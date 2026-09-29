#!/usr/bin/env node
/**
 * sparkDash PWA icon generator — dependency-free.
 *
 * Draws the CURRENT brand look: the amber outline bolt (stroke #e8a830,
 * width 2, round joins — exactly the inline SVG favicon) on a TRANSPARENT
 * canvas, matching the icon on the operator's home screen. No tile, no fill.
 * The generated PNGs are committed; rerun and commit when the logo changes:
 *
 *   node scripts/make-pwa-icons.mjs
 *
 * Output (public/icons/) — every variant keeps the transparent canvas;
 * Android composites transparency over the wallpaper, which is the look the
 * operator has on their home screen:
 *   icon-192.png           manifest "any"      — outline bolt, full canvas
 *   icon-512.png           manifest "any"      — same, large canvas
 *   icon-maskable-512.png  manifest "maskable" — same bolt shrunk into the
 *        OS 80% safe zone with the stroke scaled to match the same visual
 *        weight (launchers prefer maskable over any — this one must look
 *        right, or the phone shows a tile instead of the bare bolt)
 *   apple-touch-icon.png   iOS — transparent canvas (iOS composites on black)
 *
 * Rendering: 4x supersampled signed-distance stroke fill (|distance to the
 * bolt polygon boundary| ≤ half stroke width), box-downsampled — round caps
 * and joins fall out of the distance field for free.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "icons");

// ─── Brand geometry ────────────────────────────────────────
// Lucide "zap" bolt outline, viewBox 24×24, as the closed polyline the SVG
// path M13 2 L3 14 h9 l-1 8 L21 10 h-9 l1 -8 z traces.
const BOLT = [
  [13, 2], [3, 14], [12, 14], [11, 22], [21, 10], [12, 10],
];
const STROKE = 2; // viewBox units, same as the favicon's stroke-width

const BOLT_RGB = [0xe8, 0xa8, 0x30]; // #e8a830 — the one brand amber
// (no tile/background color: the brand mark is a bare outline on transparency)

/** Distance from point p to the bolt polygon boundary (viewBox units). */
function boltDistance(px, py) {
  let best = Infinity;
  for (let i = 0; i < BOLT.length; i++) {
    const [ax, ay] = BOLT[i];
    const [bx, by] = BOLT[(i + 1) % BOLT.length];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    const d = qx * qx + qy * qy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ─── Rasterize one icon ────────────────────────────────────
/**
 * @param {number} size      output px
 * @param {object} opts
 *   glyphFrac:   fraction of the canvas the bolt's 24-unit box occupies
 *                (1 = favicon-like full bleed; maskable shrinks into the
 *                OS safe zone)
 *   strokeFrac:  stroke width as a fraction of the canvas; scale it with
 *                glyphFrac to keep the line's weight relative to the bolt
 */
function renderIcon(size, { glyphFrac, strokeFrac = (STROKE / 24) * glyphFrac }) {
  const SS = 4; // supersample factor
  const H = size * SS;
  const s = (glyphFrac * size) / 24; // viewBox units → canvas units
  const off = (size * (1 - glyphFrac)) / 2; // bolt box top-left on the canvas
  const halfW = (strokeFrac * size) / 2 / s; // stroke half-width, viewBox units

  // Per-subpixel stroke coverage (0..1). 1D distance-field AA at supersample
  // resolution; the box downsample below turns it into final edge coverage.
  const cov = new Float32Array(H * H);
  for (let hy = 0; hy < H; hy++) {
    const vy = (hy / SS - off) / s;
    for (let hx = 0; hx < H; hx++) {
      const vx = (hx / SS - off) / s;
      const d = boltDistance(vx, vy) - halfW;
      cov[hy * H + hx] = Math.max(0, Math.min(1, 0.5 - d * s * SS));
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const inv = 1 / (SS * SS);
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) sum += cov[(oy * SS + dy) * H + ox * SS + dx];
      }
      const c = sum * inv; // cell mean coverage
      const alpha = Math.round(c * 255);
      if (alpha < 1) continue; // transparent background
      const p = (oy * size + ox) * 4;
      out[p] = BOLT_RGB[0];
      out[p + 1] = BOLT_RGB[1];
      out[p + 2] = BOLT_RGB[2];
      out[p + 3] = alpha;
    }
  }
  return encodePng(size, out);
}

// ─── Minimal PNG encoder ───────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Emit the set ──────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const jobs = [
  // Bolt fills the canvas like the favicon (its box is 20/24 of the height).
  ["icon-192.png", 192, { glyphFrac: 1 }],
  ["icon-512.png", 512, { glyphFrac: 1 }],
  // Maskable: Android prefers it over "any"; shrunk into the safe zone with
  // glyph-relative stroke so it reads identical to the home-screen original.
  ["icon-maskable-512.png", 512, { glyphFrac: 0.66 }],
  // iOS rounds a full-bleed square and composites transparency on black.
  ["apple-touch-icon.png", 180, { glyphFrac: 1 }],
];
for (const [name, size, opts] of jobs) {
  writeFileSync(join(OUT_DIR, name), renderIcon(size, opts));
  console.log(`${name}  ${size}x${size}`);
}
