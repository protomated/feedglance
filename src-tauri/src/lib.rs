mod youtrack;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![validate_connection, check_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
