// Render the 128×128 marketplace icon as a pure-PNG file using only Node
// built-in modules. Produces media/icon.png — a GraphQL-style pink hexagon
// with six vertex dots, outer edges, and the two overlaid triangles that
// give the logo its "network" feel.
//
// Run with `node scripts/generate-icon.mjs`. Re-run whenever the icon
// geometry or palette changes. The output is committed so extension users
// don't need Node to see the icon.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'media', 'icon.png');

const W = 128;
const H = 128;
const PX = new Uint8Array(W * H * 4);

// GraphQL pink.
const PINK = [0xE5, 0x35, 0xAB, 255];
// Slightly darker pink for anti-aliased outlines — avoids a ragged halo.
const DEEP = [0xB6, 0x1F, 0x86, 255];

function blend(dst, src, a) {
  // Pre-multiplied alpha over compositing for smoother edges.
  const inv = (255 - a) / 255;
  dst[0] = Math.round(dst[0] * inv + src[0] * (a / 255));
  dst[1] = Math.round(dst[1] * inv + src[1] * (a / 255));
  dst[2] = Math.round(dst[2] * inv + src[2] * (a / 255));
  dst[3] = Math.min(255, dst[3] + a);
}

function paint(x, y, color, alpha = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const idx = (y * W + x) * 4;
  const dst = [PX[idx], PX[idx + 1], PX[idx + 2], PX[idx + 3]];
  blend(dst, color, alpha);
  PX[idx] = dst[0]; PX[idx + 1] = dst[1]; PX[idx + 2] = dst[2]; PX[idx + 3] = dst[3];
}

function disk(cx, cy, r, color) {
  const rMax = r + 1.5;
  for (let y = Math.floor(cy - rMax); y <= Math.ceil(cy + rMax); y++) {
    for (let x = Math.floor(cx - rMax); x <= Math.ceil(cx + rMax); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r - 0.5) paint(x, y, color, 255);
      else if (d <= r + 0.5) paint(x, y, color, Math.round((r + 0.5 - d) * 255));
    }
  }
}

// Thick anti-aliased segment via distance-to-segment shading.
function segment(x0, y0, x1, y1, thickness, color) {
  const padding = thickness + 2;
  const minX = Math.floor(Math.min(x0, x1) - padding);
  const maxX = Math.ceil(Math.max(x0, x1) + padding);
  const minY = Math.floor(Math.min(y0, y1) - padding);
  const maxY = Math.ceil(Math.max(y0, y1) + padding);
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1;
  const half = thickness / 2;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      let t = (px * vx + py * vy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const cx = x0 + t * vx;
      const cy = y0 + t * vy;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= half - 0.5) paint(x, y, color, 255);
      else if (d <= half + 0.5) paint(x, y, color, Math.round((half + 0.5 - d) * 255));
    }
  }
}

// Regular hexagon, point-up, centered on canvas.
const cx = W / 2;
const cy = H / 2;
const R = 50; // vertex distance from center
const verts = [];
for (let i = 0; i < 6; i++) {
  const angleDeg = 90 + i * 60; // start at the top vertex
  const a = (angleDeg * Math.PI) / 180;
  verts.push([cx + R * Math.cos(a), cy - R * Math.sin(a)]);
}

// Inner "network" diagonals — every second vertex, matching the GraphQL
// logo's two overlapping triangles.
const edgeThickness = 3.2;
const diagThickness = 2.2;

// Hexagon outline.
for (let i = 0; i < 6; i++) {
  const [x0, y0] = verts[i];
  const [x1, y1] = verts[(i + 1) % 6];
  segment(x0, y0, x1, y1, edgeThickness, DEEP);
}

// Diagonals: connect v0→v2→v4→v0 and v1→v3→v5→v1.
const diagPairs = [[0, 2], [2, 4], [4, 0], [1, 3], [3, 5], [5, 1]];
for (const [a, b] of diagPairs) {
  const [x0, y0] = verts[a];
  const [x1, y1] = verts[b];
  segment(x0, y0, x1, y1, diagThickness, PINK);
}

// Vertex dots — slightly bigger so they dominate visually at small sizes.
for (const [x, y] of verts) {
  disk(x, y, 6.5, PINK);
  disk(x, y, 4.2, DEEP);
}

// ----- PNG encoding -----

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, crc]);
}

// Build scanlines with filter byte 0 (None) per row.
const scanlines = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  scanlines[y * (1 + W * 4)] = 0;
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4;
    const dst = y * (1 + W * 4) + 1 + x * 4;
    scanlines[dst] = PX[src];
    scanlines[dst + 1] = PX[src + 1];
    scanlines[dst + 2] = PX[src + 2];
    scanlines[dst + 3] = PX[src + 3];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

const magic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const png = Buffer.concat([
  magic,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
console.log(`Wrote ${OUT} (${png.length} bytes)`);
