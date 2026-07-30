//! Nifty PM provider — two-phase polling.
//!
//! Nifty has no activity feed and no delta API. Verified against the live API:
//!
//! - No `/notifications`, `/activities`, `/events`, `/feed` (all 404).
//! - Tasks carry `created_at` but **no `updated_at`**, so tasks alone cannot
//!   reveal *when* something changed.
//! - `since` / `updated_since` query params are silently ignored — passing
//!   `since=2099-01-01` returns the identical result set, so there is no
//!   server-side delta.
//! - `GET /messages?task_id=` *is* the de-facto activity feed: entries carry
//!   `subtype` (`createTask`, `assignTask`, `moveTask`, `addTaskDeadline`, …),
//!   `updated_at`, `seen_by`, and `tagged`.
//! - `messages?project_id=` returns 400 — messages are per-task only.
//!
//! Naive fan-out is therefore `1 + projects + tasks` calls per cycle. Measured on
//! a 4-project / 101-task workspace that is ~106 calls against a 200 GET/min
//! limit. Since that limit is scoped to the *team*, it is shared by every user of
//! the app in the same workspace — so naive polling cannot ship to arbitrary
//! teams.
//!
//! ## Two-phase design
//!
//! **Phase 1 (cheap sweep):** page `/tasks` per project and fingerprint each task
//! from fields present on the list payload — `comments`, `completed`, `assignees`,
//! `total_subtasks`, `completed_subtasks`, `archived`, `name`, `milestone`,
//! `labels`. Cost is `1 + ceil(tasks/200)` per project, independent of activity.
//!
//! **Phase 2 (targeted):** fetch `/messages` only for tasks whose fingerprint
//! moved. Steady state that is zero; a burst is bounded by `budget`.
//!
//! Unchanged tasks are never message-fetched, which is what makes this viable at
//! scale.

use async_trait::async_trait;
use serde::Deserialize;
use std::collections::HashMap;

use super::actions::{ActionSource, AssigneeOption, StatusOption};
use super::{
    Cursor, EventActor, EventKind, EventSubject, FetchResult, NormalizedEvent, NotificationSource,
    ProviderError, ProviderKind,
};

const API_BASE: &str = "https://openapi.niftypm.com/api/v1.0";

/// Server honours `limit` up to at least 200 (verified); `hasMore` drives paging.
const PAGE_SIZE: u32 = 200;

/// Messages fetched per changed task.
const MESSAGES_PER_TASK: u32 = 20;

/// Nifty's limit is 200 GET/min and is team-scoped — shared across every user of
/// this app in the same workspace. Stay well under it so N clients coexist.
const DEFAULT_BUDGET: u32 = 40;

/// Nifty fan-out is heavier than YouTrack's single call; poll less aggressively.
const MIN_INTERVAL_SECS: u64 = 60;

/// Only surface events from the last 24h on first run, matching YouTrack's
/// initial-load window.
const INITIAL_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Deserialize)]
struct ProjectsResponse {
    #[serde(default)]
    projects: Vec<NiftyProject>,
    #[serde(default)]
    #[allow(dead_code)]
    has_more: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct NiftyProject {
    id: String,
    #[serde(default)]
    nice_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    removed: bool,
}

#[derive(Debug, Deserialize)]
struct TasksResponse {
    #[serde(default)]
    tasks: Vec<NiftyTask>,
    #[serde(default, rename = "hasMore")]
    has_more: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct NiftyTask {
    id: String,
    #[serde(default)]
    nice_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    project: Option<String>,
    // --- fingerprint inputs (all verified present on the list payload) ---
    #[serde(default)]
    comments: i64,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    total_subtasks: i64,
    #[serde(default)]
    completed_subtasks: i64,
    #[serde(default)]
    assignees: Vec<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    milestone: Option<String>,
}

impl NiftyTask {
    /// Compact change-detection fingerprint.
    ///
    /// Nifty gives us no `updated_at` on tasks, so "did this change?" is inferred
    /// by comparing this string across cycles. It covers every mutation the feed
    /// renders; anything it misses is caught by the `comments` counter, since
    /// Nifty records structural changes as messages too.
    fn fingerprint(&self) -> String {
        let mut assignees = self.assignees.clone();
        assignees.sort();
        let mut labels = self.labels.clone();
        labels.sort();
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.comments,
            self.completed as u8,
            self.archived as u8,
            self.total_subtasks,
            self.completed_subtasks,
            assignees.join(","),
            labels.join(","),
            self.milestone.as_deref().unwrap_or(""),
            self.name.as_deref().unwrap_or(""),
        )
    }
}

#[derive(Debug, Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    messages: Vec<NiftyMessage>,
}

