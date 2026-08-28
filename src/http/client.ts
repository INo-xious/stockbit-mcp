/**
 * The read/write client. Responsibilities:
 *   - resolve the route's token domain and inject a fresh credential for THAT domain
 *   - concurrency cap + min-spacing + exponential backoff on 429/5xx (reads only)
 *   - on 401: refresh that domain once and retry the request a single time
 *   - recognise a Cloudflare challenge before it is mistaken for an entitlement refusal
 *   - normalize errors via the grpc-gateway envelope mapper
 *   - never leak secrets — though the redaction itself is NOT here: `StockbitError`'s constructor
 *     calls `redact()` (`src/http/errors.ts`), so every message this module throws is scrubbed on
 *     the way in. Worth knowing, because it means the guarantee is only ever as good as
 *     `src/redact.ts`, and `String(err)` on line ~126 hands it a foreign error verbatim.
 *
 * It does not construct the request. Host, method, path, headers, credential placement and redirect
 * policy belong to `src/http/transport.ts` (ADR-0002); callers name a route from the closed table
 * there rather than passing a path, and the `base` override this module used to accept is gone — it
 * was a way to point a bearer-carrying request at an arbitrary origin.
 *
 * ## Why the verbs are split the way they are
 *
 * `getJson` retries. `postJson`, `putJson` and `deleteJson` do not, beyond the 401 refresh. A read
 * that times out can be repeated for free; a write cannot. If a write's response is lost in flight
 * the mutation may already have been applied, and retrying would apply it again — so the only retry
 * on a write is the one case where the request provably did *not* reach the handler.
 */
import { RATE } from "../config.js";
import { ensureFresh, forceRefresh } from "../auth/session.js";
import { challengeError, isChallenge, mapHttpError, StockbitError } from "./errors.js";
import {
  authenticatedRequest,
  domainOf,
  isRefreshRoute,
  type QueryParams,
  type RouteName,
  type Segments,
} from "./transport.js";

/* --------------------------- tiny concurrency limiter --------------------------- */

let active = 0;
const queue: Array<() => void> = [];
let lastStart = 0;

async function acquire(): Promise<void> {
  if (active >= RATE.maxConcurrent) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  // Enforce minimum spacing between request starts.
  const wait = lastStart + RATE.minSpacingMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastStart = Date.now();
}

