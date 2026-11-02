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
    #pulso-look { width: 40px; height: 40px; margin-bottom: 4px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      display: grid; place-items: center; background: transparent; color: var(--WDS-content-default, #e8f3ee);
      transition: background-color .16s cubic-bezier(.2,0,0,1); }
    #pulso-look:hover { background: var(--WDS-surface-highlight, rgba(255, 255, 255, .1)); }
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
  const loginCss = (t, a) => `
    html, body { background: ${t.screen || t.frame || t.bar} !important; }
    svg:not(#pulso-update svg):not(#pulso-panel svg) { color: ${t.muted || '#9fb5ac'} !important; }
    [aria-checked="true"], [aria-checked="true"] * {
      background-color: ${t.accent} !important; border-color: ${t.accent} !important; color: ${t.onAccent} !important;
    }
    body *:not(canvas):not(svg):not(svg *):not([data-pulso-qr]):not([data-pulso-qr] *):not([data-pulso-card]):not([aria-checked="true"]):not([aria-checked="true"] *):not(#pulso-update):not(#pulso-update *):not(#pulso-panel):not(#pulso-panel *) {
      background-color: transparent !important; color: ${t.text || '#e8f3ee'} !important;
      border-color: rgba(${a}, .22) !important;
    }
    [data-pulso-card] {
      background: ${t.card || t.raised} !important; border-radius: 24px !important;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .45), 0 0 0 1px rgba(${a}, .14) !important;
    }
    [data-pulso-qr] {
      background: #fff !important; border-radius: 18px !important; padding: 14px !important;
      box-shadow: 0 0 0 4px rgba(${a}, .25), 0 0 32px rgba(${a}, .25) !important;
    }
    a, a * { color: ${t.accent} !important; }
  `;
  const loginStyle = makeStyle('');

  // Shared pieces of the themes' layouts. WhatsApp's data-testid names are stable, its class names aren't.
  const LIST_BOX = '.two > div:has(> #side)';
  const CHAT_BOX = '.two > div:has(> #main), .two > div:has(> [data-testid="intro-panel"])';
  const BUBBLE = '[data-testid="msg-container"], [data-testid="msg-container"] > div';
  const TAILS = '[data-testid="tail-out"], [data-testid="tail-in"]';
  const RAIL_ITEM = '[data-testid="navbar-primary-section"] span > div, [data-testid="navbar-primary-section"] button';
  const COMPOSER = '[data-testid="compose-box"] span > div > div > div';
  const WALLPAPER = '[data-testid^="conversation-background"]';
  const LOCK = '[data-testid="lock-screen-landing-window"]';
  const RAIL = '.two > header[data-testid="chatlist-header"]';
  const LIST_HEADER = '.two > div > header[data-testid="chatlist-header"]';
  const CHAT_HEADER = 'header[data-testid="conversation-header"], [data-testid^="drawer-"] header';
  const LEFT_DRAWER = '[data-testid="drawer-left"]';
  const ROWS = '#pane-side [data-testid="cell-frame-container"], [data-testid^="drawer-"] [data-testid="cell-frame-container"], [data-testid="dropdown"] [data-testid="cell-frame-container"]';
  const PILLS = `${BUBBLE} { border-radius: 20px !important; }
    ${TAILS}, ${WALLPAPER} { display: none !important; }`;
  const floatingCards = (radius) => `
    ${LIST_BOX}, ${CHAT_BOX} { margin: 10px 0; height: calc(100% - 20px); border-radius: ${radius}px; overflow: hidden; }
    ${CHAT_BOX} { margin-left: 10px; margin-right: 10px; }
    ${LEFT_DRAWER} { margin-top: 10px; margin-bottom: 10px; height: calc(100% - 20px); border-radius: ${radius}px; overflow: hidden; }`;

  // Chat rows drawn like glossy message bubbles. WhatsApp paints rows with these two variables,
  // so setting them on the list keeps its own hover and selected states working.
  const glossyRows = (base, active, border = 'rgba(255, 255, 255, .25)') => `
    #pane-side { background: transparent !important; }
    ${ROWS} { --WDS-surface-default: ${base} !important; --WDS-surface-highlight: ${active} !important;
      border: 1px solid ${border}; border-radius: 12px !important;
      background-image: linear-gradient(180deg, rgba(255, 255, 255, .2), rgba(255, 255, 255, .03) 50%, rgba(0, 0, 0, .18)); }`;

  const chromeTheme = (name, c) => ({
    name, bar: '#d9dbe0', panel: c.panel, chat: c.chat, raised: c.raised, high: c.high,
    incoming: '#4d5157', outgoing: c.out, composer: '#4d5157', accent: '#f0f1f3', selected: c.active, nav: '#4d5157',
    onAccent: c.onAccent, rows: 8, highlight: 'rgba(255, 255, 255, .16)',
    inBg: 'linear-gradient(180deg, #7a7f88, #4d5157 50%, #42464c)', outBg: c.outBg,
    frame: 'linear-gradient(180deg, #d9dbe0, #8b8f96 50%, #c9ccd2)',
    layout: `${TAILS}, ${WALLPAPER} { display: none !important; }
      ${floatingCards(22)}
      ${glossyRows('#4d5157', c.active)}
      ${BUBBLE} { border-radius: 12px !important; }
      [data-testid="msg-container"] > div:first-of-type { border: 1px solid rgba(255, 255, 255, .25); }
      ${LIST_BOX}, ${CHAT_BOX} { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .35); }
      ${CHAT_BOX} { background: ${c.chatBg}; }
      #main { background: transparent !important; }
      ${RAIL} { background: linear-gradient(90deg, #d9dbe0, #9a9ea5) !important; }
      ${CHAT_HEADER} { background: linear-gradient(180deg, #f2f3f5, #a9adb4 48%, #8e9299 52%, #c4c7cc) !important; }
      ${CHAT_HEADER}, ${RAIL} { --WDS-content-default: #1c1c1c !important; --WDS-content-deemphasized: #333333 !important;
        --WDS-content-action-default: #222222 !important; color: #1c1c1c; }`,
  });

  const noWallpaper = `${TAILS}, ${WALLPAPER} { display: none !important; }`;
  // Panels see through to the frame, so #main and the lists stop painting their own color.
  const seeThrough = `#main, #side, #pane-side { background: transparent !important; }
    ${CHAT_BOX}, ${LIST_BOX} { background: transparent; }`;
  const headerText = (color, muted) => `${CHAT_HEADER}, ${LIST_HEADER}, ${RAIL} {
    --WDS-content-default: ${color} !important; --WDS-content-deemphasized: ${muted} !important;
    --WDS-content-action-default: ${color} !important; color: ${color}; }`;
  const CLOUDS = `radial-gradient(9% 7% at 20% 14%, #fff 60%, transparent 62%), radial-gradient(13% 8% at 27% 16%, #fff 60%, transparent 62%),
    radial-gradient(7% 5% at 15% 17%, #fff 60%, transparent 62%), radial-gradient(10% 6% at 70% 9%, #fff 60%, transparent 62%),
    radial-gradient(14% 7% at 78% 11%, #fff 60%, transparent 62%)`;

  const THEMES = {
    pulso: {
      name: 'Pulso', bar: '#0e1413', panel: '#0e1413', chat: '#0b100f', raised: '#131b19', high: '#1a2421',
      incoming: '#1a2421', outgoing: '#17714b', composer: '#151e1b', accent: '#1fdf8a', selected: '#10392a',
      onAccent: '#04140c', rows: 14,
    },
    telegram: {
      name: 'Estilo Telegram', bar: '#0d1418', panel: '#172126', chat: '#111a1f', raised: '#1c2a30', high: '#233339',
      incoming: '#202e35', outgoing: '#005c4b', composer: '#172126', accent: '#25d366', selected: '#00795f',
      onAccent: '#04140c', rows: 0, highlight: 'rgba(0, 168, 132, .72)',
      layout: `${PILLS}${floatingCards(14)}
        ${CHAT_HEADER} { border-bottom: 1px solid rgba(255, 255, 255, .06); }`,
    },
    community: {
      name: 'Comunidad', bar: '#1a2228', panel: '#222d34', chat: '#1a2228', raised: '#222d34', high: '#2c3942',
      incoming: '#2c3942', outgoing: '#0b7a66', composer: '#222d34', accent: '#25d366', selected: '#0b7a66',
      onAccent: '#04140c', rows: 14,
      layout: `${PILLS}${floatingCards(18)}
        ${LIST_BOX}, ${CHAT_BOX} { background: transparent; }
        ${RAIL_ITEM} { border-radius: 12px !important; }
        ${CHAT_HEADER} { margin: 0 0 10px; border-radius: 16px; }
        #main { background: transparent !important; }
        ${COMPOSER} { border-radius: 14px !important; }`,
    },
    discord: {
      name: 'Estilo Discord', bar: '#1e1f22', panel: '#2b2d31', chat: '#313338', raised: '#232428', high: '#383a40',
      incoming: '#313338', outgoing: '#313338', composer: '#383a40', accent: '#25d366', selected: '#404249',
      onAccent: '#04140c', rows: 6, highlight: 'rgba(255, 255, 255, .09)',
      layout: `${TAILS}, ${WALLPAPER} { display: none !important; }
        /* Messages as a flat left-aligned stream instead of bubbles. */
        ${BUBBLE} { border-radius: 4px !important; box-shadow: none !important; }
        [data-testid="msg-container"] { max-width: 92% !important; }
        .focusable-list-item { align-items: flex-start !important; padding-left: 20px !important; }
        .focusable-list-item:hover { background: rgba(0, 0, 0, .07); }
        ${RAIL_ITEM} { border-radius: 16px !important; }
        ${CHAT_HEADER} { box-shadow: 0 1px 0 rgba(0, 0, 0, .3); }
        ${COMPOSER} { border-radius: 8px !important; }`,
    },
    ember: {
      name: 'Lava', bar: '#0a0a0a', panel: '#141010', chat: '#1a100c', raised: '#241814', high: '#3a2319',
      incoming: '#33241d', outgoing: '#c8420f', composer: '#241814', accent: '#ff6a2b', selected: '#d9480f',
      onAccent: '#ffffff', rows: 12,
      inBg: 'linear-gradient(180deg, #4a372e, #33241d 50%, #291b15)',
      outBg: 'linear-gradient(180deg, #ff7a3c, #d9480f 50%, #b5360a)',
      frame: 'radial-gradient(90% 60% at 100% 100%, rgba(232, 64, 12, .45), transparent 65%), #0a0a0a',
      layout: `${TAILS}, ${WALLPAPER} { display: none !important; }
        ${floatingCards(20)}
        ${glossyRows('#33241d', '#d9480f')}
        ${BUBBLE} { border-radius: 14px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 1px solid rgba(255, 170, 120, .28); }
        ${LIST_BOX}, ${CHAT_BOX} { box-shadow: inset 0 0 0 1px rgba(255, 122, 60, .3); }
        ${LIST_BOX} { background: linear-gradient(180deg, #1d1411, #120d0b); }
        ${CHAT_BOX} { background: radial-gradient(110% 70% at 80% 100%, #7a2a0c, #2a140c 55%, #140c09); }
        #main { background: transparent !important; }
        ${CHAT_HEADER} { background: linear-gradient(180deg, #5a4034, #33241d 50%, #291b15) !important;
          border-bottom: 1px solid rgba(255, 122, 60, .45); }
        ${COMPOSER} { border-radius: 14px !important; background-image: linear-gradient(180deg, #4a372e, #291b15) !important;
          border: 1px solid rgba(255, 170, 120, .28); }
        ${RAIL_ITEM} { border-radius: 10px !important; }`,
    },
    neon: {
      name: 'Neón', bar: '#0a060e', panel: '#0f0a14', chat: '#120c18', raised: '#1b1322', high: '#2a1b36',
      incoming: '#170f1f', outgoing: '#5b1270', composer: '#170f1f', accent: '#e879f9', selected: '#a21caf',
      onAccent: '#1a0420', rows: 12,
      inBg: 'linear-gradient(135deg, #21162c, #150e1c)', outBg: 'linear-gradient(135deg, #7a1a91, #4a0f5c)',
      frame: 'radial-gradient(90% 70% at 0 0, rgba(192, 38, 211, .45), transparent 60%), #0a060e',
      layout: `${TAILS}, ${WALLPAPER} { display: none !important; }
        ${floatingCards(16)}
        ${glossyRows('#170f1f', '#a21caf', 'rgba(232, 121, 249, .55)')}
        ${BUBBLE} { border-radius: 12px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 1px solid rgba(232, 121, 249, .6);
          box-shadow: 0 0 10px rgba(217, 70, 239, .28); }
        ${LIST_BOX}, ${CHAT_BOX} { box-shadow: inset 0 0 0 1px rgba(232, 121, 249, .4); }
        ${CHAT_BOX} { background:
          linear-gradient(rgba(232, 121, 249, .07) 1px, transparent 1px) 0 0 / 100% 36px,
          linear-gradient(90deg, rgba(232, 121, 249, .07) 1px, transparent 1px) 0 0 / 36px 100%,
          radial-gradient(80% 60% at 50% 100%, rgba(192, 38, 211, .35), transparent 70%), #0d0812; }
        #main { background: transparent !important; }
        ${CHAT_HEADER} { background: linear-gradient(90deg, rgba(162, 28, 175, .55), rgba(23, 15, 31, .9)) !important;
          border-bottom: 1px solid rgba(232, 121, 249, .6); }
        ${COMPOSER} { border-radius: 12px !important; border: 1px solid rgba(232, 121, 249, .6);
          box-shadow: 0 0 10px rgba(217, 70, 239, .28); }
        ${RAIL_ITEM} { border-radius: 12px !important; }`,
    },
    chrome: chromeTheme('Cromo rojo', {
      panel: '#7a1f23', chat: '#8f1418', raised: '#a8282c', high: '#b33a3d', out: '#a81a20', active: '#b3262b',
      onAccent: '#3a0a0c',
      outBg: 'linear-gradient(180deg, #e2474c, #a81a20 50%, #8f1418)',
      chatBg: 'radial-gradient(120% 90% at 85% 15%, #d8292f, #7d0f12 60%, #4a080a)',
    }),
    chromepurple: chromeTheme('Cromo púrpura', {
      panel: '#4f2478', chat: '#5b1a8f', raised: '#6d33a3', high: '#7d45b3', out: '#6a22a8', active: '#7a2cc0',
      onAccent: '#240a3a',
      outBg: 'linear-gradient(180deg, #a35ce6, #6a22a8 50%, #561a8f)',
      chatBg: 'radial-gradient(120% 90% at 85% 15%, #9a3fe0, #4f167d 60%, #2d0a4a)',
    }),
    chromeblue: chromeTheme('Cromo celeste', {
      panel: '#1c5a80', chat: '#14689a', raised: '#2a78a8', high: '#3a8ab8', out: '#1a78b0', active: '#1f8fcf',
      onAccent: '#06263a',
      outBg: 'linear-gradient(180deg, #5cc0f0, #1a78b0 50%, #14689a)',
      chatBg: 'radial-gradient(120% 90% at 85% 15%, #3db4ea, #0f5f92 60%, #083a5c)',
    }),
    luna: {
      name: 'Luna azul', bar: '#0058e6', panel: '#dfe2ea', chat: '#7ec0ee', raised: '#ece9d8', high: '#d6dff7',
      incoming: '#ffffff', outgoing: '#e3f7d8', composer: '#ffffff', accent: '#3a9a3a', selected: '#316ac5',
      onAccent: '#ffffff', rows: 0, highlight: 'rgba(49, 106, 197, .24)', text: '#000000', muted: '#3f4a63',
      frame: '#0054e3',
      layout: `${TAILS}, ${WALLPAPER} { display: none !important; }
        #app, #app * { font-family: Tahoma, "Segoe UI", sans-serif !important; }
        ${BUBBLE} { border-radius: 3px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 1px solid #7f9db9; }
        /* Two windows: blue frame, beige client area, hard corners. */
        ${LIST_BOX}, ${CHAT_BOX} { margin: 0 0 4px 4px; height: calc(100% - 4px); border: 3px solid #0831d9; border-top-width: 0;
          border-radius: 0 0 3px 3px; overflow: hidden; }
        ${LEFT_DRAWER} { margin-bottom: 4px; height: calc(100% - 4px); margin-left: 68px; border: 3px solid #0831d9; border-top-width: 0;
          border-radius: 0 0 3px 3px; overflow: hidden; }
        ${CHAT_BOX} { margin-right: 4px;
          background: radial-gradient(150% 52% at 25% 100%, #6fb83a 60%, #5aa52c 61%, transparent 62%),
            linear-gradient(180deg, #2a78e4, #8cc4f2 55%, #cfe7fa 74%); }
        #main { background: transparent !important; }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: linear-gradient(180deg, #0a5fe0, #3d95ff 7%, #0d6bf0 16%, #0058e6 50%, #0a62ee 86%, #003dbb) !important; }
        ${RAIL} { background: linear-gradient(90deg, #3d95ff, #0a5fe0 18%, #0054e3 70%, #003dbb) !important; }
        ${RAIL_ITEM} { border-radius: 3px !important; }
        ${CHAT_HEADER}, ${LIST_HEADER}, ${RAIL} { --WDS-content-default: #ffffff !important; --WDS-content-deemphasized: #dbe6ff !important;
          --WDS-content-action-default: #ffffff !important; color: #ffffff; }
        /* Sunken text fields and raised buttons. */
        ${COMPOSER} { border-radius: 0 !important; border: 1px solid #7f9db9; box-shadow: inset 1px 1px 1px rgba(0, 0, 0, .12); }
        [data-testid="chat-list-search-container"] div { border-radius: 0 !important; }
        [role="tab"] { border-radius: 3px !important; border: 1px solid #003c74 !important;
          background: linear-gradient(180deg, #ffffff, #f0efe6 80%, #d6d0c5) !important; color: #000000 !important; }
        [role="tab"] * { color: #000000 !important; }
        \${LIST_HEADER} header { background: transparent !important; }
        #pane-side [data-testid="cell-frame-container"] { border-radius: 0 !important; }
        ::-webkit-scrollbar { width: 16px !important; height: 16px !important; }
        ::-webkit-scrollbar-track { background: #f1eee3 !important; }
        body.dark ::-webkit-scrollbar-thumb { border-radius: 2px !important; border: 1px solid #fff;
          background: linear-gradient(90deg, #cfdcfb, #a8bff2 60%, #8faae6) !important; }`,
    },
    retro: {
      name: 'Consola retro', bar: '#d8d3bd', panel: '#d9d4be', chat: '#e4e0cc', raised: '#c7c2aa', high: '#b9d08c',
      incoming: '#f1eedd', outgoing: '#c6e486', composer: '#f1eedd', accent: '#d42f7d', selected: '#a9c864',
      onAccent: '#ffffff', rows: 4, highlight: 'rgba(120, 160, 40, .35)', text: '#25301f', muted: '#566049',
      font: 'Consolas, "Lucida Console", monospace', lockRadius: 8, card: 'linear-gradient(180deg, #e6e1cb, #cfcab2)',
      frame: `linear-gradient(#2c3d42 1px, transparent 1px) 0 0 / 26px 26px, linear-gradient(90deg, #2c3d42 1px, transparent 1px) 0 0 / 26px 26px, #1c2a2e`,
      layout: `${noWallpaper}
        ${floatingCards(10)}
        ${BUBBLE} { border-radius: 3px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 1px solid #8b8a6e; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .7), 1px 1px 0 #a8a68c; }
        ${LIST_BOX}, ${CHAT_BOX} { border: 2px solid #8b8a6e; box-shadow: inset 0 0 0 2px #f1eedd; }
        ${CHAT_BOX} { background: repeating-linear-gradient(0deg, transparent 0 3px, rgba(60, 70, 40, .05) 3px 4px), #e4e0cc; }
        #main { background: transparent !important; }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: linear-gradient(180deg, #1d3a12, #2d5a1a 60%, #1d3a12) !important; border-bottom: 2px solid #8b8a6e; }
        ${LIST_HEADER} header { background: transparent !important; }
        ${RAIL} { background: linear-gradient(90deg, #e6e1cb, #bdb8a0) !important; border-right: 2px solid #8b8a6e; }
        ${CHAT_HEADER}, ${LIST_HEADER} { --WDS-content-default: #c6f07a !important; --WDS-content-deemphasized: #9ccf5a !important;
          --WDS-content-action-default: #c6f07a !important; color: #c6f07a; }
        ${RAIL_ITEM} { border-radius: 4px !important; }
        ${ROWS} { --WDS-surface-default: #e9e5d2 !important; --WDS-surface-highlight: #b9d08c !important; border: 1px solid #8b8a6e; border-radius: 4px !important;
          box-shadow: inset 0 1px 0 #fff, 1px 1px 0 #a8a68c; }
        #pane-side { background: transparent !important; }
        ${COMPOSER} { border-radius: 4px !important; border: 1px solid #8b8a6e; box-shadow: inset 1px 1px 2px rgba(0, 0, 0, .25); }
        [role="tab"] { border-radius: 3px !important; border: 1px solid #8b8a6e !important; }`,
    },
    y2k: {
      name: 'Y2K lavanda', bar: '#a79bf2', panel: '#ece8ff', chat: '#f6f4ff', raised: '#d9d3ff', high: '#c9c0ff',
      incoming: '#ffffff', outgoing: '#d5ccff', composer: '#ffffff', accent: '#8a3fd1', selected: '#c9b6ff',
      onAccent: '#ffffff', rows: 24, highlight: 'rgba(198, 111, 214, .3)', text: '#33278f', muted: '#5f53b8',
      font: 'Bahnschrift, "Segoe UI", sans-serif', lockRadius: 28, card: 'linear-gradient(180deg, #f6f4ff, #d9d3ff)',
      inBg: 'linear-gradient(180deg, #ffffff, #eeeaff)', outBg: 'linear-gradient(180deg, #e7e1ff, #c6bbff)',
      frame: 'linear-gradient(135deg, #a79bf2, #6f62d8 45%, #b9b0f5)',
      layout: `${noWallpaper}
        ${floatingCards(26)}
        ${BUBBLE} { border-radius: 18px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 2px solid #7d6be0; }
        ${LIST_BOX}, ${CHAT_BOX} { border: 3px solid #efeaff; box-shadow: 0 0 0 2px #6f62d8; }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: linear-gradient(180deg, #a79bf2, #6a5ae0 55%, #8f80ea) !important;
          clip-path: polygon(0 0, 100% 0, calc(100% - 26px) 100%, 0 100%); }
        ${LIST_HEADER} header { background: transparent !important; }
        ${RAIL} { background: linear-gradient(90deg, #d9d3ff, #a79bf2) !important; }
        ${headerText('#ffffff', '#ecE8ff')}
        ${RAIL_ITEM} { border-radius: 50% !important; }
        ${glossyRows('#d5ccff', '#c66fd6', '#7d6be0')}
        ${ROWS} { border-width: 2px; border-radius: 24px !important; }
        ${COMPOSER} { border-radius: 24px !important; border: 2px solid #7d6be0; }
        [role="tab"] { border-radius: 99px !important; border: 2px solid #7d6be0 !important; background: linear-gradient(180deg, #d9d3ff, #a79bf2) !important; }`,
    },
    aero: {
      name: 'Aero natural', bar: '#bfe3f7', panel: '#ffffffc8', chat: '#d7eefb', raised: '#eaf7fe', high: '#cfeaf9',
      incoming: '#ffffffd9', outgoing: '#d3f0b4', composer: '#ffffffe6', accent: '#2f8f3a', selected: '#a9dcf5',
      onAccent: '#ffffff', rows: 12, highlight: 'rgba(90, 180, 235, .32)', text: '#173a52', muted: '#44677f',
      font: '"Segoe UI", Tahoma, sans-serif', lockRadius: 16, card: 'linear-gradient(180deg, #ffffffe6, #dff2fc)',
      inBg: 'linear-gradient(180deg, #ffffff, #e6f5fd 50%, #d6eefa 51%, #edf8fe)',
      outBg: 'linear-gradient(180deg, #edfbd9, #c9eda0 50%, #b6e486 51%, #dbf4bc)',
      frame: `${CLOUDS}, radial-gradient(150% 40% at 50% 112%, #62b23c 60%, transparent 61%), linear-gradient(180deg, #4aa6e8, #bfe6fa 70%, #e8f7fe)`,
      layout: `${noWallpaper}
        ${floatingCards(14)}
        ${seeThrough}
        ${LIST_BOX} { background: #ffffffa8; }
        ${CHAT_BOX} { background: #ffffff33; }
        ${BUBBLE} { border-radius: 12px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 1px solid rgba(70, 140, 190, .5); }
        ${LIST_BOX}, ${CHAT_BOX} { border: 1px solid rgba(255, 255, 255, .9); box-shadow: 0 8px 24px rgba(30, 90, 130, .3), inset 0 0 0 1px rgba(90, 160, 210, .4); }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: linear-gradient(180deg, #ffffffcc, #d6eefae6 50%, #b9e0f5e6 51%, #e2f4fde6) !important; }
        ${LIST_HEADER} header { background: transparent !important; }
        ${RAIL} { background: linear-gradient(90deg, #ffffff99, #bfe3f7aa) !important; }
        ${RAIL_ITEM} { border-radius: 50% !important; }
        ${glossyRows('#ffffffb0', '#a9dcf5', 'rgba(90, 160, 210, .55)')}
        ${COMPOSER} { border-radius: 12px !important; border: 1px solid rgba(70, 140, 190, .5); }
        [role="tab"] { border-radius: 8px !important; background: linear-gradient(180deg, #edfbd9, #b6e486) !important; }`,
    },
    hills: {
      name: 'Colinas', bar: '#a9d36c', panel: '#eaf4d9', chat: '#7cc1ee', raised: '#f3f9e8', high: '#d9ecbc',
      incoming: '#ffffffe6', outgoing: '#dcf2ad', composer: '#ffffff', accent: '#3d8a1e', selected: '#bfe08a',
      onAccent: '#ffffff', rows: 10, highlight: 'rgba(120, 180, 50, .3)', text: '#1b3312', muted: '#4b6339',
      lockRadius: 14, card: 'linear-gradient(180deg, #ffffffcc, #e4f2cf)',
      frame: 'linear-gradient(180deg, #c3e293, #93c655)',
      screen: `${CLOUDS}, radial-gradient(90% 34% at 15% 72%, #a6c63a 60%, transparent 61%),
        radial-gradient(120% 50% at 70% 100%, #8fb52a 62%, #7fa322 63%, transparent 64%), linear-gradient(180deg, #2c7fdc, #79bdf0 62%)`,
      layout: `${noWallpaper}
        ${floatingCards(12)}
        ${BUBBLE} { border-radius: 10px !important; }
        [data-testid="msg-container"] > div:first-of-type { border: 1px solid rgba(70, 120, 40, .45); }
        ${LIST_BOX}, ${CHAT_BOX} { border: 1px solid #5f8f2c; }
        ${CHAT_BOX} { background: ${CLOUDS}, radial-gradient(90% 30% at 15% 88%, #a6c63a 60%, transparent 61%),
          radial-gradient(120% 40% at 70% 108%, #8fb52a 62%, #7fa322 63%, transparent 64%), linear-gradient(180deg, #2c7fdc, #a4d3f4 78%); }
        #main { background: transparent !important; }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: linear-gradient(180deg, #d7ecb4, #a9d36c 50%, #93c655 51%, #c3e293) !important; border-bottom: 1px solid #5f8f2c; }
        ${LIST_HEADER} header { background: transparent !important; }
        ${RAIL} { background: linear-gradient(90deg, #c3e293, #93c655) !important; }
        ${RAIL_ITEM} { border-radius: 8px !important; }
        ${glossyRows('#f6fbec', '#bfe08a', 'rgba(95, 143, 44, .5)')}
        ${COMPOSER} { border-radius: 8px !important; border: 1px solid #5f8f2c; }`,
    },
    neumorph: {
      name: 'Neumórfico', bar: '#22252b', panel: '#22252b', chat: '#22252b', raised: '#292d34', high: '#2e323a',
      incoming: '#22252b', outgoing: '#e5484d', composer: '#22252b', accent: '#e5484d', selected: '#2e323a',
      onAccent: '#ffffff', rows: 18, highlight: 'rgba(0, 0, 0, .18)', lockRadius: 26, card: '#22252b',
      layout: `${noWallpaper}
        ${BUBBLE} { border-radius: 8px !important; }
        [data-testid="msg-container"] > div:first-of-type { box-shadow: 5px 5px 10px #16181c, -3px -3px 8px #2e323a; }
        ${ROWS} { border-radius: 18px !important; box-shadow: 5px 5px 10px #16181c, -3px -3px 8px #2e323a; }
        #pane-side { background: transparent !important; }
        ${CHAT_HEADER} { box-shadow: 0 6px 12px #16181c; }
        ${RAIL_ITEM} { border-radius: 50% !important; }
        [data-testid="navbar-primary-section"] span > div { box-shadow: 3px 3px 6px #16181c, -2px -2px 5px #2e323a; }
        ${COMPOSER} { border-radius: 26px !important; box-shadow: inset 4px 4px 8px #16181c, inset -3px -3px 7px #2e323a; }
        [role="tab"] { box-shadow: 3px 3px 6px #16181c, -2px -2px 5px #2e323a; border-color: transparent !important; }`,
    },
    crystal: {
      name: 'Cristal', bar: '#1a2450', panel: '#0d162c80', chat: '#1a2348', raised: '#2a2f5a', high: '#3a3f6e',
      incoming: '#ffffff1f', outgoing: '#5b3bff', composer: '#ffffff14', accent: '#5b7cff', selected: '#ffffff26',
      onAccent: '#ffffff', rows: 0, highlight: 'rgba(255, 255, 255, .12)', lockRadius: 20, card: '#0d162cb0',
      outBg: 'linear-gradient(135deg, #3a6bff, #9a2bff 55%, #ff1f5a)',
      frame: 'radial-gradient(80% 70% at 100% 100%, #c2182f, transparent 70%), radial-gradient(70% 60% at 0 100%, #7a1236, transparent 70%), radial-gradient(70% 60% at 30% 0, #2f6fa8, transparent 70%), #101a3c',
      layout: `${noWallpaper}
        ${floatingCards(18)}
        ${seeThrough}
        ${LIST_BOX} { background: #0d162c70; }
        ${CHAT_BOX} { background: #0d162c40; }
        ${LIST_BOX}, ${CHAT_BOX} { border: 1px solid rgba(255, 255, 255, .14); box-shadow: 0 20px 50px rgba(0, 0, 0, .35); }
        ${BUBBLE} { border-radius: 14px !important; }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: #ffffff0f !important; border-bottom: 1px solid rgba(255, 255, 255, .12); }
        ${LIST_HEADER} header { background: transparent !important; }
        ${RAIL} { background: transparent !important; }
        #pane-side { --WDS-surface-default: transparent !important; }
        #pane-side [data-testid="cell-frame-container"] { border-bottom: 1px solid rgba(255, 255, 255, .08); border-radius: 0 !important; }
        ${COMPOSER} { border-radius: 12px !important; }`,
    },
    pill: {
      name: 'Píldora', bar: '#2c35a0', panel: '#ffffff1f', chat: '#2a3496', raised: '#3a44b0', high: '#4a54c4',
      incoming: '#ffffff26', outgoing: '#0d0f1ccc', composer: '#ffffff1f', accent: '#ffffff', selected: '#ffffff33',
      onAccent: '#1b2a7a', rows: 22, highlight: 'rgba(255, 255, 255, .16)', lockRadius: 40, card: '#ffffff26',
      frame: 'radial-gradient(70% 45% at 70% 108%, #d4502e, transparent 70%), radial-gradient(60% 50% at 100% 0, #cfc8c4, transparent 70%), radial-gradient(70% 60% at 25% 45%, #2433b8, transparent 75%), #1b2a7a',
      layout: `${noWallpaper}
        ${floatingCards(30)}
        ${seeThrough}
        ${LIST_BOX} { background: #ffffff14; }
        ${CHAT_BOX} { background: #0d0f1c30; }
        ${LIST_BOX}, ${CHAT_BOX} { border: 2px solid rgba(255, 255, 255, .28); }
        ${RAIL} { margin: 10px 0 10px 8px; height: calc(100% - 20px); width: 56px; border-radius: 28px; overflow: hidden; padding-left: 8px;
          background: linear-gradient(180deg, #ffffff40, #ffffff12) !important; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .35); }
        ${RAIL_ITEM} { border-radius: 50% !important; }
        ${BUBBLE} { border-radius: 22px !important; }
        ${CHAT_HEADER}, ${LIST_HEADER} { background: transparent !important; }
        ${LIST_HEADER} header { background: transparent !important; }
        ${glossyRows('#ffffff14', '#ffffff40', 'rgba(255, 255, 255, .22)')}
        ${ROWS} { border-radius: 22px !important; }
        ${COMPOSER} { border-radius: 30px !important; }`,
    },
  };

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
  function themeVars(t) {
    const colors = {
      accent: t.accent, 'accent-deemphasized': t.selected, 'components-filter-surface-selected': t.selected,
      'content-on-accent': t.onAccent, 'surface-default': t.panel, 'background-wash-plain': t.chat,
      'background-wash-inset': t.chat, 'systems-chat-background-wallpaper': t.chat,
      'components-surface-nav-bar': t.nav || t.bar, 'surface-emphasized': t.raised, 'surface-elevated-default': t.raised,
      'background-elevated-wash-plain': t.raised, 'background-elevated-wash-inset': t.raised,
      'surface-elevated-emphasized': t.high, 'systems-bubble-surface-incoming': t.incoming,
      'systems-bubble-surface-outgoing': t.outgoing, 'systems-chat-surface-composer': t.composer,
      'systems-chat-surface-tray': t.panel,
      // Date chips and system notices between messages.
      'systems-bubble-surface-system': t.raised, 'systems-bubble-surface-e2e': t.raised,
      'systems-bubble-surface-business': t.raised,
    };
    const vars = Object.entries(colors).map(([k, c]) => `--WDS-${k}: ${c} !important; --WDS-${k}-RGB: ${rgb(c)} !important;`);
    vars.push(`--WDS-surface-highlight: ${t.highlight || `rgba(${rgb(t.accent)}, .08)`} !important;`);
    vars.push(`--WDS-surface-pressed: rgba(${rgb(t.accent)}, .16) !important;`);
    if (t.text) {
      for (const k of ['content-default', 'content-action-default']) vars.push(`--WDS-${k}: ${t.text} !important;`);
      for (const k of ['content-deemphasized', 'systems-bubble-content-deemphasized']) vars.push(`--WDS-${k}: ${t.muted} !important;`);
      vars.push(`--WDS-lines-divider: rgba(${rgb(t.text)}, .14) !important;`);
    }
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
      body.dark .two { background: ${theme.frame || theme.bar} !important; }
      /* The password lock screen takes the theme too. */
      ${LOCK} { background: ${theme.screen || theme.frame || theme.bar} !important; }
      ${LOCK} main { background: ${theme.card || theme.raised} !important; border-radius: ${theme.lockRadius ?? 24}px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, .4); border: 1px solid rgba(${a}, .3); }
      ${LOCK} span, ${LOCK} div, ${LOCK} button { color: ${theme.text || '#e8f3ee'} !important; }
      ${LOCK} input { background: ${theme.composer} !important; color: ${theme.text || '#e8f3ee'} !important;
        border: 1px solid rgba(${a}, .5) !important; border-radius: ${Math.min(theme.lockRadius ?? 10, 10)}px; }
      ${LOCK} main button:not(:has(svg)) { background: ${theme.accent} !important; color: ${theme.onAccent} !important;
        border-radius: ${Math.min(theme.lockRadius ?? 99, 99)}px; }
      ${LOCK} main button:not(:has(svg)) * { color: ${theme.onAccent} !important; }
      ${theme.font ? `#app, #app *, #pulso-panel, #pulso-panel * { font-family: ${theme.font}, "Segoe UI Emoji" !important; }` : ''}
      ${theme.layout || ''}
    `;
  }

  // WhatsApp defines its colors on theme classes, adding rules with insertRule after logging in.
  // Overriding them there, as a plain selector list, lets the browser match by class: other
  // elements inherit the colors and pay nothing for the theme.
  const themeStyle = makeStyle('');
  let ruleCount = -1;
  let themeSelectors = 'body.dark';
  // Bubbles paint a solid variable, so gradients need WhatsApp's own bubble classes (found below).
  let bubbleClasses = { in: new Set(), out: new Set() };
  let textClasses = new Set();
  const bubbleRule = (classes, background) => (background && classes.size
    ? `${[...classes].join(', ')} { background: ${background} !important; }` : '');
  const writeTheme = () => {
    themeStyle.textContent = `${themeSelectors} {${themeVars(theme)}}
      ${bubbleRule(bubbleClasses.in, theme.inBg)}
      ${bubbleRule(bubbleClasses.out, theme.outBg)}
      ${theme.text && textClasses.size ? `${[...textClasses].map((s) => `#main ${s}, #pane-side ${s}`).join(', ')} {
        --WDS-content-default: ${theme.text} !important; --WDS-content-action-default: ${theme.text} !important;
        --WDS-content-deemphasized: ${theme.muted} !important; }` : ''}`;
  };
  function setTheme(id, save) {
    theme = THEMES[id] || THEMES.pulso;
    applyThemeShape();
    loginStyle.textContent = loginCss(theme, rgb(theme.accent));
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
    bubbleClasses = { in: new Set(), out: new Set() };
    textClasses = new Set();
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        if (r.style && r.selectorText) {
          const bg = r.style.getPropertyValue('background-color');
          if (bg.includes('bubble-surface-incoming')) bubbleClasses.in.add(r.selectorText);
          if (bg.includes('bubble-surface-outgoing')) bubbleClasses.out.add(r.selectorText);
          if (r.style.getPropertyValue('--WDS-content-default')) textClasses.add(r.selectorText.split(',')[0]);
        }
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
    addLookButton();
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
    model.parentElement.insertBefore(makeRow(model, 'pulso', 'Ajustes de Pulso', 'Actualizaciones, inicio, gráficos', () => openPanel('settings')), before);
  }

  const panelStyle = makeStyle(`
    #pulso-panel { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
      background: rgba(0, 0, 0, .5); font: 14px/1.4 "Segoe UI", system-ui, sans-serif; color: var(--p-text); }
    #pulso-panel .box { width: min(480px, calc(100vw - 40px)); max-height: calc(100vh - 80px); overflow-y: auto;
      box-sizing: border-box; padding: 20px; border-radius: 18px; background: var(--p-raised);
      border: 1px solid rgba(255, 255, 255, .08); box-shadow: 0 20px 56px rgba(0, 0, 0, .5); }
    #pulso-panel .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
      cursor: move; user-select: none; touch-action: none; }
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
    #pulso-panel .tabs { display: flex; gap: 6px; margin-bottom: 14px; padding: 4px; border-radius: 12px; background: rgba(127, 127, 127, .14); }
    #pulso-panel .tabs button { flex: 1; padding: 8px; border-radius: 9px; font-weight: 600; transition: background-color .15s; }
    #pulso-panel .tabs button.on { background: var(--p-accent); color: var(--p-on-accent); }
    #pulso-panel .preview { position: relative; height: 150px; border-radius: 12px; overflow: hidden; background: var(--p-chat);
      border: 1px solid rgba(127, 127, 127, .3); }
    #pulso-panel .preview i { position: absolute; inset: 0; display: block; }
    #pulso-panel .choices { display: flex; flex-wrap: wrap; gap: 6px; }
    #pulso-panel .choice { padding: 7px 12px; border-radius: 9px; border: 1px solid rgba(127, 127, 127, .35); }
    #pulso-panel .choice:hover { background: rgba(127, 127, 127, .14); }
    #pulso-panel .choice.on { border-color: var(--p-accent); background: rgba(127, 127, 127, .14); }
    #pulso-panel .colors { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
    #pulso-panel .swatch { height: 34px; border-radius: 8px; border: 2px solid rgba(127, 127, 127, .3); }
    #pulso-panel .swatch.on { border-color: var(--p-accent); }
    #pulso-panel .range { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    #pulso-panel .range span { width: 84px; flex: none; font-size: 13px; }
    #pulso-panel .range input { flex: 1; min-width: 0; accent-color: var(--p-accent); }
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

  // ---------- Global chat background ----------
  // Drawn on WhatsApp's own wallpaper layer, so it sits behind the messages of every chat.
  const WALL_FITS = [
    ['cover', 'Expandir'], ['fill', 'Estirar'], ['center', 'Centrar'], ['contain', 'Ajustar'], ['wide', '16:9'],
  ];
  const WALL_COLORS = ['#0b141a', '#1f2c34', '#3b4a54', '#14342b', '#1b3a57', '#3a2a52', '#5a2a3c', '#6b4a1f',
    '#d9dbd5', '#c6e3d1', '#bcd9ea', '#e6d3ea'];
  const wallStyle = makeStyle('');
  let wall = { kind: 'none', color: WALL_COLORS[0], fit: 'cover', opacity: 1, zoom: 1, x: 50, y: 50 };
  let wallUrl = null;

  const fitCss = (w) => ({
    cover: 'background-size: cover;',
    fill: 'background-size: 100% 100%;',
    center: 'background-size: auto;',
    contain: 'background-size: contain;',
    wide: 'background-size: cover;',
  }[w.fit]);

  function renderWall() {
    if (wall.kind === 'none' || (wall.kind === 'image' && !wallUrl)) {
      wallStyle.textContent = '';
      return;
    }
    const layer = 'body #main [data-testid^="conversation-background"]';
    const base = `${layer} { display: block !important; opacity: ${wall.opacity} !important; }`;
    if (wall.kind === 'doodle') {
      wallStyle.textContent = base;
    } else if (wall.kind === 'color') {
      wallStyle.textContent = `${base} ${layer} { background: ${wall.color} !important; }`;
    } else {
      const wide = wall.fit === 'wide'
        ? 'top: 50% !important; bottom: auto !important; height: auto !important; aspect-ratio: 16 / 9; translate: 0 -50%;' : '';
      wallStyle.textContent = `#main { overflow: hidden; } ${base}
        ${layer} { inset: 0; ${wide} scale: ${wall.zoom}; background: url("${wallUrl}") no-repeat ${wall.x}% ${wall.y}% !important;
          ${fitCss(wall)} }`;
    }
  }

  function dataUrlToBlobUrl(dataUrl) {
    const [head, body] = dataUrl.split(',');
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: head.slice(5).split(';')[0] }));
  }

  async function loadWall() {
    const saved = await window.pulso.wallpaper();
    if (saved.config) wall = { ...wall, ...saved.config };
    if (saved.image) wallUrl = dataUrlToBlobUrl(saved.image);
    document.head.append(wallStyle);
    renderWall();
  }

  // Scaled down before saving: a screen-sized photo is enough, and it keeps Pulso light.
  async function pickWallImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    window.pulso.saveWallpaperImage(dataUrl);
    if (wallUrl) URL.revokeObjectURL(wallUrl);
    wallUrl = dataUrlToBlobUrl(dataUrl);
    wall = { ...wall, kind: 'image', zoom: 1, x: 50, y: 50 };
  }

  function wallPreview() {
    const box = document.createElement('div');
    box.className = 'preview';
    const inner = document.createElement('i');
    box.append(inner);
    return { box, paint() {
      const w = wall;
      inner.style.cssText = `opacity: ${w.opacity}; background: ${w.kind === 'color' ? w.color : 'transparent'};`;
      if (w.kind === 'image' && wallUrl) {
        inner.style.cssText += `background: url("${wallUrl}") no-repeat ${w.x}% ${w.y}%; scale: ${w.zoom}; ${fitCss(w)}
          ${w.fit === 'center' ? 'background-size: 40%;' : ''} ${w.fit === 'wide' ? 'inset: auto 0; top: 50%; aspect-ratio: 16 / 9; translate: 0 -50%;' : ''}`;
      }
    } };
  }

  function slider(label, min, max, step, key, onInput) {
    const row = document.createElement('label');
    row.className = 'range';
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: wall[key] });
    input.addEventListener('input', () => {
      wall[key] = Number(input.value);
      onInput();
    });
    input.addEventListener('change', () => window.pulso.saveWallpaper(wall));
    row.append(name, input);
    return row;
  }

  function wallTab() {
    const tab = document.createElement('div');
    const preview = wallPreview();
    const redraw = () => { renderWall(); preview.paint(); };
    const chooser = document.createElement('div');
    const custom = document.createElement('div');
    const apply = (next) => {
      wall = { ...wall, ...next };
      window.pulso.saveWallpaper(wall);
      redraw();
      paintChoices();
    };
    function paintChoices() {
      chooser.replaceChildren();
      const options = document.createElement('div');
      options.className = 'choices';
      const addOption = (label, kind) => {
        const b = document.createElement('button');
        b.className = wall.kind === kind ? 'choice on' : 'choice';
        b.textContent = label;
        b.addEventListener('click', () => apply({ kind }));
        options.append(b);
      };
      addOption('Del tema', 'none');
      addOption('Fondo de WhatsApp', 'doodle');
      const gallery = document.createElement('button');
      gallery.className = 'choice';
      gallery.textContent = 'Elegir en la galería de WhatsApp';
      gallery.addEventListener('click', () => {
        apply({ kind: 'doodle' });
        closePanel();
        window.pulso.action('wallpapers');
      });
      options.append(gallery);
      chooser.append(heading('Fondo de todos los chats'), options, heading('Colores'));
      const colors = document.createElement('div');
      colors.className = 'colors';
      for (const color of WALL_COLORS) {
        const c = document.createElement('button');
        c.className = wall.kind === 'color' && wall.color === color ? 'swatch on' : 'swatch';
        c.style.background = color;
        c.setAttribute('aria-label', `Color ${color}`);
        c.addEventListener('click', () => apply({ kind: 'color', color }));
        colors.append(c);
      }
      chooser.append(colors);
      custom.replaceChildren(heading('Tu imagen'));
      const file = document.createElement('input');
      Object.assign(file, { type: 'file', accept: 'image/*', hidden: true });
      file.addEventListener('change', async () => {
        if (!file.files[0]) return;
        await pickWallImage(file.files[0]);
        window.pulso.saveWallpaper(wall);
        redraw();
        paintChoices();
      });
      const pick = document.createElement('button');
      pick.className = wall.kind === 'image' ? 'choice on' : 'choice';
      pick.textContent = wallUrl ? 'Cambiar imagen' : 'Elegir imagen';
      pick.addEventListener('click', () => (wallUrl && wall.kind !== 'image' ? apply({ kind: 'image' }) : file.click()));
      const row = document.createElement('div');
      row.className = 'choices';
      row.append(pick, file);
      if (wallUrl && wall.kind !== 'image') {
        const change = document.createElement('button');
        change.className = 'choice';
        change.textContent = 'Otra imagen';
        change.addEventListener('click', () => file.click());
        pick.textContent = 'Usar mi imagen';
        row.append(change);
      }
      custom.append(row);
      if (wall.kind !== 'none') custom.append(slider('Opacidad', 0.05, 1, 0.01, 'opacity', redraw));
      if (wall.kind === 'image' && wallUrl) {
        const fits = document.createElement('div');
        fits.className = 'choices';
        for (const [fit, label] of WALL_FITS) {
          const b = document.createElement('button');
          b.className = wall.fit === fit ? 'choice on' : 'choice';
          b.textContent = label;
          b.addEventListener('click', () => apply({ fit }));
          fits.append(b);
        }
        custom.append(heading('Perfil'), fits, heading('Encuadre'),
          slider('Zoom', 1, 4, 0.01, 'zoom', redraw),
          slider('Horizontal', 0, 100, 1, 'x', redraw),
          slider('Vertical', 0, 100, 1, 'y', redraw));
      }
    }
    paintChoices();
    preview.paint();
    tab.append(preview.box, chooser, custom);
    return tab;
  }

  // Sits with WhatsApp's own icons at the bottom of the left bar.
  function addLookButton() {
    const section = document.querySelector('[data-testid="navbar-footer-section"] > div');
    if (!section || section.querySelector('#pulso-look')) return;
    const button = document.createElement('button');
    button.id = 'pulso-look';
    button.title = 'Temas y fondos';
    button.setAttribute('aria-label', 'Temas y fondos');
    button.innerHTML = iconSvg('themes');
    button.addEventListener('click', () => openPanel('look'));
    section.prepend(button);
  }

  let panel;
  const paintPanel = (el) => {
    el.style.setProperty('--p-raised', theme.raised);
    el.style.setProperty('--p-accent', theme.accent);
    el.style.setProperty('--p-text', theme.text || '#e8f3ee');
    el.style.setProperty('--p-chat', theme.chat);
    el.style.setProperty('--p-on-accent', theme.onAccent);
  };

  function closePanel() {
    if (!panel) return;
    const el = panel;
    panel = null;
    animate(el, [{ opacity: 1 }, { opacity: 0 }], 120).finished.finally(() => el.remove());
  }

  // The panel is dragged by its header and stays where it was left until Pulso restarts.
  const panelOffset = { x: 0, y: 0 };
  function makeDraggable(box, handle) {
    box.style.translate = `${panelOffset.x}px ${panelOffset.y}px`;
    handle.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || down.target.closest('button')) return;
      const startX = down.clientX - panelOffset.x;
      const startY = down.clientY - panelOffset.y;
      const rect = box.getBoundingClientRect();
      const home = { x: rect.left - panelOffset.x, y: rect.top - panelOffset.y };
      const onMove = (e) => {
        // Keeps the header reachable: the panel can't leave the window.
        panelOffset.x = Math.min(innerWidth - rect.width - home.x, Math.max(-home.x, e.clientX - startX));
        panelOffset.y = Math.min(innerHeight - 60 - home.y, Math.max(-home.y, e.clientY - startY));
        box.style.translate = `${panelOffset.x}px ${panelOffset.y}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      down.preventDefault();
    });
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
    title.textContent = kind === 'look' ? 'Apariencia' : 'Ajustes de Pulso';
    const close = document.createElement('button');
    close.className = 'x';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar');
    close.addEventListener('click', closePanel);
    head.append(title, close);
    box.append(head);
    makeDraggable(box, head);

    if (kind === 'look') {
      const tabs = document.createElement('div');
      tabs.className = 'tabs';
      const page = document.createElement('div');
      const show = (button, content) => {
        for (const b of tabs.children) b.classList.toggle('on', b === button);
        page.replaceChildren(content());
      };
      for (const [label, content] of [['Temas', () => themeCards(box)], ['Fondos', wallTab]]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => show(b, content));
        tabs.append(b);
      }
      box.append(tabs, page);
      show(tabs.firstElementChild, () => themeCards(box));
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
    animate(box, [{ opacity: 0, scale: '.94' }, { opacity: 1, scale: '1' }], 240, POP);
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
    // Sent messages sit at the end of their row. Theme layouts can't change this: it's read from
    // WhatsApp's tail icon first, which every theme keeps in the DOM.
    const item = row.querySelector('.focusable-list-item');
    const out = Boolean(row.querySelector('[data-testid="tail-out"]')) ||
      (!row.querySelector('[data-testid="tail-in"]') && Boolean(item) && getComputedStyle(item).alignItems === 'flex-end');
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
    loadWall();
    scheduleTick();
  }

  activeUntil = performance.now() + ACTIVE_FOR;
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
