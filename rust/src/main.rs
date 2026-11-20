// Pulso written in Rust: one frameless window with two webviews, the title bar (shell.html) and
// WhatsApp Web below it. page.js, the same code the Electron build injects, draws the themes, the
// Pulso panel and the update banner; this file provides everything the Electron main process did.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod icons;
mod settings;
mod system;
mod updater;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, MenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, UserAttentionType, WebviewUrl, WindowEvent};

const WHATSAPP_URL: &str = "https://web.whatsapp.com/";
const TITLE_BAR_HEIGHT: f64 = 40.0;
const LUNA_BAR_HEIGHT: f64 = 30.0; // the height of a classic title bar
const PAGE_JS: &str = include_str!("../../src/page.js");
const BRIDGE_JS: &str = include_str!("bridge.js");
const SHELL_BRIDGE_JS: &str = include_str!("shell-bridge.js");
const DEFAULT_ICO: &[u8] = include_bytes!("../icons/icon.ico");
const SPELL_LANGS: [(&str, &str); 6] = [
    ("es", "Español"),
    ("en-US", "Inglés (EE. UU.)"),
    ("pt-BR", "Portugués (Brasil)"),
    ("fr", "Francés"),
    ("de", "Alemán"),
    ("it", "Italiano"),
];
const TOGGLES: [&str; 6] = ["closeToTray", "launchAtLogin", "startMinimized", "notificationSound", "flashOnMessage", "spellcheck"];

pub struct Shared {
    settings: Mutex<settings::Settings>,
    data_dir: PathBuf,
    unread: AtomicU32,
    quitting: AtomicBool,
    pub update: Mutex<Value>,
    pub dismissed: Mutex<Option<String>>,
    pub pending: Mutex<Option<(String, String)>>,
}

fn shared(app: &AppHandle) -> &Shared {
    app.state::<Shared>().inner()
}

pub fn page_eval(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview("wa") {
        let _ = w.eval(js);
    }
}

fn shell_emit(app: &AppHandle, name: &str, args: &[Value]) {
    if let Some(w) = app.get_webview("shell") {
        let list: Vec<String> = args.iter().map(Value::to_string).collect();
        let _ = w.eval(&format!("window.__shellEmit && window.__shellEmit({}, {})", json!(name), list.join(", ")));
    }
}

fn bar_height(theme: &str) -> f64 {
    if theme == "luna" {
        LUNA_BAR_HEIGHT
    } else {
        TITLE_BAR_HEIGHT
    }
}

// ---------- Icons ----------

fn custom_ico_file(app: &AppHandle) -> PathBuf {
    shared(app).data_dir.join("custom-icon.ico")
}

fn look(app: &AppHandle) -> icons::Look {
    let icon = shared(app).settings.lock().unwrap().get("icon");
    if icon.get("kind").and_then(Value::as_str) == Some("ico") {
        if let Ok(bytes) = std::fs::read(custom_ico_file(app)) {
            if let Ok(img) = Image::from_bytes(&bytes) {
                return icons::Look::Custom { rgba: img.rgba().to_vec(), w: img.width(), h: img.height() };
            }
        }
    }
    icons::Look::Mark(icons::Style::from_setting(&icon))
}

fn is_default_icon(app: &AppHandle) -> bool {
    let icon = shared(app).settings.lock().unwrap().get("icon");
    match icon.get("kind").and_then(Value::as_str) {
        Some("ico") => false,
        Some("color") => {
            let s = |k: &str| icon.get(k).and_then(Value::as_str).unwrap_or_default().to_lowercase();
            s("from") == icons::DEFAULT_FROM
                && s("to") == icons::DEFAULT_TO
                && icon.get("angle").and_then(Value::as_f64) == Some(135.0)
                && icon.get("gradient").and_then(Value::as_bool) != Some(false)
        }
        _ => true,
    }
}

fn window_icon(app: &AppHandle) -> Image<'static> {
    if is_default_icon(app) {
        if let Ok(img) = Image::from_bytes(DEFAULT_ICO) {
            return img.to_owned();
        }
    }
    Image::new_owned(look(app).mark_rgba(64), 64, 64)
}

fn scale(app: &AppHandle) -> f64 {
    app.get_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0)
}

fn tray_icon(app: &AppHandle, count: u32) -> Image<'static> {
    let size = (16.0 * scale(app)).round().max(16.0) as u32;
    Image::new_owned(look(app).tray_rgba(size, count), size, size)
}

