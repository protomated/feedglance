use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_positioner::{Position, WindowExt};

use crate::polling::SharedPollingState;

/// Set up the system tray icon with a right-click context menu.
pub fn setup_tray(app: &AppHandle, state: SharedPollingState) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let mark_all_read =
        MenuItem::with_id(app, "mark_all_read", "Mark All as Read", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &mark_all_read, &settings_item, &quit_item])?;

    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon@2x.png"))
        .expect("failed to load tray icon");

    TrayIconBuilder::with_id("feedglance-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Feedglance")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => {
                toggle_window(app);
            }
            "mark_all_read" => {
                // Update backend state and tray badge directly so it works
                // even when the webview window is hidden.
                let state = state.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let mut mgr = state.write().await;
                    for acct in mgr.accounts.values_mut() {
                        let all_ids: Vec<String> =
                            acct.events.iter().map(|a| a.id.clone()).collect();
                        for id in all_ids {
                            acct.read_ids.insert(id);
                        }
                    }
                    drop(mgr);
                    update_tray_badge(&app, 0);
                    // Also notify the frontend so its UI stays in sync
                    let _ = app.emit("tray-mark-all-read", ());
                });
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
pub fn toggle_window(app: &AppHandle) {
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
        // Position the window centered below the tray icon.
        // On some Linux DEs the tray position is never reported to the
        // positioner plugin, which causes `move_window` to panic.
        // Catch that panic and fall back to centering on screen.
        let w = window.clone();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = w.move_window(Position::TrayCenter);
        }))
        .is_err()
        {
            let _ = window.center();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Overlay a badge dot onto the tray icon for platforms without a text title.
///
/// `set_title` renders text beside the icon in the macOS menu bar, but is a
/// no-op on Windows and Linux — so on those platforms the unread count was
/// invisible, surfacing only in the hover tooltip. A composited dot is the
/// conventional fallback: it needs no font rasterization (and so no new
/// dependency), and reads at 16px where glyphs would not.
///
/// Returns `None` if the base icon cannot be decoded, in which case the caller
/// leaves the existing icon alone rather than clearing it.
#[cfg(not(target_os = "macos"))]
fn badged_icon(unread_count: u32) -> Option<Image<'static>> {
    const BASE: &[u8] = include_bytes!("../icons/tray-icon@2x.png");
    let img = image::load_from_memory(BASE).ok()?;
    let mut rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();

    if unread_count > 0 {
        // Filled circle in the top-right quadrant, sized relative to the icon so
        // this holds if the asset is ever swapped for another resolution.
        let r = (w.min(h) as f32 * 0.28).max(3.0);
        let cx = w as f32 - r - 1.0;
        let cy = r + 1.0;
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cy;
                let d = (dx * dx + dy * dy).sqrt();
                if d <= r {
                    // Antialias the rim so the dot does not look ragged.
                    let a = ((r - d).clamp(0.0, 1.0) * 255.0) as u8;
                    let px = rgba.get_pixel_mut(x, y);
                    let blend = |bg: u8, fg: u8| {
                        ((fg as u16 * a as u16 + bg as u16 * (255 - a) as u16) / 255) as u8
                    };
                    px.0 = [
                        blend(px.0[0], 235),
                        blend(px.0[1], 87),
                        blend(px.0[2], 87),
                        px.0[3].max(a),
                    ];
                }
            }
        }
    }

    Some(Image::new_owned(rgba.into_raw(), w, h))
}

/// Update the tray icon badge and tooltip with the unread count.
pub fn update_tray_badge(app: &AppHandle, unread_count: u32) {
    if let Some(tray) = app.tray_by_id("feedglance-tray") {
        // set_title shows text next to the icon in the macOS menu bar.
        // Use Some("") instead of None to clear the title — on macOS,
        // set_title(None) can be a no-op that leaves the old text visible.
        //
        // It is a no-op on Windows and Linux, which is why those platforms get
        // the composited dot below instead.
        let title = if unread_count == 0 {
            String::new()
        } else if unread_count > 99 {
            "99+".to_string()
        } else {
            unread_count.to_string()
        };
        let _ = tray.set_title(Some(title.as_str()));

        // Repainting the icon costs a small composite, so only do it when the
        // zero/non-zero state actually flips — the count itself is not drawn.
        #[cfg(not(target_os = "macos"))]
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            static HAS_BADGE: AtomicBool = AtomicBool::new(false);
            let want = unread_count > 0;
            if HAS_BADGE.swap(want, Ordering::Relaxed) != want {
                if let Some(icon) = badged_icon(unread_count) {
                    let _ = tray.set_icon(Some(icon));
                    let _ = tray.set_icon_as_template(true);
                }
            }
        }

        // Also update tooltip for hover
        let tooltip = if unread_count == 0 {
            "Feedglance".to_string()
        } else if unread_count > 99 {
            "Feedglance — 99+ unread".to_string()
        } else {
            format!("Feedglance — {} unread", unread_count)
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}
