// The title bar is the same shell.html the Electron build uses. Tauri serves it from dist/, so it's
// copied there on every build (without its Content-Security-Policy tag, which would block Tauri's IPC).
fn main() {
    let html = std::fs::read_to_string("../src/shell.html").expect("../src/shell.html");
    let html: Vec<&str> = html.lines().filter(|l| !l.contains("Content-Security-Policy")).collect();
    std::fs::create_dir_all("dist").expect("dist");
    std::fs::write("dist/shell.html", html.join("\n")).expect("dist/shell.html");
    println!("cargo:rerun-if-changed=../src/shell.html");
    println!("cargo:rerun-if-changed=../src/page.js");
    println!("cargo:rerun-if-changed=src/bridge.js");
    println!("cargo:rerun-if-changed=src/shell-bridge.js");
    // WhatsApp Web is a remote page: Tauri only lets it call commands that are listed here and
    // granted in capabilities/default.json.
    let commands = [
        "page_focus",
        "page_notified",
        "notify",
        "set_unread_count",
        "update_state",
        "update_action",
        "options",
        "set_option",
        "set_gpu",
        "set_language",
        "page_action",
        "save_theme",
        "icon_info_cmd",
        "save_icon",
        "save_icon_file",
        "open_external",
        "zoom",
        "toggle_fullscreen",
        "hide_window",
        "quit_app",
        "devtools",
        "shell_state",
        "shell_control",
        "start_drag",
        "start_resize",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&commands)))
        .expect("tauri build");
}
