// Runs before shell.html (the title bar): the window.shell API of the Electron build, plus
// dragging and resizing the frameless window from the bar.
(() => {
  const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const listeners = {};
  const on = (name) => (cb) => { (listeners[name] = listeners[name] || []).push(cb); };
  window.__shellEmit = (name, ...args) => { for (const cb of listeners[name] || []) cb(...args); };
  let maximized = false;
  on('maximized')((m) => { maximized = m; });

  window.shell = {
    state: () => invoke('shell_state').then((s) => { maximized = s.maximized; return s; }),
    onUnread: on('unread'),
    onLook: on('look'),
    onMaximized: on('maximized'),
    onIcon: on('icon'),
    control: (action) => invoke('shell_control', { action }),
  };

  const EDGE = 5;
  const CURSORS = { North: 'ns-resize', NorthWest: 'nwse-resize', NorthEast: 'nesw-resize', West: 'ew-resize', East: 'ew-resize' };
  const edgeAt = (x, y) => {
    if (maximized) return null;
    const t = y < EDGE, l = x < EDGE, r = x > innerWidth - EDGE;
    return t && l ? 'NorthWest' : t && r ? 'NorthEast' : t ? 'North' : l ? 'West' : r ? 'East' : null;
  };
  document.addEventListener('mousemove', (e) => {
    const dir = edgeAt(e.clientX, e.clientY);
    document.documentElement.style.cursor = dir ? CURSORS[dir] : '';
  }, { passive: true });
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const dir = edgeAt(e.clientX, e.clientY);
    if (dir) { invoke('start_resize', { dir }); return; }
    if (e.target.closest && e.target.closest('.controls')) return;
    if (e.detail === 2) invoke('shell_control', { action: 'maximize' });
    else invoke('start_drag');
  });
})();