fn icon_info(app: &AppHandle) -> Value {
    let icon = shared(app).settings.lock().unwrap().get("icon");
    let mut info = if icon.is_object() { icon.clone() } else { json!({ "kind": "color" }) };
    if icon.get("kind").and_then(Value::as_str) == Some("ico") {
        if let Ok(bytes) = std::fs::read(custom_ico_file(app)) {
            use base64::Engine;
            info["ico"] = json!(format!("data:image/x-icon;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
        }
    } else {
        info["ico"] = Value::Null;
    }
    info
}

// The window, tray, title bar and (installed copy) shortcuts all follow the chosen icon.
fn apply_icon(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.set_icon(window_icon(app));
    }
    if let Some(tray) = app.tray_by_id("tray") {
        let _ = tray.set_icon(Some(tray_icon(app, shared(app).unread.load(Ordering::Relaxed))));
    }
    shell_emit(app, "icon", &[icon_info(app)]);
    if !updater::is_portable() {
        let icon_path = if is_default_icon(app) {
            std::env::current_exe().ok()
        } else {
            let bytes = look(app).ico();
            let dir = shared(app).data_dir.join("icons");
            let _ = std::fs::create_dir_all(&dir);
            // Each icon gets its own name: Windows caches icons by path.
            let hash = bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3));
            let file = dir.join(format!("pulso-{hash:016x}.ico"));
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    if e.path() != file {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            if !file.exists() {
                let _ = std::fs::write(&file, bytes);
            }
            Some(file)
        };
        if let Some(p) = icon_path {
            system::sync_shortcuts(&p);
        }
    }
}

// ---------- Window ----------

fn layout(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let sf = window.scale_factor().unwrap_or(1.0);
    let Ok(size) = window.inner_size() else { return };
    if size.width < 2 || size.height < 2 {
        return; // minimized
    }
    let size = size.to_logical::<f64>(sf);
    let full = window.is_fullscreen().unwrap_or(false);
    let theme = shared(app).settings.lock().unwrap().str("theme");
    let bar = if full { 0.0 } else { bar_height(&theme) };
    if let Some(shell) = app.get_webview("shell") {
        let _ = shell.set_position(LogicalPosition::new(0.0, if full { -100.0 } else { 0.0 }));
        let _ = shell.set_size(LogicalSize::new(size.width, bar.max(1.0)));
    }
    if let Some(wa) = app.get_webview("wa") {
        let _ = wa.set_position(LogicalPosition::new(0.0, bar));
        let _ = wa.set_size(LogicalSize::new(size.width, (size.height - bar).max(1.0)));
    }
}

fn save_bounds(app: &AppHandle) {
    let Some(w) = app.get_window("main") else { return };
    let maximized = w.is_maximized().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    let sf = w.scale_factor().unwrap_or(1.0);
    let mut s = shared(app).settings.lock().unwrap();
    s.set("maximized", json!(maximized));
    if !maximized && !minimized {
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
            let (pos, size) = (pos.to_logical::<f64>(sf), size.to_logical::<f64>(sf));
            if size.width > 100.0 {
                s.set("bounds", json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height }));
            }
        }
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_window(app);
        }
    }
}

pub fn quit(app: &AppHandle) {
    shared(app).quitting.store(true, Ordering::Relaxed);
    save_bounds(app);
    app.exit(0);
}

