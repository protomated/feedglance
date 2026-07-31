use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, Duration};

use tauri::{AppHandle, Emitter};

use crate::provider::nifty::NiftyProvider;
use crate::provider::youtrack_provider::YouTrackProvider;
use crate::provider::{
    Cursor, EventKind, NormalizedEvent, NotificationSource, ProviderError, ProviderKind,
};

/// Polling interval tiers (in seconds).
const INTERVAL_FOCUSED: u64 = 30;
const INTERVAL_MINIMIZED: u64 = 60;
const INTERVAL_IDLE: u64 = 120;

/// Per-cycle API call budget handed to each provider.
///
/// YouTrack ignores this (one call per cycle). Nifty uses it to bound fan-out:
/// its 200 GET/min limit is team-scoped, so it is shared by every user running
/// this app in the same workspace. Staying well under lets N clients coexist.
///
/// 40 was too low to complete a first sweep of a real workspace: 8 projects /
/// ~280 tasks needs ~290 calls, so phase 1 never finished, fingerprints stayed
/// incomplete, and the cheap steady state was never reached. 100 clears a
/// cold start in ~3 cycles (3 min at the 60s Nifty floor) while leaving half
/// the team-shared limit for other clients. Steady state stays near-zero
/// message calls, so this ceiling is only reached while catching up.
const CALL_BUDGET: u32 = 100;

/// Max events retained per account before pruning.
const MAX_EVENTS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusState {
    Focused,
    Minimized,
    Idle,
}

impl FocusState {
    pub fn interval_secs(&self) -> u64 {
        match self {
            FocusState::Focused => INTERVAL_FOCUSED,
            FocusState::Minimized => INTERVAL_MINIMIZED,
            FocusState::Idle => INTERVAL_IDLE,
        }
    }
}

/// Per-account polling state.
pub struct AccountPollingState {
    /// Whether polling is active for this account.
    pub running: bool,
    /// Provider-owned resume point (watermark and/or opaque provider state).
    pub cursor: Cursor,
    /// Set of seen event IDs for deduplication.
    pub seen_ids: HashSet<String>,
    /// Cached events (most recent first).
    pub events: Vec<NormalizedEvent>,
    /// Read event IDs.
    pub read_ids: HashSet<String>,
    /// Muted item IDs (display IDs like "PROJ-123") — skip OS notifications.
    pub muted_issues: HashSet<String>,
    /// Current user ID — events from this user are excluded.
    pub current_user_id: String,
    /// Which backend this account talks to.
    pub provider: ProviderKind,
    /// Credentials. `url` is unused for Nifty (fixed API host).
    pub url: String,
    pub token: String,
    /// Consecutive poll failures for backoff.
    pub consecutive_failures: u32,
}

impl AccountPollingState {
    pub fn new(url: String, token: String, current_user_id: String) -> Self {
        Self::with_provider(ProviderKind::YouTrack, url, token, current_user_id)
    }

    pub fn with_provider(
        provider: ProviderKind,
        url: String,
        token: String,
        current_user_id: String,
    ) -> Self {
        Self {
            running: true,
            cursor: Cursor::default(),
            seen_ids: HashSet::new(),
            events: Vec::new(),
            read_ids: HashSet::new(),
            muted_issues: HashSet::new(),
            current_user_id,
            provider,
            url,
            token,
            consecutive_failures: 0,
        }
    }

    /// Build the provider for this account.
    ///
    /// Constructed fresh each cycle so credential updates take effect without
    /// restarting the loop.
    fn source(&self) -> Box<dyn NotificationSource> {
        match self.provider {
            ProviderKind::YouTrack => Box::new(YouTrackProvider::new(
                &self.url,
                &self.token,
                &self.current_user_id,
            )),
            // For Nifty, `url` is the workspace origin used for deep links
            // (`{slug}.nifty.pm` or a CNAME custom domain), not an API host —
            // the API lives at a fixed address. It is optional: without it,
            // events simply carry no deep link.
            ProviderKind::Nifty => Box::new(NiftyProvider::with_workspace(
                &self.token,
                &self.current_user_id,
                &self.url,
            )),
        }
    }

