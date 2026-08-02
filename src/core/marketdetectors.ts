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

export type TransactionType = "NET" | "BUY" | "SELL";
export type MarketBoard = "REGULER" | "NEGOTIATED" | "CASH";
export type InvestorType = "ALL" | "FOREIGN" | "DOMESTIC";

export interface BrokerSummaryOptions {
  symbol: string;
  transactionType?: TransactionType;
  marketBoard?: MarketBoard;
  investorType?: InvestorType;
  /** Default 50 — the API default of 25 truncates (total_seller can exceed it). */
  limit?: number;
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
  const params = {
    transaction_type: `TRANSACTION_TYPE_${opts.transactionType ?? "NET"}`,
    market_board: `MARKET_BOARD_${opts.marketBoard ?? "REGULER"}`,
    investor_type: `INVESTOR_TYPE_${opts.investorType ?? "ALL"}`,
    limit: opts.limit ?? 50,
    period: "BROKER_SUMMARY_PERIOD_LATEST",
  };
  const key = `brokerSummary:${symbol}:${JSON.stringify(params)}`;

  return cached(key, CACHE.brokerSummaryTtlMs, async () => {
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
