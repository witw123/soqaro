mod cache_cleanup;
mod system_media;
mod local_storage;
mod native_downloader;
mod url_guard;

use tauri::{
    command,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    AppHandle, Manager, PhysicalPosition, Url, WebviewUrl, WindowEvent,
};

// The desktop lyrics window: a compact always-on-top bar that shows the
// player card (artwork, track info, transport) together with word-by-word
// karaoke lyrics. It loads the same web origin as the main window on a
// dedicated route so BroadcastChannel can bridge playback state between the
// two windows without any extra permissions.
const LYRICS_LABEL: &str = "lyrics";
const LYRICS_WIDTH: f64 = 860.0;
const LYRICS_HEIGHT: f64 = 96.0;
const LYRICS_MIN_WIDTH: f64 = 320.0;
const LYRICS_MIN_HEIGHT: f64 = 64.0;
const LYRICS_MAX_WIDTH: f64 = 2400.0;
const LYRICS_MAX_HEIGHT: f64 = 600.0;
// Keep the bar clear of the Windows taskbar / macOS dock.
const LYRICS_BOTTOM_INSET_LOGICAL: f64 = 96.0;

// NOTE: every command below is `async` on purpose. Sync commands execute on
// the main thread, and creating a webview window there dispatches back into
// the event loop it is blocking — the whole app deadlocks (no window, frozen
// UI, no quit). Async commands run on the async runtime, which is the
// supported path for cross-thread window creation.
#[command]
async fn system_media_update_meta(
    app: AppHandle,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    duration_secs: Option<f64>,
) -> Result<(), String> {
    system_media::update_metadata(
        &app,
        &title,
        artist.as_deref(),
        album.as_deref(),
        artwork_url.as_deref(),
        duration_secs,
    );
    Ok(())
}

#[command]
async fn system_media_update_playback(
    app: AppHandle,
    is_playing: bool,
    position_ms: f64,
) -> Result<(), String> {
    system_media::update_playback(&app, is_playing, position_ms);
    Ok(())
}

#[command]
async fn system_media_clear(app: AppHandle) -> Result<(), String> {
    system_media::clear(&app);
    Ok(())
}

#[command]
async fn toggle_desktop_lyrics(app: AppHandle, caller: tauri::WebviewWindow) -> Result<bool, String> {
    url_guard::validate_trusted_caller(&caller)?;

    if let Some(window) = app.get_webview_window(LYRICS_LABEL) {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|error| error.to_string())?;
            return Ok(false);
        }
        window.show().map_err(|error| error.to_string())?;
        return Ok(true);
    }

    let mut url = match app
        .get_webview_window("main")
        .and_then(|main| main.url().ok())
        .filter(url_guard::is_trusted_window_url)
    {
        Some(url) => url,
        None => {
            #[cfg(debug_assertions)]
            {
                Url::parse("http://localhost:3000/desktop-lyrics").expect("valid dev fallback url")
            }
            #[cfg(not(debug_assertions))]
            {
                Url::parse("https://soqaro.witw.top/desktop-lyrics").expect("valid fallback url")
            }
        }
    };
    url.set_path("/desktop-lyrics");
    url.set_query(Some("window=desktop-lyrics"));
    url.set_fragment(None);

    let builder = WebviewWindowBuilder::new(&app, LYRICS_LABEL, WebviewUrl::External(url))
        .title("桌面歌词")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Freely resizable: the window host exposes edge dragging and the
        // content adapts its font to the window size.
        .resizable(true)
        .shadow(false)
        .focused(false)
        .inner_size(LYRICS_WIDTH, LYRICS_HEIGHT);
    // `transparent` is unavailable on macOS builds of tauri 2.11 (the builder
    // method is cfg'd out regardless of the macos-private-api feature), so the
    // lyrics page paints its own opaque dark surface there. Windows and Linux
    // get a true see-through bar.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder.build().map_err(|error| error.to_string())?;
    position_lyrics_window(&window);
    window.show().map_err(|error| error.to_string())?;
    Ok(true)
}

