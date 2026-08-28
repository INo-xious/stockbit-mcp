/**
 * Broker flow as CONTEXT, and never as an alert.
 *
 * That restriction is the whole design. IDX closed broker codes in live running trade on 6 December
 * 2021, so this data is end-of-day: asking for today while the session is open returns empty buyers,
 * empty sellers and an all-zero detector. Any feature that alerted on it would be firing on
 * yesterday's news while implying it was now.
 *
 * So this module answers "who was on each side, last time we could see" and labels it as such. It
 * returns no `Signal` and is deliberately not wired into the alert engine.
 *
 * ## The fingerprint worth having
 *
 * `freq` and `netLots` are both present per broker, and their RATIO separates retail flow from
 * institutional flow far more reliably than size alone. Measured on BRMS, 2026-08-28:
 *
 *   XL  49,831 lots over 5,456 trades =     9 lots/trade  — retail order flow
 *   AO  25,735 lots over    75 trades =   343 lots/trade  — institutional
 *
 * Same board, same day, a thirty-fold difference in how the lots arrived. A broker buying a lot in
 * many small pieces is a different fact about the market than one buying it in a few large ones.
 */
import { readRaw } from "./tape.js";

export type InvestorType = "foreign" | "local" | "government" | "unknown";

export interface BrokerFlow {
  code: string;
  investor: InvestorType;
  /** Positive for net buyers, negative for net sellers, in lots. */
  netLots: number;
  netValueIdr: number;
  avgPrice: number;
  /** Number of transactions this broker was party to. */
  freq: number;
  /** |netLots| / freq — the retail-versus-institutional fingerprint. Null when freq is zero. */
  lotsPerTrade: number | null;
  /** A reading of that ratio, with the boundary stated rather than implied. */
  profile: "retail-like" | "mixed" | "institution-like" | "unknown";
}

export interface BandarContext {
  symbol: string;
  /** The dates this covers, exactly as the API reported them. */
  from: string;
  to: string;
  /**
   * Always true. Broker identity is end-of-day, and a caller must not present this as live.
   */
  endOfDay: true;
  buyers: BrokerFlow[];
  sellers: BrokerFlow[];
  /** Stockbit's own accumulation/distribution labels, passed through untouched. */
  labels: { scope: string; label: string; amountIdr: number; percent: number }[];
  /** Set when the read cannot carry information — see `degradedReason`. */
  degraded: boolean;
  degradedReason: string | null;
  lines: string[];
}

/**
 * Where "many small trades" stops and "few large ones" begins.
 *
 * There is no published IDX convention for this, so the boundary is ours and is stated in the output
 * rather than hidden. 25 and 150 lots per trade bracket the measured gap comfortably: the retail-
 * shaped brokers on BRMS sat at 9-13 and the institution-shaped ones at 343.
 */
const RETAIL_MAX = 25;
const INSTITUTION_MIN = 150;

function investorOf(v: unknown): InvestorType {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s.startsWith("asing")) return "foreign";
  if (s.startsWith("lokal")) return "local";
  if (s.startsWith("pemerintah")) return "government";
  return "unknown";
}

function flow(row: unknown): BrokerFlow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const code = typeof r.code === "string" ? r.code.trim().toUpperCase() : "";
  if (!code) return null;

  const netLots = readRaw(r.netLots) ?? 0;
  const freq = readRaw(r.freq) ?? 0;
  const lotsPerTrade = freq > 0 ? Math.abs(netLots) / freq : null;

  return {
    code,
    investor: investorOf(r.investorType),
    netLots,
    netValueIdr: readRaw(r.netValueIdr) ?? 0,
    avgPrice: readRaw(r.avgPrice) ?? 0,
    freq,
    lotsPerTrade,
    profile:
      lotsPerTrade === null
        ? "unknown"
        : lotsPerTrade <= RETAIL_MAX
          ? "retail-like"
          : lotsPerTrade >= INSTITUTION_MIN
            ? "institution-like"
            : "mixed",
  };
}

