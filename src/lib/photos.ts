"use client";

// Client-side helpers for storing user-taken card photos in Supabase Storage.
// Used when the card databases have no image (most promos, manual entries).
import { createClient } from "@/lib/supabase/client";

/** Downscale any image blob/file to a reasonable card-photo JPEG. */
export async function downscaleToJpeg(source: Blob, maxDim = 1000, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", quality)
  );
}

/** Upload a card photo to the user's folder; returns the URL it is stored
 *  under, or null on any failure (photo storage is always best-effort).
 *
 *  That URL does not resolve. The bucket is private (migration 054) and
 *  getPublicUrl here is pure string-building, not a promise about access —
 *  what comes back is the identifier the catalogue and the grade reports
 *  are written with, and every display of it goes through photoSrc(), which
 *  points at /api/photo to have it signed for whoever is looking. */
export async function uploadCardPhoto(source: Blob): Promise<string | null> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const blob = await downscaleToJpeg(source);
    const path = `${user.id}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage
      .from("card-photos")
      .upload(path, blob, { contentType: "image/jpeg" });
    if (error) return null;
    return supabase.storage.from("card-photos").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}
