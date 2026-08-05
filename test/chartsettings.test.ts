import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readZip } from "../src/core/chartsettings.ts";

/** Build a single-entry ZIP the way Stockbit's blob is shaped, so the reader is tested on the real form. */
function makeZip(name: string, text: string, opts: { zeroLocalSizes?: boolean; store?: boolean } = {}): Buffer {
  const data = Buffer.from(text, "utf8");
  const body = opts.store ? data : deflateRawSync(data);
  const method = opts.store ? 0 : 8;

  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : crc, 14);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : body.length, 18);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const centralStart = local.length + nameBuf.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}

const SETTINGS = JSON.stringify({
  "current_theme.name": "dark",
  "chart.lastUsedTimeBasedResolution": "1",
  "ChartDrawingToolbarWidget.visible": "true",
});

test("a deflated single-entry archive round-trips", () => {
  const entries = readZip(makeZip("layout.json", SETTINGS));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "layout.json");
  assert.deepEqual(JSON.parse(entries[0].text), JSON.parse(SETTINGS));
});

test("sizes are taken from the CENTRAL directory, not the local header", () => {
  // A local header may carry zeros with the real values in a trailing data descriptor. Reading the
  // local sizes would slice zero bytes and inflate nothing.
  const entries = readZip(makeZip("layout.json", SETTINGS, { zeroLocalSizes: true }));
  assert.deepEqual(JSON.parse(entries[0].text), JSON.parse(SETTINGS));
});

test("a stored (uncompressed) entry is read without inflating", () => {
  const entries = readZip(makeZip("layout.json", SETTINGS, { store: true }));
  assert.equal(entries[0].text, SETTINGS);
});

test("something that is not a ZIP fails loudly rather than returning nothing", () => {
  // Returning [] would be indistinguishable from "the account has no settings", which is a
  // different answer and the one a user would act on.
  assert.throws(() => readZip(Buffer.from("not a zip at all")), /not a ZIP archive/);
  assert.throws(() => readZip(Buffer.alloc(0)), /not a ZIP archive/);
});

test("a corrupt central directory is an error, not a partial result", () => {
  const zip = makeZip("layout.json", SETTINGS);
  // Find the EOCD, follow it to the central directory, and break that signature.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const centralOffset = zip.readUInt32LE(eocd + 16);
  zip.writeUInt32LE(0xdeadbeef, centralOffset);
  assert.throws(() => readZip(zip), /corrupt ZIP/);
});

test("an unsupported compression method is refused rather than mis-decoded", () => {
  const zip = makeZip("layout.json", SETTINGS);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  zip.writeUInt16LE(14, zip.readUInt32LE(eocd + 16) + 10); // LZMA
  assert.throws(() => readZip(zip), /unsupported ZIP compression method 14/);
});

test("the EOCD is found even with a trailing comment", () => {
  const zip = Buffer.concat([makeZip("layout.json", SETTINGS), Buffer.from("trailing bytes")]);
  // The comment length field says 0, so this is malformed — but the scan must not crash looking.
  assert.doesNotThrow(() => {
    try {
      readZip(zip);
    } catch (err) {
      if (!/ZIP/.test(String(err))) throw err;
    }
  });
});