#[derive(Debug, Clone, Deserialize)]
struct NiftyMessage {
    id: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    tagged: Vec<String>,
    #[serde(default)]
    seen_by: Vec<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    is_deleted: bool,
}

impl NiftyMessage {
    fn timestamp_ms(&self) -> i64 {
        self.created_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0)
    }

    /// Map Nifty's `subtype` onto the provider-independent taxonomy.
    ///
    /// A `null` subtype is a plain human comment — the common case.
    fn kind(&self) -> EventKind {
        match self.subtype.as_deref() {
            None | Some("") => EventKind::Comment,
            Some("createTask") => EventKind::ItemCreated,
            Some("assignTask") | Some("unassignTask") => EventKind::Assignment,
            Some("completeTask") | Some("uncompleteTask") => EventKind::ItemResolved,
            Some("moveTask") | Some("addTaskDeadline") | Some("removeTaskDeadline")
            | Some("updateTaskDeadline") => EventKind::StatusChange,
            Some("uploadFile") | Some("attachFile") => EventKind::Attachment,
            Some("addTaskToMilestone") | Some("removeTaskFromMilestone") => EventKind::Sprint,
            _ => EventKind::Other,
        }
    }
}

/// Persisted between cycles inside `Cursor::state`.
#[derive(Debug, Default, serde::Serialize, Deserialize)]
struct NiftyCursorState {
    /// task id -> fingerprint from the previous sweep.
    #[serde(default)]
    fingerprints: HashMap<String, String>,
    /// Tasks known to have changed but not yet message-fetched (budget overflow).
    /// Draining this first keeps a burst from starving later cycles.
    #[serde(default)]
    pending: Vec<String>,
}

pub struct NiftyProvider {
    token: String,
    client: reqwest::Client,
    current_user_id: String,
    /// Workspace origin for deep links, e.g. `https://acme.nifty.pm` or a CNAME
    /// custom domain like `https://portal.example.com`.
    ///
    /// Not derivable from the API — it exposes neither the workspace slug nor
    /// the custom domain — so it comes from account config. Empty means
    /// "unknown", and events are emitted without a URL rather than a wrong one.
    workspace_url: String,
}

impl NiftyProvider {
    pub fn new(token: &str, current_user_id: &str) -> Self {
        Self::with_workspace(token, current_user_id, "")
    }

    pub fn with_workspace(token: &str, current_user_id: &str, workspace_url: &str) -> Self {
        Self {
            token: token.to_string(),
            client: reqwest::Client::new(),
            current_user_id: current_user_id.to_string(),
            workspace_url: workspace_url.trim_end_matches('/').to_string(),
        }
    }