    /// Credentials sufficient to poll? Nifty needs no URL.
    fn is_pollable(&self) -> bool {
        if self.token.is_empty() {
            return false;
        }
        match self.provider {
            ProviderKind::YouTrack => !self.url.is_empty(),
            ProviderKind::Nifty => true,
        }
    }
}

/// Manager holding all account polling states and global focus state.
pub struct PollingManager {
    pub accounts: HashMap<String, AccountPollingState>,
    pub focus_state: FocusState,
}

impl PollingManager {
    pub fn new() -> Self {
        Self {
            accounts: HashMap::new(),
            focus_state: FocusState::Focused,
        }
    }

    /// Get merged events from all accounts, sorted by timestamp descending.
    pub fn all_events(&self) -> Vec<NormalizedEvent> {
        let mut all: Vec<NormalizedEvent> = self
            .accounts
            .values()
            .flat_map(|a| a.events.iter().cloned())
            .collect();
        all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        all
    }

    /// Total unread count across all accounts.
    ///
    /// Providers with server-side read state (Nifty `seen_by`) are trusted over
    /// the local set, so read state follows the user across devices.
    pub fn total_unread_count(&self) -> u32 {
        self.accounts
            .values()
            .map(|a| {
                a.events
                    .iter()
                    .filter(|e| match e.seen_remotely {
                        Some(seen) => !seen,
                        None => !a.read_ids.contains(&e.id),
                    })
                    .count() as u32
            })
            .sum()
    }
}

pub type SharedPollingState = Arc<RwLock<PollingManager>>;

/// Snapshot of what a cycle needs, taken under a read lock so the poll itself
/// runs lock-free.
struct PollTarget {
    account_id: String,
    source: Box<dyn NotificationSource>,
    cursor: Cursor,
    muted: HashSet<String>,
    is_initial: bool,
    min_interval: u64,
}

/// Start the background polling loop.
pub fn start_polling_loop(app_handle: AppHandle, state: SharedPollingState, _cancel: Arc<Mutex<()>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (targets, interval_secs, max_failures) = {
                let mgr = state.read().await;
                let base = mgr.focus_state.interval_secs();
                let mut targets = Vec::new();
                let mut max_failures = 0u32;

                for (id, acct) in mgr.accounts.iter() {
                    if !acct.running || !acct.is_pollable() {
                        continue;
                    }
                    max_failures = max_failures.max(acct.consecutive_failures);
                    targets.push(PollTarget {
                        account_id: id.clone(),
                        source: acct.source(),
                        cursor: acct.cursor.clone(),
                        muted: acct.muted_issues.clone(),
                        is_initial: acct.cursor.watermark == 0,
                        min_interval: acct.source().min_interval_secs(),
                    });
                }
                (targets, base, max_failures)
            };

            if targets.is_empty() {
                sleep(Duration::from_secs(2)).await;
                continue;
            }

            // Respect the slowest provider's floor — Nifty asks for 60s because
            // its fan-out is heavier than YouTrack's single call.
            let provider_floor = targets.iter().map(|t| t.min_interval).max().unwrap_or(0);
            let mut actual = interval_secs.max(provider_floor);
            if max_failures > 0 {
                actual = (actual * 2u64.pow(max_failures.min(5))).min(300);
            }

            sleep(Duration::from_secs(actual)).await;

            {
                let mgr = state.read().await;
                if mgr.accounts.values().all(|a| !a.running) {
                    continue;
                }
            }

            for target in targets {
                match target.source.fetch(&target.cursor, CALL_BUDGET).await {
                    Ok(result) => {
                        let outcome = apply_events(&state, &target, result).await;
                        let Some(outcome) = outcome else { continue };

                        let _ = app_handle.emit(
                            "activities-updated",
                            serde_json::json!({
                                "accountId": target.account_id,
                                "count": outcome.new_count,
                            }),
                        );

                        if !target.is_initial {
                            if outcome.notifiable_count > 0 {
                                send_batch_notification(
                                    &app_handle,
                                    outcome.notifiable_count,
                                    target.source.kind(),
                                );
                            }
                            for (display_id, title) in outcome.assigned_to_me {
                                let body = match title {
                                    Some(t) if !t.is_empty() => format!("{} — {}", display_id, t),
                                    _ => display_id,
                                };
                                send_titled_notification(&app_handle, "Assigned to you", &body);
                            }
                        }
                    }
                    Err(e) => {
                        {
                            let mut mgr = state.write().await;
                            if let Some(acct) = mgr.accounts.get_mut(&target.account_id) {
                                acct.consecutive_failures += 1;
                            }
                        }

                        if let ProviderError::RateLimited(secs) = e {
                            sleep(Duration::from_secs(secs)).await;
                            continue;
                        }

                        let _ = app_handle.emit(
                            "poll-error",
                            serde_json::json!({
                                "accountId": target.account_id,
                                "error": e.to_string(),
                            }),
                        );
                    }
                }
            }
        }
    });
}