function release(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------- shared plumbing ------------------------------- */

export interface GetOptions {
  /** Values for the route's dynamic path segments. Validated by the transport. */
  segments?: Segments;
  /** Query params; undefined/null values are dropped, arrays repeat the key. */
  params?: QueryParams;
}

/**
 * The credential for a route, or `undefined` when it takes none of ours.
 *
 * A route with no domain (`auth: "none"` — the two token-exchange endpoints) is called with no
 * credential at all rather than with the main session's, which would be a token sent somewhere it
 * was never issued for.
 */
async function credentialFor(route: RouteName): Promise<string | undefined> {
  const domain = domainOf(route);
  return domain ? ensureFresh(domain) : undefined;
}

/** Read a response body as JSON, falling back to text for the envelope-less short bodies 404s send. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** Turn a non-2xx response into the right typed error. Challenge is checked before the status map. */
function errorFor(route: RouteName, res: Response, body: unknown): StockbitError {
  if (isChallenge(res.status, res.headers)) return challengeError(route);
  return mapHttpError(res.status, body);
}

/* ---------------------------------- core GET ---------------------------------- */

/**
 * GET a JSON resource from a declared route. Returns the parsed body on 2xx; throws StockbitError
 * otherwise. Handles 401 (refresh+retry once) and 429/5xx (backoff up to RATE.maxRetries).
 */
export async function getJson<T = unknown>(route: RouteName, opts: GetOptions = {}): Promise<T> {
  await acquire();
  try {
    let refreshedOn401 = false;
    for (let attempt = 0; attempt <= RATE.maxRetries; attempt++) {
      const token = await credentialFor(route);
      let res: Response;
      try {
        res = await authenticatedRequest(route, {
          token,
          segments: opts.segments,
          params: opts.params,
        });
      } catch (err) {
        // A policy or validation rejection is our bug or the user's — never retried.
        if (err instanceof StockbitError && err.kind === "invalid_param") throw err;
        // Network/abort — treat as upstream and back off.
        if (attempt < RATE.maxRetries) {
          await sleep(RATE.backoffBaseMs * 2 ** attempt);
          continue;
        }
        if (err instanceof StockbitError) throw err;
        throw new StockbitError("upstream", `Network error: ${String(err)}`);
      }

      // 401 → refresh once, retry immediately (doesn't consume a backoff attempt). Not on a refresh
      // route: a 401 there means the refresh token itself is dead, and refreshing again to fix it
      // would recurse.
      if (res.status === 401 && !refreshedOn401 && !isRefreshRoute(route)) {
        refreshedOn401 = true;
        const domain = domainOf(route);
        if (domain) await forceRefresh(domain);
        attempt--; // this loop turn didn't "cost" a retry
        continue;
      }

      // 429 / 5xx → exponential backoff.
      if ((res.status === 429 || res.status >= 500) && attempt < RATE.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after")) * 1000;
        await sleep(retryAfter > 0 ? retryAfter : RATE.backoffBaseMs * 2 ** attempt);
        continue;
      }

      const body = await readBody(res);
      if (!res.ok) throw errorFor(route, res, body);
      return body as T;
    }
    // Exhausted retries.
    throw new StockbitError("upstream", `Request failed after ${RATE.maxRetries} retries`);
  } finally {
    release();
  }
}

/* --------------------------------- the writes --------------------------------- */

/**
 * Send a body-bearing or destructive request to a declared route.
 *
 * **Deliberately does not share `getJson`'s retry behaviour.** See the module note: the only retry
 * here is the 401 refresh, which is the one case where the request provably did not reach the
 * handler. A 429 or 5xx is surfaced to the caller, because the caller is the only layer that knows
 * whether re-attempting is safe — for a layout overwrite it is, for an order it is emphatically not.
 */
async function writeJson<T = unknown>(
  route: RouteName,
  opts: GetOptions & { body?: unknown } = {},
): Promise<T> {
  await acquire();
  try {
    let refreshedOn401 = false;
    for (;;) {
      const token = await credentialFor(route);
      let res: Response;
      try {
        res = await authenticatedRequest(route, {
          token,
          segments: opts.segments,
          params: opts.params,
          body: opts.body,
        });
      } catch (err) {
        if (err instanceof StockbitError) throw err;
        throw new StockbitError("upstream", `Network error: ${String(err)}`);
      }

      if (res.status === 401 && !refreshedOn401 && !isRefreshRoute(route)) {
        // The token was rejected, so the handler never ran. Safe to present a fresh one.
        refreshedOn401 = true;
        const domain = domainOf(route);
        if (domain) await forceRefresh(domain);
        continue;
      }

      const body = await readBody(res);
      if (!res.ok) throw errorFor(route, res, body);
      return body as T;
    }
  } finally {
    release();
  }
}

/** POST JSON to a declared route. No blind retry — see `writeJson`. */
export async function postJson<T = unknown>(
  route: RouteName,
  opts: GetOptions & { body?: unknown } = {},
): Promise<T> {
  return writeJson<T>(route, opts);
}

/** PUT JSON to a declared route. Inherits `postJson`'s no-blind-retry rule. */
export async function putJson<T = unknown>(
  route: RouteName,
  opts: GetOptions & { body?: unknown } = {},
): Promise<T> {
  return writeJson<T>(route, opts);
}

/**
 * DELETE a declared route.
 *
 * A body is permitted because Stockbit's screener-favourite delete takes one, but most callers pass
 * none. Retry rules are the write ones: a DELETE that timed out may already have deleted.
 */
export async function deleteJson<T = unknown>(
  route: RouteName,
  opts: GetOptions & { body?: unknown } = {},
): Promise<T> {
  return writeJson<T>(route, opts);
}
