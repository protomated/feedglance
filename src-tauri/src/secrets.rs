//! Account tokens in the OS credential store.
//!
//! Tokens live in the macOS Keychain, the Windows Credential Manager, or the
//! Secret Service on Linux (GNOME Keyring, KWallet, KeePassXC), keyed by
//! account ID. Everything else about an account stays in `credentials.json`.
//!
//! Linux desktops without a Secret Service provider (bare window managers,
//! some minimal installs) have no store to write to. The commands then return
//! an error and the frontend keeps that token in `credentials.json` instead, so
//! the account still works — just without OS protection.

use keyring::{Entry, Error};

/// Service name the entries are filed under; matches the bundle identifier.
const SERVICE: &str = "com.protomated.feedglance";

fn entry(account_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account_id).map_err(|e| format!("Keychain unavailable: {}", e))
}

// Keychain calls block (macOS can show an access prompt), so each command runs
// them off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Keychain task failed: {}", e))?
}

#[tauri::command]
pub async fn secret_set(account_id: String, token: String) -> Result<(), String> {
    blocking(move || {
        entry(&account_id)?
            .set_password(&token)
            .map_err(|e| format!("Keychain write failed: {}", e))
    })
    .await
}

/// `None` when no token is stored for the account.
#[tauri::command]
pub async fn secret_get(account_id: String) -> Result<Option<String>, String> {
    blocking(move || match entry(&account_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain read failed: {}", e)),
    })
    .await
}

/// Deleting a token that isn't there succeeds.
#[tauri::command]
pub async fn secret_delete(account_id: String) -> Result<(), String> {
    blocking(move || match entry(&account_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain delete failed: {}", e)),
    })
    .await
}