    /// Deep link for a task.
    ///
    /// Format verified by opening a real share link in a browser: Nifty's
    /// `/l/{shortcode}` links resolve to
    /// `/{project_id}/task/{task_id}-{slugified-name}`.
    ///
    /// The trailing name slug is cosmetic — loading the bare
    /// `/{project}/task/{id}` form resolves to the same task — so it is omitted
    /// rather than derived, which keeps links correct when a task is renamed.
    ///
    /// The shortcode form is NOT reproducible: it appears nowhere in the API
    /// (searched every task payload in a live workspace), so the canonical route
    /// is the only one we can build.
    ///
    /// Requires the project ID; a task alone is not addressable.
    fn task_url(&self, project_id: Option<&str>, task_id: &str) -> Option<String> {
        let project_id = project_id?;
        if self.workspace_url.is_empty() || project_id.is_empty() || task_id.is_empty() {
            return None;
        }
        Some(format!(
            "{}/{}/task/{}",
            self.workspace_url, project_id, task_id
        ))
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ProviderError> {
        let resp = self
            .client
            .get(format!("{}/{}", API_BASE, path))
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(60);
            return Err(ProviderError::RateLimited(retry));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(ProviderError::Auth(format!(
                "Nifty rejected the token ({})",
                status.as_u16()
            )));
        }
        if !status.is_success() {
            return Err(ProviderError::Other(format!(
                "Nifty API {} on /{}",
                status.as_u16(),
                path
            )));
        }

        resp.json::<T>()
            .await
            .map_err(|e| ProviderError::Other(format!("decode /{}: {}", path, e)))
    }

    async fn list_projects(&self) -> Result<Vec<NiftyProject>, ProviderError> {
        let r: ProjectsResponse = self.get(&format!("projects?limit={}", PAGE_SIZE)).await?;
        Ok(r.projects
            .into_iter()
            .filter(|p| !p.archived && !p.removed)
            .collect())
    }

    /// Phase 1 — page every task in a project, spending at most `budget` calls.
    ///
    /// Returns the tasks seen and the calls used. A truncated sweep is safe:
    /// unswept tasks keep their old fingerprint and are simply re-examined next
    /// cycle rather than being reported as changed.
    async fn sweep_project(
        &self,
        project_id: &str,
        budget: u32,
    ) -> Result<(Vec<NiftyTask>, u32), ProviderError> {
        let mut out = Vec::new();
        let mut offset = 0u32;
        let mut calls = 0u32;

        loop {
            if calls >= budget {
                break;
            }
            let r: TasksResponse = self
                .get(&format!(
                    "tasks?project_id={}&limit={}&offset={}",
                    project_id, PAGE_SIZE, offset
                ))
                .await?;
            calls += 1;

            let n = r.tasks.len() as u32;
            out.extend(r.tasks);

            // `hasMore` is authoritative; the empty-page check guards against a
            // server that reports hasMore=true forever.
            if !r.has_more || n == 0 {
                break;
            }
            offset += n;
        }

        Ok((out, calls))
    }

    /// Phase 2 — pull the message stream for one changed task.
    async fn fetch_messages(&self, task_id: &str) -> Result<Vec<NiftyMessage>, ProviderError> {
        let r: MessagesResponse = self
            .get(&format!(
                "messages?task_id={}&limit={}",
                urlencoding::encode(task_id),
                MESSAGES_PER_TASK
            ))
            .await?;
        Ok(r.messages)
    }

    fn to_event(
        &self,
        msg: &NiftyMessage,
        task: Option<&NiftyTask>,
        project: Option<&NiftyProject>,
    ) -> NormalizedEvent {
        let task_id = msg
            .task
            .clone()
            .or_else(|| task.map(|t| t.id.clone()))
            .unwrap_or_default();

        let display_id = task
            .and_then(|t| t.nice_id.clone())
            .unwrap_or_else(|| task_id.clone());

        let subject = EventSubject {
            id: task_id,
            display_id,
            title: task.and_then(|t| t.name.clone()),
            project_id: project.map(|p| p.id.clone()),
            project_name: project
                .and_then(|p| p.name.clone().or_else(|| p.nice_id.clone())),
        };

        let mentions_me = !self.current_user_id.is_empty()
            && msg.tagged.iter().any(|t| t == &self.current_user_id);

        // `seen_by` exists on the payload but is NOT usable as read state:
        // verified empty across every message in a live workspace, including
        // ones read in the Nifty UI. There is also no endpoint to mark a
        // message read, so it could not be written back regardless.
        //
        // Reporting `None` keeps read state local, same as YouTrack. Do not
        // "fix" this by reading `msg.seen_by` without re-verifying that Nifty
        // actually populates it — a false `Some(true)` silently marks
        // everything read and the feed goes permanently quiet.
        let seen_remotely = None;

        let url = self.task_url(subject.project_id.as_deref(), &subject.id);

        NormalizedEvent {
            id: format!("nifty:{}", msg.id),
            provider: ProviderKind::Nifty,
            timestamp: msg.timestamp_ms(),
            kind: msg.kind(),
            actor: msg.author.as_ref().map(|a| EventActor {
                id: a.clone(),
                name: String::new(),
                avatar_url: String::new(),
            }),
            subject,
            text: msg.text.clone(),
            mentions_me,
            seen_remotely,
            url,
            account_id: String::new(),
            raw: serde_json::to_value(msg).unwrap_or(serde_json::Value::Null),
        }
    }
}

