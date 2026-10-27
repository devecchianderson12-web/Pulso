const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, nativeTheme, shell, session,
  ipcMain, Notification, dialog, clipboard, desktopCapturer,
} = require('electron');

// Versions up to 1.1.0 kept their data under the app's previous name: move the
// login session and settings over so updating doesn't require scanning the QR again.
const legacyData = path.join(app.getPath('appData'), 'Whatsdesk');
const dataDir = path.join(app.getPath('appData'), 'Pulso');
if (app.isPackaged && !fs.existsSync(dataDir) && fs.existsSync(legacyData)) {
  try {
    fs.renameSync(legacyData, dataDir);
  } catch {
    app.setPath('userData', legacyData);
  }
}

const settings = require('./settings');
const icons = require('./icons');
const updater = require('./updater');
const gpu = require('./gpu');

gpu.setup();

const APP_NAME = 'Pulso';
const TITLE_BAR_HEIGHT = 40;
const BG = '#0b100f';
const WHATSAPP_URL = 'https://web.whatsapp.com/';
const WHATSAPP_ORIGIN = 'https://web.whatsapp.com';
const PARTITION = 'persist:whatsapp';
// WhatsApp Web rejects unknown browsers, so present as desktop Chrome of the bundled Chromium version.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
// Edge's wheel scrolling: percent-based steps and a smoother curve, closer to a phone's feel.
app.commandLine.appendSwitch('enable-features', 'WindowsScrollingPersonality,PercentBasedScrolling');
const ALLOWED_PERMISSIONS = new Set([
  'notifications', 'media', 'mediaKeySystem', 'clipboard-read',
  'clipboard-sanitized-write', 'fullscreen', 'display-capture',
]);
// Links that try to send the user to install another WhatsApp app.
const PROMO_LINK =
  /whatsapp\.com\/download|apps\.microsoft\.com|get\.microsoft\.com|ms-windows-store:|apps\.apple\.com|play\.google\.com/i;

let win;
let wa; // WhatsApp Web's webContents, shown below the title bar.
let tray;
let quitting = false;
let unread = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
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
  updater.init(win, wa, () => { quitting = true; });
  wa.once('did-finish-load', () => setTimeout(() => {
    gpu.detectSoftware().then((lite) => { if (!wa.isDestroyed()) wa.send('pulso:lite', lite); });
  }, 1500));
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
    title: APP_NAME,
    icon: icons.windowIcon(),
    backgroundColor: BG,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#cfe9dd', height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'shell.html'));
  win.webContents.once('did-finish-load', () => gpu.loaded());

  const view = new WebContentsView({
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
  view.setBackgroundColor(BG);
  win.contentView.addChildView(view);
  wa = view.webContents;
  const layout = () => {
    const [width, height] = win.getContentSize();
    const top = win.isFullScreen() ? 0 : TITLE_BAR_HEIGHT;
    view.setBounds({ x: 0, y: top, width, height: height - top });
  };
  layout();
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);

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
  wa.once('did-finish-load', () => setTimeout(measureGraphics, 2500));
  wa.on('context-menu', (event, params) => showContextMenu(params));
  wa.on('render-process-gone', (event, details) => {
    if (details.reason !== 'clean-exit') wa.reload();
  });
  // The hidden title bar also hides the menu bar, so handle its shortcuts here.
  wa.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (input.key === 'F11') toggleFullScreen();
    else if (!input.control || input.alt) return;
    else if (key === 'q') quit();
    else if (key === 'r' && !input.shift) wa.reload();
    else if (key === 'w') hideWindow();
    else if (key === '=' || key === '+') setZoom(0.1);
    else if (key === '-') setZoom(-0.1);
    else if (key === '0') setZoom(0);
    else return;
    event.preventDefault();
  });

  win.on('close', (event) => {
    saveBounds();
    if (!quitting && settings.get('closeToTray')) {
      event.preventDefault();
      hideWindow();
    }
  });
  win.on('focus', () => {
    win.flashFrame(false);
    wa.focus();
  });
}

