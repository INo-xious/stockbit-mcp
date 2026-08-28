/**
 * Naming the prints behind a surge — the delayed half of the two-stage design.
 *
 * Detection happens on live aggregates (`signals.ts`). This runs afterwards, on the running-trade
 * tape, and says which actual transactions produced the number. The two are deliberately separate
 * because they have different freshness, and pretending otherwise is the failure this whole feature
 * set is built to avoid.
 *
 * ## The tape is late, and that is not fixable here
 *
 * Measured 2026-08-27: `/order-trade/running-trade` runs EIGHT TO TEN MINUTES BEHIND and refreshes in
 * bursts, with `cache-control: max-age=1` and a CloudFront MISS placing the staleness at Stockbit's
 * own origin. So an attribution produced now explains a surge from several minutes ago. Every result
 * carries `lagged: true` so a caller cannot present it as current without doing so knowingly.
 *
 * ## What a print actually carries, observed rather than assumed
 *
 * The row shape below was read off the live endpoint on 2026-08-28. It is richer than this project
 * believed: alongside time, price and lot, each row names the BROKER on both sides, marks each as
 * foreign or local, and carries per-order numbers.
 *
 * **That was observed on a CLOSED market.** IDX closed broker codes in live running trade on
 * 6 December 2021, so whether the identity survives during an open session is unverified. Hence
 * `brokersVisible` on the result — read the flag, do not assume the field.
 */
import { readRaw } from "./tape.js";

/** One matched transaction, as the tape reports it. */
export interface Print {
  id: string;
  /** `HH:MM:SS` in WIB, as given. Deliberately not parsed into a Date — the date is not in the row. */
  time: string;
  symbol: string;
  price: number;
  lots: number;
  /** Rupiah. Present on the row, so it is not recomputed from price x lot. */
  value: number;
  /**
   * Which side crossed the spread. `buy` means the buyer lifted the offer (HAKA), `sell` means the
   * seller hit the bid (HAKI).
   */
  aggressor: "buy" | "sell";
  /** Broker code, or null when the tape withholds identity. */
  buyer: string | null;
  seller: string | null;
  buyerForeign: boolean | null;
  sellerForeign: boolean | null;
  /** `RG` regular, `TN` negotiated, `NG` cash — a negotiated print is not price discovery. */
  board: string;
  buyOrderNumber: string | null;
  sellOrderNumber: string | null;
}

const brokerCode = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  // Rows arrive as "KK [D]" — the code, then a bracketed domestic/foreign marker.
  const code = v.trim().split(/\s+/)[0];
  return code ? code.toUpperCase() : null;
};

const isForeign = (v: unknown): boolean | null =>
  typeof v === "string" && v.startsWith("BROKER_TYPE_") ? v === "BROKER_TYPE_FOREIGN" : null;

/** Parse one tape row. Returns null for anything without a usable price and size. */
export function parsePrint(row: unknown): Print | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const symbol = typeof r.code === "string" ? r.code.trim().toUpperCase() : "";
  const price = readRaw(r.price);
  const lots = readRaw(r.lot);
  if (!symbol || price === null || lots === null) return null;

  const action = typeof r.action === "string" ? r.action.toLowerCase() : "";
  // Anything that is not explicitly a sell is treated as a buy only when it says so. An unknown
  // action must not silently become a buy — side is the whole point of a tape row.
  if (action !== "buy" && action !== "sell") return null;

  const hasBroker = r.is_broker_exists === true;

  return {
    id: String(r.id ?? ""),
    time: typeof r.time === "string" ? r.time : "",
    symbol,
    price,
    lots,
    value: readRaw(r.value) ?? price * lots * 100,
    aggressor: action,
    buyer: hasBroker ? brokerCode(r.buyer) : null,
    seller: hasBroker ? brokerCode(r.seller) : null,
    buyerForeign: hasBroker ? isForeign(r.buyer_type) : null,
    sellerForeign: hasBroker ? isForeign(r.seller_type) : null,
    board: typeof r.market_board === "string" ? r.market_board : "",
    buyOrderNumber: typeof r.buy_order_number === "string" ? r.buy_order_number : null,
    sellOrderNumber: typeof r.sell_order_number === "string" ? r.sell_order_number : null,
  };
}

/** Pull the row array out of the tape envelope. */
export function parseTape(payload: unknown): Print[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const inner = (d.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : d) as Record<string, unknown>;
  const rows = Array.isArray(inner.running_trade) ? inner.running_trade : Array.isArray(d) ? d : [];
  const out: Print[] = [];
  for (const row of rows) {
    const p = parsePrint(row);
    if (p) out.push(p);
  }
  return out;
}

