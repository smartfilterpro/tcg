// A QR encoder, byte mode, error-correction level M, versions 1–6.
//
// Written rather than installed because the repo's rule is no new
// dependencies without asking, and the slice of QR needed here is small: one
// short URL, rendered once, on a page the user is already looking at.
// Versions stop at 6 deliberately — version 7 and up carry an extra 18-bit
// version block in two more places, and 6 already holds 122 bytes, far more
// than any friend link.
//
// Everything here is pure and synchronous, so it runs on the server or in the
// browser without ceremony.

/** Codewords, EC-per-block and block layout for level M. From the standard's
 *  error-correction table; the pair is (block count, total codewords per
 *  block) and data codewords are the remainder. */
const VERSIONS = [
  { version: 1, totalCodewords: 26, ecPerBlock: 10, blocks: [1, 26] },
  { version: 2, totalCodewords: 44, ecPerBlock: 16, blocks: [1, 44] },
  { version: 3, totalCodewords: 70, ecPerBlock: 26, blocks: [1, 70] },
  { version: 4, totalCodewords: 100, ecPerBlock: 18, blocks: [2, 50] },
  { version: 5, totalCodewords: 134, ecPerBlock: 24, blocks: [2, 67] },
  { version: 6, totalCodewords: 172, ecPerBlock: 16, blocks: [4, 43] },
] as const;

/** Alignment-pattern centre coordinates per version (none for version 1). */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

// ---------------------------------------------------------------- GF(256)
// The field is GF(2^8) modulo 0x11D, the primitive polynomial QR specifies.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** The generator polynomial for `degree` error-correction codewords:
 *  (x - α^0)(x - α^1)…(x - α^(degree-1)). */
export function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division; the remainder is the EC codewords. */
export function ecCodewords(data: number[], degree: number): number[] {
  const gen = generatorPoly(degree);
  const rem = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], factor);
  }
  return rem.slice(data.length);
}

// ----------------------------------------------------------- format info
// 5 data bits (2 EC level + 3 mask) extended by a (15,5) BCH code, then
// XORed with 0x5412 so an all-zero format can't read as blank.

export function formatBits(ecLevelBits: number, mask: number): number {
  const data = (ecLevelBits << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

// ------------------------------------------------------------ bit buffer

class Bits {
  bytes: number[] = [];
  length = 0;
  push(value: number, width: number) {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      const pos = this.length >>> 3;
      if (this.bytes.length <= pos) this.bytes.push(0);
      if (bit) this.bytes[pos] |= 0x80 >>> (this.length & 7);
      this.length++;
    }
  }
}

// -------------------------------------------------------------- encoding

function chooseVersion(byteLength: number) {
  for (const v of VERSIONS) {
    const [blockCount, perBlock] = v.blocks;
    const dataCodewords = blockCount * (perBlock - v.ecPerBlock);
    // 4 mode bits + 8 length bits = 12 bits of header for versions 1–9.
    if (byteLength + 2 <= dataCodewords) return { ...v, dataCodewords };
  }
  return null;
}

/** Data codewords: header, payload, terminator, pad to capacity. */
function dataCodewords(bytes: Uint8Array, capacity: number): number[] {
  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(bytes.length, 8); // character count, versions 1–9
  for (const b of bytes) bits.push(b, 8);
  bits.push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0, 1);
  const out = [...bits.bytes];
  // The standard's alternating pad bytes.
  for (let i = 0; out.length < capacity; i++) out.push(i % 2 === 0 ? 0xec : 0x11);
  return out;
}

/** Split into blocks, add EC to each, then interleave — data codewords first
 *  taken one per block in turn, then the EC codewords the same way. A burst
 *  of damage then lands across blocks instead of destroying one. */
function interleave(data: number[], v: { ecPerBlock: number; blocks: readonly [number, number] }) {
  const [blockCount, perBlock] = v.blocks;
  const dataPerBlock = perBlock - v.ecPerBlock;
  // Every block is the same size at level M for versions 1–6 (64/2, 86/2 and
  // 108/4 all divide exactly). Unequal blocks only appear in versions this
  // encoder doesn't reach, so rather than carry the general case untested,
  // this asserts the assumption it relies on.
  if (data.length !== blockCount * dataPerBlock) {
    throw new Error(`qr: ${data.length} data codewords do not fill ${blockCount} blocks`);
  }
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let i = 0; i < blockCount; i++) {
    const block = data.slice(i * dataPerBlock, (i + 1) * dataPerBlock);
    dataBlocks.push(block);
    ecBlocks.push(ecCodewords(block, v.ecPerBlock));
  }
  const out: number[] = [];
  for (let i = 0; i < dataPerBlock; i++) for (const b of dataBlocks) out.push(b[i]);
  for (let i = 0; i < v.ecPerBlock; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ---------------------------------------------------------------- matrix

type Grid = { size: number; modules: (boolean | null)[][]; reserved: boolean[][] };

function blankGrid(version: number): Grid {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFunction(g: Grid, x: number, y: number, dark: boolean) {
  g.modules[y][x] = dark;
  g.reserved[y][x] = true;
}

function drawFinder(g: Grid, cx: number, cy: number) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const outer = inRing && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const core = inRing && dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      setFunction(g, x, y, outer || core);
    }
  }
}