fn flash(app: &AppHandle) {
    let on = shared(app).settings.lock().unwrap().bool("flashOnMessage");
    if let Some(w) = app.get_window("main") {
        if on && !w.is_focused().unwrap_or(true) {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

fn set_unread(app: &AppHandle, count: u32) {
    let before = shared(app).unread.swap(count, Ordering::Relaxed);
    if before == count {
        return;
    }
    if let Some(tray) = app.tray_by_id("tray") {
        let _ = tray.set_icon(Some(tray_icon(app, count)));
        let _ = tray.set_tooltip(Some(if count > 0 { format!("Pulso — {count} sin leer") } else { "Pulso".into() }));
    }
    if let Some(w) = app.get_window("main") {
        let size = (16.0 * scale(app)).round().max(16.0) as u32;
        let overlay = (count > 0).then(|| Image::new_owned(icons::overlay_rgba(size, count), size, size));
        let _ = w.set_overlay_icon(overlay);
        let _ = w.set_title(&if count > 0 { format!("({}) Pulso", icons::badge_label(count)) } else { "Pulso".into() });
    }
    shell_emit(app, "unread", &[json!(count)]);
    if count > before {
        flash(app);
    }
}

fn set_zoom(app: &AppHandle, delta: f64) {
    let mut s = shared(app).settings.lock().unwrap();
    let current = s.f64("zoomFactor").unwrap_or(1.0);
    let factor = if delta == 0.0 { 1.0 } else { (current + delta).clamp(0.5, 3.0) };
    s.set("zoomFactor", json!(factor));
    if let Some(wa) = app.get_webview("wa") {
        let _ = wa.set_zoom(factor);
    }
}

fn reload(app: &AppHandle) {
    page_eval(app, "location.reload()");
}

fn browser_args(gpu: bool) -> String {
    // wry's defaults, plus: keep WhatsApp running at full speed while Pulso sits in the tray.
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling",
    );
    if !gpu {
        args.push_str(" --disable-gpu");
    }
    args
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let (bounds, maximized, theme, zoom, gpu, sound, spellcheck, start_min) = {
        let s = shared(app).settings.lock().unwrap();
        (
            s.get("bounds"),
            s.bool("maximized"),
            s.str("theme"),
            s.f64("zoomFactor").unwrap_or(1.0),
            s.bool("hardwareAcceleration"),
            s.bool("notificationSound"),
            s.bool("spellcheck"),
            s.bool("startMinimized"),
        )
    };
    let hidden = std::env::args().any(|a| a == "--hidden") || start_min;
    let num = |k: &str| bounds.get(k).and_then(Value::as_f64);
    let (w, h) = (num("width").unwrap_or(1200.0).max(640.0), num("height").unwrap_or(800.0).max(480.0));

    let mut builder = WindowBuilder::new(app, "main")
        .title("Pulso")
        .inner_size(w, h)
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .shadow(true)
        .visible(false)
        .theme(Some(tauri::Theme::Dark));
    builder = match (num("x"), num("y")) {
        (Some(x), Some(y)) => builder.position(x, y),
        _ => builder.center(),
    };
    builder = builder.icon(window_icon(app))?;
    let window = builder.build()?;

    let args = browser_args(gpu);
    let bar = bar_height(&theme);
    let shell = WebviewBuilder::new("shell", WebviewUrl::App("shell.html".into()))
        .initialization_script(SHELL_BRIDGE_JS)
        .additional_browser_args(&args);
    window.add_child(shell, LogicalPosition::new(0.0, 0.0), LogicalSize::new(w, bar))?;

    let baked = json!({ "theme": theme, "sound": sound, "lite": !gpu, "spellcheck": spellcheck, "maximized": maximized });
    let script = format!("{}\n;\n{}", BRIDGE_JS.replace("__PULSO_BAKED__", &baked.to_string()), PAGE_JS);
    let dl_app = app.clone();
    let wa = WebviewBuilder::new("wa", WebviewUrl::External(WHATSAPP_URL.parse().expect("url")))
        .initialization_script(&script)
        .additional_browser_args(&args)
        .zoom_hotkeys_enabled(false)
        .on_navigation(|url| {
            let ours = url.scheme() == "https" && url.host_str() == Some("web.whatsapp.com");
            if ours || matches!(url.scheme(), "about" | "blob" | "data") {
                return true;
            }
            system::open_external(url.as_str());
            false
        })
        .on_download(move |_webview, event| on_download(&dl_app, event));
    let wa = window.add_child(wa, LogicalPosition::new(0.0, bar), LogicalSize::new(w, h - bar))?;
    let _ = wa.set_zoom(zoom);

    let ev_app = app.clone();
    window.on_window_event(move |event| on_window_event(&ev_app, event));
    if maximized {
        let _ = window.maximize();
    }
    layout(app);
    if !hidden {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

fn on_window_event(app: &AppHandle, event: &WindowEvent) {
    match event {
        WindowEvent::Resized(_) => {
            layout(app);
            if let Some(w) = app.get_window("main") {
                let max = w.is_maximized().unwrap_or(false);
                shell_emit(app, "maximized", &[json!(max)]);
                page_eval(app, &format!("window.__pulsoMax = {max}"));
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            save_bounds(app);
            let to_tray = shared(app).settings.lock().unwrap().bool("closeToTray");
            if !shared(app).quitting.load(Ordering::Relaxed) && to_tray {
                api.prevent_close();
                if let Some(w) = app.get_window("main") {
                    let _ = w.hide();
                }
            } else {
                quit(app);
            }
        }
        WindowEvent::Focused(true) => {
            if let Some(w) = app.get_window("main") {
                let _ = w.request_user_attention(None);
            }
            if let Some(wa) = app.get_webview("wa") {
                let _ = wa.set_focus();
            }
        }
        _ => {}
    }
}

// Every download asks where to save it ("Guardar como") and says when it's done.
fn on_download(app: &AppHandle, event: DownloadEvent) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let name = destination.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "archivo".into());
            let mut dialog = rfd::FileDialog::new().set_title("Guardar como").set_file_name(&name);
            if let Some(dir) = destination.parent() {
                dialog = dialog.set_directory(dir);
            }
            match dialog.save_file() {
                Some(path) => {
                    *destination = path;
                    if let Some(w) = app.get_window("main") {
                        let _ = w.set_progress_bar(tauri::window::ProgressBarState {
                            status: Some(tauri::window::ProgressBarStatus::Indeterminate),
                            progress: None,
                        });
                    }
                    true
                }
                None => false,
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            if let Some(w) = app.get_window("main") {
                let _ = w.set_progress_bar(tauri::window::ProgressBarState { status: Some(tauri::window::ProgressBarStatus::None), progress: None });
            }
            if let (true, Some(file)) = (success, path) {
                let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                system::toast("Descarga completada", &name, false, move || system::show_in_folder(&file));
            }
            true
        }
        _ => true,
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let gpu = shared(app).settings.lock().unwrap().bool("hardwareAcceleration");
    let menu = MenuBuilder::new(app)
        .text("show", "Mostrar Pulso")
        .separator()
        .text("reload", "Recargar")
        .text("updates", "Buscar actualizaciones…")
        // Reachable even when the window shows nothing.
        .item(&CheckMenuItem::with_id(app, "gpu", "Aceleración por GPU", true, gpu, None::<&str>)?)
        .separator()
        .text("quit", "Salir")
        .build()?;
    TrayIconBuilder::with_id("tray")
        .icon(tray_icon(app, 0))
        .tooltip("Pulso")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "reload" => reload(app),
            "updates" => check_updates(app),
            "gpu" => {
                let on = !shared(app).settings.lock().unwrap().bool("hardwareAcceleration");
                set_graphics(app, on);
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn check_updates(app: &AppHandle) {
    show_window(app);
    let app = app.clone();
    std::thread::spawn(move || updater::check(&app, true));
}

fn set_graphics(app: &AppHandle, on: bool) {
    shared(app).settings.lock().unwrap().set("hardwareAcceleration", json!(on));
    save_bounds(app);
    shared(app).quitting.store(true, Ordering::Relaxed);
    app.restart();
}

fn apply_launch_at_login(app: &AppHandle) {
    let on = shared(app).settings.lock().unwrap().bool("launchAtLogin");
    system::set_launch_at_login(on);
}

// ---------- Commands called from the title bar and from WhatsApp's page ----------

#[tauri::command]
fn page_focus(app: AppHandle) {
    show_window(&app);
}

#[tauri::command]
fn page_notified(app: AppHandle) {
    flash(&app);
}

#[tauri::command]
fn notify(app: AppHandle, id: u64, title: String, body: String, silent: bool) {
    std::thread::spawn(move || {
        let click_app = app.clone();
        system::toast(&title, &body, silent, move || {
            show_window(&click_app);
            page_eval(&click_app, &format!("window.__pulsoNotificationClick && window.__pulsoNotificationClick({id})"));
        });
    });
}

#[tauri::command]
fn set_unread_count(app: AppHandle, count: u32) {
    set_unread(&app, count);
}

#[tauri::command]
fn update_state(app: AppHandle) -> Value {
    shared(&app).update.lock().unwrap().clone()
}

#[tauri::command]
fn update_action(app: AppHandle, action: String) {
    updater::action(&app, &action);
}

#[tauri::command]
fn options(app: AppHandle) -> Value {
    let s = shared(&app).settings.lock().unwrap();
    let toggles: serde_json::Map<String, Value> = TOGGLES.iter().map(|k| (k.to_string(), json!(s.bool(k)))).collect();
    json!({
        "version": app.package_info().version.to_string(),
        "gpu": s.bool("hardwareAcceleration"),
        "languages": SPELL_LANGS.iter().map(|(c, l)| json!([c, l])).collect::<Vec<_>>(),
        "activeLanguages": s.get("spellcheckLanguages"),
        "toggles": toggles,
    })
}

#[tauri::command]
fn set_option(app: AppHandle, key: String, value: bool) {
    if !TOGGLES.contains(&key.as_str()) {
        return;
    }
    shared(&app).settings.lock().unwrap().set(&key, json!(value));
    match key.as_str() {
        "launchAtLogin" => system::set_launch_at_login(value),
        "notificationSound" => reload(&app),
        _ => {}
    }
}

#[tauri::command]
fn set_gpu(app: AppHandle, on: bool) {
    set_graphics(&app, on);
}

#[tauri::command]
fn set_language(app: AppHandle, code: String, on: bool) {
    if !SPELL_LANGS.iter().any(|(c, _)| *c == code) {
        return;
    }
    let mut s = shared(&app).settings.lock().unwrap();
    let mut list: Vec<Value> = s.get("spellcheckLanguages").as_array().cloned().unwrap_or_default();
    list.retain(|c| c.as_str() != Some(code.as_str()));
    if on {
        list.push(json!(code));
    }
    s.set("spellcheckLanguages", Value::Array(list));
}

#[tauri::command]
fn page_action(app: AppHandle, name: String) {
    match name.as_str() {
        "checkUpdates" => check_updates(&app),
        "reload" => reload(&app),
        "clearCache" => page_eval(
            &app,
            "(async () => { try { for (const k of await caches.keys()) await caches.delete(k); \
             for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {} location.reload(); })()",
        ),
        "resetSession" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let yes = rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Warning)
                    .set_title("Cerrar sesión")
                    .set_description(
                        "Se borrarán todos los datos locales de WhatsApp Web en este equipo.\n\n\
                         Tendrás que escanear el código QR de nuevo. Tus chats siguen en tu teléfono.",
                    )
                    .set_buttons(rfd::MessageButtons::OkCancelCustom("Cerrar sesión".into(), "Cancelar".into()))
                    .show();
                if matches!(yes, rfd::MessageDialogResult::Custom(ref s) if s == "Cerrar sesión") {
                    if let Some(wa) = app.get_webview("wa") {
                        let _ = wa.clear_all_browsing_data();
                    }
                    reload(&app);
                }
            });
        }
        "about" => {
            let version = app.package_info().version.to_string();
            let webview = tauri::webview_version().unwrap_or_default();
            std::thread::spawn(move || {
                rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Info)
                    .set_title("Acerca de Pulso")
                    .set_description(format!(
                        "Pulso {version} (Rust)\n\nTu WhatsApp, en tu estilo. Cliente de escritorio no oficial para Windows \
                         que ejecuta WhatsApp Web.\nNo está afiliado a WhatsApp ni a Meta.\n\nRust · Tauri · WebView2 {webview}"
                    ))
                    .show();
            });
        }
        "help" => system::open_external("https://faq.whatsapp.com/"),
        "quit" => quit(&app),
        _ => {}
    }
}

