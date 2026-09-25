/**
 * Routes on `carina.stockbit.com` — Stockbit Sekuritas: the trading account itself.
 *
 * ## The credential is not the market-data one
 *
 * Every row here carries the SECURITIES token, obtained by exchanging an exodus grant plus the
 * user's six-digit PIN. Presented as a plain `Authorization: Bearer` — **not** the
 * `Authorization-Carina` header this project's own docs/stockbit-api.md claimed until it was checked
 * against the bundle.
 *
 * Only account reads and session authentication are allowed. No real-money order routes exist.
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
   * `auth: "refreshSecurities"` sends the refresh token in BOTH the `refresh_token` JSON body
   * and Authorization bearer. Public frontend modules88216/94615 confirm both placements.
   */
  carinaAuthRefresh: { host: "carina", method: "POST", template: "/auth/refresh", auth: "refreshSecurities" },
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
  /** Current frontend's separate personal-account reader (public module 56, 2026-09-24). */
  accountPersonal: { host: "carina", method: "GET", template: "/account/personal", auth: "securities" },
  subAccountList: { host: "carina", method: "GET", template: "/v2/sub-account/list", auth: "securities" },

  // Real-money order routes are intentionally absent. See ADR-0012.
} as const satisfies Record<string, RouteSpec>;
