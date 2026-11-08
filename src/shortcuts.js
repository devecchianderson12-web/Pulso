// Points Pulso's Windows shortcuts (desktop, Start menu, pinned to the taskbar) at the chosen
// icon. Only shortcuts that launch this Pulso are touched, and only their icon changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app, shell } = require('electron');

const FOLDERS = () => {
  const appData = app.getPath('appData');
  return [
    app.getPath('desktop'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch'),
  ];
};

// The portable build runs from a temporary copy; its shortcuts point at the real .exe.
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

// Each icon gets its own file name: Windows caches icons by path, so a new name shows at once.
function writeIconFile(buffer) {
  const dir = path.join(app.getPath('userData'), 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const name = `pulso-${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12)}.ico`;
  for (const old of fs.readdirSync(dir)) if (old !== name) fs.rm(path.join(dir, old), { force: true }, () => {});
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  return file;
}

function shortcutsFor(target, folders) {
  const found = [];
  for (const dir of folders) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      const file = path.join(dir, name);
      try {
        const link = shell.readShortcutLink(file);
        if (link.target && path.resolve(link.target).toLowerCase() === path.resolve(target).toLowerCase()) found.push([file, link]);
      } catch { /* not readable */ }
    }
  }
  return found;
}

// `icoBuffer` null means the original icon, which lives inside the .exe.
function sync(icoBuffer, { folders = FOLDERS(), target = exePath() } = {}) {
  const icon = icoBuffer ? writeIconFile(icoBuffer) : target;
  let changed = 0;
  for (const [file, link] of shortcutsFor(target, folders)) {
    if (link.icon && path.resolve(link.icon).toLowerCase() === icon.toLowerCase() && (link.iconIndex || 0) === 0) continue;
    if (shell.writeShortcutLink(file, 'update', { icon, iconIndex: 0 })) changed++;
  }
  // Asks Explorer to redraw icons now instead of at the next sign-in.
  if (changed && process.platform === 'win32') {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe'), ['-show'], () => {});
  }
  return changed;
}

module.exports = { sync };
