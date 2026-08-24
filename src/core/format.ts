/**
 * Number formatting for text a person reads.
 *
 * Locale-independent on purpose. `toLocaleString` would render a rupiah figure differently
 * depending on the machine the server happens to run on, and the two Indonesian conventions
 * disagree about which separator is decimal — so a test could pass on a developer's laptop and a
 * user could read a number a thousand times too large.
 */

/** Rupiah with thousand separators, e.g. `Rp 4,100`. `null` renders as `unknown`, never as 0. */
export function idr(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}Rp ${grouped}`;
}

/** A percentage with a fixed number of places. `null` renders as `unknown`. */
export function pct(value: number | null, places = 2): string {
  return value === null || !Number.isFinite(value) ? "unknown" : `${value.toFixed(places)}%`;
}
