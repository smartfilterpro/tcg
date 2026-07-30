"use client";

// The admin's banner, at the top of the signed-in app.
//
// Dismissal is remembered per notice id in localStorage, not per session: a
// notice someone has read and closed should stay closed as they move around
// the app, and a NEW notice must reappear even if they closed the last one.
// Keying on the id is what makes both true.

import { useEffect, useState } from "react";

interface Notice {
  id: string;
  body: string;
  level: "info" | "warning" | "outage";
  dismissible: boolean;
}

const STYLES: Record<Notice["level"], string> = {
  info: "border-brand-line bg-white text-brand-ink2",
  warning: "border-[#F0DFA8] bg-[#FFF8E1] text-[#7A5A12]",
  outage: "border-[#F3C6BE] bg-[#FDF0EE] text-[#8C2E1E]",
};

const ICONS: Record<Notice["level"], string> = {
  info: "ℹ️",
  warning: "⚠️",
  outage: "🚫",
};

const dismissKey = (id: string) => `notice-dismissed:${id}`;

export default function SiteNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/notice")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const n = j?.notice as Notice | null | undefined;
        if (!live || !n) return;
        try {
          if (n.dismissible && localStorage.getItem(dismissKey(n.id))) return;
        } catch {
          // Private browsing with storage disabled: show it. A banner shown
          // twice is a smaller failure than an outage notice never shown.
        }
        setNotice(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!notice) return null;

  return (
    <div className={`border-b ${STYLES[notice.level]}`}>
      <div className="mx-auto flex max-w-[1060px] items-start gap-2.5 px-4 py-2.5 sm:px-6">
        <span aria-hidden className="shrink-0 text-[13px] leading-[1.5]">
          {ICONS[notice.level]}
        </span>
        <p className="m-0 min-w-0 flex-1 text-[13.5px] leading-[1.5]">{notice.body}</p>
        {notice.dismissible && (
          <button
            aria-label="Dismiss"
            className="shrink-0 rounded px-1.5 text-[13px] opacity-60 hover:opacity-100"
            onClick={() => {
              try {
                localStorage.setItem(dismissKey(notice.id), "1");
              } catch {}
              setNotice(null);
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
