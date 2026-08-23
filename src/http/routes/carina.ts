/**
 * Routes on `carina.stockbit.com` — Stockbit Sekuritas: the trading account itself.
 *
 * ## The credential is not the market-data one
 *
 * Every row here carries the SECURITIES token, obtained by exchanging an exodus grant plus the
 * user's six-digit PIN. Presented as a plain `Authorization: Bearer` — **not** the
 * `Authorization-Carina` header this project's own STOCKBIT-API.md claimed until it was checked
 * against the bundle.
 *
 * ## Why the write rows are separate from the read rows in review, if not in the file
 *
 * The reads describe the account. The writes move money. `test/transport.test.ts` names them as
 * distinct classes and cites the ADR each belongs to, so a new one cannot arrive as an ordinary
 * row: `ORDER_WRITES` is ADR-0004 and required an argument, not an edit.
 */
import type { RouteSpec } from "./_spec.js";

export const CARINA_ROUTES = {
  /* ------------------------------ the unlock ------------------------------ */

  /**
   * Exchange the exodus grant + the user's PIN for a securities session.
   *
   * The PIN reaches this body from a hidden terminal prompt and from nowhere else. No MCP tool
   * accepts one, nothing persists one, and `src/redact.ts` drops the field from every log line —
   * see ADR-0004.
   */
  carinaAuthLogin: { host: "carina", method: "POST", template: "/auth/v2/login", auth: "none" },
  /**
   * Renew the securities session.
   *
   * `auth: "refreshSecurities"` puts the refresh token in the BODY as `refresh_token` and sends no
   * Authorization header — that is what Stockbit's own client does here, and it is the one thing
   * about this chain that differs from the main session's refresh. Whether carina would also accept
   * a bearer is unknown and deliberately untested from code: the documented form works.
   */
  carinaAuthRefresh: { host: "carina", method: "POST", template: "/auth/refresh", auth: "refreshSecurities" },
  /** Re-validate the PIN for an action that demands it again. Same PIN policy as the login. */
  carinaAuthPinValidate: { host: "carina", method: "POST", template: "/auth/pin/validate", auth: "securities" },
  /** End the securities session server-side, so `trading-logout` is more than a local delete. */
  carinaAuthLogout: { host: "carina", method: "POST", template: "/auth/logout", auth: "securities" },
} as const satisfies Record<string, RouteSpec>;
