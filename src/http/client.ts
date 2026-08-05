/**
 * Market-data read client. Responsibilities:
 *   - inject a fresh Bearer token (auth/session)
 *   - concurrency cap + min-spacing + exponential backoff on 429/5xx
 *   - on 401: refresh once and retry the request a single time
 *   - normalize errors via the grpc-gateway envelope mapper
 *   - never leak secrets (redaction is applied to all thrown errors)
 *
 * It does not construct the request. Host, method, path, headers, and redirect policy belong to
 * `src/http/transport.ts` (ADR-0002); callers name a route from the closed table there rather than
 * passing a path, and the `base` override this module used to accept is gone — it was a way to
 * point a bearer-carrying request at an arbitrary origin.
 */
import { RATE } from "../config.js";
import { ensureFresh, forceRefresh } from "../auth/session.js";
import { mapHttpError, StockbitError } from "./errors.js";
import { authenticatedRequest, type QueryParams, type RouteName, type Segments } from "./transport.js";

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

/* ---------------------------------- core GET ---------------------------------- */

export interface GetOptions {
  /** Values for the route's dynamic path segments. Validated by the transport. */
  segments?: Segments;
  /** Query params; undefined/null values are dropped. */
  params?: QueryParams;
}

/**
 * GET a JSON resource from a declared route. Returns the parsed body on 2xx; throws StockbitError
 * otherwise. Handles 401 (refresh+retry once) and 429/5xx (backoff up to RATE.maxRetries).
 */
export async function getJson<T = unknown>(route: RouteName, opts: GetOptions = {}): Promise<T> {
  await acquire();
  try {
    let refreshedOn401 = false;
    for (let attempt = 0; attempt <= RATE.maxRetries; attempt++) {
      const token = await ensureFresh();
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

      // 401 → refresh once, retry immediately (doesn't consume a backoff attempt).
      if (res.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        await forceRefresh();
        attempt--; // this loop turn didn't "cost" a retry
        continue;
      }

      // 429 / 5xx → exponential backoff.
      if ((res.status === 429 || res.status >= 500) && attempt < RATE.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after")) * 1000;
        await sleep(retryAfter > 0 ? retryAfter : RATE.backoffBaseMs * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (!res.ok) throw mapHttpError(res.status, body);
      return body as T;
    }
    // Exhausted retries.
    throw new StockbitError("upstream", `Request failed after ${RATE.maxRetries} retries`);
  } finally {
    release();
  }
}

/* ---------------------------------- core POST ---------------------------------- */

/**
 * POST JSON to a declared route.
 *
 * **Deliberately does not share `getJson`'s retry behaviour.** A read that times out can be repeated
 * for free; a write cannot. If a POST's response is lost in flight, the mutation may already have
 * been applied, and retrying would apply it again — so the only retry here is the 401 refresh, which
 * is the one case where the request provably did *not* reach the handler.
 *
 * A 429 or 5xx is surfaced to the caller rather than backed off, because the caller is the only
 * layer that knows whether re-attempting is safe. For layout saves it is — an overwrite is
 * idempotent — but that is `src/core/layoutwrite.ts`'s judgement to make with a snapshot in hand,
 * not this module's to make blindly.
 */
export async function postJson<T = unknown>(
  route: RouteName,
  opts: GetOptions & { body?: unknown } = {},
): Promise<T> {
  await acquire();
  try {
    let refreshedOn401 = false;
    for (;;) {
      const token = await ensureFresh();
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

      if (res.status === 401 && !refreshedOn401) {
        // The token was rejected, so the handler never ran. Safe to present a fresh one.
        refreshedOn401 = true;
        await forceRefresh();
        continue;
      }

      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (!res.ok) throw mapHttpError(res.status, body);
      return body as T;
    }
  } finally {
    release();
  }
}
