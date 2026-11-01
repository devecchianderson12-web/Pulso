const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  unread: () => ipcRenderer.invoke('shell:unread'),
  onUnread: (cb) => ipcRenderer.on('shell:unread', (e, count) => cb(count)),
  menu: (x, y) => ipcRenderer.send('shell:menu', x, y),
});
