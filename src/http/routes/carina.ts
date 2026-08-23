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

  /* ------------------------------ account reads ------------------------------ */

  /**
   * The portfolio, its summary, and one position.
   *
   * Every one of these carries PII and money. `src/trading/account.ts` PROJECTS them into named
   * fields rather than passing the row through, which is the opposite of the rule the market-data
   * modules follow — there, naming the survivors turns "we have not looked at this field" into
   * "this field does not exist". Here the trade runs the other way: an unmapped field on a
   * brokerage response is as likely to be an account number as a metric, and a tool result is text
   * a model relays.
   */
  portfolioList: { host: "carina", method: "GET", template: "/portfolio/v2/list", auth: "securities" },
  portfolioSummary: { host: "carina", method: "GET", template: "/portfolio/v2/summary", auth: "securities" },
  portfolioDetail: { host: "carina", method: "GET", template: "/portfolio/v2/detail", auth: "securities" },

  /** Cash. `info` carries the settlement breakdown (T+0/T+1/T+2) that `cash` alone does not. */
  balanceCash: { host: "carina", method: "GET", template: "/balance/cash", auth: "securities" },
  balanceCashInfo: { host: "carina", method: "GET", template: "/balance/cash/info", auth: "securities" },

  /**
   * Open orders, and one order's detail.
   *
   * `src/trading/account.ts` exposes these twice: a cached, display-shaped read for a caller asking
   * "what is open", and an UNCACHED raw read for the order write path. That is the ADR-0003 lesson
   * restated — a truncating, cached accessor and a byte-exact operation must not share an entry
   * point, because reading the write path through the display accessor is what made every real
   * chart look empty.
   */
  orderList: { host: "carina", method: "GET", template: "/order/v2/list", auth: "securities" },
  orderDetail: { host: "carina", method: "GET", template: "/order/v2/detail", auth: "securities" },

  /** Trade history and realised P/L. */
  historyList: { host: "carina", method: "GET", template: "/history/v3", auth: "securities" },
  historyDetail: { host: "carina", method: "GET", template: "/history/detail", auth: "securities" },
  historyRealized: { host: "carina", method: "GET", template: "/history/realized", auth: "securities" },
  historyRealizedDetail: { host: "carina", method: "GET", template: "/history/realized/detail", auth: "securities" },
  historyTradePerformance: {
    host: "carina",
    method: "GET",
    template: "/history/performance/trade",
    auth: "securities",
  },
  historyPortfolioPerformance: {
    host: "carina",
    method: "GET",
    template: "/history/performance/portfolio/:performanceKind",
    auth: "securities",
  },

  /**
   * Fees and tradability.
   *
   * `formula/v2` is the authority on this account's actual commission. The project has been
   * carrying 0.15%/0.25% as a default, which is the common Indonesian retail rate and is not
   * necessarily THIS account's — and a preview that reports a net proceed using the wrong rate is
   * wrong in the one number the user checks.
   */
  tradingInfo: { host: "carina", method: "GET", template: "/trading/info", auth: "securities" },
  tradingFormula: { host: "carina", method: "GET", template: "/formula/v2", auth: "securities" },
  stockTradable: { host: "carina", method: "GET", template: "/stock/tradable", auth: "securities" },

  /** Who the account is. Masked before it leaves `src/trading/account.ts`. */
  account: { host: "carina", method: "GET", template: "/account", auth: "securities" },
  subAccountList: { host: "carina", method: "GET", template: "/v2/sub-account/list", auth: "securities" },
} as const satisfies Record<string, RouteSpec>;
