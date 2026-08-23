/**
 * The trading account's read tools.
 *
 * Every one of these is a `define.read`. Nothing in this file can place, amend or cancel an order —
 * that arrives with ADR-0004 and goes through `define.write`, which is deliberately unreachable
 * from a saved workflow recipe.
 *
 * Two things recur in the descriptions below and are worth stating once here, because a model
 * reading these tools has no other documentation:
 *
 *  1. **Nothing on this host has been observed live.** The securities session needs a PIN this
 *     project never stores. Field names are therefore projected against candidate keys, `readFrom`
 *     names the wire key each value actually came from, and a field this projection could not read
 *     is absent rather than zero.
 *  2. **Unrecognised fields are dropped, not returned.** `unmappedKeys` lists their NAMES only. On
 *     market data this project returns the raw row; on a brokerage account it does not, because an
 *     unmapped field there is as likely to be an account number as a metric.
 */
import { z } from "zod";
import * as account from "../trading/account.js";
import { PERFORMANCE_KINDS } from "../trading/account.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

/** The sentence every description ends with. Written once so all ten agree word for word. */
const PROJECTION_NOTE =
  "PENDING VERIFICATION: this endpoint has not been observed live, so field names are projected. " +
  "`readFrom` names the wire key each value was read from; a field that is absent was not " +
  "recognised on the response, which is NOT the same as it being zero. `unmappedKeys` lists the " +
  "names of fields this server did not recognise — their values are deliberately dropped rather " +
  "than returned, because an unmapped field on a brokerage response may be an account number.";

const LOGIN_NOTE =
  "Requires the trading session: if it is not set up the error says to run `stockbit-auth " +
  "trading-login`, which asks the user for their 6-digit PIN at their own terminal. Never ask the " +
  "user for that PIN here — no tool accepts one and this server never stores one.";

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
    async (a) => {
      const opts = {
        symbol: a.symbol ? String(a.symbol) : undefined,
        period: a.period ? String(a.period) : undefined,
        page: a.page as number | undefined,
        limit: a.limit as number | undefined,
      };
      return runTool<account.HistoryPage | account.RealizedPage>(() =>
        a.kind === "realized" ? account.getRealizedHistory(opts) : account.getTradeHistory(opts),
      );
    },
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
    async (a) =>
      runTool(() =>
        a.series ? account.getPortfolioPerformance(String(a.series)) : account.getTradePerformance(),
      ),
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
      PROJECTION_NOTE,
    {},
    async () => runTool(() => account.getAccount()),
  );
}
