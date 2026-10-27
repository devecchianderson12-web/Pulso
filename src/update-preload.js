const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  get: () => ipcRenderer.invoke('update:get'),
  onState: (cb) => ipcRenderer.on('update:state', (e, state) => cb(state)),
  onClose: (cb) => ipcRenderer.on('update:close', () => cb()),
  action: (name) => ipcRenderer.send('update:action', name),
  closed: () => ipcRenderer.send('update:closed'),
});
