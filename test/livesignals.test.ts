/**
 * The signal layer: parsing, detection, and the machinery that decides who gets woken up.
 *
 * Fixtures are taken from a real BRMS response (2026-08-28) rather than invented, because the two
 * unit traps this file guards against are only visible against real numbers — a ladder that sums to
 * a field labelled "lot" but holding shares, and a `bid_percent` that reads balanced while the top
 * of book is nine-to-one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderBook, depth, toLots, SHARES_PER_LOT } from "../src/live/orderbook.ts";
import {
  valueSurge,
  bandApproach,
  bookImbalance,
  wallChange,
  awakening,
  umaFlag,
  floorLocked,
  topFiveBidPercent,
  depthToBand,
  DEFAULTS,
} from "../src/live/signals.ts";
import { AlertEngine, isQuietPeriod, wibParts, FATIGUE_DEFAULTS } from "../src/live/alertengine.ts";
import { compilePrompt, parseMoney } from "../src/live/promptspec.ts";
import { parsePrint, parseTape, attribute } from "../src/live/attribution.ts";
import { readBandar } from "../src/live/bandar.ts";
import type { TradeDelta } from "../src/live/tape.ts";

/* ------------------------------- fixtures ------------------------------- */

const lvl = (price: number, volume: number, que = 10) => ({
  price: String(price),
  volume: String(volume),
  que_num: String(que),
  change_percentage: "",
});

/** BRMS at the close on 2026-08-28, trimmed but numerically faithful. */
const BRMS = {
  symbol: "BRMS",
  lastprice: 750,
  previous: 765,
  open: 780,
  high: 785,
  low: 745,
  average: 759,
  frequency: 19576,
  value: 192602886000,
  volume: 253908500,
  up: "265",
  down: "110",
  unchanged: "1118",
  fbuy: 34203585500,
  fsell: 88405151000,
  fnet: -54201565500,
  uma: false,
  notation: [],
  tradable: true,
  status: "Active",
  ara: { value: "935", visible: true },
  arb: { value: "640", visible: true },
  iepiev: { status: "STATUS_UNSPECIFIED", iep: { raw: 0 }, iev: { raw: 0 }, time_left_seconds: 0 },
  bid: [lvl(750, 882700), lvl(745, 10255500), lvl(740, 15081500), lvl(735, 8552000), lvl(730, 13647600), lvl(655, 11771600)],
  offer: [lvl(755, 2341700), lvl(760, 4304300), lvl(765, 7621900), lvl(770, 6028400), lvl(775, 8534600), lvl(955, 2544300)],
};

const delta = (over: Partial<TradeDelta> = {}): TradeDelta => ({
  symbol: "BRMS",
  value: 1_000_000_000,
  lots: 1000,
  trades: 10,
  averageTradeValue: 100_000_000,
  seconds: 30,
  confidence: "averaged",
  ...over,
});

/* ------------------------------ order book ------------------------------ */

test("the book parses, and lots are derived from shares not believed from a field name", () => {
  const b = parseOrderBook(BRMS);
  assert.ok(b);
  assert.equal(b.symbol, "BRMS");
  assert.equal(b.lastPrice, 750);
  assert.equal(b.ara, 935);
  assert.equal(b.arb, 640);
  assert.equal(SHARES_PER_LOT, 100);
  // 882,700 shares is 8,827 lots. Reading the ladder as lots would overstate depth 100x.
  assert.equal(toLots(882700), 8827);
});

test("reachesBand records that the ladder stops short of ARB but passes ARA", () => {
  const b = parseOrderBook(BRMS)!;
  // Offer runs to 955, past ARA 935. Bid stops at 655, above ARB 640.
  assert.equal(b.reachesBand.ara, true);
  assert.equal(b.reachesBand.arb, false);
});

