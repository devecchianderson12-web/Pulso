// Bridges WhatsApp Web's page and Pulso, and loads page.js before WhatsApp's own scripts run.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const { code, sound, lite } = ipcRenderer.sendSync('pulso:page');

contextBridge.exposeInMainWorld('pulso', {
  sound,
  lite,
  focus: () => ipcRenderer.send('pulso:focus'),
  notified: () => ipcRenderer.send('pulso:notified'),
  update: (action) => ipcRenderer.send('update:action', action),
  updateState: () => ipcRenderer.invoke('update:get'),
});

// Reach the page as DOM events: strings cross the isolated worlds safely.
ipcRenderer.on('pulso:lite', (e, on) => {
  window.dispatchEvent(new CustomEvent('pulso-lite', { detail: on ? '1' : '0' }));
});
ipcRenderer.on('pulso:update-state', (e, state) => {
  window.dispatchEvent(new CustomEvent('pulso-update', { detail: JSON.stringify(state) }));
});

webFrame.executeJavaScript(code);
