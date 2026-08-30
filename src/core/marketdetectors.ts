/**
 * Broker summary + bandar detector — the core feature. TradingView has no equivalent.
 * Endpoint: GET /marketdetectors/{symbol}?transaction_type&market_board&investor_type&limit&period
 * Field units verified in docs/stockbit-api.md §4a (blot/slot = net lots; bval/sval = net IDR value).
 *
 * ## The sell side is NEGATIVE, and that is the wire's doing
 *
 * `slot`/`sval` arrive signed: a net seller is reported as `"-250668"` / `"-7.5689625e+10"`, while
 * every buy row is positive. All 25 sell rows and all 16 buy rows of the captured fixture agree, and
 * `test/core.test.ts` asserts it. That sign is carried through `NormalizedBroker` untouched, so a
 * caller that wants a magnitude asks for one — `src/analysis/analyze.ts` does exactly that. It is
 * spelled out here because a reader who assumes magnitudes writes `buy - sell` and gets the SUM of
 * both sides, which is the bug this comment exists to prevent recurring.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { isSettledRange, normalizeDateRange, type DateRange, type DateRangeInput } from "./dates.js";

/**
 * The vocabulary this endpoint actually accepts.
 *
 * Three of the values sent here for the life of the project do not exist upstream:
 *
 *   - `TRANSACTION_TYPE_BUY` / `_SELL`. The endpoint's two modes are net and gross; there is no
 *     buy-only or sell-only mode, because every response already carries both sides as
 *     `brokers_buy` and `brokers_sell`. The alternative to NET is **GROSS**.
 *   - `MARKET_BOARD_NEGOTIATED` / `_CASH`. The board names are `NEGO` and `TUNAI`, and `ALL` — the
 *     one that folds negotiated blocks back in, and the one most likely to be wanted — was missing
 *     entirely.
 *
 * The names were guessed by translating the English words. The right ones were measured for the
 * broker *distribution* endpoint in this same codebase (`DISTRIBUTION_BOARDS` in
 * `src/core/brokerdistribution.ts`), and that measurement was simply never carried across. Note the
 * *prefix* still differs between the two endpoints — `MARKET_BOARD_` here, `MARKET_TYPE_` there —
 * which is exactly why each one keeps its own table instead of sharing a constant that would look
 * interchangeable.
 *
 * A wrong enum here does not 400. It comes back 200 with numbers, which is why this went unnoticed.
 */
/**
 * Preset windows, the alternative to `from`/`to`.
 *
 * Measured against a live account on 2026-08-09, which settled a direct contradiction between two
 * of this project's own documents: `docs/stockbit-api.md` §4a claimed a 16-candidate sweep had left only
 * `_LATEST` and `_UNSPECIFIED`, and `docs/research/2026-08-05-capability-research.md` claimed eleven. **The research
 * doc was right and the catalogue was wrong.** What the endpoint actually accepts:
 *
 * ```
 *   LATEST         200   from = to = the last session
 *   UNSPECIFIED    200   identical to LATEST
 *   YESTERDAY      200   the session before
 *   LAST_7_DAYS    200   2026-08-01 → 2026-08-07
 *   YEAR_TO_DATE   200   2026-01-02 → 2026-08-07
 *   LAST_3_MONTHS  200   2026-05-07 → 2026-08-07
 *   LAST_30_DAYS   400
 *   LAST_1_DAY     400
 * ```
 *
 * This matters more than a spelling correction. The server aggregates net broker flow across the
 * whole window in ONE request, so "who accumulated year to date" costs exactly as much as "who
 * bought today" — and it needed no dates worked out client-side.
 *
 * Mutually exclusive with `from`/`to`, and violating that fails SILENTLY: the API ignores the dates
 * and answers 200 with the latest session. See `paramsFor`.
 */
export const BROKER_SUMMARY_PERIODS = [
  "LATEST",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_3_MONTHS",
  "YEAR_TO_DATE",
] as const;

export type BrokerSummaryPeriod = (typeof BROKER_SUMMARY_PERIODS)[number];

export const TRANSACTION_TYPES = ["NET", "GROSS"] as const;
export const MARKET_BOARDS = ["REGULER", "ALL", "NEGO", "TUNAI"] as const;
export const INVESTOR_TYPES = ["ALL", "FOREIGN", "DOMESTIC"] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type MarketBoard = (typeof MARKET_BOARDS)[number];
export type InvestorType = (typeof INVESTOR_TYPES)[number];

export interface BrokerSummaryOptions extends DateRangeInput {
  symbol: string;
  /** Preset window. Ignored when `from`/`to` are given — the two are mutually exclusive. */
  period?: BrokerSummaryPeriod;
  transactionType?: TransactionType;
  marketBoard?: MarketBoard;
  investorType?: InvestorType;
  /** Default 50 — the API default of 25 truncates (total_seller can exceed it). */
  limit?: number;
}

