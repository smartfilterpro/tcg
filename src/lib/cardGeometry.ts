// Card geometry: find the card in a photo, flatten out the camera angle, and
// MEASURE centering instead of eyeballing it.
//
// Why this exists: centering is the one grading category that is pure
// geometry — a ratio of border widths — while corners, edges and surface
// need judgement. Handing a raw phone photo to a vision model and asking for
// a centering ratio bakes in the camera angle: shoot a perfectly centered
// card 10° off-perpendicular and the far border compresses, so the model
// reports lens distortion as a centering flaw. Here we locate the card's four
// corners, warp them back to a flat 63x88mm rectangle, and count border
// pixels. Same card, any angle, same number.
//
// Deliberately DOM-free so it can be exercised in plain node.

export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Card corners in source-image pixels, always ordered
 *  top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/** Standard trading card: 63mm x 88mm. */
export const CARD_ASPECT = 63 / 88;

// ===== small helpers =====

function px(img: RGBAImage, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Box-average downscale — detection runs on a small copy for speed, and
 *  averaging (rather than dropping pixels) keeps thin edges visible. */
export function downscale(img: RGBAImage, maxDim: number): { img: RGBAImage; scale: number } {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (scale >= 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const xr = img.width / w;
  const yr = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * xr)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { img: { data: out, width: w, height: h }, scale };
}

/** Median colour of a frame around the image edge — our estimate of the
 *  background the card is sitting on. */
function ringColor(img: RGBAImage, frac: number): [number, number, number] {
  const bw = Math.max(1, Math.round(img.width * frac));
  const bh = Math.max(1, Math.round(img.height * frac));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number) => {
    const [r, g, b] = px(img, x, y);
    rs.push(r);
    gs.push(g);
    bs.push(b);
  };
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < bw; x++) take(x, y);
    for (let x = Math.max(bw, img.width - bw); x < img.width; x++) take(x, y);
  }
  for (let x = 0; x < img.width; x += 2) {
    for (let y = 0; y < bh; y++) take(x, y);
    for (let y = Math.max(bh, img.height - bh); y < img.height; y++) take(x, y);
  }
  return [median(rs), median(gs), median(bs)];
}

/** Otsu's method over a distance histogram: picks the split between
 *  "background-ish" and "card" without us hard-coding a contrast level. */
function otsuThreshold(values: Float32Array, maxValue: number, bins = 64): number {
  const hist = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.floor((values[i] / maxValue) * bins));
    hist[b]++;
  }
  const total = values.length;
  let sum = 0;
  for (let b = 0; b < bins; b++) sum += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = b;
    }
  }
  return ((best + 1) / bins) * maxValue;
}

/** 3x3 majority vote — removes speckle without eating real edges. */
function majorityFilter(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          on += mask[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = on * 2 > n ? 1 : 0;
    }
  }
  return out;
}

/** Keep only the biggest blob, so a dark shadow in one corner of the frame
 *  can't drag a "corner" away from the card. */
function largestComponent(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; area: number } {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let bestArea = 0;
  let bestSeed = -1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let area = 0;
    while (head < tail) {
      const p = queue[head++];
      area++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), (queue[tail++] = p - 1);
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), (queue[tail++] = p + 1);
      if (y > 0 && mask[p - w] && !seen[p - w]) (seen[p - w] = 1), (queue[tail++] = p - w);
      if (y < h - 1 && mask[p + w] && !seen[p + w]) (seen[p + w] = 1), (queue[tail++] = p + w);
    }
    if (area > bestArea) {
      bestArea = area;
      bestSeed = start;
    }
  }
  const out = new Uint8Array(mask.length);
  if (bestSeed < 0) return { mask: out, area: 0 };
  const seen2 = new Uint8Array(mask.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = bestSeed;
  seen2[bestSeed] = 1;
  while (head < tail) {
    const p = queue[head++];
    out[p] = 1;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0 && mask[p - 1] && !seen2[p - 1]) (seen2[p - 1] = 1), (queue[tail++] = p - 1);
    if (x < w - 1 && mask[p + 1] && !seen2[p + 1]) (seen2[p + 1] = 1), (queue[tail++] = p + 1);
    if (y > 0 && mask[p - w] && !seen2[p - w]) (seen2[p - w] = 1), (queue[tail++] = p - w);
    if (y < h - 1 && mask[p + w] && !seen2[p + w]) (seen2[p + w] = 1), (queue[tail++] = p + w);
  }
  return { mask: out, area: bestArea };
}

