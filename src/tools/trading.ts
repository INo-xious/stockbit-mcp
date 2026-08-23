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
import { previewOrder, type OrderTicket } from "../trading/preview.js";
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

  /* ------------------------------- order entry ------------------------------- */

  define.read(
    "trading_status",
    "Whether this server may place an order right now, and why not if it may not.\n" +
      "Read it before offering to trade anything. Trading is OFF by default and the user turns it " +
      "on themselves with `stockbit-auth trading-enable`; nothing this server does can turn it on, " +
      "and no argument to any tool can override it.\n" +
      "`policy.reason` is written for the user — relay it rather than paraphrasing. " +
      "`policy.autoConfirmIgnored`, when present, means autoConfirm was configured but is not being " +
      "honoured because no per-order value cap is set.\n" +
      "This tool reads local configuration and makes no request, so it works with no trading session.",
    {},
    async () =>
      runTool(async () => {
        const policy = tradingPolicy();
        return {
          policy,
          sessionStored: hasStoredSession("securities"),
          ticketTtlSeconds: TICKET_TTL_MS / 1000,
          orderLog: orderLogPath(),
          protocol:
            "Two steps, always: order_preview builds a ticket and returns its `summary`; the user reads that " +
            "summary and agrees to THAT order; order_buy/order_sell/order_amend/order_cancel take the ticket " +
            "id and confirm: true. The write tools take no price and no quantity, so what is placed is what " +
            "was shown.",
        };
      }),
  );

  define.read(
    "order_preview",
    "Price an order and check it, WITHOUT sending anything. This is step one of two and the only " +
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
      "For amend and cancel, pass `order_id` from the `orders` tool; the symbol and the untouched " +
      "terms are read from the open order.",
    {
      action: z.enum(["buy", "sell", "amend", "cancel"]).describe("What the order would do"),
      symbol: z.string().optional().describe("IDX ticker. Required for buy and sell; read from the order otherwise."),
      price: z.coerce.number().optional().describe("Limit price in rupiah. Must sit on the IDX tick grid."),
      lots: z.coerce.number().optional().describe("Lots — 1 lot is 100 shares. The wire takes shares; this does the arithmetic."),
      order_id: z.string().optional().describe("The order to amend or cancel, from the `orders` tool"),
    },
    async (a) =>
      runTool(() =>
        previewOrder({
          action: a.action as OrderTicket["action"],
          symbol: a.symbol ? String(a.symbol) : undefined,
          price: a.price as number | undefined,
          lots: a.lots as number | undefined,
          orderId: a.order_id ? String(a.order_id) : undefined,
        }),
      ),
  );

  const writeArgs = {
    ticket_id: z.string().describe("The id from order_preview. This tool takes no price and no quantity."),
    confirm: z
      .boolean()
      .optional()
      .describe("Must be true. The user must have agreed to THIS ticket's summary, in words, first."),
  };

  const submit = (
    run: (options: { ticketId: string; confirm?: boolean; elicit?: Definer["elicit"] }) => Promise<OrderResult>,
  ) =>
    async (a: Record<string, unknown>) =>
      runTool(async () => {
        const result = await run({
          ticketId: String(a.ticket_id),
          confirm: a.confirm === true,
          // Passed through, not called here: when the client supports it the human is asked directly,
          // on top of the confirmation the caller already had to pass.
          elicit: define.elicit ? define.elicit.bind(define) : undefined,
        });
        return { ...result, message: describeOutcome(result), ...auditNote(result) };
      });

  define.write(
    "order_buy",
    "PLACE A REAL BUY ORDER on the Indonesian exchange with the user's own money. There is no undo.\n" +
      "Step two of two. Call `order_preview` first, relay its `summary` to the user in words, ask " +
      "them, and pass `confirm: true` only after they have agreed to that specific order. Setting " +
      "confirm without asking is placing an order the user did not agree to.\n" +
      "This tool takes a ticket id and nothing else — no price, no quantity — so what reaches the " +
      "exchange is exactly what the user was shown.\n" +
      "READ `outcome` BEFORE REPORTING ANYTHING. `ok` is the only class that means the order is on " +
      "the book and was seen there. `not-visible`, `outcome-unknown` and `landed-despite-error` all " +
      "mean the state is uncertain — relay `message` verbatim and DO NOT RESEND. A resend is how " +
      "one intention becomes two orders.",
    writeArgs,
    submit(placeBuy),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "order_sell",
    "PLACE A REAL SELL ORDER on the Indonesian exchange, against the user's actual position. There " +
      "is no undo.\n" +
      "Same two-step protocol as `order_buy`: preview, relay the summary, ask, then pass the ticket " +
      "id with `confirm: true`. The ticket is what defines the order; this tool takes no terms.\n" +
      "READ `outcome` before reporting. Anything other than `ok` means the state is uncertain — " +
      "relay `message` verbatim and never resend.",
    writeArgs,
    submit(placeSell),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "order_amend",
    "CHANGE a working order's price or size on the exchange. Preview it first with " +
      "`action: \"amend\"` and the `order_id`, relay the summary, ask, then pass the ticket id with " +
      "`confirm: true`.\n" +
      "An amend can fill at the new terms the instant it is accepted, so it is a real order " +
      "decision and not an edit, and there is no undo. If `outcome` is not `ok`, the order may " +
      "still be working at its OLD terms or at the new ones — relay `message`, read `orders` " +
      "before acting, and do not resend.",
    writeArgs,
    submit(amendOrder),
    { destructiveHint: true, idempotentHint: false },
  );

  define.write(
    "order_cancel",
    "CANCEL a working order. Preview it first with `action: \"cancel\"` and the `order_id`, then " +
      "pass the ticket id with `confirm: true`.\n" +
      "A cancel races the market: an order can fill between the preview and the cancel arriving, in " +
      "which case there is nothing to cancel and the fill stands — which is why a cancel has no " +
      "undo either. `outcome: \"ok\"` means the order is gone from the book or marked cancelled; " +
      "anything else means read `orders` before telling the user what they own, and do not resend.",
    writeArgs,
    submit(cancelOrder),
    { destructiveHint: true, idempotentHint: false },
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
  const what = `${result.action.toUpperCase()} ${result.shares ?? ""} shares of ${result.symbol}`.replace(/\s+/g, " ");
  switch (result.outcome) {
    case "ok":
      return `${what} is on the book${result.orderId ? ` as order ${result.orderId}` : ""}, confirmed by reading the orders back.`;
    case "rejected":
      return `${what} was REJECTED and is not working. ${result.error ?? ""}`.trim();
    case "write-failed":
      return `${what} was refused before it reached the exchange, so nothing is on the book. ${result.error ?? ""}`.trim();
    case "not-found-after-error":
      return (
        `The request for ${what} errored (${result.error}) and the order list read back clean, so it does not ` +
        "appear to have been placed. Check `orders` before trying again."
      );
    default:
      // Every remaining class is an uncertain one, and each carries its own sentence already.
      return result.outcomeUnknown ?? `The outcome of ${what} could not be established. Do not resend it.`;
  }
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
