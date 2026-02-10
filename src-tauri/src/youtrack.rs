use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};

use crate::activities::{ActivityItem, ACTIVITY_FIELDS, POLL_CATEGORIES};

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
}
