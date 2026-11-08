// Regenerates assets/icon.ico (every Windows size) and assets/icon.png from src/icons.js.
//   node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { markPng, icoBuffer } = require('../src/icons');

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'icon.ico'), icoBuffer());
fs.writeFileSync(path.join(assets, 'icon.png'), markPng(512));
console.log('assets/icon.ico y assets/icon.png generados');
