#!/usr/bin/env node
/**
 * sparkDash PWA icon generator — dependency-free.
 *
 * Draws the brand mark: the amber outline bolt (stroke #e8a830, width 2,
 * round joins — exactly the inline SVG favicon) on a FULLY OPAQUE dark tile
 * (#0d1117, the app's theme color). The generated PNGs are committed; rerun
 * and commit when the logo changes:
 *
 *   node scripts/make-pwa-icons.mjs
 *
 * Why an opaque tile (this flip-flopped twice — the rationale, with the
 * evidence, so it sticks):
 *   - Transparent canvases do NOT render transparent on phones. Chrome's
 *     adaptive-icon generation and iOS both composite the alpha over WHITE
 *     — the 2026-09-29 home screen showed exactly that: white rounded
 *     square with the amber bolt.
 *   - The only deterministic look is a fully opaque icon: the dark tile
 *     here, matching every other dark icon on the operator's home screen.
 *
 * Output (public/icons/) — one geometry for every variant, so the icon
 * reads identical however the launcher masks it:
 *   icon-192.png / icon-512.png   manifest "any"      — bolt centered
 *   icon-maskable-512.png         manifest "maskable" — same, and spec-legal:
 *        the opaque tile fills the canvas, the bolt sits inside the safe zone
 *   apple-touch-icon.png          iOS — opaque (transparency ⇒ white tile)
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
const BG_RGB = [0x0d, 0x11, 0x17];   // #0d1117 — theme color; launchers paint
// transparency white, so the tile must be dark AND opaque, never alpha.

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
 *                (0.66 = inside the OS maskable safe zone)
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
      const p = (oy * size + ox) * 4;
      // Opaque dark tile; the amber stroke alpha-blends over it.
      out[p] = Math.round(BG_RGB[0] + (BOLT_RGB[0] - BG_RGB[0]) * c);
      out[p + 1] = Math.round(BG_RGB[1] + (BOLT_RGB[1] - BG_RGB[1]) * c);
      out[p + 2] = Math.round(BG_RGB[2] + (BOLT_RGB[2] - BG_RGB[2]) * c);
      out[p + 3] = 255;
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
const GLYPH = 0.66; // one geometry for every variant → identical look under
// any launcher mask; the bolt's 24-unit box occupies 66% of the canvas.
const jobs = [
  ["icon-192.png", 192, { glyphFrac: GLYPH }],
  ["icon-512.png", 512, { glyphFrac: GLYPH }],
  // Maskable safe zone is the center ~66% — GLYPH is already inside it, and
  // the opaque tile satisfies the fill-the-canvas requirement.
  ["icon-maskable-512.png", 512, { glyphFrac: GLYPH }],
  ["apple-touch-icon.png", 180, { glyphFrac: GLYPH }],
];
for (const [name, size, opts] of jobs) {
  writeFileSync(join(OUT_DIR, name), renderIcon(size, opts));
  console.log(`${name}  ${size}x${size}`);
}
