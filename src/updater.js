// Checks for new versions (updates/latest.yml in the repository). All states show in the
// banner at the bottom of the chat list, drawn by page.js.
const { app, ipcMain, shell } = require('electron');

const RELEASES_URL = 'https://github.com/devecchianderson12-web/Pulso/releases/latest';
const FIRST_CHECK = 8000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
// electron-updater cannot replace the portable build, so it gets the download page.
const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

let page; // WhatsApp Web's webContents, which hosts the banner.
let beforeInstall;
let state = { kind: 'hidden' };
let manual = false;
let dismissed = null;
let updater;

function send(next) {
  state = next;
  if (!page.isDestroyed()) page.send('pulso:update-state', state);
}

function friendlyError(err) {
  const text = String((err && err.message) || err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(text)) return 'No hay conexión con el servidor de actualizaciones.';
  return text.split('\n')[0].slice(0, 140);
}

// Loaded on first use: it isn't needed for startup and pulls in several modules.
function getUpdater() {
  if (updater) return updater;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  if (process.env.PULSO_DEV_UPDATES) updater.forceDevUpdateConfig = true;

  updater.on('update-available', (info) => {
    // Once dismissed with "Más tarde", automatic checks stay quiet until the next launch.
    if (dismissed === info.version && !manual) return;
    send({ kind: 'available', version: info.version, current: app.getVersion(), portable: PORTABLE });
  });
  updater.on('update-not-available', () => {
    if (manual) send({ kind: 'none', current: app.getVersion() });
  });
  updater.on('download-progress', (p) => send({ kind: 'progress', percent: p.percent }));
  updater.on('update-downloaded', (info) => {
    send({ kind: 'installing', version: info.version });
    setTimeout(() => {
      beforeInstall();
      updater.quitAndInstall(true, true);
    }, 900);
  });
  updater.on('error', (err) => {
    console.error('Actualización:', err);
    if (manual || state.kind === 'progress') send({ kind: 'error', message: friendlyError(err) });
  });
  return updater;
}

function check(isManual) {
  manual = isManual;
  if (!app.isPackaged && !process.env.PULSO_DEV_UPDATES) {
    if (isManual) send({ kind: 'error', message: 'Las actualizaciones solo funcionan en la versión instalada.' });
    return;
  }
  if (isManual) send({ kind: 'checking' });
  getUpdater().checkForUpdates().catch(() => {});
}

ipcMain.handle('update:get', () => state);
ipcMain.on('update:action', (event, action) => {
  if (action === 'update' && state.kind === 'available') {
    if (state.portable) {
      shell.openExternal(RELEASES_URL);
      send({ kind: 'hidden' });
      return;
    }
    send({ kind: 'progress', percent: 0 });
    getUpdater().downloadUpdate().catch(() => {});
  } else if (action === 'later') {
    if (state.kind === 'available') dismissed = state.version;
    send({ kind: 'hidden' });
  } else if (action === 'retry') {
    check(true);
  } else if (action === 'close') {
    send({ kind: 'hidden' });
  }
});

function init(waContents, onBeforeInstall) {
  page = waContents;
  beforeInstall = onBeforeInstall;
  setTimeout(() => check(false), FIRST_CHECK);
  setInterval(() => check(false), CHECK_INTERVAL);
}

module.exports = { init, check };
