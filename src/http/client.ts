/**
 * HTTP client for the Stockbit exodus API. Responsibilities:
 *   - inject a fresh Bearer token (auth/session)
 *   - browser-shaped default headers
 *   - concurrency cap + min-spacing + exponential backoff on 429/5xx
 *   - on 401: refresh once and retry the request a single time
 *   - normalize errors via the grpc-gateway envelope mapper
 *   - never leak secrets (redaction is applied to all thrown errors)
 */
import { HOSTS, RATE, defaultHeaders } from "../config.js";
import { ensureFresh, forceRefresh } from "../auth/session.js";
import { mapHttpError, StockbitError } from "./errors.js";

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
  /** Query params; undefined/null values are dropped. */
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Base host, defaults to exodus. */
  base?: string;
}

function buildUrl(path: string, base: string, params?: GetOptions["params"]): string {
  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : base + "/");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function rawFetch(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE.requestTimeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { ...defaultHeaders(), authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET a JSON resource. Returns parsed body on 2xx; throws StockbitError otherwise.
 * Handles 401 (refresh+retry once) and 429/5xx (backoff up to RATE.maxRetries).
 */
export async function getJson<T = unknown>(path: string, opts: GetOptions = {}): Promise<T> {
  const base = opts.base ?? HOSTS.exodus;
  const url = buildUrl(path, base, opts.params);

  await acquire();
  try {
    let refreshedOn401 = false;
    for (let attempt = 0; attempt <= RATE.maxRetries; attempt++) {
      let token = await ensureFresh();
      let res: Response;
      try {
        res = await rawFetch(url, token);
      } catch (err) {
        // Network/abort — treat as upstream and back off.
        if (attempt < RATE.maxRetries) {
          await sleep(RATE.backoffBaseMs * 2 ** attempt);
          continue;
        }
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
