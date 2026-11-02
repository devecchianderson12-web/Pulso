// Bridges WhatsApp Web's page and Pulso, and loads page.js before WhatsApp's own scripts run.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const { code, sound, lite, theme } = ipcRenderer.sendSync('pulso:page');

contextBridge.exposeInMainWorld('pulso', {
  sound,
  lite,
  theme,
  focus: () => ipcRenderer.send('pulso:focus'),
  notified: () => ipcRenderer.send('pulso:notified'),
  update: (action) => ipcRenderer.send('update:action', action),
  updateState: () => ipcRenderer.invoke('update:get'),
  options: () => ipcRenderer.invoke('pulso:options'),
  set: (key, value) => ipcRenderer.send('pulso:set', key, value),
  setGpu: (on) => ipcRenderer.send('pulso:gpu', on),
  setLanguage: (code, on) => ipcRenderer.send('pulso:language', code, on),
  action: (name) => ipcRenderer.send('pulso:action', name),
  saveTheme: (id, color) => ipcRenderer.send('pulso:theme', id, color),
});

// Reach the page as DOM events: strings cross the isolated worlds safely.
ipcRenderer.on('pulso:lite', (e, on) => {
  window.dispatchEvent(new CustomEvent('pulso-lite', { detail: on ? '1' : '0' }));
});
ipcRenderer.on('pulso:update-state', (e, state) => {
  window.dispatchEvent(new CustomEvent('pulso-update', { detail: JSON.stringify(state) }));
});

webFrame.executeJavaScript(code);