const rupiah = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `Rp ${(n / 1e9).toFixed(2)} bn`;
  if (abs >= 1e6) return `Rp ${(n / 1e6).toFixed(1)} jt`;
  return `Rp ${Math.round(n).toLocaleString("en-US")}`;
};

/**
 * Read a `broker_summary` payload into context.
 *
 * @param floorLocked pass true when the symbol sat at ARB with an empty bid. Every broker then fills
 *   at one price, so accumulation-versus-distribution has no price discovery to infer intent from
 *   and the labels carry no information — a fact this reports rather than lets a reader assume away.
 */
export function readBandar(payload: unknown, floorLocked = false): BandarContext | null {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!d) return null;
  const data = (d.data && typeof d.data === "object" ? d.data : d) as Record<string, unknown>;

  const symbol = typeof data.symbol === "string" ? data.symbol.toUpperCase() : "";
  const buyers = (Array.isArray(data.buyers) ? data.buyers : []).map(flow).filter((b): b is BrokerFlow => b !== null);
  const sellers = (Array.isArray(data.sellers) ? data.sellers : []).map(flow).filter((b): b is BrokerFlow => b !== null);

  const det = (data.bandarDetector ?? {}) as Record<string, unknown>;
  const labels: BandarContext["labels"] = [];
  for (const scope of ["top1", "top3", "top5", "top10", "avg", "avg5"]) {
    const v = det[scope];
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      labels.push({
        scope,
        label: typeof o.accdist === "string" ? o.accdist : "",
        amountIdr: readRaw(o.amount) ?? 0,
        percent: readRaw(o.percent) ?? 0,
      });
    }
  }

  const empty = buyers.length === 0 && sellers.length === 0;
  const degraded = empty || floorLocked;
  const degradedReason = empty
    ? "No broker rows came back. During an open session that is the normal answer — broker identity is end-of-day."
    : floorLocked
      ? "The symbol was locked at its auto-reject floor, so every broker filled at one price. Accumulation and distribution labels carry no information in that state."
      : null;

  const lines: string[] = [];
  if (degradedReason) {
    lines.push(degradedReason);
  } else {
    const topBuy = buyers[0];
    const topSell = sellers[0];
    if (topBuy) {
      lines.push(
        `Biggest buyer ${topBuy.code} (${topBuy.investor}): ${topBuy.netLots.toLocaleString("en-US")} lots, ${rupiah(topBuy.netValueIdr)}, ${topBuy.freq.toLocaleString("en-US")} trades — ${topBuy.lotsPerTrade?.toFixed(0)} lots each, ${topBuy.profile}.`,
      );
    }
    if (topSell) {
      lines.push(
        `Biggest seller ${topSell.code} (${topSell.investor}): ${topSell.netLots.toLocaleString("en-US")} lots, ${rupiah(topSell.netValueIdr)}, ${topSell.freq.toLocaleString("en-US")} trades — ${topSell.lotsPerTrade?.toFixed(0)} lots each, ${topSell.profile}.`,
      );
    }
    const inst = buyers.filter((b) => b.profile === "institution-like");
    if (inst.length) {
      lines.push(
        `Institution-shaped buying (few, large trades): ${inst.slice(0, 3).map((b) => `${b.code} ${b.lotsPerTrade?.toFixed(0)} lots/trade`).join(", ")}.`,
      );
    }
    const t3 = labels.find((l) => l.scope === "top3");
    if (t3?.label) lines.push(`Stockbit's own top-3 reading: ${t3.label} (${t3.percent.toFixed(1)}%).`);
    lines.push(`Retail/institution split uses |netLots|/freq with our own boundaries: <=${RETAIL_MAX} retail-like, >=${INSTITUTION_MIN} institution-like. IDX publishes no convention for this.`);
  }
  lines.push("End-of-day data. Broker codes are closed during live trading, so this is never a real-time signal.");

  return {
    symbol,
    from: typeof data.from === "string" ? data.from : "",
    to: typeof data.to === "string" ? data.to : "",
    endOfDay: true,
    buyers,
    sellers,
    labels,
    degraded,
    degradedReason,
    lines,
  };
}
