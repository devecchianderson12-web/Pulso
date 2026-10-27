const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  bounds: { width: 1200, height: 800 },
  maximized: false,
  closeToTray: true,
  startMinimized: false,
  launchAtLogin: false,
  notificationSound: true,
  flashOnMessage: true,
  spellcheck: true,
  spellcheckLanguages: ['es', 'en-US'],
  zoomFactor: 1,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');
let cache;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('No se pudo guardar la configuración:', err);
  }
}

module.exports = { get, set };
