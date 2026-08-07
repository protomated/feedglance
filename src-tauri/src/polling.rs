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

/// How long unfocused before dropping to the idle tier. Matches the 5 minutes
/// the frontend timer used to (attempt to) enforce.
const IDLE_AFTER: Duration = Duration::from_secs(5 * 60);

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

/// The feed's client-side filters, mirrored backend-side.
///
/// The tray badge must match what the feed shows, but the badge has to stay
/// correct while the window is hidden — and a hidden webview is throttled or
/// suspended by the OS (aggressively so on Windows and Linux), so anything
/// computed in the frontend stops updating exactly when the app is in its normal
/// state: closed in the tray.
///
/// So the filters are pushed down once whenever they change, and the count is
/// computed here on every poll. Empty means "no filter", matching the frontend's
/// `size === 0` convention — a fresh install filters nothing.
#[derive(Debug, Default, Clone)]
pub struct FeedFilters {
    pub accounts: HashSet<String>,
    /// Account-scoped project keys, as built by the frontend.
    pub projects: HashSet<String>,
    pub kinds: HashSet<String>,
    pub search: String,
    pub assigned_to_me_only: bool,
}

/// Separator in scoped project keys. Must match `SEP` in `projectFilter.ts`.
const PROJECT_KEY_SEP: &str = "::";

/// Scoped project key for an event, mirroring `activityProjectKey`.
///
/// The frontend resolves the bare key as `shortName ?? id ?? "unknown"`, and
/// `compat.ts` maps `shortName` from `subject.projectName` — so the precedence
/// here is projectName, then projectId, then the literal "unknown" that the
/// frontend uses for events with no project at all.
fn event_project_key(event: &NormalizedEvent) -> String {
    let bare = event
        .subject
        .project_name
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(event
            .subject
            .project_id
            .as_deref()
            .filter(|s| !s.is_empty()))
        .unwrap_or("unknown");
    format!("{}{}{}", event.account_id, PROJECT_KEY_SEP, bare)
}

impl FeedFilters {
    /// Mirrors `flatActivities` in App.tsx. The two must agree, or the badge
    /// disagrees with the feed the user sees.
    fn allows(&self, event: &NormalizedEvent, current_user_id: &str) -> bool {
        // Own actions are hidden unless they mention you.
        if !current_user_id.is_empty() && !event.mentions_me {
            if let Some(actor) = &event.actor {
                if actor.id == current_user_id {
                    return false;
                }
            }
        }
        if !self.accounts.is_empty()
            && !event.account_id.is_empty()
            && !self.accounts.contains(&event.account_id)
        {
            return false;
        }
        // Project keys are `{accountId}::{projectKey}`, where projectKey is the
        // project's shortName falling back to its id — the frontend's format,
        // mirrored exactly. `event_project_key` reproduces it.
        //
        // A selection only constrains the accounts it names: if nothing is
        // selected for this event's account, that account is unfiltered. This
        // matches `passesProjectFilter`; without it, filtering one account would
        // silently drop every other account's events from the badge while the
        // feed still showed them.
        if !self.projects.is_empty() {
            let account_has_selection = self
                .projects
                .iter()
                .any(|k| k.split(PROJECT_KEY_SEP).next().unwrap_or("") == event.account_id);
            if account_has_selection && !self.projects.contains(&event_project_key(event)) {
                return false;
            }
        }
        if !self.kinds.is_empty() {
            let kind = serde_json::to_value(event.kind)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            if !kind.is_empty() && !self.kinds.contains(&kind) {
                return false;
            }
        }
        if !self.search.is_empty() {
            let needle = self.search.to_lowercase();
            // Same fields `matchesSearch` scans: author name, item id, title,
            // and body text.
            let hay = [
                event.text.as_deref().unwrap_or(""),
                event.subject.title.as_deref().unwrap_or(""),
                &event.subject.display_id,
                event.actor.as_ref().map(|a| a.name.as_str()).unwrap_or(""),
                event.actor.as_ref().map(|a| a.id.as_str()).unwrap_or(""),
            ]
            .join(" ")
            .to_lowercase();
            if !hay.contains(&needle) {
                return false;
            }
        }
        // Mirrors `isAssigneeChangeTo`: an assignment whose `added` names the
        // current user. Deliberately NOT satisfied by `mentions_me` — the
        // frontend's version does not accept mentions, and treating it as a
        // match would over-count the badge relative to the feed.
        if self.assigned_to_me_only {
            if event.kind != EventKind::Assignment || current_user_id.is_empty() {
                return false;
            }
            let names_me = |v: &serde_json::Value| {
                v.get("id").and_then(|x| x.as_str()) == Some(current_user_id)
                    || v.get("login").and_then(|x| x.as_str()) == Some(current_user_id)
            };
            let matched = match event.raw.get("added") {
                Some(serde_json::Value::Array(a)) => a.iter().any(names_me),
                Some(v @ serde_json::Value::Object(_)) => names_me(v),
                _ => false,
            };
            if !matched {
                return false;
            }
        }
        true
    }
}

