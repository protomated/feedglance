use serde::{Deserialize, Serialize};

/// Represents a YouTrack activity item from `GET /api/activities`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub id: String,
    #[serde(default)]
    pub author: Option<ActivityAuthor>,
    /// Unix timestamp in milliseconds (UTC).
    pub timestamp: i64,
    #[serde(default)]
    pub category: Option<ActivityCategory>,
    #[serde(default)]
    pub target: Option<ActivityTarget>,
    #[serde(default)]
    pub target_member: Option<String>,
    /// Values added — could be objects or primitives depending on category.
    #[serde(default)]
    pub added: serde_json::Value,
    /// Values removed.
    #[serde(default)]
    pub removed: serde_json::Value,
    #[serde(default)]
    pub field: Option<ActivityField>,
    #[serde(rename = "$type", default)]
    pub activity_type: Option<String>,
    /// Account ID this activity belongs to (injected by polling engine, not from API).
    #[serde(default, skip_deserializing)]
    pub account_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAuthor {
    pub id: String,
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCategory {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTarget {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub id_readable: Option<String>,
    #[serde(rename = "$type", default)]
    pub target_type: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    /// Permalink to this target, which YouTrack supplies for comments.
    /// Absent on plain issue targets — they are addressed by `id_readable`.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub project: Option<ActivityProject>,
    /// Parent issue when target is a comment, attachment, or VCS change.
    #[serde(default)]
    pub issue: Option<Box<ActivityTargetRef>>,
    /// Parent article when target is an article comment.
    #[serde(default)]
    pub article: Option<Box<ActivityTargetRef>>,
}

/// Lightweight reference to an issue or article embedded inside a target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTargetRef {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub id_readable: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub project: Option<ActivityProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityProject {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub short_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityField {
    #[serde(default)]
    pub name: Option<String>,
}

/// Categories we poll for (per spec).
pub const POLL_CATEGORIES: &[&str] = &[
    "CommentsCategory",
    "CustomFieldCategory",
    "AttachmentsCategory",
    "IssueCreatedCategory",
    "IssueResolvedCategory",
    "SprintCategory",
    "VcsChangeCategory",
];

/// Fields requested from the activities endpoint.
///
/// `added` and `removed` need an explicit sub-projection — without it, YouTrack
/// returns minimal payloads (often just `$type`/`id`), stripping `name`/`login`
/// and breaking our description rendering for state/priority/assignee changes.
pub const ACTIVITY_FIELDS: &str = concat!(
    "id,",
    "author(id,login,name,avatarUrl),",
    "timestamp,",
    "category(id),",
    // `url` is the comment permalink, present on IssueComment/ArticleComment
    // targets. Requesting it lets deep links land on the comment itself rather
    // than the top of a long issue.
    "target(id,idReadable,$type,text,summary,url,",
    "project(id,name,shortName),",
    "issue(id,idReadable,summary,project(id,name,shortName)),",
    "article(id,idReadable,summary,project(id,name,shortName))),",
    "targetMember,",
    "added(id,name,localizedName,login,fullName,text,presentation,minutes,$type),",
    "removed(id,name,localizedName,login,fullName,text,presentation,minutes,$type),",
    "field(name),",
    "$type"
);
