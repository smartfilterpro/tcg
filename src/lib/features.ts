/** Feature switches for whole surfaces of the product.
 *
 *  Trading is OFF. Owner decision: member-to-member trading creates
 *  obligations between people that someone has to referee — disputes,
 *  no-shows, "he said the card was mint" — and that is a support job, not a
 *  code one. The code stays: routes, tables, UI and the trade board are all
 *  intact behind this flag, so turning it back on is this one line plus a
 *  deploy. Nothing is deleted and no member's posts are destroyed.
 *
 *  Client-safe: read directly in components. When off:
 *   - the Trades nav item is hidden and /trades redirects home
 *   - the trade APIs refuse writes (reads stay harmless)
 *   - friends' trade-offer surfaces are hidden
 *   - marketing copy stops promising it
 */
export const TRADING_ENABLED = false;
