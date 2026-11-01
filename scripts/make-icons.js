// Regenerates assets/icon.ico (every Windows size) and assets/icon.png from src/icons.js.
//   node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { markPng } = require('../src/icons');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

// A PNG per size, so Windows never has to rescale.
function icoBuffer(sizes) {
  const images = sizes.map((s) => markPng(s));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4);  // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'icon.ico'), icoBuffer(ICO_SIZES));
fs.writeFileSync(path.join(assets, 'icon.png'), markPng(512));
console.log('assets/icon.ico y assets/icon.png generados');