/**
 * Build the query for one broker-summary request.
 *
 * **`period` and `from`/`to` are mutually exclusive on the wire, and getting that wrong fails
 * silently.** When `period` is present the API ignores the dates entirely and returns the latest
 * session with HTTP 200 — a caller asking for last week gets today's numbers and no indication
 * anything went wrong.
 *
 * So the two shapes are built separately and never merged. This is deliberately not
 * "always set period, then delete it when dates exist": that form leaves a single `delete` between
 * correct behaviour and a silent wrong answer, and nothing in a diff would flag its removal. Here,
 * emitting both requires editing a return statement that plainly has only one of each.
 *
 * Exported so the exclusivity can be asserted directly in tests, without a network round-trip.
 */
function paramsFor(
  opts: BrokerSummaryOptions,
  range: DateRange | undefined,
): Record<string, string | number> {
  // `base` lists its fields explicitly rather than spreading `opts`. BrokerSummaryOptions extends
  // DateRangeInput, so a spread would carry date_from/start_date onto the wire — parameters the API
  // silently ignores, which is the failure this whole module is built to prevent.
  const base = {
    transaction_type: `TRANSACTION_TYPE_${opts.transactionType ?? "NET"}`,
    market_board: `MARKET_BOARD_${opts.marketBoard ?? "REGULER"}`,
    investor_type: `INVESTOR_TYPE_${opts.investorType ?? "ALL"}`,
    limit: opts.limit ?? 50,
  };
  return range
    ? { ...base, from: range.from, to: range.to }
    : { ...base, period: `BROKER_SUMMARY_PERIOD_${opts.period ?? "LATEST"}` };
}

export function buildBrokerSummaryParams(opts: BrokerSummaryOptions): Record<string, string | number> {
  return paramsFor(opts, normalizeDateRange(opts));
}

function ttlFor(range: DateRange | undefined, now: Date): number {
  // A window that ended before today can never change, so it is cached far longer than a live one.
  // Anything touching today is still being written to by the running session.
  return range && isSettledRange(range, now)
    ? CACHE.brokerSummarySettledTtlMs
    : CACHE.brokerSummaryTtlMs;
}

/** Cache lifetime for a given request. Exported so both branches can be asserted directly. */
export function brokerSummaryTtlFor(opts: BrokerSummaryOptions, now: Date = new Date()): number {
  return ttlFor(normalizeDateRange(opts), now);
}

const BrokerRow = z
  .object({
    netbs_broker_code: z.string(),
    netbs_date: z.string().optional(),
    type: z.string().optional(), // Asing | Lokal | Pemerintah
    freq: z.string().optional(),
    // buy side
    blot: z.string().optional(),
    bval: z.string().optional(),
    netbs_buy_avg_price: z.string().optional(),
    // sell side
    slot: z.string().optional(),
    sval: z.string().optional(),
    netbs_sell_avg_price: z.string().optional(),
  })
  .passthrough();

