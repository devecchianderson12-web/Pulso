const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  state: () => ipcRenderer.invoke('shell:state'),
  onUnread: (cb) => ipcRenderer.on('shell:unread', (e, count) => cb(count)),
  onLook: (cb) => ipcRenderer.on('shell:look', (e, color, theme) => cb(color, theme)),
  onMaximized: (cb) => ipcRenderer.on('shell:maximized', (e, on) => cb(on)),
  control: (action) => ipcRenderer.send('shell:control', action),
  onIcon: (cb) => ipcRenderer.on('shell:icon', (e, info) => cb(info)),
});
