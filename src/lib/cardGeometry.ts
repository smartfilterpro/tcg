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
function largestComponent(
  mask: Uint8Array,
  w: number,
  h: number
): { mask: Uint8Array; area: number; bboxArea: number } {
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
  if (bestSeed < 0) return { mask: out, area: 0, bboxArea: 0 };
  const seen2 = new Uint8Array(mask.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = bestSeed;
  seen2[bestSeed] = 1;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  while (head < tail) {
    const p = queue[head++];
    out[p] = 1;
    const x = p % w;
    const y = (p / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > 0 && mask[p - 1] && !seen2[p - 1]) (seen2[p - 1] = 1), (queue[tail++] = p - 1);
    if (x < w - 1 && mask[p + 1] && !seen2[p + 1]) (seen2[p + 1] = 1), (queue[tail++] = p + 1);
    if (y > 0 && mask[p - w] && !seen2[p - w]) (seen2[p - w] = 1), (queue[tail++] = p - w);
    if (y < h - 1 && mask[p + w] && !seen2[p + w]) (seen2[p + w] = 1), (queue[tail++] = p + w);
  }
  const bboxArea = maxX < 0 ? 0 : (maxX - minX + 1) * (maxY - minY + 1);
  return { mask: out, area: bestArea, bboxArea };
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

/** Build a candidate quad for one background/foreground threshold. */
function quadAtThreshold(
  img: RGBAImage,
  dist: Float32Array,
  thr: number
): { quad: Quad; ratio: number; bboxArea: number } | null {
  const w = img.width;
  const h = img.height;
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < dist.length; i++) raw[i] = dist[i] > thr ? 1 : 0;
  const mask = majorityFilter(majorityFilter(raw, w, h), w, h);

  const { mask: blob, bboxArea } = largestComponent(mask, w, h);
  // Guard on the bounding box rather than filled area: a strict threshold
  // can leave only the card's printed border as a ring — small in area but
  // exactly the right size and shape.
  if (bboxArea < w * h * 0.12) return null;

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
  let quad = refineQuad(blob, w, h, coarse) ?? coarse;

  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const wAvg = (side(quad[0], quad[1]) + side(quad[3], quad[2])) / 2;
  const hAvg = (side(quad[0], quad[3]) + side(quad[1], quad[2])) / 2;
  if (wAvg < 1 || hAvg < 1) return null;

  // A card photographed sideways: rotate the ordering so the output is
  // always portrait.
  if (wAvg / hAvg > 1.15) quad = [quad[3], quad[0], quad[1], quad[2]];

  const ratio =
    (side(quad[0], quad[1]) + side(quad[3], quad[2])) /
    (side(quad[0], quad[3]) + side(quad[1], quad[2]));
  // 0.716 is a card; allow generous slack for perspective before giving up.
  if (ratio < 0.5 || ratio > 0.95) return null;
  return { quad, ratio, bboxArea };
}

/** Mean colour of a short run of pixels — used to compare the two sides of
 *  a possible edge. */
function runMean(
  img: RGBAImage,
  from: number,
  to: number,
  fixed: number,
  horizontal: boolean
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = from; i <= to; i++) {
    const x = horizontal ? i : fixed;
    const y = horizontal ? fixed : i;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const p = px(img, x, y);
    r += p[0];
    g += p[1];
    b += p[2];
    n++;
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

/** Walk in from one side of the photo and record where the first SUSTAINED
 *  colour change happens on each scan line — the card's edge. Wood grain and
 *  the like produce plenty of thin, local changes; requiring the difference
 *  to hold over ~18px steps past them. */
function scanEdgePoints(
  img: RGBAImage,
  dir: "left" | "right" | "top" | "bottom",
  thr: number
): Array<[number, number]> {
  const horizontal = dir === "left" || dir === "right";
  const along = horizontal ? img.height : img.width;
  const across = horizontal ? img.width : img.height;
  const forward = dir === "left" || dir === "top";
  const points: Array<[number, number]> = [];
  for (let a = Math.floor(along * 0.05); a < along * 0.95; a += 2) {
    for (let step = 5; step < across * 0.55; step++) {
      const d = forward ? step : across - 1 - step;
      const outerFrom = forward ? d - 4 : d + 1;
      const innerFrom = forward ? d + 1 : d - 4;
      const near = runMean(img, outerFrom, outerFrom + 3, a, horizontal);
      const far = runMean(img, innerFrom, innerFrom + 3, a, horizontal);
      if (colorDist(near, far) <= thr) continue;
      // Confirm it holds further in, so a grain line or a scratch on the
      // table doesn't read as the card's edge.
      const wideOuter = forward
        ? runMean(img, d - 20, d - 4, a, horizontal)
        : runMean(img, d + 4, d + 20, a, horizontal);
      const wideInner = forward
        ? runMean(img, d + 4, d + 20, a, horizontal)
        : runMean(img, d - 20, d - 4, a, horizontal);
      if (colorDist(wideOuter, wideInner) > thr) {
        points.push([a, d]);
        break;
      }
    }
  }
  return points;
}

/** Fit a line through boundary points that tolerates a large minority of
 *  nonsense. Least squares is dragged badly by the stray points a textured
 *  table produces; this keeps the line the most points actually agree on.
 *  Deterministic — it walks a fixed lattice of pairs rather than sampling
 *  randomly, so the same photo always gives the same answer. */
function robustLine(
  points: Array<[number, number]>,
  maxSlope: number
): { a: number; b: number; inliers: number } | null {
  if (points.length < 12) return null;
  const span = points[points.length - 1][0] - points[0][0];
  if (span <= 0) return null;
  const stride = Math.max(1, Math.floor(points.length / 32));
  let best: { a: number; b: number; inliers: number } | null = null;
  for (let i = 0; i < points.length; i += stride) {
    for (let j = i + stride; j < points.length; j += stride) {
      const [t1, v1] = points[i];
      const [t2, v2] = points[j];
      if (Math.abs(t1 - t2) < span * 0.3) continue;
      const a = (v2 - v1) / (t2 - t1);
      if (!Number.isFinite(a) || Math.abs(a) > maxSlope) continue;
      const b = v1 - a * t1;
      let inliers = 0;
      for (const [t, v] of points) {
        if (Math.abs(v - (a * t + b)) <= 3) inliers++;
      }
      if (!best || inliers > best.inliers) best = { a, b, inliers };
    }
  }
  if (!best || best.inliers < Math.max(12, points.length * 0.25)) return null;
  // Refit on the agreeing points for sub-pixel accuracy.
  const kept = points.filter(([t, v]) => Math.abs(v - (best!.a * t + best!.b)) <= 3);
  const refit = fitLine(kept);
  return refit ? { ...refit, inliers: best.inliers } : best;
}

/** Find the card by its four edges rather than by separating it from the
 *  background. Robust where a colour-threshold mask isn't: a wood table's
 *  highlights are nowhere near its median colour, so masking pulls patches
 *  of table in with the card, but the table has no long straight
 *  high-contrast edges to confuse a line fit. */
function scanQuad(img: RGBAImage, thr: number): Quad | null {
  const MAX_SLOPE = 0.4; // ~22° of rotation
  const left = robustLine(scanEdgePoints(img, "left", thr), MAX_SLOPE);
  const right = robustLine(scanEdgePoints(img, "right", thr), MAX_SLOPE);
  const top = robustLine(scanEdgePoints(img, "top", thr), MAX_SLOPE);
  const bottom = robustLine(scanEdgePoints(img, "bottom", thr), MAX_SLOPE);
  if (!left || !right || !top || !bottom) return null;

  // The scan stops at the first sustained change, which is typically a pixel
  // or two out from the card — often on the hairline shadow it casts. Slide
  // each edge along its normal to where the colour step is strongest, which
  // is the card's actual boundary. Left unrefined this leaves a rim of table
  // inside the crop, and that rim lands in the corner close-ups.
  const refined = [
    refineLine(img, left, true, 1),
    refineLine(img, right, true, -1),
    refineLine(img, top, false, 1),
    refineLine(img, bottom, false, -1),
  ];
  const tl = intersect(refined[0], refined[2]);
  const tr = intersect(refined[1], refined[2]);
  const br = intersect(refined[1], refined[3]);
  const bl = intersect(refined[0], refined[3]);
  if (!tl || !tr || !br || !bl) return null;
  return [tl, tr, br, bl];
}

/** Slide one fitted edge along its normal to the offset with the strongest
 *  colour step — sub-pixel edge localisation. `vertical` means the line is
 *  x = a·y + b; `inside` is +1 when the card lies at increasing values. */
function refineLine(
  img: RGBAImage,
  line: { a: number; b: number },
  vertical: boolean,
  inside: 1 | -1
): { a: number; b: number } {
  const along = vertical ? img.height : img.width;
  // Bilinear, because the offset is searched in half-pixel steps and
  // rounding would flatten the very peak we're hunting for.
  const sample = (t: number, v: number): [number, number, number] | null => {
    const fx = vertical ? v : t;
    const fy = vertical ? t : v;
    if (fx < 0 || fy < 0 || fx > img.width - 1 || fy > img.height - 1) return null;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(img.width - 1, x0 + 1);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const c00 = px(img, x0, y0);
    const c10 = px(img, x1, y0);
    const c01 = px(img, x0, y1);
    const c11 = px(img, x1, y1);
    const out: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const top = c00[k] * (1 - ax) + c10[k] * ax;
      const bot = c01[k] * (1 - ax) + c11[k] * ax;
      out[k] = top * (1 - ay) + bot * ay;
    }
    return out;
  };
  let best = { a: line.a, b: line.b };
  let bestStep = -1;
  // Angle is searched alongside offset, but only narrowly (~±0.7°): the fit
  // can be a fraction of a degree out, which shows up as table creeping in
  // along one end of an edge, yet a wide search would let the edge slide
  // onto some strong feature inside the artwork.
  for (let da = -0.012; da <= 0.0121; da += 0.003) {
    const a = line.a + da;
    for (let d = -10; d <= 10; d += 0.5) {
      const b = line.b + d;
      let sum = 0;
      let n = 0;
      for (let t = Math.floor(along * 0.15); t < along * 0.85; t += 3) {
        const v = a * t + b;
        // Narrow baseline: a wide one scores every position within its own
        // span equally, so the "best" offset could sit several pixels off
        // the card and leave a rim of table in the crop. A 3px baseline
        // peaks on the boundary itself.
        const outer = sample(t, v - 1.5);
        const inner = sample(t, v + 1.5);
        if (!outer || !inner) continue;
        sum += colorDist(outer, inner);
        n++;
      }
      if (n > 0 && sum / n > bestStep) {
        bestStep = sum / n;
        best = { a, b };
      }
    }
  }
  return best;
}

/** The weakest colour step across the four edges of a candidate quad.
 *
 *  A genuine card boundary shows a clear change from just inside the edge to
 *  just outside it. A quad that has instead latched onto part of the card —
 *  which happens when some of the artwork is close to the table's colour and
 *  the mask breaks up — has at least one edge with card on both sides, and
 *  that edge gives itself away with almost no step. */
function minEdgeContrast(img: RGBAImage, quad: Quad): number {
  const H = cardToSource(quad);
  if (!H) return 0;
  const at = (u: number, v: number): [number, number, number] | null => {
    const d = H[6] * u + H[7] * v + 1;
    const x = Math.round((H[0] * u + H[1] * v + H[2]) / d);
    const y = Math.round((H[3] * u + H[4] * v + H[5]) / d);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
    return px(img, x, y);
  };
  const OUT = 0.035;
  const IN = 0.035;
  const edges: Array<(t: number) => [[number, number], [number, number]]> = [
    (t) => [[t, -OUT], [t, IN]], // top
    (t) => [[t, 1 + OUT], [t, 1 - IN]], // bottom
    (t) => [[-OUT, t], [IN, t]], // left
    (t) => [[1 + OUT, t], [1 - IN, t]], // right
  ];
  let weakest = Infinity;
  for (const edge of edges) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 24; i++) {
      const t = 0.15 + (0.7 * i) / 23;
      const [o, k] = edge(t);
      const outside = at(o[0], o[1]);
      const inside = at(k[0], k[1]);
      if (!outside || !inside) continue;
      sum += colorDist(outside, inside);
      n++;
    }
    if (n === 0) return 0;
    weakest = Math.min(weakest, sum / n);
  }
  return weakest === Infinity ? 0 : weakest;
}

