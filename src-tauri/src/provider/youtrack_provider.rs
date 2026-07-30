//! YouTrack adapter — wraps the existing `YouTrackClient` in `NotificationSource`.
//!
//! YouTrack is the easy case: `GET /api/activities` is a single global feed with
//! a server-side `start` watermark, so one call per cycle covers the whole
//! workspace regardless of size. No fan-out, no client-side diffing.
//!
//! This adapter deliberately adds no behaviour — it only translates the existing
//! client's output into `NormalizedEvent` so the engine can treat both providers
//! identically.

use async_trait::async_trait;

use super::actions::{ActionSource, AssigneeOption, StatusOption};
use super::{
    Cursor, EventActor, EventKind, EventSubject, FetchResult, NormalizedEvent, NotificationSource,
    ProviderError, ProviderKind,
};
use crate::activities::ActivityItem;
use crate::youtrack::YouTrackClient;

const ACTIVITIES_PER_PAGE: u32 = 100;
const INITIAL_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

pub struct YouTrackProvider {
    client: YouTrackClient,
    base_url: String,
    current_user_id: String,
}

impl YouTrackProvider {
    pub fn new(base_url: &str, token: &str, current_user_id: &str) -> Self {
        Self {
            client: YouTrackClient::new(base_url, token),
            base_url: base_url.trim_end_matches('/').to_string(),
            current_user_id: current_user_id.to_string(),
        }
    }

    /// Map a YouTrack activity category onto the shared taxonomy.
    fn kind_of(a: &ActivityItem) -> EventKind {
        let cat = a.category.as_ref().map(|c| c.id.as_str()).unwrap_or("");
        match cat {
            "CommentsCategory" => EventKind::Comment,
            "IssueCreatedCategory" => EventKind::ItemCreated,
            "IssueResolvedCategory" => EventKind::ItemResolved,
            "AttachmentsCategory" => EventKind::Attachment,
            "SprintCategory" => EventKind::Sprint,
            "VcsChangeCategory" => EventKind::VcsChange,
            "CustomFieldCategory" => {
                // Assignee changes are a distinct, higher-signal event than a
                // generic field edit — the feed surfaces them differently.
                match a.field.as_ref().and_then(|f| f.name.as_deref()) {
                    Some("Assignee") => EventKind::Assignment,
                    _ => EventKind::StatusChange,
                }
            }
            _ => EventKind::Other,
        }
    }

    /// Readable issue ID (`PROJ-123`), unwrapping comment/article targets.
    fn issue_id_readable(a: &ActivityItem) -> Option<String> {
        let t = a.target.as_ref()?;
        if let Some(ref id_readable) = t.id_readable {
            let tt = t.target_type.as_deref().unwrap_or("");
            if tt != "IssueComment" && tt != "ArticleComment" && tt != "Article" {
                return Some(id_readable.clone());
            }
        }
        t.issue
            .as_ref()
            .and_then(|i| i.id_readable.clone())
            .or_else(|| t.article.as_ref().and_then(|x| x.id_readable.clone()))
    }

    fn to_event(&self, a: &ActivityItem) -> NormalizedEvent {
        let target = a.target.as_ref();
        let display_id = Self::issue_id_readable(a).unwrap_or_default();

        let project = target.and_then(|t| {
            t.project
                .clone()
                .or_else(|| t.issue.as_ref().and_then(|i| i.project.clone()))
        });

        let title = target.and_then(|t| {
            t.summary
                .clone()
                .or_else(|| t.issue.as_ref().and_then(|i| i.summary.clone()))
        });

        let subject = EventSubject {
            id: target
                .and_then(|t| t.id.clone())
                .unwrap_or_else(|| display_id.clone()),
            display_id: display_id.clone(),
            title,
            project_id: project.as_ref().map(|p| p.id.clone()),
            project_name: project
                .as_ref()
                .and_then(|p| p.name.clone().or_else(|| p.short_name.clone())),
        };

        let url = if display_id.is_empty() {
            None
        } else {
            Some(format!("{}/issue/{}", self.base_url, display_id))
        };

        NormalizedEvent {
            id: format!("youtrack:{}", a.id),
            provider: ProviderKind::YouTrack,
            timestamp: a.timestamp,
            kind: Self::kind_of(a),
            actor: a.author.as_ref().map(|au| EventActor {
                id: au.id.clone(),
                name: if au.name.is_empty() {
                    au.login.clone()
                } else {
                    au.name.clone()
                },
                avatar_url: au.avatar_url.clone(),
            }),
            subject,
            text: target.and_then(|t| t.text.clone()),
            mentions_me: false,
            // YouTrack has no server-side read state — it stays local.
            seen_remotely: None,
            url,
            account_id: String::new(),
            raw: serde_json::to_value(a).unwrap_or(serde_json::Value::Null),
        }
    }
}

