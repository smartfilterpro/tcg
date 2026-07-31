/** Product limits, in one place — and client-safe, so the UI and the API
 *  enforce the same number instead of drifting apart. (credits.ts can't be
 *  imported by client components — it pulls in the service-role client.)
 *
 *  Owner's dial: change the number here and every surface follows — the
 *  save gate, the "N of N used" note, and the save-button lock. */
export const FREE_DECK_LIMIT = 3;