/** Is this quad shaped like a card seen through a phone camera?
 *
 *  A rectangle photographed with mild perspective keeps its opposite edges
 *  roughly parallel and its corners near square. The strongest colour step
 *  in a photo is often NOT the card's border — on a neon full-art card the
 *  artwork steps harder than the edge does — so a lopsided quad drawn inside
 *  the picture could out-score the card itself. It cannot fake the shape:
 *  the one that beat the real outline had a top edge at -30 degrees and a
 *  bottom edge at 2. */
function isCardShaped(quad: Quad): boolean {
  const angle = (a: Point, b: Point) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  /** Smallest difference between two directions, treating opposite as equal. */
  const gap = (p: number, q: number) => {
    let d = Math.abs(((p - q) % 180) + 180) % 180;
    if (d > 90) d = 180 - d;
    return d;
  };
  const top = angle(quad[0], quad[1]);
  const bottom = angle(quad[3], quad[2]);
  const left = angle(quad[0], quad[3]);
  const right = angle(quad[1], quad[2]);
  if (gap(top, bottom) > 14) return false;
  if (gap(left, right) > 14) return false;
  // Corners near square: the sides should run across the ends, not with them.
  if (Math.abs(gap(top, left) - 90) > 20) return false;
  if (Math.abs(gap(bottom, right) - 90) > 20) return false;
  return true;
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

  // Two different ways of finding the card, because each fails on photos the
  // other handles. Masking by colour distance copes with a rotated card on a
  // plain background but falls apart on a textured one, where highlights sit
  // nowhere near the background's median colour and drag patches of table in
  // with the card. Edge scanning ignores that entirely but wants the card
  // roughly square to the frame.
  const base = Math.max(30, otsuThreshold(dist, 442));
  const candidates: Quad[] = [];
  for (const t of [base, base * 1.6]) {
    const c = quadAtThreshold(img, dist, t);
    if (c) candidates.push(c.quad);
  }
  for (const t of [48, 70]) {
    const q = scanQuad(img, t);
    if (q) candidates.push(q);
  }

  // Score them all the same way: a real card outline has a strong colour
  // step along every one of its four edges, and something close to 63:88
  // proportions. Whichever candidate scores best wins; if none is
  // convincing, say so rather than hand back a confident wrong outline.
  let best: { quad: Quad; score: number } | null = null;
  for (const quad of candidates) {
    const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const wAvg = (side(quad[0], quad[1]) + side(quad[3], quad[2])) / 2;
    const hAvg = (side(quad[0], quad[3]) + side(quad[1], quad[2])) / 2;
    if (wAvg < w * 0.2 || hAvg < h * 0.2) continue;
    const ratio = wAvg / hAvg;
    if (ratio < 0.5 || ratio > 0.95) continue;
    // Corners well outside the frame mean the fit ran away.
    if (quad.some((p) => p.x < -w * 0.05 || p.x > w * 1.05 || p.y < -h * 0.05 || p.y > h * 1.05)) {
      continue;
    }
    // A card seen through a camera stays a rectangle. This is what rules out
    // a lopsided quad drawn inside the artwork, which edge contrast alone
    // cannot: neon artwork steps harder than the card's own border.
    if (!isCardShaped(quad)) continue;
    const contrast = minEdgeContrast(img, quad);
    const score = contrast - Math.abs(ratio - CARD_ASPECT) * 120;
    if (!best || score > best.score) best = { quad, score };
  }
  if (!best || best.score < 38) return null;

  return best.quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad;
}

