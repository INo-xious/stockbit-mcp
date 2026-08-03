/**
 * Central config. Hosts and defaults are derived from the reverse-engineered Stockbit
 * frontend (see STOCKBIT-API.md). Nothing here is secret.
 */

/** Backend hosts (from the web bundle's host-constant module). */
export const HOSTS = {
  /** Market data — everything this MCP reads lives here. Const `g`/`q7` in the bundle. */
  exodus: "https://exodus.stockbit.com",
  /** Web origin, used for Origin/Referer headers the API expects. */
  web: "https://stockbit.com",
} as const;

/**
 * Main-session token refresh. CONFIRMED contract (frontend source + live endpoint probe):
 *   POST {exodus}/login/refresh
 *   Header: Authorization: Bearer <refresh_token>   (the refresh token, NOT the access token)
 *   Body:   empty
 *   Response: nested { data: { data: {...} } }
 *
 * This renews the MAIN session bearer used on exodus market-data calls. It is distinct from the
 * *securities* token refresh (`POST {carina|trading}/auth/refresh` with a `{refresh_token}` body),
 * which this read-only MCP does not use.
 *
 * The URL itself is not declared here: `loginRefresh` in `src/http/transport.ts` is the authority on
 * every authenticated host/method/path, and a second copy of the path would be a second thing to
 * keep in sync with the policy (ADR-0002).
 *
 * Still unverified until a real refresh with a valid token is observed: the exact success-response
 * field names (where the new access token lives) and whether the refresh token rotates.
 * parseRefresh() handles those defensively.
 */
export const AUTH = {
  /** Refresh the access token when it has this many seconds (or fewer) left. */
  expirySkewSeconds: 60,
} as const;

/**
 * Default request headers. The API 400s/403s some routes without browser-shaped
 * Origin/Referer, so we always send them. The Authorization header is injected per-request
 * by the HTTP client and is never set here.
 */
export function defaultHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: HOSTS.web,
    referer: `${HOSTS.web}/`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  };
}

/** Rate limiting / retry — behave like a human; protect the account behind Cloudflare. */
export const RATE = {
  maxConcurrent: 3,
  minSpacingMs: 150,
  maxRetries: 3,
  backoffBaseMs: 500,
  requestTimeoutMs: 20_000,
} as const;

/** Per-symbol response cache TTL (ms). Must be shorter than the data's own staleness. */
export const CACHE = {
  quoteTtlMs: 3_000,
  brokerSummaryTtlMs: 60_000,
  /**
   * Broker summary for a date range that ended before today. Those sessions are closed and their
   * numbers can no longer change, so the only reason to re-fetch is process restart.
   */
  brokerSummarySettledTtlMs: 6 * 60 * 60_000,
  keystatsTtlMs: 300_000,
  defaultTtlMs: 5_000,
} as const;

/** Keychain identifiers for the token store. */
export const KEYCHAIN = {
  service: "stockbit-mcp",
  account: "refresh-token",
} as const;
