/**
 * Broker Distribution — the broker-to-broker flow matrix.
 *
 * Where `broker_summary` tells you *how much* each broker net-bought or net-sold, this tells you
 * *who they traded with*: for each top broker, the counterparties on the other side and the amount
 * that moved between them. It is the difference between "AK accumulated 445B" and "AK accumulated
 * 445B, of which 77B came from BK and 55B from DX".
 *
 * ## Entitlement
 *
 * Stockbit gates this feature behind a minimum account balance (Rp 10,000,000). In their own web
 * app the gate is enforced **client-side**: the component receives an `isEligible` prop and, when
 * false, renders a blurred overlay over placeholder data and never issues the request at all.
 *
 * That has two consequences worth stating plainly, because they bound what this module can promise:
 *
 *   1. Whether the *server* also refuses an ineligible account is **unverified** — it could not be
 *      tested from an entitled account, and deliberately obtaining an ineligible one to find out
 *      was not worth doing.
 *   2. Therefore the ineligibility path here is written defensively rather than from an observed
 *      response: an HTTP 403 (authenticated, but refused) is reported as an entitlement problem,
 *      while 401 stays a genuine auth failure. If the server turns out not to gate at all, this
 *      branch simply never fires and callers get their data.
 *
 * The failure message names the requirement either way, so a caller who is refused learns *why*
 * rather than seeing a bare "forbidden".
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { isSettledRange, normalizeDateRange, type DateRange, type DateRangeInput } from "./dates.js";

/** Stockbit's minimum total balance for this feature, in IDR. */
export const REQUIRED_BALANCE_IDR = 10_000_000;

export const ENTITLEMENT_MESSAGE =
  "Your Stockbit account does not have access to Broker Distribution. Stockbit gates this feature " +
  `behind a minimum total balance of Rp ${REQUIRED_BALANCE_IDR.toLocaleString("en-US")}. ` +
  "Top up to that level in the Stockbit app to unlock it. All other tools are unaffected.";

/** VALUE returns IDR amounts; VOLUME returns share counts. The other block comes back empty. */
export type DistributionDataType = "VALUE" | "VOLUME";
export type DistributionInvestorType = "ALL" | "FOREIGN" | "DOMESTIC";

/**
 * Preset windows the endpoint accepts. Mutually exclusive with `from`/`to` — see `buildParams`.
 * Taken from the `TB_PERIOD_*` enum in Stockbit's own bundle.
 */
export const DISTRIBUTION_PERIODS = [
  "LAST_1_DAY",
  "LAST_7_DAYS",
  "LAST_1_MONTH",
  "LAST_3_MONTHS",
  "LAST_6_MONTHS",
  "LAST_1_YEAR",
  "PREVIOUS_DAY",
  "PREVIOUS_MONTH",
  "THIS_MONTH",
  "YEAR_TO_DATE",
] as const;
export type DistributionPeriod = (typeof DISTRIBUTION_PERIODS)[number];

export interface BrokerDistributionOptions extends DateRangeInput {
  symbol: string;
  dataType?: DistributionDataType;
  investorType?: DistributionInvestorType;
  /** A preset window. Ignored if `from`/`to` are supplied. */
  period?: DistributionPeriod;
}

/* --------------------------------- response --------------------------------- */

const Party = z
  .object({
    code: z.string(),
    type: z.string().optional(),
    amount: z.coerce.number().optional(),
  })
  .passthrough();

const Entry = z
  .object({
    detail: Party,
    distribute_to: z.array(Party).optional(),
  })
  .passthrough();

const Side = z
  .object({
    top_broker_buy: z.array(Entry).optional(),
    top_broker_sell: z.array(Entry).optional(),
  })
  .passthrough();

const Response = z
  .object({
    data: z
      .object({
        date_info: z.string().optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        by_value: Side.optional(),
        by_volume: Side.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface DistributionCounterparty {
  code: string;
  investorType?: string;
  /** IDR when dataType is VALUE, shares when VOLUME. */
  amount: number;
}

export interface DistributionBroker extends DistributionCounterparty {
  /** Who this broker's flow went to / came from, largest first. */
  distributedWith: DistributionCounterparty[];
}

export interface BrokerDistribution {
  symbol: string;
  dataType: DistributionDataType;
  /** Units of every `amount` below — spelled out so a reader never has to guess. */
  amountUnit: "IDR" | "shares";
  from?: string;
  to?: string;
  asOf?: string;
  topBuyers: DistributionBroker[];
  topSellers: DistributionBroker[];
}

/* ---------------------------------- request ---------------------------------- */

/**
 * Build the query.
 *
 * `period` and `from`/`to` are mutually exclusive here exactly as they are on broker summary — the
 * frontend picks one or the other (`b ? {period} : {from,to}`) and never sends both. The two shapes
 * are therefore separate returns rather than one object with a conditional delete.
 *
 * `market_board` is deliberately absent: sending it makes the endpoint answer **400**, unlike
 * broker summary where it is required. Measured, not assumed.
 *
 * Exported so the exclusivity is assertable without a network round-trip.
 */
export function buildDistributionParams(
  opts: BrokerDistributionOptions,
  range: DateRange | undefined = normalizeDateRange(opts),
): Record<string, string> {
  const base = {
    symbol: normalizeSymbol(opts.symbol),
    data_type: `BROKER_DISTRIBUTION_DATA_TYPE_${opts.dataType ?? "VALUE"}`,
    investor_type: `INVESTOR_TYPE_${opts.investorType ?? "ALL"}`,
  };
  if (range) return { ...base, from: range.from, to: range.to };
  return { ...base, period: `TB_PERIOD_${opts.period ?? "LAST_1_DAY"}` };
}

const mapParty = (p: z.output<typeof Party>): DistributionCounterparty => ({
  code: p.code,
  investorType: p.type,
  amount: p.amount ?? 0,
});

/**
 * Fetch the broker-to-broker flow matrix.
 *
 * A 403 is translated into the entitlement message rather than surfacing as a bare auth error —
 * see the module header for why that mapping is defensive rather than observed.
 */
export async function getBrokerDistribution(
  opts: BrokerDistributionOptions,
): Promise<BrokerDistribution> {
  const range = normalizeDateRange(opts);
  const params = buildDistributionParams(opts, range);
  const dataType = opts.dataType ?? "VALUE";
  const key = `brokerDistribution:${JSON.stringify(params)}`;
  const ttl = range && isSettledRange(range) ? CACHE.brokerSummarySettledTtlMs : CACHE.brokerSummaryTtlMs;

  return cached(key, ttl, async () => {
    let body: unknown;
    try {
      body = await getJson("brokerDistribution", { params });
    } catch (err) {
      if (err instanceof StockbitError && err.status === 403) {
        throw new StockbitError("auth", ENTITLEMENT_MESSAGE, { status: 403 });
      }
      throw err;
    }

    const parsed = parseOr(Response, body, "broker distribution");
    const d = parsed.data;
    const side = dataType === "VALUE" ? d.by_value : d.by_volume;

    const mapEntry = (e: z.output<typeof Entry>): DistributionBroker => ({
      ...mapParty(e.detail),
      distributedWith: (e.distribute_to ?? []).map(mapParty),
    });

    return {
      symbol: params.symbol,
      dataType,
      amountUnit: dataType === "VALUE" ? "IDR" : "shares",
      from: d.start_date,
      to: d.end_date,
      asOf: d.date_info,
      topBuyers: (side?.top_broker_buy ?? []).map(mapEntry),
      topSellers: (side?.top_broker_sell ?? []).map(mapEntry),
    };
  });
}
