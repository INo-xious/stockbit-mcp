/**
 * Symbol validation — the single place a user-supplied ticker becomes a value this codebase will
 * put in a URL.
 *
 * Nearly every read is keyed by Symbol, and most routes carry it as a *path segment*. Core
 * modules used to interpolate `symbol.toUpperCase()` straight into a template, which uppercases
 * `../` and `%2e%2e` just as happily as `BBRI` — so the path a request took was decided by tool
 * input, not by the route table. Validation happens here and nowhere else; the transport then
 * treats an unvalidated segment as a programming error.
 *
 * The charset is deliberately narrower than "whatever IDX might list". It admits ordinary tickers
 * (`BBRI`), indices (`IHSG`, `LQ45`), and the hyphenated non-regular-board suffixes Stockbit uses
 * for rights and warrants (`BUKA-W`, `BBRI-R`). It excludes `/`, `.`, `%`, `?`, `#`, and every
 * other character that could change a URL's meaning. If a legitimate Symbol is ever rejected, the
 * fix is to widen this rule under review — not to bypass it at a call site.
 */
import { StockbitError } from "./http/errors.js";

/** Uppercase alphanumeric, optionally one hyphenated suffix. Anchored; no separators. */
const SYMBOL_RE = /^[A-Z0-9]{1,12}(-[A-Z0-9]{1,4})?$/;

/**
 * Normalize and validate a Symbol: trims, uppercases, then checks the charset.
 *
 * Throws `invalid_param` on anything else — this is user error (a bad tool argument or config
 * value), never upstream schema drift.
 */
export function normalizeSymbol(input: string): string {
  if (typeof input !== "string") {
    throw new StockbitError("invalid_param", "Symbol must be a string");
  }
  const symbol = input.trim().toUpperCase();
  if (!symbol) {
    throw new StockbitError("invalid_param", "Symbol must not be empty");
  }
  if (!SYMBOL_RE.test(symbol)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid Symbol ${JSON.stringify(input)}: expected an uppercase IDX ticker ` +
        `such as BBRI or IHSG, optionally with a -W/-R suffix`,
    );
  }
  return symbol;
}

/** Whether `input` is already a valid Symbol, without throwing. */
export function isSymbol(input: string): boolean {
  return typeof input === "string" && SYMBOL_RE.test(input);
}