// ===== detection =====

/** Least-squares fit of a line through boundary points, with one
 *  outlier-rejection pass. Fitting a whole edge beats trusting the four
 *  extreme pixels: hundreds of boundary samples average away the noise, and
 *  a corner off by two pixels is enough to move a centering ratio by a
 *  couple of points — which can be a whole grade at a threshold. */
function fitLine(points: Array<[number, number]>): { a: number; b: number } | null {
  if (points.length < 8) return null;
  const fit = (pts: Array<[number, number]>) => {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (const [t, v] of pts) {
      sx += t;
      sy += v;
      sxy += t * v;
      sxx += t * t;
    }
    const n = pts.length;
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const a = (n * sxy - sx * sy) / denom;
    const b = (sy - a * sx) / n;
    return { a, b };
  };
  const first = fit(points);
  if (!first) return null;
  const residuals = points.map(([t, v]) => Math.abs(v - (first.a * t + first.b)));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  const kept = points.filter((_, i) => residuals[i] <= Math.max(1.5, rms * 2));
  return fit(kept.length >= 8 ? kept : points) ?? first;
}

/** Where two fitted edges meet. Sides are fitted as x = a·y + b, tops and
 *  bottoms as y = a·x + b, so the intersection is a small substitution. */
function intersect(
  side: { a: number; b: number },
  cap: { a: number; b: number }
): Point | null {
  const denom = 1 - side.a * cap.a;
  if (Math.abs(denom) < 1e-9) return null;
  const x = (side.a * cap.b + side.b) / denom;
  return { x, y: cap.a * x + cap.b };
}

/** Refit the card's four edges against the mask and re-derive the corners
 *  from where those edges cross. */
function refineQuad(blob: Uint8Array, w: number, h: number, coarse: Quad): Quad | null {
  const [tl, tr, br, bl] = coarse;
  const rowFrom = Math.max(tl.y, tr.y);
  const rowTo = Math.min(bl.y, br.y);
  const colFrom = Math.max(tl.x, bl.x);
  const colTo = Math.min(tr.x, br.x);
  const rowMargin = (rowTo - rowFrom) * 0.12;
  const colMargin = (colTo - colFrom) * 0.12;
  if (rowTo - rowFrom < 20 || colTo - colFrom < 20) return null;

  const leftPts: Array<[number, number]> = [];
  const rightPts: Array<[number, number]> = [];
  for (let y = Math.ceil(rowFrom + rowMargin); y <= Math.floor(rowTo - rowMargin); y++) {
    if (y < 0 || y >= h) continue;
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < w; x++) {
      if (blob[y * w + x]) {
        x0 = x;
        break;
      }
    }
    for (let x = w - 1; x >= 0; x--) {
      if (blob[y * w + x]) {
        x1 = x;
        break;
      }
    }
    if (x0 >= 0) leftPts.push([y, x0]);
    if (x1 >= 0) rightPts.push([y, x1 + 1]);
  }

  const topPts: Array<[number, number]> = [];
  const botPts: Array<[number, number]> = [];
  for (let x = Math.ceil(colFrom + colMargin); x <= Math.floor(colTo - colMargin); x++) {
    if (x < 0 || x >= w) continue;
    let y0 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      if (blob[y * w + x]) {
        y0 = y;
        break;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      if (blob[y * w + x]) {
        y1 = y;
        break;
      }
    }
    if (y0 >= 0) topPts.push([x, y0]);
    if (y1 >= 0) botPts.push([x, y1 + 1]);
  }

  const left = fitLine(leftPts);
  const right = fitLine(rightPts);
  const top = fitLine(topPts);
  const bottom = fitLine(botPts);
  if (!left || !right || !top || !bottom) return null;

  const nTL = intersect(left, top);
  const nTR = intersect(right, top);
  const nBR = intersect(right, bottom);
  const nBL = intersect(left, bottom);
  if (!nTL || !nTR || !nBR || !nBL) return null;
  return [nTL, nTR, nBR, nBL];
}

/** Locate the card's four corners in a photo. Returns null when it can't be
 *  found confidently (low contrast against the background, card cropped off
 *  the frame) — callers fall back to hand-placed corners rather than
 *  measuring something wrong. */
