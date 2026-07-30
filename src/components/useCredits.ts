"use client";

// One answer to "can this person spend right now", shared by every AI button.
//
// Credits are the only real limit on AI features. The plan lock in the nav is
// a pitch; this is the wall, and it applies to paid plans exactly as it does
// to free ones — a Pro who has burned through the month's allowance is in the
// same position as a free user, and pretending otherwise would be a worse
// surprise for the person who is actually paying.
//
// Fetched once per page load and shared: half a dozen components asking the
// same question should not be half a dozen requests. `refresh()` re-reads
// after a spend so the balance and the lock stay honest without a reload.

import { useCallback, useEffect, useState } from "react";
import type { CreditsInfo } from "@/components/CreditsMeter";

export interface CreditState {
  credits: CreditsInfo | null;
  /** Unmetered. Admins never see a lock. */
  admin: boolean;
  /** Nothing left to spend. False while still loading — a lock that flashes
   *  on every page load would be worse than one that arrives a moment late. */
  empty: boolean;
  loading: boolean;
  refresh: () => void;
}

let shared: Promise<{ admin: boolean; credits: CreditsInfo | null }> | null = null;

function load(force = false) {
  if (!shared || force) {
    shared = fetch("/api/usage/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => ({ admin: j?.admin === true, credits: (j?.credits as CreditsInfo) ?? null }))
      // A failed lookup must not lock anyone out of something they can
      // afford: no data means no lock, and the server refuses the spend
      // anyway if they genuinely can't.
      .catch(() => ({ admin: false, credits: null }));
  }
  return shared;
}

export function useCredits(): CreditState {
  const [state, setState] = useState<{ admin: boolean; credits: CreditsInfo | null } | null>(null);

  const read = useCallback((force: boolean) => {
    let live = true;
    load(force).then((v) => {
      if (live) setState(v);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => read(false), [read]);

  const refresh = useCallback(() => {
    read(true);
  }, [read]);

  return {
    credits: state?.credits ?? null,
    admin: state?.admin === true,
    empty: state != null && state.admin !== true && (state.credits?.balance ?? 1) <= 0,
    loading: state == null,
    refresh,
  };
}
