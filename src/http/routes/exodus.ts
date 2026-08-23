/**
 * Routes on `exodus.stockbit.com` — market data, stream, Chartbit, screener, watchlist.
 *
 * Every row carries the MAIN session token (`auth: "main"`), except the two that mint credentials
 * for the other two hosts. Adding a row is a deliberate act visible in a diff and in
 * `test/transport.test.ts`'s per-host snapshot; anything absent is rejected by the transport rather
 * than by convention.
 */
import type { RouteSpec } from "./_spec.js";

export const EXODUS_ROUTES = {
  /* ------------------------------- session ------------------------------- */

  /**
   * Renew the main session bearer. The refresh token goes in the Authorization header, not a body.
   *
   * It lives in this table as an ordinary declared route rather than as the special case
   * `src/auth/session.ts` used to make of it with a direct `fetch`.
   */
  loginRefresh: { host: "exodus", method: "POST", template: "/login/refresh", auth: "refreshMain" },

  /**
   * The first hop of the trading unlock: a short-lived grant the securities host exchanges — with
   * the user's PIN — for a Stockbit Sekuritas session.
   *
   * A GET that returns a credential, which is unusual enough to say out loud. It is authorised by
   * the main session, so possessing it does not by itself unlock trading; the PIN is the second
   * factor and never leaves the CLI's stack frame (ADR-0004).
   */
  sekuritasAuthToken: { host: "exodus", method: "GET", template: "/sekuritas/auth/token", auth: "main" },

  /** The same shape for e-IPO: a webview link whose token the partner host exchanges. */
  eipoWebviewLink: { host: "exodus", method: "GET", template: "/auth/eipo/webview/link", auth: "main" },

  /* -------------------- quote, trending, sectors, movers -------------------- */
  emittenInfo: { host: "exodus", method: "GET", template: "/emitten/:symbol/info", auth: "main" },
  emittenTrending: { host: "exodus", method: "GET", template: "/emitten/trending", auth: "main" },
  emittenSectors: { host: "exodus", method: "GET", template: "/emitten/sectors", auth: "main" },
  emittenHotlist: { host: "exodus", method: "GET", template: "/emitten/hotlist/:moverType", auth: "main" },

  /* ------------------------------ price feed ------------------------------ */
  pricesClose: { host: "exodus", method: "GET", template: "/company-price-feed/prices/close", auth: "main" },
  /**
   * Daily OHLCV, 12 rows per page, ignoring every widening parameter — so a long series costs many
   * upstream calls. `src/core/bars.ts` bounds the walk, and `charts`/`chartsDaily` below are the
   * cheaper path when they answer.
   */
  historicalSummary: {
    host: "exodus",
    method: "GET",
    template: "/company-price-feed/historical/summary/:symbol",
    auth: "main",
  },
  pricePerformance: {
    host: "exodus",
    method: "GET",
    template: "/company-price-feed/price-performance/:symbol",
    auth: "main",
  },
  orderbook: {
    host: "exodus",
    method: "GET",
    template: "/company-price-feed/v2/orderbook/companies/:symbol",
    auth: "main",
  },

  /* ---------------------------- broker summary ---------------------------- */
  marketDetectors: { host: "exodus", method: "GET", template: "/marketdetectors/:symbol", auth: "main" },
  /**
   * Broker-to-broker flow matrix. Served by the order-trade service rather than marketdetectors,
   * and it takes the symbol as a QUERY parameter, not a path segment — hence no `:symbol` here.
   */
  brokerDistribution: { host: "exodus", method: "GET", template: "/order-trade/broker/distribution", auth: "main" },

  /* ----------------------------- fundamentals ----------------------------- */
  keystats: { host: "exodus", method: "GET", template: "/keystats/:symbol", auth: "main" },
  keystatsRatio: { host: "exodus", method: "GET", template: "/keystats/ratio/v1/:symbol", auth: "main" },
  financial: { host: "exodus", method: "GET", template: "/findata-view/company/financial", auth: "main" },

  /* --------------------------------- social --------------------------------- */
  streamSymbol: { host: "exodus", method: "GET", template: "/stream/v3/symbol/:symbol", auth: "main" },

  /* ------------------------------- watchlist ------------------------------- */
  /**
   * The user's own watchlists, and their contents. READS.
   *
   * Traps worth knowing before touching the accessor — `limit` is required and capped at 500, and
   * `total_items` in the index reports **0** for every list regardless of how many symbols it
   * actually contains, so it must never be used as a count.
   */
  watchlists: { host: "exodus", method: "GET", template: "/watchlist", auth: "main" },
  watchlistDetail: { host: "exodus", method: "GET", template: "/watchlist/:watchlistId", auth: "main" },

  /* -------------------------------- screener -------------------------------- */
  /**
   * All READS. `templates` lists the user's own saved screens and `templates/:templateId` RUNS one,
   * returning matched companies with their metric values: a plain GET, no POST and no ADR required.
   */
  screenerTemplates: { host: "exodus", method: "GET", template: "/screener/templates", auth: "main" },
  screenerRunTemplate: { host: "exodus", method: "GET", template: "/screener/templates/:templateId", auth: "main" },
  screenerMetrics: { host: "exodus", method: "GET", template: "/screener/metric", auth: "main" },
  screenerPresets: { host: "exodus", method: "GET", template: "/screener/preset", auth: "main" },
  screenerUniverse: { host: "exodus", method: "GET", template: "/screener/universe", auth: "main" },

  /* -------------------------------- chartbit -------------------------------- */
  /**
   * The RETIRED per-symbol pair, still declared because `src/core/layout.ts` and
   * `src/core/layoutwrite.ts` still call them and Phase 3 replaces both together.
   *
   * They are a server-side stub: GET answers 200-with-empty for any key, POST answers 200 for any
   * accepted body and stores nothing. Real persistence lives on `/chartbit/charts` and
   * `/chartbit/chart-drawings`, which the Chartbit increment adds.
   */
  chartbitLayout: { host: "exodus", method: "GET", template: "/chartbit/:symbol/layout", auth: "main" },
  chartbitSaveLayout: { host: "exodus", method: "POST", template: "/chartbit/:symbol/layout", auth: "main" },
  chartbitTemplates: { host: "exodus", method: "GET", template: "/chartbit/template", auth: "main" },
  chartbitSaveTemplate: { host: "exodus", method: "POST", template: "/chartbit/template", auth: "main" },

  chartbitInitial: { host: "exodus", method: "GET", template: "/chartbit/initial/:symbol", auth: "main" },
  chartbitVersion: { host: "exodus", method: "GET", template: "/chartbit/version", auth: "main" },
  userSettings: { host: "exodus", method: "GET", template: "/user-setting/configurations", auth: "main" },

  /**
   * What the account is entitled to, per feature. A READ.
   *
   * This is the authority on whether a paywall is the reason something does not work. The project
   * has already made the mistake of *inferring* a gate once — every 403 blamed on the Rp 10,000,000
   * broker-distribution balance requirement — so when Stockbit will simply answer the question, ask
   * it instead of guessing.
   */
  paywallEligibility: { host: "exodus", method: "GET", template: "/paywall/eligibility/check", auth: "main" },
} as const satisfies Record<string, RouteSpec>;