export function detectCardQuad(source: RGBAImage): Quad | null {
  const { img, scale } = downscale(source, 720);
  const w = img.width;
  const h = img.height;
  const bg = ringColor(img, 0.04);

  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      dist[y * w + x] = colorDist(px(img, x, y), bg);
    }
  }

  const thr = Math.max(30, otsuThreshold(dist, 442));
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < dist.length; i++) raw[i] = dist[i] > thr ? 1 : 0;
  const mask = majorityFilter(majorityFilter(raw, w, h), w, h);

  const { mask: blob, area } = largestComponent(mask, w, h);
  if (area < w * h * 0.12) return null;

  // For a rectangle rotated less than ~45°, the extremes of (x+y) and (x-y)
  // land on its four corners.
  let tl = -1;
  let br = -1;
  let tr = -1;
  let bl = -1;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!blob[y * w + x]) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) (minSum = sum), (tl = y * w + x);
      if (sum > maxSum) (maxSum = sum), (br = y * w + x);
      if (diff > maxDiff) (maxDiff = diff), (tr = y * w + x);
      if (diff < minDiff) (minDiff = diff), (bl = y * w + x);
    }
  }
  if (tl < 0 || tr < 0 || br < 0 || bl < 0) return null;

  const atScale = (p: number): Point => ({ x: p % w, y: (p / w) | 0 });
  const coarse: Quad = [atScale(tl), atScale(tr), atScale(br), atScale(bl)];
  // Sharpen the corners against the fitted edges; fall back to the coarse
  // extremes if the refit doesn't converge.
  const refined = refineQuad(blob, w, h, coarse) ?? coarse;
  let quad: Quad = [
    { x: refined[0].x / scale, y: refined[0].y / scale },
    { x: refined[1].x / scale, y: refined[1].y / scale },
    { x: refined[2].x / scale, y: refined[2].y / scale },
    { x: refined[3].x / scale, y: refined[3].y / scale },
  ];

  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const topW = side(quad[0], quad[1]);
  const botW = side(quad[3], quad[2]);
  const leftH = side(quad[0], quad[3]);
  const rightH = side(quad[1], quad[2]);
  const wAvg = (topW + botW) / 2;
  const hAvg = (leftH + rightH) / 2;
  if (wAvg < 1 || hAvg < 1) return null;

  // A card photographed sideways: rotate the ordering so the output is
  // always portrait.
  if (wAvg / hAvg > 1.15) {
    quad = [quad[3], quad[0], quad[1], quad[2]];
  }

  const ratio =
    (side(quad[0], quad[1]) + side(quad[3], quad[2])) /
    (side(quad[0], quad[3]) + side(quad[1], quad[2]));
  // 0.716 is a card; allow generous slack for perspective before giving up.
  if (ratio < 0.5 || ratio > 0.95) return null;

  return quad;
}

/** The whole-photo fallback: corners at the image edges, inset slightly.
 *  Used as the starting position for hand-placed corners. */
export function defaultQuad(width: number, height: number): Quad {
  const ix = width * 0.1;
  const iy = height * 0.1;
  return [
    { x: ix, y: iy },
    { x: width - ix, y: iy },
    { x: width - ix, y: height - iy },
    { x: ix, y: height - iy },
  ];
}

// ===== perspective rectification =====

/** Solve the 8 unknowns of a homography by Gaussian elimination. */
function solve8(a: number[][], b: number[]): number[] | null {
  const n = 8;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

/** Homography mapping unit card space (0..1, 0..1) to source pixels. */
function cardToSource(quad: Quad): number[] | null {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = quad[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  return solve8(a, b);
}

function sampleBilinear(img: RGBAImage, x: number, y: number, out: Uint8ClampedArray, o: number) {
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > img.width - 1) x = img.width - 1;
  if (y > img.height - 1) y = img.height - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * img.width + x0) * 4;
  const i10 = (y0 * img.width + x1) * 4;
  const i01 = (y1 * img.width + x0) * 4;
  const i11 = (y1 * img.width + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = img.data[i00 + c] * (1 - fx) + img.data[i10 + c] * fx;
    const bot = img.data[i01 + c] * (1 - fx) + img.data[i11 + c] * fx;
    out[o + c] = top * (1 - fy) + bot * fy;
  }
  out[o + 3] = 255;
}