/// Manager holding all account polling states and global focus state.
pub struct PollingManager {
    pub accounts: HashMap<String, AccountPollingState>,
    pub focus_state: FocusState,
    /// When the app last became unfocused, used to promote Minimized -> Idle in
    /// the polling loop rather than via a frontend timer that a hidden webview
    /// may never run. `None` while focused.
    pub unfocused_since: Option<std::time::Instant>,
    /// Mirror of the feed's filters, so the badge can be computed without the
    /// webview. See `FeedFilters`.
    pub filters: FeedFilters,
}

impl PollingManager {
    pub fn new() -> Self {
        Self {
            accounts: HashMap::new(),
            focus_state: FocusState::Focused,
            unfocused_since: None,
            filters: FeedFilters::default(),
        }
    }

    /// Effective polling tier, promoting Minimized -> Idle once the app has been
    /// unfocused long enough.
    ///
    /// Owned here rather than in the frontend because the window is hidden on
    /// blur, and a hidden webview's timers are unreliable on Windows and Linux.
    pub fn effective_focus_state(&self) -> FocusState {
        match (self.focus_state, self.unfocused_since) {
            (FocusState::Minimized, Some(since)) if since.elapsed() >= IDLE_AFTER => {
                FocusState::Idle
            }
            (state, _) => state,
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

    /// Unread count as the *feed* would show it — the number the tray badge
    /// must display.
    ///
    /// Unlike `total_unread_count`, this applies the mirrored feed filters and
    /// per-account mutes, so a user filtering to one project sees a badge for
    /// that project rather than the whole workspace.
    pub fn filtered_unread_count(&self) -> u32 {
        self.accounts
            .values()
            .map(|a| {
                a.events
                    .iter()
                    .filter(|e| {
                        let unread = match e.seen_remotely {
                            Some(seen) => !seen,
                            None => !a.read_ids.contains(&e.id),
                        };
                        if !unread {
                            return false;
                        }
                        if !e.subject.display_id.is_empty()
                            && a.muted_issues.contains(&e.subject.display_id)
                        {
                            return false;
                        }
                        self.filters.allows(e, &a.current_user_id)
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
                let base = mgr.effective_focus_state().interval_secs();
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

                        // The badge is computed here, not in the webview: while
                        // the window is hidden the frontend is throttled and its
                        // listener may not run for minutes, which left the badge
                        // stale exactly when the app lives in the tray.
                        //
                        // Recomputed even on a zero-event cycle, since read
                        // state can change from the tray menu meanwhile.
                        let unread = {
                            let mgr = state.read().await;
                            mgr.filtered_unread_count()
                        };
                        crate::tray::update_tray_badge(&app_handle, unread);

                        // Nothing new means nothing for the UI to redraw. The
                        // emit wakes the webview and triggers a full refresh
                        // round-trip, so skipping it keeps an idle app idle —
                        // the common case by far.
                        //
                        // Both notification paths below are fed only by events
                        // counted in `new_count`, so skipping here cannot drop
                        // an alert. Asserted rather than assumed: if that ever
                        // stops holding, this must move below the notifications.
                        if outcome.new_count == 0 {
                            debug_assert!(
                                outcome.notifiable_count == 0 && outcome.assigned_to_me.is_empty(),
                                "no new events but notifications pending — \
                                 the early-continue would swallow them"
                            );
                            continue;
                        }

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
    send_titled_notification(app_handle, "Feedglance", &body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{EventSubject, NormalizedEvent};

    fn ev(id: &str, account: &str, project: Option<&str>, kind: EventKind) -> NormalizedEvent {
        NormalizedEvent {
            id: id.into(),
            provider: ProviderKind::Nifty,
            timestamp: 1,
            kind,
            actor: None,
            subject: EventSubject {
                id: "t1".into(),
                display_id: "P-1".into(),
                title: Some("Fix the thing".into()),
                project_id: project.map(String::from),
                project_name: None,
            },
            text: Some("hello world".into()),
            mentions_me: false,
            seen_remotely: None,
            url: None,
            account_id: account.into(),
            raw: serde_json::Value::Null,
        }
    }

    /// A fresh install filters nothing — an empty set must mean "allow all",
    /// matching the frontend's `size === 0` convention. Inverting this would
    /// blank the feed and the badge on first run.
    #[test]
    fn empty_filters_allow_everything() {
        let f = FeedFilters::default();
        assert!(f.allows(&ev("e1", "a1", Some("p1"), EventKind::Comment), ""));
    }

    #[test]
    fn account_filter_excludes_other_accounts() {
        let mut f = FeedFilters::default();
        f.accounts.insert("a1".into());
        assert!(f.allows(&ev("e1", "a1", None, EventKind::Comment), ""));
        assert!(!f.allows(&ev("e2", "a2", None, EventKind::Comment), ""));
    }

    /// Project keys are account-scoped (`account::project`) — the same project
    /// in two accounts must not cross-match. Note account a2 has no selection
    /// at all here, so it stays unfiltered (see the test below).
    #[test]
    fn project_filter_is_account_scoped() {
        let mut f = FeedFilters::default();
        f.projects.insert("a1::p1".into());
        f.projects.insert("a2::other".into());
        assert!(f.allows(&ev("e1", "a1", Some("p1"), EventKind::Comment), ""));
        assert!(!f.allows(&ev("e2", "a2", Some("p1"), EventKind::Comment), ""));
    }

    /// A selection constrains only the accounts it names. Filtering account a1
    /// must not silently hide every event from a2 — the frontend's
    /// `accountHasSelection` escape hatch, which the badge has to reproduce or
    /// it disagrees with the visible feed.
    #[test]
    fn project_filter_leaves_unselected_accounts_alone() {
        let mut f = FeedFilters::default();
        f.projects.insert("a1::p1".into());
        assert!(
            f.allows(&ev("e2", "a2", Some("anything"), EventKind::Comment), ""),
            "an account with no project selected must stay unfiltered"
        );
    }

    /// The bare key is `projectName ?? projectId ?? "unknown"` — `compat.ts`
    /// maps the frontend's `shortName` from `projectName`, so a name-bearing
    /// event keys on the name, not the id.
    #[test]
    fn project_key_prefers_name_then_id_then_unknown() {
        let mut e = ev("e1", "a1", Some("p_id"), EventKind::Comment);
        e.subject.project_name = Some("PROJ".into());
        assert_eq!(event_project_key(&e), "a1::PROJ");

        e.subject.project_name = None;
        assert_eq!(event_project_key(&e), "a1::p_id");

        e.subject.project_id = None;
        assert_eq!(event_project_key(&e), "a1::unknown");
    }

    /// Kind names must match the wire format the frontend filters on
    /// (`camelCase` via serde), not Rust's variant spelling.
    #[test]
    fn kind_filter_matches_serialized_names() {
        let mut f = FeedFilters::default();
        f.kinds.insert("statusChange".into());
        assert!(f.allows(&ev("e1", "a1", None, EventKind::StatusChange), ""));
        assert!(!f.allows(&ev("e2", "a1", None, EventKind::Comment), ""));
    }

    #[test]
    fn search_is_case_insensitive_across_fields() {
        let mut f = FeedFilters::default();
        f.search = "THING".into();
        assert!(f.allows(&ev("e1", "a1", None, EventKind::Comment), ""));
        f.search = "absent".into();
        assert!(!f.allows(&ev("e2", "a1", None, EventKind::Comment), ""));
    }

    /// Own actions are hidden unless they mention you — the same rule the
    /// providers apply upstream, mirrored so the badge agrees with the feed.
    #[test]
    fn own_events_are_excluded_unless_they_mention_me() {
        let f = FeedFilters::default();
        let mut e = ev("e1", "a1", None, EventKind::Comment);
        e.actor = Some(crate::provider::EventActor {
            id: "me".into(),
            name: "Me".into(),
            avatar_url: String::new(),
        });
        assert!(!f.allows(&e, "me"));
        e.mentions_me = true;
        assert!(f.allows(&e, "me"));
        // With no known user id there is nobody to exclude.
        e.mentions_me = false;
        assert!(f.allows(&e, ""));
    }

    /// `assignedToMeOnly` mirrors `isAssigneeChangeTo`, which requires an
    /// assignment naming the user in `added`. A mention alone must NOT satisfy
    /// it, or the badge over-counts relative to the feed.
    #[test]
    fn assigned_to_me_requires_an_assignment_not_a_mention() {
        let mut f = FeedFilters::default();
        f.assigned_to_me_only = true;

        let mut mention = ev("e1", "a1", None, EventKind::Comment);
        mention.mentions_me = true;
        assert!(!f.allows(&mention, "me"), "a mention is not an assignment");

        let mut assigned = ev("e2", "a1", None, EventKind::Assignment);
        assigned.raw = serde_json::json!({ "added": [{ "id": "me" }] });
        assert!(f.allows(&assigned, "me"));

        // An assignment to somebody else must not match.
        let mut other = ev("e3", "a1", None, EventKind::Assignment);
        other.raw = serde_json::json!({ "added": [{ "id": "someone" }] });
        assert!(!f.allows(&other, "me"));
    }

    /// Both the array and bare-object shapes of `added` occur in YouTrack
    /// payloads, and `login` is matched as well as `id`.
    #[test]
    fn assigned_to_me_handles_object_shape_and_login() {
        let mut f = FeedFilters::default();
        f.assigned_to_me_only = true;

        let mut obj = ev("e1", "a1", None, EventKind::Assignment);
        obj.raw = serde_json::json!({ "added": { "login": "me" } });
        assert!(f.allows(&obj, "me"));
    }

    /// Regression guard for the tray badge: the count must reflect filters and
    /// mutes, or it disagrees with the feed the user is looking at.
    #[test]
    fn filtered_unread_count_respects_filters_read_state_and_mutes() {
        let mut mgr = PollingManager::new();
        let mut acct = AccountPollingState::with_provider(
            ProviderKind::Nifty,
            String::new(),
            "t".into(),
            String::new(),
        );
        acct.events = vec![
            ev("e1", "a1", Some("p1"), EventKind::Comment),
            ev("e2", "a1", Some("p2"), EventKind::Comment),
            ev("e3", "a1", Some("p1"), EventKind::Comment),
        ];
        acct.read_ids.insert("e3".into());
        mgr.accounts.insert("a1".into(), acct);

        assert_eq!(mgr.filtered_unread_count(), 2, "e3 is read");

        mgr.filters.projects.insert("a1::p1".into());
        assert_eq!(mgr.filtered_unread_count(), 1, "only e1 survives the filter");

        mgr.accounts
            .get_mut("a1")
            .unwrap()
            .muted_issues
            .insert("P-1".into());
        assert_eq!(mgr.filtered_unread_count(), 0, "muted issues do not count");
    }

    /// Server-side read state wins over the local set where a provider has it.
    #[test]
    fn seen_remotely_overrides_local_read_state() {
        let mut mgr = PollingManager::new();
        let mut acct = AccountPollingState::with_provider(
            ProviderKind::Nifty,
            String::new(),
            "t".into(),
            String::new(),
        );
        let mut e = ev("e1", "a1", None, EventKind::Comment);
        e.seen_remotely = Some(true);
        acct.events = vec![e];
        mgr.accounts.insert("a1".into(), acct);
        assert_eq!(mgr.filtered_unread_count(), 0);
    }

    /// The idle tier must be reachable without the frontend: the window is
    /// hidden on blur and a hidden webview's timers are unreliable, which is
    /// what left polling pinned at the faster minimized rate.
    #[test]
    fn minimized_promotes_to_idle_after_the_threshold() {
        let mut mgr = PollingManager::new();
        assert_eq!(mgr.effective_focus_state(), FocusState::Focused);

        mgr.focus_state = FocusState::Minimized;
        mgr.unfocused_since = Some(std::time::Instant::now());
        assert_eq!(
            mgr.effective_focus_state(),
            FocusState::Minimized,
            "must not promote immediately"
        );

        mgr.unfocused_since = std::time::Instant::now().checked_sub(IDLE_AFTER);
        assert_eq!(
            mgr.effective_focus_state(),
            FocusState::Idle,
            "should drop to the idle tier once the threshold passes"
        );
        assert_eq!(mgr.effective_focus_state().interval_secs(), INTERVAL_IDLE);
    }

    /// Focus must win immediately — a user opening the window should not keep
    /// polling at the idle rate.
    #[test]
    fn focus_resets_the_idle_promotion() {
        let mut mgr = PollingManager::new();
        mgr.focus_state = FocusState::Focused;
        mgr.unfocused_since = None;
        assert_eq!(mgr.effective_focus_state(), FocusState::Focused);
        assert_eq!(
            mgr.effective_focus_state().interval_secs(),
            INTERVAL_FOCUSED
        );
    }

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
