/**
 * Broker summary + bandar detector — the core feature. TradingView has no equivalent.
 * Endpoint: GET /marketdetectors/{symbol}?transaction_type&market_board&investor_type&limit&period
 * Field units verified in STOCKBIT-API.md §4a (blot/slot = net lots; bval/sval = net IDR value).
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { isSettledRange, normalizeDateRange, type DateRange, type DateRangeInput } from "./dates.js";

export type TransactionType = "NET" | "BUY" | "SELL";
export type MarketBoard = "REGULER" | "NEGOTIATED" | "CASH";
export type InvestorType = "ALL" | "FOREIGN" | "DOMESTIC";

export interface BrokerSummaryOptions extends DateRangeInput {
  symbol: string;
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
    : { ...base, period: "BROKER_SUMMARY_PERIOD_LATEST" };
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
  netLots: number;
  netValueIdr: number;
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
}

const num = (s?: string): number => (s == null ? 0 : Number(s));

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

    const mapBuy = (r: z.infer<typeof BrokerRow>): NormalizedBroker => ({
      code: r.netbs_broker_code,
      investorType: r.type,
      netLots: num(r.blot),
      netValueIdr: num(r.bval),
      avgPrice: r.netbs_buy_avg_price ? num(r.netbs_buy_avg_price) : undefined,
      freq: r.freq ? num(r.freq) : undefined,
    });
    const mapSell = (r: z.infer<typeof BrokerRow>): NormalizedBroker => ({
      code: r.netbs_broker_code,
      investorType: r.type,
      netLots: num(r.slot),
      netValueIdr: num(r.sval),
      avgPrice: r.netbs_sell_avg_price ? num(r.netbs_sell_avg_price) : undefined,
      freq: r.freq ? num(r.freq) : undefined,
    });

    return {
      symbol: bs.symbol ?? symbol,
      from: parsed.data.from,
      to: parsed.data.to,
      buyers: bs.brokers_buy.map(mapBuy),
      sellers: bs.brokers_sell.map(mapSell),
      bandarDetector: parsed.data.bandar_detector,
    };
  });
}
