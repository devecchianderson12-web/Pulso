// Checks GitHub Releases for new versions. A found update shows as a banner at the bottom of
// the chat list (inside WhatsApp Web); the rounded popup covers manual checks and errors.
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/devecchianderson12-web/Pulso/releases/latest';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
// electron-updater cannot replace the portable build, so it gets the download page.
const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

let parent;
let page; // WhatsApp Web's webContents, which hosts the banner.
let popup;
let state = { kind: 'idle' };
let manual = false;
let beforeInstall = () => {};

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

const BANNER_STATES = ['available', 'progress', 'installing', 'hidden'];

function send(next) {
  state = next;
  if (popup && !popup.isDestroyed()) popup.webContents.send('update:state', state);
  if (BANNER_STATES.includes(state.kind) && page && !page.isDestroyed()) page.send('pulso:update-state', state);
}

function hideBanner() {
  if (page && !page.isDestroyed()) page.send('pulso:update-state', { kind: 'hidden' });
}

function openPopup() {
  if (popup && !popup.isDestroyed()) {
    popup.show();
    popup.focus();
    return;
  }
  const width = 420;
  const height = 260;
  const area = parent && !parent.isDestroyed() && parent.isVisible()
    ? parent.getBounds()
    : screen.getPrimaryDisplay().workArea;
  popup = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    parent: parent && parent.isVisible() ? parent : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: !parent || !parent.isVisible(),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popup.loadFile(path.join(__dirname, 'update.html'));
  popup.once('ready-to-show', () => popup.show());
  popup.on('closed', () => { popup = null; });
}

function closePopup() {
  if (popup && !popup.isDestroyed()) popup.webContents.send('update:close');
}

autoUpdater.on('checking-for-update', () => {
  if (manual) send({ kind: 'checking' });
});
autoUpdater.on('update-available', (info) => {
  // Once dismissed with "Más tarde", automatic checks stay quiet until the next launch.
  if (dismissed === info.version && !manual) return;
  closePopup();
  send({ kind: 'available', version: info.version, current: app.getVersion(), portable: PORTABLE });
});
autoUpdater.on('update-not-available', () => {
  if (manual) send({ kind: 'none', current: app.getVersion() });
});
autoUpdater.on('download-progress', (p) => send({ kind: 'progress', percent: p.percent }));
autoUpdater.on('update-downloaded', (info) => {
  send({ kind: 'installing', version: info.version });
  setTimeout(() => {
    beforeInstall();
    autoUpdater.quitAndInstall(true, true);
  }, 900);
});
function friendlyError(err) {
  const text = String((err && err.message) || err);
  if (/404|latest\.yml|No published versions/i.test(text)) return 'Todavía no hay ninguna actualización publicada.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(text)) return 'No hay conexión con el servidor de actualizaciones.';
  return text.split('\n')[0].slice(0, 140);
}

autoUpdater.on('error', (err) => {
  console.error('Actualización:', err);
  if (manual || state.kind === 'progress') {
    hideBanner();
    send({ kind: 'error', message: friendlyError(err) });
    openPopup();
  }
});

let dismissed = null;

ipcMain.handle('update:get', () => state);
ipcMain.on('update:action', (event, action) => {
  if (action === 'update') {
    if (state.kind !== 'available') return;
    if (state.portable) {
      shell.openExternal(RELEASES_URL);
      send({ kind: 'hidden' });
      return;
    }
    send({ kind: 'progress', percent: 0 });
    autoUpdater.downloadUpdate().catch(() => {});
  } else if (action === 'later') {
    if (state.kind === 'available') dismissed = state.version;
    send({ kind: 'hidden' });
  } else if (action === 'retry') {
    check(true);
  } else if (action === 'close') {
    closePopup();
  }
});
ipcMain.on('update:closed', () => {
  if (popup && !popup.isDestroyed()) popup.close();
});

function check(isManual) {
  manual = isManual;
  if (!app.isPackaged && !process.env.PULSO_DEV_UPDATES) {
    if (isManual) {
      send({ kind: 'error', message: 'Las actualizaciones solo funcionan en la versión instalada.' });
      openPopup();
    }
    return;
  }
  if (isManual) {
    send({ kind: 'checking' });
    openPopup();
  }
  autoUpdater.checkForUpdates().catch(() => {});
}

function init(win, waContents, onBeforeInstall) {
  parent = win;
  page = waContents;
  beforeInstall = onBeforeInstall;
  if (process.env.PULSO_DEV_UPDATES) autoUpdater.forceDevUpdateConfig = true;
  setTimeout(() => check(false), 8000);
  setInterval(() => check(false), CHECK_INTERVAL);
}

module.exports = { init, check };
