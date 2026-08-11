// One way to write a dollar amount.
//
// The app had 47 hand-rolled `toFixed(2)` calls, which is fine until a
// number reaches four figures and prints as $1727.55 — a total that reads
// as $172 at a glance and takes a second look to parse. Thousands
// separators are not decoration on a page whose whole job is telling
// somebody what their collection is worth.
//
// toLocaleString rather than a hand-rolled regex: it puts the separator
// where the reader's locale expects it, which for the same collection is a
// comma in Chicago and a full stop in Berlin.

/** A price, with separators and always two decimals. */
export function money(value: number): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The same, for a value that might not exist. Renders an em dash rather
 *  than $0.00, because "nothing has priced this" and "this is worthless"
 *  are different facts and only one of them is usually true. */
export function moneyOrDash(value: number | null | undefined): string {
  return value == null ? "—" : money(value);
}
