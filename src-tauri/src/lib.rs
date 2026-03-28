mod activities;
mod cache;
mod polling;
mod tray;
mod youtrack;

use std::sync::Arc;
use tauri_plugin_global_shortcut::ShortcutState;
use tokio::sync::{Mutex, RwLock};

use cache::SharedProjectCache;
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
    current_user_id: Option<String>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.url = url;
    s.token = token;
    if let Some(uid) = current_user_id {
        s.current_user_id = uid;
    }
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
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedPollingState>,
    activity_id: String,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.read_ids.insert(activity_id);
    let unread = s.activities.iter().filter(|a| !s.read_ids.contains(&a.id)).count() as u32;
    drop(s);
    tray::update_tray_badge(&app, unread);
    Ok(())
}

#[tauri::command]
async fn mark_all_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedPollingState>,
) -> Result<(), String> {
    let mut s = state.write().await;
    let all_ids: Vec<String> = s.activities.iter().map(|a| a.id.clone()).collect();
    for id in all_ids {
        s.read_ids.insert(id);
    }
    drop(s);
    tray::update_tray_badge(&app, 0);
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
async fn set_muted_issues(
    state: tauri::State<'_, SharedPollingState>,
    muted_ids: Vec<String>,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.muted_issues = muted_ids.into_iter().collect();
    Ok(())
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

// --- Epic 3: Quick Actions commands ---

#[tauri::command]
async fn execute_command(
    url: String,
    token: String,
    issue_id: String,
    command: String,
) -> Result<youtrack::CommandResult, String> {
    let client = YouTrackClient::new(&url, &token);
    client
        .post_command(&issue_id, &command)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn post_comment(
    url: String,
    token: String,
    issue_id: String,
    text: String,
) -> Result<youtrack::CommandResult, String> {
    let client = YouTrackClient::new(&url, &token);
    client
        .post_comment(&issue_id, &text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_project_states(
    url: String,
    token: String,
    project_id: String,
    project_cache: tauri::State<'_, SharedProjectCache>,
) -> Result<Vec<youtrack::StateBundleElement>, String> {
    let client = YouTrackClient::new(&url, &token);
    cache::fetch_project_states(&project_cache, &client, &project_id).await
}

#[tauri::command]
async fn get_project_team(
    url: String,
    token: String,
    project_id: String,
    project_cache: tauri::State<'_, SharedProjectCache>,
) -> Result<Vec<youtrack::TeamMember>, String> {
    let client = YouTrackClient::new(&url, &token);
    cache::fetch_project_team(&project_cache, &client, &project_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let polling_state: SharedPollingState = Arc::new(RwLock::new(PollingState::new()));
    let project_cache: SharedProjectCache = Arc::new(RwLock::new(cache::ProjectCache::new()));
    let cancel = Arc::new(Mutex::new(()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_positioner::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        // Any registered shortcut toggles the main window
                        tray::toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(polling_state.clone())
        .manage(project_cache)
        .setup(move |app| {
            // Hide from macOS dock — tray-only app
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Set up system tray
            tray::setup_tray(app.handle(), polling_state.clone())?;

            // Global shortcut is registered from the frontend (allows user customization).
            // The Rust handler above will toggle the window for any registered shortcut.

            // Start polling loop
            let handle = app.handle().clone();
            let state = polling_state.clone();
            let cancel = cancel.clone();
            polling::start_polling_loop(handle, state, cancel);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide window instead of closing — tray app stays alive
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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
            set_muted_issues,
            execute_command,
            post_comment,
            get_project_states,
            get_project_team,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
