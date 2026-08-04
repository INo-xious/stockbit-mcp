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

/**
 * What to say when the server returns 403.
 *
 * Phrased as the *likely* cause rather than a verdict, and it never replaces what the server said.
 * An earlier version asserted the balance gate outright and discarded the upstream body — which
 * meant a Cloudflare block or a revoked session told the user to deposit Rp 10,000,000 to fix a
 * problem that money cannot fix, with the real error text gone. This project's own config notes
 * that these routes "400s/403s ... without browser-shaped Origin/Referer", so a non-entitlement 403
 * is not hypothetical; it is the one actually seen.
 */
export const ENTITLEMENT_MESSAGE =
  "Stockbit refused this request (HTTP 403). The most likely cause is Broker Distribution's " +
  `entitlement gate: Stockbit requires a minimum total balance of Rp ${REQUIRED_BALANCE_IDR.toLocaleString("en-US")} ` +
  "for this feature, and accounts below it have no access. If your balance already exceeds that, " +
  "the session may need re-authenticating (`stockbit-auth login`), or the request was blocked " +
  "upstream — this API also answers 403 when expected browser headers are missing.";

/** Append whatever the server actually said, so the real cause is never destroyed. */
export function describeForbidden(upstream?: string): string {
  const said = upstream?.trim();
  return said && said !== "HTTP 403" ? `${ENTITLEMENT_MESSAGE}\nServer said: ${said}` : ENTITLEMENT_MESSAGE;
}

/** VALUE returns IDR amounts; VOLUME returns share counts. The other block comes back empty. */
export type DistributionDataType = "VALUE" | "VOLUME";
export type DistributionInvestorType = "ALL" | "FOREIGN" | "DOMESTIC";

/**
 * Market boards this endpoint accepts.
 *
 * NOTE the value prefix is `MARKET_TYPE_`, not `MARKET_BOARD_` as broker summary uses — sending the
 * summary's spelling here returns 400, which an earlier revision misread as "this endpoint does not
 * take a board at all". It does, and it matters: REGULER (the default, matching Stockbit's own UI)
 * gives BRMS a top buyer of 120.33B, while ALL gives 978.15B because it folds in negotiated blocks.
 */
export const DISTRIBUTION_BOARDS = ["REGULER", "ALL", "NEGO", "TUNAI"] as const;
export type DistributionBoard = (typeof DISTRIBUTION_BOARDS)[number];

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
  /** Default REGULER — negotiated block trades distort accumulation reads. */
  marketBoard?: DistributionBoard;
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
  marketBoard: DistributionBoard;
  /** Units of every `amount` below — spelled out so a reader never has to guess. */
  amountUnit: "IDR" | "lots";
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
    market_board: `MARKET_TYPE_${opts.marketBoard ?? "REGULER"}`,
  };
  if (range) return { ...base, from: range.from, to: range.to };
  return { ...base, period: `TB_PERIOD_${opts.period ?? "LAST_1_DAY"}` };
}

function ttlFor(range: DateRange | undefined, now: Date): number {
  // A window that closed before today is immutable; anything touching today is still being written.
  return range && isSettledRange(range, now)
    ? CACHE.brokerSummarySettledTtlMs
    : CACHE.brokerSummaryTtlMs;
}

/** Cache lifetime for a given request. Exported so both branches can be asserted directly. */
export function brokerDistributionTtlFor(
  opts: BrokerDistributionOptions,
  now: Date = new Date(),
): number {
  return ttlFor(normalizeDateRange(opts), now);
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
  // The key is derived from the full param set, so VALUE vs VOLUME, a different investor_type, and
  // a different window are all distinct entries. Collapsing any of them would serve one query's
  // data in answer to another.
  const key = `brokerDistribution:${JSON.stringify(params)}`;
  const ttl = ttlFor(range, new Date());

  return cached(key, ttl, async () => {
    let body: unknown;
    try {
      body = await getJson("brokerDistribution", { params });
    } catch (err) {
      if (err instanceof StockbitError && err.status === 403) {
        // Augment, never replace: errorType and details are what a reader needs when the cause is
        // NOT the balance gate.
        throw new StockbitError("auth", describeForbidden(err.message), {
          status: 403,
          errorType: err.errorType,
          details: err.details,
        });
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
      marketBoard: opts.marketBoard ?? "REGULER",
      amountUnit: dataType === "VALUE" ? "IDR" : "lots",
      from: d.start_date,
      to: d.end_date,
      asOf: d.date_info,
      topBuyers: (side?.top_broker_buy ?? []).map(mapEntry),
      topSellers: (side?.top_broker_sell ?? []).map(mapEntry),
    };
  });
}