// The title bar takes the theme's surface color, so it reads as part of the interface.
#[tauri::command]
fn save_theme(app: AppHandle, id: String, color: String) {
    let id_ok = !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_lowercase());
    if !id_ok || icons::hex(&color).is_none() {
        return;
    }
    {
        let mut s = shared(&app).settings.lock().unwrap();
        s.set("theme", json!(id));
        s.set("barColor", json!(color));
    }
    shell_emit(&app, "look", &[json!(color), json!(id)]);
    layout(&app);
}

#[tauri::command]
fn icon_info_cmd(app: AppHandle) -> Value {
    icon_info(&app)
}

#[tauri::command]
fn save_icon(app: AppHandle, json: String) {
    let Ok(c) = serde_json::from_str::<Value>(&json) else { return };
    let (Some(from), Some(to)) = (c["from"].as_str(), c["to"].as_str()) else { return };
    if icons::hex(from).is_none() || icons::hex(to).is_none() {
        return;
    }
    let angle = c["angle"].as_f64().map(|a| (a.round() as i64 % 361) as f64).unwrap_or(135.0);
    shared(&app).settings.lock().unwrap().set(
        "icon",
        json!({ "kind": "color", "from": from, "to": to, "angle": angle, "gradient": c["gradient"].as_bool().unwrap_or(false) }),
    );
    apply_icon(&app);
}

