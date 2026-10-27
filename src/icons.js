// Draws Pulso's icons as vector shapes (signed distance fields), rendered at each exact pixel
// size with analytic anti-aliasing, so edges stay smooth at 16 px and at 256 px alike.
const path = require('path');
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
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Shapes (unit square, y down). Each returns the signed distance to its edge. ----------

function segDist(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// Stroked polyline with round caps and joins.
function stroke(points, width) {
  return (x, y) => {
    let d = Infinity;
    for (let i = 0; i < points.length - 1; i++) d = Math.min(d, segDist(x, y, points[i], points[i + 1]));
    return d - width / 2;
  };
}

const C = [0.535, 0.465];
const RING = 0.355;
const ringPoint = (deg) => [C[0] + RING * Math.cos(deg * Math.PI / 180), C[1] + RING * Math.sin(deg * Math.PI / 180)];
// The ring opens between these angles, where the speech tail joins it.
const GAP_FROM = 110;
const GAP_TO = 142;
const TAIL = [ringPoint(GAP_TO), [0.105, 0.925], ringPoint(GAP_FROM)];
const PULSE = [[0.3, 0.48], [0.405, 0.48], [0.462, 0.325], [0.545, 0.635], [0.602, 0.44], [0.642, 0.505], [0.77, 0.505]];

function markShape(weight) {
  const w = 0.088 * weight;
  const tail = stroke(TAIL, w);
  const line = stroke(PULSE, 0.072 * weight);
  return (x, y) => {
    const ang = (Math.atan2(y - C[1], x - C[0]) * 180) / Math.PI;
    const ring = ang > GAP_FROM && ang < GAP_TO
      ? Infinity
      : Math.abs(Math.hypot(x - C[0], y - C[1]) - RING) - w / 2;
    return Math.min(ring, tail(x, y), line(x, y));
  };
}

// Pulse-green gradient from top-left to bottom-right.
function markColor(x, y) {
  const t = Math.max(0, Math.min(1, (x + y) / 2));
  return [44 - 28 * t, 235 - 53 * t, 154 - 39 * t];
}

// Digits as strokes in a 0.6 x 1 box.
const DIGITS = {
  0: [[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]]],
  1: [[[0.12, 0.2], [0.34, 0], [0.34, 1]]],
  2: [[[0, 0], [0.6, 0], [0.6, 0.5], [0, 0.5], [0, 1], [0.6, 1]]],
  3: [[[0, 0], [0.6, 0], [0.6, 1], [0, 1]], [[0.06, 0.5], [0.6, 0.5]]],
  4: [[[0, 0], [0, 0.55], [0.6, 0.55]], [[0.6, 0], [0.6, 1]]],
  5: [[[0.6, 0], [0, 0], [0, 0.5], [0.6, 0.5], [0.6, 1], [0, 1]]],
  6: [[[0.6, 0], [0, 0], [0, 1], [0.6, 1], [0.6, 0.5], [0, 0.5]]],
  7: [[[0, 0], [0.6, 0], [0.25, 1]]],
  8: [[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]], [[0, 0.5], [0.6, 0.5]]],
  9: [[[0.6, 0.5], [0, 0.5], [0, 0], [0.6, 0], [0.6, 1], [0, 1]]],
  '+': [[[0.3, 0.12], [0.3, 0.88]], [[-0.08, 0.5], [0.68, 0.5]]],
};

// Text centered at (cx, cy) with the given height, as one distance function.
function textShape(text, cx, cy, h) {
  const gap = 0.35;
  const width = (text.length * 0.6 + (text.length - 1) * gap) * h;
  const strokes = [];
  [...text].forEach((ch, i) => {
    const ox = cx - width / 2 + i * (0.6 + gap) * h;
    for (const line of DIGITS[ch]) {
      strokes.push(stroke(line.map(([px, py]) => [ox + px * h, cy - h / 2 + py * h]), h * 0.2));
    }
  });
  return (x, y) => Math.min(...strokes.map((s) => s(x, y)));
}

const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

// ---------- Rendering ----------

// Layers are drawn bottom to top: { shape, color: [r,g,b] | (x,y)=>[r,g,b], erase? }.
function render(size, layers) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size, y = (j + 0.5) / size;
      let r = 0, g = 0, b = 0, a = 0;
      for (const layer of layers) {
        const cov = Math.max(0, Math.min(1, 0.5 - layer.shape(x, y) / aa));
        if (cov <= 0) continue;
        if (layer.erase) { r *= 1 - cov; g *= 1 - cov; b *= 1 - cov; a *= 1 - cov; continue; }
        const [cr, cg, cb] = typeof layer.color === 'function' ? layer.color(x, y) : layer.color;
        r = cr * cov + r * (1 - cov); g = cg * cov + g * (1 - cov); b = cb * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const k = (j * size + i) * 4;
      if (a > 0) {
        px[k] = Math.round(r / a); px[k + 1] = Math.round(g / a); px[k + 2] = Math.round(b / a);
        px[k + 3] = Math.round(a * 255);
      }
    }
  }
  return encodePng(size, px);
}

// Thicker strokes at small sizes keep the mark legible.
const weightFor = (size) => (size <= 20 ? 1.35 : size <= 32 ? 1.18 : 1);

function markPng(size) {
  return render(size, [{ shape: markShape(weightFor(size)), color: markColor }]);
}

const RED = [229, 57, 53];
const WHITE = [255, 255, 255];

function badgeLabel(count) {
  return count > 99 ? '99+' : String(count);
}

// Mark with a red counter in the lower-right corner, cut out from the mark behind it.
function trayPng(size, count) {
  if (!count) return markPng(size);
  const label = count > 9 ? '+' : String(count);
  return render(size, [
    { shape: markShape(weightFor(size)), color: markColor },
    { shape: circle(0.72, 0.72, 0.335), erase: true },
    { shape: circle(0.72, 0.72, 0.28), color: RED },
    { shape: textShape(label, 0.72, 0.72, 0.3), color: WHITE },
  ]);
}

// Taskbar overlay: red circle with the count.
function overlayPng(size, count) {
  const label = badgeLabel(count);
  const h = label.length > 2 ? 0.26 : label.length > 1 ? 0.4 : 0.5;
  return render(size, [
    { shape: circle(0.5, 0.5, 0.48), color: RED },
    { shape: textShape(label, 0.5, 0.5, h), color: WHITE },
  ]);
}

// Windows icon (.ico) holding a PNG per size, so Windows never has to rescale.
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

// One native image with a representation per DPI scale, for 16-px tray and overlay icons.
const SCALES = [1, 1.25, 1.5, 2, 2.5, 3];
function multiScale(draw) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createEmpty();
  for (const scaleFactor of SCALES) img.addRepresentation({ scaleFactor, buffer: draw(Math.round(16 * scaleFactor)) });
  return img;
}

const trayIcon = (count) => multiScale((s) => trayPng(s, count));
const overlayIcon = (count) => multiScale((s) => overlayPng(s, count));

function windowIcon() {
  const { nativeImage } = require('electron');
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.ico'));
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

module.exports = { markPng, icoBuffer, ICO_SIZES, trayIcon, overlayIcon, windowIcon, badgeLabel, trayPng, overlayPng };
