// Finding several cards in one photo, without asking a model.
//
// Purely for the overlay drawn while a scan runs — the rectangles that say
// "six detected" before the reading finishes. That framing is what makes a
// classical approach the right choice here rather than a compromise: if this
// misses a card, the model still reads it and the card still lands in the
// collection. The failure is a missing rectangle, not a missing card. Very
// little else in the app can absorb an imperfect algorithm that cheaply, and
// it costs no tokens at all.
//
// The method is deliberately unclever, because clever fails in ways that are
// hard to explain to someone holding a phone:
//
//   1. shrink the photo — detection doesn't need pixels, it needs shapes
//   2. take the background colour from the border ring
//   3. mark every pixel that isn't the background
//   4. flood-fill the marks into connected blobs
//   5. keep blobs that are card-shaped: right proportions, solid, big enough
//
// Where it struggles is predictable and worth designing the capture flow
// around: cards overlapping each other merge into one blob, and white-
// bordered cards on a white table have no step 3 to speak of. Both are fixed
// by spreading the cards on a dark surface, which is advice that improves the
// model's reading too.

import { CARD_ASPECT, downscale, type RGBAImage } from "@/lib/cardGeometry";

export interface CardBox {
  /** Fractions of the source image, 0–1, so a caller can position an overlay
   *  without knowing what size it rendered the photo at. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Working width for detection. Small on purpose: a card is a large shape,
 *  and 512px is plenty to find one while keeping the flood fill under a few
 *  hundred thousand pixels. */
const WORK_DIM = 512;

/** A card is 63:88 ≈ 0.716 upright, or 1.396 on its side.
 *
 *  0.18, not 0.34. At 0.34 a roughly SQUARE blob passes — |1.0 − 0.716| =
 *  0.284 — and a 2×2 block of cards that merged into one blob is roughly
 *  square. So the loose tolerance was the thing letting the worst kind of
 *  detection through: one huge box over four cards, which looks like a
 *  confident answer and is nonsense. 0.18 still covers a card foreshortened
 *  by a phone held at an angle (0.54–0.90) and rejects the square. */
const ASPECT_TOLERANCE = 0.18;

/** A card is a solid rectangle, so its blob should nearly fill its own
 *  bounding box. This is what rejects hands, shadows, table edges and the
 *  pattern on a play mat, all of which are foreground but not rectangles. */
const MIN_FILL = 0.62;

/** Fraction of the photo one card must occupy. Below this it's a crumb — a
 *  speck of dust or a bit of text — and above it, it's the table. */
const MIN_AREA = 0.006;
const MAX_AREA = 0.55;

function ringBackground(img: RGBAImage): [number, number, number] {
  // Median of the border pixels. Median rather than mean so one dark object
  // touching the edge doesn't drag the estimate.
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    rs.push(img.data[i]);
    gs.push(img.data[i + 1]);
    bs.push(img.data[i + 2]);
  };
  const band = Math.max(1, Math.round(Math.min(img.width, img.height) * 0.03));
  for (let y = 0; y < img.height; y += 2) {
    for (let d = 0; d < band; d++) {
      push(d, y);
      push(img.width - 1 - d, y);
    }
  }
  for (let x = 0; x < img.width; x += 2) {
    for (let d = 0; d < band; d++) {
      push(x, d);
      push(x, img.height - 1 - d);
    }
  }
  const mid = (v: number[]) => {
    v.sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : 0;
  };
  return [mid(rs), mid(gs), mid(bs)];
}

/** Cards in a photo, as fractions of its size. Empty when nothing
 *  card-shaped stands out — which is a normal answer, not a failure. */
export function detectCards(source: RGBAImage, tolerance = 54): CardBox[] {
  const { img } = downscale(source, WORK_DIM);
  const { width: w, height: h } = img;
  if (w < 32 || h < 32) return [];

  const bg = ringBackground(img);
  const total = w * h;

  // 1 = not background.
  const fg = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const dr = img.data[p] - bg[0];
    const dg = img.data[p + 1] - bg[1];
    const db = img.data[p + 2] - bg[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) > tolerance) fg[i] = 1;
  }

  // Shrink the foreground by one pixel before labelling.
  //
  // Cards laid out in a block are separated by a gap of a millimetre or two,
  // which at this working size is one or two pixels — and a single bridging
  // pixel, from a shadow or a compression artefact, welds two cards into one
  // blob. Eroding first breaks those bridges. Solid card interiors lose only
  // their outermost pixel, which the bounding box doesn't miss.
  const eroded = new Uint8Array(total);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (
        fg[i] &&
        fg[i - 1] &&
        fg[i + 1] &&
        fg[i - w] &&
        fg[i + w]
      ) {
        eroded[i] = 1;
      }
    }
  }
  fg.set(eroded);

  // Flood fill with an explicit stack. Recursion would blow the stack on a
  // blob of 50,000 pixels, which is an ordinary card at this size.
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const boxes: CardBox[] = [];

  for (let start = 0; start < total; start++) {
    if (fg[start] === 0 || seen[start] === 1) continue;

    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let area = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 4-connected: diagonal linking bridges cards that merely touch at a
      // corner, merging two into one blob.
      if (x > 0 && fg[idx - 1] && !seen[idx - 1]) {
        seen[idx - 1] = 1;
        stack[sp++] = idx - 1;
      }
      if (x < w - 1 && fg[idx + 1] && !seen[idx + 1]) {
        seen[idx + 1] = 1;
        stack[sp++] = idx + 1;
      }
      if (y > 0 && fg[idx - w] && !seen[idx - w]) {
        seen[idx - w] = 1;
        stack[sp++] = idx - w;
      }
      if (y < h - 1 && fg[idx + w] && !seen[idx + w]) {
        seen[idx + w] = 1;
        stack[sp++] = idx + w;
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const boxArea = bw * bh;
    const areaFrac = boxArea / total;
    if (areaFrac < MIN_AREA || areaFrac > MAX_AREA) continue;
    if (area / boxArea < MIN_FILL) continue;

    // Card-shaped either way up.
    const ratio = bw / bh;
    const upright = Math.abs(ratio - CARD_ASPECT);
    const sideways = Math.abs(ratio - 1 / CARD_ASPECT);
    if (Math.min(upright, sideways) > ASPECT_TOLERANCE) continue;

    boxes.push({ x: minX / w, y: minY / h, w: bw / w, h: bh / h });
  }

  // Reading order, so the overlay's numbering matches how someone laid the
  // cards out and how the model reads them.
  return boxes.sort((a, b) => (Math.abs(a.y - b.y) > 0.08 ? a.y - b.y : a.x - b.x));
}
