"use client";

import { useMemo } from "react";
import { encodeQr } from "@/lib/qr";

/** A QR code as one SVG path.
 *
 *  One path rather than a rect per module: a version-5 symbol is 1,369
 *  modules, and that many DOM nodes is a real cost on a page someone is
 *  holding up at arm's length for a friend to scan.
 *
 *  The quiet zone is not decoration — scanners need four clear modules of
 *  margin to find the symbol, so it is drawn as part of the image and
 *  survives being screenshotted or cropped to the element. */
export default function QrCode({
  value,
  size = 200,
  className,
  title,
}: {
  value: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const qr = useMemo(() => encodeQr(value), [value]);
  if (!qr) return null;

  const quiet = 4;
  const total = qr.size + quiet * 2;
  let d = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={title ?? "QR code"}
    >
      <rect width={total} height={total} fill="#FFFFFF" />
      <path d={d} fill="#16171B" />
    </svg>
  );
}
