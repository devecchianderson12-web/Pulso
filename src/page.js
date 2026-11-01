// Runs inside WhatsApp Web's page. Nothing here reacts to individual DOM changes: typing and
// scrolling cost zero extra work, and a slow idle tick does the upkeep. Styles that use broad
// selectors exist in the document only while they are needed.
(() => {
  if (window.__pulsoPage) return;
  window.__pulsoPage = true;

  const HIDDEN = 'data-pulso-hidden';
  const PROMO_TEXT = [
    /^(descarga|descargar|obt[eé]n|obtener|instala|get|download|install)( la app de)? whatsapp\b/i,
    /\bwhatsapp (para|for) (windows|mac|escritorio|desktop)\b/i,
    /^(descargar|download|get the|obtener la) (aplicaci[oó]n|app)$/i,
  ];
  // Never hide real conversations, the composer or the login QR.
  const PROTECTED = '[data-id], [contenteditable="true"], [role="row"], [role="listitem"], canvas';
  const SKIPPED_IDS = new Set(['main', 'pane-side', 'pulso-update']);
  const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'FOOTER', 'CANVAS', 'SVG']);
  const SCROLLERS = '#pane-side, #main [role="application"], [data-scrolltracepolicy]';
  const ACTIVE_TICK = 300;
  const IDLE_TICK = 2000;
  const ACTIVE_FOR = 15000;

  const makeStyle = (text) => {
    const el = document.createElement('style');
    el.textContent = text;
    return el;
  };
  const toggleStyle = (el, on) => {
    if (on && !el.isConnected) document.head.appendChild(el);
    else if (!on) el.remove();
  };

  const baseStyle = makeStyle(`
    [${HIDDEN}], a[href*="whatsapp.com/download"], a[href*="apps.microsoft.com"], a[href*="get.microsoft.com"],
    a[href^="ms-windows-store:"], a[href*="apps.apple.com"], a[href*="play.google.com"] { display: none !important; }
    html { -webkit-font-smoothing: antialiased; }
    /* Own compositor layer and no scroll chaining, so scrolling never repaints the rest of the page. */
    ${SCROLLERS} { will-change: scroll-position; overscroll-behavior: contain; }
    /* Each chat row lays out and paints on its own. */
    #pane-side [role="listitem"] { contain: layout paint style; }
    /* Hover feedback only on the chat list and buttons: never on messages, which repaint while scrolling. */
    #pane-side [role="listitem"], #pane-side [role="row"], button, [role="button"], [role="tab"] {
      transition: background-color .16s cubic-bezier(.2,0,0,1), color .16s cubic-bezier(.2,0,0,1);
    }
    /* Pulso theme, dark mode only. */
    :root, body.dark {
      --splashscreen-startup-background: #0b100f !important;
      --splashscreen-startup-background-rgb: 11, 16, 15 !important;
      --splashscreen-progress-primary: #1fdf8a !important;
    }
    body.dark #pane-side [role="listitem"], body.dark #pane-side [role="row"] { border-radius: 14px; }
    body.dark ::-webkit-scrollbar-thumb { background-color: rgba(31, 223, 138, .18) !important; border-radius: 99px; }
    body.dark ::-webkit-scrollbar-thumb:hover { background-color: rgba(31, 223, 138, .32) !important; }
  `);

  // Without a usable GPU every pixel is drawn by the CPU: drop the costliest effects.
  const liteStyle = makeStyle(`
    * { backdrop-filter: none !important; }
    #pane-side [role="listitem"], #pane-side [role="row"], button, [role="button"], [role="tab"] { transition: none !important; }
  `);

  // WhatsApp paints the login screen with fixed light colors, so restyle it while it's up.
  const loginStyle = makeStyle(`
    html, body { background: #0b100f !important; }
    svg:not(#pulso-update svg) { color: #9fb5ac !important; }
    [aria-checked="true"], [aria-checked="true"] * {
      background-color: #1fdf8a !important; border-color: #1fdf8a !important; color: #04140c !important;
    }
    body *:not(canvas):not(svg):not(svg *):not([data-pulso-qr]):not([data-pulso-qr] *):not([data-pulso-card]):not([aria-checked="true"]):not([aria-checked="true"] *):not(#pulso-update):not(#pulso-update *) {
      background-color: transparent !important; color: #e8f3ee !important;
      border-color: rgba(31, 223, 138, .22) !important;
    }
    [data-pulso-card] {
      background: linear-gradient(160deg, #131b19, #0e1413) !important; border-radius: 24px !important;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .45), 0 0 0 1px rgba(31, 223, 138, .14) !important;
    }
    [data-pulso-qr] {
      background: #fff !important; border-radius: 18px !important; padding: 14px !important;
      box-shadow: 0 0 0 4px rgba(31, 223, 138, .25), 0 0 32px rgba(31, 223, 138, .25) !important;
    }
    a, a * { color: #1fdf8a !important; }
  `);

  const THEME_VARS = `
    --WDS-accent: #1fdf8a !important;
    --WDS-accent-RGB: 31, 223, 138 !important;
    --WDS-accent-deemphasized: #10392a !important;
    --WDS-accent-deemphasized-RGB: 16, 57, 42 !important;
    --WDS-components-filter-surface-selected: #10392a !important;
    --WDS-content-on-accent: #04140c !important;
    --WDS-surface-default: #0e1413 !important;
    --WDS-surface-default-RGB: 14, 20, 19 !important;
    --WDS-background-wash-plain: #0b100f !important;
    --WDS-background-wash-inset: #0b100f !important;
    --WDS-systems-chat-background-wallpaper: #0b100f !important;
    --WDS-systems-chat-background-wallpaper-RGB: 11, 16, 15 !important;
    --WDS-components-surface-nav-bar: #0b100f !important;
    --WDS-surface-emphasized: #131b19 !important;
    --WDS-surface-elevated-default: #131b19 !important;
    --WDS-background-elevated-wash-plain: #131b19 !important;
    --WDS-background-elevated-wash-inset: #131b19 !important;
    --WDS-surface-elevated-emphasized: #1a2421 !important;
    --WDS-systems-bubble-surface-incoming: #1a2421 !important;
    --WDS-systems-bubble-surface-incoming-RGB: 26, 36, 33 !important;
    --WDS-systems-bubble-surface-outgoing: #17714b !important;
    --WDS-systems-bubble-surface-outgoing-RGB: 23, 113, 75 !important;
    --WDS-systems-chat-surface-composer: #151e1b !important;
    --WDS-systems-chat-surface-tray: #0e1413 !important;
    --WDS-surface-highlight: rgba(31, 223, 138, .08) !important;
    --WDS-surface-pressed: rgba(31, 223, 138, .16) !important;
  `;

  // WhatsApp defines its colors on theme classes, adding rules with insertRule after logging in.
  // Overriding them there, as a plain selector list, lets the browser match by class: other
  // elements inherit the colors and pay nothing for the theme.
  const themeStyle = makeStyle('');
  let ruleCount = -1;
  function updateTheme() {
    const sheets = [...document.styleSheets].filter((s) => s.ownerNode !== themeStyle);
    let count = 0;
    const readable = [];
    for (const sheet of sheets) {
      try {
        count += sheet.cssRules.length;
        readable.push(sheet);
      } catch { /* cross-origin */ }
    }
    if (count === ruleCount) return;
    ruleCount = count;
    const selectors = new Set();
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        if (r.style && r.selectorText && r.style.getPropertyValue('--WDS-accent')) {
          for (const s of r.selectorText.split(',')) {
            if (!s.includes(':root') && !s.includes('::')) selectors.add(`body.dark ${s.trim()}`);
          }
        }
      }
    };
    for (const sheet of readable) walk(sheet.cssRules);
    themeStyle.textContent = `${['body.dark', ...selectors].join(', ')} {${THEME_VARS}}`;
  }

  function isPromo(text) {
    const t = text.trim();
    return t.length > 0 && t.length < 80 && PROMO_TEXT.some((re) => re.test(t));
  }

  // Climbs to the promo's own card, stopping before a container that also holds other content.
  function hidePromo(el) {
    if (el.closest(PROTECTED)) return;
    let node = el;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      if ((parent.textContent || '').length > 400 || parent.querySelector(PROTECTED) ||
        parent.id === 'app' || parent.id === 'side') break;
      node = parent;
    }
    node.setAttribute(HIDDEN, '');
  }

  // Walks only the page's shell: chats and messages are skipped whole, so the cost stays
  // the same no matter how long the conversations are.
  function scanPromos() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return isPromo(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        return SKIPPED_IDS.has(n.id) || SKIPPED_TAGS.has(n.tagName.toUpperCase()) || n.hasAttribute(HIDDEN)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    const found = [];
    while (walker.nextNode()) found.push(walker.currentNode.parentElement);
    found.forEach(hidePromo);
  }

  // Marks the QR login screen (QR canvas present, no chat list) for the login styles.
  let wasLogin = null;
  let activeUntil = 0;
  function markLogin() {
    const canvas = document.querySelector('canvas');
    const login = Boolean(canvas) && !document.getElementById('side');
    if (login !== wasLogin) {
      wasLogin = login;
      activeUntil = performance.now() + ACTIVE_FOR; // the screen is changing: look more often
      toggleStyle(loginStyle, login);
      placeBanner();
    }
    if (!login) return;
    canvas.parentElement.setAttribute('data-pulso-qr', '');
    let card = canvas.parentElement.parentElement;
    while (card && card !== document.body && parseFloat(getComputedStyle(card).borderTopWidth) < 1) {
      card = card.parentElement;
    }
    if (card && card !== document.body) card.setAttribute('data-pulso-card', '');
  }

  function tick() {
    updateTheme();
    scanPromos();
    markLogin();
  }

  function scheduleTick() {
    const delay = performance.now() < activeUntil ? ACTIVE_TICK : IDLE_TICK;
    setTimeout(() => {
      if (document.hidden) scheduleTick();
      else requestIdleCallback(() => { tick(); scheduleTick(); }, { timeout: 1000 });
    }, delay);
  }

  // Ticks pause while the window is hidden or covered: catch up the moment it's seen again.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  // ---------- Update banner at the bottom of the chat list ----------
  const bannerStyle = makeStyle(`
    #pulso-update {
      position: fixed; z-index: 2147483000; bottom: 14px; left: 14px; width: 340px; box-sizing: border-box;
      padding: 14px 14px 12px; border-radius: 18px; background: #131b19; color: #e8f3ee;
      border: 1px solid rgba(31, 223, 138, .22); box-shadow: 0 14px 36px rgba(0, 0, 0, .45);
      font: 14px/1.35 "Segoe UI", system-ui, sans-serif;
      opacity: 0; transform: translateY(16px); pointer-events: none;
      transition: opacity .22s cubic-bezier(.2,0,0,1), transform .32s cubic-bezier(.2,.9,.25,1.05);
    }
    #pulso-update.on { opacity: 1; transform: none; pointer-events: auto; }
    #pulso-update .row { display: flex; gap: 12px; align-items: center; }
    #pulso-update .ic { width: 36px; height: 36px; border-radius: 12px; flex: none; display: grid; place-items: center;
      background: rgba(31, 223, 138, .14); color: #1fdf8a; }
    #pulso-update .t { font-weight: 600; font-size: 14.5px; }
    #pulso-update .s { color: #8fa69d; font-size: 12.5px; margin-top: 1px; }
    #pulso-update .bar { height: 5px; border-radius: 99px; background: #23302c; margin-top: 12px; overflow: hidden; }
    #pulso-update .bar i { display: block; height: 100%; width: 100%; border-radius: inherit; background: #1fdf8a;
      transform-origin: left; transform: scaleX(0); transition: transform .3s cubic-bezier(.2,0,0,1); }
    #pulso-update .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    #pulso-update button { font: 600 13.5px "Segoe UI", system-ui, sans-serif; border: 0; border-radius: 99px;
      padding: 8px 16px; cursor: pointer; transition: background-color .15s, transform .1s; }
    #pulso-update button:active { transform: scale(.96); }
    #pulso-update .later { background: transparent; color: #e8f3ee; }
    #pulso-update .later:hover { background: rgba(255, 255, 255, .07); }
    #pulso-update .go { background: #1fdf8a; color: #04140c; }
    #pulso-update .go:hover { background: #3ae89c; }
    #pulso-update [hidden] { display: none; }
  `);

  const UPDATE_VIEWS = {
    checking: () => ({ title: 'Buscando actualizaciones…', sub: 'Un momento' }),
    available: (s) => ({
      title: 'Hay una actualización disponible',
      sub: `Pulso ${s.version} · tienes la ${s.current}`,
      later: ['Más tarde', 'later'],
      go: [s.portable ? 'Descargar' : 'Actualizar', 'update'],
    }),
    progress: (s) => ({
      title: 'Descargando actualización…',
      sub: `${Math.round(s.percent)} % · no cierres Pulso`,
      bar: s.percent,
    }),
    installing: () => ({ title: 'Instalando…', sub: 'Pulso se reiniciará en unos segundos', bar: 100 }),
    none: (s) => ({ title: 'Estás al día', sub: `Tienes la última versión (${s.current})`, closeAfter: 3500 }),
    error: (s) => ({
      title: 'No se pudo actualizar',
      sub: s.message,
      later: ['Cerrar', 'close'],
      go: ['Reintentar', 'retry'],
    }),
  };

  let banner;
  let closeTimer;
  function ensureBanner() {
    if (banner) return banner;
    document.head.appendChild(bannerStyle);
    banner = document.createElement('div');
    banner.id = 'pulso-update';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <div class="row">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg></div>
        <div><div class="t"></div><div class="s"></div></div>
      </div>
      <div class="bar"><i></i></div>
      <div class="btns"><button class="later"></button><button class="go"></button></div>`;
    for (const name of ['later', 'go']) {
      const button = banner.querySelector(`.${name}`);
      button.addEventListener('click', () => window.pulso.update(button.dataset.action));
    }
    document.body.appendChild(banner);
    return banner;
  }

  // Sits over the bottom of the chat list, or centered when there is none (login screen).
  function placeBanner() {
    if (!banner) return;
    const side = document.getElementById('side') || document.getElementById('pane-side');
    const r = side && side.getBoundingClientRect();
    const inList = r && r.width > 120 && r.width < innerWidth * 0.75;
    const width = inList ? Math.min(340, r.width - 24) : 340;
    banner.style.width = `${width}px`;
    banner.style.left = `${Math.round(inList ? r.left + (r.width - width) / 2 : (innerWidth - width) / 2)}px`;
  }
  window.addEventListener('resize', placeBanner);

  function showUpdate(s) {
    clearTimeout(closeTimer);
    const view = UPDATE_VIEWS[s.kind];
    if (!view) {
      if (banner) banner.classList.remove('on');
      return;
    }
    const v = view(s);
    const b = ensureBanner();
    placeBanner();
    b.querySelector('.t').textContent = v.title;
    b.querySelector('.s').textContent = v.sub;
    b.querySelector('.bar').hidden = v.bar === undefined;
    b.querySelector('.bar i').style.transform = `scaleX(${(v.bar || 0) / 100})`;
    b.querySelector('.btns').hidden = !v.go;
    if (v.go) {
      for (const [name, [label, action]] of [['later', v.later], ['go', v.go]]) {
        const button = b.querySelector(`.${name}`);
        button.textContent = label;
        button.dataset.action = action;
      }
    }
    requestAnimationFrame(() => b.classList.add('on'));
    if (v.closeAfter) closeTimer = setTimeout(() => window.pulso.update('close'), v.closeAfter);
  }

  window.addEventListener('pulso-update', (e) => showUpdate(JSON.parse(e.detail)));
  window.addEventListener('pulso-lite', (e) => toggleStyle(liteStyle, e.detail === '1'));

  // Notification clicks bring Pulso to the front even when it sits in the tray.
  const Native = window.Notification;
  class PulsoNotification extends Native {
    constructor(title, options = {}) {
      super(title, { ...options, silent: !window.pulso.sound || options.silent });
      window.pulso.notified();
      this.addEventListener('click', () => window.pulso.focus());
    }
  }
  Object.defineProperty(PulsoNotification, 'permission', { get: () => Native.permission });
  PulsoNotification.requestPermission = (...a) => Native.requestPermission(...a);
  window.Notification = PulsoNotification;

  function start() {
    document.head.append(baseStyle, themeStyle);
    toggleStyle(liteStyle, window.pulso.lite);
    window.addEventListener('load', updateTheme, { once: true });
    tick();
    window.pulso.updateState().then(showUpdate); // an update found before the page loaded
    scheduleTick();
  }

  activeUntil = performance.now() + ACTIVE_FOR;
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
