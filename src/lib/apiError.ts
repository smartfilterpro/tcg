// What a failing route is allowed to say.
//
// Security audit finding M1: eighty-five route handlers ended in
//
//   { error: err instanceof Error ? err.message : "Scan failed" }
//
// which reads as "show the real reason, fall back to something friendly"
// and behaves as "show the client whatever the database, the storage
// layer, the payment processor or an upstream API happened to say". That
// is table and column names, connection strings, upstream URLs and library
// internals, handed to anybody who can make a request fail — and the
// friendly string, the one an author actually wrote for this route, was
// the branch that almost never ran.
//
// The rule now: a message reaches the client only if somebody wrote it for
// a person. Everything else is logged in full on the server, where it was
// always more useful anyway, and the client gets the route's own sentence.
//
// Two kinds of error are people-facing, and both say so in their type:
//
//   AuthError    — "Not authenticated", "Admin only", a suspended account
//   PublicError  — "Both of today's downloads are used", "Try a different
//                  photo", "Run the card catalogue import first"
//
// If you are writing a throw whose message a member should read, throw a
// PublicError. If you are not sure, you are not sure it is safe, and a
// plain Error is the right answer.

import { NextResponse } from "next/server";

/** An error whose message is written for a person and may be shown to one. */
export class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

/** Recognised by name rather than by `instanceof AuthError`, so that this
 *  module imports nothing: it is used by libraries that run outside a
 *  request, and importing auth would pull next/headers into all of them. */
function isPublic(err: unknown): err is Error & { status: number } {
  return (
    err instanceof Error &&
    (err.name === "AuthError" || err.name === "PublicError") &&
    typeof (err as { status?: unknown }).status === "number"
  );
}

/** The message to show, and nothing more.
 *
 *  For places that record a failure rather than return one — a job row a
 *  member will read later is exactly as public as an HTTP response. */
export function safeMessage(err: unknown, fallback: string): string {
  if (isPublic(err)) return err.message;
  return fallback;
}

/** The standard failure response.
 *
 *  `fallback` is what the client is told when the error is not one of ours:
 *  keep it specific to the route ("Scan failed", "Couldn't save the deck"),
 *  because it is now the only thing anybody will read. */
export function errorJson(err: unknown, fallback: string, status = 500): NextResponse {
  if (isPublic(err)) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // The full error, once, on the server. Losing this while hiding the
  // message from the client would be trading one problem for a worse one.
  console.error(`${fallback}:`, err);
  return NextResponse.json({ error: fallback }, { status });
}