/** The colour the card is sitting on, estimated from the photo's outer
 *  frame. */
export function estimateBackground(source: RGBAImage): [number, number, number] {
  const { img } = downscale(source, 480);
  return ringColor(img, 0.04);
}

/** How much of the flattened card's outer edge is actually background —
 *  i.e. how far the corners overshoot the card. This is the one alignment
 *  check that works on a full-art card, where there's no printed border to
 *  compare against and the centering measurement stays silent. */
export function backgroundBleed(
  card: RGBAImage,
  bg: [number, number, number],
  tolerance = 42
): number {
  let hits = 0;
  let total = 0;
  const depth = Math.max(2, Math.round(card.width * 0.012));
  const check = (x: number, y: number) => {
    total++;
    if (colorDist(px(card, x, y), bg) < tolerance) hits++;
  };
  for (let y = 0; y < card.height; y += 3) {
    for (let d = 0; d < depth; d++) {
      check(d, y);
      check(card.width - 1 - d, y);
    }
  }
  for (let x = 0; x < card.width; x += 3) {
    for (let d = 0; d < depth; d++) {
      check(x, d);
      check(x, card.height - 1 - d);
    }
  }
  return total === 0 ? 0 : hits / total;
}

/** How far the placed outline is from a card's 63:88 proportions.
 *
 *  A card is always noticeably taller than it is wide, so an outline that
 *  isn't tells you the corners are wrong — whether auto-detection collapsed
 *  onto part of the card or a handle got dragged somewhere odd. Worth its own
 *  check because a crop that sits INSIDE the card leaves no background in the
 *  picture for the bleed test to notice, yet still yields a confident and
 *  completely wrong centering ratio. */