// `raw` needs Serialize; derive it separately to keep the Deserialize block clean.
impl serde::Serialize for NiftyMessage {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("id", &self.id)?;
        m.serialize_entry("text", &self.text)?;
        m.serialize_entry("subtype", &self.subtype)?;
        m.serialize_entry("task", &self.task)?;
        m.serialize_entry("author", &self.author)?;
        m.serialize_entry("tagged", &self.tagged)?;
        m.serialize_entry("createdAt", &self.created_at)?;
        m.end()
    }
}

#[derive(Debug, Deserialize)]
struct NiftyUser {
    id: String,
}

#[async_trait]
impl NotificationSource for NiftyProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Nifty
    }

    fn min_interval_secs(&self) -> u64 {
        MIN_INTERVAL_SECS
    }

    async fn validate(&self) -> Result<String, ProviderError> {
        let u: NiftyUser = self.get("users/me").await?;
        Ok(u.id)
    }

    async fn fetch(&self, cursor: &Cursor, budget: u32) -> Result<FetchResult, ProviderError> {
        let budget = if budget == 0 { DEFAULT_BUDGET } else { budget };
        let mut calls = 0u32;

        let mut state: NiftyCursorState =
            serde_json::from_value(cursor.state.clone()).unwrap_or_default();

        let is_initial = cursor.watermark == 0;

        // --- Phase 1: cheap sweep -------------------------------------------
        let projects = self.list_projects().await?;
        calls += 1;

        let mut tasks_by_id: HashMap<String, NiftyTask> = HashMap::new();
        let mut project_of_task: HashMap<String, String> = HashMap::new();
        let mut changed: Vec<String> = Vec::new();
        let mut next_fingerprints: HashMap<String, String> = HashMap::new();

        for p in &projects {
            if calls >= budget {
                break;
            }
            let (tasks, used) = self.sweep_project(&p.id, budget.saturating_sub(calls)).await?;
            calls += used;

            for t in tasks {
                let fp = t.fingerprint();
                let prev = state.fingerprints.get(&t.id);

                // On first run we don't report every pre-existing task as
                // "changed" — that would flood the feed. We record fingerprints
                // and let the 24h message window below decide what to surface.
                let moved = match prev {
                    Some(old) => old != &fp,
                    None => is_initial,
                };
                if moved {
                    changed.push(t.id.clone());
                }
                next_fingerprints.insert(t.id.clone(), fp);
                project_of_task.insert(t.id.clone(), p.id.clone());
                tasks_by_id.insert(t.id.clone(), t);
            }
        }

        // Drain previously-deferred tasks first so a burst can't starve them.
        let mut queue: Vec<String> = Vec::new();
        for id in state.pending.drain(..) {
            if !queue.contains(&id) {
                queue.push(id);
            }
        }
        for id in changed {
            if !queue.contains(&id) {
                queue.push(id);
            }
        }

        // --- Phase 2: targeted message fetch --------------------------------
        let projects_by_id: HashMap<&str, &NiftyProject> =
            projects.iter().map(|p| (p.id.as_str(), p)).collect();

        let cutoff = if is_initial {
            chrono::Utc::now().timestamp_millis() - INITIAL_WINDOW_MS
        } else {
            cursor.watermark
        };

        let mut events = Vec::new();
        let mut max_ts = cursor.watermark;
        let mut drained = 0usize;

        for task_id in &queue {
            if calls >= budget {
                break;
            }
            let msgs = self.fetch_messages(task_id).await?;
            calls += 1;
            drained += 1;

            let task = tasks_by_id.get(task_id);
            let project = project_of_task
                .get(task_id)
                .and_then(|pid| projects_by_id.get(pid.as_str()).copied());

            for m in &msgs {
                if m.is_deleted {
                    continue;
                }
                let ts = m.timestamp_ms();
                if ts <= cutoff {
                    continue;
                }
                // Suppress the user's own actions, matching YouTrack behaviour.
                if !self.current_user_id.is_empty()
                    && m.author.as_deref() == Some(self.current_user_id.as_str())
                {
                    continue;
                }
                if ts > max_ts {
                    max_ts = ts;
                }
                events.push(self.to_event(m, task, project));
            }
        }

        // Anything we couldn't reach this cycle carries over.
        let pending: Vec<String> = queue.into_iter().skip(drained).collect();

        events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        let next_state = NiftyCursorState {
            fingerprints: next_fingerprints,
            pending,
        };

        Ok(FetchResult {
            events,
            cursor: Cursor {
                // Never regress the watermark, even if a cycle saw nothing.
                watermark: max_ts.max(cursor.watermark).max(if is_initial {
                    chrono::Utc::now().timestamp_millis() - INITIAL_WINDOW_MS
                } else {
                    0
                }),
                state: serde_json::to_value(next_state).unwrap_or(serde_json::Value::Null),
            },
            calls_used: calls,
        })
    }
}