struct ApplyOutcome {
    new_count: u32,
    notifiable_count: u32,
    assigned_to_me: Vec<(String, Option<String>)>,
}

/// Merge a fetch result into account state under a single write lock.
async fn apply_events(
    state: &SharedPollingState,
    target: &PollTarget,
    result: crate::provider::FetchResult,
) -> Option<ApplyOutcome> {
    let mut mgr = state.write().await;
    let acct = mgr.accounts.get_mut(&target.account_id)?;

    acct.consecutive_failures = 0;
    // The provider owns cursor semantics; the engine only persists it.
    acct.cursor = result.cursor;

    let mut new_count = 0u32;
    let mut notifiable_count = 0u32;
    let mut assigned_to_me = Vec::new();

    for mut event in result.events {
        event.account_id = target.account_id.clone();

        if acct.seen_ids.contains(&event.id) {
            continue;
        }

        let is_muted = !event.subject.display_id.is_empty()
            && target.muted.contains(&event.subject.display_id);

        if !is_muted && is_for_me(&event, &acct.current_user_id) {
            assigned_to_me.push((
                event.subject.display_id.clone(),
                event.subject.title.clone(),
            ));
        }

        acct.seen_ids.insert(event.id.clone());
        acct.events.insert(0, event);
        new_count += 1;
        if !is_muted {
            notifiable_count += 1;
        }
    }

    if acct.events.len() > MAX_EVENTS {
        let removed: Vec<_> = acct.events.drain(MAX_EVENTS..).collect();
        for r in &removed {
            acct.seen_ids.remove(&r.id);
        }
    }

    Some(ApplyOutcome {
        new_count,
        notifiable_count,
        assigned_to_me,
    })
}

/// True when an event directly targets the current user — an assignment to them,
/// or an @-mention. Both warrant a distinct notification from the batch.
fn is_for_me(event: &NormalizedEvent, current_user_id: &str) -> bool {
    if current_user_id.is_empty() {
        return false;
    }
    if event.mentions_me {
        return true;
    }
    if event.kind != EventKind::Assignment {
        return false;
    }

    // YouTrack encodes the new assignee in `added`; Nifty sets `mentions_me`
    // upstream, so this only needs to handle the YouTrack shape.
    fn matches(v: &serde_json::Value, uid: &str) -> bool {
        v.get("id").and_then(|x| x.as_str()) == Some(uid)
    }
    match event.raw.get("added") {
        Some(serde_json::Value::Array(arr)) => arr.iter().any(|e| matches(e, current_user_id)),
        Some(v @ serde_json::Value::Object(_)) => matches(v, current_user_id),
        _ => false,
    }
}

