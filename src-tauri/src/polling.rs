use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, Duration};

use tauri::{AppHandle, Emitter};

use crate::activities::ActivityItem;
use crate::youtrack::YouTrackClient;

/// Polling interval tiers (in seconds).
const INTERVAL_FOCUSED: u64 = 30;
const INTERVAL_MINIMIZED: u64 = 60;
const INTERVAL_IDLE: u64 = 120;

/// Max activities per request.
const ACTIVITIES_PER_PAGE: u32 = 100;

/// Duration for initial load window (24 hours in ms).
const INITIAL_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

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
    /// Timestamp watermark (unix ms) — poll activities after this.
    pub watermark: i64,
    /// Set of seen activity IDs for deduplication.
    pub seen_ids: HashSet<String>,
    /// Cached activities (most recent first).
    pub activities: Vec<ActivityItem>,
    /// Read activity IDs.
    pub read_ids: HashSet<String>,
    /// Muted issue IDs (readable IDs like "PROJ-123") — skip OS notifications for these.
    pub muted_issues: HashSet<String>,
    /// Current user ID — activities from this user are excluded.
    pub current_user_id: String,
    /// Credentials for polling.
    pub url: String,
    pub token: String,
    /// Consecutive poll failures for backoff.
    pub consecutive_failures: u32,
}

impl AccountPollingState {
    pub fn new(url: String, token: String, current_user_id: String) -> Self {
        Self {
            running: true,
            watermark: 0,
            seen_ids: HashSet::new(),
            activities: Vec::new(),
            read_ids: HashSet::new(),
            muted_issues: HashSet::new(),
            current_user_id,
            url,
            token,
            consecutive_failures: 0,
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

    /// Get merged activities from all accounts, sorted by timestamp descending.
    pub fn all_activities(&self) -> Vec<ActivityItem> {
        let mut all: Vec<ActivityItem> = self
            .accounts
            .values()
            .flat_map(|a| a.activities.iter().cloned())
            .collect();
        all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        all
    }

    /// Get total unread count across all accounts.
    pub fn total_unread_count(&self) -> u32 {
        self.accounts
            .values()
            .map(|a| {
                a.activities
                    .iter()
                    .filter(|act| !a.read_ids.contains(&act.id))
                    .count() as u32
            })
            .sum()
    }
}

pub type SharedPollingState = Arc<RwLock<PollingManager>>;

/// Start the background polling loop.
/// Iterates over all accounts each cycle.
pub fn start_polling_loop(
    app_handle: AppHandle,
    state: SharedPollingState,
    _cancel: Arc<Mutex<()>>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Snapshot account info and global settings
            let (account_snapshots, interval_secs) = {
                let mgr = state.read().await;
                let interval = mgr.focus_state.interval_secs();
                let snapshots: Vec<(String, String, String, i64, u32, String, HashSet<String>)> = mgr
                    .accounts
                    .iter()
                    .filter(|(_, a)| a.running && !a.url.is_empty() && !a.token.is_empty())
                    .map(|(id, a)| {
                        (
                            id.clone(),
                            a.url.clone(),
                            a.token.clone(),
                            a.watermark,
                            a.consecutive_failures,
                            a.current_user_id.clone(),
                            a.muted_issues.clone(),
                        )
                    })
                    .collect();
                (snapshots, interval)
            };

            if account_snapshots.is_empty() {
                // No active accounts — wait and re-check.
                sleep(Duration::from_secs(2)).await;
                continue;
            }

            // Calculate actual interval with max backoff across all accounts
            let max_failures = account_snapshots
                .iter()
                .map(|(_, _, _, _, f, _, _)| *f)
                .max()
                .unwrap_or(0);
            let actual_interval = if max_failures > 0 {
                let backoff = interval_secs * 2u64.pow(max_failures.min(5));
                backoff.min(300)
            } else {
                interval_secs
            };

            sleep(Duration::from_secs(actual_interval)).await;

            // Re-check that manager still has running accounts after sleep
            {
                let mgr = state.read().await;
                if mgr.accounts.values().all(|a| !a.running) {
                    continue;
                }
            }

            // Poll each account
            for (account_id, url, token, watermark, _consecutive_failures, current_user_id, muted_issues) in &account_snapshots {
                let client = YouTrackClient::new(url, token);

                let is_initial_load = *watermark == 0;
                let start = if *watermark > 0 {
                    watermark + 1
                } else {
                    let now = chrono::Utc::now().timestamp_millis();
                    now - INITIAL_WINDOW_MS
                };

                match client.get_activities(start, ACTIVITIES_PER_PAGE).await {
                    Ok(new_activities) => {
                        let mut mgr = state.write().await;
                        let Some(acct) = mgr.accounts.get_mut(account_id) else {
                            continue;
                        };
                        acct.consecutive_failures = 0;

                        let mut new_count = 0u32;
                        let mut non_muted_new_count = 0u32;
                        // Collect activities where the current user was just assigned,
                        // so we can fire targeted notifications after releasing the lock.
                        let mut assigned_to_me: Vec<(String, Option<String>)> = Vec::new();

                        for mut activity in new_activities {
                            // Stamp the account ID
                            activity.account_id = account_id.clone();

                            // Skip current user's own activities
                            if !current_user_id.is_empty() {
                                if let Some(ref author) = activity.author {
                                    if author.id == *current_user_id {
                                        continue;
                                    }
                                }
                            }

                            // Deduplication
                            if acct.seen_ids.contains(&activity.id) {
                                continue;
                            }

                            // Update watermark
                            if activity.timestamp > acct.watermark {
                                acct.watermark = activity.timestamp;
                            }

                            // Check if this activity's issue is muted
                            let is_muted = resolve_issue_id_readable(&activity)
                                .map(|id| muted_issues.contains(&id))
                                .unwrap_or(false);

                            // Capture assignee-to-me targets (skip muted issues)
                            if !is_muted
                                && !current_user_id.is_empty()
                                && is_assignment_to_user(&activity, current_user_id)
                            {
                                if let Some(issue_id) = resolve_issue_id_readable(&activity) {
                                    let summary = activity
                                        .target
                                        .as_ref()
                                        .and_then(|t| t.summary.clone().or_else(|| {
                                            t.issue.as_ref().and_then(|i| i.summary.clone())
                                        }));
                                    assigned_to_me.push((issue_id, summary));
                                }
                            }

                            acct.seen_ids.insert(activity.id.clone());
                            acct.activities.insert(0, activity);
                            new_count += 1;
                            if !is_muted {
                                non_muted_new_count += 1;
                            }
                        }

                        // Prune old activities (keep last 500 per account)
                        if acct.activities.len() > 500 {
                            let removed: Vec<_> = acct.activities.drain(500..).collect();
                            for r in &removed {
                                acct.seen_ids.remove(&r.id);
                            }
                        }

                        // Read IDs are age-pruned (30-day TTL) durably on the
                        // frontend, which is the source of truth across restarts.
                        // The backend set is rehydrated from there, so no
                        // in-memory pruning is needed here.

                        drop(mgr);

                        // Emit event with account context
                        let _ = app_handle.emit(
                            "activities-updated",
                            serde_json::json!({
                                "accountId": account_id,
                                "count": new_count,
                            }),
                        );

                        // Send OS notification only for non-muted new activities
                        if non_muted_new_count > 0 && !is_initial_load {
                            send_activity_batch_notification(&app_handle, non_muted_new_count);
                        }

                        // Fire a separate, targeted notification for each assignee-to-me event.
                        if !is_initial_load {
                            for (issue_id, summary) in assigned_to_me {
                                let body = match summary {
                                    Some(s) if !s.is_empty() => format!("{} — {}", issue_id, s),
                                    _ => issue_id,
                                };
                                send_titled_notification(&app_handle, "Assigned to you", &body);
                            }
                        }
                    }
                    Err(e) => {
                        let err_msg = e.to_string();
                        let mut mgr = state.write().await;
                        if let Some(acct) = mgr.accounts.get_mut(account_id) {
                            acct.consecutive_failures += 1;
                        }

                        if err_msg.starts_with("RATE_LIMITED:") {
                            if let Some(secs_str) = err_msg.strip_prefix("RATE_LIMITED:") {
                                if let Ok(secs) = secs_str.parse::<u64>() {
                                    drop(mgr);
                                    sleep(Duration::from_secs(secs)).await;
                                    continue;
                                }
                            }
                        }

                        drop(mgr);

                        let _ = app_handle.emit(
                            "poll-error",
                            serde_json::json!({
                                "accountId": account_id,
                                "error": err_msg,
                            }),
                        );
                    }
                }
            }
        }
    });
}

