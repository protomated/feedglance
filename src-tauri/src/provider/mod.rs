//! Provider abstraction for multi-PM-tool support.
//!
//! The seam sits at the *normalized event*, not the API client. YouTrack and
//! Nifty disagree on nearly every structural assumption:
//!
//! | | YouTrack | Nifty |
//! |---|---|---|
//! | Feed | global `/activities` | per-task `/messages` (no project-wide) |
//! | Delta | `timestamp > watermark` server-side | none — client-side diff |
//! | Read state | local only | local only (`seen_by` is never populated) |
//! | Mutations | command API | REST |
//!
//! A shared "API client" trait would leak those differences into every caller.
//! Instead each provider owns its own fetch strategy and emits `NormalizedEvent`,
//! so the feed, tray, and filter code never learn which provider is running.
//!
//! This is also the seam a webhook transport drops into later: a
//! `NiftyWebhookSource` and `NiftyPollingSource` are interchangeable here.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod actions;
pub mod nifty;
pub mod youtrack_provider;

/// Which backend an account talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    YouTrack,
    Nifty,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::YouTrack => "youtrack",
            ProviderKind::Nifty => "nifty",
        }
    }
}

/// Provider-independent event category.
///
/// Deliberately coarser than either provider's native taxonomy — it carries only
/// what the feed actually renders and filters on. Provider-specific detail stays
/// in `NormalizedEvent::raw`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    Comment,
    StatusChange,
    Assignment,
    ItemCreated,
    ItemResolved,
    Attachment,
    Sprint,
    VcsChange,
    /// Recognized but uncategorized — still shown, never filtered out silently.
    Other,
}

/// Who produced an event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventActor {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar_url: String,
}

/// The work item an event is about (issue, task, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSubject {
    /// Provider-native ID, used for deep links and mutations.
    pub id: String,
    /// Human-facing ID (`PROJ-123`, `PTART-1`). Falls back to `id`.
    pub display_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}

/// A single feed item, provider-independent.
///
/// `id` must be stable across polls — it is the dedup key. Providers that lack a
/// natural stable ID must synthesize a deterministic one (never a random or
/// time-derived value, which would resurface the same event every cycle).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub id: String,
    pub provider: ProviderKind,
    /// Unix ms, UTC.
    pub timestamp: i64,
    pub kind: EventKind,
    #[serde(default)]
    pub actor: Option<EventActor>,
    pub subject: EventSubject,
    /// Pre-rendered human-readable summary ("moved to In Progress").
    #[serde(default)]
    pub text: Option<String>,
    /// True when the current user is @-mentioned or directly targeted.
    #[serde(default)]
    pub mentions_me: bool,
    /// Server-side read state where the provider has one (Nifty `seen_by`).
    /// `None` means the provider has no such concept and read state is local.
    #[serde(default)]
    pub seen_remotely: Option<bool>,
    /// Deep link into the provider's web UI.
    #[serde(default)]
    pub url: Option<String>,
    /// Account this event belongs to (stamped by the polling engine).
    #[serde(default, skip_deserializing)]
    pub account_id: String,
    /// Provider-native payload, retained for provider-specific UI.
    #[serde(default)]
    pub raw: serde_json::Value,
}

/// Where a provider's incremental fetch resumes from.
///
/// YouTrack uses a server-side timestamp watermark; Nifty has no delta API and
/// must carry a client-side fingerprint of prior state. Modelling both as one
/// opaque cursor keeps the polling loop provider-agnostic.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cursor {
    /// Unix ms high-water mark. 0 = initial load.
    #[serde(default)]
    pub watermark: i64,
    /// Provider-defined opaque state (Nifty stores per-task counter fingerprints).
    #[serde(default)]
    pub state: serde_json::Value,
}

/// Result of one poll cycle.
pub struct FetchResult {
    pub events: Vec<NormalizedEvent>,
    /// Cursor to persist for the next cycle.
    pub cursor: Cursor,
    /// API calls consumed — surfaced so the loop can respect shared rate budgets.
    pub calls_used: u32,
}

#[derive(Debug)]
pub enum ProviderError {
    /// Rate limited; wait this many seconds (from `Retry-After` when present).
    RateLimited(u64),
    Auth(String),
    Network(String),
    Other(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Preserved wire format — polling.rs parses this prefix for backoff.
            ProviderError::RateLimited(s) => write!(f, "RATE_LIMITED:{}", s),
            ProviderError::Auth(m) => write!(f, "AUTH: {}", m),
            ProviderError::Network(m) => write!(f, "NETWORK: {}", m),
            ProviderError::Other(m) => write!(f, "{}", m),
        }
    }
}

impl std::error::Error for ProviderError {}

/// A source of notification events.
///
/// Implementations own their fetch strategy entirely — polling cadence, fan-out,
/// and delta detection are all internal. The engine only supplies a cursor and
/// receives normalized events.
#[async_trait]
pub trait NotificationSource: Send + Sync {
    fn kind(&self) -> ProviderKind;

    /// Validate credentials and return the current user's ID.
    async fn validate(&self) -> Result<String, ProviderError>;

    /// Fetch events since `cursor`.
    ///
    /// `budget` caps API calls for this cycle; implementations must stay within
    /// it and may return partial results, resuming next cycle via the cursor.
    /// This is what keeps large-workspace fan-out from exhausting a rate limit
    /// that is shared across every user of the same workspace.
    async fn fetch(&self, cursor: &Cursor, budget: u32) -> Result<FetchResult, ProviderError>;

    /// Minimum seconds between polls. Providers with heavier fan-out ask for more.
    fn min_interval_secs(&self) -> u64 {
        30
    }
}