/// Fire an OS notification with an explicit title + body.
fn send_titled_notification(app_handle: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app_handle
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

/// Batched "N new notifications" alert.
///
/// Names the provider rather than the app: with several accounts connected, a
/// generic title does not say which service the notifications came from.
fn send_batch_notification(app_handle: &AppHandle, count: u32, provider: ProviderKind) {
    let name = match provider {
        ProviderKind::YouTrack => "YouTrack",
        ProviderKind::Nifty => "Nifty",
    };
    let body = format!(
        "{} new notification{} in {}",
        count,
        if count == 1 { "" } else { "s" },
        name
    );
    send_titled_notification(app_handle, "YouTrackd", &body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{EventSubject, NormalizedEvent};

    fn event(kind: EventKind, mentions_me: bool, added: serde_json::Value) -> NormalizedEvent {
        NormalizedEvent {
            id: "e1".into(),
            provider: ProviderKind::YouTrack,
            timestamp: 1,
            kind,
            actor: None,
            subject: EventSubject {
                id: "t1".into(),
                display_id: "P-1".into(),
                title: None,
                project_id: None,
                project_name: None,
            },
            text: None,
            mentions_me,
            seen_remotely: None,
            url: None,
            account_id: String::new(),
            raw: serde_json::json!({ "added": added }),
        }
    }

    #[test]
    fn mention_is_for_me_regardless_of_kind() {
        let e = event(EventKind::Comment, true, serde_json::Value::Null);
        assert!(is_for_me(&e, "u1"));
    }

    #[test]
    fn assignment_to_me_matches_youtrack_added_array() {
        let e = event(
            EventKind::Assignment,
            false,
            serde_json::json!([{ "id": "u1" }]),
        );
        assert!(is_for_me(&e, "u1"));
        assert!(!is_for_me(&e, "u2"));
    }

    #[test]
    fn assignment_to_someone_else_is_not_for_me() {
        let e = event(
            EventKind::Assignment,
            false,
            serde_json::json!([{ "id": "other" }]),
        );
        assert!(!is_for_me(&e, "u1"));
    }

    #[test]
    fn empty_user_id_never_matches() {
        let e = event(EventKind::Assignment, true, serde_json::json!([{"id": ""}]));
        assert!(!is_for_me(&e, ""));
    }

    #[test]
    fn remote_seen_state_overrides_local_read_set() {
        let mut mgr = PollingManager::new();
        let mut acct = AccountPollingState::with_provider(
            ProviderKind::Nifty,
            String::new(),
            "t".into(),
            "u1".into(),
        );

        // Seen remotely => read, even though it is absent from read_ids.
        let mut seen = event(EventKind::Comment, false, serde_json::Value::Null);
        seen.id = "seen".into();
        seen.seen_remotely = Some(true);

        let mut unseen = event(EventKind::Comment, false, serde_json::Value::Null);
        unseen.id = "unseen".into();
        unseen.seen_remotely = Some(false);

        acct.events = vec![seen, unseen];
        mgr.accounts.insert("a".into(), acct);

        assert_eq!(mgr.total_unread_count(), 1);
    }

    #[test]
    fn local_read_set_used_when_provider_has_no_remote_state() {
        let mut mgr = PollingManager::new();
        let mut acct = AccountPollingState::new("u".into(), "t".into(), "u1".into());
        let mut a = event(EventKind::Comment, false, serde_json::Value::Null);
        a.id = "a".into();
        let mut b = event(EventKind::Comment, false, serde_json::Value::Null);
        b.id = "b".into();
        acct.events = vec![a, b];
        acct.read_ids.insert("a".into());
        mgr.accounts.insert("acct".into(), acct);

        assert_eq!(mgr.total_unread_count(), 1);
    }

    #[test]
    fn nifty_is_pollable_without_url() {
        let acct = AccountPollingState::with_provider(
            ProviderKind::Nifty,
            String::new(),
            "token".into(),
            String::new(),
        );
        assert!(acct.is_pollable());
    }

    #[test]
    fn youtrack_requires_url() {
        let acct = AccountPollingState::new(String::new(), "token".into(), String::new());
        assert!(!acct.is_pollable());
    }
}