export function quadLooksLikeCard(quad: Quad): boolean {
  // Headroom for real perspective: a card shot at 30 degrees off square
  // still measures within about 0.11 of its true proportions, while an
  // outline that has collapsed onto part of a card runs 0.27 and up.
  return quadAspectOff(quad) <= 0.18;
}

export function quadAspectOff(quad: Quad): number {
  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = (side(quad[0], quad[1]) + side(quad[3], quad[2])) / 2;
  const h = (side(quad[0], quad[3]) + side(quad[1], quad[2])) / 2;
  if (w <= 0 || h <= 0) return 1;
  return Math.abs(w / h - CARD_ASPECT);
}

/** True when the card runs right up to the edge of the photo. Background
 *  estimation samples the frame's outer ring, so a card with no margin
 *  around it poisons that estimate and auto-detection drifts. */
export function quadNearEdge(quad: Quad, width: number, height: number, frac = 0.025): boolean {
  const mx = width * frac;
  const my = height * frac;
  return quad.some((p) => p.x < mx || p.x > width - mx || p.y < my || p.y > height - my);
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
  // Exported and called with computed sizes, so the same fractional-length
  // throw that took down the grade screen is reachable here too. A refused
  // rectify shows "couldn't measure"; a thrown one shows a white page.
  if (!Number.isInteger(outW) || !Number.isInteger(outH) || outW < 1 || outH < 1) return null;
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

export interface AxisMeasure {
  /** Border widths in rectified pixels: left/top then right/bottom. */
  a: number;
  b: number;
  /** e.g. [55, 45]. */
  pct: [number, number];
  /** Highest grade this axis alone allows. */
  cap: number;
}

export interface CenteringMeasurement {
  width: number;
  height: number;
  /** Null when that axis couldn't be measured reliably. */
  lr: AxisMeasure | null;
  tb: AxisMeasure | null;
  /** When an axis is null, exactly which edge defeated it and why. */
  lrNote: string | null;
  tbNote: string | null;
  /** The worse majority percentage across the axes we could measure. */
  worst: number;
  /** Highest grade the measured centering allows. */
  cap: number;
  borderColor: [number, number, number];
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

/** Walk inward from one edge of the rectified card and measure the printed
 *  border's thickness, taking the median across many scan lines.
 *
 *  Two things about real photos that a naive edge-to-first-change walk gets
 *  wrong, both found by running this against actual graded exports:
 *
 *  THE CROP LEAVES SLIVERS. Corners placed a hair wide put a few rows of
 *  table inside the crop, so the border does not start at d=0 — walking
 *  from the crop edge met table, mismatched instantly, and reported the
 *  border "too thin" on a card whose border was in plain view. So each line
 *  first finds where the border STARTS (skipping any leading non-border
 *  sliver), and thickness is measured from there. The card's true edge is
 *  where its border begins, not where the crop happened to be cut.
 *
 *  TEXT INTERRUPTS BORDERS. The copyright line sits INSIDE the bottom
 *  border of most modern cards; treating it as the border's end read a
 *  third of the true width. A short interruption after which border colour
 *  resumes is part of the border; the frame or artwork that genuinely ends
 *  it does not come back. */
function scanBorder(
  card: RGBAImage,
  border: [number, number, number],
  thr: number,
  dir: "left" | "right" | "top" | "bottom"
): { widths: number[]; tried: number; startMedian: number } {
  const horizontal = dir === "left" || dir === "right";
  const along = horizontal ? card.height : card.width;
  const across = horizontal ? card.width : card.height;
  const maxFrac = 0.3;
  /** A border starting deeper than this isn't the card's edge border. */
  const startCap = Math.floor(across * 0.08);
  /** Interruption the scan may look past — the height of a line of text set
   *  into the border, not more. ONLY the bottom border gets this: the
   *  copyright line lives there and nowhere else. The sides carry no text,
   *  and the top's hazard runs the other way — a resume window let scan
   *  lines escape across the frame into a pale name banner, which reads as
   *  border colour and inflates the measurement. Both were observed on the
   *  real exports, each costing an axis that measured fine without it. */
  const gapCap = dir === "bottom" ? Math.max(4, Math.floor(across * 0.03)) : 0;
  const resumeNeed = Math.max(5, Math.floor(across * 0.008));

  const at = (d: number, a: number): [number, number, number] => {
    const pos = dir === "left" || dir === "top" ? d : across - 1 - d;
    return horizontal ? px(card, pos, a) : px(card, a, pos);
  };
  const isBorder = (d: number, a: number) => colorDist(at(d, a), border) <= thr;

  // Pass 1: each line's border start and end.
  const lines: Array<{ a: number; start: number; end: number }> = [];
  let tried = 0;
  for (let a = Math.floor(along * 0.18); a < along * 0.82; a += 2) {
    tried++;

    let start = -1;
    for (let d = Math.floor(across * 0.004); d < startCap; d++) {
      if (isBorder(d, a) && isBorder(d + 1, a) && isBorder(d + 2, a)) {
        start = d;
        break;
      }
    }
    if (start < 0) continue;

    let end = -1;
    let d = start;
    let resumes = 2;
    for (;;) {
      let run = 0;
      while (d < across * maxFrac) {
        if (!isBorder(d, a)) {
          run++;
          if (run >= 3) break;
        } else {
          run = 0;
        }
        d++;
      }
      end = d - run;
      if (gapCap === 0 || resumes === 0) break;
      // Look past a text-sized gap for the border resuming in earnest.
      let resumed = -1;
      const limit = Math.min(d + gapCap, Math.floor(across * maxFrac));
      for (let r = d; r < limit; r++) {
        let ok = true;
        for (let k = 0; k < resumeNeed; k++) {
          if (!isBorder(r + k, a)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          resumed = r;
          break;
        }
      }
      if (resumed < 0) break;
      resumes--;
      d = resumed;
    }
    if (end > start) lines.push({ a, start, end });
  }

  // Pass 2: one start for the whole edge. The card's edge is a single
  // straight line in a rectified image, so the per-line starts are noisy
  // estimates of one number — using each line's own start fed that noise
  // straight into the width spread and failed the consistency check on
  // borders that were perfectly uniform. Lines whose start sits far from
  // the consensus saw glare or artwork, not the edge, and are dropped.
  const startMedian = median(lines.map((l) => l.start));
  const widths: number[] = [];
  for (const l of lines) {
    if (Math.abs(l.start - startMedian) > Math.max(4, across * 0.02)) continue;
    const w = l.end - startMedian;
    if (w > 0) widths.push(w);
  }
  return { widths, tried, startMedian: lines.length > 0 ? startMedian : -1 };
}

/** The inner frame boundary, found as a line rather than a colour change.
 *
 *  The colour-walk above ends each scan line at the first place border
 *  colour stops matching — which is the copyright text on bottoms, glare on
 *  holos, and a pale name banner's whim on tops. But the FRAME is a printed
 *  straight line: in a rectified card it sits at one depth on every scan
 *  line. So instead of asking each line where it first wavered, aggregate
 *  the colour gradient across all lines at each depth and take the first
 *  strong aligned spike past the border's minimum width. Text and glare
 *  spike on a few lines at scattered depths and average out; the frame
 *  spikes everywhere at once. */
function frameEdgeDepth(
  card: RGBAImage,
  dir: "left" | "right" | "top" | "bottom",
  start: number,
  minDepth: number,
  maxDepth: number
): { depth: number; support: number } | null {
  const horizontal = dir === "left" || dir === "right";
  const along = horizontal ? card.height : card.width;
  const across = horizontal ? card.width : card.height;
  const at = (d: number, a: number): [number, number, number] => {
    const pos = dir === "left" || dir === "top" ? d : across - 1 - d;
    return horizontal ? px(card, pos, a) : px(card, a, pos);
  };

  // INTEGERS, explicitly.
  //
  // `start` is a median, and median() averages the middle pair on an even
  // count — so it is routinely x.5. That made `hi - lo` fractional, and
  // `new Array(8.5)` is a hard throw: Safari words it "Array length must be
  // a positive integer of safe magnitude", which is what took down the whole
  // grade screen while corners were being dragged. Every re-detect rolled
  // the dice on whether the median landed on a half.
  //
  // Flooring is also the correct fix rather than merely a safe one: `lo`
  // indexes into the array below as `d - lo`, so a fractional offset wrote
  // to fractional keys and left every real slot at its initial zero.
  const lo = Math.floor(Math.max(start + minDepth, 3));
  const hi = Math.floor(Math.min(maxDepth, across - 3));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 6) return null;

  const as: number[] = [];
  for (let a = Math.floor(along * 0.18); a < along * 0.82; a += 2) as.push(a);
  if (as.length < 20) return null;

  // Aggregate gradient magnitude per depth, over a ±2px baseline so a
  // 1px anti-aliased frame stroke still registers.
  const g: number[] = new Array(hi - lo).fill(0);
  for (const a of as) {
    for (let d = lo; d < hi; d++) {
      g[d - lo] += colorDist(at(d - 2, a), at(d + 2, a));
    }
  }
  // Light smoothing: the frame's spike survives, single-depth noise doesn't.
  const sm = g.map((_, i) => (g[i - 1] ?? g[i]) * 0.25 + g[i] * 0.5 + (g[i + 1] ?? g[i]) * 0.25);
  const gmax = Math.max(...sm);
  const gmed = [...sm].sort((x, y) => x - y)[Math.floor(sm.length / 2)];
  // No spike worth the name → no frame found here; let the caller fall back.
  if (gmax < gmed * 2.2 || gmax <= 0) return null;

  // The NEAREST strong aligned edge is the frame — deeper strong edges are
  // artwork. Walk outward-in and take the first local peak near the max.
  let depth = -1;
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] >= gmax * 0.72 && sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1]) {
      depth = lo + i;
      break;
    }
  }
  if (depth < 0) return null;

  // Support: how many individual lines actually change colour at this depth.
  // Aligned support is the whole argument — demand it line by line.
  let support = 0;
  for (const a of as) {
    let local = 0;
    for (let d = depth - 2; d <= depth + 2; d++) {
      local = Math.max(local, colorDist(at(d - 2, a), at(d + 2, a)));
    }
    if (local >= 40) support++;
  }
  return { depth, support };
}