export interface Attribution {
  symbol: string;
  /** Always true for this source. Kept explicit so a caller must handle it. */
  lagged: true;
  lagNote: string;
  /** Whether the tape gave broker identity on these rows. */
  brokersVisible: boolean;
  prints: Print[];
  totalValue: number;
  totalLots: number;
  /** Rupiah bought by the aggressor minus rupiah sold. */
  netAggressorValue: number;
  /** The largest prints, biggest first. */
  largest: Print[];
  /** Rupiah per broker on the buy side, biggest first. Empty when identity is withheld. */
  topBuyers: { broker: string; value: number; prints: number }[];
  topSellers: { broker: string; value: number; prints: number }[];
  lines: string[];
}

function rank(prints: Print[], side: "buyer" | "seller"): { broker: string; value: number; prints: number }[] {
  const acc = new Map<string, { value: number; prints: number }>();
  for (const p of prints) {
    const b = p[side];
    if (!b) continue;
    const cur = acc.get(b) ?? { value: 0, prints: 0 };
    cur.value += p.value;
    cur.prints += 1;
    acc.set(b, cur);
  }
  return [...acc.entries()]
    .map(([broker, v]) => ({ broker, ...v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

const rupiah = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `Rp ${(n / 1e9).toFixed(2)} bn`;
  if (abs >= 1e6) return `Rp ${(n / 1e6).toFixed(1)} jt`;
  return `Rp ${Math.round(n).toLocaleString("en-US")}`;
};

/**
 * Explain a window of trading from the tape.
 *
 * `from`/`to` are `HH:MM:SS` WIB strings compared lexically, which is correct for a zero-padded
 * 24-hour clock and avoids inventing a date the row does not carry.
 */
export function attribute(prints: Print[], symbol: string, from?: string, to?: string): Attribution {
  const want = symbol.trim().toUpperCase();
  const inWindow = prints.filter(
    (p) => p.symbol === want && (!from || p.time >= from) && (!to || p.time <= to),
  );

  const totalValue = inWindow.reduce((s, p) => s + p.value, 0);
  const totalLots = inWindow.reduce((s, p) => s + p.lots, 0);
  const net = inWindow.reduce((s, p) => s + (p.aggressor === "buy" ? p.value : -p.value), 0);
  const largest = [...inWindow].sort((a, b) => b.value - a.value).slice(0, 5);
  const brokersVisible = inWindow.some((p) => p.buyer !== null);

  const lines: string[] = [];
  if (inWindow.length === 0) {
    lines.push(`No prints for ${want} in that window on the tape yet — it runs 8-10 minutes behind.`);
  } else {
    lines.push(
      `${inWindow.length} print${inWindow.length === 1 ? "" : "s"}, ${totalLots.toLocaleString("en-US")} lots, ${rupiah(totalValue)}.`,
    );
    lines.push(
      net >= 0
        ? `Net ${rupiah(net)} was buyer-initiated (HAKA — buyers lifting the offer).`
        : `Net ${rupiah(-net)} was seller-initiated (HAKI — sellers hitting the bid).`,
    );
    const top = largest[0];
    if (top) {
      lines.push(
        `Largest single print: ${top.lots.toLocaleString("en-US")} lots at ${top.price} (${rupiah(top.value)}) at ${top.time}, ${top.aggressor === "buy" ? "buyer-initiated" : "seller-initiated"}${top.buyer && top.seller ? `, ${top.buyer} bought from ${top.seller}` : ""}.`,
      );
    }
    if (!brokersVisible) {
      lines.push("Broker identity is withheld on these rows — IDX closes broker codes during live trading.");
    }
    const negotiated = inWindow.filter((p) => p.board && p.board !== "RG");
    if (negotiated.length) {
      lines.push(
        `${negotiated.length} of these were on the ${[...new Set(negotiated.map((p) => p.board))].join("/")} board — negotiated, so not price discovery.`,
      );
    }
  }

  return {
    symbol: want,
    lagged: true,
    lagNote: "The running-trade tape runs 8-10 minutes behind the market. This explains a surge that has already happened.",
    brokersVisible,
    prints: inWindow,
    totalValue,
    totalLots,
    netAggressorValue: net,
    largest,
    topBuyers: rank(inWindow, "buyer"),
    topSellers: rank(inWindow, "seller"),
    lines,
  };
}
