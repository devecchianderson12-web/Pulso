// Runs inside WhatsApp Web's page. Nothing here reacts to individual DOM changes: typing and
// scrolling cost no extra work (only new messages are watched), and a slow idle tick does the upkeep. Styles that use broad
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
  `);

  // Without a usable GPU every pixel is drawn by the CPU: drop the costliest effects.
  const liteStyle = makeStyle(`
    * { backdrop-filter: none !important; }
    #pane-side [role="listitem"], #pane-side [role="row"], button, [role="button"], [role="tab"] { transition: none !important; }
  `);

  // WhatsApp paints the login screen with fixed light colors, so restyle it while it's up.
  const loginStyle = makeStyle(`
    html, body { background: #0b100f !important; }
    svg:not(#pulso-update svg):not(#pulso-panel svg) { color: #9fb5ac !important; }
    [aria-checked="true"], [aria-checked="true"] * {
      background-color: #1fdf8a !important; border-color: #1fdf8a !important; color: #04140c !important;
    }
    body *:not(canvas):not(svg):not(svg *):not([data-pulso-qr]):not([data-pulso-qr] *):not([data-pulso-card]):not([aria-checked="true"]):not([aria-checked="true"] *):not(#pulso-update):not(#pulso-update *):not(#pulso-panel):not(#pulso-panel *) {
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

  const THEMES = {
    pulso: {
      name: 'Pulso', bar: '#0e1413', panel: '#0e1413', chat: '#0b100f', raised: '#131b19', high: '#1a2421',
      incoming: '#1a2421', outgoing: '#17714b', composer: '#151e1b', accent: '#1fdf8a', selected: '#10392a',
      onAccent: '#04140c', rows: 14, bubbles: 18,
    },
    telegram: {
      name: 'Estilo Telegram', bar: '#17212b', panel: '#17212b', chat: '#0e1621', raised: '#1e2c3a', high: '#242f3d',
      incoming: '#182533', outgoing: '#2b5278', composer: '#17212b', accent: '#6ab2f2', selected: '#2b5278',
      onAccent: '#0e1621', rows: 10, bubbles: 14,
    },
    discord: {
      name: 'Estilo Discord', bar: '#1e1f22', panel: '#2b2d31', chat: '#313338', raised: '#232428', high: '#383a40',
      incoming: '#2b2d31', outgoing: '#4752c4', composer: '#383a40', accent: '#5865f2', selected: '#404249',
      onAccent: '#ffffff', rows: 6, bubbles: 8,
    },
  };

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
  function themeVars(t) {
    const colors = {
      accent: t.accent, 'accent-deemphasized': t.selected, 'components-filter-surface-selected': t.selected,
      'content-on-accent': t.onAccent, 'surface-default': t.panel, 'background-wash-plain': t.chat,
      'background-wash-inset': t.chat, 'systems-chat-background-wallpaper': t.chat,
      'components-surface-nav-bar': t.bar, 'surface-emphasized': t.raised, 'surface-elevated-default': t.raised,
      'background-elevated-wash-plain': t.raised, 'background-elevated-wash-inset': t.raised,
      'surface-elevated-emphasized': t.high, 'systems-bubble-surface-incoming': t.incoming,
      'systems-bubble-surface-outgoing': t.outgoing, 'systems-chat-surface-composer': t.composer,
      'systems-chat-surface-tray': t.panel,
    };
    const vars = Object.entries(colors).map(([k, c]) => `--WDS-${k}: ${c} !important; --WDS-${k}-RGB: ${rgb(c)} !important;`);
    vars.push(`--WDS-surface-highlight: rgba(${rgb(t.accent)}, .08) !important;`);
    vars.push(`--WDS-surface-pressed: rgba(${rgb(t.accent)}, .16) !important;`);
    vars.push(`--chat-bubble-border-radius: ${t.bubbles}px !important;`);
    return vars.join('\n');
  }

  let theme = THEMES.pulso;
  const shapeStyle = makeStyle('');
  function applyThemeShape() {
    const a = rgb(theme.accent);
    shapeStyle.textContent = `
      :root, body.dark {
        --splashscreen-startup-background: ${theme.chat} !important;
        --splashscreen-startup-background-rgb: ${rgb(theme.chat)} !important;
        --splashscreen-progress-primary: ${theme.accent} !important;
      }
      body.dark #pane-side [role="listitem"], body.dark #pane-side [role="row"] { border-radius: ${theme.rows}px; }
      body.dark ::-webkit-scrollbar-thumb { background-color: rgba(${a}, .18) !important; border-radius: 99px; }
      body.dark ::-webkit-scrollbar-thumb:hover { background-color: rgba(${a}, .32) !important; }
    `;
  }

  // WhatsApp defines its colors on theme classes, adding rules with insertRule after logging in.
  // Overriding them there, as a plain selector list, lets the browser match by class: other
  // elements inherit the colors and pay nothing for the theme.
  const themeStyle = makeStyle('');
  let ruleCount = -1;
  let themeSelectors = 'body.dark';
  const writeTheme = () => { themeStyle.textContent = `${themeSelectors} {${themeVars(theme)}}`; };
  function setTheme(id, save) {
    theme = THEMES[id] || THEMES.pulso;
    applyThemeShape();
    writeTheme();
    if (save) window.pulso.saveTheme(id, theme.bar);
  }
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
    themeSelectors = ['body.dark', ...selectors].join(', ');
    writeTheme();
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
    addPulsoRows();
    watchChat();
    if (!popoversWatched) popoversWatched = watchPopovers();
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

  // ---------- Pulso section in WhatsApp's settings list ----------
  const ICONS = {
    themes: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    pulso: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  };
  const iconSvg = (name) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

  // Copies WhatsApp's own row so it looks native. A copy has none of React's handlers, so only
  // the click added here runs; React ignores nodes it didn't create.
  function makeRow(model, name, title, sub, onClick) {
    const row = model.cloneNode(true);
    row.removeAttribute('data-testid');
    row.setAttribute('data-pulso-row', name);
    for (const el of row.querySelectorAll('[data-testid]')) el.removeAttribute('data-testid');
    const icon = row.querySelector('[data-icon]') || row.querySelector('svg');
    if (icon) icon.outerHTML = iconSvg(name);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) if (walker.currentNode.data.trim()) texts.push(walker.currentNode);
    texts.forEach((t, i) => { t.data = i === 0 ? title : i === 1 ? sub : ''; });
    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return row;
  }

  function addPulsoRows() {
    const model = document.querySelector('[data-testid="li-chats"]');
    if (!model || document.querySelector('[data-pulso-row]')) return;
    const before = document.querySelector('[data-testid="li-keyboard-shortcuts"]') || model.nextElementSibling;
    model.parentElement.insertBefore(makeRow(model, 'themes', 'Temas', 'Cambia el aspecto de Pulso', () => openPanel('themes')), before);
    model.parentElement.insertBefore(makeRow(model, 'pulso', 'Ajustes de Pulso', 'Actualizaciones, inicio, gráficos', () => openPanel('settings')), before);
  }

  const panelStyle = makeStyle(`
    #pulso-panel { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
      background: rgba(0, 0, 0, .5); font: 14px/1.4 "Segoe UI", system-ui, sans-serif; color: #e8f3ee; }
    #pulso-panel .box { width: min(480px, calc(100vw - 40px)); max-height: calc(100vh - 80px); overflow-y: auto;
      box-sizing: border-box; padding: 20px; border-radius: 18px; background: var(--p-raised);
      border: 1px solid rgba(255, 255, 255, .08); box-shadow: 0 20px 56px rgba(0, 0, 0, .5); }
    #pulso-panel .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    #pulso-panel h2 { margin: 0; font-size: 18px; font-weight: 600; }
    #pulso-panel h3 { margin: 16px 0 6px; font-size: 12.5px; font-weight: 600; color: var(--p-accent); }
    #pulso-panel button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; }
    #pulso-panel .x { width: 32px; height: 32px; border-radius: 99px; font-size: 18px; }
    #pulso-panel .x:hover, #pulso-panel .item:hover { background: rgba(255, 255, 255, .07); }
    #pulso-panel .themes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    #pulso-panel .theme { padding: 10px; border-radius: 14px; text-align: left; border: 2px solid transparent;
      background: rgba(255, 255, 255, .04); transition: border-color .15s; }
    #pulso-panel .theme.on { border-color: var(--p-accent); }
    #pulso-panel .theme .mini { display: flex; height: 64px; border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
    #pulso-panel .theme .mini i { display: block; width: 34%; }
    #pulso-panel .theme .mini b { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 6px; padding: 0 8px; }
    #pulso-panel .theme .mini u { display: block; width: 58%; height: 12px; border-radius: 6px; }
    #pulso-panel .theme .mini u + u { align-self: flex-end; }
    #pulso-panel .soon { display: grid; place-items: center; min-height: 104px; border-radius: 14px; padding: 10px; text-align: center;
      color: #8fa69d; border: 2px dashed rgba(255, 255, 255, .12); }
    #pulso-panel .item { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      width: 100%; padding: 9px 10px; border-radius: 10px; text-align: left; }
    #pulso-panel .sw { width: 34px; height: 20px; border-radius: 99px; background: rgba(255, 255, 255, .18); position: relative; flex: none;
      transition: background-color .16s; }
    #pulso-panel .sw::after { content: ""; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; transition: translate .18s cubic-bezier(.2,.9,.25,1.1); }
    #pulso-panel .sw.on { background: var(--p-accent); }
    #pulso-panel .sw.on::after { translate: 14px 0; }
    #pulso-panel .danger { color: #ff7b72; }
    #pulso-panel .ver { margin-top: 12px; text-align: center; font-size: 12px; color: #8fa69d; }
  `);

  const TOGGLE_LABELS = [
    ['closeToTray', 'Cerrar a la bandeja del sistema'], ['launchAtLogin', 'Iniciar con Windows'],
    ['startMinimized', 'Iniciar minimizado'], ['notificationSound', 'Sonido en notificaciones'],
    ['flashOnMessage', 'Parpadear en la barra de tareas'], ['spellcheck', 'Corrector ortográfico'],
  ];

  function toggleItem(label, on, onChange) {
    const item = document.createElement('button');
    item.className = 'item';
    item.append(label);
    const sw = document.createElement('span');
    sw.className = on ? 'sw on' : 'sw';
    item.append(sw);
    item.addEventListener('click', () => onChange(sw.classList.toggle('on')));
    return item;
  }

  function actionItem(label, action, className) {
    const item = document.createElement('button');
    item.className = className ? `item ${className}` : 'item';
    item.textContent = label;
    item.addEventListener('click', () => {
      closePanel();
      window.pulso.action(action);
    });
    return item;
  }

  function heading(text) {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
  }

  function themeCards(box) {
    const grid = document.createElement('div');
    grid.className = 'themes';
    const current = () => Object.keys(THEMES).find((k) => THEMES[k] === theme);
    for (const [id, t] of Object.entries(THEMES)) {
      const card = document.createElement('button');
      card.className = id === current() ? 'theme on' : 'theme';
      card.innerHTML = `<span class="mini"><i style="background:${t.panel}"></i><b style="background:${t.chat}">
        <u style="background:${t.incoming}"></u><u style="background:${t.outgoing}"></u></b></span>`;
      card.append(t.name);
      card.addEventListener('click', () => {
        setTheme(id, true);
        for (const c of grid.querySelectorAll('.theme')) c.classList.toggle('on', c === card);
        paintPanel(box.parentElement);
      });
      grid.append(card);
    }
    const soon = document.createElement('div');
    soon.className = 'soon';
    soon.textContent = 'Próximamente más temas';
    grid.append(soon);
    return grid;
  }

  let panel;
  const paintPanel = (el) => {
    el.style.setProperty('--p-raised', theme.raised);
    el.style.setProperty('--p-accent', theme.accent);
  };

  function closePanel() {
    if (!panel) return;
    const el = panel;
    panel = null;
    animate(el, [{ opacity: 1 }, { opacity: 0 }], 120).finished.finally(() => el.remove());
  }

  async function openPanel(kind) {
    closePanel();
    if (!panelStyle.isConnected) document.head.append(panelStyle);
    const root = document.createElement('div');
    root.id = 'pulso-panel';
    paintPanel(root);
    const box = document.createElement('div');
    box.className = 'box';
    root.append(box);
    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('h2');
    title.textContent = kind === 'themes' ? 'Temas' : 'Ajustes de Pulso';
    const close = document.createElement('button');
    close.className = 'x';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar');
    close.addEventListener('click', closePanel);
    head.append(title, close);
    box.append(head);

    if (kind === 'themes') {
      box.append(themeCards(box));
    } else {
      const o = await window.pulso.options();
      box.append(actionItem('Buscar actualizaciones', 'checkUpdates'), heading('General'));
      for (const [key, label] of TOGGLE_LABELS) {
        box.append(toggleItem(label, o.toggles[key], (on) => window.pulso.set(key, on)));
      }
      box.append(heading('Idiomas del corrector'));
      for (const [code, label] of o.languages) {
        box.append(toggleItem(label, o.activeLanguages.includes(code), (on) => window.pulso.setLanguage(code, on)));
      }
      box.append(heading('Gráficos'));
      box.append(toggleItem('Aceleración por GPU (reinicia Pulso)', o.gpu, (on) => window.pulso.setGpu(on)));
      box.append(heading('Aplicación'));
      box.append(actionItem('Recargar', 'reload'), actionItem('Borrar caché y recargar', 'clearCache'),
        actionItem('Centro de ayuda de WhatsApp', 'help'), actionItem('Acerca de Pulso', 'about'),
        actionItem('Cerrar sesión y borrar datos', 'resetSession', 'danger'), actionItem('Salir de Pulso', 'quit'));
      const ver = document.createElement('div');
      ver.className = 'ver';
      ver.textContent = `Pulso ${o.version}`;
      box.append(ver);
    }

    root.addEventListener('click', (e) => { if (e.target === root) closePanel(); });
    document.body.append(root);
    panel = root;
    animate(root, [{ opacity: 0 }, { opacity: 1 }], 160);
    animate(box, [{ opacity: 0, scale: '.94', translate: '0 10px' }, { opacity: 1, scale: '1', translate: '0 0' }], 240, POP);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  // ---------- Animations ----------
  // Only opacity and the individual translate/scale properties: the compositor runs them without
  // layout or paint, and they don't clash with the transforms WhatsApp sets on its elements.
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  const POP = 'cubic-bezier(.2,.9,.25,1.08)';
  const motionOk = () => !liteStyle.isConnected && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = (el, frames, duration, easing = EASE) => el.animate(frames, { duration, easing });

  function animateMessage(row) {
    if (!motionOk()) return;
    // Message ids start with the "sent by me" flag; otherwise tell by which side the text sits on.
    const message = row.matches('[data-id]') ? row : row.querySelector('[data-id]');
    const flag = /^(true|false)_/.exec((message && message.dataset.id) || '');
    const text = row.querySelector('[dir]');
    const box = row.getBoundingClientRect();
    const out = flag ? flag[1] === 'true'
      : Boolean(text) && text.getBoundingClientRect().right > box.left + box.width * 0.6;
    animate(row, [
      { opacity: 0, translate: out ? '0 46px' : '-14px 16px', scale: '.92', transformOrigin: out ? '100% 100%' : '0 100%' },
      { opacity: 1, translate: '0 0', scale: '1', transformOrigin: out ? '100% 100%' : '0 100%' },
    ], out ? 280 : 240, POP);
  }

  function animateChat(el) {
    if (!motionOk()) return;
    animate(el, [{ opacity: .3, translate: '26px 0' }, { opacity: 1, translate: '0 0' }], 230);
  }

  // Finds the row list as the closest ancestor of the last message with several children.
  function messageList(main) {
    const all = main.querySelectorAll('[data-id]');
    let el = all[all.length - 1];
    while (el && el !== main) {
      if (el.parentElement && el.parentElement.children.length > 2) return el.parentElement;
      el = el.parentElement;
    }
    return null;
  }

  // Sees only direct children of the message list: typing, scrolling and the rest of the page
  // never reach it. Batches of several rows are history loading, not new messages.
  const listObserver = new MutationObserver((records) => {
    if (performance.now() - chatOpenedAt < 500) return;
    const added = records.flatMap((r) => [...r.addedNodes]).filter((n) => n.nodeType === 1);
    if (added.length !== 1) return;
    const [row] = added;
    if (!row.nextElementSibling) animateMessage(row);
  });
  const paneObserver = new MutationObserver(() => {
    const main = document.getElementById('main');
    if (main && main !== watchedMain) animateChat(main);
    watchChat();
  });
  let watchedPane = null;
  let watchedMain = null;
  let watchedList = null;
  let chatOpenedAt = 0;

  function watchChat() {
    const main = document.getElementById('main');
    const pane = (main || document.querySelector('[data-testid="intro-panel"]') || {}).parentElement;
    if (pane && pane !== watchedPane) {
      watchedPane = pane;
      paneObserver.disconnect();
      paneObserver.observe(pane, { childList: true });
    }
    if (main !== watchedMain) {
      watchedMain = main;
      watchedList = null;
      listObserver.disconnect();
      chatOpenedAt = performance.now();
    }
    const list = main && messageList(main);
    if (list && list !== watchedList) {
      watchedList = list;
      listObserver.disconnect();
      listObserver.observe(list, { childList: true });
    }
  }

  // Menus and popovers open with a small pop.
  function watchPopovers() {
    const bucket = document.getElementById('wa-popovers-bucket');
    if (!bucket) return false;
    new MutationObserver((records) => {
      if (!motionOk()) return;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) animate(n, [{ opacity: 0, scale: '.95' }, { opacity: 1, scale: '1' }], 170, POP);
        }
      }
    }).observe(bucket, { childList: true });
    return true;
  }
  let popoversWatched = false;

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
    document.head.append(baseStyle, themeStyle, shapeStyle);
    setTheme(window.pulso.theme);
    // Settings and menus open from clicks: look right away instead of waiting for the tick.
    document.addEventListener('click', () => {
      for (const delay of [100, 300, 700, 1300]) setTimeout(addPulsoRows, delay);
    }, true);
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
