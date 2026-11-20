// Looks for newer "-rust" builds in the GitHub releases. Every state shows in the banner at the
// bottom of the chat list, drawn by page.js. Installing replaces this build in place and reopens
// it: the installed copy reinstalls silently, the portable .exe is swapped for the new one.
use crate::{page_eval, Shared};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const RELEASES_API: &str = "https://api.github.com/repos/devecchianderson12-web/Pulso/releases?per_page=20";
const NO_WINDOW: u32 = 0x0800_0000;

fn version_of(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// The installed copy sits next to the uninstaller the installer leaves.
pub fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| !d.join("uninstall.exe").exists()))
        .unwrap_or(true)
}

fn send(app: &AppHandle, state: Value) {
    let shared = app.state::<Shared>();
    *shared.update.lock().unwrap() = state.clone();
    let detail = serde_json::to_string(&state.to_string()).unwrap_or_default();
    page_eval(app, &format!("window.dispatchEvent(new CustomEvent('pulso-update', {{ detail: {detail} }}))"));
}

fn current(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

struct Found {
    version: String,
    url: String,
    name: String,
}

fn find_latest(portable: bool) -> Result<Option<Found>, String> {
    let prefix = if portable { "Pulso-Portable-" } else { "Pulso-Setup-" };
    let body: Value = ureq::get(RELEASES_API)
        .set("User-Agent", "Pulso-Rust")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    let mut best: Option<((u64, u64, u64), Found)> = None;
    for release in body.as_array().into_iter().flatten() {
        if release["draft"].as_bool() == Some(true) || release["prerelease"].as_bool() == Some(true) {
            continue;
        }
        for asset in release["assets"].as_array().into_iter().flatten() {
            let name = asset["name"].as_str().unwrap_or_default();
            let Some(ver) = name.strip_prefix(prefix).and_then(|r| r.strip_suffix("-rust.exe")) else { continue };
            let Some(v) = version_of(ver) else { continue };
            if best.as_ref().map_or(true, |(b, _)| v > *b) {
                let url = asset["browser_download_url"].as_str().unwrap_or_default().to_string();
                best = Some((v, Found { version: ver.to_string(), url, name: name.to_string() }));
            }
        }
    }
    Ok(best.map(|(_, f)| f))
}

fn friendly(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") || lower.contains("network") {
        return "No hay conexión con el servidor de actualizaciones.".into();
    }
    err.lines().next().unwrap_or_default().chars().take(140).collect()
}

pub fn check(app: &AppHandle, manual: bool) {
    if manual {
        send(app, json!({ "kind": "checking" }));
    }
    let cur = current(app);
    match find_latest(is_portable()) {
        Ok(Some(found)) if version_of(&found.version) > version_of(&cur) => {
            let shared = app.state::<Shared>();
            let dismissed = shared.dismissed.lock().unwrap().clone();
            // Once dismissed with "Más tarde", automatic checks stay quiet until the next launch.
            if !manual && dismissed.as_deref() == Some(found.version.as_str()) {
                return;
            }
            *shared.pending.lock().unwrap() = Some((found.url.clone(), found.name.clone()));
            send(app, json!({ "kind": "available", "version": found.version, "current": cur, "portable": false }));
        }
        Ok(_) => {
            if manual {
                send(app, json!({ "kind": "none", "current": cur }));
            }
        }
        Err(e) => {
            if manual {
                send(app, json!({ "kind": "error", "message": friendly(&e) }));
            }
        }
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        loop {
            check(&app, false);
            std::thread::sleep(Duration::from_secs(4 * 60 * 60));
        }
    });
}

pub fn action(app: &AppHandle, action: &str) {
    let shared = app.state::<Shared>();
    let state = shared.update.lock().unwrap().clone();
    let kind = state["kind"].as_str().unwrap_or_default().to_string();
    match action {
        "update" if kind == "available" => {
            let Some((url, name)) = shared.pending.lock().unwrap().clone() else { return };
            let version = state["version"].as_str().unwrap_or_default().to_string();
            let app = app.clone();
            send(&app, json!({ "kind": "progress", "percent": 0 }));
            std::thread::spawn(move || match download(&app, &url, &name) {
                Ok(file) => {
                    send(&app, json!({ "kind": "installing", "version": version }));
                    std::thread::sleep(Duration::from_millis(900));
                    if let Err(e) = install(&file) {
                        send(&app, json!({ "kind": "error", "message": friendly(&e) }));
                        return;
                    }
                    crate::quit(&app);
                }
                Err(e) => send(&app, json!({ "kind": "error", "message": friendly(&e) })),
            });
        }
        "later" => {
            if kind == "available" {
                *shared.dismissed.lock().unwrap() = state["version"].as_str().map(String::from);
            }
            send(app, json!({ "kind": "hidden" }));
        }
        "retry" => {
            let app = app.clone();
            std::thread::spawn(move || check(&app, true));
        }
        "close" => send(app, json!({ "kind": "hidden" })),
        _ => {}
    }
}

fn download(app: &AppHandle, url: &str, name: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("pulso-rust-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(name);
    let resp = ureq::get(url).set("User-Agent", "Pulso-Rust").call().map_err(|e| e.to_string())?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&file).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let (mut got, mut last) = (0u64, 0u64);
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        if total > 0 && (got - last) * 50 >= total {
            last = got;
            send(app, json!({ "kind": "progress", "percent": got as f64 * 100.0 / total as f64 }));
        }
    }
    if total > 0 && got < total {
        return Err("La descarga quedó incompleta.".into());
    }
    Ok(file)
}

fn ps_quote(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', "''"))
}

// A hidden PowerShell waits for Pulso to close, puts the new version in place, removes the
// downloaded file and opens Pulso again: nothing of the old version is left behind.
fn install(file: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let script = if is_portable() {
        let dir = exe.parent().ok_or("sin carpeta")?;
        let target = dir.join(file.file_name().ok_or("sin nombre")?);
        format!(
            "Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; \
             Remove-Item -LiteralPath {old} -Force -ErrorAction SilentlyContinue; \
             Move-Item -LiteralPath {new} -Destination {target} -Force; \
             Remove-Item -LiteralPath {tmp} -Recurse -Force -ErrorAction SilentlyContinue; \
             Start-Process -FilePath {target}",
            old = ps_quote(&exe),
            new = ps_quote(file),
            target = ps_quote(&target),
            tmp = ps_quote(file.parent().unwrap_or(file)),
        )
    } else {
        format!(
            "Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; \
             Start-Process -FilePath {setup} -ArgumentList '/S' -Wait; \
             Remove-Item -LiteralPath {tmp} -Recurse -Force -ErrorAction SilentlyContinue; \
             Start-Process -FilePath {exe}",
            setup = ps_quote(file),
            tmp = ps_quote(file.parent().unwrap_or(file)),
            exe = ps_quote(&exe),
        )
    };
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
