mod activities;
mod polling;
mod youtrack;

use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

use polling::{FocusState, PollingState, SharedPollingState};
use youtrack::YouTrackClient;

#[tauri::command]
async fn validate_connection(url: String, token: String) -> Result<youtrack::UserInfo, String> {
    let client = YouTrackClient::new(&url, &token);
    client.get_current_user().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_connection(url: String, token: String) -> Result<bool, String> {
    let client = YouTrackClient::new(&url, &token);
    match client.get_current_user().await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn start_polling(
    state: tauri::State<'_, SharedPollingState>,
    url: String,
    token: String,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.url = url;
    s.token = token;
    s.running = true;
    Ok(())
}

#[tauri::command]
async fn stop_polling(state: tauri::State<'_, SharedPollingState>) -> Result<(), String> {
    let mut s = state.write().await;
    s.running = false;
    Ok(())
}

#[tauri::command]
async fn set_focus_state(
    state: tauri::State<'_, SharedPollingState>,
    focus: String,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.focus_state = match focus.as_str() {
        "focused" => FocusState::Focused,
        "minimized" => FocusState::Minimized,
        "idle" => FocusState::Idle,
        _ => return Err(format!("Invalid focus state: {}", focus)),
    };
    Ok(())
}

#[tauri::command]
async fn get_activities(
    state: tauri::State<'_, SharedPollingState>,
) -> Result<Vec<activities::ActivityItem>, String> {
    let s = state.read().await;
    Ok(s.activities.clone())
}

#[tauri::command]
async fn mark_activity_read(
    state: tauri::State<'_, SharedPollingState>,
    activity_id: String,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.read_ids.insert(activity_id);
    Ok(())
}

#[tauri::command]
async fn mark_all_read(state: tauri::State<'_, SharedPollingState>) -> Result<(), String> {
    let mut s = state.write().await;
    let all_ids: Vec<String> = s.activities.iter().map(|a| a.id.clone()).collect();
    for id in all_ids {
        s.read_ids.insert(id);
    }
    Ok(())
}

#[tauri::command]
async fn get_read_ids(
    state: tauri::State<'_, SharedPollingState>,
) -> Result<Vec<String>, String> {
    let s = state.read().await;
    Ok(s.read_ids.iter().cloned().collect())
}

#[tauri::command]
async fn get_unread_count(state: tauri::State<'_, SharedPollingState>) -> Result<u32, String> {
    let s = state.read().await;
    let count = s
        .activities
        .iter()
        .filter(|a| !s.read_ids.contains(&a.id))
        .count() as u32;
    Ok(count)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let polling_state: SharedPollingState = Arc::new(RwLock::new(PollingState::new()));
    let cancel = Arc::new(Mutex::new(()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(polling_state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = polling_state.clone();
            let cancel = cancel.clone();
            polling::start_polling_loop(handle, state, cancel);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            validate_connection,
            check_connection,
            start_polling,
            stop_polling,
            set_focus_state,
            get_activities,
            mark_activity_read,
            mark_all_read,
            get_read_ids,
            get_unread_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
