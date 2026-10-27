// Bridges WhatsApp Web's page and Pulso: notification clicks bring Pulso to the front even
// when it sits in the tray, and the update banner talks to the updater.
const fs = require('fs');
const path = require('path');
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Synchronous so everything is in place before WhatsApp's own scripts run.
const { notificationSound, lite } = ipcRenderer.sendSync('pulso:settings');

contextBridge.exposeInMainWorld('pulso', {
  lite,
  focus: () => ipcRenderer.send('pulso:focus'),
  notified: () => ipcRenderer.send('pulso:notified'),
  update: (action) => ipcRenderer.send('update:action', action),
  pendingUpdate: () => ipcRenderer.invoke('update:get'),
});

ipcRenderer.on('pulso:lite', (e, lite) => {
  window.dispatchEvent(new CustomEvent('pulso-lite', { detail: lite ? '1' : '0' }));
});

// Update states reach the page as a DOM event (strings cross the isolated worlds safely).
ipcRenderer.on('pulso:update-state', (e, state) => {
  window.dispatchEvent(new CustomEvent('pulso-update', { detail: JSON.stringify(state) }));
});

webFrame.executeJavaScript(fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8'));

webFrame.executeJavaScript(`(() => {
    const Native = window.Notification;
    if (!Native || Native.__pulso) return;
    class PulsoNotification extends Native {
      constructor(title, options = {}) {
        super(title, { ...options, silent: ${!notificationSound} || options.silent });
        window.pulso.notified();
        this.addEventListener('click', () => window.pulso.focus());
      }
    }
    PulsoNotification.__pulso = true;
    Object.defineProperty(PulsoNotification, 'permission', { get: () => Native.permission });
    PulsoNotification.requestPermission = (...a) => Native.requestPermission(...a);
    window.Notification = PulsoNotification;
  })();`);
