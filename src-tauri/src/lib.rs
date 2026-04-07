mod activities;
mod cache;
mod polling;
mod tray;
mod youtrack;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;
use tokio::sync::{Mutex, RwLock};

use cache::SharedProjectCache;
use polling::{AccountPollingState, FocusState, PollingManager, SharedPollingState};
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
    account_id: String,
    url: String,
    token: String,
    current_user_id: Option<String>,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    let uid = current_user_id.unwrap_or_default();
    if let Some(acct) = mgr.accounts.get_mut(&account_id) {
        acct.url = url;
        acct.token = token;
        acct.current_user_id = uid;
        acct.running = true;
    } else {
        mgr.accounts
            .insert(account_id, AccountPollingState::new(url, token, uid));
    }
    Ok(())
}

#[tauri::command]
async fn stop_polling(
    state: tauri::State<'_, SharedPollingState>,
    account_id: Option<String>,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    match account_id {
        Some(id) => {
            if let Some(acct) = mgr.accounts.get_mut(&id) {
                acct.running = false;
            }
        }
        None => {
            for acct in mgr.accounts.values_mut() {
                acct.running = false;
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn remove_account(
    state: tauri::State<'_, SharedPollingState>,
    account_id: String,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    mgr.accounts.remove(&account_id);
    Ok(())
}

#[tauri::command]
async fn set_focus_state(
    state: tauri::State<'_, SharedPollingState>,
    focus: String,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    mgr.focus_state = match focus.as_str() {
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
    account_id: Option<String>,
) -> Result<Vec<activities::ActivityItem>, String> {
    let mgr = state.read().await;
    match account_id {
        Some(id) => {
            if let Some(acct) = mgr.accounts.get(&id) {
                Ok(acct.activities.clone())
            } else {
                Ok(vec![])
            }
        }
        None => Ok(mgr.all_activities()),
    }
}

#[tauri::command]
async fn mark_activity_read(
    state: tauri::State<'_, SharedPollingState>,
    activity_id: String,
    account_id: String,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    if let Some(acct) = mgr.accounts.get_mut(&account_id) {
        acct.read_ids.insert(activity_id);
    }
    Ok(())
}

#[tauri::command]
async fn mark_all_read(
    state: tauri::State<'_, SharedPollingState>,
    account_id: Option<String>,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    match account_id {
        Some(id) => {
            if let Some(acct) = mgr.accounts.get_mut(&id) {
                let all_ids: Vec<String> = acct.activities.iter().map(|a| a.id.clone()).collect();
                for id in all_ids {
                    acct.read_ids.insert(id);
                }
            }
        }
        None => {
            for acct in mgr.accounts.values_mut() {
                let all_ids: Vec<String> = acct.activities.iter().map(|a| a.id.clone()).collect();
                for id in all_ids {
                    acct.read_ids.insert(id);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_read_ids(
    state: tauri::State<'_, SharedPollingState>,
    account_id: String,
) -> Result<Vec<String>, String> {
    let mgr = state.read().await;
    if let Some(acct) = mgr.accounts.get(&account_id) {
        Ok(acct.read_ids.iter().cloned().collect())
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn set_muted_issues(
    state: tauri::State<'_, SharedPollingState>,
    muted_ids: Vec<String>,
    account_id: Option<String>,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    match account_id {
        Some(id) => {
            if let Some(acct) = mgr.accounts.get_mut(&id) {
                acct.muted_issues = muted_ids.into_iter().collect();
            }
        }
        None => {
            // Apply to all accounts (backward compat)
            let set: std::collections::HashSet<String> = muted_ids.into_iter().collect();
            for acct in mgr.accounts.values_mut() {
                acct.muted_issues = set.clone();
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_read_ids(
    state: tauri::State<'_, SharedPollingState>,
    read_ids: Vec<String>,
    account_id: String,
) -> Result<(), String> {
    let mut mgr = state.write().await;
    if let Some(acct) = mgr.accounts.get_mut(&account_id) {
        acct.read_ids = read_ids.into_iter().collect();
    }
    Ok(())
}

#[tauri::command]
async fn get_unread_count(state: tauri::State<'_, SharedPollingState>) -> Result<u32, String> {
    let mgr = state.read().await;
    Ok(mgr.total_unread_count())
}

// --- Tray badge ---

#[tauri::command]
async fn set_tray_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    tray::update_tray_badge(&app, count);
    Ok(())
}

// --- Project listing ---

#[tauri::command]
async fn get_projects(
    url: String,
    token: String,
) -> Result<Vec<youtrack::ProjectInfo>, String> {
    let client = YouTrackClient::new(&url, &token);
    client.get_projects().await.map_err(|e| e.to_string())
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
    let polling_state: SharedPollingState = Arc::new(RwLock::new(PollingManager::new()));
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
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            match tray::setup_tray(app.handle(), polling_state.clone()) {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("Failed to set up system tray: {e}");
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            let handle = app.handle().clone();
            let state = polling_state.clone();
            let cancel = cancel.clone();
            polling::start_polling_loop(handle, state, cancel);
            Ok(())
        })
        .on_window_event(|window, event| {
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
            remove_account,
            set_focus_state,
            get_activities,
            mark_activity_read,
            mark_all_read,
            get_read_ids,
            get_unread_count,
            set_muted_issues,
            get_projects,
            set_tray_badge,
            set_read_ids,
            execute_command,
            post_comment,
            get_project_states,
            get_project_team,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