test("a regular stock is not mistaken for a call auction just because iepiev exists", () => {
  // The key is present on every symbol, filled with zeroes. Presence proves nothing.
  const b = parseOrderBook(BRMS)!;
  assert.equal(b.isCallAuction, false);
  assert.equal(b.indicative, null);

  const fca = parseOrderBook({ ...BRMS, iepiev: { status: "STATUS_PRE_OPENING", iep: { raw: 800 }, iev: { raw: 5000 }, time_left_seconds: 120 } })!;
  assert.equal(fca.isCallAuction, true);
  assert.equal(fca.indicative?.price, 800);
});

test("an unreadable payload returns null rather than an empty book", () => {
  // An empty book would read as "no depth", which is a real and very different market state.
  assert.equal(parseOrderBook(null), null);
  assert.equal(parseOrderBook({ symbol: "BRMS" }), null);
});

/* ------------------------------- #1 surge ------------------------------- */

test("value surge needs BOTH concentration and rate", () => {
  const session = { sessionValue: 192_602_886_000, sessionFrequency: 19576, elapsedSeconds: 6 * 3600 };
  // Session mean print ~Rp 9.8m. A window of 3 prints at Rp 500m each is 51x concentrated.
  const hot = valueSurge({ delta: delta({ value: 1_500_000_000, trades: 3 }), ...session });
  assert.ok(hot, "should fire on concentrated value");
  assert.equal(hot.kind, "value-surge");

  // Same money, spread over 400 prints: high rate, ordinary concentration. Must not fire.
  const churn = valueSurge({ delta: delta({ value: 1_500_000_000, trades: 400 }), ...session });
  assert.equal(churn, null);
});

test("the warm-up gate keeps a barely-traded symbol quiet", () => {
  const r = valueSurge({
    delta: delta({ value: 5_000_000_000, trades: 3 }),
    sessionValue: 5_000_000_000,
    sessionFrequency: 12, // below minSessionTrades
    elapsedSeconds: 3600,
  });
  assert.equal(r, null);
});

test("a single print is described as a trade; an averaged window is not", () => {
  const session = { sessionValue: 192_602_886_000, sessionFrequency: 19576, elapsedSeconds: 6 * 3600 };
  const one = valueSurge({ delta: delta({ value: 2_000_000_000, trades: 3, confidence: "few" }), ...session })!;
  assert.match(one.detail.join(" "), /at least one was large/);

  const many = valueSurge({ delta: delta({ value: 9_000_000_000, trades: 300, confidence: "averaged" }), ...session });
  // 300 prints of Rp30m each is only ~3x concentrated — below the gate, so it should not fire at all.
  assert.equal(many, null);
});

test("surprise is the binding constraint, never the flattering one", () => {
  // Session mean print Rp 10m. Window: Rp 2bn over 4 prints = Rp 500m mean, so CONC = 50 (10x its
  // gate of 5). Expected window value = 100bn x 30/7200 = Rp 416.7m, so RATE = 4.8 (1.6x its gate
  // of 3). The rank must follow the WEAKER of the two, or a signal that scraped past one gate would
  // outrank one that cleared both.
  const session = { sessionValue: 100_000_000_000, sessionFrequency: 10_000, elapsedSeconds: 7200 };
  const s = valueSurge({ delta: delta({ value: 2_000_000_000, trades: 4, seconds: 30 }), ...session })!;
  assert.ok(s, "should fire — both gates are cleared");
  assert.ok(Math.abs(s.surprise - 1.6) < 0.05, `expected ~1.6 (the RATE ratio), got ${s.surprise}`);
});

/* ------------------------------ #2 band ------------------------------ */

test("depth to the band is summed from real levels, and says when it is a lower bound", () => {
  const b = parseOrderBook(BRMS)!;
  const up = depthToBand(b, "ara")!;
  assert.equal(up.complete, true);
  assert.ok(up.shares > 0);

  const down = depthToBand(b, "arb")!;
  assert.equal(down.complete, false, "bid ladder stops above ARB");
});

