// A minimal ZIP writer — enough to bundle a training export.
//
// No dependency, because none is warranted. Every file here is a JPEG or
// JSONL: JPEGs are already compressed and would gain nothing from deflate,
// and the JSONL is a rounding error next to the photos. So this writes
// STORE-only entries (method 0), which needs no compressor at all — just the
// headers, a CRC32, and the offsets bookkeeping.
//
// Format, per PKWARE APPNOTE:
//   [local header + data] × n
//   [central directory entry] × n
//   [end of central directory]
//
// Deliberately not supported: ZIP64 (so the archive must stay under 4 GiB and
// 65,535 entries), encryption, and directory entries. The caller caps the
// export size well below any of those, and a silently-wrong archive would be
// worse than a refusal — so writeZip throws rather than truncating.

import { PublicError } from "@/lib/apiError";

const MAX_ENTRIES = 65_535;
const MAX_BYTES = 0xffffffff;

/** CRC32, table-driven. Built once on first use rather than at module load —
 *  most requests never make a zip. */
let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      // 0xEDB88320 is the reversed polynomial ZIP uses.
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, e.g. "images/abc-front.jpg". Forward slashes. */
  name: string;
  data: Uint8Array;
}

/** DOS date/time. Nobody reads these, but a zero here makes some tools
 *  report the file as being from 1979, which looks like corruption. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a ZIP archive. `at` timestamps every entry (passed in rather than
 *  read here so the output is reproducible when a caller wants that). */
export function writeZip(entries: ZipEntry[], at: Date = new Date()): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new PublicError(`A zip holds at most ${MAX_ENTRIES} files without ZIP64 (${entries.length} given).`);
  }

  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(at);

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed (2.0)
    // Bit 11: names are UTF-8. Card names reach these paths, and without it
    // a non-ASCII name decodes as CP437 mojibake.
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); // method 0 = store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed
    lv.setUint32(22, size, true); // uncompressed
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // offset of local header
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
    if (offset > MAX_BYTES) {
      throw new PublicError("Archive exceeds 4 GiB — export in smaller batches.");
    }
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  ev.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(end, p);
  return out;
}