const Response = z
  .object({
    data: z
      .object({
        broker_summary: z
          .object({
            symbol: z.string().optional(),
            brokers_buy: z.array(BrokerRow),
            brokers_sell: z.array(BrokerRow),
          })
          .passthrough(),
        bandar_detector: z.record(z.unknown()).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface NormalizedBroker {
  code: string;
  investorType?: string; // Asing/Lokal/Pemerintah
  /**
   * Net lots. POSITIVE on a buy row, NEGATIVE on a sell row — the wire's own sign, kept.
   *
   * Absent when the field could not be read. Absent is not zero: a broker whose figure was
   * unreadable has not netted nothing, and the one tool whose job is telling those apart must not
   * be handed a fabricated 0. See `unreadable` on the summary.
   */
  netLots?: number;
  /** Net value in IDR. Same sign convention and same absent-is-not-zero rule as `netLots`. */
  netValueIdr?: number;
  avgPrice?: number;
  freq?: number;
}

export interface BrokerSummary {
  symbol: string;
  from?: string;
  to?: string;
  buyers: NormalizedBroker[];
  sellers: NormalizedBroker[];
  bandarDetector?: Record<string, unknown>;
  /**
   * What a caller cannot see from the rows alone: which brokers are missing from which total, and
   * which wire keys were involved. Absent when everything parsed, which is the normal case.
   *
   * `buyers` and `sellers` count the LISTED brokers whose own side's flow figure did not yield a
   * number — missing, empty or unparseable alike — so they are the brokers left out of that side's
   * value and lot totals. Reported per side because a single number could not say which total was
   * short. `buyers: 1` beside `buyers.length: 16` means every buy total above covers 15 brokers.
   *
   * `keys` names every wire key involved, including `freq` and the average price. Those decorate a
   * row and feed no total, so they never move the two counts; a `freq` that will not parse gives
   * `{ buyers: 0, sellers: 0, keys: ["freq"] }`.
   */
  unreadable?: { buyers: number; sellers: number; keys: string[] };
}

/**
 * A number off the broker wire, or `undefined`.
 *
 * Mirrors `asNumber` in `src/trading/account.ts` — a separated number ("1,234" / "1.234,56") is
 * REFUSED rather than guessed at, because the two Indonesian conventions disagree about which
 * separator is the decimal one and a value parsed under the wrong one is off by a thousand while
 * still looking like a value.
 *
 * It differs from `asNumber` in one way that matters: this wire is E-notation
 * ("1.01635016e+11", "3.79869e+07"), which `asNumber`'s pattern rejects. Reusing that regex verbatim
 * here would turn every figure in the captured fixture into `undefined`.
 */
const NUMERIC_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function asBrokerNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!NUMERIC_RE.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export async function getBrokerSummary(opts: BrokerSummaryOptions): Promise<BrokerSummary> {
  const symbol = normalizeSymbol(opts.symbol);
  // Normalized once and threaded through, so the params and the TTL are decided from the same
  // resolved range rather than each deriving it independently.
  const range = normalizeDateRange(opts);
  const params = paramsFor(opts, range);
  const key = `brokerSummary:${symbol}:${JSON.stringify(params)}`;
  const ttl = ttlFor(range, new Date());

  return cached(key, ttl, async () => {
    const body = await getJson("marketDetectors", { segments: { symbol }, params });
    const parsed = parseOr(Response, body, "broker summary");
    const bs = parsed.data.broker_summary;

    // One collector for both sides. A figure the wire sent but this server would not parse is
    // recorded by key and by row, so `unreadable` can say so out loud rather than the value simply
    // being missing for no stated reason.
    const unreadableKeys = new Set<string>();
    const dropped = { buyers: 0, sellers: 0 };

    /**
     * Read a row's numbers, distinguishing the two figures that carry flow from the two that
     * decorate it.
     *
     * The two are counted differently because they fail differently.
     *
     * A FLOW figure is the row's own side's `blot`/`bval` or `slot`/`sval`. If it does not yield a
     * number — missing, empty, or unparseable, the reason does not matter — that broker cannot enter
     * the total, and a total that summed 15 of 16 listed brokers has to say so. Refusing to
     * fabricate a zero for a ROW and then quietly fabricating one for the TOTAL would be the same
     * mistake one level up.
     *
     * A DETAIL figure is `freq` or the average price. It feeds nothing, so a broker whose `freq`
     * will not parse is still wholly inside `buyValueIdr` and counting it as dropped would tell the
     * model a complete total was short. Its key is still named — a wire that started sending an
     * unparseable `freq` is worth knowing about — but only when it was actually sent: an absent or
     * empty detail field is Stockbit saying "no value here", which `numberish` in
     * `src/core/pricefeed.ts` already reads that way, and is not news.
     */
    const read = (
      row: Record<string, string | undefined>,
      side: "buyers" | "sellers",
      flowKeys: [string, string],
      detailKeys: string[],
    ): Record<string, number | undefined> => {
      const out: Record<string, number | undefined> = {};
      let flowMissing = false;
      for (const key of flowKeys) {
        const value = asBrokerNumber(row[key]);
        if (value === undefined) {
          unreadableKeys.add(key);
          flowMissing = true;
        }
        out[key] = value;
      }
      for (const key of detailKeys) {
        const raw = row[key];
        const value = asBrokerNumber(raw);
        if (value === undefined && raw != null && raw.trim() !== "") unreadableKeys.add(key);
        out[key] = value;
      }
      if (flowMissing) dropped[side] += 1;
      return out;
    };

    const mapBuy = (r: z.infer<typeof BrokerRow>): NormalizedBroker => {
      const v = read(r as Record<string, string | undefined>, "buyers", ["blot", "bval"], ["netbs_buy_avg_price", "freq"]);
      return {
        code: r.netbs_broker_code,
        investorType: r.type,
        netLots: v.blot,
        netValueIdr: v.bval,
        avgPrice: v.netbs_buy_avg_price,
        freq: v.freq,
      };
    };
    const mapSell = (r: z.infer<typeof BrokerRow>): NormalizedBroker => {
      const v = read(r as Record<string, string | undefined>, "sellers", ["slot", "sval"], ["netbs_sell_avg_price", "freq"]);
      return {
        code: r.netbs_broker_code,
        investorType: r.type,
        netLots: v.slot,
        netValueIdr: v.sval,
        avgPrice: v.netbs_sell_avg_price,
        freq: v.freq,
      };
    };

    const buyers = bs.brokers_buy.map(mapBuy);
    const sellers = bs.brokers_sell.map(mapSell);

    return {
      symbol: bs.symbol ?? symbol,
      from: parsed.data.from,
      to: parsed.data.to,
      buyers,
      sellers,
      bandarDetector: parsed.data.bandar_detector,
      // Emitted whenever a key would not parse, even if no total lost a broker by it: zero counts
      // with a key named is the honest report of an unparseable `freq`.
      ...(unreadableKeys.size > 0
        ? { unreadable: { buyers: dropped.buyers, sellers: dropped.sellers, keys: [...unreadableKeys].sort() } }
        : {}),
    };
  });
}
