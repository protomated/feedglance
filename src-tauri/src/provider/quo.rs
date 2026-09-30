//! Quo (formerly OpenPhone) provider — incoming SMS as feed events.
//!
//! Quo's public API (v1, `https://api.quo.com/v1`) has no inbox-wide message
//! feed. Messages are only listable per conversation, and a conversation is
//! addressed by the line (`phoneNumberId`) plus its participants. So a cycle is:
//!
//! 1. `GET /conversations?userId=&updatedAfter=` — conversations visible to the
//!    account's user that changed since the watermark (one call, paged).
//! 2. For each whose `lastActivityId` moved: `GET /messages?phoneNumberId=
//!    &participants=&createdAfter=` — the new messages in that thread.
//!
//! Only **incoming** messages become events. Outgoing texts (yours or a
//! teammate's) are context, not notifications; they appear in the reply
//! panel's thread view via `details`.
//!
//! ## Unverified: does an incoming text bump `updatedAt`?
//!
//! Step 1 relies on `updatedAfter` catching conversations that received a
//! message. The docs don't say whether a message updates the conversation. As a
//! backstop, every `FULL_SCAN_EVERY` cycles the filter is dropped and the first
//! page of conversations is diffed on `lastActivityId` instead, so a missed
//! message is picked up within a few minutes rather than never. The `#[ignore]`d
//! live test `updated_after_catches_new_messages_live` settles the question.
//!
//! ## Identity
//!
//! API keys are workspace-wide and say nothing about who is using them, so the
//! account stores the user's Quo email (in the account's `url` slot) and
//! `validate` resolves it to a `US…` user ID. That ID scopes which
//! conversations are visible and is who in-app replies are sent as.
//!
//! ## Cost
//!
//! Reading is free. Sending (`POST /messages`) costs $0.01 per segment from
//! prepaid credits, so the UI defaults to opening the conversation in Quo and
//! only sends through `ActionSource::comment` when the user has opted in.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use super::actions::{ActionSource, AssigneeOption, ItemDetails, StatusOption, ThreadMessage};
use super::{
    Cursor, EventActor, EventKind, EventSubject, FetchResult, NormalizedEvent, NotificationSource,
    ProviderError, ProviderKind,
};

const API_BASE: &str = "https://api.quo.com/v1";

/// Web app host for deep links. Quo's own webhook payloads link conversations
/// as `https://my.quo.com/inbox/{PN}/c/{CN}`, with `?at={AC}` to jump to a
/// message.
const WEB_BASE: &str = "https://my.quo.com";

/// `maxResults` ceiling for conversations and messages.
const PAGE_SIZE: u32 = 100;
/// `maxResults` ceiling for users and contacts.
const SMALL_PAGE_SIZE: u32 = 50;

/// First load looks back 24h, matching the other providers.
const INITIAL_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Re-query this far behind the watermark, so a message written just as the
/// previous cycle ran is not skipped. Duplicates are dropped by event ID.
const OVERLAP_MS: i64 = 2 * 60 * 1000;

/// Cycles between unfiltered conversation scans (see module docs).
const FULL_SCAN_EVERY: u32 = 5;

/// Refresh the contact directory at most this often.
const CONTACTS_TTL_MS: i64 = 60 * 60 * 1000;
/// Contact pages fetched per refresh; 20 × 50 = 1000 contacts.
const MAX_CONTACT_PAGES: u32 = 20;

/// Messages shown in the reply panel's thread.
const THREAD_LENGTH: u32 = 10;

/// Quo allows 10 requests/second per key. Calls here are sequential; this gap
/// keeps a burst (cold start, contact refresh) safely under that.
const MIN_CALL_GAP: Duration = Duration::from_millis(120);

/// Separator in a subject ID. Sending needs the line and the recipients, and
/// the action path receives only the subject ID, so all three travel in it:
/// `{CN}|{PN}|{+1555…,+1666…}`. Quo IDs are alphanumeric and E.164 numbers are
/// `+` and digits, so `|` and `,` cannot collide.
const ID_SEP: char = '|';

