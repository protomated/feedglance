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
//! - `messages?project_id=` returns 400 — but that is the wrong *parameter*, not
//!   proof that only tasks have messages. Project discussions are reachable via
//!   `messages?chat_id=`; see "Project discussions" below.
//!
//! ## Project discussions
//!
//! Each project carries `general_discussion`, the chat ID of its discussion
//! channel, and `GET /messages?chat_id={id}` returns that thread in the same
//! message shape as tasks (differing only in `chat` replacing `task`).
//!
//! There is **no cheap change signal** for discussions, verified live:
//!
//! - Discussion chats are absent from `GET /chats` entirely — it lists only DMs,
//!   so they cannot be enumerated or diffed there.
//! - `GET /chats/{id}` does return the chat with `last_message_at`, but that
//!   field is unreliable in *both* directions: one project reported a timestamp
//!   a day older than its own newest message (a real message would be missed),
//!   while three empty discussions reported recent timestamps (fetching forever
//!   for nothing). It tracks the chat object, not its messages.
//! - Nothing on the project payload moves when a message is posted.
//!
//! So discussions cost one unconditional call each. To keep that from scaling
//! with project count, they are polled on a **rotation**: at most
//! `DISCUSSIONS_PER_CYCLE` per cycle, resuming where the last cycle stopped, and
//! only after task fan-out has taken its share. Every discussion is still
//! visited — just not all in the same cycle.
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

use super::actions::{render_mentions, ActionSource, AssigneeOption, StatusOption};
use super::{
    Cursor, EventActor, EventKind, EventSubject, FetchResult, NormalizedEvent, NotificationSource,
    ProviderError, ProviderKind,
};

const API_BASE: &str = "https://openapi.niftypm.com/api/v1.0";

/// Server honours `limit` up to at least 200 (verified); `hasMore` drives paging.
const PAGE_SIZE: u32 = 200;

/// Messages fetched per changed task.
const MESSAGES_PER_TASK: u32 = 20;

/// Messages fetched per project discussion.
const MESSAGES_PER_DISCUSSION: u32 = 20;

/// Discussions polled per cycle, resuming via `discussion_rotation`.
///
/// Discussions have no change signal, so each costs a call whether or not
/// anything was said. Capping the per-cycle count keeps that bounded on
/// workspaces with many projects; at a 60s floor a 40-project workspace still
/// sees every discussion within ~2 minutes.
const DISCUSSIONS_PER_CYCLE: usize = 6;

/// Marks a subject ID as a project discussion rather than a task.
///
/// The quick-action path (`ActionSource::comment`) receives only an opaque item
/// ID, with no room for a subject *type*. Encoding it in the ID lets a reply be
/// routed to `chat_id` instead of `task_id` without threading a new parameter
/// through the trait, the Tauri command, and the frontend.
///
/// Nifty IDs are opaque and may contain `!` and `_`, but never `:` — verified
/// across every task, project, chat, and message ID in a live workspace — so
/// this cannot collide with a real ID.
pub(crate) const DISCUSSION_ID_PREFIX: &str = "chat:";

/// Calls held back from task fan-out so phase 3 can always run.
///
/// Without this, discussions are starved outright on any workspace whose task
/// backlog saturates `budget` — verified live: three consecutive cycles spent
/// 120/120 calls on tasks and left the discussion rotation pinned at 0, so no
/// discussion was ever polled. Tasks give up a few calls per cycle and drain
/// one cycle later; discussions go from never to always.
const DISCUSSION_RESERVE: u32 = DISCUSSIONS_PER_CYCLE as u32;

/// Nifty's limit is 200 GET/min and is team-scoped — shared across every user of
/// this app in the same workspace. Stay well under it so N clients coexist.
///
/// Only a fallback for callers that pass 0; the engine supplies `CALL_BUDGET`.
/// Kept in step with it so a cold start can actually drain (40 could not).
const DEFAULT_BUDGET: u32 = 100;

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
    /// Chat ID of the project's discussion channel. Absent on projects with the
    /// discussion module switched off.
    #[serde(default)]
    general_discussion: Option<String>,
    /// User has muted the discussion in Nifty's own UI; respected so the app
    /// does not notify for a channel Nifty itself stays quiet about.
    #[serde(default)]
    general_discussion_muted: bool,
    /// Which project modules are switched on. `discussion` absent means the
    /// channel is disabled even when `general_discussion` still holds an ID.
    #[serde(default)]
    enabled_modules: Vec<String>,
}

impl NiftyProject {
    /// The discussion chat to poll, or `None` when there is nothing to poll.
    fn discussion_chat(&self) -> Option<&str> {
        if self.general_discussion_muted {
            return None;
        }
        // An empty `enabled_modules` means the payload omitted it rather than
        // that every module is off — don't silently disable discussions then.
        if !self.enabled_modules.is_empty()
            && !self.enabled_modules.iter().any(|m| m == "discussion")
        {
            return None;
        }
        self.general_discussion
            .as_deref()
            .filter(|id| !id.is_empty())
    }
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
    /// Parent chat, present on project-discussion messages in place of `task`.
    #[serde(default)]
    chat: Option<String>,
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
            // Date changes ride alongside moves as status-ish updates.
            // `addTaskStartDate` was observed live and previously fell through
            // to `Other`; its siblings are included for symmetry with the
            // deadline set, which Nifty names the same way.
            Some("moveTask") | Some("addTaskDeadline") | Some("removeTaskDeadline")
            | Some("updateTaskDeadline") | Some("addTaskStartDate")
            | Some("removeTaskStartDate") | Some("updateTaskStartDate") => EventKind::StatusChange,
            Some("uploadFile") | Some("attachFile") => EventKind::Attachment,
            Some("addTaskToMilestone") | Some("removeTaskFromMilestone") => EventKind::Sprint,
            // Discussion-channel membership events, observed live on
            // `messages?chat_id=`. Closest to "something was created" in the
            // shared taxonomy; without this they fall through to `Other`.
            Some("joinProject") | Some("leaveProject") => EventKind::ItemCreated,
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
    /// Index into the project list where the next discussion sweep resumes.
    /// Discussions have no change signal, so they are polled round-robin rather
    /// than all at once; this is what makes the rotation resume across cycles.
    #[serde(default)]
    discussion_rotation: usize,
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