#[tauri::command]
fn save_icon_file(app: AppHandle, base64: String) -> Value {
    use base64::Engine;
    if base64.len() > 6_000_000 {
        return Value::Null;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64.trim()) else { return Value::Null };
    // ICONDIR header: reserved 0, type 1 (icon), at least one image.
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    if bytes.len() < 22 || u16_at(0) != 0 || u16_at(2) != 1 || u16_at(4) < 1 || Image::from_bytes(&bytes).is_err() {
        return Value::Null;
    }
    if std::fs::write(custom_ico_file(&app), &bytes).is_err() {
        return Value::Null;
    }
    shared(&app).settings.lock().unwrap().set("icon", json!({ "kind": "ico" }));
    apply_icon(&app);
    icon_info(&app)
}

#[tauri::command]
fn open_external(url: String) {
    system::open_external(&url);
}

#[tauri::command]
fn zoom(app: AppHandle, delta: f64) {
    set_zoom(&app, delta);
}

#[tauri::command]
fn toggle_fullscreen(app: AppHandle) {
    if let Some(w) = app.get_window("main") {
        let full = w.is_fullscreen().unwrap_or(false);
        let _ = w.set_fullscreen(!full);
        layout(&app);
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit(&app);
}

#[tauri::command]
fn devtools(app: AppHandle) {
    if let Some(wa) = app.get_webview("wa") {
        wa.open_devtools();
    }
}

#[tauri::command]
fn shell_state(app: AppHandle) -> Value {
    let (color, theme) = {
        let s = shared(&app).settings.lock().unwrap();
        (s.str("barColor"), s.str("theme"))
    };
    let maximized = app.get_window("main").and_then(|w| w.is_maximized().ok()).unwrap_or(false);
    json!({
        "unread": shared(&app).unread.load(Ordering::Relaxed),
        "color": color,
        "theme": theme,
        "maximized": maximized,
        "icon": icon_info(&app),
    })
}

#[tauri::command]
fn shell_control(app: AppHandle, action: String) {
    let Some(w) = app.get_window("main") else { return };
    match action.as_str() {
        "minimize" => {
            let _ = w.minimize();
        }
        "maximize" => {
            if w.is_maximized().unwrap_or(false) {
                let _ = w.unmaximize();
            } else {
                let _ = w.maximize();
            }
        }
        "close" => {
            let _ = w.close();
        }
        _ => {}
    }
}

#[tauri::command]
fn start_drag(app: AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.start_dragging();
    }
}

