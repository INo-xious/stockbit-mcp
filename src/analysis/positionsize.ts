/**
 * How many lots, given what you are willing to lose.
 *
 * The arithmetic is not hard — risk divided by risk-per-share, floored to whole lots — and that is
 * exactly why it belongs here rather than being done in a model's head. It is the calculation
 * people get wrong under time pressure, in the direction that costs money: rounding lots up,
 * forgetting that a lot is a hundred shares, forgetting the round-trip commission, and putting a
 * stop on a price the exchange will reject.
 *
 * ## What this is not
 *
 * It is **pure arithmetic**. It reads no account, checks no buying power, does not know what the
 * user already holds, and cannot place anything. `order_preview` is where the real checks live —
 * cash, tradability, the caps in the trading policy — and this says so in its own summary rather
 * than letting a caller mistake a plan for a permission.
 *
 * ## Long only
 *
 * IDX retail has no short selling. A "stop" above the entry is therefore not a short position with
 * an inverted stop, it is a typo, and it is refused rather than silently interpreted.
 *
 * ## Fees
 *
 * Defaulted to the published retail rate (0.15% buy / 0.25% sell) and always labelled with where
 * the number came from. They are not decoration: on a 1% risk budget the round trip is a
 * meaningful fraction of the loss, and a break-even price computed without them is below the price
 * you actually need to get out flat.
 */
import { StockbitError } from "../http/errors.js";
import { tickSize, nearestTicks, onTickGrid, roundToTick } from "../core/ticks.js";
import { idr } from "../core/format.js";

/** Shares in one lot. Everything user-facing is in lots; the wire's business is shares. */
const SHARES_PER_LOT = 100;

/** The published retail schedule, used when the account's own is not supplied. */
export const DEFAULT_FEE_PCT = { buy: 0.15, sell: 0.25 } as const;

export interface PositionSizeInput {
  entryPrice: number;
  stopPrice: number;
  /** The rupiah you are willing to lose. Exactly one of this or `accountIdr` + `riskPct`. */
  riskIdr?: number;
  accountIdr?: number;
  /** Percent of the account, e.g. 1 for one percent. */
  riskPct?: number;
  feeBuyPct?: number;
  feeSellPct?: number;
  /** Today's auto-rejection ceiling, from `price_bands`. Checked only when supplied. */
  ara?: number;
  /** Today's auto-rejection floor, from `price_bands`. */
  arb?: number;
  maxLots?: number;
}

export interface PositionSizeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PositionSizeResult {
  lots: number;
  shares: number;
  positionIdr: number;
  riskPerShareIdr: number;
  /** What is actually at risk at this size — at most the budget, usually less after flooring. */
  riskIdr: number;
  riskPctOfAccount: number | null;
  /** The requested budget, before flooring to whole lots. */
  riskBudgetIdr: number;
  feesRoundTripIdr: number;
  feeSource: "supplied" | "default";
  /** Where the position must get to before commission is paid off. */
  breakEvenPrice: number;
  /** 1R, 2R and 3R from the entry, on the tick grid. */
  rTargets: { r1: number; r2: number; r3: number };
  ticks: {
    tick: number;
    entryOnGrid: boolean;
    stopOnGrid: boolean;
    /** Present only when something is off-grid. */
    nearest?: { entry?: { below: number; above: number }; stop?: { below: number; above: number } };
  };
  bands: {
    checked: boolean;
    entryAboveAra?: boolean;
    stopBelowArb?: boolean;
  };
  checks: PositionSizeCheck[];
  warnings: string[];
  summary: string;
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new StockbitError("invalid_param", `${name} must be a positive number, got ${value}`);
  }
}

/**
 * Size a long position.
 *
 * @throws StockbitError on inputs that cannot mean anything — a non-positive price, a stop at or
 * above the entry, or a risk budget that is both specified and not specified.
 */
