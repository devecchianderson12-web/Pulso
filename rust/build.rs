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
    tauri_build::build();
}
