const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  info: () => ipcRenderer.invoke('shell:info'),
  onUnread: (cb) => ipcRenderer.on('shell:unread', (e, count) => cb(count)),
  menu: (x, y) => ipcRenderer.send('shell:menu', x, y),
});
