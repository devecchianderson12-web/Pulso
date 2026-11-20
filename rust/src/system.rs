// Windows integration: notifications, links, start with Windows and shortcut icons.
use std::os::windows::process::CommandExt;
use std::path::Path;
use tauri_winrt_notification::{Duration, Sound, Toast};

pub const AUMID: &str = "com.pulso.rust";
const NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "Pulso Rust";

// Links that try to send the user to install another WhatsApp app.
fn is_promo(url: &str) -> bool {
    let u = url.to_lowercase();
    ["whatsapp.com/download", "apps.microsoft.com", "get.microsoft.com", "ms-windows-store:", "apps.apple.com", "play.google.com"]
        .iter()
        .any(|p| u.contains(p))
}

pub fn open_external(url: &str) {
    if is_promo(url) {
        return;
    }
    let ok = ["http://", "https://", "mailto:", "tel:"].iter().any(|p| url.to_lowercase().starts_with(p));
    if ok {
        let _ = open::that_detached(url);
    }
}

pub fn show_in_folder(file: &Path) {
    let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}", file.display())).spawn();
}

/// Registers the app id so Windows shows its notifications, even for the portable .exe.
pub fn register_app_id(icon_png: &Path) {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    if let Ok((key, _)) = hkcu.create_subkey(format!(r"Software\Classes\AppUserModelId\{AUMID}")) {
        let _ = key.set_value("DisplayName", &"Pulso");
        let _ = key.set_value("IconUri", &icon_png.display().to_string());
    }
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!("com.pulso.rust"));
    }
}

/// A Windows notification. `on_click` runs when the user clicks it.
pub fn toast(title: &str, body: &str, silent: bool, on_click: impl FnMut() + Send + 'static) {
    let mut on_click = on_click;
    let result = Toast::new(AUMID)
        .title(title)
        .text1(body)
        .sound(if silent { None } else { Some(Sound::Default) })
        .duration(Duration::Short)
        .on_activated(move |_| {
            on_click();
            Ok(())
        })
        .show();
    if let Err(e) = result {
        eprintln!("Notificación: {e:?}");
    }
}

pub fn set_launch_at_login(on: bool) {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey(RUN_KEY) else { return };
    if on {
        if let Ok(exe) = std::env::current_exe() {
            let _ = key.set_value(RUN_NAME, &format!("\"{}\" --hidden", exe.display()));
        }
    } else {
        let _ = key.delete_value(RUN_NAME);
    }
}

/// Points the desktop, Start menu and taskbar shortcuts that open this Pulso at `icon`
/// (the .exe itself for the original icon). Only their icon changes.
pub fn sync_shortcuts(icon: &Path) {
    let Ok(exe) = std::env::current_exe() else { return };
    let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "''"));
    let script = format!(
        "$sh = New-Object -ComObject WScript.Shell; $changed = 0; \
         $dirs = @([Environment]::GetFolderPath('Desktop'), \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\", \
           \"$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\", \"$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\"); \
         foreach ($d in $dirs) {{ Get-ChildItem -LiteralPath $d -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {{ \
           $l = $sh.CreateShortcut($_.FullName); \
           if ($l.TargetPath -ieq {exe} -and $l.IconLocation -ne ({icon} + ',0')) {{ $l.IconLocation = {icon} + ',0'; $l.Save(); $changed++ }} }} }}; \
         if ($changed) {{ & \"$env:SystemRoot\\System32\\ie4uinit.exe\" -show }}",
        exe = q(&exe),
        icon = q(icon),
    );
    let _ = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(NO_WINDOW)
        .spawn();
}
