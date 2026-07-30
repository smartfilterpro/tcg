// Pulling complete objects out of JSON that is still arriving.
//
// The scan model writes its answer as `{"count":6,"cards":[{…},{…},…]}` over
// ten to thirty seconds. Waiting for the closing brace before showing
// anything is why the scan page had a progress bar driven by a 3.5-second
// timer: the client genuinely knew nothing until the end, so it invented
// something to display.
//
// Each card is complete long before the message is. This walks the buffer as
// it grows and hands back each object the moment its braces balance, so "reading
// Bergmite… ✓ 042/191" is a real event rather than a guess.
//
// Not a JSON parser — a brace counter that respects strings and escapes,
// which is all that's needed to find object boundaries. The objects
// themselves go through JSON.parse, so anything malformed is skipped rather
// than half-understood.

export interface ObjectScanner {
  /** Feed the next chunk; returns any objects that completed within it. */
  push(chunk: string): unknown[];
  /** Everything received so far, for a final whole-message parse. */
  text(): string;
}

export function createObjectScanner(): ObjectScanner {
  let buffer = "";
  // Where the unscanned part starts. Never rewinds, so cost stays linear in
  // the message length rather than quadratic in the number of chunks.
  let cursor = 0;
  // A STACK of start offsets, not a single depth counter.
  //
  // The cards are nested inside the envelope, so they open at depth 1 and
  // close back to depth 1 — a "closed at depth 0" test only ever fires for
  // the envelope, which arrives last and defeats the entire point. Every
  // object is emitted as it closes, innermost first, and the consumer picks
  // the ones it wants.
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const out: unknown[] = [];

      while (cursor < buffer.length) {
        const c = buffer[cursor];

        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
          cursor++;
          continue;
        }

        if (c === '"') {
          inString = true;
        } else if (c === "{") {
          starts.push(cursor);
        } else if (c === "}") {
          // A stray closing brace (in prose the model wrapped around the
          // JSON) pops nothing rather than corrupting the state.
          const start = starts.pop();
          if (start != null) {
            try {
              out.push(JSON.parse(buffer.slice(start, cursor + 1)));
            } catch {
              // A slice that doesn't parse is a boundary we got wrong, not a
              // reason to stop reading the rest.
            }
          }
        }
        cursor++;
      }
      return out;
    },
    text: () => buffer,
  };
}

/** The envelope — `{"count":…,"cards":[…]}` — arrives last, after the cards
 *  nested inside it. A consumer showing progress wants everything EXCEPT it.
 *
 *  Distinguished by shape rather than by order: an object carrying a `cards`
 *  array is the envelope. Checking order would break the moment the model
 *  emits a trailing field. */
export function isEnvelope(obj: unknown): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    Array.isArray((obj as { cards?: unknown }).cards)
  );
}