// --- Wire types ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    data: Vec<T>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoUser {
    id: String,
    // Required by the spec, but optional here: one odd user (a pending invite)
    // must not make the whole list undecodable and block sign-in.
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
}

impl QuoUser {
    fn display_name(&self) -> String {
        let name = [self.first_name.as_deref(), self.last_name.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if name.is_empty() {
            self.email.clone().unwrap_or_default()
        } else {
            name
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoPhoneNumber {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    formatted_number: Option<String>,
    #[serde(default)]
    number: String,
}

impl QuoPhoneNumber {
    /// "Sales (555) 123-4567", or just the number when the line is unnamed.
    fn label(&self) -> String {
        let number = self
            .formatted_number
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.number.clone());
        if self.name.is_empty() {
            number
        } else {
            format!("{} {}", self.name, number)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoConversation {
    id: String,
    phone_number_id: String,
    #[serde(default)]
    participants: Vec<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    last_activity_id: Option<String>,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuoMedia {
    url: String,
    #[serde(default, rename = "type")]
    media_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoMessage {
    id: String,
    #[serde(default)]
    from: String,
    #[serde(default)]
    text: String,
    direction: String,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    status: String,
    created_at: String,
    #[serde(default)]
    media: Vec<QuoMedia>,
}

impl QuoMessage {
    fn timestamp_ms(&self) -> i64 {
        parse_ms(&self.created_at).unwrap_or(0)
    }

    fn is_incoming(&self) -> bool {
        self.direction == "incoming"
    }

    /// Body as shown in the feed. Picture-only texts are common, and an empty
    /// row would read as a glitch.
    fn body(&self) -> String {
        let text = self.text.trim();
        match (text.is_empty(), self.media.len()) {
            (_, 0) => text.to_string(),
            (true, n) => attachment_label(n),
            (false, n) => format!("{} [{}]", text, attachment_label(n)),
        }
    }
}

fn attachment_label(n: usize) -> String {
    if n == 1 {
        "1 attachment".into()
    } else {
        format!("{} attachments", n)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoContact {
    #[serde(default)]
    default_fields: QuoContactFields,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoContactFields {
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    company: Option<String>,
    #[serde(default)]
    phone_numbers: Vec<QuoContactValue>,
}

#[derive(Debug, Deserialize)]
struct QuoContactValue {
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SendResponse {
    data: SendData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendData {
    #[serde(default)]
    status: String,
}

/// Carried between cycles in `Cursor::state`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoCursorState {
    /// Conversation ID → last `lastActivityId` processed.
    #[serde(default)]
    last_activity: HashMap<String, String>,
    /// Normalized phone number → contact display name.
    #[serde(default)]
    contacts: HashMap<String, String>,
    #[serde(default)]
    contacts_fetched_at: i64,
    /// Phone number ID → line label.
    #[serde(default)]
    lines: HashMap<String, String>,
    #[serde(default)]
    cycle: u32,
}

// --- Helpers ---

fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Reduce a number to its digits so `+1 (555) 123-4567` and `+15551234567`
/// match. Contacts are free text; conversation participants are E.164.
fn phone_key(number: &str) -> String {
    number.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Pack what a reply needs into a subject ID; see `ID_SEP`.
fn encode_subject_id(conversation_id: &str, phone_number_id: &str, participants: &[String]) -> String {
    format!(
        "{}{sep}{}{sep}{}",
        conversation_id,
        phone_number_id,
        participants.join(","),
        sep = ID_SEP
    )
}

/// Inverse of `encode_subject_id`: (conversation, line, participants).
fn decode_subject_id(id: &str) -> Result<(&str, &str, Vec<&str>), ProviderError> {
    let mut parts = id.splitn(3, ID_SEP);
    let (Some(cn), Some(pn), Some(to)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(ProviderError::Other(format!(
            "Not a Quo conversation reference: {}",
            id
        )));
    };
    let to: Vec<&str> = to.split(',').filter(|s| !s.is_empty()).collect();
    if cn.is_empty() || pn.is_empty() || to.is_empty() {
        return Err(ProviderError::Other(format!(
            "Incomplete Quo conversation reference: {}",
            id
        )));
    }
    Ok((cn, pn, to))
}

/// Map a Quo error response to something a user can act on.
///
/// The send-path codes come from Quo's error reference; the rest fall back to
/// the API's own message.
fn describe_error(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    // Quo nests details under `error` (`{"error":{"message":…}}`, verified on
    // a live 401); accept a flat body too.
    let err = parsed.get("error").filter(|e| e.is_object()).unwrap_or(&parsed);
    let field = |k: &str| err.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let code = field("code");
    let message = field("message");
    match (status.as_u16(), code.as_str()) {
        (400, "0206400") => {
            "Quo can't text US numbers from this line yet: its A2P 10DLC carrier registration \
             isn't approved. Reply in the Quo app, or finish registration in Quo."
                .into()
        }
        (403, "0204403") => "This Quo line has reached its daily A2P message cap.".into(),
        (402, _) => "Quo declined the send: the workspace subscription or prepaid credits \
             have run out. Top up in Quo, or reply in the Quo app."
            .into(),
        _ if !message.is_empty() => format!("Quo API {}: {}", status.as_u16(), message),
        _ => format!(
            "Quo API {}: {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ),
    }
}

// --- Provider ---

pub struct QuoProvider {
    client: reqwest::Client,
    token: String,
    /// The account's Quo login email, used to resolve `user_id` when unset.
    email: String,
    /// `US…` ID of the person using the app. Empty until validated.
    user_id: String,
    last_call: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

impl QuoProvider {
    pub fn new(email: &str, token: &str, user_id: &str) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: token.to_string(),
            email: email.trim().to_string(),
            user_id: user_id.to_string(),
            last_call: tokio::sync::Mutex::new(None),
        }
    }

    /// Space calls out to respect the 10 req/s limit.
    async fn pace(&self) {
        let mut last = self.last_call.lock().await;
        if let Some(t) = *last {
            let since = t.elapsed();
            if since < MIN_CALL_GAP {
                tokio::time::sleep(MIN_CALL_GAP - since).await;
            }
        }
        *last = Some(tokio::time::Instant::now());
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, ProviderError> {
        self.pace().await;
        // Quo takes the raw key, with no `Bearer` prefix.
        let resp = req
            .header("Authorization", &self.token)
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
                .unwrap_or(10);
            return Err(ProviderError::RateLimited(retry));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ProviderError::Auth("Quo rejected the API key (401)".into()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Other(describe_error(status, &body)));
        }
        Ok(resp)
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, ProviderError> {
        let resp = self
            .send(self.client.get(format!("{}/{}", API_BASE, path)).query(query))
            .await?;
        resp.json::<T>()
            .await
            .map_err(|e| ProviderError::Other(format!("decode /{}: {}", path, e)))
    }

    async fn list_users(&self) -> Result<(Vec<QuoUser>, u32), ProviderError> {
        let mut users = Vec::new();
        let mut calls = 0;
        let mut token: Option<String> = None;
        loop {
            let mut q = vec![("maxResults", SMALL_PAGE_SIZE.to_string())];
            if let Some(t) = &token {
                q.push(("pageToken", t.clone()));
            }
            let page: Page<QuoUser> = self.get("users", &q).await?;
            calls += 1;
            users.extend(page.data);
            match page.next_page_token {
                Some(t) if !t.is_empty() => token = Some(t),
                _ => break,
            }
        }
        Ok((users, calls))
    }

    /// Resolve the account's email to a Quo user.
    async fn resolve_user(&self) -> Result<QuoUser, ProviderError> {
        if self.email.is_empty() {
            return Err(ProviderError::Other(
                "Enter the email you sign in to Quo with".into(),
            ));
        }
        let (users, _) = self.list_users().await?;
        users
            .into_iter()
            .find(|u| {
                u.email
                    .as_deref()
                    .is_some_and(|e| e.trim().eq_ignore_ascii_case(&self.email))
            })
            .ok_or_else(|| {
                ProviderError::Other(format!(
                    "No Quo user with the email {} in this workspace",
                    self.email
                ))
            })
    }

    async fn user_id(&self) -> Result<String, ProviderError> {
        if !self.user_id.is_empty() {
            return Ok(self.user_id.clone());
        }
        Ok(self.resolve_user().await?.id)
    }

    async fn lines(&self, user_id: &str) -> Result<HashMap<String, String>, ProviderError> {
        let page: Page<QuoPhoneNumber> =
            self.get("phone-numbers", &[("userId", user_id.to_string())]).await?;
        Ok(page.data.into_iter().map(|p| (p.id.clone(), p.label())).collect())
    }

    async fn contacts(&self) -> Result<(HashMap<String, String>, u32), ProviderError> {
        let mut out = HashMap::new();
        let mut calls = 0;
        let mut token: Option<String> = None;
        for _ in 0..MAX_CONTACT_PAGES {
            let mut q = vec![("maxResults", SMALL_PAGE_SIZE.to_string())];
            if let Some(t) = &token {
                q.push(("pageToken", t.clone()));
            }
            let page: Page<QuoContact> = self.get("contacts", &q).await?;
            calls += 1;
            for c in page.data {
                let f = &c.default_fields;
                let name = [f.first_name.as_deref(), f.last_name.as_deref()]
                    .into_iter()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                let name = if name.is_empty() {
                    f.company.clone().unwrap_or_default()
                } else {
                    name
                };
                if name.is_empty() {
                    continue;
                }
                for p in &f.phone_numbers {
                    if let Some(v) = p.value.as_deref() {
                        let key = phone_key(v);
                        if !key.is_empty() {
                            out.entry(key).or_insert_with(|| name.clone());
                        }
                    }
                }
            }
            match page.next_page_token {
                Some(t) if !t.is_empty() => token = Some(t),
                _ => break,
            }
        }
        Ok((out, calls))
    }

    async fn messages(
        &self,
        phone_number_id: &str,
        participants: &[&str],
        created_after: Option<i64>,
        max: u32,
    ) -> Result<Vec<QuoMessage>, ProviderError> {
        let mut q: Vec<(&str, String)> = vec![
            ("phoneNumberId", phone_number_id.to_string()),
            ("maxResults", max.to_string()),
        ];
        // Repeated key, no brackets — per the API docs.
        for p in participants {
            q.push(("participants", p.to_string()));
        }
        if let Some(ms) = created_after {
            q.push(("createdAfter", iso(ms)));
        }
        let page: Page<QuoMessage> = self.get("messages", &q).await?;
        Ok(page.data)
    }

    /// Contact name for a conversation, falling back to its numbers.
    fn conversation_label(conv: &QuoConversation, contacts: &HashMap<String, String>) -> String {
        if let Some(n) = conv.name.as_deref().filter(|n| !n.trim().is_empty()) {
            return n.to_string();
        }
        conv.participants
            .iter()
            .map(|p| contacts.get(&phone_key(p)).cloned().unwrap_or_else(|| p.clone()))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn to_event(
        conv: &QuoConversation,
        msg: &QuoMessage,
        contacts: &HashMap<String, String>,
        line_label: Option<&String>,
    ) -> NormalizedEvent {
        let sender = contacts
            .get(&phone_key(&msg.from))
            .cloned()
            .unwrap_or_else(|| msg.from.clone());

        NormalizedEvent {
            id: format!("quo:{}", msg.id),
            provider: ProviderKind::Quo,
            timestamp: msg.timestamp_ms(),
            kind: EventKind::Message,
            actor: Some(EventActor {
                id: msg.from.clone(),
                name: sender,
                avatar_url: String::new(),
            }),
            subject: EventSubject {
                id: encode_subject_id(&conv.id, &conv.phone_number_id, &conv.participants),
                display_id: Self::conversation_label(conv, contacts),
                title: None,
                project_id: Some(conv.phone_number_id.clone()),
                project_name: line_label.cloned(),
            },
            text: Some(msg.body()),
            mentions_me: false,
            seen_remotely: None,
            url: Some(format!(
                "{}/inbox/{}/c/{}?at={}",
                WEB_BASE, conv.phone_number_id, conv.id, msg.id
            )),
            account_id: String::new(),
            raw: serde_json::json!({
                "direction": msg.direction,
                "from": msg.from,
                "participants": conv.participants,
                "conversationId": conv.id,
                "phoneNumberId": conv.phone_number_id,
                "media": msg.media,
            }),
        }
    }
}

#[async_trait]
impl NotificationSource for QuoProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Quo
    }

    async fn validate(&self) -> Result<String, ProviderError> {
        Ok(self.resolve_user().await?.id)
    }

    async fn fetch(&self, cursor: &Cursor, budget: u32) -> Result<FetchResult, ProviderError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut calls = 0u32;
        let mut state: QuoCursorState =
            serde_json::from_value(cursor.state.clone()).unwrap_or_default();
        state.cycle = state.cycle.wrapping_add(1);

        let user_id = if self.user_id.is_empty() {
            calls += 1;
            self.user_id().await?
        } else {
            self.user_id.clone()
        };

        // Lines and contacts are metadata: refresh them when missing or stale,
        // and never let a failure there block messages.
        if state.lines.is_empty() || now - state.contacts_fetched_at > CONTACTS_TTL_MS {
            if let Ok(lines) = self.lines(&user_id).await {
                state.lines = lines;
            }
            calls += 1;
            match self.contacts().await {
                Ok((contacts, used)) => {
                    state.contacts = contacts;
                    calls += used;
                }
                Err(e @ (ProviderError::Auth(_) | ProviderError::RateLimited(_))) => return Err(e),
                Err(_) => calls += 1,
            }
            state.contacts_fetched_at = now;
        }

        let is_initial = cursor.watermark == 0;
        let since = if is_initial {
            now - INITIAL_WINDOW_MS
        } else {
            cursor.watermark - OVERLAP_MS
        };
        let full_scan = !is_initial && state.cycle % FULL_SCAN_EVERY == 0;

        // Step 1: which conversations changed.
        let mut conversations = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut q = vec![
                ("userId", user_id.clone()),
                ("maxResults", PAGE_SIZE.to_string()),
            ];
            if !full_scan {
                q.push(("updatedAfter", iso(since)));
            }
            if let Some(t) = &page_token {
                q.push(("pageToken", t.clone()));
            }
            let page: Page<QuoConversation> = self.get("conversations", &q).await?;
            calls += 1;
            conversations.extend(page.data);
            // A full scan is a backstop, not a sweep: the first page is the
            // most recently active conversations, which is where a missed
            // message would be.
            if full_scan {
                break;
            }
            match page.next_page_token {
                Some(t) if !t.is_empty() && calls < budget => page_token = Some(t),
                _ => break,
            }
        }

        // Step 2: fetch messages for conversations whose last activity moved.
        let mut events = Vec::new();
        let mut max_ts = cursor.watermark;
        let mut exhausted = false;
        for conv in &conversations {
            if conv.deleted_at.is_some() || conv.participants.is_empty() {
                continue;
            }
            // Only lines the user belongs to; `userId` scoping can include
            // shared inboxes the account can see but doesn't work.
            if !state.lines.is_empty() && !state.lines.contains_key(&conv.phone_number_id) {
                continue;
            }
            let activity = conv.last_activity_id.clone().unwrap_or_default();
            if !activity.is_empty() && state.last_activity.get(&conv.id) == Some(&activity) {
                continue;
            }
            if calls >= budget {
                // Leave the fingerprint unset so the next cycle retries it.
                exhausted = true;
                continue;
            }

            let participants: Vec<&str> = conv.participants.iter().map(String::as_str).collect();
            let msgs = match self
                .messages(&conv.phone_number_id, &participants, Some(since), PAGE_SIZE)
                .await
            {
                Ok(m) => m,
                Err(e @ (ProviderError::Auth(_) | ProviderError::RateLimited(_))) => return Err(e),
                // One bad thread shouldn't sink the cycle; it retries next time.
                Err(_) => {
                    calls += 1;
                    continue;
                }
            };
            calls += 1;

            for m in msgs.iter().filter(|m| m.is_incoming()) {
                let ts = m.timestamp_ms();
                if ts > max_ts {
                    max_ts = ts;
                }
                events.push(Self::to_event(
                    conv,
                    m,
                    &state.contacts,
                    state.lines.get(&conv.phone_number_id),
                ));
            }
            if !activity.is_empty() {
                state.last_activity.insert(conv.id.clone(), activity);
            }
        }

        // With budget left over, everything up to now has been seen. When the
        // budget ran out, hold the watermark so skipped conversations are
        // still inside the `updatedAfter` window next cycle.
        let watermark = if exhausted {
            max_ts.max(cursor.watermark)
        } else {
            now.max(max_ts)
        };

        Ok(FetchResult {
            events,
            cursor: Cursor {
                watermark,
                state: serde_json::to_value(&state).unwrap_or_default(),
            },
            calls_used: calls,
        })
    }
}

#[async_trait]
impl ActionSource for QuoProvider {
    /// Send an SMS reply. Costs Quo credits; the UI only calls this when the
    /// user has opted in to sending from Feedglance.
    async fn comment(&self, item_id: &str, text: &str) -> Result<(), ProviderError> {
        let content = text.trim();
        if content.is_empty() {
            return Err(ProviderError::Other("Message is empty".into()));
        }
        if content.chars().count() > 1600 {
            return Err(ProviderError::Other(
                "Quo messages are limited to 1600 characters".into(),
            ));
        }
        let (_, phone_number_id, to) = decode_subject_id(item_id)?;
        // Without `userId` Quo credits the send to the line's owner, not the
        // person replying.
        let user_id = self.user_id().await?;

        let resp = self
            .send(
                self.client
                    .post(format!("{}/messages", API_BASE))
                    .json(&serde_json::json!({
                        "content": content,
                        "from": phone_number_id,
                        "to": to,
                        "userId": user_id,
                    })),
            )
            .await?;
        // 202 means accepted, not delivered. An immediate `undelivered` is the
        // only failure visible at this point.
        if let Ok(r) = resp.json::<SendResponse>().await {
            if r.data.status == "undelivered" {
                return Err(ProviderError::Other("Quo accepted the message but could not deliver it".into()));
            }
        }
        Ok(())
    }

    async fn statuses(&self, _project_id: &str) -> Result<Vec<StatusOption>, ProviderError> {
        Err(ProviderError::Other("Quo conversations have no statuses".into()))
    }

    async fn set_status(&self, _item_id: &str, _status_id: &str) -> Result<(), ProviderError> {
        Err(ProviderError::Other("Quo conversations have no statuses".into()))
    }

    async fn assignees(&self, _project_id: &str) -> Result<Vec<AssigneeOption>, ProviderError> {
        Err(ProviderError::Other("Assigning Quo conversations isn't supported".into()))
    }

    async fn assign(&self, _item_id: &str, _assignee_id: &str) -> Result<(), ProviderError> {
        Err(ProviderError::Other("Assigning Quo conversations isn't supported".into()))
    }

    /// The conversation's recent messages, both directions, for the reply
    /// panel. Free: reads don't cost credits.
    async fn details(&self, item_id: &str) -> Result<ItemDetails, ProviderError> {
        let (_, phone_number_id, participants) = decode_subject_id(item_id)?;
        let mut msgs = self
            .messages(phone_number_id, &participants, None, THREAD_LENGTH)
            .await?;
        msgs.sort_by_key(|m| m.timestamp_ms());

        // Name outgoing messages by teammate; fall back quietly if the user
        // list can't be read.
        let names: HashMap<String, String> = self
            .list_users()
            .await
            .map(|(users, _)| users.into_iter().map(|u| (u.id.clone(), u.display_name())).collect())
            .unwrap_or_default();

        let thread = msgs
            .iter()
            .map(|m| ThreadMessage {
                author: if m.is_incoming() {
                    m.from.clone()
                } else if m.user_id.as_deref() == Some(self.user_id.as_str()) && !self.user_id.is_empty() {
                    "You".into()
                } else {
                    m.user_id
                        .as_ref()
                        .and_then(|id| names.get(id).cloned())
                        .unwrap_or_else(|| "Your team".into())
                },
                text: m.body(),
                timestamp: m.timestamp_ms(),
                outgoing: !m.is_incoming(),
                status: Some(m.status.clone()).filter(|s| !s.is_empty()),
            })
            .collect();

        Ok(ItemDetails {
            thread: Some(thread),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_id_round_trips() {
        let id = encode_subject_id("CNabc", "PNdef", &["+15551234567".into(), "+15557654321".into()]);
        assert_eq!(id, "CNabc|PNdef|+15551234567,+15557654321");
        let (cn, pn, to) = decode_subject_id(&id).unwrap();
        assert_eq!((cn, pn), ("CNabc", "PNdef"));
        assert_eq!(to, vec!["+15551234567", "+15557654321"]);
    }

    #[test]
    fn foreign_ids_are_rejected() {
        assert!(decode_subject_id("PROJ-123").is_err());
        assert!(decode_subject_id("CN1|PN1|").is_err());
    }

    #[test]
    fn phone_keys_ignore_formatting() {
        assert_eq!(phone_key("+1 (555) 123-4567"), phone_key("+15551234567"));
    }

    #[test]
    fn media_only_message_gets_a_body() {
        let m = QuoMessage {
            id: "AC1".into(),
            from: "+15551234567".into(),
            text: "".into(),
            direction: "incoming".into(),
            user_id: None,
            status: "received".into(),
            created_at: "2026-09-30T10:00:00Z".into(),
            media: vec![QuoMedia { url: "https://x".into(), media_type: None }],
        };
        assert_eq!(m.body(), "1 attachment");
        assert_eq!(m.timestamp_ms(), 1_790_762_400_000);
    }

    #[test]
    fn a2p_error_is_explained() {
        let msg = describe_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"code":"0206400","message":"A2P Registration Not Approved"}"#,
        );
        assert!(msg.contains("A2P 10DLC"));
    }

    #[test]
    fn nested_error_message_is_used() {
        let msg = describe_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"message":"Forbidden","key":"Forbidden"}}"#,
        );
        assert_eq!(msg, "Quo API 403: Forbidden");
    }

    #[test]
    fn conversation_label_prefers_contact_names() {
        let conv = QuoConversation {
            id: "CN1".into(),
            phone_number_id: "PN1".into(),
            participants: vec!["+15551234567".into(), "+15550000000".into()],
            name: None,
            last_activity_id: None,
            deleted_at: None,
        };
        let contacts = HashMap::from([("15551234567".to_string(), "Jane Doe".to_string())]);
        assert_eq!(
            QuoProvider::conversation_label(&conv, &contacts),
            "Jane Doe, +15550000000"
        );
    }

    /// `QUO_API_KEY=… QUO_EMAIL=… cargo test quo -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn validate_live() {
        let key = std::env::var("QUO_API_KEY").expect("QUO_API_KEY not set");
        let email = std::env::var("QUO_EMAIL").expect("QUO_EMAIL not set");
        let uid = QuoProvider::new(&email, &key, "").validate().await.unwrap();
        println!("user id: {}", uid);
        assert!(uid.starts_with("US"));
    }

    /// Settles the open question in the module docs. Text one of your Quo
    /// lines, wait a few seconds, then run this: it passes when the
    /// conversation shows up under `updatedAfter` = 10 minutes ago.
    #[tokio::test]
    #[ignore]
    async fn updated_after_catches_new_messages_live() {
        let key = std::env::var("QUO_API_KEY").expect("QUO_API_KEY not set");
        let email = std::env::var("QUO_EMAIL").expect("QUO_EMAIL not set");
        let p = QuoProvider::new(&email, &key, "");
        let uid = p.validate().await.unwrap();
        let since = chrono::Utc::now().timestamp_millis() - 10 * 60 * 1000;
        let page: Page<QuoConversation> = p
            .get(
                "conversations",
                &[
                    ("userId", uid),
                    ("maxResults", "20".into()),
                    ("updatedAfter", iso(since)),
                ],
            )
            .await
            .unwrap();
        println!("{} conversation(s) updated in the last 10 minutes", page.data.len());
        assert!(!page.data.is_empty(), "no conversation updated — updatedAt may not move on new messages");
    }
}