/** Warp a rectangular region of card space — (u0,v0)-(u1,v1) in 0..1
 *  coordinates where the whole card is (0,0)-(1,1) — into a flat image.
 *  The full card is region (0,0)-(1,1); a corner close-up is a small
 *  sub-region, which is why this is generalised rather than a plain
 *  "rectify whole card". */
export function rectifyRegion(
  source: RGBAImage,
  quad: Quad,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  outW: number,
  outH: number
): RGBAImage | null {
  const H = cardToSource(quad);
  if (!H) return null;
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const v = v0 + ((oy + 0.5) / outH) * (v1 - v0);
    for (let ox = 0; ox < outW; ox++) {
      const u = u0 + ((ox + 0.5) / outW) * (u1 - u0);
      const denom = H[6] * u + H[7] * v + 1;
      const sx = (H[0] * u + H[1] * v + H[2]) / denom;
      const sy = (H[3] * u + H[4] * v + H[5]) / denom;
      sampleBilinear(source, sx, sy, data, (oy * outW + ox) * 4);
    }
  }
  return { data, width: outW, height: outH };
}

/** Flatten the whole card to a fixed 63:88 rectangle. */
export function rectifyCard(source: RGBAImage, quad: Quad, outW = 800): RGBAImage | null {
  const outH = Math.round(outW / CARD_ASPECT);
  return rectifyRegion(source, quad, 0, 0, 1, 1, outW, outH);
}

/** The four corner close-ups, each a ~14mm square of the real card lifted
 *  straight from the full-resolution photo — the detail a grader actually
 *  looks at, which a whole-card thumbnail throws away. */
export const CORNER_REGIONS: Array<{ key: "TL" | "TR" | "BR" | "BL"; label: string; u0: number; v0: number; u1: number; v1: number }> = [
  { key: "TL", label: "top-left", u0: 0, v0: 0, u1: 0.222, v1: 0.159 },
  { key: "TR", label: "top-right", u0: 0.778, v0: 0, u1: 1, v1: 0.159 },
  { key: "BR", label: "bottom-right", u0: 0.778, v0: 0.841, u1: 1, v1: 1 },
  { key: "BL", label: "bottom-left", u0: 0, v0: 0.841, u1: 0.222, v1: 1 },
];

// ===== centering measurement =====

export interface CenteringMeasurement {
  /** Border widths in rectified pixels. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  /** e.g. [55, 45] meaning 55/45 left-to-right. */
  lr: [number, number];
  tb: [number, number];
  /** The worse of the two majority percentages — what sets the cap. */
  worst: number;
  /** Highest grade this centering alone allows. */
  cap: number;
  borderColor: [number, number, number];
  /** How much of the scan agreed; low means treat the number with suspicion. */
  agreement: number;
}

/** Highest grade the measured centering permits, on PSA's published
 *  front-centering allowances. */
export function centeringCap(worstPct: number): number {
  if (worstPct <= 55) return 10;
  if (worstPct <= 60) return 9;
  if (worstPct <= 65) return 8;
  if (worstPct <= 70) return 7;
  if (worstPct <= 80) return 6;
  if (worstPct <= 85) return 5;
  if (worstPct <= 90) return 4;
  return 3;
}

/** Backs are held to a looser standard than fronts — PSA allows roughly
 *  75/25 on the back of a 10, and 90/10 on a 9. */
export function centeringCapBack(worstPct: number): number {
  if (worstPct <= 75) return 10;
  if (worstPct <= 90) return 9;
  return 8;
}

/** Walk inward from one edge of the rectified card until the printed border
 *  colour gives way to the frame/artwork, and take the median across many
 *  scan lines. Returns null if the card has no measurable border (full-art
 *  and borderless cards) — better to say "can't measure" than invent a
 *  ratio. */
function scanBorder(
  card: RGBAImage,
  border: [number, number, number],
  thr: number,
  dir: "left" | "right" | "top" | "bottom"
): { widths: number[]; tried: number } {
  const horizontal = dir === "left" || dir === "right";
  const along = horizontal ? card.height : card.width;
  const across = horizontal ? card.width : card.height;
  const startFrac = 0.008;
  const maxFrac = 0.3;
  const widths: number[] = [];
  let tried = 0;
  for (let a = Math.floor(along * 0.18); a < along * 0.82; a += 2) {
    tried++;
    let run = 0;
    for (let d = Math.floor(across * startFrac); d < across * maxFrac; d++) {
      const pos = dir === "left" || dir === "top" ? d : across - 1 - d;
      const [r, g, b] = horizontal ? px(card, pos, a) : px(card, a, pos);
      if (colorDist([r, g, b], border) > thr) {
        run++;
        if (run >= 3) {
          widths.push(d - 2);
          break;
        }
      } else {
        run = 0;
      }
    }
  }
  return { widths, tried };
}