#[tauri::command]
fn start_resize(app: AppHandle, dir: String) {
    use tauri_runtime::ResizeDirection as D;
    let d = match dir.as_str() {
        "North" => D::North,
        "South" => D::South,
        "East" => D::East,
        "West" => D::West,
        "NorthEast" => D::NorthEast,
        "NorthWest" => D::NorthWest,
        "SouthEast" => D::SouthEast,
        "SouthWest" => D::SouthWest,
        _ => return,
    };
    if let Some(w) = app.get_window("main") {
        let _ = w.start_resize_dragging(d);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .invoke_handler(tauri::generate_handler![
            page_focus,
            page_notified,
            notify,
            set_unread_count,
            update_state,
            update_action,
            options,
            set_option,
            set_gpu,
            set_language,
            page_action,
            save_theme,
            icon_info_cmd,
            save_icon,
            save_icon_file,
            open_external,
            zoom,
            toggle_fullscreen,
            hide_window,
            quit_app,
            devtools,
            shell_state,
            shell_control,
            start_drag,
            start_resize,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_config_dir()?;
            let _ = std::fs::create_dir_all(&data_dir);
            app.manage(Shared {
                settings: Mutex::new(settings::Settings::load(&data_dir)),
                data_dir: data_dir.clone(),
                unread: AtomicU32::new(0),
                quitting: AtomicBool::new(false),
                update: Mutex::new(json!({ "kind": "hidden" })),
                dismissed: Mutex::new(None),
                pending: Mutex::new(None),
            });
            let icon_png = data_dir.join("notification-icon.png");
            let _ = std::fs::write(&icon_png, icons::png(64, &look(&handle).mark_rgba(64)));
            system::register_app_id(&icon_png);
            create_window(&handle)?;
            create_tray(&handle)?;
            apply_launch_at_login(&handle);
            updater::start(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Pulso")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Closing the window to the tray must not end the app.
                if code.is_none() && !shared(app).quitting.load(Ordering::Relaxed) {
                    api.prevent_exit();
                }
            }
        });
}