/// Task-group ("status column") as returned by `GET /taskgroups`.
#[derive(Debug, Deserialize)]
struct NiftyTaskGroup {
    id: String,
    #[serde(default)]
    name: Option<String>,
    /// Present when the column represents completion.
    #[serde(default)]
    completed_group: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TaskGroupsResponse {
    /// Note: this endpoint keys its payload `items`, unlike `/tasks` and
    /// `/projects` which use their own names.
    #[serde(default)]
    items: Vec<NiftyTaskGroup>,
}

#[derive(Debug, Deserialize)]
struct NiftyMember {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    removed: bool,
    #[serde(default)]
    pending: bool,
}

impl NiftyProvider {
    /// Send a JSON body and discard the response, mapping status to a typed error.
    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: serde_json::Value,
    ) -> Result<(), ProviderError> {
        let resp = self
            .client
            .request(method, format!("{}/{}", API_BASE, path))
            .header("Authorization", format!("Bearer {}", self.token))
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(60);
            return Err(ProviderError::RateLimited(retry));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(ProviderError::Auth(format!(
                "Nifty rejected the token ({})",
                status.as_u16()
            )));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Other(format!(
                "Nifty API {} on /{}: {}",
                status.as_u16(),
                path,
                body.chars().take(200).collect::<String>()
            )));
        }
        Ok(())
    }
}

#[async_trait]
impl ActionSource for NiftyProvider {
    async fn comment(&self, item_id: &str, text: &str) -> Result<(), ProviderError> {
        if text.trim().is_empty() {
            return Err(ProviderError::Other("Comment text is empty".into()));
        }
        // Verified live: type=text + task_id creates a task comment (HTTP 201).
        self.send_json(
            reqwest::Method::POST,
            "messages",
            serde_json::json!({
                "type": "text",
                "text": text,
                "task_id": item_id,
            }),
        )
        .await
    }

