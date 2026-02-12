use std::collections::HashSet;
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

/// Shared state for the polling engine.
pub struct PollingState {
    /// Whether polling is active.
    pub running: bool,
    /// Current focus state determining poll interval.
    pub focus_state: FocusState,
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
    /// Credentials for polling.
    pub url: String,
    pub token: String,
    /// Consecutive poll failures for backoff.
    pub consecutive_failures: u32,
}

impl PollingState {
    pub fn new() -> Self {
        Self {
            running: false,
            focus_state: FocusState::Focused,
            watermark: 0,
            seen_ids: HashSet::new(),
            activities: Vec::new(),
            read_ids: HashSet::new(),
            muted_issues: HashSet::new(),
            url: String::new(),
            token: String::new(),
            consecutive_failures: 0,
        }
    }
}

pub type SharedPollingState = Arc<RwLock<PollingState>>;

/// Start the background polling loop.
/// The `cancel` mutex is used to signal the loop to stop — when `running` is set to false.
pub fn start_polling_loop(
    app_handle: AppHandle,
    state: SharedPollingState,
    _cancel: Arc<Mutex<()>>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (should_run, interval_secs, url, token, watermark, consecutive_failures) = {
                let s = state.read().await;
                (
                    s.running,
                    s.focus_state.interval_secs(),
                    s.url.clone(),
                    s.token.clone(),
                    s.watermark,
                    s.consecutive_failures,
                )
            };

            if !should_run || url.is_empty() || token.is_empty() {
                // Not configured or stopped — wait and re-check.
                sleep(Duration::from_secs(2)).await;
                continue;
            }

            // Calculate actual interval with exponential backoff on failures
            let actual_interval = if consecutive_failures > 0 {
                let backoff = interval_secs * 2u64.pow(consecutive_failures.min(5));
                backoff.min(300) // Cap at 5 minutes
            } else {
                interval_secs
            };

            sleep(Duration::from_secs(actual_interval)).await;

            // Re-check running state after sleep
            {
                let s = state.read().await;
                if !s.running {
                    continue;
                }
            }

            // Perform the poll
            let client = YouTrackClient::new(&url, &token);

            // Use watermark for subsequent polls, or 24h ago for initial load
            let is_initial_load = watermark == 0;
            let start = if watermark > 0 {
                watermark + 1 // +1 to avoid re-fetching the last seen activity
            } else {
                let now = chrono::Utc::now().timestamp_millis();
                now - INITIAL_WINDOW_MS
            };

            match client.get_activities(start, ACTIVITIES_PER_PAGE).await {
                Ok(new_activities) => {
                    let mut s = state.write().await;
                    s.consecutive_failures = 0;

                    let mut new_count = 0u32;
                    let mut non_muted_new_count = 0u32;

                    for activity in new_activities {
                        // Deduplication
                        if s.seen_ids.contains(&activity.id) {
                            continue;
                        }

                        // Update watermark to the latest timestamp
                        if activity.timestamp > s.watermark {
                            s.watermark = activity.timestamp;
                        }

                        // Check if this activity's issue is muted
                        let is_muted = resolve_issue_id_readable(&activity)
                            .map(|id| s.muted_issues.contains(&id))
                            .unwrap_or(false);

                        s.seen_ids.insert(activity.id.clone());
                        s.activities.insert(0, activity); // Newest first
                        new_count += 1;
                        if !is_muted {
                            non_muted_new_count += 1;
                        }
                    }

                    // Prune old activities (keep last 500)
                    if s.activities.len() > 500 {
                        let removed: Vec<_> = s.activities.drain(500..).collect();
                        for r in &removed {
                            s.seen_ids.remove(&r.id);
                        }
                    }

                    // Prune read_ids older than 30 days
                    // (We'll do this on a simple size cap since we don't track per-id timestamps)
                    if s.read_ids.len() > 5000 {
                        s.read_ids.clear();
                    }

                    // Compute unread count before dropping the lock
                    let unread_count = s
                        .activities
                        .iter()
                        .filter(|a| !s.read_ids.contains(&a.id))
                        .count() as u32;

                    drop(s);

                    // Update tray badge with current unread count
                    crate::tray::update_tray_badge(&app_handle, unread_count);

                    // Emit event to frontend with the new activity count
                    let _ = app_handle.emit("activities-updated", new_count);

                    // Send OS notification only for non-muted new activities
                    // Skip on initial load — those are catch-up activities, not genuinely new
                    if non_muted_new_count > 0 && !is_initial_load {
                        send_os_notification(&app_handle, non_muted_new_count);
                    }
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    let mut s = state.write().await;
                    s.consecutive_failures += 1;

                    if err_msg.starts_with("RATE_LIMITED:") {
                        // Parse retry-after and apply extra delay
                        if let Some(secs_str) = err_msg.strip_prefix("RATE_LIMITED:") {
                            if let Ok(secs) = secs_str.parse::<u64>() {
                                drop(s);
                                sleep(Duration::from_secs(secs)).await;
                                continue;
                            }
                        }
                    }

                    drop(s);

                    let _ = app_handle.emit("poll-error", err_msg);
                }
            }
        }
    });
}

/// Resolve the readable issue ID for an activity (e.g. "PROJ-123").
/// Mirrors the frontend's `resolveIssueIdForFilter` logic.
fn resolve_issue_id_readable(activity: &ActivityItem) -> Option<String> {
    let t = activity.target.as_ref()?;
    // Direct issue target (not a comment or article)
    if let Some(ref id_readable) = t.id_readable {
        let target_type = t.target_type.as_deref().unwrap_or("");
        if target_type != "IssueComment" && target_type != "ArticleComment" && target_type != "Article" {
            return Some(id_readable.clone());
        }
    }
    // Parent issue
    if let Some(ref issue) = t.issue {
        if let Some(ref id_readable) = issue.id_readable {
            return Some(id_readable.clone());
        }
    }
    None
}

fn send_os_notification(app_handle: &AppHandle, count: u32) {
    use tauri_plugin_notification::NotificationExt;

    let body = if count > 3 {
        format!("{} new activities in YouTrack", count)
    } else {
        format!(
            "{} new activit{} in YouTrack",
            count,
            if count == 1 { "y" } else { "ies" }
        )
    };

    let _ = app_handle
        .notification()
        .builder()
        .title("YouTrackd")
        .body(&body)
        .show();
}
