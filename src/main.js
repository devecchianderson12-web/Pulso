const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell, session, ipcMain,
  Notification, dialog, clipboard, desktopCapturer,
} = require('electron');
const settings = require('./settings');
const icons = require('./icons');
const updater = require('./updater');

// Hardware-accelerated rendering and smooth scrolling for fluid animations.
for (const flag of ['enable-smooth-scrolling', 'enable-gpu-rasterization', 'enable-zero-copy', 'ignore-gpu-blocklist']) {
  app.commandLine.appendSwitch(flag);
}

const WHATSAPP_URL = 'https://web.whatsapp.com/';
const WHATSAPP_ORIGIN = 'https://web.whatsapp.com';
const PARTITION = 'persist:whatsapp';
// WhatsApp Web rejects unknown browsers, so present as desktop Chrome.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ALLOWED_PERMISSIONS = new Set([
  'notifications', 'media', 'mediaKeySystem', 'clipboard-read',
  'clipboard-sanitized-write', 'fullscreen', 'display-capture',
]);
// Links that try to send the user to install another WhatsApp app.
const PROMO_LINK =
  /whatsapp\.com\/download|apps\.microsoft\.com|get\.microsoft\.com|ms-windows-store:|apps\.apple\.com|play\.google\.com/i;

let win;
let tray;
let quitting = false;
let unread = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
}

app.setAppUserModelId('com.whatsdesk.windows');

function start() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(USER_AGENT);
  ses.setSpellCheckerLanguages(settings.get('spellcheckLanguages'));
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
  updater.init(win, () => { quitting = true; });
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
  const bounds = settings.get('bounds');
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 480,
    title: 'Whatsdesk',
    icon: nativeImage.createFromBuffer(icons.appIcon()),
    autoHideMenuBar: true,
    backgroundColor: '#111b21',
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  if (settings.get('maximized')) win.maximize();
  const hidden = process.argv.includes('--hidden') || settings.get('startMinimized');
  win.once('ready-to-show', () => {
    if (!hidden) showWindow();
  });

  const wc = win.webContents;
  wc.setZoomFactor(settings.get('zoomFactor'));
  wc.loadURL(WHATSAPP_URL, { userAgent: USER_AGENT });

  wc.setWindowOpenHandler(({ url }) => {
    if (!isWhatsApp(url)) openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isWhatsApp(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  wc.on('page-title-updated', (event, title) => {
    event.preventDefault();
    const match = /^\((\d+)\)/.exec(title);
    setUnread(match ? Number(match[1]) : 0);
    win.setTitle(unread ? `(${icons.badgeLabel(unread)}) Whatsdesk` : 'Whatsdesk');
  });
  wc.on('context-menu', (event, params) => showContextMenu(params));
  wc.on('render-process-gone', (event, details) => {
    if (details.reason !== 'clean-exit') wc.reload();
  });

  win.on('close', (event) => {
    saveBounds();
    if (!quitting && settings.get('closeToTray')) {
      event.preventDefault();
      hideWindow();
    }
  });
  win.on('focus', () => win.flashFrame(false));
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  settings.set('maximized', win.isMaximized());
  if (!win.isMaximized() && !win.isMinimized()) settings.set('bounds', win.getBounds());
}

// Eases the window opacity so showing and hiding from the tray feels smooth.
let fadeTimer;
function fade(from, to, ms, done) {
  clearInterval(fadeTimer);
  const start = Date.now();
  win.setOpacity(from);
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    win.setOpacity(from + (to - from) * eased);
    if (t === 1) {
      clearInterval(fadeTimer);
      if (done) done();
    }
  }, 1000 / 120);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  const wasVisible = win.isVisible();
  if (!wasVisible) win.setOpacity(0);
  win.show();
  win.focus();
  if (!wasVisible) fade(0, 1, 180);
}

function hideWindow() {
  if (!win.isVisible()) return;
  fade(win.getOpacity(), 0, 140, () => {
    win.hide();
    win.setOpacity(1);
  });
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) hideWindow();
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
  tray.setImage(nativeImage.createFromBuffer(icons.trayIcon(count)));
  tray.setToolTip(count ? `Whatsdesk — ${count} sin leer` : 'Whatsdesk');
  win.setOverlayIcon(
    count ? nativeImage.createFromBuffer(icons.overlayIcon(count)) : null,
    count ? `${count} mensajes sin leer` : '',
  );
  if (grew) flash();
}

function flash() {
  if (settings.get('flashOnMessage') && !win.isFocused()) win.flashFrame(true);
}

