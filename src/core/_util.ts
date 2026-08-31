/**
 * Shared helpers for core modules: a tiny TTL cache and a zod-based schema guard.
 */
import { z } from "zod";
import { StockbitError } from "../http/errors.js";

/* --------------------------------- TTL cache --------------------------------- */

interface Entry {
  value: unknown;
  expiresAt: number;
}
const cacheMap = new Map<string, Entry>();

/** Memoize an async loader by key for `ttlMs`. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cacheMap.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const value = await load();
  cacheMap.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/** Clear the cache (tests). */
export function clearCache(): void {
  cacheMap.clear();
}

/**
 * Drop the entries whose key starts with `prefix`.
 *
 * Exists so a write can invalidate exactly what it changed. `clearCache()` empties the whole map —
 * every symbol's quotes, keystats, ratios and broker summaries — which is fine in a test and
 * needlessly destructive when one layout was saved.
 */
export function invalidateCache(prefix: string): void {
  for (const key of cacheMap.keys()) {
    if (key.startsWith(prefix)) cacheMap.delete(key);
  }
}

/* ------------------------------- schema guard ------------------------------- */

/**
 * Validate `body` against `schema`. On mismatch, throw a typed schema_drift error rather than
 * silently mis-parsing — this API is private and undocumented, so drift must fail loudly.
 */
export function parseOr<T>(schema: z.ZodType<T>, body: unknown, context: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "<root>"}: ${issue.message}` : "unknown";
    throw new StockbitError("schema_drift", `Unexpected ${context} response shape (${where})`);
  }
  return result.data;
}

/** Common ID types can arrive as string or number; coerce to a string output. */
export const StrOrNum = z.coerce.string();

/* ------------------------------- reading a number ------------------------------- */

/**
 * One wire number, or `null` when the response did not carry a usable one.
 *
 * ## Why this is not `z.coerce.number()`
 *
 * `z.coerce.number()` is `Number()`, and `Number("")`, `Number(null)`, `Number("  ")`,
 * `Number(false)` and `Number([])` are every one of them **0**. A schema that coerces therefore
 * destroys the difference between "the field was absent" and "the figure was zero" before any
 * projection can report it — and on this API that difference is the whole answer: "no foreign flow
 * today" and "we have no idea" are not the same claim. This project has now made that mistake in
 * four separate modules, so `src/core/` now has one reader and every route there goes through it.
 * `src/analysis/analyze.ts` and `src/live/tape.ts` still carry their own; the live one does not
 * guard the empty string at all, and is recorded as an open finding rather than changed from here.
 *
 * ## The rule
 *
 * What the value IS, never a list of empties — enumerating them missed `"  "` once already. A
 * number passes as itself; a string passes only when it still has content once separators and
 * space are removed; a `{value}` or `{raw}`
 * wrapper is unwrapped, because both are live on this API (`src/core/pricefeed.ts` measured
 * `{"value":"3,910"}` beside bare numbers); everything else is absent.
 *
 * A non-numeric string is `null` rather than `NaN`: `NaN` is not a figure, and every consumer would
 * otherwise need its own guard. Thousands separators are stripped — a `"1,234"` read as unreadable
 * would be worse than reading it. NOTE that makes `"1,5"` 15, not 1.5: the Indonesian decimal comma
 * is not distinguishable from a thousands separator without knowing the field's magnitude, and this
 * project has never seen a decimal comma on a numeric wire field.
 */
export function wireNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // Separators come out BEFORE the emptiness test, not after. With the order reversed a string
    // of nothing but separators — "," or " , " — has non-space content, passes the guard, becomes
    // "" during the strip, and `Number("")` is 0. That put the whole defect back for a fourth
    // time, in the one function every price and every statistic now flows through.
    const cleaned = value.replace(/,/g, "").trim();
    if (cleaned === "") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    const wrapper = value as Record<string, unknown>;
    if ("value" in wrapper) return wireNumber(wrapper.value);
    if ("raw" in wrapper) return wireNumber(wrapper.raw);
  }
  return null;
}