test("a truncated ladder is reported as a lower bound, not as the whole story", () => {
  const b = parseOrderBook({ ...BRMS, lastprice: 700, previous: 765 })!; // falling -> ARB side
  const s = bandApproach({ book: b, recentVolumeShares: 100_000_000, windowSeconds: 300 });
  if (s) assert.match(s.detail.join(" "), /LOWER BOUND/);
});

test("band approach stays quiet when there is plenty of supply left", () => {
  const b = parseOrderBook(BRMS)!;
  const s = bandApproach({ book: b, recentVolumeShares: 1000, windowSeconds: 300 });
  assert.equal(s, null);
});

/* ---------------------------- #3 imbalance ---------------------------- */

test("top-5 imbalance is computed here, not taken from the API's bid_percent", () => {
  const b = parseOrderBook(BRMS)!;
  const pct = topFiveBidPercent(b)!;
  const bidTop5 = depth(b.bid, 5);
  const offerTop5 = depth(b.offer, 5);
  assert.equal(Math.round(pct), Math.round((bidTop5 / (bidTop5 + offerTop5)) * 100));
});

test("one poll never fires an imbalance — it must hold across two", () => {
  const heavy = parseOrderBook({ ...BRMS, offer: [lvl(755, 10)], bid: [lvl(750, 10_000_000)] })!;
  assert.equal(bookImbalance({ book: heavy, previousPercent: null }), null, "first poll has no history");
  const s = bookImbalance({ book: heavy, previousPercent: 99 });
  assert.ok(s);
  assert.match(s.detail.join(" "), /intention, not a transaction/);
});

/* ------------------------------ #6 walls ------------------------------ */

test("depth withdrawn is only interesting when trading cannot explain it", () => {
  const before = parseOrderBook(BRMS)!;
  const after = parseOrderBook({ ...BRMS, bid: [lvl(750, 882700), lvl(745, 100_000), lvl(740, 15081500), lvl(735, 8552000), lvl(730, 13647600), lvl(655, 11771600)] })!;

  // Almost nothing traded, so a 10.1m-share level vanishing is withdrawal.
  const withdrawn = wallChange({ book: after, previous: before, tradedShares: 50_000 });
  assert.ok(withdrawn);
  assert.match(withdrawn.headline, /withdrawn/);

  // If the trading explains it, it is consumption and not this signal.
  const eaten = wallChange({ book: after, previous: before, tradedShares: 50_000_000 });
  assert.equal(eaten, null);
});

