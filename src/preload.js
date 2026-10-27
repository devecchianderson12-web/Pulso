// Bridges WhatsApp Web's notifications to the desktop window: clicking a
// notification brings Whatsdesk to the front even when it sits in the tray.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('whatsdesk', {
  focus: () => ipcRenderer.send('whatsdesk:focus'),
  notified: () => ipcRenderer.send('whatsdesk:notified'),
});

const fs = require('fs');
const path = require('path');

webFrame.executeJavaScript(fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8'));

// Synchronous so the patch is in place before WhatsApp's own scripts run.
const { notificationSound } = ipcRenderer.sendSync('whatsdesk:settings');
webFrame.executeJavaScript(`(() => {
    const Native = window.Notification;
    if (!Native || Native.__whatsdesk) return;
    class WhatsdeskNotification extends Native {
      constructor(title, options = {}) {
        super(title, { ...options, silent: ${!notificationSound} || options.silent });
        window.whatsdesk.notified();
        this.addEventListener('click', () => window.whatsdesk.focus());
      }
    }
    WhatsdeskNotification.__whatsdesk = true;
    Object.defineProperty(WhatsdeskNotification, 'permission', { get: () => Native.permission });
    WhatsdeskNotification.requestPermission = (...a) => Native.requestPermission(...a);
    window.Notification = WhatsdeskNotification;
  })();`);
