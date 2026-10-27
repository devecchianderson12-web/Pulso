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
    html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
    button, [role="button"], [role="listitem"], [role="row"], [role="tab"], a, li, input {
      transition: background-color .2s cubic-bezier(.2,0,0,1), color .2s cubic-bezier(.2,0,0,1),
        opacity .2s cubic-bezier(.2,0,0,1), box-shadow .2s cubic-bezier(.2,0,0,1),
        border-color .2s cubic-bezier(.2,0,0,1);
    }
    img, video { transition: opacity .25s ease-out; }

    /* Pulso theme: deep green-black surfaces and a bright pulse-green accent (dark mode only). */
    :root, body.dark, body.dark * {
      --splashscreen-startup-background: #0b100f !important;
      --splashscreen-startup-background-rgb: 11, 16, 15 !important;
      --splashscreen-progress-primary: #1fdf8a !important;
    }
    body.dark, body.dark * {
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
    }
    body.dark #pane-side [role="listitem"], body.dark #pane-side [role="row"] { border-radius: 14px; }

    /* Login screen: WhatsApp paints it with fixed light colors, so restyle it here. */
    html.pulso-login, html.pulso-login body { background: #0b100f !important; }
    html.pulso-login svg { color: #9fb5ac !important; }
    html.pulso-login [aria-checked="true"], html.pulso-login [aria-checked="true"] * {
      background-color: #1fdf8a !important; border-color: #1fdf8a !important; color: #04140c !important;
    }
    html.pulso-login body *:not(canvas):not(svg):not(svg *):not([data-pulso-qr]):not([data-pulso-qr] *):not([data-pulso-card]):not([aria-checked="true"]):not([aria-checked="true"] *) {
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
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) for (const node of m.addedNodes) pending.push(node);
    if (scheduled) return;
    scheduled = true;
    // Batch work into idle time so scanning never competes with animations.
    requestIdleCallback(() => {
      const batch = pending;
      pending = [];
      scheduled = false;
      for (const node of batch) if (node.isConnected) scan(node.nodeType === 3 ? node.parentElement : node);
      markLogin();
    }, { timeout: 500 });
  });

  function start() {
    document.head.appendChild(style);
    scan(document.body);
    markLogin();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
