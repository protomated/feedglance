use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};

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
}
