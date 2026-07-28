"use client";

// Browser glue between a photo file and the pure geometry in cardGeometry.ts:
// decode, rectify, crop the corner close-ups, and encode what the grader
// actually sees.

import {
  backgroundBleed,
  detectCardQuad,
  defaultQuad,
  estimateBackground,
  measureCentering,
  quadLooksLikeCard,
  photoMetrics,
  rectifyCard,
  rectifyRegion,
  CORNER_REGIONS,
  type CenteringMeasurement,
  type PhotoMetrics,
  type Quad,
  type RGBAImage,
} from "@/lib/cardGeometry";

export interface LoadedPhoto {
  img: RGBAImage;
  /** Object URL for display — revoke when done. */
  url: string;
  width: number;
  height: number;
}

/** Decode a photo to pixels. imageOrientation is pinned explicitly: the
 *  default has differed between browsers and browser versions, and an
 *  iPhone photo that arrives rotated would put the card's corners somewhere
 *  else entirely. 2400px keeps the corner close-ups at roughly native
 *  resolution while holding the decoded pixels (which stay in memory so the
 *  corners can be re-dragged) to about 30MB a side. */
export async function loadPhoto(file: File, maxDim = 2400): Promise<LoadedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const data = ctx.getImageData(0, 0, width, height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  return {
    img: { data: data.data, width, height },
    url: URL.createObjectURL(blob ?? file),
    width,
    height,
  };
}

/** Auto-detected card corners, or a sensible starting rectangle the user
 *  can drag into place. */
export function initialQuad(photo: LoadedPhoto): { quad: Quad; detected: boolean } {
  const found = detectCardQuad(photo.img);
  if (found) return { quad: found, detected: true };
  return { quad: defaultQuad(photo.width, photo.height), detected: false };
}

function toCanvas(img: RGBAImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  const frame = ctx.createImageData(img.width, img.height);
  frame.data.set(img.data);
  ctx.putImageData(frame, 0, 0);
  return canvas;
}

async function encode(
  img: RGBAImage,
  quality: number
): Promise<{ base64: string; dataUrl: string; blob: Blob }> {
  const canvas = toCanvas(img);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality)
  );
  return { base64: dataUrl.split(",")[1], dataUrl, blob };
}

/** Measure only when the outline is actually shaped like a card. An outline
 *  that has collapsed onto part of the card still produces a confident
 *  ratio — the back of a card cropped square once reported 70/30 and capped
 *  the grade at 7 — and that number goes on to clamp the grade, so a wrong
 *  crop must produce no measurement rather than a wrong one. */
function measurableCentering(quad: Quad, card: RGBAImage) {
  if (!quadLooksLikeCard(quad)) return null;
  return measureCentering(card);
}

export interface SidePreview {
  cardDataUrl: string;
  measurement: CenteringMeasurement | null;
  metrics: PhotoMetrics;
  /** Fraction of the flattened card's edge that is really table. */
  bleed: number;
}

/** Flatten and measure without encoding the corner close-ups — cheap enough
 *  to re-run while the corners are being dragged, so the centering number
 *  updates live and for free, before any AI call. */
export function previewSide(photo: LoadedPhoto, quad: Quad): SidePreview | null {
  const card = rectifyCard(photo.img, quad, 800);
  if (!card) return null;
  return {
    cardDataUrl: toCanvas(card).toDataURL("image/jpeg", 0.85),
    measurement: measurableCentering(quad, card),
    metrics: photoMetrics(card),
    bleed: backgroundBleed(card, estimateBackground(photo.img)),
  };
}

export interface CornerCrop {
  key: string;
  label: string;
  base64: string;
  dataUrl: string;
}

export interface PreparedSide {
  /** The flattened card, background removed by construction. */
  cardBase64: string;
  cardDataUrl: string;
  cardBlob: Blob;
  corners: CornerCrop[];
  measurement: CenteringMeasurement | null;
  metrics: PhotoMetrics;
}

/** Turn a photo + placed corners into everything the grader needs: the
 *  flattened card, four corner close-ups lifted from the full-resolution
 *  photo, the measured centering, and photo-quality metrics. */
export async function prepareSide(photo: LoadedPhoto, quad: Quad): Promise<PreparedSide | null> {
  const card = rectifyCard(photo.img, quad, 800);
  if (!card) return null;
  const measurement = measurableCentering(quad, card);
  const metrics = photoMetrics(card);
  // Quality 0.92: high enough that JPEG ringing isn't mistaken for print
  // lines on the surface.
  const encoded = await encode(card, 0.92);

  const corners: CornerCrop[] = [];
  for (const region of CORNER_REGIONS) {
    // Cropped from the original photo, not from the 800px card — a corner
    // sampled from a whole-card thumbnail is far too coarse to judge
    // fraying on.
    const crop = rectifyRegion(photo.img, quad, region.u0, region.v0, region.u1, region.v1, 340, 340);
    if (!crop) continue;
    const enc = await encode(crop, 0.92);
    corners.push({ key: region.key, label: region.label, base64: enc.base64, dataUrl: enc.dataUrl });
  }

  return {
    cardBase64: encoded.base64,
    cardDataUrl: encoded.dataUrl,
    cardBlob: encoded.blob,
    corners,
    measurement,
    metrics,
  };
}
