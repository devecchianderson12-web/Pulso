const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, WebContentsView, Tray, Menu, nativeTheme, shell, session,
  ipcMain, Notification, dialog, clipboard, desktopCapturer,
} = require('electron');
const settings = require('./settings');
const icons = require('./icons');
const updater = require('./updater');

const APP_NAME = 'Pulso';
const TITLE_BAR_HEIGHT = 40;
const LUNA_BAR_HEIGHT = 30; // the height of a classic title bar
const WHATSAPP_URL = 'https://web.whatsapp.com/';
const WHATSAPP_ORIGIN = 'https://web.whatsapp.com';
const PARTITION = 'persist:whatsapp';
// WhatsApp Web rejects unknown browsers, so present as desktop Chrome of the bundled Chromium version.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
const ALLOWED_PERMISSIONS = new Set([
  'notifications', 'media', 'mediaKeySystem', 'clipboard-read',
  'clipboard-sanitized-write', 'fullscreen', 'display-capture',
]);
// Links that try to send the user to install another WhatsApp app.
const PROMO_LINK =
  /whatsapp\.com\/download|apps\.microsoft\.com|get\.microsoft\.com|ms-windows-store:|apps\.apple\.com|play\.google\.com/i;
// page.js runs inside WhatsApp Web; the sandboxed preload receives it from here.
const PAGE_CODE = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');

let win;
let wa; // WhatsApp Web's webContents, shown below the title bar.
let tray;
let layout; // Fits WhatsApp's view below the title bar.
let quitting = false;
let unread = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  setUpGraphics();
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
}

function setUpGraphics() {
  // Still marked from the previous launch: it never finished loading, so start without the GPU.
  if (settings.get('gpuBooting')) settings.set('hardwareAcceleration', false);
  if (settings.get('hardwareAcceleration')) {
    settings.set('gpuBooting', true);
    // Draw on the GPU inside the main process. As a separate process, NVIDIA's driver treats it
    // as a background app and caps it (20 fps) when "background application max frame rate" is on.
    // Electron 38+ never presents the window to the screen with this switch: stay on Electron 37.
    app.commandLine.appendSwitch('in-process-gpu');
  } else {
    app.disableHardwareAcceleration();
  }
  // Keeps messages and notifications arriving while Pulso sits in the tray.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  // Edge's wheel scrolling: percent-based steps and a smoother curve, closer to a phone's feel.
  app.commandLine.appendSwitch('enable-features', 'WindowsScrollingPersonality,PercentBasedScrolling');
}

// Without a real GPU every pixel is drawn by the CPU: page.js then drops its costliest effects.
async function detectSoftwareRendering() {
  let software = !settings.get('hardwareAcceleration');
  try {
    const status = app.getGPUFeatureStatus();
    const { gpuDevice = [] } = await app.getGPUInfo('basic');
    const active = gpuDevice.find((d) => d.active);
    software = software || /^disabled/.test(status.gpu_compositing) ||
      /swiftshader|basic render/i.test((active && active.deviceString) || '');
  } catch {
    // Keep what the settings say.
  }
  settings.set('lite', software);
  if (!wa.isDestroyed()) wa.send('pulso:lite', software);
}

function relaunch() {
  quitting = true;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE; // portable: the real .exe, not the temp folder
  const args = process.argv.slice(1).filter((a) => a !== '--hidden');
  app.relaunch(exe ? { execPath: exe, args } : { args });
  app.exit(0);
}

app.setAppUserModelId('com.pulso.windows');
// Pulso's look is dark; WhatsApp Web follows it when its theme is "system default".
nativeTheme.themeSource = 'dark';

function start() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(USER_AGENT);
  ses.setSpellCheckerLanguages(settings.get('spellcheckLanguages'));
  ses.setSpellCheckerEnabled(settings.get('spellcheck'));
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isWhatsApp(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    ALLOWED_PERMISSIONS.has(permission) &&
    (isWhatsApp(origin) || isWhatsApp(details.requestingUrl || details.securityOrigin)));
  // Screen sharing during calls: share the primary screen.
  ses.setDisplayMediaRequestHandler(async (request, cb) => {
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
    cb(screen ? { video: screen } : {});
  });
  ses.on('will-download', onDownload);

  createWindow();
  createTray();
  buildMenu();
  applyLaunchAtLogin();
  updater.init(wa, () => { quitting = true; });
}