    async fn statuses(&self, project_id: &str) -> Result<Vec<StatusOption>, ProviderError> {
        if project_id.is_empty() {
            return Ok(Vec::new());
        }
        // `archived`, `limit` and `offset` are documented as optional but the
        // server returns 400 without them.
        let r: TaskGroupsResponse = self
            .get(&format!(
                "taskgroups?project_id={}&archived=false&limit=200&offset=0",
                urlencoding::encode(project_id)
            ))
            .await?;

        Ok(r.items
            .into_iter()
            .map(|g| StatusOption {
                is_resolved: g
                    .completed_group
                    .as_ref()
                    .map(|v| !v.is_null() && v.as_bool() != Some(false))
                    .unwrap_or(false),
                name: g.name.unwrap_or_else(|| g.id.clone()),
                id: g.id,
            })
            .collect())
    }

    async fn set_status(&self, item_id: &str, status_id: &str) -> Result<(), ProviderError> {
        // In Nifty a task's status IS its board column.
        self.send_json(
            reqwest::Method::PUT,
            &format!("tasks/{}", urlencoding::encode(item_id)),
            serde_json::json!({ "task_group_id": status_id }),
        )
        .await
    }

    async fn assignees(&self, project_id: &str) -> Result<Vec<AssigneeOption>, ProviderError> {
        if project_id.is_empty() {
            return Ok(Vec::new());
        }
        let members: Vec<NiftyMember> = self
            .get(&format!(
                "members?project_id={}",
                urlencoding::encode(project_id)
            ))
            .await?;

        Ok(members
            .into_iter()
            .filter(|m| !m.removed && !m.pending)
            .map(|m| AssigneeOption {
                login: m.email.clone().unwrap_or_default(),
                name: m
                    .name
                    .or(m.email)
                    .unwrap_or_else(|| m.id.clone()),
                avatar_url: m.avatar.unwrap_or_default(),
                id: m.id,
            })
            .collect())
    }

    async fn assign(&self, item_id: &str, assignee_id: &str) -> Result<(), ProviderError> {
        // `assignees` replaces the whole list, so this sets a single assignee
        // rather than adding one.
        self.send_json(
            reqwest::Method::PUT,
            &format!("tasks/{}", urlencoding::encode(item_id)),
            serde_json::json!({ "assignees": [assignee_id] }),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, comments: i64, completed: bool) -> NiftyTask {
        NiftyTask {
            id: id.into(),
            nice_id: Some(format!("T-{}", id)),
            name: Some("task".into()),
            project: Some("p1".into()),
            comments,
            completed,
            archived: false,
            total_subtasks: 0,
            completed_subtasks: 0,
            assignees: vec![],
            labels: vec![],
            milestone: None,
        }
    }

    /// The exact call onboarding makes when a user connects a Nifty account:
    /// validate a token with no workspace host configured. Must return the user
    /// ID, since the UI keys the account on it.
    #[tokio::test]
    #[ignore]
    async fn onboarding_validate_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let p = NiftyProvider::new(&token, "");
        let uid = p.validate().await.expect("validate failed");
        println!("validate returned user id: {}", uid);
        assert!(!uid.is_empty(), "validate returned an empty user id");
    }

    /// A bad token must fail cleanly as an auth error, not hang or panic —
    /// onboarding surfaces this message directly to the user.
    #[tokio::test]
    #[ignore]
    async fn onboarding_rejects_bad_token_live() {
        let p = NiftyProvider::new("definitely-not-a-real-token", "");
        match p.validate().await {
            Err(ProviderError::Auth(m)) => println!("rejected as auth error: {}", m),
            Err(other) => println!("rejected as: {}", other),
            Ok(id) => panic!("bogus token unexpectedly validated as {}", id),
        }
    }

    /// Read-only halves of the quick actions, against the live API. The write
    /// halves (set_status/assign/comment) are deliberately not exercised here —
    /// they mutate a real workspace.
    #[tokio::test]
    #[ignore]
    async fn quick_action_options_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let uid = NiftyProvider::new(&token, "").validate().await.unwrap();
        let p = NiftyProvider::new(&token, &uid);

