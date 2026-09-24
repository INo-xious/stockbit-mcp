/** Read-only securities account tools and explicitly named local paper-simulation tools. */
import { z } from "zod";
import * as account from "../trading/account.js";
import { PERFORMANCE_KINDS } from "../trading/account.js";
import { previewOrder, type OrderTicket, type PreviewAccountReads } from "../trading/preview.js";
import {
  amendOrder,
  cancelOrder,
  orderLogPath,
  placeBuy,
  placeSell,
  type OrderResult,
} from "../trading/orders.js";
import { TICKET_TTL_MS } from "../trading/tickets.js";
import { hasStoredSession } from "../auth/session.js";
import { tradingPolicy } from "../settings.js";
import { COMMITMENT_CONFIRM, runTool } from "./_format.js";
import type { Definer, ElicitDecision } from "./_define.js";
import { elicitationNote } from "../trading/confirmation.js";
import { describeRemember, forgetRemember, REMEMBER_TTL_MS } from "../trading/remember.js";
import {
  loadLedger,
  paperLedgerPath,
  saveLedger,
  settlePaper,
  snapshot,
  PAPER_BANNER,
  PAPER_FEES,
  type PaperLedger,
} from "../trading/paper.js";
import { getQuote } from "../core/emitten.js";
import { getIntradayPrices } from "../core/pricefeed.js";

/** The family remains projected because nonempty account rows have not been checked live. */
const PROJECTION_NOTE =
  "Field mapping is partly verified: nested portfolio totals, empty positions, cash, fees, masked " +
  "identity, tradability and trading features were checked read-only on 2026-09-24. Nonempty " +
  "holding, order and history rows remain projected from frontend schemas. `readFrom` names the " +
  "fields actually mapped; missing values are not zero.";

// Names the command deliberately: `test/trading-account.test.ts` asserts every account read says
// how to GET a session, and a tool that only says it needs one leaves the user stuck. The rest of
// what this used to say — the PIN is typed at their terminal, never asked for here — is in the
// server instructions now, once.
const LOGIN_NOTE = "Requires the trading session (`stockbit-auth trading-login`).";

/**
 * For the three reads paper mode CANNOT answer.
 *
 * `account` is the account holder's identity, `trading_info` their commission schedule,
 * `stock_tradable` the exchange's verdict on a symbol today. A ledger has no answer to any of them,
 * and inventing one would be the first lie in a feature whose whole value is that it does not
 * flatter. So they keep needing a real session, in every mode, and say so.
 */
const NO_PAPER_NOTE =
  "THIS ONE IS NOT SERVED FROM THE PAPER LEDGER. It describes the real brokerage relationship — a " +
  "paper account has no identity, no commission schedule of its own and no say in what the exchange " +
  "will accept — so it needs a securities session even when `trading_status` says paper. If there " +
  "is none, say that rather than reporting a paper figure in its place.";

/**
 * Bring the ledger up to date before anything reads it.
 *
 * Lazy settlement: every open order is checked against the session's minutely closes at the moment
 * someone looks, rather than by a background process that has to be kept alive. The cost is that an
 * order's `filledAt` is when it was noticed, not when it printed — stated on the result.
 */
async function currentLedger(): Promise<PaperLedger> {
  const ledger = loadLedger();
  const open = ledger.orders.filter((o) => o.status === "open");
  if (!open.length) return ledger;

  const intradayBySymbol: Record<string, number[]> = {};
  for (const symbol of new Set(open.map((o) => o.symbol))) {
    try {
      const series = await getIntradayPrices(symbol);
      const closes = extractCloses(series);
      if (closes.length) intradayBySymbol[symbol] = closes;
    } catch {
      // No series for this symbol: its orders stay open, which is the conservative reading.
    }
  }

  const settled = settlePaper(ledger, { intradayBySymbol }, new Date());
  if (settled.filled.length) saveLedger(settled.ledger);
  return settled.ledger;
}

