// Generates the PWA icons (goal 08) with pngjs: a rounded square in the novice ink colour with the
// Kora "↗" mark. Run: node apps/web/scripts/make-icons.mjs (outputs are committed in public/icons).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BG = [0x1c, 0x24, 0x30];
const FG = [0xf7, 0xf5, 0xf0];
const ACCENT = [0x6f, 0x8c, 0xff];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function icon(size, { maskable }) {
  const png = new PNG({ width: size, height: size });
  const pad = maskable ? 0 : size * 0.06; // maskable icons fill the whole square (safe zone inside)
  const radius = maskable ? 0 : size * 0.22;
  const inner = maskable ? 0.28 : 0.24; // arrow sits inside the maskable safe zone (80 % circle)
  const s = size;
  // Mark: a rising line with an arrow head, top right.
  const a = [s * inner, s * (1 - inner)];
  const b = [s * (1 - inner), s * inner];
  const w = s * 0.075;
  const head = s * 0.2;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      // Rounded-square mask.
      const cx = Math.min(Math.max(x, pad + radius), s - pad - radius);
      const cy = Math.min(Math.max(y, pad + radius), s - pad - radius);
      const inside =
        x >= pad &&
        y >= pad &&
        x < s - pad &&
        y < s - pad &&
        Math.hypot(x - cx, y - cy) <= radius + 0.5;
      if (!inside) {
        png.data[i + 3] = 0;
        continue;
      }
      let c = BG;
      const onShaft = distToSegment(x, y, a[0], a[1], b[0], b[1]) <= w / 2;
      const onHeadA = distToSegment(x, y, b[0], b[1], b[0] - head, b[1]) <= w / 2;
      const onHeadB = distToSegment(x, y, b[0], b[1], b[0], b[1] + head) <= w / 2;
      if (onShaft) c = FG;
      if (onHeadA || onHeadB) c = ACCENT;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon-192.png'), icon(192, { maskable: false }));
writeFileSync(resolve(OUT, 'icon-512.png'), icon(512, { maskable: false }));
writeFileSync(resolve(OUT, 'maskable-512.png'), icon(512, { maskable: true }));
writeFileSync(resolve(OUT, 'apple-touch-icon.png'), icon(180, { maskable: true }));
console.log(`icons written to ${OUT}`);