test("withdrawal is never described as spoofing", () => {
  const before = parseOrderBook(BRMS)!;
  const after = parseOrderBook({ ...BRMS, bid: [lvl(750, 882700), lvl(745, 1000), lvl(740, 15081500), lvl(735, 8552000), lvl(730, 13647600), lvl(655, 11771600)] })!;
  const s = wallChange({ book: after, previous: before, tradedShares: 1000 })!;
  const text = (s.headline + " " + s.detail.join(" ")).toLowerCase();
  assert.ok(!text.includes("spoof"), "must not allege intent");
  assert.match(text, /not a claim about anyone's intent/);
});

test("a wall appearing is detected too, not only one leaving", () => {
  const before = parseOrderBook({ ...BRMS, offer: [lvl(755, 1_000_000)] })!;
  const after = parseOrderBook({ ...BRMS, offer: [lvl(755, 20_000_000)] })!;
  const s = wallChange({ book: after, previous: before, tradedShares: 100_000 })!;
  assert.match(s.headline, /wall appeared/);
});

/* --------------------------- #7 / #11 / #12 --------------------------- */

test("awakening compares today against the whole previous session", () => {
  const s = awakening({ symbol: "BIPI", todayValue: 67_200_000_000, previousSessionValue: 22_100_000_000 })!;
  assert.match(s.headline, /3\.0x/);
  assert.equal(awakening({ symbol: "BIPI", todayValue: 22_000_000_000, previousSessionValue: 22_100_000_000 }), null);
});

test("a UMA flag never implies wrongdoing", () => {
  assert.equal(umaFlag(parseOrderBook(BRMS)!), null, "unflagged stock stays silent");
  const s = umaFlag(parseOrderBook({ ...BRMS, uma: true })!)!;
  assert.match(s.detail.join(" "), /not a sanction and not a finding of manipulation/);
});

test("floor-locked fires only when price is at ARB with a thin bid", () => {
  assert.equal(floorLocked(parseOrderBook(BRMS)!), null, "price is nowhere near ARB");

  const locked = parseOrderBook({ ...BRMS, lastprice: 640, bid: [], offer: [lvl(640, 33_649_500)] })!;
  const s = floorLocked(locked)!;
  assert.equal(s.severity, "critical");
  assert.match(s.detail.join(" "), /cannot be exited/);
});

/* ---------------------------- alert engine ---------------------------- */

const sig = (over: Partial<import("../src/live/signals.ts").Signal> = {}) => ({
  kind: "value-surge" as const,
  symbol: "AAAA",
  severity: "alert" as const,
  surprise: 2,
  headline: "h",
  detail: [],
  priceBucket: 1,
  at: 0,
  ...over,
});

const OPEN = new Date("2026-08-27T03:00:00Z"); // 10:00 WIB Thursday — trading, not a quiet period

test("the interval cap is hard, and ranking happens before it", () => {
  const e = new AlertEngine();
  const many = Array.from({ length: 12 }, (_, i) =>
    sig({ symbol: `S${i}`, surprise: i + 1, severity: i === 11 ? "critical" : "alert" }),
  );
  const r = e.process(many, OPEN, 100);
  assert.equal(r.emitted.length, FATIGUE_DEFAULTS.maxPerInterval);
  // The critical one must survive the cap.
  assert.equal(r.emitted[0].severity, "critical");
  assert.equal(r.suppressed.filter((s) => s.reason === "interval-cap").length, 7);
});

test("the session cap holds across intervals", () => {
  const e = new AlertEngine();
  for (let i = 0; i < 10; i++) {
    const batch = Array.from({ length: 5 }, (_, j) => sig({ symbol: `S${i}_${j}`, surprise: 5 }));
    e.process(batch, new Date(OPEN.getTime() + i * 20 * 60_000), 100);
  }
  assert.equal(e.spent, FATIGUE_DEFAULTS.maxPerSession);
});

test("a repeat of the same condition is suppressed, but a 2x escalation gets through", () => {
  const e = new AlertEngine();
  assert.equal(e.process([sig({ surprise: 2 })], OPEN, 10).emitted.length, 1);

  const soon = new Date(OPEN.getTime() + 60_000);
  assert.equal(e.process([sig({ surprise: 2 })], soon, 10).emitted.length, 0, "duplicate");
  assert.equal(e.process([sig({ surprise: 5 })], soon, 10).emitted.length, 1, "escalated past 2x");
});

test("market-wide moves emit one line instead of burning the budget", () => {
  const e = new AlertEngine();
  const all = Array.from({ length: 60 }, (_, i) => sig({ symbol: `S${i}` }));
  const r = e.process(all, OPEN, 100);
  assert.ok(r.marketWide);
  assert.equal(r.emitted.length, 0);
  assert.match(r.marketWide.note, /that is the market, not a stock/);
});

test("quiet periods differ on Friday, and only CRITICAL gets through", () => {
  // 2026-08-27 is a Thursday, 2026-08-28 a Friday.
  const thu1155 = new Date("2026-08-27T04:57:00Z"); // 11:57 WIB
  const fri1155 = new Date("2026-08-28T04:57:00Z");
  assert.equal(wibParts(thu1155).weekday, 4);
  assert.equal(wibParts(fri1155).weekday, 5);

  // 11:55-12:00 is quiet Mon-Thu, but Friday's session already ended at 11:30.
  assert.equal(isQuietPeriod(thu1155), true);
  assert.equal(isQuietPeriod(fri1155), false);

  const e = new AlertEngine();
  assert.equal(e.process([sig({ severity: "alert" })], thu1155, 10).emitted.length, 0);
  assert.equal(e.process([sig({ severity: "critical" })], thu1155, 10).emitted.length, 1);
});

test("a symbol that keeps firing gets its thresholds widened", () => {
  const e = new AlertEngine();
  assert.equal(e.widenFactor("AAAA"), 1);
  for (let i = 0; i < 7; i++) {
    e.process([sig({ symbol: "AAAA", kind: "awakening", priceBucket: i, surprise: 9 })], new Date(OPEN.getTime() + i * 20 * 60_000), 10);
  }
  assert.equal(e.widenFactor("AAAA"), FATIGUE_DEFAULTS.adaptiveWidenBy);
});

/* --------------------------- prompt compiler --------------------------- */

test("Indonesian and English prompts compile to the same intent", () => {
  const id = compilePrompt("kasih tau kalau ada transaksi besar");
  const en = compilePrompt("tell me about big transactions");
  assert.ok(id.kinds.includes("value-surge"));
  assert.ok(en.kinds.includes("value-surge"));
});

test("a bandar request is honestly downgraded, never silently dropped", () => {
  const s = compilePrompt("pantau akumulasi bandar");
  assert.ok(s.downgrades.length > 0);
  assert.match(s.downgrades.join(" "), /6 December 2021/);
});

test("asking about spoofing yields a wording downgrade, not a refusal", () => {
  const s = compilePrompt("watch for spoofing");
  assert.ok(s.kinds.includes("wall-change"));
  assert.match(s.downgrades.join(" "), /depth withdrawn/);
});

test("a money floor is understood in both languages", () => {
  assert.equal(parseMoney("1 miliar"), 1e9);
  assert.equal(parseMoney("300jt"), 3e8);
  assert.equal(parseMoney("2 billion"), 2e9);
  assert.equal(compilePrompt("abaikan yang di bawah 1 miliar").minValue, 1e9);
});

test("a bare 'M' is refused rather than guessed", () => {
  // Indonesian "M" is miliar (1e9); English "M" is million (1e6). Guessing is a 1000x error.
  assert.equal(parseMoney("5 M"), null);
});

test("an unrecognised prompt enables everything and says so", () => {
  const s = compilePrompt("please do something clever");
  assert.equal(s.kinds.length, 7);
  assert.match(s.interpretation.join(" "), /full picture rather than silence/);
});

test("wake-me-only raises the severity floor", () => {
  assert.equal(compilePrompt("bangunkan saya kalau ada yang besar sekali").severityFloor, "critical");
});

test("prompt words that look like tickers are not treated as tickers", () => {
  const s = compilePrompt("tell me when there is big buy");
  assert.ok(!s.symbols.includes("TELL"));
  assert.ok(!s.symbols.includes("WHEN"));
});

/* ---------------------------- tape attribution ---------------------------- */

const PRINT = {
  id: "4812262126",
  time: "08:58:00",
  action: "buy",
  code: "ZONE",
  price: "805",
  lot: "2",
  is_broker_exists: true,
  buyer: "KK [D]",
  seller: "XL [D]",
  buyer_type: "BROKER_TYPE_FOREIGN",
  seller_type: "BROKER_TYPE_LOCAL",
  market_board: "RG",
  buy_order_number: "27642",
  sell_order_number: "12532",
  value: { raw: 161000, formatted: "161.0K" },
};

test("a print parses with its aggressor side and both broker codes", () => {
  const p = parsePrint(PRINT)!;
  assert.equal(p.symbol, "ZONE");
  assert.equal(p.aggressor, "buy");
  assert.equal(p.buyer, "KK");
  assert.equal(p.seller, "XL");
  assert.equal(p.buyerForeign, true);
  assert.equal(p.sellerForeign, false);
  assert.equal(p.value, 161000);
});

test("a row with an unknown action is dropped rather than assumed to be a buy", () => {
  assert.equal(parsePrint({ ...PRINT, action: "" }), null);
  assert.equal(parsePrint({ ...PRINT, action: "cross" }), null);
});

test("broker identity absent is reported, not silently blanked", () => {
  const prints = parseTape({ data: { running_trade: [{ ...PRINT, is_broker_exists: false, buyer: "", seller: "" }] } });
  const a = attribute(prints, "ZONE");
  assert.equal(a.brokersVisible, false);
  assert.match(a.lines.join(" "), /Broker identity is withheld/);
});

test("attribution always declares itself lagged", () => {
  const a = attribute(parseTape({ data: { running_trade: [PRINT] } }), "ZONE");
  assert.equal(a.lagged, true);
  assert.match(a.lagNote, /8-10 minutes behind/);
});

test("HAKA and HAKI net out correctly", () => {
  const rows = [
    { ...PRINT, action: "buy", value: { raw: 1000 } },
    { ...PRINT, id: "2", action: "sell", value: { raw: 400 } },
  ];
  const a = attribute(parseTape({ data: { running_trade: rows } }), "ZONE");
  assert.equal(a.netAggressorValue, 600);
  assert.match(a.lines.join(" "), /buyer-initiated/);
});

test("a negotiated print is flagged as not price discovery", () => {
  const a = attribute(parseTape({ data: { running_trade: [{ ...PRINT, market_board: "TN" }] } }), "ZONE");
  assert.match(a.lines.join(" "), /negotiated, so not price discovery/);
});

/* ------------------------------- bandar ------------------------------- */

const BANDAR = {
  symbol: "BRMS",
  from: "2026-08-28",
  to: "2026-08-28",
  buyers: [
    { code: "XL", investorType: "Lokal", netLots: 49831, netValueIdr: 3838451000, avgPrice: 760, freq: 5456 },
    { code: "AO", investorType: "Lokal", netLots: 25735, netValueIdr: 1953033500, avgPrice: 758, freq: 75 },
  ],
  sellers: [{ code: "AK", investorType: "Asing", netLots: -451195, netValueIdr: -34260033000, avgPrice: 759, freq: 3670 }],
  bandarDetector: { top3: { accdist: "Big Dist", amount: -28509684000, percent: -38.6 } },
};

test("freq versus netLots separates retail flow from institutional flow", () => {
  const b = readBandar(BANDAR)!;
  const xl = b.buyers.find((x) => x.code === "XL")!;
  const ao = b.buyers.find((x) => x.code === "AO")!;
  assert.equal(Math.round(xl.lotsPerTrade!), 9);
  assert.equal(Math.round(ao.lotsPerTrade!), 343);
  assert.equal(xl.profile, "retail-like");
  assert.equal(ao.profile, "institution-like");
});

test("bandar context always declares itself end-of-day", () => {
  const b = readBandar(BANDAR)!;
  assert.equal(b.endOfDay, true);
  assert.match(b.lines.join(" "), /never a real-time signal/);
});

test("an empty broker read is explained rather than shown as no activity", () => {
  const b = readBandar({ symbol: "BRMS", buyers: [], sellers: [] })!;
  assert.equal(b.degraded, true);
  assert.match(b.degradedReason!, /end-of-day/);
});

test("a floor-locked day is marked as carrying no accumulation information", () => {
  const b = readBandar(BANDAR, true)!;
  assert.equal(b.degraded, true);
  assert.match(b.degradedReason!, /carry no information/);
});

test("foreign, local and government investor types are all recognised", () => {
  const b = readBandar({
    ...BANDAR,
    buyers: [
      { code: "CC", investorType: "Pemerintah", netLots: 1, netValueIdr: 1, avgPrice: 1, freq: 1 },
      { code: "DR", investorType: "Asing", netLots: 1, netValueIdr: 1, avgPrice: 1, freq: 1 },
    ],
  })!;
  assert.equal(b.buyers[0].investor, "government");
  assert.equal(b.buyers[1].investor, "foreign");
});
