// Draws the app icon (the nine-bar pulse with an orange centre bar) into desktop/assets/icon.png.
// A tiny PNG writer: no image tools needed. Run with `node scripts/make-icon.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const BARS = [3, 7, 11, 8, 16, 8, 11, 7, 3];
const px = new Uint8Array(SIZE * SIZE * 4);

const mix = (a, b, t) => Math.round(a + (b - a) * t);
const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const margin = SIZE * 0.06;
const corner = SIZE * 0.22;
const unit = 40;
const barW = 36;
const gap = (SIZE - 2 * margin - BARS.length * barW) / (BARS.length + 1) / 1.1;
const total = BARS.length * barW + (BARS.length - 1) * gap;
const left = (SIZE - total) / 2;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundedRect(x, y, margin, margin, SIZE - margin, SIZE - margin, corner)) continue;
    // A dark room with a faint warm glow at the bottom.
    const glow = Math.max(0, 1 - Math.hypot(x - SIZE / 2, y - SIZE * 1.05) / (SIZE * 0.75));
    let r = mix(14, 60, glow * 0.7);
    let g = mix(13, 28, glow * 0.7);
    let b = mix(14, 20, glow * 0.7);
    BARS.forEach((h, n) => {
      const x0 = left + n * (barW + gap);
      const bh = (h / 16) * (SIZE * 0.5);
      const y0 = (SIZE - bh) / 2;
      if (inRoundedRect(x, y, x0, y0, x0 + barW, y0 + bh, barW / 2)) {
        const core = n === Math.floor(BARS.length / 2);
        const fade = 1 - Math.abs(n - 4) * 0.12;
        [r, g, b] = core ? [255, 106, 61] : [mix(r, 238, fade), mix(g, 237, fade), mix(b, 232, fade)];
      }
    });
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
}
void unit;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4); header[8] = 8; header[9] = 6;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
