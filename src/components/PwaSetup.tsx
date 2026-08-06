"use client";

// Registering the service worker, and offering to install the app.
//
// Two small jobs that both have to be done in the browser, kept together so
// there is one place to look for "why is this behaving like an app?".
//
// The install prompt is the interesting half. Chrome fires
// beforeinstallprompt and lets a page hold onto it and ask later; iOS fires
// nothing at all and requires the person to use Share → Add to Home Screen,
// which nobody discovers on their own. So: a quiet strip, shown once the app
// has clearly been used rather than on first sight, dismissible for good, and
// never shown to somebody who has already installed it.

import { useEffect, useState } from "react";

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "trainerdeck.install.dismissed";

/** Already running as an installed app? Then there is nothing to offer.
 *  iOS reports it on navigator, everyone else through the media query. */
function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function PwaSetup() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);

  // 1. The service worker.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Only where there IS a built app to cache. In development the assets
    // change on every keystroke and a cache is purely an obstacle.
    if (process.env.NODE_ENV !== "production") return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        // Not fatal, ever: the app works exactly as before without one.
        console.warn("service worker registration failed", err);
      });
    };
    // After load, so registering never competes with the first paint.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  // 2. The install offer.
  useEffect(() => {
    if (isInstalled()) return;
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      // Private mode with storage blocked: showing the strip is fine, it
      // just won't be remembered as dismissed.
    }

    const onPrompt = (e: Event) => {
      // Chrome would otherwise show its own mini-infobar; holding the event
      // is what lets the offer sit inside the app's own design.
      e.preventDefault();
      setPrompt(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS never fires that event, so the hint is offered on its own terms —
    // and only in Safari, since Chrome on iOS cannot install anything.
    if (isIos() && /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent)) {
      setShowIosHint(true);
    }
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {}
    setPrompt(null);
    setShowIosHint(false);
  };

  if (!prompt && !showIosHint) return null;

  return (
    <div className="mx-auto mb-3 flex max-w-5xl items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
      <span className="min-w-0 flex-1 leading-snug">
        {prompt ? (
          <>
            <b>Add TrainerDeck to your home screen</b> — it opens straight to your collection and
            works without a signal.
          </>
        ) : (
          <>
            <b>Add TrainerDeck to your home screen</b> — tap Share, then &ldquo;Add to Home
            Screen&rdquo;.
          </>
        )}
      </span>
      {prompt && (
        <button
          className="btn-secondary shrink-0 text-xs"
          onClick={async () => {
            const event = prompt;
            setPrompt(null);
            try {
              await event.prompt();
              await event.userChoice;
            } catch {
              // They closed it. Nothing to do and nothing to say.
            }
            dismiss();
          }}
        >
          Install
        </button>
      )}
      <button
        className="shrink-0 text-lg leading-none text-slate-400 hover:text-slate-700"
        aria-label="Not now"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}