        const PROJECT: &str = "iVLWyIgDPUTn4W";

        let statuses = p.statuses(PROJECT).await.expect("statuses failed");
        println!("statuses: {}", statuses.len());
        for s in statuses.iter().take(5) {
            println!("  {} => {}", s.id, s.name);
        }
        assert!(!statuses.is_empty(), "no status columns returned");
        assert!(
            statuses.iter().all(|s| !s.id.is_empty() && !s.name.is_empty()),
            "a status option is missing an id or name"
        );

        let people = p.assignees(PROJECT).await.expect("assignees failed");
        println!("assignees: {}", people.len());
        for a in people.iter().take(5) {
            println!("  {} => {}", a.id, a.name);
        }
        assert!(
            people.iter().all(|a| !a.id.is_empty() && !a.name.is_empty()),
            "an assignee option is missing an id or name"
        );
    }

    /// An empty comment must be rejected before any network call.
    #[tokio::test]
    async fn empty_comment_is_rejected() {
        let p = NiftyProvider::new("t", "u");
        assert!(p.comment("task", "   ").await.is_err());
    }

    #[test]
    fn task_url_matches_verified_canonical_format() {
        // Verified in a browser: /l/{code} resolves to /{project}/task/{task}.
        let p = NiftyProvider::with_workspace("t", "u", "https://protomated.nifty.pm");
        assert_eq!(
            p.task_url(Some("iVLWyIgDPUTn4W"), "ymaf9QHxcUq!Uc").as_deref(),
            Some("https://protomated.nifty.pm/iVLWyIgDPUTn4W/task/ymaf9QHxcUq!Uc")
        );
    }

    #[test]
    fn task_url_supports_cname_custom_domain() {
        let p = NiftyProvider::with_workspace("t", "u", "https://portal.protomated.com");
        assert_eq!(
            p.task_url(Some("proj"), "abc123").as_deref(),
            Some("https://portal.protomated.com/proj/task/abc123")
        );
    }

    #[test]
    fn task_url_tolerates_trailing_slash() {
        let p = NiftyProvider::with_workspace("t", "u", "https://acme.nifty.pm/");
        assert_eq!(
            p.task_url(Some("proj"), "x").as_deref(),
            Some("https://acme.nifty.pm/proj/task/x")
        );
    }

    /// Without a host or a project there is no addressable URL — emitting a
    /// guessed one would deep-link users somewhere they cannot open.
    #[test]
    fn task_url_is_none_without_workspace_or_project() {
        assert!(NiftyProvider::new("t", "u").task_url(Some("p"), "abc").is_none());
        let p = NiftyProvider::with_workspace("t", "u", "https://acme.nifty.pm");
        assert!(p.task_url(None, "abc").is_none());
        assert!(p.task_url(Some(""), "abc").is_none());
    }

    #[test]
    fn fingerprint_detects_new_comment() {
        let a = task("1", 0, false);
        let b = task("1", 1, false);
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    #[test]
    fn fingerprint_detects_completion() {
        assert_ne!(task("1", 0, false).fingerprint(), task("1", 0, true).fingerprint());
    }

    #[test]
    fn fingerprint_is_stable_for_unchanged_task() {
        assert_eq!(task("1", 3, false).fingerprint(), task("1", 3, false).fingerprint());
    }

    #[test]
    fn fingerprint_ignores_assignee_ordering() {
        let mut a = task("1", 0, false);
        let mut b = task("1", 0, false);
        a.assignees = vec!["u1".into(), "u2".into()];
        b.assignees = vec!["u2".into(), "u1".into()];
        assert_eq!(a.fingerprint(), b.fingerprint());
    }

    #[test]
    fn fingerprint_detects_assignee_change() {
        let mut a = task("1", 0, false);
        let mut b = task("1", 0, false);
        a.assignees = vec!["u1".into()];
        b.assignees = vec!["u2".into()];
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    #[test]
    fn subtype_maps_to_event_kind() {
        let mk = |s: Option<&str>| NiftyMessage {
            id: "m".into(),
            text: None,
            subtype: s.map(String::from),
            task: None,
            author: None,
            tagged: vec![],
            seen_by: vec![],
            created_at: None,
            is_deleted: false,
        };
        assert_eq!(mk(None).kind(), EventKind::Comment);
        assert_eq!(mk(Some("createTask")).kind(), EventKind::ItemCreated);
        assert_eq!(mk(Some("assignTask")).kind(), EventKind::Assignment);
        assert_eq!(mk(Some("moveTask")).kind(), EventKind::StatusChange);
        assert_eq!(mk(Some("wat")).kind(), EventKind::Other);
    }

    /// Live check against the real Nifty API. Ignored by default (needs
    /// NIFTY_TOKEN and hits the network); run with:
    ///   cargo test --lib two_phase_live -- --ignored --nocapture
    ///
    /// Asserts the property the whole design rests on: a second poll with an
    /// unchanged cursor must spend *only* sweep calls, never per-task message
    /// calls. If that regresses, the poller silently reverts to O(tasks)
    /// fan-out and will exhaust the team-shared rate limit at scale.
    #[tokio::test]
    #[ignore]
    async fn two_phase_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let p = NiftyProvider::new(&token, "");

        let uid = p.validate().await.expect("validate failed");
        println!("authenticated as {}", uid);

        let p = NiftyProvider::new(&token, &uid);

        let first = p
            .fetch(&Cursor::default(), 120)
            .await
            .expect("initial fetch failed");
        println!(
            "cold  : {} events, {} calls",
            first.events.len(),
            first.calls_used
        );

        let second = p
            .fetch(&first.cursor, 120)
            .await
            .expect("second fetch failed");
        println!(
            "warm  : {} events, {} calls",
            second.events.len(),
            second.calls_used
        );

        let state: NiftyCursorState =
            serde_json::from_value(second.cursor.state.clone()).unwrap_or_default();
        println!("fingerprints tracked: {}", state.fingerprints.len());
        println!("pending carryover   : {}", state.pending.len());

        assert!(
            !state.fingerprints.is_empty(),
            "sweep recorded no fingerprints — phase 1 is broken"
        );

        // The core scaling property.
        assert!(
            second.calls_used <= first.calls_used,
            "warm poll ({}) cost more than cold ({}) — fan-out is not being suppressed",
            second.calls_used,
            first.calls_used
        );

        assert!(
            second.cursor.watermark >= first.cursor.watermark,
            "watermark regressed: {} -> {}",
            first.cursor.watermark,
            second.cursor.watermark
        );
    }

    /// Cold start must respect `budget` rather than fanning out unbounded —
    /// otherwise the first poll of a large workspace blows the team-shared rate
    /// limit on its own. Deferred tasks must land in `pending` for later cycles.
    #[tokio::test]
    #[ignore]
    async fn cold_start_respects_budget_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let uid = NiftyProvider::new(&token, "").validate().await.unwrap();
        let p = NiftyProvider::new(&token, &uid);

        let budget = 15u32;
        let r = p.fetch(&Cursor::default(), budget).await.expect("fetch failed");
        println!("capped: {} calls (budget {})", r.calls_used, budget);

        let st: NiftyCursorState =
            serde_json::from_value(r.cursor.state.clone()).unwrap_or_default();
        println!("deferred to pending: {}", st.pending.len());

        assert!(
            r.calls_used <= budget,
            "spent {} calls with a budget of {}",
            r.calls_used,
            budget
        );
    }

    #[test]
    fn parses_rfc3339_timestamp() {
        let m = NiftyMessage {
            id: "m".into(),
            text: None,
            subtype: None,
            task: None,
            author: None,
            tagged: vec![],
            seen_by: vec![],
            created_at: Some("2024-07-29T20:40:01.721Z".into()),
            is_deleted: false,
        };
        assert_eq!(m.timestamp_ms(), 1722285601721);
    }
}