/** One axis, measured only if both of its edges agree with themselves.
 *  A real printed border ends at the same depth on every scan line; artwork
 *  wanders, and so does a border with copyright text set into it. */
function measureAxis(
  card: RGBAImage,
  border: [number, number, number],
  thr: number,
  dirA: "left" | "top",
  dirB: "right" | "bottom",
  span: number,
  back: boolean
): { measure: AxisMeasure; note: null } | { measure: null; note: string } {
  // A printed border is at least a couple of percent of the card. Anything
  // thinner is the scan having stopped early on something inside the border
  // — the copyright line set into the bottom of a modern card does exactly
  // this, reading a third of the real width. The cost is that a card miscut
  // almost to its edge reports unmeasurable rather than a wrong ratio, which
  // is the right way round.
  const minBorder = span * 0.018;
  const sides = [dirA, dirB].map((dir) => {
    const { widths, startMedian } = scanBorder(card, border, thr, dir);

    // First choice: the inner frame line itself. One straight printed line,
    // found by aligned gradient across all scan lines — immune to the
    // copyright text, holo glare, and pale banners that end a colour walk
    // early or late. The colour walk below remains the fallback for cards
    // whose frame is soft (watercolour full-bleeds, worn borders).
    if (startMedian >= 0) {
      const frame = frameEdgeDepth(
        card,
        dir,
        startMedian,
        Math.floor(minBorder),
        Math.floor(span * 0.3)
      );
      if (frame && frame.support >= 20) {
        const w = frame.depth - startMedian;
        if (w >= minBorder && w <= span * 0.3) {
          return { dir, m: w, mad: 0, n: frame.support };
        }
      }
    }

    let m = median(widths);
    let mad = median(widths.map((w) => Math.abs(w - m)));
    let n = widths.length;

    // The bottom border's rescue, and only the bottom's.
    //
    // The copyright line splits its scan lines into two populations: lines
    // that stopped at the text (under-measured) and lines that read through
    // to the frame (true). That bimodal spread fails the consistency check
    // even though the upper cluster is perfectly tight — so when it fails,
    // re-judge on the widths at or above the median, which discards the
    // text-stopped population. Safe here because the bottom's systematic
    // error runs one way: text makes lines read SHORT. The top is left
    // strict, because its failure runs the other way — a scan escaping into
    // a pale name banner reads LONG, and an upper-cluster rescue would
    // canonise exactly the lines that escaped.
    if (dir === "bottom" && n >= 20 && (m < minBorder || mad > Math.max(4, m * 0.25))) {
      const upper = widths.filter((w) => w >= m);
      const um = median(upper);
      const umad = median(upper.map((w) => Math.abs(w - um)));
      if (upper.length >= 20 && um >= minBorder && umad <= Math.max(4, um * 0.25)) {
        m = um;
        mad = umad;
        n = upper.length;
      }
    }
    return { dir, m, mad, n };
  });

  // Name the edge that actually failed, and why. Reporting "top and bottom"
  // when only the bottom is unreadable is simply inaccurate, and the whole
  // point of showing the measurement is that it can be checked by eye.
  const failures: string[] = [];
  for (const s of sides) {
    if (s.n < 20) {
      failures.push(
        `too few clean scan lines crossed the ${s.dir} border (glare or artwork over most of it)`
      );
    } else if (s.m < minBorder) {
      failures.push(`the ${s.dir} border measures thinner than any printed border`);
    } else if (s.mad > Math.max(4, s.m * 0.25)) {
      failures.push(`the ${s.dir} border varies too much along its length to be a printed border`);
    }
  }
  const axisName = dirA === "left" ? "left-to-right" : "top-to-bottom";
  if (failures.length > 0) {
    // Say plainly that this is a limit of the method, not a fault in the
    // card. Top-to-bottom fails on most modern cards for the same structural
    // reason every time, and a note that reads like a defect invites the
    // owner to go looking for one.
    const known =
      axisName === "top-to-bottom"
        ? " This says nothing about the card itself — only that this direction couldn't be measured reliably from the photo."
        : "";
    return {
      measure: null,
      note: `On this card ${failures.join(", and ")}. A ${axisName} ratio needs both edges, so rather than measure off a line of text this direction was judged by eye.${known}`,
    };
  }

  const [a, b] = sides.map((s) => s.m);
  if (a + b <= 0 || a + b > span * 0.5) {
    return { measure: null, note: `The ${axisName} borders didn't measure sensibly on this card, so this direction was judged by eye instead.` };
  }
  const aPct = Math.round((a / (a + b)) * 100);
  const pct: [number, number] = [aPct, 100 - aPct];
  const worst = Math.max(pct[0], pct[1]);
  // Past 85/15 the likelier story is a misread line (a text-box rule taken
  // for the frame) than a card actually cut that badly — and a confident
  // wrong ratio is worse than none, because it caps the grade.
  if (worst > 85) {
    return {
      measure: null,
      note: `The ${axisName} measurement came out wildly lopsided (${pct[0]}/${pct[1]}), which is more likely a misread frame line than a real border — judged by eye instead.`,
    };
  }
  return {
    measure: { a, b, pct, cap: back ? centeringCapBack(worst) : centeringCap(worst) },
    note: null,
  };
}