function isWhatsApp(url) {
  try {
    return new URL(url).origin === WHATSAPP_ORIGIN;
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (PROMO_LINK.test(url)) return;
  try {
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(url).protocol)) {
      shell.openExternal(url);
    }
  } catch {
    // Ignore malformed URLs.
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...settings.get('bounds'),
    minWidth: 640,
    minHeight: 480,
    title: APP_NAME,
    icon: icons.windowIcon(),
    backgroundColor: settings.get('barColor'),
    show: false,
    titleBarStyle: 'hidden', // shell.html draws the bar and its buttons, so themes can restyle them
    webPreferences: { preload: path.join(__dirname, 'shell-preload.js') },
  });
  win.loadFile(path.join(__dirname, 'shell.html'));
  win.webContents.once('did-finish-load', () => settings.set('gpuBooting', false));

  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: true,
      backgroundThrottling: false,
      // Keeps WhatsApp's compiled code on disk: less work and fewer stalls after the first run.
      v8CacheOptions: 'bypassHeatCheck',
    },
  });
  view.setBackgroundColor(settings.get('barColor'));
  win.contentView.addChildView(view);
  wa = view.webContents;
  layout = () => {
    const [width, height] = win.getContentSize();
    const bar = settings.get('theme') === 'luna' ? LUNA_BAR_HEIGHT : TITLE_BAR_HEIGHT;
    const top = win.isFullScreen() ? 0 : bar;
    view.setBounds({ x: 0, y: top, width, height: height - top });
  };
  layout();
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.on('maximize', () => win.webContents.send('shell:maximized', true));
  win.on('unmaximize', () => win.webContents.send('shell:maximized', false));

  if (settings.get('maximized')) win.maximize();
  const hidden = process.argv.includes('--hidden') || settings.get('startMinimized');
  win.once('ready-to-show', () => {
    if (!hidden) showWindow();
  });

  wa.setZoomFactor(settings.get('zoomFactor'));
  wa.loadURL(WHATSAPP_URL, { userAgent: USER_AGENT });

  wa.setWindowOpenHandler(({ url }) => {
    if (!isWhatsApp(url)) openExternal(url);
    return { action: 'deny' };
  });
  wa.on('will-navigate', (event, url) => {
    if (!isWhatsApp(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  wa.on('page-title-updated', (event, title) => {
    const match = /^\((\d+)\)/.exec(title);
    setUnread(match ? Number(match[1]) : 0);
  });
  // Run after the page has painted: before the GPU starts, its status reads "disabled".
  wa.once('did-finish-load', () => setTimeout(detectSoftwareRendering, 1500));
  wa.on('context-menu', (event, params) => showContextMenu(params));
  wa.on('render-process-gone', (event, details) => {
    if (details.reason !== 'clean-exit') wa.reload();
  });

  win.on('close', (event) => {
    saveBounds();
    if (!quitting && settings.get('closeToTray')) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('focus', () => {
    win.flashFrame(false);
    wa.focus();
  });
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  settings.set('maximized', win.isMaximized());
  if (!win.isMaximized() && !win.isMinimized()) settings.set('bounds', win.getBounds());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  saveBounds();
});
app.on('window-all-closed', () => app.quit());

function setUnread(count) {
  if (count === unread) return;
  const grew = count > unread;
  unread = count;
  tray.setImage(icons.trayIcon(count));
  tray.setToolTip(count ? `${APP_NAME} — ${count} sin leer` : APP_NAME);
  win.setOverlayIcon(count ? icons.overlayIcon(count) : null, count ? `${count} mensajes sin leer` : '');
  win.setTitle(count ? `(${icons.badgeLabel(count)}) ${APP_NAME}` : APP_NAME);
  win.webContents.send('shell:unread', count);
  if (grew) flash();
}

function flash() {
  if (settings.get('flashOnMessage') && !win.isFocused()) win.flashFrame(true);
}

ipcMain.on('pulso:focus', showWindow);
ipcMain.on('pulso:notified', flash);
ipcMain.on('pulso:page', (event) => {
  event.returnValue = {
    code: PAGE_CODE,
    sound: settings.get('notificationSound'),
    lite: settings.get('lite'),
    theme: settings.get('theme'),
  };
});
ipcMain.handle('shell:state', () => ({
  unread,
  color: settings.get('barColor'),
  theme: settings.get('theme'),
  maximized: win.isMaximized(),
}));
ipcMain.on('shell:control', (event, action) => {
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

// Options shown in the Pulso panel inside WhatsApp Web. That page is remote content, so only
// these exact keys and actions can be reached from it.
const OPTION_EFFECTS = {
  closeToTray: null,
  launchAtLogin: applyLaunchAtLogin,
  startMinimized: null,
  notificationSound: () => wa.reload(),
  flashOnMessage: null,
  spellcheck: (on) => session.fromPartition(PARTITION).setSpellCheckerEnabled(on),
};
const ACTIONS = {
  checkUpdates: checkForUpdates,
  reload: () => wa.reload(),
  clearCache,
  resetSession,
  about: showAbout,
  help: () => openExternal('https://faq.whatsapp.com/'),
  quit,
};
ipcMain.handle('pulso:options', () => ({
  version: app.getVersion(),
  gpu: settings.get('hardwareAcceleration'),
  languages: SPELL_LANGS,
  activeLanguages: settings.get('spellcheckLanguages'),
  toggles: Object.fromEntries(Object.keys(OPTION_EFFECTS).map((k) => [k, settings.get(k)])),
}));
ipcMain.on('pulso:set', (event, key, value) => {
  if (!(key in OPTION_EFFECTS)) return;
  settings.set(key, Boolean(value));
  if (OPTION_EFFECTS[key]) OPTION_EFFECTS[key](Boolean(value));
});
ipcMain.on('pulso:gpu', (event, on) => setGraphics(Boolean(on)));
ipcMain.on('pulso:language', (event, code, on) => {
  if (!SPELL_LANGS.some(([c]) => c === code)) return;
  const others = settings.get('spellcheckLanguages').filter((c) => c !== code);
  const next = on ? [...others, code] : others;
  settings.set('spellcheckLanguages', next);
  session.fromPartition(PARTITION).setSpellCheckerLanguages(next);
});
// The chat background chosen by the user. The image lives in its own file, not in settings.
const wallpaperFile = () => path.join(app.getPath('userData'), 'wallpaper.jpg');
const JPEG_PREFIX = 'data:image/jpeg;base64,';
ipcMain.handle('pulso:wallpaper', () => {
  let image = null;
  try {
    image = JPEG_PREFIX + fs.readFileSync(wallpaperFile()).toString('base64');
  } catch { /* no image yet */ }
  return { config: settings.get('wallpaper'), image };
});
ipcMain.on('pulso:wallpaper-config', (event, json) => {
  try {
    const c = JSON.parse(json);
    settings.set('wallpaper', {
      kind: ['none', 'doodle', 'color', 'image'].includes(c.kind) ? c.kind : 'none',
      color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#0b141a',
      fit: ['cover', 'fill', 'center', 'contain', 'wide'].includes(c.fit) ? c.fit : 'cover',
      opacity: Math.min(1, Math.max(0.05, Number(c.opacity) || 1)),
      zoom: Math.min(4, Math.max(1, Number(c.zoom) || 1)),
      x: Math.min(100, Math.max(0, Number(c.x) || 0)),
      y: Math.min(100, Math.max(0, Number(c.y) || 0)),
    });
  } catch { /* ignore malformed */ }
});
ipcMain.on('pulso:wallpaper-image', (event, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(JPEG_PREFIX) || dataUrl.length > 40e6) return;
  fs.writeFile(wallpaperFile(), Buffer.from(dataUrl.slice(JPEG_PREFIX.length), 'base64'), () => {});
});
ipcMain.on('pulso:action', (event, name) => {
  if (Object.hasOwn(ACTIONS, name)) ACTIONS[name]();
});
// The title bar takes the theme's surface color, so it reads as part of the interface.
ipcMain.on('pulso:theme', (event, id, color) => {
  if (!/^[a-z]{1,20}$/.test(id) || !/^#[0-9a-f]{6}$/i.test(color)) return;
  settings.set('theme', id);
  settings.set('barColor', color);
  win.setBackgroundColor(color);
  win.webContents.send('shell:look', color, id);
  layout();
});

function checkForUpdates() {
  showWindow();
  updater.check(true);
}

function setGraphics(on) {
  settings.set('gpuBooting', false);
  settings.set('hardwareAcceleration', on);
  relaunch();
}

function createTray() {
  tray = new Tray(icons.trayIcon(0));
  tray.setToolTip(APP_NAME);
  tray.on('click', toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Mostrar ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    { label: 'Recargar', click: () => wa.reload() },
    { label: 'Buscar actualizaciones…', click: checkForUpdates },
    // Reachable even when the window shows nothing.
    {
      label: 'Aceleración por GPU',
      type: 'checkbox',
      checked: settings.get('hardwareAcceleration'),
      click: (item) => setGraphics(item.checked),
    },
    { type: 'separator' },
    { label: 'Salir', click: quit },
  ]));
}

function setZoom(delta) {
  const factor = delta === 0 ? 1 : Math.min(3, Math.max(0.5, wa.getZoomFactor() + delta));
  wa.setZoomFactor(factor);
  settings.set('zoomFactor', factor);
}

const SPELL_LANGS = [
  ['es', 'Español'], ['en-US', 'Inglés (EE. UU.)'], ['pt-BR', 'Portugués (Brasil)'],
  ['fr', 'Francés'], ['de', 'Alemán'], ['it', 'Italiano'],
];

// Never shown: the title bar has no menu. It only provides the keyboard shortcuts.
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: APP_NAME,
    submenu: [
      { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => wa.reload() },
      { label: 'Ocultar', accelerator: 'CmdOrCtrl+W', click: () => win.hide() },
      { label: 'Salir', accelerator: 'CmdOrCtrl+Q', click: quit },
      { label: 'Acercar', accelerator: 'CmdOrCtrl+=', click: () => setZoom(0.1) },
      { label: 'Alejar', accelerator: 'CmdOrCtrl+-', click: () => setZoom(-0.1) },
      { label: 'Tamaño real', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0) },
      { label: 'Pantalla completa', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: 'Herramientas de desarrollo', accelerator: 'CmdOrCtrl+Shift+I', click: () => wa.toggleDevTools() },
    ],
  }]));
}