function drawPatterns(g: Grid, version: number) {
  drawFinder(g, 0, 0);
  drawFinder(g, g.size - 7, 0);
  drawFinder(g, 0, g.size - 7);

  for (let i = 8; i < g.size - 8; i++) {
    const dark = i % 2 === 0;
    setFunction(g, i, 6, dark);
    setFunction(g, 6, i, dark);
  }

  const centres = ALIGNMENT[version] ?? [];
  for (const cy of centres) {
    for (const cx of centres) {
      // Skip the three that would sit on a finder.
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === g.size - 7) || (cx === g.size - 7 && cy === 6))
        continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFunction(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  setFunction(g, 8, g.size - 8, true); // the always-dark module

  // Reserve the format-information cells; values are written after masking.
  for (let i = 0; i < 9; i++) {
    if (!g.reserved[8][i]) setFunction(g, i, 8, false);
    if (!g.reserved[i][8]) setFunction(g, 8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!g.reserved[8][g.size - 1 - i]) setFunction(g, g.size - 1 - i, 8, false);
    if (!g.reserved[g.size - 1 - i][8]) setFunction(g, 8, g.size - 1 - i, false);
  }
}

/** Zigzag placement: two-module-wide columns, right to left, alternating
 *  upward and downward, skipping the vertical timing column. */
function placeData(g: Grid, codewords: number[]) {
  let bit = 0;
  let upward = true;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the timing column is not part of the zigzag
    for (let step = 0; step < g.size; step++) {
      const y = upward ? g.size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (g.reserved[y][x]) continue;
        const byte = codewords[bit >>> 3] ?? 0;
        g.modules[y][x] = ((byte >>> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (y + x) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (y + x) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (x, y) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (x, y) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++)
    for (let x = 0; x < g.size; x++)
      if (!g.reserved[y][x] && MASKS[mask](x, y)) g.modules[y][x] = !g.modules[y][x];
}

/** The standard's four penalty rules. Lower is better; the mask with the
 *  lowest total is the one a scanner will find easiest. */
function penalty(g: Grid): number {
  const n = g.size;
  const at = (x: number, y: number) => g.modules[y][x] === true;
  let score = 0;

  // Rule 1 — runs of five or more of the same colour.
  for (let i = 0; i < n; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const cur = horizontal ? at(j, i) : at(i, j);
        const prev = horizontal ? at(j - 1, i) : at(i, j - 1);
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
    }
  }
  // Rule 2 — every 2x2 block of one colour.
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
  // Rule 3 — the finder-like 1:1:3:1:1 sequence with four light modules beside it.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  for (let i = 0; i < n; i++)
    for (let j = 0; j + 11 <= n; j++)
      for (const horizontal of [true, false]) {
        const win = Array.from({ length: 11 }, (_, k) =>
          horizontal ? at(j + k, i) : at(i, j + k)
        );
        if (win.every((v, k) => v === A[k]) || win.every((v, k) => v === B[k])) score += 40;
      }
  // Rule 4 — deviation from an even split of dark and light.
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (at(x, y)) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

function writeFormat(g: Grid, mask: number) {
  const bits = formatBits(0b00, mask); // 0b00 = level M
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    // Copy one: around the top-left finder.
    if (i < 6) g.modules[8][i] = dark;
    else if (i === 6) g.modules[8][7] = dark;
    else if (i === 7) g.modules[8][8] = dark;
    else if (i === 8) g.modules[7][8] = dark;
    else g.modules[14 - i][8] = dark;
    // Copy two: split between the other two finders.
    if (i < 8) g.modules[8][g.size - 1 - i] = dark;
    else g.modules[g.size - 15 + i][8] = dark;
  }
}

export interface QrResult {
  size: number;
  /** Row-major; true is a dark module. */
  modules: boolean[][];
  version: number;
  mask: number;
}

/** Encode text as a QR matrix, or null if it's too long for version 6. */
export function encodeQr(text: string): QrResult | null {
  const bytes = new TextEncoder().encode(text);
  const v = chooseVersion(bytes.length);
  if (!v) return null;

  const codewords = interleave(dataCodewords(bytes, v.dataCodewords), v);

  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = blankGrid(v.version);
    drawPatterns(g, v.version);
    placeData(g, codewords);
    applyMask(g, mask);
    writeFormat(g, mask);
    const score = penalty(g);
    if (!best || score < best.score) best = { grid: g, mask, score };
  }
  const g = best!.grid;
  return {
    size: g.size,
    modules: g.modules.map((row) => row.map((m) => m === true)),
    version: v.version,
    mask: best!.mask,
  };
}

/** The matrix as a self-contained SVG string, quiet zone included.
 *
 *  One `<path>` of rectangles rather than a rect per module: a version-4 code
 *  is 1,089 modules, and that many DOM nodes is a visible cost on a page
 *  someone is holding up for a friend to scan. */
export function qrSvg(text: string, opts?: { size?: number; quiet?: number }): string | null {
  const qr = encodeQr(text);
  if (!qr) return null;
  const quiet = opts?.quiet ?? 4;
  const total = qr.size + quiet * 2;
  const px = opts?.size ?? 200;
  let d = "";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${total}" height="${total}" fill="#FFFFFF"/>` +
    `<path d="${d}" fill="#16171B"/></svg>`
  );
}
