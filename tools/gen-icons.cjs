// Generates the extension icons as PNGs with zero dependencies.
// Renders the brand mark as a floating bubble: gradient main bubble with a
// glossy sheen, a spark glyph, and a small satellite bubble — in 7 color themes.
// Usage: node tools/gen-icons.cjs
//
// Output:
//   icons/icon*.png                 → default (indigo) fallback set
//   icons/<theme>/icon*.png         → themes for chrome.action.setIcon switching

'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ themes

// from/to: gradient stops; mark: spark color; gloss: sheen strength;
// sat/satRing: satellite bubble fill + ring; edge: visibility ring (white theme).
const THEMES = {
  indigo:  { from: [129, 140, 248], to: [79, 70, 229],   mark: [255, 255, 255], gloss: 0.22, sat: [255, 255, 255], satRing: [79, 70, 229] },
  black:   { from: [46, 42, 35],    to: [10, 9, 8],      mark: [246, 240, 227], gloss: 0.18, sat: [246, 240, 227], satRing: [23, 21, 18] },
  white:   { from: [255, 255, 255], to: [231, 223, 208], mark: [23, 21, 18],    gloss: 0.55, sat: [23, 21, 18],   satRing: [255, 255, 255], edge: { color: [120, 112, 98], alpha: 0.45 } },
  sky:     { from: [56, 189, 248],  to: [2, 132, 199],   mark: [255, 255, 255], gloss: 0.28, sat: [255, 255, 255], satRing: [2, 132, 199] },
  emerald: { from: [52, 211, 153],  to: [5, 150, 105],   mark: [255, 255, 255], gloss: 0.28, sat: [255, 255, 255], satRing: [5, 150, 105] },
  rose:    { from: [251, 113, 133], to: [225, 29, 72],   mark: [255, 255, 255], gloss: 0.28, sat: [255, 255, 255], satRing: [225, 29, 72] },
  amber:   { from: [251, 191, 36],  to: [217, 119, 6],   mark: [255, 255, 255], gloss: 0.34, sat: [255, 255, 255], satRing: [217, 119, 6] }
};

const DEFAULT_THEME = 'indigo';

// ------------------------------------------------------------------ PNG encode

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// -------------------------------------------------------------------- SDF math

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Anti-aliased coverage of "inside when distance d < w" (px units, aa = edge width)
function cov(d, w, aa) {
  return clamp01((w - d) / aa + 0.5);
}

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
];

// Four-point spark: alternating outer- and inner-radius points.
const SPARK = [
  [0, -1], [0.26, -0.26], [1, 0], [0.26, 0.26],
  [0, 1], [-0.26, 0.26], [-1, 0], [-0.26, -0.26]
];

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 3×3 supersampled coverage for a small concave polygon (the spark).
function polyCoverage(px, py, pts, aa) {
  let hit = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      if (pointInPoly(px + (sx - 1) * aa * 0.5, py + (sy - 1) * aa * 0.5, pts)) hit++;
    }
  }
  return hit / 9;
}

// -------------------------------------------------------------------- drawing

function renderIcon(S, themeName) {
  const T = THEMES[themeName] || THEMES[DEFAULT_THEME];
  const rgba = Buffer.alloc(S * S * 4);
  const cx = S / 2, cy = S / 2;
  const r = S / 2 - Math.max(0.5, S * 0.03);
  const aa = Math.max(1.1, S / 32);
  const detail = S >= 32; // gloss + satellite only from 32px up

  // Spark mark (nudged up-left so the satellite stays clear at 32px+)
  const markCx = 0.465 * S, markCy = 0.44 * S, markR = 0.315 * S;
  const markPts = SPARK.map(([ux, uy]) => [markCx + ux * markR, markCy + uy * markR]);

  // Satellite bubble (bottom-right) — the "floating" companion
  const sat = { x: 0.80 * S, y: 0.79 * S, r: 0.14 * S, ring: 0.022 * S };
  // Gloss sheen ellipse (top-left)
  const gloss = { x: 0.36 * S, y: 0.28 * S, rx: 0.30 * S, ry: 0.185 * S };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;

      const dc = Math.hypot(px - cx, py - cy);
      const circleC = cov(dc, r, aa);
      if (circleC <= 0) continue;

      // Gradient base
      const t = clamp01((px + py) / (2 * S));
      let col = mix(T.from, T.to, t);

      // Visibility edge (white theme on light toolbars)
      if (T.edge) {
        const edgeC = cov(Math.abs(dc - r), Math.max(0.75, S * 0.03), aa);
        col = mix(col, T.edge.color, T.edge.alpha * edgeC);
      }

      // Gloss sheen
      if (detail) {
        const de = Math.hypot((px - gloss.x) / gloss.rx, (py - gloss.y) / gloss.ry);
        const glossC = cov((de - 1) * gloss.ry, 0, aa);
        if (glossC > 0) col = mix(col, [255, 255, 255], T.gloss * glossC);
      }

      // Spark
      const markC = polyCoverage(px, py, markPts, aa);
      if (markC > 0) col = mix(col, T.mark, markC);

      // Satellite bubble drawn on top
      if (detail) {
        const ds = Math.hypot(px - sat.x, py - sat.y);
        const fillC = cov(ds, sat.r, aa);
        if (fillC > 0) col = mix(col, T.sat, fillC);
        const ringC = cov(Math.abs(ds - sat.r), sat.ring, aa);
        if (ringC > 0) col = mix(col, T.satRing, ringC * 0.9);
      }

      const i = (y * S + x) * 4;
      rgba[i] = Math.round(col[0]);
      rgba[i + 1] = Math.round(col[1]);
      rgba[i + 2] = Math.round(col[2]);
      rgba[i + 3] = Math.round(circleC * 255);
    }
  }
  return encodePng(S, S, rgba);
}

// ---------------------------------------------------------------------- main

const outRoot = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outRoot, { recursive: true });

const SIZES = [16, 24, 32, 48, 128];

for (const [themeName, T] of Object.entries(THEMES)) {
  const dir = themeName === DEFAULT_THEME ? outRoot : path.join(outRoot, themeName);
  fs.mkdirSync(dir, { recursive: true });
  for (const size of SIZES) {
    const png = renderIcon(size, themeName);
    const file = path.join(dir, `icon${size}.png`);
    fs.writeFileSync(file, png);
    console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${png.length} bytes) [${themeName}]`);
  }
}
