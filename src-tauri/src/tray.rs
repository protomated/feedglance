use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_positioner::{Position, WindowExt};

/// Set up the system tray icon with a right-click context menu.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let mark_all_read =
        MenuItem::with_id(app, "mark_all_read", "Mark All as Read", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &mark_all_read, &settings_item, &quit_item])?;

    TrayIconBuilder::with_id("youtrackd-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .tooltip("YouTrackd")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                toggle_window(app);
            }
            "mark_all_read" => {
                let _ = app.emit("tray-mark-all-read", ());
            }
            "settings" => {
                let _ = app.emit("tray-open-settings", ());
                show_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Feed tray events to the positioner so it knows where the icon is
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);

            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Toggle the main window visibility.
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_window(app);
        }
    }
}

/// Show the main window positioned at the tray icon and focus it.
fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Position the window centered below the tray icon
        let _ = window.move_window(Position::TrayCenter);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Update the tray icon badge (title text next to icon) and tooltip with unread count.
pub fn update_tray_badge(app: &AppHandle, unread_count: u32) {
    if let Some(tray) = app.tray_by_id("youtrackd-tray") {
        // set_title shows text next to the icon in the macOS menu bar
        let title = if unread_count == 0 {
            None
        } else if unread_count > 99 {
            Some("99+".to_string())
        } else {
            Some(unread_count.to_string())
        };
        let _ = tray.set_title(title.as_deref());

        // Also update tooltip for hover
        let tooltip = if unread_count == 0 {
            "YouTrackd".to_string()
        } else if unread_count > 99 {
            "YouTrackd — 99+ unread".to_string()
        } else {
            format!("YouTrackd — {} unread", unread_count)
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}
