// Reading a request body without agreeing to read any request body.
//
// Security audit finding M3. Scan and grade take base64 images inside a
// JSON body, and App Router route handlers have no body-size limit of
// their own — the Pages router's bodyParser cap does not apply here, and
// nothing replaced it. `await req.json()` therefore buffers whatever
// arrives, however much that is, before any code gets a chance to object.
//
// Both routes require a session and spend credits, so this is abuse by an
// existing member rather than by a stranger. That is a smaller problem,
// not a different one: a handful of concurrent uploads is all it takes to
// exhaust an instance that everybody else is sharing.
//
// Content-Length is checked first because it is free and rejects the
// obvious case before a byte of body is read. It is a claim, not a fact,
// so the stream is counted as well and abandoned the moment it exceeds
// what was allowed.

import { PublicError } from "@/lib/apiError";

function tooLarge(maxBytes: number): PublicError {
  const mb = Math.round(maxBytes / 1_000_000);
  return new PublicError(`That upload is too large — the limit is about ${mb}MB.`, 413);
}

/** Parse a JSON body, refusing anything over `maxBytes`. */
export async function readJson<T>(req: Request, maxBytes: number): Promise<T> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);

  const body = req.body;
  // No stream to count (a polyfilled or already-buffered request): the
  // header check above is what we have, and text() is what is left.
  if (!body) {
    const text = await req.text();
    if (text.length > maxBytes) throw tooLarge(maxBytes);
    return JSON.parse(text) as T;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling. Whatever the sender still has queued is their
      // problem, not this instance's memory.
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PublicError("That request wasn't readable — try again.", 400);
  }
}

/** One downscaled card photo as base64, with room to spare. The client
 *  sends ~200KB; anything near this ceiling is not a card photograph. */
export const SCAN_BODY_LIMIT = 12_000_000;

/** Front, back and up to eight corner close-ups. Larger for the obvious
 *  reason, and still an order of magnitude under what a grade actually
 *  weighs. */
export const GRADE_BODY_LIMIT = 30_000_000;
