// Runs at the start of WhatsApp Web's page, before page.js: gives it the same window.pulso API the
// Electron preload provided, backed by Rust commands. __PULSO_BAKED__ is filled in by main.rs.
(() => {
  if (location.origin !== 'https://web.whatsapp.com' || window.__pulsoBridge) return;
  window.__pulsoBridge = true;
  const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const baked = __PULSO_BAKED__;
  // The theme and sound live in Rust's settings; this copy lets a reload read them without waiting.
  const stored = (key, fallback) => {
    try { const v = localStorage.getItem(`pulso:${key}`); return v === null ? fallback : v; } catch { return fallback; }
  };
  const store = (key, value) => { try { localStorage.setItem(`pulso:${key}`, value); } catch { /* private mode */ } };

  window.pulso = {
    sound: stored('sound', baked.sound ? '1' : '0') === '1',
    lite: baked.lite,
    theme: stored('theme', baked.theme),
    focus: () => invoke('page_focus'),
    notified: () => invoke('page_notified'),
    update: (action) => invoke('update_action', { action }),
    updateState: () => invoke('update_state'),
    options: () => invoke('options'),
    set: (key, value) => {
      if (key === 'notificationSound') store('sound', value ? '1' : '0');
      if (key === 'spellcheck') setSpellcheck(value);
      invoke('set_option', { key, value: Boolean(value) });
    },
    setGpu: (on) => invoke('set_gpu', { on: Boolean(on) }),
    setLanguage: (code, on) => invoke('set_language', { code, on: Boolean(on) }),
    action: (name) => invoke('page_action', { name }),
    saveTheme: (id, color) => { store('theme', id); invoke('save_theme', { id, color }); },
    iconInfo: () => invoke('icon_info_cmd'),
    saveIcon: (config) => invoke('save_icon', { json: JSON.stringify(config) }),
    saveIconFile: (base64) => invoke('save_icon_file', { base64 }),
  };

  function setSpellcheck(on) {
    const apply = () => document.body && (document.body.spellcheck = Boolean(on));
    if (document.body) apply(); else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }
  setSpellcheck(baked.spellcheck);

  // Web notifications become Windows notifications sent by Pulso. Clicking one fires the page's
  // own click handlers, so WhatsApp opens that chat.
  const shown = new Map();
  let nextId = 0;
  class PulsoNative extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.id = ++nextId;
      this.title = String(title || '');
      this.body = String(options.body || '');
      this.tag = options.tag || '';
      this.data = options.data;
      this.onclick = null;
      this.onclose = null;
      shown.set(this.id, this);
      if (shown.size > 50) shown.delete(shown.keys().next().value);
      invoke('notify', { id: this.id, title: this.title, body: this.body, silent: Boolean(options.silent) });
    }
    close() { shown.delete(this.id); }
    static get permission() { return 'granted'; }
    static requestPermission(cb) { if (cb) cb('granted'); return Promise.resolve('granted'); }
  }
  window.Notification = PulsoNative;
  window.__pulsoNotificationClick = (id) => {
    const n = shown.get(id);
    if (!n) return;
    const event = new Event('click');
    n.dispatchEvent(event);
    if (typeof n.onclick === 'function') n.onclick(event);
  };
  if (navigator.permissions && navigator.permissions.query) {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc) => (desc && desc.name === 'notifications'
      ? Promise.resolve({ state: 'granted', status: 'granted', onchange: null, addEventListener() {}, removeEventListener() {} })
      : query(desc));
  }

  // Unread count from the page title ("(3) WhatsApp").
  let lastUnread = -1;
  const readTitle = () => {
    const m = /^\((\d+)\)/.exec(document.title);
    const count = m ? Number(m[1]) : 0;
    if (count !== lastUnread) {
      lastUnread = count;
      invoke('set_unread_count', { count });
    }
  };
  const watchTitle = () => {
    readTitle();
    new MutationObserver(readTitle).observe(document.head, { subtree: true, childList: true, characterData: true });
  };
  if (document.head) watchTitle(); else document.addEventListener('DOMContentLoaded', watchTitle, { once: true });

  // Links open in the browser; WhatsApp's own pages stay here.
  const external = (url) => {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin && /^(https?|mailto|tel):$/.test(u.protocol)) invoke('open_external', { url: u.href });
    } catch { /* malformed */ }
  };
  window.open = (url) => { if (url) external(String(url)); return null; };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.hasAttribute('download') || /^(blob|data|javascript):/i.test(a.getAttribute('href'))) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin) {
      e.preventDefault();
      e.stopPropagation();
      external(u.href);
    }
  }, true);

  // Keyboard shortcuts of the Electron build.
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (k === 'f11') invoke('toggle_fullscreen');
    else if (ctrl && e.shiftKey && k === 'i') invoke('devtools');
    else if (ctrl && !e.shiftKey && k === 'r') location.reload();
    else if (ctrl && k === 'w') invoke('hide_window');
    else if (ctrl && k === 'q') invoke('quit_app');
    else if (ctrl && (k === '=' || k === '+')) invoke('zoom', { delta: 0.1 });
    else if (ctrl && k === '-') invoke('zoom', { delta: -0.1 });
    else if (ctrl && k === '0') invoke('zoom', { delta: 0 });
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // The window has no system frame: its left, right and bottom edges resize it from here.
  window.__pulsoMax = baked.maximized;
  const EDGE = 5;
  const CURSORS = { West: 'ew-resize', East: 'ew-resize', South: 'ns-resize', SouthWest: 'nesw-resize', SouthEast: 'nwse-resize' };
  const edgeAt = (x, y) => {
    if (window.__pulsoMax) return null;
    const l = x < EDGE, r = x > innerWidth - EDGE, b = y > innerHeight - EDGE;
    return b && l ? 'SouthWest' : b && r ? 'SouthEast' : l ? 'West' : r ? 'East' : b ? 'South' : null;
  };
  let edgeCursor = false;
  document.addEventListener('mousemove', (e) => {
    const dir = edgeAt(e.clientX, e.clientY);
    if (dir || edgeCursor) {
      document.documentElement.style.cursor = dir ? CURSORS[dir] : '';
      edgeCursor = Boolean(dir);
    }
  }, { capture: true, passive: true });
  document.addEventListener('mousedown', (e) => {
    const dir = e.button === 0 && edgeAt(e.clientX, e.clientY);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    invoke('start_resize', { dir });
  }, true);
})();
