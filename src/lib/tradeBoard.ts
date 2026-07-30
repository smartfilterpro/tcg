// The public trade board's parent control.
//
// profiles.trade_board_enabled has been settable from Family settings since
// migration 026, but nothing read it — a parent could switch the board off
// and the child's board carried on exactly as before. This is the read side,
// enforced in the API (not just hidden in the UI, which a direct request
// would walk straight past).
//
// Turning the board off never blocks trading: direct offers with family and
// approved pals live on the Friends page and don't touch the board at all.

export const BOARD_OFF_ERROR =
  "The public trade board is off for this profile. You can still trade with " +
  "your family and approved pals from the Friends page.";

/** Absent column (pre-026) and null both mean on — the board predates the
 *  control, so only an explicit false turns it off. */
export function boardEnabled(
  profile: { trade_board_enabled?: boolean | null } | null | undefined
): boolean {
  return profile?.trade_board_enabled !== false;
}
