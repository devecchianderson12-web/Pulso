// Runs inside WhatsApp Web's page (main world). Hides every prompt to download
// another WhatsApp app and adds smoother transitions to the interface.
(() => {
  if (window.__whatsdeskPage) return;
  window.__whatsdeskPage = true;

  const HIDDEN = 'data-whatsdesk-hidden';
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
    }, { timeout: 500 });
  });

  function start() {
    document.head.appendChild(style);
    scan(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
