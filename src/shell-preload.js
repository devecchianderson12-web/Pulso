const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  state: () => ipcRenderer.invoke('shell:state'),
  onUnread: (cb) => ipcRenderer.on('shell:unread', (e, count) => cb(count)),
  onColor: (cb) => ipcRenderer.on('shell:color', (e, color) => cb(color)),
});