/** Measure centering from the flattened card. Each axis is judged on its own,
 *  so a card whose left and right borders are clean still reports a
 *  left-to-right ratio even when the bottom border has the copyright line
 *  set into it and can't be read. Returns null only when neither axis can be
 *  trusted (full-art and borderless cards). */
export function measureCentering(card: RGBAImage, back = false): CenteringMeasurement | null {
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

  const devs: number[] = [];
  for (let i = 0; i < rs.length; i += 7) {
    devs.push(colorDist([rs[i], gs[i], bs[i]], border));
  }
  const spread = median(devs);
  if (spread > 45) return null;
  // Scale the threshold with the border's own noise, but not without limit:
  // a holo border sparkles, and letting its spread drive the threshold too
  // high made the scan sail straight past the border into the artwork.
  const thr = Math.min(90, Math.max(45, spread * 2));

  const lrResult = measureAxis(card, border, thr, "left", "right", card.width, back);
  const tbResult = measureAxis(card, border, thr, "top", "bottom", card.height, back);
  const lr = lrResult.measure;
  const tb = tbResult.measure;
  if (!lr && !tb) return null;

  const worst = Math.max(lr ? Math.max(...lr.pct) : 0, tb ? Math.max(...tb.pct) : 0);
  const cap = Math.min(lr ? lr.cap : 10, tb ? tb.cap : 10);
  return {
    width: card.width,
    height: card.height,
    lr,
    tb,
    lrNote: lrResult.note,
    tbNote: tbResult.note,
    worst,
    cap,
    borderColor: border,
  };
}

/** Human-readable form for the report and the prompt. */
export function centeringText(m: CenteringMeasurement): string {
  const parts: string[] = [];
  if (m.lr) parts.push(`${m.lr.pct[0]}/${m.lr.pct[1]} left-to-right`);
  if (m.tb) parts.push(`${m.tb.pct[0]}/${m.tb.pct[1]} top-to-bottom`);
  if (parts.length === 1) {
    parts.push(m.lr ? "top-to-bottom not measurable" : "left-to-right not measurable");
  }
  return parts.join(", ");
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
