"use client";

import { useEffect } from "react";
import Link from "next/link";

/** What a member sees when a client-side exception escapes.
 *
 *  There was no boundary at all, so any throw inside a signed-in page —
 *  dragging a cropper handle onto an index that had just gone, say —
 *  replaced the whole app with Next's white page reading "Application
 *  error: a client-side exception has occurred (see the browser console for
 *  more information)". On a phone there is no console to see, so that
 *  sentence is a dead end: nothing to do, nothing to report, and no way
 *  back except retyping the URL.
 *
 *  This keeps the failure inside the page it happened on, offers the two
 *  things that actually help — try again, go home — and shows the error's
 *  own words so a report can name it. The digest is what ties a report to
 *  the server log.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Into the browser console for anyone who has one, and — because this
    // runs on the client — nowhere else. Worth knowing when reading a bug
    // report: the server log will NOT have this.
    console.error("client error:", error);
  }, [error]);

  return (
    <div className="card-panel mx-auto mt-10 max-w-md p-6 text-center">
      <div className="text-3xl">😵‍💫</div>
      <h1 className="mt-2 text-lg font-bold">That screen hit a snag</h1>
      <p className="mt-1 text-sm text-slate-500">
        Something went wrong drawing this page. Nothing you saved is affected — collections,
        decks and grades are stored on the server, not here.
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <button className="btn-primary" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="btn-secondary">
          Back to collection
        </Link>
      </div>
      {(error.message || error.digest) && (
        <p className="mt-4 break-words font-mono text-[11px] leading-snug text-slate-400">
          {error.message}
          {error.digest ? ` · ${error.digest}` : ""}
        </p>
      )}
    </div>
  );
}