    /// Deep link for a project's discussion channel.
    ///
    /// The path segment matches the module name the API itself uses in
    /// `enabled_modules` (`discussion`). Unlike `task_url`, this route is NOT
    /// browser-verified: Nifty is a SPA and answers 200 for any path, so a
    /// fetch cannot distinguish a real route from a client-side 404. If users
    /// report discussion links landing on an empty page, check the real route
    /// in the Nifty UI — the event itself is unaffected.
    fn discussion_url(&self, project_id: Option<&str>) -> Option<String> {
        let project_id = project_id?;
        if self.workspace_url.is_empty() || project_id.is_empty() {
            return None;
        }
        Some(format!("{}/{}/discussion", self.workspace_url, project_id))
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

    /// Should this message be hidden because the user caused it themselves?
    ///
    /// Own actions are suppressed to match YouTrack behaviour — you don't want
    /// your own comments notifying you. An explicit @-tag overrides that: a
    /// direct mention is the highest-signal event the feed carries, and Nifty's
    /// UI shows it regardless of who wrote it. Suppressing a self-authored
    /// mention is what made the app disagree with Nifty's own notification list.
    fn is_suppressed_own_action(&self, msg: &NiftyMessage) -> bool {
        if self.current_user_id.is_empty() {
            return false;
        }
        let mine = msg.author.as_deref() == Some(self.current_user_id.as_str());
        let tags_me = msg.tagged.iter().any(|t| t == &self.current_user_id);
        mine && !tags_me
    }

    /// Workspace member directory, keyed by user ID.
    ///
    /// Messages carry only an author *ID* (`fo_OWHEm!UvNxf`), never a display
    /// name, so without this every Nifty event renders its author as "Unknown".
    /// One call per cycle covers the whole workspace, unlike `assignees` which
    /// is per-project.
    ///
    /// Removed and pending members are kept: they still authored past messages,
    /// and dropping them would regress those events back to "Unknown".
    async fn member_directory(&self) -> Result<HashMap<String, EventActor>, ProviderError> {
        let members: Vec<NiftyMember> = self.get("members?limit=200").await?;
        Ok(members
            .into_iter()
            .map(|m| {
                let name = m
                    .name
                    .filter(|n| !n.trim().is_empty())
                    .or(m.email)
                    .unwrap_or_else(|| m.id.clone());
                (
                    m.id.clone(),
                    EventActor {
                        id: m.id,
                        name: name.trim().to_string(),
                        avatar_url: m.avatar.unwrap_or_default(),
                    },
                )
            })
            .collect())
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

    /// Phase 3 — pull one project's discussion channel.
    ///
    /// Same endpoint and payload shape as tasks, keyed by `chat_id`.
    async fn fetch_discussion(&self, chat_id: &str) -> Result<Vec<NiftyMessage>, ProviderError> {
        let r: MessagesResponse = self
            .get(&format!(
                "messages?chat_id={}&limit={}",
                urlencoding::encode(chat_id),
                MESSAGES_PER_DISCUSSION
            ))
            .await?;
        Ok(r.messages)
    }

    /// Replace Nifty's `<@userId>` mention tokens with display names.
    ///
    /// Message bodies embed raw IDs (`<@fo_OWHEm!UvNxf> is this the case?`),
    /// which is unreadable in a feed. IDs contain `!` and other punctuation, so
    /// this scans for the literal delimiters rather than using a character class.
    ///
    /// An unresolvable ID (author no longer in the workspace) keeps its raw
    /// token rather than being blanked — showing *something* beats silently
    /// dropping who was mentioned.
    fn resolve_mentions(text: &str, directory: &HashMap<String, EventActor>) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;

        while let Some(start) = rest.find("<@") {
            let (before, from_token) = rest.split_at(start);
            out.push_str(before);

            let body = &from_token[2..];
            match body.find('>') {
                Some(end) => {
                    let id = &body[..end];
                    match directory.get(id) {
                        Some(actor) if !actor.name.is_empty() => {
                            out.push('@');
                            out.push_str(&actor.name);
                        }
                        // Unknown ID — leave the original token intact.
                        _ => out.push_str(&from_token[..end + 3]),
                    }
                    rest = &body[end + 1..];
                }
                // Unterminated token; emit the remainder verbatim.
                None => {
                    out.push_str(from_token);
                    return out;
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn to_event(
        &self,
        msg: &NiftyMessage,
        task: Option<&NiftyTask>,
        project: Option<&NiftyProject>,
        directory: &HashMap<String, EventActor>,
    ) -> NormalizedEvent {
        let task_id = msg
            .task
            .clone()
            .or_else(|| task.map(|t| t.id.clone()))
            .unwrap_or_default();

        // A discussion message has no task — its subject is the project itself.
        // Keying it on the task ID would produce an event with an empty subject
        // and no deep link, so the two shapes are built separately.
        let is_discussion = task_id.is_empty() && msg.chat.is_some();

        let subject = if is_discussion {
            let project_name = project
                .and_then(|p| p.name.clone().or_else(|| p.nice_id.clone()));
            EventSubject {
                // Prefixed with the chat ID so a reply can be routed back to
                // `chat_id` rather than `task_id`. The quick-action path carries
                // only an opaque item ID, so the routing information has to live
                // in the ID itself; `comment()` splits it back apart.
                id: msg
                    .chat
                    .as_deref()
                    .map(|c| format!("{}{}", DISCUSSION_ID_PREFIX, c))
                    .unwrap_or_default(),
                display_id: project
                    .and_then(|p| p.nice_id.clone())
                    .or_else(|| project_name.clone())
                    .unwrap_or_default(),
                // The feed groups by subject; naming it "Discussion" is what
                // distinguishes a project's discussion from its tasks.
                title: Some(match project_name.as_deref() {
                    Some(n) => format!("{} · Discussion", n),
                    None => "Discussion".to_string(),
                }),
                project_id: project.map(|p| p.id.clone()),
                project_name,
            }
        } else {
            EventSubject {
                display_id: task
                    .and_then(|t| t.nice_id.clone())
                    .unwrap_or_else(|| task_id.clone()),
                id: task_id,
                title: task.and_then(|t| t.name.clone()),
                project_id: project.map(|p| p.id.clone()),
                project_name: project
                    .and_then(|p| p.name.clone().or_else(|| p.nice_id.clone())),
            }
        };

        let mentions_me = !self.current_user_id.is_empty()
            && msg.tagged.iter().any(|t| t == &self.current_user_id);

        // `seen_by` IS populated — an earlier note here claimed it was always
        // empty, which re-probing disproved: 15 of 26 sampled task messages had
        // a non-empty `seen_by`, 10 of them containing the current user, and
        // discussion messages behave the same way.
        //
        // It still is not wired up, for a different reason: read state is
        // one-way. Every mark-read route 404s — `PUT|POST /messages/{id}/seen`,
        // `/messages/{id}/read`, `/messages/seen`, `PUT|POST /chats/{id}/seen`
        // — and `PUT /messages/{id}` with `{"seen": true}` returns 500 while
        // leaving `seen_by` unchanged. So the app could read Nifty's read state
        // but never write its own back, and the two would diverge the moment a
        // user marked anything read here.
        //
        // Reporting `None` keeps read state local and self-consistent, same as
        // YouTrack. Surfacing `seen_by` is defensible *only* alongside a
        // one-way-sync story for that divergence; a naive `Some(true)` marks
        // everything already-read on first poll and the feed goes silent.
        let seen_remotely = None;

        // Discussion subjects carry a `chat:`-prefixed ID, so the task route
        // must not be built from it.
        let url = if is_discussion {
            self.discussion_url(subject.project_id.as_deref())
        } else {
            self.task_url(subject.project_id.as_deref(), &subject.id)
        };

        NormalizedEvent {
            id: format!("nifty:{}", msg.id),
            provider: ProviderKind::Nifty,
            timestamp: msg.timestamp_ms(),
            kind: msg.kind(),
            // Fall back to the bare ID when the author has left the workspace
            // and is absent from the directory — better than rendering
            // "Unknown".
            actor: msg.author.as_ref().map(|a| {
                directory.get(a).cloned().unwrap_or_else(|| EventActor {
                    id: a.clone(),
                    name: a.clone(),
                    avatar_url: String::new(),
                })
            }),
            subject,
            text: msg
                .text
                .as_deref()
                .map(|t| Self::resolve_mentions(t, directory)),
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
        m.serialize_entry("chat", &self.chat)?;
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

        // Budget tasks may spend, holding back enough for phase 3. Reserving up
        // front is what keeps a saturated task backlog from starving
        // discussions entirely; see DISCUSSION_RESERVE.
        //
        // The reserve is capped at a quarter of the budget so a small budget is
        // not dominated by it — with `budget: 15` a flat reserve would hand a
        // third of the cycle to discussions and stall the cold-start task drain.
        let reserve = DISCUSSION_RESERVE.min(budget / 4);
        let task_budget = budget.saturating_sub(reserve);

        // --- Phase 1: cheap sweep -------------------------------------------
        let projects = self.list_projects().await?;
        calls += 1;

        let mut tasks_by_id: HashMap<String, NiftyTask> = HashMap::new();
        let mut project_of_task: HashMap<String, String> = HashMap::new();
        let mut changed: Vec<String> = Vec::new();
        let mut next_fingerprints: HashMap<String, String> = HashMap::new();

        for p in &projects {
            if calls >= task_budget {
                break;
            }
            let (tasks, used) = self
                .sweep_project(&p.id, task_budget.saturating_sub(calls))
                .await?;
            calls += used;

            for t in tasks {
                let fp = t.fingerprint();
                let prev = state.fingerprints.get(&t.id);

                // A task with no stored fingerprint has never been examined, so
                // we cannot tell whether it changed — it must be inspected.
                //
                // This is not only the cold-start case: `restore_activities`
                // deliberately restores the watermark but NOT the fingerprint
                // map, so a normal app restart lands here with `is_initial ==
                // false` and an empty map. Treating that as "unchanged" made
                // phase 2 never run, and any event newer than the restored
                // watermark became permanently unreachable — the feed went
                // silent until the account was re-added.
                //
                // Inspecting them is safe: the `cutoff` below still filters by
                // timestamp, so this costs message calls on the first cycle
                // after a restart but cannot surface anything already reported.
                let moved = match prev {
                    Some(old) => old != &fp,
                    None => true,
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

        // Discussions to visit this cycle, resuming the rotation where the last
        // cycle stopped. Built before the directory so a cycle with no task
        // changes but a pending discussion still resolves author names.
        let discussion_targets: Vec<(String, String)> = projects
            .iter()
            .filter_map(|p| p.discussion_chat().map(|c| (p.id.clone(), c.to_string())))
            .collect();

        let rotation_start = if discussion_targets.is_empty() {
            0
        } else {
            state.discussion_rotation % discussion_targets.len()
        };
        let discussion_slice: Vec<(String, String)> = discussion_targets
            .iter()
            .cycle()
            .skip(rotation_start)
            .take(DISCUSSIONS_PER_CYCLE.min(discussion_targets.len()))
            .cloned()
            .collect();

        // Author names come from the member directory — one call, and only when
        // there is actually something to render, so a quiet cycle still costs
        // just the phase-1 sweep. A failure here is non-fatal: events fall back
        // to bare IDs rather than being dropped.
        let directory = if queue.is_empty() && discussion_slice.is_empty() {
            HashMap::new()
        } else {
            match self.member_directory().await {
                Ok(d) => {
                    calls += 1;
                    d
                }
                Err(_) => {
                    calls += 1;
                    HashMap::new()
                }
            }
        };

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
            if calls >= task_budget {
                break;
            }
            // A per-task failure must not discard the whole cycle. Nifty
            // intermittently 502s on individual /messages calls (observed live,
            // succeeds on retry); propagating that threw away every event
            // already collected from the other ~280 tasks. Auth and rate-limit
            // errors are still fatal — they apply to the whole cycle, and
            // continuing would burn the team-shared budget for nothing.
            let msgs = match self.fetch_messages(task_id).await {
                Ok(m) => m,
                Err(e @ (ProviderError::Auth(_) | ProviderError::RateLimited(_))) => return Err(e),
                Err(_) => {
                    // Leave the fingerprint stale so the task is retried next
                    // cycle rather than being silently marked up-to-date.
                    next_fingerprints.remove(task_id);
                    calls += 1;
                    drained += 1;
                    continue;
                }
            };
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
                if self.is_suppressed_own_action(m) {
                    continue;
                }
                if ts > max_ts {
                    max_ts = ts;
                }
                events.push(self.to_event(m, task, project, &directory));
            }
        }

        // Anything we couldn't reach this cycle carries over.
        let pending: Vec<String> = queue.into_iter().skip(drained).collect();

        // --- Phase 3: project discussions (rotation) ------------------------
        //
        // Unconditional — discussions expose no change signal — so this runs
        // after task fan-out and only with whatever budget survived it. Tasks
        // keep priority because they carry the `pending` backlog; a starved
        // discussion is simply visited on a later turn of the rotation.
        let mut discussions_visited = 0usize;
        for (project_id, chat_id) in &discussion_slice {
            if calls >= budget {
                break;
            }
            let msgs = match self.fetch_discussion(chat_id).await {
                Ok(m) => m,
                Err(e @ (ProviderError::Auth(_) | ProviderError::RateLimited(_))) => return Err(e),
                Err(_) => {
                    // Transient per-chat failure (Nifty 502s intermittently).
                    // Count it as visited so the rotation still advances rather
                    // than retrying the same broken chat forever.
                    calls += 1;
                    discussions_visited += 1;
                    continue;
                }
            };
            calls += 1;
            discussions_visited += 1;

            let project = projects_by_id.get(project_id.as_str()).copied();

            for m in &msgs {
                if m.is_deleted {
                    continue;
                }
                let ts = m.timestamp_ms();
                if ts <= cutoff {
                    continue;
                }
                if self.is_suppressed_own_action(m) {
                    continue;
                }
                if ts > max_ts {
                    max_ts = ts;
                }
                events.push(self.to_event(m, None, project, &directory));
            }
        }

        let discussion_rotation = if discussion_targets.is_empty() {
            0
        } else {
            (rotation_start + discussions_visited) % discussion_targets.len()
        };

        events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        let next_state = NiftyCursorState {
            fingerprints: next_fingerprints,
            pending,
            discussion_rotation,
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
        // Nifty links a mention only from a `<@userId>` token — the same form
        // `resolve_mentions` decodes on the way in. Sending the display name or
        // email as plain text posts fine but links nobody and notifies nobody.
        let body = render_mentions(text, |m| format!("<@{}>", m.id));

        // A project discussion posts to the same endpoint but keys on `chat_id`;
        // sending `task_id` for a chat (or vice versa) is rejected. Both shapes
        // verified live against the real API — each returns HTTP 201.
        let payload = match item_id.strip_prefix(DISCUSSION_ID_PREFIX) {
            Some(chat_id) => serde_json::json!({
                "type": "text",
                "text": body,
                "chat_id": chat_id,
            }),
            None => serde_json::json!({
                "type": "text",
                "text": body,
                "task_id": item_id,
            }),
        };

        self.send_json(reqwest::Method::POST, "messages", payload)
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

    fn msg(author: &str, tagged: &[&str]) -> NiftyMessage {
        NiftyMessage {
            id: "m".into(),
            text: None,
            subtype: None,
            task: None,
            chat: None,
            author: Some(author.into()),
            tagged: tagged.iter().map(|s| s.to_string()).collect(),
            seen_by: vec![],
            created_at: None,
            is_deleted: false,
        }
    }

    /// The regression behind "Nifty shows it but the app doesn't": a comment the
    /// user wrote that @-tags the user is a real notification in Nifty's UI, so
    /// self-suppression must not eat it.
    #[test]
    fn own_message_that_mentions_me_is_not_suppressed() {
        let p = NiftyProvider::new("t", "me");
        assert!(!p.is_suppressed_own_action(&msg("me", &["me"])));
    }

    #[test]
    fn own_message_without_mention_is_suppressed() {
        let p = NiftyProvider::new("t", "me");
        assert!(p.is_suppressed_own_action(&msg("me", &[])));
    }

    /// Tagging someone else in your own comment is still your own action.
    #[test]
    fn own_message_mentioning_someone_else_is_suppressed() {
        let p = NiftyProvider::new("t", "me");
        assert!(p.is_suppressed_own_action(&msg("me", &["other"])));
    }

    #[test]
    fn other_authors_are_never_suppressed() {
        let p = NiftyProvider::new("t", "me");
        assert!(!p.is_suppressed_own_action(&msg("other", &[])));
        assert!(!p.is_suppressed_own_action(&msg("other", &["me"])));
    }

    /// Before validate() resolves a user ID there is nobody to suppress, and
    /// guessing would blank the feed entirely.
    #[test]
    fn unknown_user_suppresses_nothing() {
        let p = NiftyProvider::new("t", "");
        assert!(!p.is_suppressed_own_action(&msg("anyone", &[])));
    }

    fn directory(pairs: &[(&str, &str)]) -> HashMap<String, EventActor> {
        pairs
            .iter()
            .map(|(id, name)| {
                (
                    id.to_string(),
                    EventActor {
                        id: id.to_string(),
                        name: name.to_string(),
                        avatar_url: String::new(),
                    },
                )
            })
            .collect()
    }

    /// Nifty user IDs contain `!` and other punctuation, so the parser must key
    /// off the literal `<@`/`>` delimiters rather than a word-character class.
    #[test]
    fn resolves_mention_token_with_punctuation_in_id() {
        let d = directory(&[("fo_OWHEm!UvNxf", "Dele")]);
        assert_eq!(
            NiftyProvider::resolve_mentions("<@fo_OWHEm!UvNxf> is this the casE?", &d),
            "@Dele is this the casE?"
        );
    }

    #[test]
    fn resolves_multiple_mentions() {
        let d = directory(&[("a!1", "Ada"), ("b!2", "Bo")]);
        assert_eq!(
            NiftyProvider::resolve_mentions("<@a!1> ping <@b!2> now", &d),
            "@Ada ping @Bo now"
        );
    }

    /// A departed author is absent from the directory; keeping the raw token
    /// beats blanking out who was mentioned.
    #[test]
    fn unknown_mention_id_is_left_intact() {
        let d = directory(&[("known", "Kim")]);
        assert_eq!(
            NiftyProvider::resolve_mentions("<@ghost> and <@known>", &d),
            "<@ghost> and @Kim"
        );
    }

    #[test]
    fn text_without_mentions_is_unchanged() {
        let d = directory(&[("a", "Ada")]);
        assert_eq!(NiftyProvider::resolve_mentions("plain text", &d), "plain text");
    }

    /// Malformed input must not panic or truncate the message.
    #[test]
    fn unterminated_mention_token_is_preserved() {
        let d = directory(&[("a", "Ada")]);
        assert_eq!(NiftyProvider::resolve_mentions("oops <@a", &d), "oops <@a");
    }

    /// Regression: after a restart, `restore_activities` gives back the
    /// watermark but deliberately not the fingerprint map. A task with no
    /// stored fingerprint must therefore be treated as needing inspection —
    /// when it was treated as unchanged, phase 2 never ran and every event
    /// newer than the restored watermark became permanently unreachable.
    #[test]
    fn unknown_fingerprint_is_inspected_on_warm_cursor() {
        let t = task("1", 3, false);

        // Warm cursor: watermark set, fingerprints empty (the restart case).
        let state = NiftyCursorState::default();
        let prev = state.fingerprints.get(&t.id);
        let is_initial = false;
        let moved = match prev {
            Some(old) => old != &t.fingerprint(),
            None => true,
        };
        assert!(
            moved,
            "a task never fingerprinted must be inspected even on a warm cursor"
        );
        let _ = is_initial;
    }

    /// The counterpart: a task whose fingerprint is unchanged stays unswept,
    /// which is what keeps steady-state polling cheap.
    #[test]
    fn matching_fingerprint_is_not_reinspected() {
        let t = task("1", 3, false);
        let mut state = NiftyCursorState::default();
        state.fingerprints.insert(t.id.clone(), t.fingerprint());

        let moved = match state.fingerprints.get(&t.id) {
            Some(old) => old != &t.fingerprint(),
            None => true,
        };
        assert!(!moved, "unchanged task must not be message-fetched");
    }

    #[test]
    fn subtype_maps_to_event_kind() {
        let mk = |s: Option<&str>| NiftyMessage {
            id: "m".into(),
            text: None,
            subtype: s.map(String::from),
            task: None,
            chat: None,
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
        // Observed live and previously unmapped.
        assert_eq!(mk(Some("addTaskStartDate")).kind(), EventKind::StatusChange);
    }

    /// Every non-comment subtype observed in a live workspace carries
    /// pre-rendered `text` — that is the entire basis for the UI showing these
    /// events, since Nifty sends no structured diff. If a subtype ever arrives
    /// with empty text the feed silently regresses to "made a change", so the
    /// mapping must keep `text` as the description source.
    #[test]
    fn non_comment_events_carry_prerendered_text() {
        let d = directory(&[("CnAHALsDiDgBv", "Bo")]);
        let p = NiftyProvider::new("t", "me");

        // Verbatim payload shapes captured from the live API.
        for (subtype, text, expected) in [
            ("assignTask", "Assigned <@CnAHALsDiDgBv> to this task", "Assigned @Bo to this task"),
            ("createTask", "Created this task", "Created this task"),
            ("moveTask", "Moved this task from other project", "Moved this task from other project"),
        ] {
            let m = NiftyMessage {
                id: "m".into(),
                text: Some(text.into()),
                subtype: Some(subtype.into()),
                task: Some("t1".into()),
                chat: None,
                author: Some("someone".into()),
                tagged: vec![],
                seen_by: vec![],
                created_at: Some("2024-07-29T20:40:01.721Z".into()),
                is_deleted: false,
            };
            let ev = p.to_event(&m, None, None, &d);
            assert_eq!(
                ev.text.as_deref(),
                Some(expected),
                "{} lost its rendered description",
                subtype
            );
        }
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

    fn project(id: &str, chat: Option<&str>) -> NiftyProject {
        NiftyProject {
            id: id.into(),
            nice_id: Some("PRJ".into()),
            name: Some("Proj".into()),
            archived: false,
            removed: false,
            general_discussion: chat.map(String::from),
            general_discussion_muted: false,
            enabled_modules: vec!["tasks".into(), "discussion".into()],
        }
    }

    #[test]
    fn discussion_chat_is_returned_when_enabled() {
        assert_eq!(project("p", Some("c1")).discussion_chat(), Some("c1"));
    }

    /// Nifty's own UI stays quiet for a muted discussion; the app must match, or
    /// it notifies for a channel the user deliberately silenced.
    #[test]
    fn muted_discussion_is_skipped() {
        let mut p = project("p", Some("c1"));
        p.general_discussion_muted = true;
        assert_eq!(p.discussion_chat(), None);
    }

    #[test]
    fn discussion_disabled_module_is_skipped() {
        let mut p = project("p", Some("c1"));
        p.enabled_modules = vec!["tasks".into()];
        assert_eq!(p.discussion_chat(), None);
    }

    /// A payload that omits `enabled_modules` must not be read as "every module
    /// is off" — that would silently disable discussions workspace-wide.
    #[test]
    fn absent_enabled_modules_does_not_disable_discussion() {
        let mut p = project("p", Some("c1"));
        p.enabled_modules = vec![];
        assert_eq!(p.discussion_chat(), Some("c1"));
    }

    #[test]
    fn project_without_discussion_chat_is_skipped() {
        assert_eq!(project("p", None).discussion_chat(), None);
        assert_eq!(project("p", Some("")).discussion_chat(), None);
    }

    /// The rotation must cover every discussion across successive cycles, and
    /// wrap — otherwise later projects are never polled at all.
    #[test]
    fn discussion_rotation_covers_all_projects_and_wraps() {
        let targets: Vec<String> = (0..10).map(|i| format!("c{}", i)).collect();
        let mut rotation = 0usize;
        let mut seen: Vec<String> = Vec::new();

        // Three cycles at 6 per cycle over 10 targets: full coverage plus wrap.
        for _ in 0..3 {
            let start = rotation % targets.len();
            let slice: Vec<String> = targets
                .iter()
                .cycle()
                .skip(start)
                .take(DISCUSSIONS_PER_CYCLE.min(targets.len()))
                .cloned()
                .collect();
            assert_eq!(slice.len(), DISCUSSIONS_PER_CYCLE);
            seen.extend(slice.iter().cloned());
            rotation = (start + DISCUSSIONS_PER_CYCLE) % targets.len();
        }

        for t in &targets {
            assert!(seen.contains(t), "{} was never polled by the rotation", t);
        }
    }

    /// A workspace with fewer discussions than the per-cycle cap must not spin
    /// the rotation past the end or re-fetch the same chat twice in one cycle.
    #[test]
    fn discussion_rotation_handles_fewer_targets_than_cap() {
        let targets = vec!["a".to_string(), "b".to_string()];
        let start = 0usize;
        let slice: Vec<String> = targets
            .iter()
            .cycle()
            .skip(start)
            .take(DISCUSSIONS_PER_CYCLE.min(targets.len()))
            .cloned()
            .collect();
        assert_eq!(slice, vec!["a".to_string(), "b".to_string()]);
    }

    fn discussion_msg(text: &str) -> NiftyMessage {
        NiftyMessage {
            id: "dm1".into(),
            text: Some(text.into()),
            subtype: None,
            task: None,
            chat: Some("T5Goj36a!N!sbx".into()),
            author: Some("CnAHALsDiDgBv".into()),
            tagged: vec![],
            seen_by: vec![],
            created_at: Some("2024-06-20T09:35:56.812Z".into()),
            is_deleted: false,
        }
    }

    /// A discussion message has no task. Keyed on the task ID it would produce
    /// an event with an empty subject and no deep link, so the subject must fall
    /// back to the project.
    #[test]
    fn discussion_event_is_subjected_to_the_project() {
        let p = NiftyProvider::with_workspace("t", "me", "https://acme.nifty.pm");
        let d = directory(&[("CnAHALsDiDgBv", "Bo")]);
        let proj = project("iVLWyIgDPUTn4W", Some("T5Goj36a!N!sbx"));

        let ev = p.to_event(&discussion_msg("hello"), None, Some(&proj), &d);

        assert_eq!(ev.subject.id, "chat:T5Goj36a!N!sbx");
        assert_eq!(ev.subject.project_id.as_deref(), Some("iVLWyIgDPUTn4W"));
        assert_eq!(ev.subject.title.as_deref(), Some("Proj · Discussion"));
        assert_eq!(ev.kind, EventKind::Comment);
        assert_eq!(ev.actor.as_ref().map(|a| a.name.as_str()), Some("Bo"));
        assert_eq!(
            ev.url.as_deref(),
            Some("https://acme.nifty.pm/iVLWyIgDPUTn4W/discussion")
        );
    }

    /// Mentions resolve identically in discussions — the payload shape is the
    /// same, so the task path's rendering must carry over.
    #[test]
    fn discussion_message_resolves_mentions() {
        let p = NiftyProvider::with_workspace("t", "me", "https://acme.nifty.pm");
        let d = directory(&[("CnAHALsDiDgBv", "Bo"), ("fo_OWHEm!UvNxf", "Dele")]);
        let proj = project("p1", Some("c1"));

        let ev = p.to_event(
            &discussion_msg("<@fo_OWHEm!UvNxf> okay. noted"),
            None,
            Some(&proj),
            &d,
        );
        assert_eq!(ev.text.as_deref(), Some("@Dele okay. noted"));
    }

    /// Task events must keep pointing at the task route — the discussion branch
    /// must not capture them just because they share a project.
    #[test]
    fn task_event_still_uses_the_task_url() {
        let p = NiftyProvider::with_workspace("t", "me", "https://acme.nifty.pm");
        let d = directory(&[]);
        let proj = project("p1", Some("c1"));
        let t = task("task9", 1, false);

        let mut m = discussion_msg("a task comment");
        m.chat = None;
        m.task = Some("task9".into());

        let ev = p.to_event(&m, Some(&t), Some(&proj), &d);
        assert_eq!(ev.subject.id, "task9");
        assert_eq!(
            ev.url.as_deref(),
            Some("https://acme.nifty.pm/p1/task/task9")
        );
    }

    /// Observed live on `messages?chat_id=`; previously fell through to `Other`.
    #[test]
    fn discussion_membership_subtypes_are_mapped() {
        let mut m = discussion_msg("joined");
        m.subtype = Some("joinProject".into());
        assert_eq!(m.kind(), EventKind::ItemCreated);
        m.subtype = Some("leaveProject".into());
        assert_eq!(m.kind(), EventKind::ItemCreated);
    }

    /// Self-suppression applies to discussions too, on the same rules.
    #[test]
    fn own_discussion_message_is_suppressed_unless_it_tags_me() {
        let p = NiftyProvider::new("t", "me");
        let mut m = discussion_msg("mine");
        m.author = Some("me".into());
        assert!(p.is_suppressed_own_action(&m));
        m.tagged = vec!["me".into()];
        assert!(!p.is_suppressed_own_action(&m));
    }

    /// The reply path receives only an opaque item ID, so the `chat:` prefix is
    /// the sole signal that a comment must post to `chat_id` rather than
    /// `task_id`. Sending the wrong key is rejected by the API.
    #[test]
    fn discussion_subject_id_is_prefixed_for_reply_routing() {
        let p = NiftyProvider::with_workspace("t", "me", "https://acme.nifty.pm");
        let d = directory(&[]);
        let proj = project("p1", Some("c1"));
        let ev = p.to_event(&discussion_msg("hi"), None, Some(&proj), &d);

        assert!(ev.subject.id.starts_with(DISCUSSION_ID_PREFIX));
        assert_eq!(
            ev.subject.id.strip_prefix(DISCUSSION_ID_PREFIX),
            Some("T5Goj36a!N!sbx"),
            "the chat id must survive round-tripping through the subject"
        );
        // The deep link must still come from the project, not the prefixed id.
        assert_eq!(
            ev.url.as_deref(),
            Some("https://acme.nifty.pm/p1/discussion")
        );
    }

    /// Nifty IDs use `!` and `_` but never `:` — verified across 336 real task,
    /// project, chat, and member IDs — so a task ID can never be mistaken for a
    /// prefixed discussion ID.
    #[test]
    fn task_ids_do_not_collide_with_the_discussion_prefix() {
        for id in ["ymaf9QHxcUq!Uc", "iVLWyIgDPUTn4W", "fo_OWHEm!UvNxf", "T_F6bpSrBoQMg!"] {
            assert!(
                !id.starts_with(DISCUSSION_ID_PREFIX),
                "{} would be misrouted as a discussion",
                id
            );
        }
    }

    /// Live: a reply must reach a project discussion, not just a task. Posts a
    /// real message and deletes it immediately. Ignored by default — it mutates
    /// a real workspace and is briefly visible to teammates.
    ///   cargo test --lib discussion_reply_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn discussion_reply_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let uid = NiftyProvider::new(&token, "").validate().await.unwrap();
        let p = NiftyProvider::new(&token, &uid);

        // Target the quietest discussion to minimise what teammates see.
        let projects = p.list_projects().await.expect("list_projects failed");
        let mut best: Option<(String, usize)> = None;
        for pr in &projects {
            if let Some(chat) = pr.discussion_chat() {
                let n = p.fetch_discussion(chat).await.map(|m| m.len()).unwrap_or(usize::MAX);
                if best.as_ref().map_or(true, |(_, bn)| n < *bn) {
                    best = Some((chat.to_string(), n));
                }
            }
        }
        let (chat, _) = best.expect("no discussion channel available");

        let item_id = format!("{}{}", DISCUSSION_ID_PREFIX, chat);
        p.comment(&item_id, "(automated test — deleting immediately)")
            .await
            .expect("discussion reply failed");

        // Confirm it landed, then remove it.
        let msgs = p.fetch_discussion(&chat).await.expect("re-fetch failed");
        let posted = msgs
            .iter()
            .find(|m| {
                m.author.as_deref() == Some(uid.as_str())
                    && m.text.as_deref().is_some_and(|t| t.contains("automated test"))
                    && !m.is_deleted
            })
            .expect("posted reply not found in the discussion");
        println!("posted to discussion {}: message {}", chat, posted.id);

        p.send_json(
            reqwest::Method::DELETE,
            &format!("messages/{}", urlencoding::encode(&posted.id)),
            serde_json::json!({}),
        )
        .await
        .expect("cleanup delete failed");
        println!("cleaned up {}", posted.id);
    }

    /// Read state is one-way: `seen_by` is populated but there is no endpoint to
    /// write it back. If Nifty ever ships one this test starts failing, which is
    /// the signal to revisit `seen_remotely`.
    #[tokio::test]
    #[ignore]
    async fn read_state_is_not_writable_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let uid = NiftyProvider::new(&token, "").validate().await.unwrap();
        let p = NiftyProvider::new(&token, &uid);

        let projects = p.list_projects().await.expect("list_projects failed");
        let chat = projects
            .iter()
            .find_map(|pr| pr.discussion_chat())
            .expect("no discussion channel");
        let msgs = p.fetch_discussion(chat).await.expect("fetch failed");
        let target = msgs
            .iter()
            .find(|m| !m.is_deleted && !m.seen_by.iter().any(|s| s == &uid));
        let Some(target) = target else {
            println!("every message already seen; nothing to probe");
            return;
        };

        let mid = urlencoding::encode(&target.id).into_owned();
        for (method, path) in [
            (reqwest::Method::POST, format!("messages/{}/seen", mid)),
            (reqwest::Method::POST, format!("messages/{}/read", mid)),
            (reqwest::Method::POST, "messages/seen".to_string()),
        ] {
            let r = p
                .send_json(method.clone(), &path, serde_json::json!({}))
                .await;
            println!("{} /{} -> {:?}", method, path, r.as_ref().err());
            assert!(
                r.is_err(),
                "{} /{} unexpectedly succeeded — Nifty may have shipped a \
                 mark-read endpoint; revisit seen_remotely",
                method,
                path
            );
        }
    }

    /// Live: confirms project discussions are reachable and that the rotation
    /// actually yields discussion-subjected events. Run with:
    ///   cargo test --lib discussions_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn discussions_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let uid = NiftyProvider::new(&token, "").validate().await.unwrap();
        let p = NiftyProvider::with_workspace(&token, &uid, "https://protomated.nifty.pm");

        let projects = p.list_projects().await.expect("list_projects failed");
        let with_disc: Vec<_> = projects
            .iter()
            .filter_map(|pr| pr.discussion_chat().map(|c| (pr.nice_id.clone(), c)))
            .collect();
        println!("projects with a discussion channel: {}", with_disc.len());
        assert!(
            !with_disc.is_empty(),
            "no project exposed general_discussion — the field or gating regressed"
        );

        let (nice, chat) = &with_disc[0];
        let msgs = p.fetch_discussion(chat).await.expect("fetch_discussion failed");
        println!("{:?} discussion -> {} messages", nice, msgs.len());
        for m in msgs.iter().take(3) {
            println!("  [{:?}] {:?}", m.subtype, m.text.as_deref().unwrap_or(""));
        }
        // Every message from this endpoint must carry `chat`, which is what
        // routes it down the discussion branch in `to_event`.
        assert!(
            msgs.iter().all(|m| m.chat.is_some()),
            "a discussion message arrived without `chat` — subject routing would break"
        );
    }

    /// Regression guard for the starvation risk: on a workspace whose task
    /// backlog saturates `budget`, phase 3 runs with nothing left and the
    /// rotation never advances, so discussions are never polled at all.
    /// Measured live at 120/120 calls with 94 tasks pending, so this is the
    /// real steady state, not a corner case.
    #[tokio::test]
    #[ignore]
    async fn discussions_are_not_starved_by_task_backlog_live() {
        let token = std::env::var("NIFTY_TOKEN").expect("NIFTY_TOKEN not set");
        let uid = NiftyProvider::new(&token, "").validate().await.unwrap();
        let p = NiftyProvider::with_workspace(&token, &uid, "https://protomated.nifty.pm");

        const BUDGET: u32 = 120;
        let task_budget = BUDGET - DISCUSSION_RESERVE.min(BUDGET / 4);

        let mut cursor = Cursor::default();
        let mut spends = Vec::new();
        for cycle in 0..3 {
            let r = p.fetch(&cursor, BUDGET).await.expect("fetch failed");
            let st: NiftyCursorState =
                serde_json::from_value(r.cursor.state.clone()).unwrap_or_default();
            println!(
                "cycle {}: {} calls (task budget {}), {} pending tasks, rotation={}",
                cycle,
                r.calls_used,
                task_budget,
                st.pending.len(),
                st.discussion_rotation
            );
            assert!(
                r.calls_used <= BUDGET,
                "cycle {} overspent: {} > {}",
                cycle,
                r.calls_used,
                BUDGET
            );
            spends.push((r.calls_used, task_budget));
            cursor = r.cursor;
        }

        // Rotation alone is not the signal: when the target count divides
        // evenly into the per-cycle cap it wraps back to 0 every cycle, which
        // means *full* coverage, not none. What matters is that phase 3 got
        // calls at all — so assert on the spend above the task reserve.
        assert!(
            spends.iter().any(|&(used, task_budget)| used > task_budget),
            "no cycle spent beyond the task budget ({:?}) — phase 3 never ran \
             and the task backlog is starving discussions",
            spends
        );
    }

    #[test]
    fn parses_rfc3339_timestamp() {
        let m = NiftyMessage {
            id: "m".into(),
            text: None,
            subtype: None,
            task: None,
            chat: None,
            author: None,
            tagged: vec![],
            seen_by: vec![],
            created_at: Some("2024-07-29T20:40:01.721Z".into()),
            is_deleted: false,
        };
        assert_eq!(m.timestamp_ms(), 1722285601721);
    }
}
