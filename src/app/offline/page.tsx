import { APP_NAME } from "@/lib/branding";

// What an installed app shows when there is no signal.
//
// Precached at install, so it is the one page guaranteed to render with the
// network gone. It says what is true — the phone is offline, the collection
// lives on a server, nothing has been lost — and nothing else. A cached
// collection would be worse than this page: prices move, cards get added on
// another device, and a stale total presented as a real one is the kind of
// wrong the rest of this app has spent a week removing.

export const metadata = { title: `Offline — ${APP_NAME}` };

export default function OfflinePage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="text-4xl">📶</span>
      <h1 className="m-0 font-display text-xl font-bold">No connection</h1>
      <p className="m-0 text-sm leading-relaxed text-slate-500">
        {APP_NAME} needs a signal to reach your collection — your cards, prices and decks live on
        the server, not on this phone, so nothing here is lost. This page will come back to life
        the moment you are back online.
      </p>
      <p className="m-0 text-xs text-slate-400">
        Scans taken while offline are not saved. Take the photo again once you have a signal.
      </p>
    </div>
  );
}
