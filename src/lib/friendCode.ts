// Friend codes: the only way to be found.
//
// Crockford base32 — the digits and letters minus I, L, O and U. Dropping
// those is what lets someone read a code off a screen and type it into a
// phone without getting it wrong, and dropping U means the alphabet can't
// accidentally spell anything.
//
// Eight characters is 32^8 ≈ 1.1 trillion codes. Guessing one is not a
// realistic attack, and there is deliberately no prefix lookup to shorten
// the search: the resolver matches whole codes only.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/** Crockford's rule: the excluded letters map back to the digits they look
 *  like, so "I" typed for "1" and "O" typed for "0" both still work. */
const CONFUSIONS: Record<string, string> = { I: "1", L: "1", O: "0", U: "V" };

/** Strip formatting and fix the usual misreadings. Returns "" if what's left
 *  isn't a whole code, so callers can treat empty as "not a code". */
export function normalizeFriendCode(input: string): string {
  const cleaned = [...input.toUpperCase()]
    .map((ch) => CONFUSIONS[ch] ?? ch)
    .filter((ch) => ALPHABET.includes(ch))
    .join("");
  return cleaned.length === CODE_LENGTH ? cleaned : "";
}

/** XXXX-XXXX. The dash is display only — never stored, never sent. */
export function formatFriendCode(code: string | null | undefined): string {
  if (!code) return "";
  const bare = code.replace(/-/g, "");
  return bare.length === CODE_LENGTH ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}

/** A fresh code from a CSPRNG.
 *
 *  Rejection sampling rather than `% 32`: 256 happens to be divisible by 32
 *  so modulo would be uniform here anyway, but the alphabet is a thing that
 *  gets edited, and a biased code generator is exactly the kind of bug that
 *  never announces itself. */
export function generateFriendCode(
  randomBytes: (n: number) => Uint8Array = defaultRandom
): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

function defaultRandom(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/** The shareable link. Scanned from a QR or pasted into a message; the
 *  friends page reads ?add= and offers to send the request. */
export function friendLink(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/friends?add=${formatFriendCode(code)}`;
}
