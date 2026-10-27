// Bridges WhatsApp Web's notifications to the desktop window: clicking a
// notification brings Pulso to the front even when it sits in the tray.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('pulso', {
  focus: () => ipcRenderer.send('pulso:focus'),
  notified: () => ipcRenderer.send('pulso:notified'),
});

const fs = require('fs');
const path = require('path');

webFrame.executeJavaScript(fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8'));

// Synchronous so the patch is in place before WhatsApp's own scripts run.
const { notificationSound } = ipcRenderer.sendSync('pulso:settings');
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