/// Resolve the readable issue ID for an activity (e.g. "PROJ-123").
fn resolve_issue_id_readable(activity: &ActivityItem) -> Option<String> {
    let t = activity.target.as_ref()?;
    if let Some(ref id_readable) = t.id_readable {
        let target_type = t.target_type.as_deref().unwrap_or("");
        if target_type != "IssueComment"
            && target_type != "ArticleComment"
            && target_type != "Article"
        {
            return Some(id_readable.clone());
        }
    }
    if let Some(ref issue) = t.issue {
        if let Some(ref id_readable) = issue.id_readable {
            return Some(id_readable.clone());
        }
    }
    None
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

/// Batched "N new activities" notification.
fn send_activity_batch_notification(app_handle: &AppHandle, count: u32) {
    let body = if count > 3 {
        format!("{} new activities in YouTrack", count)
    } else {
        format!(
            "{} new activit{} in YouTrack",
            count,
            if count == 1 { "y" } else { "ies" }
        )
    };
    send_titled_notification(app_handle, "YouTrackd", &body);
}

/// Returns true if this activity is a CustomField/Assignee change where the
/// `added` array contains the given user (matched by `id`).
fn is_assignment_to_user(activity: &ActivityItem, current_user_id: &str) -> bool {
    if current_user_id.is_empty() {
        return false;
    }
    let Some(ref category) = activity.category else { return false };
    if category.id != "CustomFieldCategory" {
        return false;
    }
    let Some(ref field) = activity.field else { return false };
    if field.name.as_deref() != Some("Assignee") {
        return false;
    }
    // `added` may be an array of user objects or a single object.
    fn entry_matches(entry: &serde_json::Value, user_id: &str) -> bool {
        entry
            .get("id")
            .and_then(|v| v.as_str())
            .map(|id| id == user_id)
            .unwrap_or(false)
    }
    match &activity.added {
        serde_json::Value::Array(arr) => arr.iter().any(|e| entry_matches(e, current_user_id)),
        v @ serde_json::Value::Object(_) => entry_matches(v, current_user_id),
        _ => false,
    }
}