ipcMain.on('whatsdesk:focus', showWindow);
ipcMain.on('whatsdesk:notified', flash);
ipcMain.on('whatsdesk:settings', (event) => {
  event.returnValue = { notificationSound: settings.get('notificationSound') };
});

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(icons.trayIcon(0)));
  tray.setToolTip('Whatsdesk');
  tray.on('click', toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar Whatsdesk', click: showWindow },
    { type: 'separator' },
    { label: 'Recargar', click: () => win.webContents.reload() },
    { label: 'Buscar actualizaciones…', click: () => updater.check(true) },
    { type: 'separator' },
    { label: 'Salir', click: quit },
  ]));
}

function toggleSetting(label, key, after) {
  return {
    label,
    type: 'checkbox',
    checked: settings.get(key),
    click: (item) => {
      settings.set(key, item.checked);
      if (after) after(item.checked);
    },
  };
}

function setZoom(delta) {
  const wc = win.webContents;
  const factor = delta === 0 ? 1 : Math.min(3, Math.max(0.5, wc.getZoomFactor() + delta));
  wc.setZoomFactor(factor);
  settings.set('zoomFactor', factor);
}

const SPELL_LANGS = [
  ['es', 'Español'], ['en-US', 'Inglés (EE. UU.)'], ['pt-BR', 'Portugués (Brasil)'],
  ['fr', 'Francés'], ['de', 'Alemán'], ['it', 'Italiano'],
];

function spellMenu() {
  const active = settings.get('spellcheckLanguages');
  return SPELL_LANGS.map(([code, label]) => ({
    label,
    type: 'checkbox',
    checked: active.includes(code),
    click: (item) => {
      const next = item.checked
        ? [...settings.get('spellcheckLanguages'), code]
        : settings.get('spellcheckLanguages').filter((c) => c !== code);
      settings.set('spellcheckLanguages', next);
      session.fromPartition(PARTITION).setSpellCheckerLanguages(next);
    },
  }));
}

function buildMenu() {
  const template = [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
        { label: 'Ocultar en la bandeja', accelerator: 'CmdOrCtrl+W', click: hideWindow },
        { type: 'separator' },
        { label: 'Borrar caché y recargar', click: clearCache },
        { label: 'Cerrar sesión y borrar datos', click: resetSession },
        { type: 'separator' },
        { label: 'Salir', accelerator: 'CmdOrCtrl+Q', click: quit },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Acercar', accelerator: 'CmdOrCtrl+=', click: () => setZoom(0.1) },
        { label: 'Alejar', accelerator: 'CmdOrCtrl+-', click: () => setZoom(-0.1) },
        { label: 'Tamaño real', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'Ajustes',
      submenu: [
        { label: 'Buscar actualizaciones…', click: () => updater.check(true) },
        { type: 'separator' },
        toggleSetting('Cerrar a la bandeja del sistema', 'closeToTray'),
        toggleSetting('Iniciar con Windows', 'launchAtLogin', applyLaunchAtLogin),
        toggleSetting('Iniciar minimizado', 'startMinimized'),
        { type: 'separator' },
        toggleSetting('Sonido en notificaciones', 'notificationSound', () => win.webContents.reload()),
        toggleSetting('Parpadear en la barra de tareas', 'flashOnMessage'),
        { type: 'separator' },
        { label: 'Corrector ortográfico', submenu: spellMenu() },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Centro de ayuda de WhatsApp', click: () => openExternal('https://faq.whatsapp.com/') },
        { label: 'Acerca de Whatsdesk', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  win.webContents.reload();
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
  win.webContents.reload();
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Acerca de Whatsdesk',
    message: `Whatsdesk ${app.getVersion()}`,
    detail:
      'Cliente de escritorio no oficial para Windows que ejecuta WhatsApp Web.\n' +
      'No está afiliado a WhatsApp ni a Meta.\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
  });
}

function showContextMenu(params) {
  const wc = win.webContents;
  const items = [];
  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    }
    items.push({
      label: 'Añadir al diccionario',
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: 'separator' });
  }
  if (params.linkURL) {
    items.push({ label: 'Abrir enlace en el navegador', click: () => openExternal(params.linkURL) });
    items.push({ label: 'Copiar enlace', click: () => clipboard.writeText(params.linkURL) });
    items.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Copiar imagen', click: () => wc.copyImageAt(params.x, params.y) });
    items.push({ label: 'Guardar imagen como…', click: () => wc.downloadURL(params.srcURL) });
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
      icon: nativeImage.createFromBuffer(icons.appIcon(64)),
    });
    note.on('click', () => shell.showItemInFolder(file));
    note.show();
  });
}