#[async_trait]
impl NotificationSource for YouTrackProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::YouTrack
    }

    async fn validate(&self) -> Result<String, ProviderError> {
        self.client
            .get_current_user()
            .await
            .map(|u| u.id)
            .map_err(|e| ProviderError::Auth(e.to_string()))
    }

    /// One call per cycle — `budget` is not a constraint here, but is respected
    /// so a caller can throttle every provider uniformly.
    async fn fetch(&self, cursor: &Cursor, budget: u32) -> Result<FetchResult, ProviderError> {
        if budget == 0 {
            return Ok(FetchResult {
                events: Vec::new(),
                cursor: cursor.clone(),
                calls_used: 0,
            });
        }

        let start = if cursor.watermark > 0 {
            cursor.watermark + 1
        } else {
            chrono::Utc::now().timestamp_millis() - INITIAL_WINDOW_MS
        };

        let activities = self
            .client
            .get_activities(start, ACTIVITIES_PER_PAGE)
            .await
            .map_err(|e| {
                let msg = e.to_string();
                // The existing client signals rate limiting via this prefix.
                if let Some(secs) = msg.strip_prefix("RATE_LIMITED:") {
                    ProviderError::RateLimited(secs.parse().unwrap_or(60))
                } else {
                    ProviderError::Network(msg)
                }
            })?;

        let mut max_ts = cursor.watermark;
        let mut events = Vec::new();

        for a in &activities {
            // Suppress the user's own actions.
            if !self.current_user_id.is_empty() {
                if let Some(ref author) = a.author {
                    if author.id == self.current_user_id {
                        continue;
                    }
                }
            }
            if a.timestamp > max_ts {
                max_ts = a.timestamp;
            }
            events.push(self.to_event(a));
        }

        events.sort_by(|x, y| y.timestamp.cmp(&x.timestamp));

        Ok(FetchResult {
            events,
            cursor: Cursor {
                watermark: max_ts.max(cursor.watermark),
                state: serde_json::Value::Null,
            },
            calls_used: 1,
        })
    }
}

/// YouTrack mutations go through the command API, which takes natural-language
/// command strings rather than typed fields.
#[async_trait]
impl ActionSource for YouTrackProvider {
    async fn comment(&self, item_id: &str, text: &str) -> Result<(), ProviderError> {
        if text.trim().is_empty() {
            return Err(ProviderError::Other("Comment text is empty".into()));
        }
        self.client
            .post_comment(item_id, text)
            .await
            .map(|_| ())
            .map_err(|e| ProviderError::Other(e.to_string()))
    }

    async fn statuses(&self, project_id: &str) -> Result<Vec<StatusOption>, ProviderError> {
        let states = self
            .client
            .get_project_states(project_id)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        Ok(states
            .into_iter()
            .map(|s| StatusOption {
                id: s.name.clone(),
                name: s.name,
                is_resolved: s.is_resolved,
            })
            .collect())
    }

    async fn set_status(&self, item_id: &str, status_id: &str) -> Result<(), ProviderError> {
        // The command API identifies states by name, so `status_id` carries the
        // state name (see `statuses` above). Quote it so multi-word states like
        // "In Progress" are parsed as one value.
        self.client
            .post_command(item_id, &format!("State {}", quote_if_needed(status_id)))
            .await
            .map(|_| ())
            .map_err(|e| ProviderError::Other(e.to_string()))
    }

    async fn assignees(&self, project_id: &str) -> Result<Vec<AssigneeOption>, ProviderError> {
        let team = self
            .client
            .get_project_team(project_id)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        Ok(team
            .into_iter()
            .map(|m| AssigneeOption {
                // Commands address users by login, so that is the applied ID.
                id: m.login.clone(),
                login: m.login,
                name: m.name,
                avatar_url: m.avatar_url,
            })
            .collect())
    }

    async fn assign(&self, item_id: &str, assignee_id: &str) -> Result<(), ProviderError> {
        self.client
            .post_command(item_id, &format!("for {}", quote_if_needed(assignee_id)))
            .await
            .map(|_| ())
            .map_err(|e| ProviderError::Other(e.to_string()))
    }
}

/// Wrap a command value in braces when it contains spaces.
///
/// YouTrack's command parser splits on whitespace, so `State In Progress` would
/// be read as the state `In` followed by junk. `State {In Progress}` is correct.
fn quote_if_needed(value: &str) -> String {
    if value.contains(char::is_whitespace) {
        format!("{{{}}}", value)
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::{ActivityCategory, ActivityField};

    fn activity(cat: &str, field: Option<&str>) -> ActivityItem {
        ActivityItem {
            id: "a1".into(),
            author: None,
            timestamp: 1000,
            category: Some(ActivityCategory { id: cat.into() }),
            target: None,
            target_member: None,
            added: serde_json::Value::Null,
            removed: serde_json::Value::Null,
            field: field.map(|f| ActivityField {
                name: Some(f.into()),
            }),
            activity_type: None,
            account_id: String::new(),
        }
    }

    #[test]
    fn multi_word_state_is_brace_quoted() {
        // "State In Progress" would parse as state "In"; braces keep it one value.
        assert_eq!(quote_if_needed("In Progress"), "{In Progress}");
        assert_eq!(quote_if_needed("Open"), "Open");
    }

    #[test]
    fn maps_comment_category() {
        assert_eq!(
            YouTrackProvider::kind_of(&activity("CommentsCategory", None)),
            EventKind::Comment
        );
    }

    #[test]
    fn assignee_field_is_assignment_not_status() {
        assert_eq!(
            YouTrackProvider::kind_of(&activity("CustomFieldCategory", Some("Assignee"))),
            EventKind::Assignment
        );
        assert_eq!(
            YouTrackProvider::kind_of(&activity("CustomFieldCategory", Some("State"))),
            EventKind::StatusChange
        );
    }

    #[test]
    fn unknown_category_is_other_not_dropped() {
        assert_eq!(
            YouTrackProvider::kind_of(&activity("SomethingNew", None)),
            EventKind::Other
        );
    }
}