#[command]
async fn hide_desktop_lyrics_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LYRICS_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[command]
async fn drag_desktop_lyrics_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LYRICS_LABEL) {
        window.start_dragging().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[command]
async fn set_desktop_lyrics_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LYRICS_LABEL) else {
        return Ok(());
    };
    let width = width.clamp(LYRICS_MIN_WIDTH, LYRICS_MAX_WIDTH);
    let height = height.clamp(LYRICS_MIN_HEIGHT, LYRICS_MAX_HEIGHT);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    Ok(())
}

// The web bundle this window renders is served from a remote origin, so its
// baked-in version always tracks the latest deploy and on its own can never
// reveal that the installed binary is behind. Report the shell's compiled-in
// version instead — it comes from tauri.conf.json, which the release tag must
// match, so the update check compares the installed app against the release
// rather than the (always current) web build against itself.
#[command]
async fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

/// 设置 webview 原生缩放(等效浏览器 Ctrl+滚轮缩放):
/// 等比缩放全部内容(文字/图片/布局/fixed 元素),viewport 断点同步适应,
/// 与浏览器端缩放体验完全一致。
#[command]
async fn set_ui_zoom(app: AppHandle, scale: f64) -> Result<(), String> {
    let clamped = scale.clamp(0.5, 2.0);
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_zoom(clamped)
            .map_err(|e| format!("Failed to set zoom: {e}"))
    } else {
        Err("Main window not found".to_string())
    }
}

#[command]
async fn focus_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

#[command]
#[allow(deprecated)]
async fn open_external_url(
    app: AppHandle,
    caller: tauri::WebviewWindow,
    url: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    url_guard::validate_trusted_caller(&caller)?;
    let parsed = url_guard::validate_external_url(&url)?;
    app.shell()
        .open(parsed.as_str(), None)
        .map_err(|error| error.to_string())
}

fn position_lyrics_window(window: &tauri::WebviewWindow) {
    let monitor = window
        .app_handle()
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let width_px = (LYRICS_WIDTH * scale).round() as i32;
    let height_px = (LYRICS_HEIGHT * scale).round() as i32;
    let inset_px = (LYRICS_BOTTOM_INSET_LOGICAL * scale).round() as i32;
    let x = monitor_position.x + (monitor_size.width as i32 - width_px) / 2;
    let y = monitor_position.y + monitor_size.height as i32 - height_px - inset_px;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[command]
async fn download_direct_native(
    caller: tauri::WebviewWindow,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    concurrent_parts: Option<usize>,
) -> Result<native_downloader::NativeDownloadResponse, String> {
    url_guard::validate_trusted_caller(&caller)?;
    native_downloader::download_direct_native(url, headers, concurrent_parts).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    cache_cleanup::clear_stale_webview_cache(
        &context.config().identifier,
        &context.package_info().version.to_string(),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let shortcut_str = shortcut.into_string();
                        let key = match shortcut_str.as_str() {
                            "MediaPlayPause" => "play-pause",
                            "MediaTrackNext" => "next-track",
                            "MediaTrackPrevious" => "previous-track",
                            "MediaStop" => "stop",
                            _ => "",
                        };
                        if !key.is_empty() {
                            let _ = tauri::Emitter::emit(app, "media-key", key);
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .build()
        )
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            local_storage::local_storage,
            system_media_update_meta,
            system_media_update_playback,
            system_media_clear,
            toggle_desktop_lyrics,
            hide_desktop_lyrics_window,
            drag_desktop_lyrics_window,
            set_desktop_lyrics_size,
            get_app_version,
            set_ui_zoom,
            focus_main_window,
            open_external_url,
            download_direct_native
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            for key in ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaStop"] {
                if let Ok(shortcut) = key.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                    let _ = app.global_shortcut().register(shortcut);
                }
            }

            let quit_i = MenuItem::with_id(app, "quit", "退出 Soqaro", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }

            let _tray = builder.build(app)?;

            if let Err(error) = system_media::init(&app.handle()) {
                eprintln!("system media controls init failed: {error}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide window instead of closing to keep background music playback active
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(context)
        .expect("error while running tauri application");
}
