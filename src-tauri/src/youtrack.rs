use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

use crate::activities::{ActivityItem, ACTIVITY_FIELDS, POLL_CATEGORIES};

// --- Project listing ---

/// A project from the YouTrack API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub short_name: String,
}

// --- Types for Quick Actions (Epic 3) ---

/// A state/value from a project's custom field bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateBundleElement {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_resolved: bool,
}

/// A team member from a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar_url: String,
}

/// Wrapper for the project team response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTeamResponse {
    #[serde(default)]
    pub users: Vec<TeamMember>,
}

/// Result of executing a command or posting a comment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub full_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub avatar_url: String,
}

pub struct YouTrackClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

impl YouTrackClient {
    pub fn new(base_url: &str, token: &str) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        Self {
            base_url,
            token: token.to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn get_current_user(&self) -> Result<UserInfo, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/api/users/me?fields=id,login,fullName,email,avatarUrl",
            self.base_url
        );

        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("YouTrack API error ({}): {}", status, body).into());
        }

        let mut user: UserInfo = resp.json().await?;

        // YouTrack returns avatarUrl as a relative path — resolve to absolute
        if !user.avatar_url.is_empty() && !user.avatar_url.starts_with("http") {
            user.avatar_url = format!(
                "{}{}",
                self.base_url,
                user.avatar_url
            );
        }

        Ok(user)
    }

    /// Fetch all projects accessible to the current user.
    pub async fn get_projects(
        &self,
    ) -> Result<Vec<ProjectInfo>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/api/admin/projects?fields=id,name,shortName&$top=-1",
            self.base_url
        );

        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to fetch projects ({}): {}", status, body).into());
        }

        let projects: Vec<ProjectInfo> = resp.json().await?;
        Ok(projects)
    }

    /// Fetch activities since `start_timestamp` (unix ms).
    /// Returns activities newest-first.
    pub async fn get_activities(
        &self,
        start_timestamp: i64,
        top: u32,
    ) -> Result<Vec<ActivityItem>, Box<dyn std::error::Error + Send + Sync>> {
        let mut url = format!(
            "{}/api/activities?fields={}&reverse=true&$top={}",
            self.base_url, ACTIVITY_FIELDS, top
        );

        // Add each category as a separate query param
        for cat in POLL_CATEGORIES {
            url.push_str(&format!("&categories={}", cat));
        }

        // Watermark: only fetch activities after this timestamp
        if start_timestamp > 0 {
            url.push_str(&format!("&start={}", start_timestamp));
        }

        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        let status = resp.status();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            return Err(format!(
                "RATE_LIMITED:{}",
                retry_after.unwrap_or(60)
            )
            .into());
        }

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("YouTrack API error ({}): {}", status, body).into());
        }

        let mut activities: Vec<ActivityItem> = resp.json().await?;

        // Resolve relative avatar URLs to absolute
        for activity in &mut activities {
            if let Some(ref mut author) = activity.author {
                if !author.avatar_url.is_empty() && !author.avatar_url.starts_with("http") {
                    author.avatar_url =
                        format!("{}{}", self.base_url, author.avatar_url);
                }
            }
        }

        Ok(activities)
    }

    /// Execute a command on an issue via `POST /api/commands`.
    /// `command` is a natural-language command string like `"State In Progress"` or `"for john.doe"`.
    pub async fn post_command(
        &self,
        issue_id: &str,
        command: &str,
    ) -> Result<CommandResult, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("{}/api/commands", self.base_url);

        let body = serde_json::json!({
            "issues": [{ "idReadable": issue_id }],
            "query": command,
            "silent": false
        });

        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Command failed ({}): {}", status, body).into());
        }

        Ok(CommandResult {
            success: true,
            message: "Command executed successfully".to_string(),
        })
    }

    /// Post a comment on an issue via `POST /api/issues/{id}/comments`.
    pub async fn post_comment(
        &self,
        issue_id: &str,
        text: &str,
    ) -> Result<CommandResult, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/api/issues/{}/comments?fields=id,text",
            self.base_url, issue_id
        );

        let body = serde_json::json!({
            "text": text
        });

        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Comment failed ({}): {}", status, body).into());
        }

        Ok(CommandResult {
            success: true,
            message: "Comment posted successfully".to_string(),
        })
    }

    /// Fetch custom fields for a project, extracting state-type field values.
    /// Returns the state bundle elements (e.g. "Open", "In Progress", "Fixed").
    pub async fn get_project_states(
        &self,
        project_id: &str,
    ) -> Result<Vec<StateBundleElement>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/api/admin/projects/{}/customFields?fields=id,field(name,fieldType(id)),bundle(values(id,name,isResolved)),$type",
            self.base_url, project_id
        );

        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to fetch project fields ({}): {}", status, body).into());
        }

        let fields: Vec<serde_json::Value> = resp.json().await?;

        // Find state-type fields and extract their bundle values
        let mut states: Vec<StateBundleElement> = Vec::new();

        for field in &fields {
            let field_type = field
                .get("$type")
                .and_then(|t| t.as_str())
                .unwrap_or("");

            // State fields are typically StateProjectCustomField or StateIssueCustomField
            let is_state = field_type.contains("State");

            if !is_state {
                // Also check field name for "State" as a fallback
                let name = field
                    .pointer("/field/name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                if name != "State" {
                    continue;
                }
            }

            if let Some(values) = field.pointer("/bundle/values").and_then(|v| v.as_array()) {
                for val in values {
                    let elem = StateBundleElement {
                        id: val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        name: val.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        is_resolved: val.get("isResolved").and_then(|v| v.as_bool()).unwrap_or(false),
                    };
                    if !elem.name.is_empty() {
                        states.push(elem);
                    }
                }
            }
        }

        Ok(states)
    }

    /// Fetch team members for a project.
    pub async fn get_project_team(
        &self,
        project_id: &str,
    ) -> Result<Vec<TeamMember>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/api/admin/projects/{}/team?fields=users(id,login,name,avatarUrl)",
            self.base_url, project_id
        );

        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to fetch project team ({}): {}", status, body).into());
        }

        let team: ProjectTeamResponse = resp.json().await?;

        // Resolve relative avatar URLs
        let members: Vec<TeamMember> = team
            .users
            .into_iter()
            .map(|mut m| {
                if !m.avatar_url.is_empty() && !m.avatar_url.starts_with("http") {
                    m.avatar_url = format!("{}{}", self.base_url, m.avatar_url);
                }
                m
            })
            .collect();

        Ok(members)
    }
}
