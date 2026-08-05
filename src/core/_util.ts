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
