//! Quick actions (Epic 3) across providers.
//!
//! Separate from `NotificationSource` on purpose: reading and writing have
//! different shapes and different failure modes, and a provider could plausibly
//! support one without the other. Keeping them apart also means a read-only
//! provider needs no stub mutation impl.
//!
//! The two providers disagree structurally here too:
//!
//! | | YouTrack | Nifty |
//! |---|---|---|
//! | Mutations | `POST /api/commands`, natural-language strings | `PUT /tasks/{id}`, typed JSON |
//! | Comment | `POST /issues/{id}/comments` | `POST /messages` with `type: "text"` |
//! | Statuses | project custom-field bundle | project task groups (board columns) |
//! | Assignee | login name in a command string | user IDs in an array |
//!
//! So the trait is expressed in intent ("set status to X"), and each provider
//! translates that into its own wire format.

use async_trait::async_trait;

use super::ProviderError;

/// A selectable status/state value.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOption {
    /// Provider-native identifier used when applying the change.
    pub id: String,
    /// Human-readable name shown in the dropdown.
    pub name: String,
    /// Whether this status means "done".
    #[serde(default)]
    pub is_resolved: bool,
}

/// A person who can be assigned.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssigneeOption {
    pub id: String,
    /// Login/handle. Empty when the provider has no separate login concept.
    #[serde(default)]
    pub login: String,
    pub name: String,
    #[serde(default)]
    pub avatar_url: String,
}

/// Mutations a provider can perform on a work item.
///
/// Implementations receive provider-native IDs as supplied by
/// `NormalizedEvent::subject` — `id` for API calls, never `display_id`.
#[async_trait]
pub trait ActionSource: Send + Sync {
    /// Post a comment on an item.
    async fn comment(&self, item_id: &str, text: &str) -> Result<(), ProviderError>;

    /// Statuses available for an item's project, for the status dropdown.
    async fn statuses(&self, project_id: &str) -> Result<Vec<StatusOption>, ProviderError>;

    /// Apply a status to an item. `status_id` comes from `statuses()`.
    async fn set_status(&self, item_id: &str, status_id: &str) -> Result<(), ProviderError>;

    /// People assignable on an item's project, for the assign dropdown.
    async fn assignees(&self, project_id: &str) -> Result<Vec<AssigneeOption>, ProviderError>;

    /// Assign an item to a user. `assignee_id` comes from `assignees()`.
    async fn assign(&self, item_id: &str, assignee_id: &str) -> Result<(), ProviderError>;
}
