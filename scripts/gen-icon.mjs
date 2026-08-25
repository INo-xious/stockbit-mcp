/**
 * Generate `mcpb/icon.png` — the Desktop Extension icon.
 *
 * Written by hand rather than committed as a binary blob, because a 512×512 PNG in the tree is a
 * thing nobody can review in a diff. Node's zlib is the only dependency; the PNG encoder below is
 * the minimum spec-compliant one: a single IHDR, one deflated IDAT of filter-0 scanlines, IEND.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const S = 512;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------- the drawing ------------------------------------- */

const BG = [14, 18, 28]; //  near-black, so it sits on a light or a dark shelf
const GREEN = [34, 197, 94];
const RED = [239, 68, 68];
const GREY = [71, 85, 105];

const px = Buffer.alloc(S * S * 4);

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // Source-over onto whatever is already there, so antialiased edges blend.
  const sa = a / 255;
  px[i] = Math.round(r * sa + px[i] * (1 - sa));
  px[i + 1] = Math.round(g * sa + px[i + 1] * (1 - sa));
  px[i + 2] = Math.round(b * sa + px[i + 2] * (1 - sa));
  px[i + 3] = Math.max(px[i + 3], Math.round(255 * sa));
}

function rect(x0, y0, w, h, colour) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, colour);
}

/** A rounded square, antialiased by sampling the corner distance. */
function roundedBackground(radius, colour) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.max(radius - x, x - (S - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (S - 1 - radius), 0);
      const d = Math.hypot(dx, dy);
      if (d <= radius - 1) set(x, y, colour);
      else if (d < radius) set(x, y, colour, Math.round((radius - d) * 255));
    }
  }
}

/** One candle: body between `open` and `close`, wick between `high` and `low`. */
function candle(cx, width, open, close, high, low, colour) {
  const wick = Math.max(4, Math.round(width * 0.16));
  rect(cx - Math.floor(wick / 2), high, wick, low - high, colour);
  const top = Math.min(open, close);
  rect(cx - Math.floor(width / 2), top, width, Math.max(Math.abs(close - open), wick), colour);
}

roundedBackground(96, BG);

// A grid line, so the candles read as a chart rather than as three bars.
for (let x = 64; x < S - 64; x += 6) rect(x, 384, 3, 3, GREY);

const W = 78;
candle(136, W, 300, 210, 176, 336, GREEN);
candle(256, W, 232, 292, 196, 340, RED);
candle(376, W, 288, 148, 112, 320, GREEN);

/* -------------------------------------- the encoder -------------------------------------- */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// 10–12 stay zero: deflate, adaptive filtering, no interlace.

// Filter byte 0 (None) in front of every scanline.
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(join(root, "mcpb"), { recursive: true });
const out = join(root, "mcpb", "icon.png");
writeFileSync(out, png);
console.log(`mcpb/icon.png written — ${S}×${S}, ${png.length} bytes.`);