export function positionSize(input: PositionSizeInput): PositionSizeResult {
  requirePositive(input.entryPrice, "entry_price");
  requirePositive(input.stopPrice, "stop_price");

  if (input.stopPrice >= input.entryPrice) {
    throw new StockbitError(
      "invalid_param",
      `stop_price (${input.stopPrice}) must be BELOW entry_price (${input.entryPrice}). ` +
        "IDX retail has no short selling, so a stop above the entry is not a short — it is a typo.",
    );
  }

  // Exactly one of the two ways to say how much to risk. Accepting both would mean silently
  // preferring one, and the two answers differ by whatever the user got wrong.
  const hasDirect = input.riskIdr !== undefined;
  const hasPct = input.accountIdr !== undefined || input.riskPct !== undefined;
  if (hasDirect && hasPct) {
    throw new StockbitError(
      "invalid_param",
      "Give either risk_idr, or account_idr together with risk_pct — not both. They can disagree, " +
        "and there is no right way to choose between them for you.",
    );
  }
  if (!hasDirect && !hasPct) {
    throw new StockbitError(
      "invalid_param",
      "How much are you willing to lose? Pass risk_idr, or account_idr with risk_pct (e.g. " +
        "account_idr: 50000000, risk_pct: 1).",
    );
  }
  if (hasPct && (input.accountIdr === undefined || input.riskPct === undefined)) {
    throw new StockbitError(
      "invalid_param",
      "account_idr and risk_pct go together — one without the other cannot produce a rupiah figure.",
    );
  }

  let riskBudgetIdr: number;
  if (hasDirect) {
    requirePositive(input.riskIdr as number, "risk_idr");
    riskBudgetIdr = input.riskIdr as number;
  } else {
    requirePositive(input.accountIdr as number, "account_idr");
    requirePositive(input.riskPct as number, "risk_pct");
    riskBudgetIdr = ((input.accountIdr as number) * (input.riskPct as number)) / 100;
  }

  const feeSupplied = input.feeBuyPct !== undefined || input.feeSellPct !== undefined;
  const feeBuyPct = input.feeBuyPct ?? DEFAULT_FEE_PCT.buy;
  const feeSellPct = input.feeSellPct ?? DEFAULT_FEE_PCT.sell;

  const riskPerShareIdr = input.entryPrice - input.stopPrice;
  const riskPerLotIdr = riskPerShareIdr * SHARES_PER_LOT;

  const checks: PositionSizeCheck[] = [];
  const warnings: string[] = [];

  // Whole lots, always down. Rounding up would put more at risk than the number the user gave, and
  // the number the user gave is the entire point of the exercise.
  let lots = Math.floor(riskBudgetIdr / riskPerLotIdr);
  if (input.maxLots !== undefined) {
    requirePositive(input.maxLots, "max_lots");
    const cap = Math.floor(input.maxLots);
    if (lots > cap) {
      warnings.push(
        `Capped at ${cap} lots by max_lots; the risk budget alone would have allowed ${lots}.`,
      );
      lots = cap;
    }
  }

  if (lots === 0) {
    warnings.push(
      `Zero lots. One lot risks ${idr(riskPerLotIdr)}, which is more than the budget of ` +
        `${idr(riskBudgetIdr)}. Either widen the budget, or move the stop closer — but move it ` +
        "because the chart says so, not because the arithmetic came out inconvenient.",
    );
  }

  const shares = lots * SHARES_PER_LOT;
  const positionIdr = shares * input.entryPrice;
  const riskIdr = shares * riskPerShareIdr;
  const riskPctOfAccount =
    input.accountIdr !== undefined ? (riskIdr / input.accountIdr) * 100 : null;

  const buyFee = positionIdr * (feeBuyPct / 100);
  // The sell side is charged on the exit value; at break-even that is the entry value, which is the
  // right basis for the question "where do I get out flat".
  const sellFeeAtEntry = positionIdr * (feeSellPct / 100);
  const feesRoundTripIdr = buyFee + sellFeeAtEntry;

  // Solve exit * shares * (1 - sellPct) = entry * shares * (1 + buyPct).
  const breakEvenRaw =
    feeSellPct >= 100
      ? Number.POSITIVE_INFINITY
      : (input.entryPrice * (1 + feeBuyPct / 100)) / (1 - feeSellPct / 100);
  // Rounded UP: a break-even quoted below the true one is a loss the user was told was flat.
  const breakEvenPrice = Number.isFinite(breakEvenRaw) ? roundToTick(breakEvenRaw, "up") : breakEvenRaw;

  // Targets round up too — a target below the real one is a target you miss by a tick.
  const rTargets = {
    r1: roundToTick(input.entryPrice + riskPerShareIdr, "up"),
    r2: roundToTick(input.entryPrice + 2 * riskPerShareIdr, "up"),
    r3: roundToTick(input.entryPrice + 3 * riskPerShareIdr, "up"),
  };

  /* ---------------------------------- checks ---------------------------------- */

  const tick = tickSize(input.entryPrice);
  const entryOnGrid = onTickGrid(input.entryPrice);
  const stopOnGrid = onTickGrid(input.stopPrice);
  const nearest: PositionSizeResult["ticks"]["nearest"] = {};
  if (!entryOnGrid) nearest.entry = nearestTicks(input.entryPrice);
  if (!stopOnGrid) nearest.stop = nearestTicks(input.stopPrice);

  checks.push({
    name: "entry on the tick grid",
    ok: entryOnGrid,
    detail: entryOnGrid
      ? `${idr(input.entryPrice)} is a valid limit price (tick ${tick}).`
      : `${idr(input.entryPrice)} is not a valid limit price and would be REJECTED by the exchange. ` +
        `Nearest valid: ${idr(nearest.entry!.below)} or ${idr(nearest.entry!.above)}.`,
  });
  checks.push({
    name: "stop on the tick grid",
    ok: stopOnGrid,
    detail: stopOnGrid
      ? `${idr(input.stopPrice)} is a valid limit price (tick ${tickSize(input.stopPrice)}).`
      : `${idr(input.stopPrice)} is not a valid limit price and would be REJECTED by the exchange. ` +
        `Nearest valid: ${idr(nearest.stop!.below)} or ${idr(nearest.stop!.above)}.`,
  });

  const bands: PositionSizeResult["bands"] = { checked: input.ara !== undefined || input.arb !== undefined };
  if (input.ara !== undefined) {
    bands.entryAboveAra = input.entryPrice > input.ara;
    checks.push({
      name: "entry within today's ARA",
      ok: !bands.entryAboveAra,
      detail: bands.entryAboveAra
        ? `${idr(input.entryPrice)} is above today's ceiling of ${idr(input.ara)} and would be auto-rejected.`
        : `${idr(input.entryPrice)} is at or below today's ceiling of ${idr(input.ara)}.`,
    });
  }
  if (input.arb !== undefined) {
    bands.stopBelowArb = input.stopPrice < input.arb;
    checks.push({
      name: "stop within today's ARB",
      ok: !bands.stopBelowArb,
      detail: bands.stopBelowArb
        ? `${idr(input.stopPrice)} is below today's floor of ${idr(input.arb)}. A stop under the floor ` +
          "cannot fill today: if the stock locks on ARB there is nobody to sell to."
        : `${idr(input.stopPrice)} is at or above today's floor of ${idr(input.arb)}.`,
    });
    if (bands.stopBelowArb) {
      warnings.push(
        "The stop sits below today's auto-rejection floor. Being 'stopped out' at that price is not " +
          "something the exchange can do today.",
      );
    }
  }
  if (!bands.checked) {
    warnings.push("ARA/ARB not checked — pass `ara` and `arb` from `price_bands` to include them.");
  }

  if (!feeSupplied) {
    warnings.push(
      `Commission is the published retail rate (${DEFAULT_FEE_PCT.buy}% buy / ${DEFAULT_FEE_PCT.sell}% sell), ` +
        "not this account's. Pass fee_buy_pct and fee_sell_pct, or read them from `trading_info`.",
    );
  }

  const stopDistancePct = (riskPerShareIdr / input.entryPrice) * 100;
  if (stopDistancePct < 1) {
    warnings.push(
      `The stop is only ${stopDistancePct.toFixed(2)}% away. Inside normal intraday noise, a stop that ` +
        "tight is a fee schedule rather than a risk limit.",
    );
  }

  /* --------------------------------- summary --------------------------------- */

  const failed = checks.filter((c) => !c.ok);
  const summary =
    lots === 0
      ? `NO POSITION. One lot risks ${idr(riskPerLotIdr)} against a budget of ${idr(riskBudgetIdr)}.` +
        (failed.length ? ` Also: ${failed.map((c) => c.name).join(", ")} failed.` : "")
      : `${lots} lot${lots === 1 ? "" : "s"} (${shares.toLocaleString("en-US")} shares) at ` +
        `${idr(input.entryPrice)} = ${idr(positionIdr)}. Stop ${idr(input.stopPrice)} risks ` +
        `${idr(riskIdr)}` +
        (riskPctOfAccount === null ? "" : ` (${riskPctOfAccount.toFixed(2)}% of the account)`) +
        `, out of a budget of ${idr(riskBudgetIdr)}. Round-trip commission ${idr(feesRoundTripIdr)}; ` +
        `break-even ${idr(breakEvenPrice)}. Targets ${idr(rTargets.r1)} / ${idr(rTargets.r2)} / ` +
        `${idr(rTargets.r3)} at 1R / 2R / 3R.` +
        (failed.length
          ? ` BLOCKED: ${failed.map((c) => c.detail).join(" ")}`
          : "") +
        " This is arithmetic, not permission — `order_preview` checks buying power, tradability and " +
        "the caps before anything can be placed.";

  return {
    lots,
    shares,
    positionIdr,
    riskPerShareIdr,
    riskIdr,
    riskPctOfAccount,
    riskBudgetIdr,
    feesRoundTripIdr,
    feeSource: feeSupplied ? "supplied" : "default",
    breakEvenPrice,
    rTargets,
    ticks: {
      tick,
      entryOnGrid,
      stopOnGrid,
      ...(Object.keys(nearest).length ? { nearest } : {}),
    },
    bands,
    checks,
    warnings,
    summary,
  };
}
