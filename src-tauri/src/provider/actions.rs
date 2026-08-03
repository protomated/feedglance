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

/// A person referenced by an `@[Name](id)` token in composed comment text.
pub struct Mention<'a> {
    /// Provider-native user ID, from `AssigneeOption::id`.
    pub id: &'a str,
    /// Display name as it was shown in the compose box. Neither provider needs
    /// it today (both address users by ID), but a provider that mentions by
    /// name would, and the token already carries it.
    #[allow(dead_code)]
    pub name: &'a str,
}

/// Rewrite the UI's provider-neutral mention tokens into a provider's own syntax.
///
/// The compose box can't emit provider-native mention markup: it is shared, and
/// the providers disagree (Nifty wants `<@id>`, YouTrack wants a plain handle).
/// So it emits `@[Name](id)` — display name and ID in one unambiguous token —
/// and each `ActionSource::comment` impl calls this to render it on the way out.
///
/// `render` receives each parsed mention and returns the provider's replacement.
/// Malformed or unterminated tokens are left exactly as typed: a user who writes
/// a literal `@[` should see it survive, and dropping text is worse than a
/// mention that fails to link.
pub fn render_mentions(text: &str, render: impl Fn(Mention<'_>) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(start) = rest.find("@[") {
        // Everything before the token is literal.
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];

        // `@[Name](id)` — name runs to the first `]`, which must be followed
        // immediately by `(`, and the id runs to the next `)`.
        //
        // The name may not span a later `@[`: without that bound, an unclosed
        // token would consume the following valid one's `]` and silently eat all
        // the literal text between them.
        let name_limit = after_open.find("@[").unwrap_or(after_open.len());
        let parsed = after_open[..name_limit].find(']').and_then(|name_end| {
            let tail = &after_open[name_end + 1..];
            let inner = tail.strip_prefix('(')?;
            let id_end = inner.find(')')?;
            Some((&after_open[..name_end], &inner[..id_end], &inner[id_end + 1..]))
        });

        match parsed {
            Some((name, id, tail)) if !id.is_empty() => {
                out.push_str(&render(Mention { id, name }));
                rest = tail;
            }
            // Not a well-formed token: emit the `@[` literally and keep scanning
            // past it, so a later valid token in the same string still resolves.
            _ => {
                out.push_str("@[");
                rest = after_open;
            }
        }
    }

    out.push_str(rest);
    out
}

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
    ///
    /// `text` arrives in the UI's neutral mention format (`@[Name](id)`);
    /// implementations must pass it through [`render_mentions`] to emit whatever
    /// markup the provider links against.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Render in Nifty's shape, the format that actually motivated the token.
    fn nifty(text: &str) -> String {
        render_mentions(text, |m| format!("<@{}>", m.id))
    }

    #[test]
    fn renders_single_mention() {
        assert_eq!(
            nifty("@[Dele Tosh](fo_OWHEm!UvNxf) is this the case?"),
            "<@fo_OWHEm!UvNxf> is this the case?"
        );
    }

    #[test]
    fn renders_multiple_mentions() {
        assert_eq!(
            nifty("@[Ada](a!1) ping @[Bo](b!2) now"),
            "<@a!1> ping <@b!2> now"
        );
    }

    /// The display name is free text; punctuation in it must not end the token.
    #[test]
    fn name_with_spaces_and_punctuation_is_handled() {
        assert_eq!(nifty("cc @[O'Neil, Jr.](x9)"), "cc <@x9>");
    }

    #[test]
    fn text_without_mentions_is_unchanged() {
        assert_eq!(nifty("plain text"), "plain text");
    }

    /// A literal `@[` the user typed must survive rather than be swallowed.
    #[test]
    fn malformed_token_is_left_intact() {
        assert_eq!(nifty("see @[not a mention"), "see @[not a mention");
        assert_eq!(nifty("array@[0] index"), "array@[0] index");
    }

    /// A broken token early in the string must not hide a valid one after it.
    #[test]
    fn valid_mention_after_malformed_one_still_renders() {
        assert_eq!(nifty("@[oops and @[Bo](b!2)"), "@[oops and <@b!2>");
    }

    /// An empty id would render `<@>`, which links nobody — keep it literal.
    #[test]
    fn empty_id_is_not_treated_as_a_mention() {
        assert_eq!(nifty("@[Ghost]()"), "@[Ghost]()");
    }

    /// YouTrack's rendering is the pre-existing `@login` plain text.
    #[test]
    fn youtrack_shape_renders_bare_login() {
        assert_eq!(
            render_mentions("@[Dele Tosh](dele) hi", |m| format!("@{}", m.id)),
            "@dele hi"
        );
    }

    #[test]
    fn name_is_available_to_the_renderer() {
        assert_eq!(
            render_mentions("@[Dele Tosh](d1)", |m| m.name.to_string()),
            "Dele Tosh"
        );
    }

    /// End-to-end: these inputs are the verbatim output of the frontend's
    /// serializeMentions, so the two halves are checked against each other.
    #[test]
    fn round_trips_frontend_serializer_output() {
        assert_eq!(
            nifty("@[Dele Tosh](fo_OWHEm!UvNxf) is this the case?"),
            "<@fo_OWHEm!UvNxf> is this the case?"
        );
        assert_eq!(
            nifty("cc @[Dele Tosh](fo_OWHEm!UvNxf) and @[Dele](xx_short) now"),
            "cc <@fo_OWHEm!UvNxf> and <@xx_short> now"
        );
        assert_eq!(
            nifty("email me at a@b.com please"),
            "email me at a@b.com please"
        );
    }
}