export function measureCentering(card: RGBAImage): CenteringMeasurement | null {
  // The printed border's colour, sampled from a thin ring just inside the
  // card edge (skipping the very edge, which can carry a sliver of
  // background if the corners were placed a hair wide).
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const inset0 = Math.round(card.width * 0.012);
  const inset1 = Math.round(card.width * 0.03);
  for (let y = Math.floor(card.height * 0.2); y < card.height * 0.8; y += 3) {
    for (let d = inset0; d < inset1; d++) {
      for (const x of [d, card.width - 1 - d]) {
        const [r, g, b] = px(card, x, y);
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    }
  }
  if (rs.length === 0) return null;
  const border: [number, number, number] = [median(rs), median(gs), median(bs)];

  // How uniform is that ring? A real printed border is very consistent; a
  // full-art card's edge is not, and we refuse to measure those.
  const devs: number[] = [];
  for (let i = 0; i < rs.length; i += 7) {
    devs.push(colorDist([rs[i], gs[i], bs[i]], border));
  }
  const spread = median(devs);
  if (spread > 40) return null;
  const thr = Math.min(150, Math.max(45, spread * 4));

  const left = scanBorder(card, border, thr, "left");
  const right = scanBorder(card, border, thr, "right");
  const top = scanBorder(card, border, thr, "top");
  const bottom = scanBorder(card, border, thr, "bottom");

  const hits = left.widths.length + right.widths.length + top.widths.length + bottom.widths.length;
  const tried = left.tried + right.tried + top.tried + bottom.tried;
  if (tried === 0) return null;
  const agreement = hits / tried;
  if (
    agreement < 0.5 ||
    left.widths.length < 10 ||
    right.widths.length < 10 ||
    top.widths.length < 10 ||
    bottom.widths.length < 10
  ) {
    return null;
  }

  const l = median(left.widths);
  const r = median(right.widths);
  const t = median(top.widths);
  const b = median(bottom.widths);
  if (l + r <= 0 || t + b <= 0) return null;
  if (l + r > card.width * 0.5 || t + b > card.height * 0.5) return null;

  const lPct = Math.round((l / (l + r)) * 100);
  const tPct = Math.round((t / (t + b)) * 100);
  const lr: [number, number] = [lPct, 100 - lPct];
  const tb: [number, number] = [tPct, 100 - tPct];
  const worst = Math.max(lr[0], lr[1], tb[0], tb[1]);

  return {
    left: l,
    right: r,
    top: t,
    bottom: b,
    width: card.width,
    height: card.height,
    lr,
    tb,
    worst,
    cap: centeringCap(worst),
    borderColor: border,
    agreement,
  };
}

/** Human-readable form for the report and the prompt. */
export function centeringText(m: CenteringMeasurement): string {
  return `${m.lr[0]}/${m.lr[1]} left-to-right, ${m.tb[0]}/${m.tb[1]} top-to-bottom`;
}

// ===== photo quality =====

export interface PhotoMetrics {
  /** Laplacian variance — higher is sharper. */
  sharpness: number;
  /** Percentage of blown-out pixels (glare). */
  glarePct: number;
  blurry: boolean;
  glary: boolean;
}

export function photoMetrics(card: RGBAImage): PhotoMetrics {
  const w = card.width;
  const h = card.height;
  const gray = new Float32Array(w * h);
  let blown = 0;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const r = card.data[p];
    const g = card.data[p + 1];
    const b = card.data[p + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if (r > 250 && g > 250 && b > 250) blown++;
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 0 ? sumSq / n - mean * mean : 0;
  const glarePct = (blown / gray.length) * 100;
  return {
    sharpness: variance,
    glarePct,
    // Thresholds are rules of thumb for warning the user, never for
    // changing a grade.
    blurry: variance < 45,
    glary: glarePct > 2,
  };
}