// First run only: measures real fps inside WhatsApp Web while the title bar animates, and lets
// gpu.js try another graphics mode (restarting Pulso) until one is smooth.
let measuring = false;
async function measureGraphics() {
  if (measuring || gpu.state().done) return;
  // Only measured with Pulso in the foreground; checks again until it is.
  if (!win.isVisible() || !win.isFocused()) {
    setTimeout(measureGraphics, 2000);
    return;
  }
  measuring = true;
  win.webContents.send('shell:toast', 'Optimizando gráficos… (solo la primera vez)', 3200);
  let fps = NaN;
  try {
    fps = await wa.executeJavaScript(`new Promise((resolve) => {
      const dts = []; let last = performance.now(); const t0 = last;
      const tick = (t) => { dts.push(t - last); last = t;
        if (t - t0 < 2800) requestAnimationFrame(tick);
        else { dts.shift(); dts.sort((a, b) => a - b); resolve(1000 / (dts[Math.floor(dts.length * .75)] || 16.7)); } };
      requestAnimationFrame(tick);
    })`);
  } catch { /* page navigated away; try again next launch */ }
  measuring = false;
  // Another app took the foreground: the measurement doesn't count.
  if (!win.isFocused()) {
    setTimeout(measureGraphics, 2000);
    return;
  }
  const r = gpu.report(fps, () => { quitting = true; });
  if (r.action === 'restart') win.webContents.send('shell:toast', 'Probando otro modo gráfico… Pulso se reinicia solo', 4000);
  else if (r.action === 'done') win.webContents.send('shell:toast', `Gráficos listos: ${Math.round(r.fps)} fps`, 3000);
}

function toggleFullScreen() {
  win.setFullScreen(!win.isFullScreen());
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
  tray.setImage(icons.trayIcon(count));
  tray.setToolTip(count ? `${APP_NAME} — ${count} sin leer` : APP_NAME);
  win.setOverlayIcon(
    count ? icons.overlayIcon(count) : null,
    count ? `${count} mensajes sin leer` : '',
  );
  win.setTitle(count ? `(${icons.badgeLabel(count)}) ${APP_NAME}` : APP_NAME);
  win.webContents.send('shell:unread', count);
  if (grew) flash();
}

function flash() {
  if (settings.get('flashOnMessage') && !win.isFocused()) win.flashFrame(true);
}

ipcMain.on('pulso:focus', showWindow);
ipcMain.on('pulso:notified', flash);
ipcMain.on('pulso:settings', (event) => {
  event.returnValue = { notificationSound: settings.get('notificationSound'), lite: gpu.state().software };
});
ipcMain.on('shell:menu', (event, x, y) => {
  Menu.getApplicationMenu().popup({ window: win, x: Math.round(x), y: Math.round(y) });
});
ipcMain.handle('shell:info', () => ({ version: app.getVersion(), unread }));

function createTray() {
  tray = new Tray(icons.trayIcon(0));
  tray.setToolTip(APP_NAME);
  tray.on('click', toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Mostrar ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    { label: 'Recargar', click: () => wa.reload() },
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
  const factor = delta === 0 ? 1 : Math.min(3, Math.max(0.5, wa.getZoomFactor() + delta));
  wa.setZoomFactor(factor);
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
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => wa.reload() },
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
        { label: 'Pantalla completa', accelerator: 'F11', click: toggleFullScreen },
        { label: 'Herramientas de desarrollo', click: () => wa.toggleDevTools() },
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
        toggleSetting('Sonido en notificaciones', 'notificationSound', () => wa.reload()),
        toggleSetting('Parpadear en la barra de tareas', 'flashOnMessage'),
        { type: 'separator' },
        {
          label: 'Corrector ortográfico',
          submenu: [
            toggleSetting('Activado', 'spellcheck', (on) => session.fromPartition(PARTITION).setSpellCheckerEnabled(on)),
            { type: 'separator' },
            ...spellMenu(),
          ],
        },
        { type: 'separator' },
        {
          label: `Optimizar gráficos (ahora: ${gpu.state().label})`,
          click: () => gpu.retune(() => { quitting = true; }),
        },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Centro de ayuda de WhatsApp', click: () => openExternal('https://faq.whatsapp.com/') },
        { label: `Acerca de ${APP_NAME}`, click: showAbout },
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
  dialog.showMessageBox(win, {
    type: 'info',
    title: `Acerca de ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail:
      'Tu WhatsApp, en tu estilo. Cliente de escritorio no oficial para Windows que ejecuta WhatsApp Web.\n' +
      'No está afiliado a WhatsApp ni a Meta.\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
      `Gráficos: ${graphicsSummary()}`,
  });
}

function graphicsSummary() {
  const s = gpu.state();
  let status = '';
  try {
    const g = app.getGPUFeatureStatus();
    status = ` · compositing ${g.gpu_compositing} · raster ${g.rasterization}`;
  } catch { /* not available */ }
  return `${s.label}${s.fps ? ` (${s.fps} fps)` : ''}${status}`;
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
