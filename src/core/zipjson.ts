/**
 * The base64-ZIP-of-`layout.json` envelope Stockbit wraps its chart state in.
 *
 * Three different payloads use it — the account-wide chart settings blob
 * (GET /user-setting/configurations), a saved Chartbit layout (GET /chartbit/charts) and a chart's
 * drawings (GET /chartbit/chart-drawings) — because they all pass through the same helper pair in
 * Stockbit's bundle. Paths are written unquoted here on purpose: the first-path-segment guard in
 * `test/transport.test.ts` reads a quoted leading slash as a call site declaring its own route, and
 * it is right to, so prose spells them out instead. The archive holds exactly one file, named `layout.json`, deflated.
 *
 * The reader is a minimal ZIP parser rather than a dependency: the parts of the format that make
 * general unzipping hard — multi-entry central directories, ZIP64, encryption — are not present. It
 * reads the central directory rather than scanning local headers, because a local header may carry
 * sizes of 0 with the real values in a trailing data descriptor.
 *
 * The writer is hand-rolled for the same reason, and matches what Stockbit's JSZip call produces:
 * one stored-name entry, DEFLATE at level 9, no data descriptor. A round-trip through both halves is
 * asserted in `test/zipjson.test.ts`; that test is what makes a read-back comparison mean anything
 * on the write paths.
 */
import { crc32 } from "node:zlib";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/** The single file name Stockbit's client uses inside every one of these archives. */
export const ENTRY_NAME = "layout.json";

/**
 * Stockbit's own client-side ceiling on an encoded payload, in characters of base64.
 *
 * Taken from the bundle rather than invented. Exceeding it client-side is how a save turns into a
 * silent truncation on their side, so this project refuses first and says which limit it hit.
 */
export const MAX_ENCODED_CHARS = 46_725_732;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  text: string;
}

/**
 * Read every entry of a single-disk ZIP.
 *
 * Throws rather than returning partial results: a layout decoded from half an archive is worse than
 * an error, because it looks like a layout.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  // The EOCD is at the end, after a comment of unknown length, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error(`corrupt ZIP: bad central header at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    // Sizes come from the central directory; the local header's may be zero with the real values in
    // a trailing data descriptor. Its variable-length fields still have to be skipped, and they can
    // differ from the central ones.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    entries.push({ name, text: (method === 8 ? inflateRawSync(data) : data).toString("utf8") });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Build a one-entry ZIP the way Stockbit's JSZip call does.
 *
 * DOS date/time and the "made by" field are fixed constants rather than the current clock: two
 * encodes of the same layout must produce identical bytes, or a write's read-back comparison would
 * fail purely because a minute had passed.
 */
export function writeZip(name: string, text: string): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(text, "utf8");
  const deflated = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt16LE(0, 10); // dos time — fixed, see the note above
  local.writeUInt16LE(0x21, 12); // dos date — 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_SIG, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const centralOffset = local.length + nameBytes.length + deflated.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, eocd]);
}

/**
 * Decode a base64 ZIP into the object its `layout.json` holds.
 *
 * Returns `null` for an empty blob — the account genuinely has nothing saved — and throws for a blob
 * that is present but undecodable. Those are different answers and only one of them means "nothing
 * saved"; collapsing them is how a decode bug gets reported to a user as an empty chart.
 */
export function decodeZipJson(encoded: string): unknown {
  if (!encoded) return null;
  const entries = readZip(Buffer.from(encoded, "base64"));
  const entry = entries.find((e) => e.name === ENTRY_NAME) ?? entries[0];
  if (!entry) throw new Error("archive contained no entries");
  return JSON.parse(entry.text) as unknown;
}

/** Encode an object as the base64 ZIP envelope. Refuses a payload past Stockbit's own client cap. */
export function encodeZipJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("value is not serialisable");
  const encoded = writeZip(ENTRY_NAME, text).toString("base64");
  if (encoded.length > MAX_ENCODED_CHARS) {
    throw new Error(
      `Encoded payload is ${encoded.length} characters, past Stockbit's own ${MAX_ENCODED_CHARS}-character ` +
        "client limit. Sending it would be truncated server-side rather than rejected.",
    );
  }
  return encoded;
}
