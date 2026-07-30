import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

// eBay marketplace account deletion / closure notifications.
//
// eBay requires every production application to be reachable here before it
// will keep issuing production keys: when someone deletes their eBay account,
// eBay notifies every app that might be holding their data. The alternative
// is claiming an exemption in the developer portal, which is only honest if
// you store no eBay user data at all — true for us today, but it's a claim
// that has to stay true forever, and the cost of just answering the calls is
// this file.
//
// Two shapes, both required by eBay's spec:
//
//   GET  ?challenge_code=…  → prove we own the endpoint
//   POST { notification }   → an account was deleted; erase their data
//
// We hold nothing to erase. Prices come from public search using an
// application token; no eBay user ever signs into TrainerDeck, so no eBay
// user id, handle or address is stored anywhere in this database. The POST
// handler therefore acknowledges and does nothing — which is the correct
// response, not a stub. If that ever changes (a "link your eBay account"
// feature, say), the deletion has to be implemented here at the same time.

export const dynamic = "force-dynamic";

function verificationToken(): string {
  // Trimmed for the same reason as the PokeTrace key: a trailing newline from
  // pasting into Railway would silently break every challenge, and the only
  // symptom is eBay quietly marking the endpoint down.
  return (process.env.EBAY_VERIFICATION_TOKEN ?? "").trim();
}

/** The endpoint URL exactly as registered with eBay.
 *
 *  This is part of the hash, so it has to match what was typed into the
 *  developer portal character for character — https vs http, trailing slash,
 *  www or not. Deriving it from the request works but goes through whatever
 *  proxy headers Railway sets, so an explicit value wins when one is given. */
function endpointUrl(req: Request): string {
  const configured = (process.env.EBAY_DELETION_ENDPOINT ?? "").trim();
  if (configured) return configured;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${url.pathname}`;
}

export async function GET(req: Request) {
  const token = verificationToken();
  if (!token) {
    // Loud rather than a silent 200: a missing token means the endpoint looks
    // alive to eBay and fails validation for a reason nothing explains.
    console.error("EBAY: challenge received but EBAY_VERIFICATION_TOKEN is not set.");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  const challenge = new URL(req.url).searchParams.get("challenge_code");
  if (!challenge) {
    return NextResponse.json({ error: "Missing challenge_code." }, { status: 400 });
  }

  // eBay's spec: sha256 over the three values concatenated in this exact
  // order, hex encoded.
  const hash = createHash("sha256");
  hash.update(challenge);
  hash.update(token);
  hash.update(endpointUrl(req));

  return NextResponse.json(
    { challengeResponse: hash.digest("hex") },
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(req: Request) {
  // Not signature-verified, deliberately. eBay signs these with a key fetched
  // from their Notification API, and verifying it would matter if the handler
  // did anything — but it deletes nothing, writes nothing and reads nothing,
  // so a forged call achieves exactly what an authentic one does: nothing.
  // The moment this handler touches the database, that verification becomes
  // mandatory and must be added first.
  let username: string | null = null;
  try {
    const body = (await req.json()) as { notification?: { data?: { username?: string } } };
    username = body?.notification?.data?.username ?? null;
  } catch {
    // A body we can't parse is still acknowledged: eBay retries on non-2xx,
    // and retrying will not make it parse.
  }

  // Recorded so there's a trace if we're ever asked to show compliance.
  console.log(`EBAY: account deletion notice${username ? ` for ${username}` : ""} — no data held.`);

  // eBay wants a fast 2xx. Anything else counts against endpoint health and
  // repeated failures get the endpoint marked down.
  return new NextResponse(null, { status: 204 });
}
