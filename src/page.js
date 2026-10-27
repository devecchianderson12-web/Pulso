// Runs inside WhatsApp Web's page (main world). Hides every prompt to download
// another WhatsApp app and adds smoother transitions to the interface.
(() => {
  if (window.__pulsoPage) return;
  window.__pulsoPage = true;

  const HIDDEN = 'data-pulso-hidden';
  const PROMO_TEXT = [
    /^(descarga|descargar|obt[eé]n|obtener|instala|get|download|install)( la app de)? whatsapp\b/i,
    /\bwhatsapp (para|for) (windows|mac|escritorio|desktop)\b/i,
    /^(descargar|download|get the|obtener la) (aplicaci[oó]n|app)$/i,
  ];
  const PROMO_LINK =
    /whatsapp\.com\/download|apps\.microsoft\.com|get\.microsoft\.com|ms-windows-store:|apps\.apple\.com|play\.google\.com/i;
  // Never hide real conversations, the composer or the login QR.
  const PROTECTED = '[data-id], [contenteditable="true"], [role="row"], [role="listitem"], canvas';

  const style = document.createElement('style');
  style.textContent = `
    [${HIDDEN}] { display: none !important; }
    html { -webkit-font-smoothing: antialiased; }
    /* Hover feedback only on the chat list and buttons: never on messages, which repaint while scrolling. */
    #pane-side [role="listitem"], #pane-side [role="row"], button, [role="button"], [role="tab"] {
      transition: background-color .16s cubic-bezier(.2,0,0,1), color .16s cubic-bezier(.2,0,0,1);
    }
    /* Without a usable GPU every pixel is drawn by the CPU: drop the costliest effects. */
    html.pulso-lite *, html.pulso-lite *::before, html.pulso-lite *::after {
      backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    }
    html.pulso-lite #pane-side [role="listitem"], html.pulso-lite #pane-side [role="row"],
    html.pulso-lite button, html.pulso-lite [role="button"], html.pulso-lite [role="tab"] { transition: none !important; }
    /* Lets the browser skip layout and paint of chat-list rows that are off screen. */
    #pane-side [role="listitem"] { contain: layout paint style; }

    /* Pulso theme: deep green-black surfaces and a bright pulse-green accent (dark mode only). */
    :root, body.dark {
      --splashscreen-startup-background: #0b100f !important;
      --splashscreen-startup-background-rgb: 11, 16, 15 !important;
      --splashscreen-progress-primary: #1fdf8a !important;
    }
  `;

  // Applied only where WhatsApp defines its theme (found below), not on every element.
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

  style.textContent += `
    body.dark #pane-side [role="listitem"], body.dark #pane-side [role="row"] { border-radius: 14px; }

    /* Login screen: WhatsApp paints it with fixed light colors, so restyle it here. */
    html.pulso-login, html.pulso-login body { background: #0b100f !important; }
    html.pulso-login svg:not(#pulso-update svg) { color: #9fb5ac !important; }
    html.pulso-login [aria-checked="true"], html.pulso-login [aria-checked="true"] * {
      background-color: #1fdf8a !important; border-color: #1fdf8a !important; color: #04140c !important;
    }
    html.pulso-login body *:not(canvas):not(svg):not(svg *):not([data-pulso-qr]):not([data-pulso-qr] *):not([data-pulso-card]):not([aria-checked="true"]):not([aria-checked="true"] *):not(#pulso-update):not(#pulso-update *) {
      background-color: transparent !important; color: #e8f3ee !important;
      border-color: rgba(31, 223, 138, .22) !important;
    }
    html.pulso-login [data-pulso-card] {
      background: linear-gradient(160deg, #131b19, #0e1413) !important; border-radius: 24px !important;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .45), 0 0 0 1px rgba(31, 223, 138, .14) !important;
    }
    html.pulso-login [data-pulso-qr] {
      background: #fff !important; border-radius: 18px !important; padding: 14px !important;
      box-shadow: 0 0 0 4px rgba(31, 223, 138, .25), 0 0 32px rgba(31, 223, 138, .25) !important;
    }
    html.pulso-login a, html.pulso-login a * { color: #1fdf8a !important; }
    body.dark ::-webkit-scrollbar-thumb { background-color: rgba(31, 223, 138, .18) !important; border-radius: 99px; }
    body.dark ::-webkit-scrollbar-thumb:hover { background-color: rgba(31, 223, 138, .32) !important; }
  `;

  // WhatsApp defines its colors on a few theme classes. Find those rules and override the
  // variables right there, so every other element simply inherits them.
  const themeStyle = document.createElement('style');
  let themeKey = null;
  function updateTheme() {
    const selectors = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules && r.cssRules.length) walk(r.cssRules);
          if (r.style && r.selectorText && r.style.getPropertyValue('--WDS-accent')) {
            for (const s of r.selectorText.split(',')) {
              if (!s.includes(':root') && !s.includes('::')) selectors.add(s.trim());
            }
          }
        }
      };
      walk(rules);
    }
    const list = [...selectors].join(', ');
    if (list === themeKey) return;
    themeKey = list;
    const roots = list ? `body.dark, body.dark :is(${list})` : 'body.dark, body.dark *';
    themeStyle.textContent = `${roots} {${THEME_VARS}}`;
  }

  function isPromo(text) {
    const t = text.trim();
    return t.length > 0 && t.length < 80 && PROMO_TEXT.some((re) => re.test(t));
  }

  // Climbs to the promo's own card, stopping before a container that also holds other content.
  function promoContainer(el) {
    if (el.closest(PROTECTED)) return null;
    let node = el;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      if ((parent.textContent || '').length > 400 || parent.querySelector(PROTECTED) ||
        parent.id === 'app' || parent.id === 'side' || parent.id === 'main') break;
      node = parent;
    }
    return node;
  }

  function hide(el) {
    const box = el && promoContainer(el);
    if (box) box.setAttribute(HIDDEN, '');
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    for (const a of root.querySelectorAll('a[href]')) {
      if (PROMO_LINK.test(a.href)) hide(a);
    }
    if (root.matches && root.matches('a[href]') && PROMO_LINK.test(root.href)) hide(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (isPromo(n.textContent)) hide(n.parentElement);
    }
  }

  // Marks the QR login screen (QR canvas present, no chat list) for the Pulso login styles.
  function markLogin() {
    const canvas = document.querySelector('canvas');
    const login = Boolean(canvas) && !document.getElementById('side');
    document.documentElement.classList.toggle('pulso-login', login);
    if (!login) return;
    if (!canvas.parentElement.hasAttribute('data-pulso-qr')) canvas.parentElement.setAttribute('data-pulso-qr', '');
    let card = canvas.parentElement.parentElement;
    while (card && card !== document.body && parseFloat(getComputedStyle(card).borderTopWidth) < 1) {
      card = card.parentElement;
    }
    if (card && card !== document.body && !card.hasAttribute('data-pulso-card')) card.setAttribute('data-pulso-card', '');
  }

  let pending = [];
  let scheduled = false;
  let sheetsChanged = false;
  // Messages and the text box are where most DOM changes happen (scrolling, typing);
  // promos never appear there, so those changes are ignored without any work.
  const SKIP = '[data-id], #main, footer, [contenteditable="true"], #pulso-update';
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (!m.addedNodes.length) continue;
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (target && target !== document.head && target.closest(SKIP)) continue;
      for (const node of m.addedNodes) {
        if (node.nodeName === 'STYLE' || node.nodeName === 'LINK') {
          sheetsChanged = true;
          if (node.nodeName === 'LINK') node.addEventListener('load', updateTheme, { once: true });
        } else if (node.nodeType === 1) {
          pending.push(node);
        }
      }
    }
    if (!pending.length && !sheetsChanged) return;
    if (scheduled) return;
    scheduled = true;
    // Batch work into idle time so scanning never competes with animations.
    requestIdleCallback(() => {
      const batch = pending;
      pending = [];
      scheduled = false;
      for (const node of batch) if (node.isConnected) scan(node);
      if (sheetsChanged) {
        sheetsChanged = false;
        updateTheme();
      }
      markLogin();
    }, { timeout: 2000 });
  });

  // ---------- "Hay una actualización" banner at the bottom of the chat list ----------
  const bannerStyle = `
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
    #pulso-update .bar { height: 5px; border-radius: 99px; background: #23302c; margin-top: 12px; overflow: hidden; display: none; }
    #pulso-update .bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: #1fdf8a;
      transition: width .3s cubic-bezier(.2,0,0,1); }
    #pulso-update.busy .bar { display: block; }
    #pulso-update .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    #pulso-update.busy .btns { display: none; }
    #pulso-update button { font: 600 13.5px "Segoe UI", system-ui, sans-serif; border: 0; border-radius: 99px;
      padding: 8px 16px; cursor: pointer; transition: background-color .15s, transform .1s; }
    #pulso-update button:active { transform: scale(.96); }
    #pulso-update .later { background: transparent; color: #e8f3ee; }
    #pulso-update .later:hover { background: rgba(255, 255, 255, .07); }
    #pulso-update .go { background: #1fdf8a; color: #04140c; }
    #pulso-update .go:hover { background: #3ae89c; }
  `;
  let banner;
  function ensureBanner() {
    if (banner && banner.isConnected) return banner;
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
      <div class="btns"><button class="later">Más tarde</button><button class="go">Actualizar</button></div>`;
    banner.querySelector('.later').addEventListener('click', () => window.pulso.update('later'));
    banner.querySelector('.go').addEventListener('click', () => window.pulso.update('update'));
    document.body.appendChild(banner);
    placeBanner();
    return banner;
  }
  // Sits over the bottom of the chat list (#side), or centered when there is none (login screen).
  function placeBanner() {
    if (!banner) return;
    const side = document.getElementById('side');
    const r = side && side.getBoundingClientRect();
    if (r && r.width > 0) {
      const width = Math.min(340, r.width - 24);
      banner.style.width = `${width}px`;
      banner.style.left = `${Math.round(r.left + (r.width - width) / 2)}px`;
    } else {
      banner.style.width = '340px';
      banner.style.left = `${Math.round((innerWidth - 340) / 2)}px`;
    }
  }
  window.addEventListener('resize', placeBanner);

  function showUpdate(s) {
    if (!['available', 'progress', 'installing', 'hidden'].includes(s.kind)) return;
    const b = ensureBanner();
    if (s.kind === 'hidden') { b.classList.remove('on'); return; }
    placeBanner();
    b.classList.toggle('busy', s.kind !== 'available');
    b.querySelector('.t').textContent = s.kind === 'available' ? 'Hay una actualización'
      : s.kind === 'progress' ? 'Descargando actualización…' : 'Instalando…';
    b.querySelector('.s').textContent = s.kind === 'available'
      ? `Pulso ${s.version} · tienes la ${s.current}`
      : s.kind === 'progress' ? `${Math.round(s.percent || 0)} % · no cierres Pulso` : 'Pulso se reiniciará en unos segundos';
    b.querySelector('.go').textContent = s.portable ? 'Descargar' : 'Actualizar';
    b.querySelector('.bar i').style.width = `${s.kind === 'installing' ? 100 : Math.max(2, s.percent || 0)}%`;
    requestAnimationFrame(() => b.classList.add('on'));
  }
  window.addEventListener('pulso-update', (e) => {
    try { showUpdate(JSON.parse(e.detail)); } catch { /* ignore malformed */ }
  });

  window.addEventListener('pulso-lite', (e) => {
    document.documentElement.classList.toggle('pulso-lite', e.detail === '1');
  });

  function start() {
    if (window.pulso && window.pulso.lite) document.documentElement.classList.add('pulso-lite');
    style.textContent += bannerStyle;
    document.head.appendChild(style);
    document.head.appendChild(themeStyle);
    updateTheme();
    window.addEventListener('load', updateTheme, { once: true });
    scan(document.body);
    markLogin();
    // An update found before the page finished loading.
    if (window.pulso && window.pulso.pendingUpdate) window.pulso.pendingUpdate().then((s) => s && showUpdate(s));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