function applyLaunchAtLogin() {
  if (!app.isPackaged) return; // Avoid registering electron.exe during development.
  app.setLoginItemSettings({
    openAtLogin: settings.get('launchAtLogin'),
    args: ['--hidden'],
  });
}

async function clearCache() {
  const ses = session.fromPartition(PARTITION);
  await ses.clearCache();
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  wa.reload();
}

async function resetSession() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancelar', 'Cerrar sesión'],
    defaultId: 0,
    cancelId: 0,
    title: 'Cerrar sesión',
    message: 'Se borrarán todos los datos locales de WhatsApp Web en este equipo.',
    detail: 'Tendrás que escanear el código QR de nuevo. Tus chats siguen en tu teléfono.',
  });
  if (response !== 1) return;
  await session.fromPartition(PARTITION).clearStorageData();
  wa.reload();
}

function showAbout() {
  const g = app.getGPUFeatureStatus();
  dialog.showMessageBox(win, {
    type: 'info',
    title: `Acerca de ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail:
      'Tu WhatsApp, en tu estilo. Cliente de escritorio no oficial para Windows que ejecuta WhatsApp Web.\n' +
      'No está afiliado a WhatsApp ni a Meta.\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
      `Gráficos: compositing ${g.gpu_compositing} · raster ${g.rasterization}`,
  });
}

function showContextMenu(params) {
  const items = [];
  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => wa.replaceMisspelling(s) });
    }
    items.push({
      label: 'Añadir al diccionario',
      click: () => wa.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: 'separator' });
  }
  if (params.linkURL) {
    items.push({ label: 'Abrir enlace en el navegador', click: () => openExternal(params.linkURL) });
    items.push({ label: 'Copiar enlace', click: () => clipboard.writeText(params.linkURL) });
    items.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Copiar imagen', click: () => wa.copyImageAt(params.x, params.y) });
    items.push({ label: 'Guardar imagen como…', click: () => wa.downloadURL(params.srcURL) });
    items.push({ type: 'separator' });
  }
  const { editFlags } = params;
  if (params.isEditable) {
    items.push({ role: 'cut', label: 'Cortar', enabled: editFlags.canCut });
    items.push({ role: 'copy', label: 'Copiar', enabled: editFlags.canCopy });
    items.push({ role: 'paste', label: 'Pegar', enabled: editFlags.canPaste });
    items.push({ role: 'selectAll', label: 'Seleccionar todo' });
  } else if (params.selectionText) {
    items.push({ role: 'copy', label: 'Copiar' });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

// Without a save path Electron shows the native "Save as" dialog.
function onDownload(event, item) {
  item.on('updated', () => {
    const total = item.getTotalBytes();
    if (total > 0) win.setProgressBar(item.getReceivedBytes() / total);
  });
  item.once('done', (e, state) => {
    win.setProgressBar(-1);
    if (state !== 'completed') return;
    const file = item.getSavePath();
    const note = new Notification({
      title: 'Descarga completada',
      body: path.basename(file),
      icon: icons.windowIcon(),
    });
    note.on('click', () => shell.showItemInFolder(file));
    note.show();
  });
}
