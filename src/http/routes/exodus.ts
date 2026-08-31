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


  /* --------------------- stream, news, research (Phase 2) --------------------- */
  /** Market-wide stream. `category` picks news / ideas / reports / insider / …, `keyword` searches. */
  streamAll: { host: "exodus", method: "GET", template: "/stream/v3", auth: "main" },
  streamSymbolPinned: { host: "exodus", method: "GET", template: "/stream/v3/symbol/:symbol/pinned", auth: "main" },
  streamPost: { host: "exodus", method: "GET", template: "/stream/v3/post/:postId", auth: "main" },
  streamUser: { host: "exodus", method: "GET", template: "/stream/non-login/user/:username", auth: "main" },
  /**
   * Trending posts. A POST that READS — the date/cursor triple does not fit a URL, so Stockbit's own
   * client posts it. Filed as a read-shaped POST in `test/transport.test.ts` so that "this is a
   * POST" never has to mean "this mutates".
   */
  streamTrending: { host: "exodus", method: "POST", template: "/stream/v3/trending", auth: "main" },
  researchCategories: { host: "exodus", method: "GET", template: "/research/categories", auth: "main" },
  researchIndicator: { host: "exodus", method: "GET", template: "/research/indicator/new", auth: "main" },

  /* ------------------------------- company -------------------------------- */
  emittenProfile: { host: "exodus", method: "GET", template: "/emitten/:symbol/profile", auth: "main" },
  emittenContact: { host: "exodus", method: "GET", template: "/emitten/:symbol/contact", auth: "main" },
  /** `:emittenType` selects the statement vocabulary — a bank's fin-items are not a manufacturer's. */
  emittenTypedInfo: { host: "exodus", method: "GET", template: "/emitten/v2/:emittenType/:symbol/info", auth: "main" },
  emittenFinItems: {
    host: "exodus",
    method: "GET",
    template: "/emitten/v2/:emittenType/:symbol/fin-items",
    auth: "main",
  },
  emittenSubsidiary: { host: "exodus", method: "GET", template: "/emitten-metadata/subsidiary/:symbol", auth: "main" },
  /**
   * The shareholder chart is gated behind a one-shot token that its own endpoint mints. A POST that
   * READS: it creates nothing and returns a value used immediately by the GET below.
   */
  shareholdersToken: { host: "exodus", method: "POST", template: "/emitten-metadata/shareholders/token", auth: "main" },
  shareholdersChart: {
    host: "exodus",
    method: "GET",
    template: "/emitten-metadata/shareholders/:symbol/chart",
    auth: "main",
  },
  emittenClassification: { host: "exodus", method: "GET", template: "/emitten/classification", auth: "main" },
  emittenClassificationCompany: {
    host: "exodus",
    method: "GET",
    template: "/emitten/classification/company",
    auth: "main",
  },
  /** Members of an index (IDX30, LQ45, …). `limit` is required and 500 is the documented ceiling. */
  indexMembers: { host: "exodus", method: "GET", template: "/emitten/indexes/:indexCode", auth: "main" },
  sectorCompanies: { host: "exodus", method: "GET", template: "/emitten/v3/sector/:sectorId/company", auth: "main" },
  searchV2: { host: "exodus", method: "GET", template: "/search/v2", auth: "main" },
  search: { host: "exodus", method: "GET", template: "/search", auth: "main" },
  watchlistSearchCompany: { host: "exodus", method: "GET", template: "/watchlist/search/company", auth: "main" },

  /* --------------------- fundamentals, valuation, ratings --------------------- */
  seasonality: { host: "exodus", method: "GET", template: "/company-price-feed/seasonality/:symbol", auth: "main" },
  earnings: { host: "exodus", method: "GET", template: "/earnings", auth: "main" },
  analystRatings: { host: "exodus", method: "GET", template: "/analyst-ratings/:symbol", auth: "main" },
  analystConsensus: { host: "exodus", method: "GET", template: "/analyst-ratings/:symbol/consensus", auth: "main" },
  /**
   * Peer comparison. This is what makes a valuation reading relative rather than absolute — the
   * `analyze` tool could previously only compare a PE against a fixed band, which says nothing about
   * whether the whole sector re-rated.
   */
  comparisonRatios: { host: "exodus", method: "GET", template: "/comparison/:symbol/ratios", auth: "main" },
  comparisonIndustries: { host: "exodus", method: "GET", template: "/comparison/:symbol/industries", auth: "main" },
  comparisonSymbolTemplates: { host: "exodus", method: "GET", template: "/comparison/:symbol/templates", auth: "main" },
  comparisonMetrics: { host: "exodus", method: "GET", template: "/comparison/metrics", auth: "main" },
  comparisonTemplates: { host: "exodus", method: "GET", template: "/comparison/templates", auth: "main" },
  fundachartMetrics: { host: "exodus", method: "GET", template: "/fundachart/metrics", auth: "main" },
  fundachartTemplates: { host: "exodus", method: "GET", template: "/fundachart/templates", auth: "main" },

  /* --------------------------- insider & ownership --------------------------- */
  insiderTransactions: { host: "exodus", method: "GET", template: "/insider/company/majorholder", auth: "main" },
  insiderOwnership: { host: "exodus", method: "GET", template: "/insider/majorholder/ownership", auth: "main" },
  /**
   * The segment is a NUMERIC company id, not a ticker.
   *
   * Sending the ticker — which this route did until the segment was renamed — answers
   * `400 {"error":"Invalid company id"}`. `normalizeSymbol` would have accepted `"134"` quite
   * happily (`^[A-Z0-9]{1,12}$` matches digits), so naming the segment `symbol` was not a harmless
   * label: it was a validator that agreed with the wrong value. `companyId` refuses a ticker here
   * instead, and `getShareholdingCompanies` resolves the ticker before it gets this far.
   */
  shareholdingCompanies: {
    host: "exodus",
    method: "GET",
    template: "/insider/shareholding/companies/:companyId",
    auth: "main",
  },
  shareholdingInvestors: {
    host: "exodus",
    method: "GET",
    template: "/insider/shareholding/investors/:insiderId",
    auth: "main",
  },
  shareholdingNetwork: { host: "exodus", method: "GET", template: "/insider/shareholding/network", auth: "main" },
  shareholdingComposition: {
    host: "exodus",
    method: "GET",
    template: "/insider/shareholding/composition/companies/:symbol",
    auth: "main",
  },

  /* -------------------------------- market -------------------------------- */
  /**
   * A whole price series in ONE request, in the timeframes Stockbit's own chart uses.
   *
   * `docs/PENDING-VERIFICATION.md` recorded `/charts` as real-but-unusable, because earlier probes
   * sent `1D`, `daily` and `DAILY`. The values are lowercase (`1w`, `1m`, `3m`, `ytd`, `1y`, `3y`,
   * `5y`), and with the right spelling this replaces roughly forty `historicalSummary` pages with
   * one request — which changes the cost of every scan, backtest and alignment.
   */
  charts: { host: "exodus", method: "GET", template: "/charts/:symbol", auth: "main" },
  chartsDaily: { host: "exodus", method: "GET", template: "/charts/:symbol/daily", auth: "main" },
  runningTrade: { host: "exodus", method: "GET", template: "/order-trade/running-trade", auth: "main" },
  runningTradeGroup: { host: "exodus", method: "GET", template: "/order-trade/running-trade/group", auth: "main" },
  runningTradeChart: {
    host: "exodus",
    method: "GET",
    template: "/order-trade/running-trade/chart/:symbol",
    auth: "main",
  },
  tradeBook: { host: "exodus", method: "GET", template: "/order-trade/trade-book", auth: "main" },
  tradeBookChart: { host: "exodus", method: "GET", template: "/order-trade/trade-book/chart", auth: "main" },
  marketMover: { host: "exodus", method: "GET", template: "/order-trade/market-mover", auth: "main" },
  topStock: { host: "exodus", method: "GET", template: "/order-trade/top-stock", auth: "main" },
  orderQueue: { host: "exodus", method: "GET", template: "/order-trade/order-queue", auth: "main" },
  marketSession: { host: "exodus", method: "GET", template: "/company-price-feed/market-time/session", auth: "main" },
  pricesBatch: { host: "exodus", method: "GET", template: "/company-price-feed/prices", auth: "main" },
  pricesMarket: { host: "exodus", method: "GET", template: "/company-price-feed/prices/:symbol/market", auth: "main" },

  /* ------------------------------- brokers -------------------------------- */
  /** The broker directory: what every two-letter code actually stands for. */
  brokerDirectory: { host: "exodus", method: "GET", template: "/findata-view/marketdetectors/brokers", auth: "main" },
  /**
   * Which stocks one broker traded. Takes REPEATED `market_type` and `investor_type` parameters —
   * comma-joining them returns a confident, narrower answer rather than an error, which is why
   * `QueryParams` grew array support before this route existed.
   */
  brokerActivity: { host: "exodus", method: "GET", template: "/order-trade/broker/activity", auth: "main" },
  brokerTop: { host: "exodus", method: "GET", template: "/order-trade/broker/top", auth: "main" },

  /* ------------------- corporate actions & the IPO pipeline ------------------- */
  /** One action kind at a time. `:actionType` is a closed list — an unknown one returns an empty page. */
  corpaction: { host: "exodus", method: "GET", template: "/corpaction/:actionType", auth: "main" },
  /** Everything happening on ONE date, market-wide. `from`/`to` are silently ignored here. */
  corpactionToday: { host: "exodus", method: "GET", template: "/corpaction", auth: "main" },
  corpactionStatus: { host: "exodus", method: "GET", template: "/corpaction/status", auth: "main" },
  stockConversion: { host: "exodus", method: "GET", template: "/corpaction/:symbol/stock_conversion", auth: "main" },
  underwriters: { host: "exodus", method: "GET", template: "/order-trade/underwriters", auth: "main" },
  underwriterPerformance: {
    host: "exodus",
    method: "GET",
    template: "/order-trade/underwriters/:underwriterCode/ipo-performance",
    auth: "main",
  },

  /* ------------------------------- screener -------------------------------- */
  /**
   * Run an ad-hoc screen. A POST that READS: the body carries `save: "0"`, which is Stockbit's own
   * "evaluate but do not persist" flag, so nothing is created. `src/core/screener.ts` hard-codes
   * that value and a unit test asserts it — the saving variant is a separate, confirm-gated tool.
   */
  screenerRun: { host: "exodus", method: "POST", template: "/screener/templates", auth: "main" },
  screenerFavorites: { host: "exodus", method: "GET", template: "/screener/favorites", auth: "main" },

  /**
   * The screener WRITES. ADR-0006.
   *
   * `screenerSave` is the same method and path as `screenerRun` and is a SEPARATE row on purpose.
   * The only difference on the wire is one body field — `save: "1"` instead of `"0"` — and a route
   * table that could not tell them apart would file a write under the read-shaped POST that runs an
   * ad-hoc screen. Two keys means the write class in `test/transport.test.ts` names it as a
   * mutation, which is the whole point of that list.
   */
  screenerSave: { host: "exodus", method: "POST", template: "/screener/templates", auth: "main" },
  screenerTemplateDelete: {
    host: "exodus",
    method: "DELETE",
    template: "/screener/templates/:templateId",
    auth: "main",
  },
  screenerFavoriteAdd: { host: "exodus", method: "POST", template: "/screener/favorites", auth: "main" },
  screenerFavoriteRemove: { host: "exodus", method: "DELETE", template: "/screener/favorites", auth: "main" },
  screenerFinItems: { host: "exodus", method: "GET", template: "/screener/finitem-watchlist", auth: "main" },

  /* ------------------------------- watchlist ------------------------------- */
  watchlistSymbols: { host: "exodus", method: "GET", template: "/watchlist/:watchlistId/symbols", auth: "main" },

  /**
   * The watchlist WRITES. ADR-0006.
   *
   * The mildest mutations in this project, and still gated. A watchlist is a statement of what the
   * user is paying attention to — several tools read it as the universe to scan — so an entry
   * silently added or a list silently deleted changes what every later answer is about. None of
   * them touches money, which is why they are reversible by hand and why `watchlist_delete` is the
   * only one that asks twice.
   */
  watchlistCreate: { host: "exodus", method: "POST", template: "/watchlist", auth: "main" },
  watchlistRename: { host: "exodus", method: "PUT", template: "/watchlist/:watchlistId", auth: "main" },
  watchlistDelete: { host: "exodus", method: "DELETE", template: "/watchlist/:watchlistId", auth: "main" },
  watchlistAddItem: {
    host: "exodus",
    method: "POST",
    template: "/watchlist/:watchlistId/company/item",
    auth: "main",
  },
  watchlistRemoveItem: {
    host: "exodus",
    method: "DELETE",
    template: "/watchlist/:watchlistId/company/:companyId/item",
    auth: "main",
  },
  watchlistFavorite: { host: "exodus", method: "PUT", template: "/watchlist/favorite/:watchlistId", auth: "main" },

  /* -------------------------------- chartbit -------------------------------- */
  /**
   * Where a Chartbit chart is ACTUALLY persisted.
   *
   * The chart page lazily loads a wrapper that configures the TradingView Charting Library with a
   * `save_load_adapter`, an `auto_save_delay`, the `saveload_separate_drawings_storage` feature and
   * `onAutoSaveNeeded -> widget.saveChartToServer()`. Those adapter methods point here, not at the
   * per-symbol pair above — which is why this project concluded for months that Chartbit saving was
   * retired on both sides. It was looking at the retired half.
   *
   * A layout and its DRAWINGS are stored separately, which is what that feature flag means: the
   * layout is the chart container (panes, studies, properties) and the drawings are the line tools
   * on it. Reading only the layout and reporting "you have drawn nothing" would be wrong in a way
   * the user could check at a glance.
   *
   * ADR-0003 as amended: the writes here carry the same apparatus the layout write did —
   * confirmation, snapshot, read-back verification, rollback, mutation log.
   */
  chartbitCharts: { host: "exodus", method: "GET", template: "/chartbit/charts", auth: "main" },
  chartbitChart: { host: "exodus", method: "GET", template: "/chartbit/charts/:layoutId", auth: "main" },
  chartbitChartCreate: { host: "exodus", method: "POST", template: "/chartbit/charts", auth: "main" },
  chartbitChartUpdate: { host: "exodus", method: "PUT", template: "/chartbit/charts/:layoutId", auth: "main" },
  /**
   * Deleting a layout destroys it, and Stockbit offers no undo. Declared because a user who asks to
   * remove a chart they made should not be told the server cannot; gated behind the same
   * confirmation and snapshot as every other destructive write.
   */
  chartbitChartDelete: { host: "exodus", method: "DELETE", template: "/chartbit/charts/:layoutId", auth: "main" },
  chartbitDrawings: { host: "exodus", method: "GET", template: "/chartbit/chart-drawings", auth: "main" },
  chartbitDrawingsSave: { host: "exodus", method: "POST", template: "/chartbit/chart-drawings", auth: "main" },
  /** Named chart templates (colours, studies, properties). Names must match ^[a-zA-Z0-9 ]*$. */
  chartbitSettings: { host: "exodus", method: "GET", template: "/chartbit/settings", auth: "main" },
  chartbitSettingsCreate: { host: "exodus", method: "POST", template: "/chartbit/settings", auth: "main" },
  chartbitSetting: { host: "exodus", method: "GET", template: "/chartbit/settings/:templateName", auth: "main" },
  chartbitSettingUpdate: { host: "exodus", method: "PUT", template: "/chartbit/settings/:templateName", auth: "main" },
  chartbitSettingDelete: {
    host: "exodus",
    method: "DELETE",
    template: "/chartbit/settings/:templateName",
    auth: "main",
  },
  /** Saved study and drawing templates. Reads only — creating one has no caller. */
  chartbitStudies: { host: "exodus", method: "GET", template: "/chartbit/studies", auth: "main" },
  chartbitDrawingTemplates: { host: "exodus", method: "GET", template: "/chartbit/drawings", auth: "main" },

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