/** Minutely closes out of whatever shape the intraday feed returned. */
function extractCloses(payload: unknown): number[] {
  const rows = Array.isArray(payload)
    ? payload
    : ((payload as { data?: unknown })?.data ?? (payload as { prices?: unknown })?.prices);
  if (!Array.isArray(rows)) return [];
  const out: number[] = [];
  for (const row of rows) {
    const value =
      typeof row === "number"
        ? row
        : ((row as Record<string, unknown>)?.close ?? (row as Record<string, unknown>)?.price);
    const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Last traded price per symbol, for marking the paper book. A miss is `null`, never a guess. */
async function marksFor(symbols: string[]): Promise<Record<string, number | null>> {
  const marks: Record<string, number | null> = {};
  for (const symbol of symbols) {
    try {
      const quote = await getQuote(symbol);
      const parsed = Number(String(quote.price).replace(/,/g, ""));
      marks[symbol] = Number.isFinite(parsed) ? parsed : null;
    } catch {
      marks[symbol] = null;
    }
  }
  return marks;
}

/** The whole paper account, settled and marked. */
async function paperSnapshot() {
  const ledger = await currentLedger();
  return snapshot(ledger, await marksFor(Object.keys(ledger.positions)));
}


/**
 * The four account-side reads `paper_order_preview` needs, answered from the ledger.
 *
 * Shaped to match the brokerage readers exactly, so the preview's arithmetic and every check that
 * consumes them is the same code in both modes. Only the account side is substituted: the tick
 * grid, the auto-rejection band, the session and tradability are still read from the real market,
 * because a rehearsal that skipped those would teach nothing about why a real order bounces.
 */
function paperPreviewReads(): Partial<PreviewAccountReads> {
  return {
    async listOrders(options?: { symbol?: string }) {
      const ledger = await currentLedger();
      const symbol = options?.symbol?.toUpperCase();
      const open = ledger.orders.filter((o) => o.status === "open" && (!symbol || o.symbol === symbol));
      return {
        orders: open.map((o) => ({
          orderId: o.id,
          symbol: o.symbol,
          side: o.action,
          sideRaw: o.action,
          price: o.price,
          lots: o.lots,
          shares: o.lots * 100,
          status: o.status,
          statusRaw: o.status,
        })),
        request: { symbol: symbol ?? undefined },
        unmappedKeys: [],
      } as unknown as Awaited<ReturnType<typeof account.listOrders>>;
    },
    async getCashBalance() {
      const snap = await paperSnapshot();
      return {
        cashIdr: snap.cashIdr,
        buyingPowerIdr: snap.cashIdr,
        readFrom: { cashIdr: "paper-ledger", buyingPowerIdr: "paper-ledger" },
        unmappedKeys: [],
      } as unknown as Awaited<ReturnType<typeof account.getCashBalance>>;
    },
    async getPosition(symbol: string) {
      const snap = await paperSnapshot();
      const holding = snap.holdings.find((h) => h.symbol === symbol.toUpperCase());
      return {
        symbol: symbol.toUpperCase(),
        holding: holding
          ? {
              symbol: holding.symbol,
              shares: holding.shares,
              availableShares: holding.shares,
              lots: holding.lots,
              averagePrice: holding.avgPrice,
            }
          : null,
        unmappedKeys: [],
      } as unknown as Awaited<ReturnType<typeof account.getPosition>>;
    },
    async getFees() {
      // `source: "default"` is the truth: a paper account has no schedule of its own to read, and
      // the preview's own warning about defaulted commission is one the user should still see.
      return {
        buyPct: PAPER_FEES.buyPct,
        sellPct: PAPER_FEES.sellPct,
        source: "default",
        note: `${PAPER_BANNER} Commission is the published retail rate; a paper account has none of its own.`,
      } as unknown as Awaited<ReturnType<typeof account.getFees>>;
    },
  };
}

export function registerTradingTools(define: Definer): void {
  define.read(
    "portfolio",
    "The user's ACTUAL stock holdings at Stockbit Sekuritas — what they own right now, at what " +
      "average price, and what it is worth. This is the account, not a watchlist: `watchlist` is a " +
      "list of symbols someone is following, this is money at risk.\n" +
      "Read it before offering any opinion that touches position sizing, concentration or whether " +
      "to add. An opinion about BBRI means something different to someone holding 40% of their " +
      "portfolio in it.\n" +
      "`totals` carries the account-level figures from the summary endpoint. If the summary request " +
      "fails the holdings are still returned and `totalsUnavailable` says why — do not report the " +
      "portfolio as unreadable in that case.\n" +
      "LOTS AND SHARES: 1 lot = 100 shares. Each is reported only when a wire key whose name says " +
      "which one carried it; `derived` lists any that this server computed from the other. A " +
      "derived figure is arithmetic, not a reading.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {},
    async () => runTool(() => account.getPortfolio()),
  );

  define.read(
    "position",
    "ONE symbol's position: how much of it the user holds, at what average price, and what it is " +
      "worth now. Cheaper than `portfolio` when the question is about a single stock.\n" +
      "`holding: null` means the account holds none of this symbol. That is a normal answer and " +
      "the correct one to relay — it is not an error and not a failed lookup.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => account.getPosition(String(a.symbol))),
  );

  define.read(
    "cash_balance",
    "Cash in the trading account, and the buying power that is not the same number.\n" +
      "`cashIdr` is the balance. `buyingPowerIdr` is what an order can actually spend, which on an " +
      "Indonesian retail account is routinely LARGER than the cash balance because of the trading " +
      "limit. Use buying power to judge affordability; quoting cash where buying power was meant " +
      "understates what the user can do, and the reverse overstates it.\n" +
      "`settlement` breaks the balance into T+0/T+1/T+2 buckets when the `balance/cash/info` endpoint " +
      "answered. " +
      "Its absence with `settlementUnavailable` set means that second request failed, not that the " +
      "account has no unsettled cash.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {},
    async () => runTool(() => account.getCashBalance()),
  );

  define.read(
    "orders",
    "Orders currently on the book: what is working, what is partially filled, what was rejected.\n" +
      "Pass `symbol` to filter to one stock. `request` echoes the filter that was actually sent, so " +
      "an empty result can be told apart from a filter that did not apply.\n" +
      "`side` is buy or sell only when the wire said so in a word this server recognises; `sideRaw` " +
      "always carries what it actually said. If `side` is absent, quote `sideRaw` rather than " +
      "guessing the direction of someone's order.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    { symbol: z.string().optional().describe("IDX ticker to filter by, e.g. BBRI. Omit for all open orders.") },
    async (a) => runTool(() => account.listOrders({ symbol: a.symbol ? String(a.symbol) : undefined })),
  );

  define.read(
    "order_detail",
    "One order in full, by its id. Get the id from `orders`.\n" +
      "`order: null` means the id matched nothing — a cancelled order that has aged out, or an id " +
      "from a different account. Say that rather than reporting the order as still open.\n" +
      "PENDING VERIFICATION: the query parameter name (`order_id`) is this server's reading of " +
      "Stockbit's client, not an observed call. A wrong name most likely produces a 400 or the " +
      "whole list; if the order returned does not match the id you asked for, say so.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    { order_id: z.string().describe("The order id, from the `orders` tool") },
    async (a) => runTool(() => account.getOrderDetail(String(a.order_id))),
  );

  define.read(
    "order_history",
    "Trades that actually executed, and closed positions with what they made.\n" +
      "`kind: \"trades\"` (default) lists executions. `kind: \"realized\"` lists " +
      "closed positions and their realised profit and loss — that is the tool for 'how have I " +
      "actually done', because unrealised gains on `portfolio` are a mark, not a result.\n" +
      "`period` is passed through verbatim: the accepted vocabulary is not known, so an " +
      "unrecognised value is the server's to reject rather than this tool's. `request` echoes what " +
      "was sent.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {
      kind: z.enum(["trades", "realized"]).optional().describe("trades (executions) or realized (closed positions). Default trades."),
      symbol: z.string().optional().describe("IDX ticker to filter by"),
      period: z.string().optional().describe("Server-side period token, passed through as sent"),
      page: z.coerce.number().optional().describe("1-based page"),
      limit: z.coerce.number().optional().describe("Rows per page"),
    },
    async (a) => runTool<account.HistoryPage | account.RealizedPage>(() => {
      const opts = { symbol: a.symbol ? String(a.symbol) : undefined, period: a.period ? String(a.period) : undefined,
        page: a.page as number | undefined, limit: a.limit as number | undefined };
      return a.kind === "realized" ? account.getRealizedHistory(opts) : account.getTradeHistory(opts);
    }),
  );

  define.read(
    "trade_performance",
    "How the account itself has performed — the aggregate trading record, or one of four portfolio " +
      "series over time.\n" +
      `\`series\` selects a portfolio curve: ${PERFORMANCE_KINDS.join(", ")}. Omit it for the ` +
      "aggregate trading performance instead.\n" +
      "The points are projected structurally — a label and a value — because a performance series " +
      "carries no identifiers. Where a point's shape was not recognised its keys are named in " +
      "`unmappedKeys` and no number is invented for it.\n" +
      LOGIN_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {
      series: z
        .enum(PERFORMANCE_KINDS)
        .optional()
        .describe("Portfolio series to read. Omit for the aggregate trading performance."),
    },
    async (a) => runTool(() => a.series ? account.getPortfolioPerformance(String(a.series)) : account.getTradePerformance()),
  );

  define.read(
    "trading_info",
    "The account's trading state and, most importantly, ITS OWN commission rates.\n" +
      "`fees.source` says where the rates came from: `formula` or `trading-info` means they were " +
      "read from the account; `default` means they could NOT be read and this server fell back to " +
      "0.15% buy / 0.25% sell, which is the common Indonesian retail rate and may not be this " +
      "account's. When `source` is `default`, say so before quoting any net proceed — the fee is " +
      "the number a user checks.\n" +
      "`fees.raw` carries what the wire actually held, before this server decided whether it was a " +
      "percentage or a fraction.\n" +
      LOGIN_NOTE +
      "\n" +
      NO_PAPER_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {},
    async () => runTool(() => account.getTradingInfo()),
  );

  define.read(
    "stock_tradable",
    "Whether the exchange will accept an order in these symbols right now. Suspensions, " +
      "delistings, and boards that only trade by call auction all show up here.\n" +
      "`tradable: undefined` means the response said nothing about that symbol — it is not the same " +
      "as `false`. Report 'could not confirm' rather than 'you cannot trade this'.\n" +
      "Worth calling before telling a user to buy something: a confident recommendation to buy a " +
      "suspended stock is worse than no recommendation.\n" +
      LOGIN_NOTE +
      "\n" +
      NO_PAPER_NOTE +
      "\n" +
      PROJECTION_NOTE,
    { symbols: z.array(z.string()).describe("IDX tickers, e.g. [\"BBRI\", \"TLKM\"]") },
    async (a) => runTool(() => account.getStockTradable((a.symbols as string[]).map(String))),
  );

  define.read(
    "account",
    "Which brokerage account this session is attached to, and its sub-accounts.\n" +
      "IDENTIFIERS ARE MASKED before they reach you: the holder's name is reduced to initials and " +
      "the account, RDN and SID numbers to their last four characters. This masking is done by this " +
      "server, not by Stockbit — do not report the bullets as what the API returned, and do not ask " +
      "the user to supply the full values to 'verify' anything. They are not needed for any tool " +
      "here. `masking` in the result says the same thing in prose.\n" +
      "Use it to confirm the session is pointed at the account the user means before discussing " +
      "their positions, not as a source of personal details.\n" +
      LOGIN_NOTE +
      "\n" +
      NO_PAPER_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {},
    async () => runTool(() => account.getAccount()),
  );

  define.read(
    "paper_portfolio",
    "LOCAL PAPER SIMULATION: portfolio from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    {},
    async () =>
      runTool(async () => {
        const snap = await paperSnapshot();
        return { ...snap, holdings: snap.holdings, ledger: paperLedgerPath() };
      }),
  );

  define.read(
    "paper_position",
    "LOCAL PAPER SIMULATION: position from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) =>
      runTool(async () => {
        const snap = await paperSnapshot();
        const symbol = String(a.symbol).toUpperCase();
        const holding = snap.holdings.find((h) => h.symbol === symbol) ?? null;
        return {
          mode: "paper" as const,
          symbol,
          holding,
          summary: holding
            ? `${PAPER_BANNER} ${holding.lots} lots of ${symbol} at an average of ${holding.avgPrice.toFixed(2)}.`
            : `${PAPER_BANNER} The paper account holds no ${symbol}.`,
        };
      }),
  );

  define.read(
    "paper_cash_balance",
    "LOCAL PAPER SIMULATION: cash balance from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    {},
    async () =>
      runTool(async () => {
        const snap = await paperSnapshot();
        return {
          mode: "paper" as const,
          cashIdr: snap.cashIdr,
          // In paper there is no trading limit, so buying power IS the cash. Said explicitly,
          // because on a real Indonesian retail account the two differ and that matters.
          buyingPowerIdr: snap.cashIdr,
          startingCashIdr: snap.startingCashIdr,
          realisedIdr: snap.realisedIdr,
          summary:
            `${PAPER_BANNER} Cash ${snap.cashIdr.toFixed(0)} IDR. There is no trading limit on a paper ` +
            "account, so buying power is the cash balance — on a real account it is usually larger.",
        };
      }),
  );

  define.read(
    "paper_orders",
    "LOCAL PAPER SIMULATION: orders from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    { symbol: z.string().optional().describe("IDX ticker to filter by, e.g. BBRI. Omit for all open orders.") },
    async (a) =>
      runTool(async () => {
        const ledger = await currentLedger();
        const symbol = a.symbol ? String(a.symbol).toUpperCase() : undefined;
        const open = ledger.orders.filter((o) => o.status === "open" && (!symbol || o.symbol === symbol));
        return {
          mode: "paper" as const,
          orders: open,
          request: { symbol: symbol ?? null },
          summary:
            `${PAPER_BANNER} ${open.length} open paper order${open.length === 1 ? "" : "s"}` +
            `${symbol ? ` in ${symbol}` : ""}. Open orders are checked against the session's minutely ` +
            "closes each time this is read, so a fill is recorded when it is noticed rather than when it printed.",
        };
      }),
  );

  define.read(
    "paper_order_detail",
    "LOCAL PAPER SIMULATION: order detail from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    { order_id: z.string().describe("The order id, from the `orders` tool") },
    async (a) =>
      runTool(async () => {
        const ledger = await currentLedger();
        const id = String(a.order_id);
        const order = ledger.orders.find((o) => o.id === id || o.uiRef === id) ?? null;
        return {
          mode: "paper" as const,
          order,
          fills: ledger.fills.filter((f) => f.orderId === order?.id),
          summary: order
            ? `${PAPER_BANNER} Paper order ${order.id}: ${order.action} ${order.lots} lots of ` +
              `${order.symbol} at ${order.price}, ${order.status}.`
            : `${PAPER_BANNER} No paper order with id ${JSON.stringify(id)}.`,
        };
      }),
  );

  define.read(
    "paper_order_history",
    "LOCAL PAPER SIMULATION: order history from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    {
      kind: z.enum(["trades", "realized"]).optional().describe("trades (executions) or realized (closed positions). Default trades."),
      symbol: z.string().optional().describe("IDX ticker to filter by"),
      period: z.string().optional().describe("Server-side period token, passed through as sent"),
      page: z.coerce.number().optional().describe("1-based page"),
      limit: z.coerce.number().optional().describe("Rows per page"),
    },
    async (a) => {
        return runTool(async () => {
          const ledger = await currentLedger();
          const fills = a.symbol
            ? ledger.fills.filter((f) => f.symbol === String(a.symbol).toUpperCase())
            : ledger.fills;
          const realised = fills.filter((f) => f.realisedIdr !== undefined);
          return {
            mode: "paper" as const,
            kind: a.kind === "realized" ? "realized" : "trades",
            rows: a.kind === "realized" ? realised : fills,
            summary:
              `${PAPER_BANNER} ${fills.length} paper fill${fills.length === 1 ? "" : "s"} recorded` +
              `${a.symbol ? ` in ${String(a.symbol).toUpperCase()}` : ""}. This is the local ledger, not ` +
              "the brokerage's history — it holds nothing that happened before paper mode was turned on.",
          };
        });
    },
  );

  define.read(
    "paper_trade_performance",
    "LOCAL PAPER SIMULATION: trade performance from this machine’s paper ledger. No Stockbit virtual portfolio or real money is affected. No securities session or PIN is needed. Relay the PAPER ACCOUNT banner and fill limitations.",
    {
      series: z
        .enum(PERFORMANCE_KINDS)
        .optional()
        .describe("Portfolio series to read. Omit for the aggregate trading performance."),
    },
    async (a) =>
      runTool(async () => {
        const snap = await paperSnapshot();
        const wins = (await currentLedger()).fills.filter((f) => (f.realisedIdr ?? 0) > 0).length;
        const closed = (await currentLedger()).fills.filter((f) => f.realisedIdr !== undefined).length;
        return {
          mode: "paper" as const,
          startingCashIdr: snap.startingCashIdr,
          cashIdr: snap.cashIdr,
          totalValueIdr: snap.totalValueIdr,
          realisedIdr: snap.realisedIdr,
          closedTrades: closed,
          winners: wins,
          // No series: a paper ledger records fills, not a daily portfolio curve, and interpolating
          // one would be a picture of something that was never measured.
          series: null,
          summary:
            `${PAPER_BANNER} Realised P&L ${snap.realisedIdr.toFixed(0)} IDR over ${closed} closed ` +
            `paper trade${closed === 1 ? "" : "s"}. There is no equity curve here: the ledger records ` +
            "fills, not a daily valuation, and drawing one would be a picture of something nobody measured.",
        };
      }),
  );

  /* ------------------------------- order entry ------------------------------- */

  define.read(
    "trading_status",
    "Local paper-simulation policy and securities session presence. Real-money execution is permanently unavailable. This is an offline configuration read; it does not validate the session.",
    {},
    async () => runTool(async () => {
      const policy = tradingPolicy();
      return {
        policy, mode: policy.mode, realMoneyExecution: "unavailable",
        sessionStored: hasStoredSession("securities"), ticketTtlSeconds: TICKET_TTL_MS / 1000,
        rememberGrant: describeRemember(policy), orderLog: orderLogPath(),
        protocol: "Two steps: paper_order_preview creates a local simulation ticket. Relay its summary and obtain consent, then call the matching paper_order_buy/sell/amend/cancel tool. No real order route exists.",
        paper: { ledger: paperLedgerPath(), reset: "stockbit-auth paper-reset" },
      };
    }),
  );

  define.read(
    "paper_order_preview",
    "LOCAL PAPER SIMULATION: price a paper order and check it, WITHOUT sending anything. This is step one of two and the only " +
      "way to get a ticket id.\n" +
      "RELAY `summary` VERBATIM to the user. It is one paragraph carrying the lots, the price, the " +
      "gross, the commission and its source, the net, the last trade, the distance from it, and " +
      "today's auto-rejection band. Do not summarise it further and do not round its numbers — the " +
      "user is agreeing to those figures.\n" +
      "Then ASK, in plain words, and wait. Only after they agree do you call the matching write " +
      "tool with this ticket id and confirm: true. Never set confirm on their behalf.\n" +
      `The ticket expires in ${TICKET_TTL_MS / 1000} seconds because it was priced against a market ` +
      "that moves. An expired ticket is refused, not silently repriced.\n" +
      "CHECKS: `checks` each carry `ok` and a `detail` written for a person. `ok: false` blocks the " +
      "order. A check marked `unverified` PASSED BY DEFAULT because its input could not be read — " +
      "it means 'not contradicted', never 'confirmed', and `warnings` names every one of them.\n" +
      "A ticket is returned even when checks fail: the user asked what would happen, and the " +
      "answer is why it will not work.\n" +
      "For amend and cancel, pass `order_id` from the `paper_orders` tool; the symbol and the untouched " +
      "terms are read from the open order.",
    {
      action: z.enum(["buy", "sell", "amend", "cancel"]).describe("What the order would do"),
      symbol: z.string().optional().describe("IDX ticker. Required for buy and sell; read from the order otherwise."),
      // Bounded at the schema, not only downstream. `z.coerce.number()` alone accepts NaN ("abc"),
      // 0 (""), negatives and fractions, and previewOrder does five sequential network reads before
      // anything looks at the value — so the user paid a full round trip for an argument that could
      // never have been valid. The preview's own checks stay: they give a better message, and they
      // are what a value read off an existing order goes through.
      price: z.coerce
        .number()
        .finite()
        .positive()
        .optional()
        .describe("Limit price in rupiah. Must sit on the IDX tick grid."),
      lots: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Lots — 1 lot is 100 shares. The wire takes shares; this does the arithmetic."),
      order_id: z.string().optional().describe("The local paper order to amend or cancel, from paper_orders"),
    },
    async (a) =>
      runTool(async () => {
        const ticket = await previewOrder({
          action: a.action as OrderTicket["action"],
          symbol: a.symbol ? String(a.symbol) : undefined,
          price: a.price as number | undefined,
          lots: a.lots as number | undefined,
          orderId: a.order_id ? String(a.order_id) : undefined,
          // In paper the four ACCOUNT-side reads come from the ledger. The market-side checks — the
          // tick grid, today's ARA/ARB band, the session, whether the exchange will take the symbol
          // — stay real, because those are exactly what the rehearsal is for.
          account: paperPreviewReads(),
        });
        return {
          ...ticket,
          mode: "paper" as const,
          summary: `${PAPER_BANNER} ${ticket.summary}`,
        };
      }),
  );

  const writeArgs = {
    ticket_id: z.string().describe("The id from paper_order_preview. This tool takes no price and no quantity."),
    confirm: z
      .boolean()
      .optional()
      .describe(COMMITMENT_CONFIRM),
  };

  const submit = (
    run: (options: { ticketId: string; confirm?: boolean; elicit?: ElicitDecision }) => Promise<OrderResult>,
  ) =>
    async (a: Record<string, unknown>) =>
      runTool(async () => {
        const result = await run({
          ticketId: String(a.ticket_id),
          confirm: a.confirm === true,
          // Passed through, not called here. The gate calls it BEFORE it looks at `confirm`, so a
          // client that can reach a person always reaches them — see src/trading/confirmation.ts.
          elicit: define.elicitDecision ? define.elicitDecision.bind(define) : undefined,
        });
        return { ...result, mode: "paper", message: describeOutcome(result), ...auditNote(result) };
      });

  define.write(
    "paper_order_buy",
    "LOCAL PAPER SIMULATION ONLY: buy a paper order in this machine's ledger. No real money or Stockbit virtual account is affected. " +
      "First call paper_order_preview, relay its PAPER ACCOUNT summary, and obtain consent. Pass the ticket id with confirm: true only after agreement. " +
      "When MCP elicitation is available, the person's answer decides. Fills are approximate: close-only data, no queue position, no partial fills. Read outcome and paperNote before reporting success.",
    writeArgs,
    submit(placeBuy),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "paper_order_sell",
    "LOCAL PAPER SIMULATION ONLY: sell a paper order in this machine's ledger. No real money or Stockbit virtual account is affected. " +
      "First call paper_order_preview, relay its PAPER ACCOUNT summary, and obtain consent. Pass the ticket id with confirm: true only after agreement. " +
      "When MCP elicitation is available, the person's answer decides. Fills are approximate: close-only data, no queue position, no partial fills. Read outcome and paperNote before reporting success.",
    writeArgs,
    submit(placeSell),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "paper_order_amend",
    "LOCAL PAPER SIMULATION ONLY: amend a paper order in this machine's ledger. No real money or Stockbit virtual account is affected. " +
      "First call paper_order_preview, relay its PAPER ACCOUNT summary, and obtain consent. Pass the ticket id with confirm: true only after agreement. " +
      "When MCP elicitation is available, the person's answer decides. Fills are approximate: close-only data, no queue position, no partial fills. Read outcome and paperNote before reporting success.",
    writeArgs,
    submit(amendOrder),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "paper_order_cancel",
    "LOCAL PAPER SIMULATION ONLY: cancel a paper order in this machine's ledger. No real money or Stockbit virtual account is affected. " +
      "First call paper_order_preview, relay its PAPER ACCOUNT summary, and obtain consent. Pass the ticket id with confirm: true only after agreement. " +
      "When MCP elicitation is available, the person's answer decides. Fills are approximate: close-only data, no queue position, no partial fills. Read outcome and paperNote before reporting success.",
    writeArgs,
    submit(cancelOrder),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "trading_forget",
    "Cancel the user's standing \"don't ask again\", so the next order asks them directly again.\n" +
      "The confirmation dialog can carry a second box the user ticks themselves, which waives the " +
      "dialog for later orders of the same value or smaller, for " +
      `${REMEMBER_TTL_MS / 60_000} minutes, in this server process only. This ends that immediately.\n` +
      "Call it whenever the user says anything like \"ask me again\", \"stop skipping the " +
      "confirmation\" or \"I didn't mean to tick that\" — it only ever makes this server ask MORE " +
      "questions, never fewer, so there is no case where calling it is the risky choice.\n" +
      "It is safe to call when there is no grant: `hadGrant: false` says so and nothing changes. " +
      "It touches no settings and makes no request.\n" +
      "This clears memory in THIS process. `stockbit-auth trading-forget` at a terminal does the " +
      "same across every server process, including ones already running, by stamping the settings " +
      "file — use that when the user has more than one client open.",
    {},
    async () =>
      runTool(async () => {
        // Read before clearing, against the CURRENT policy, so the answer distinguishes two facts
        // that are not the same: whether anything was held in memory, and whether it was still in
        // force. A grant whose policy has moved on, or that a terminal already revoked, is held but
        // covers nothing — reporting that as "a permission was removed" would overstate what this
        // call did.
        const before = describeRemember(tradingPolicy());
        forgetRemember();
        const held = before.active || before.stale === true;
        return {
          hadGrant: held,
          wasInForce: before.active,
          ...(before.capIdr === undefined ? {} : { clearedCapIdr: before.capIdr }),
          message: before.active
            ? "The standing \"don't ask again\" is cleared. The next order asks the user directly again, " +
              "wherever this client supports it."
            : held
              ? "A standing \"don't ask again\" was held but was already out of force — the trading policy had " +
                "changed under it, or it had been revoked at a terminal. It is gone now, and nothing about " +
                "what gets asked has changed."
              : "There was no standing \"don't ask again\" to clear. Every order already asks the user directly, " +
                "wherever this client supports it.",
        };
      }),
    // It only ever tightens: the state it removes is a permission, and removing it cannot place,
    // amend or cancel anything. Running it twice is running it once, which is what idempotent means.
    { destructiveHint: false, idempotentHint: true },
  );
}

/**
 * One sentence per outcome class, written for a person.
 *
 * Kept here rather than in `src/trading/orders.ts` for the reason ADR-0003 gives: the core returns
 * facts, the tool layer turns them into the words a model will repeat. A model that reads only this
 * sentence must still end up telling the user the truth — which is why none of the uncertain
 * branches contain the word "placed" on its own.
 */
function describeOutcome(result: OrderResult): string {
  const note = elicitationNote(result.elicitation);
  const description = result.paperNote ?? `${PAPER_BANNER} ${result.action.toUpperCase()} ${result.symbol}: ${result.outcome}. ${result.error ?? ""}`;
  return `${description}${note ? ` ${note}` : ""}`;
}

/** Says plainly when the attempt is NOT in the audit log, rather than implying that it is. */
function auditNote(result: OrderResult): { auditLog: string } | { auditGap: string } {
  return result.logged
    ? { auditLog: result.logPath }
    : {
        auditGap:
          `This attempt could NOT be written to ${result.logPath}. The order itself is unaffected, but there ` +
          "is no audit line for it — tell the user.",
      };
}
