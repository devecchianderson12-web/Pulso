// Generates the app, tray and badge icons at runtime as PNG buffers,
// so the project ships no binary image assets.
const zlib = require('zlib');

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Draws by sampling a coverage function (4x4 supersampling for smooth edges).
function render(size, shader) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const c = shader((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (a / 16) * 255;
      }
    }
  }
  return px;
}

const GREEN = [18, 140, 126, 1];
const WHITE = [255, 255, 255, 1];
const RED = [229, 57, 53, 1];

// 3x5 bitmap digits used for the unread counter.
const DIGITS = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

function textHit(text, u, v, cx, cy, h) {
  const cell = h / 5;
  const w = text.length * 3 * cell + (text.length - 1) * cell;
  const x0 = cx - w / 2, y0 = cy - h / 2;
  if (v < y0 || v >= y0 + h || u < x0 || u >= x0 + w) return false;
  const col = Math.floor((u - x0) / cell);
  const ch = Math.floor(col / 4), cc = col % 4;
  if (cc === 3) return false;
  const row = Math.floor((v - y0) / cell);
  return DIGITS[text[ch]][row][cc] === '1';
}

// Chat bubble with three dots: an original mark, not WhatsApp's logo.
function bubble(u, v) {
  const dx = u - 0.5, dy = v - 0.47;
  const inCircle = dx * dx + dy * dy <= 0.4 * 0.4;
  const inTail = v > 0.62 && v < 0.94 && u > 0.16 && u < 0.42 && (u - 0.16) > (v - 0.62) * 0.2 &&
    (0.42 - u) > (v - 0.62) * 0.81;
  if (!inCircle && !inTail) return null;
  for (const ox of [0.32, 0.5, 0.68]) {
    const ddx = u - ox, ddy = v - 0.47;
    if (ddx * ddx + ddy * ddy <= 0.055 * 0.055) return WHITE;
  }
  return GREEN;
}

function appIcon(size = 256) {
  return encodePng(size, render(size, bubble));
}

function badgeLabel(count) {
  return count > 99 ? '99+' : String(count);
}

// Tray icon: bubble plus a red counter in the lower-right corner.
function trayIcon(count, size = 32) {
  const label = count > 9 ? '+' : String(count);
  return encodePng(size, render(size, (u, v) => {
    if (count > 0) {
      const dx = u - 0.7, dy = v - 0.7;
      if (dx * dx + dy * dy <= 0.3 * 0.3) {
        return textHit(label, u, v, 0.7, 0.7, 0.32) ? WHITE : RED;
      }
    }
    return bubble(u, v);
  }));
}

// Taskbar overlay: red circle with the count.
function overlayIcon(count, size = 32) {
  const label = badgeLabel(count);
  const h = label.length > 2 ? 0.3 : 0.45;
  return encodePng(size, render(size, (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    if (dx * dx + dy * dy > 0.5 * 0.5) return null;
    return textHit(label, u, v, 0.5, 0.5, h) ? WHITE : RED;
  }));
}

module.exports = { appIcon, trayIcon, overlayIcon, badgeLabel };
