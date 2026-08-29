// Isolate the token store before importing anything that reads it.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-core-"));

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { getBrokerSummary, clearCache } from "../src/core/index.ts";
import { brokerSummaryTtlFor } from "../src/core/marketdetectors.ts";
import { getBandarDetector } from "../src/core/brokers.ts";
import { extractBands } from "../src/core/pricefeed.ts";
import { CACHE } from "../src/config.ts";
import { StockbitError } from "../src/http/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "broker_summary_BBRI.json"), "utf8"),
);

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;

/**
 * Every URL the client actually requested.
 *
 * Asserting on the helper that *builds* params proves nothing about what production sends — a
 * mutation replacing the call site with the pre-feature inline object left the whole suite green.
 * These tests read the real query string instead.
 */
const seenUrls: string[] = [];

/** The market-data URL from the most recent call (the token refresh is filtered out). */
function lastMarketUrl(): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes("/marketdetectors/"));
  assert.ok(found, "no /marketdetectors request was made");
  return new URL(found);
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes("/login/refresh")) {
      return new Response(JSON.stringify({ data: { access_token: farFutureJwt() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/marketdetectors/BBRI")) {
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/marketdetectors/DRIFT")) {
      // Valid envelope but missing broker_summary → must trip schema_drift.
      return new Response(JSON.stringify({ data: { unexpected: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

test("getBrokerSummary normalizes the real BBRI fixture (XL & XC are net sellers)", async () => {
  const s = await getBrokerSummary({ symbol: "BBRI", limit: 50 });
  assert.equal(s.symbol, "BBRI");
  assert.ok(s.sellers.length > 0 && s.buyers.length > 0);

  const codes = new Map(s.sellers.map((b) => [b.code, b]));
  assert.ok(codes.has("XL"), "XL present on sell side");
  assert.ok(codes.has("XC"), "XC present on sell side");
  // Sells are negative net value (IDR).
  assert.ok(codes.get("XL")!.netValueIdr < 0);
  assert.ok(codes.get("XC")!.netValueIdr < 0);
  // Foreign/local classification survives.
  assert.ok(["Asing", "Lokal", "Pemerintah"].includes(codes.get("XL")!.investorType ?? ""));
});

/* ------------------------------------------------------------------ *
 * The bandar reading, against the CAPTURED fixture rather than a hand-made one.
 *
 * These numbers were wrong in shipped code for as long as the only bandar tests ran on a synthetic
 * fixture with POSITIVE sell values. The suite was green because the fixture agreed with the code;
 * both disagreed with the response committed three directories away. Every assertion here is a
 * quantity computed from that real response.
 * ------------------------------------------------------------------ */

test("bandar: the real fixture nets ~5.68e9, not the ~5.89e11 the sign bug produced", async () => {
  clearCache();
  const reading = await getBandarDetector({ symbol: "BBRI", limit: 50 });

  assert.equal(reading.buyValueIdr, 297_122_545_000);
  assert.equal(reading.sellValueIdr, -291_438_712_000, "the wire signs the sell side negative");

  // buy - |sell|. The old `buy - sell` turned (+) - (-) into the SUM of both sides: 5.8856e11.
  assert.equal(reading.netValueIdr, 5_683_833_000);
  assert.ok(
    Math.abs(reading.netValueIdr) < reading.buyValueIdr,
    "the net must be small beside either side's total, never their sum",
  );

  assert.equal(reading.buyLots, 983_225);
  assert.equal(reading.sellLots, -964_535);
  assert.equal(reading.netLots, 18_690); // was 1,947,760 — the same 104x error in lots
});

test("bandar: topDistributors really is largest-seller-first on the real fixture", async () => {
  clearCache();
  const reading = await getBandarDetector({ symbol: "BBRI", limit: 50, top: 5 });

  // Descending over negative numbers put the SMALLEST seller first, so this list used to read
  // BQ, KI, HP, XA, DX — the five smallest — under the label "Largest net sellers first".
  assert.deepEqual(
    reading.topDistributors.map((b) => b.code),
    ["SQ", "XL", "CC", "OD", "DH"],
  );
  assert.equal(reading.topDistributors[0].netValueIdr, -75_689_625_000);
  assert.deepEqual(
    reading.topAccumulators.map((b) => b.code),
    ["YU", "ZP", "AK", "BB", "RX"],
  );

  // Ranked by size of flow, so each side is monotonically non-increasing in magnitude.
  for (const side of [reading.topDistributors, reading.topAccumulators]) {
    for (let i = 1; i < side.length; i++) {
      assert.ok(
        Math.abs(side[i].netValueIdr!) <= Math.abs(side[i - 1].netValueIdr!),
        "a ranked list must not step back up",
      );
    }
  }
});

test("bandar: sell-side concentration is a number on real data, not a permanent null", async () => {
  clearCache();
  const reading = await getBandarDetector({ symbol: "BBRI", limit: 50 });
  const c = reading.concentration;

  // All three were null on every real call, because the denominator was negative. The tool
  // description tells the model a null share means nothing traded on that side.
  assert.ok(c.topSellerShare !== null && Math.abs(c.topSellerShare - 0.2597) < 1e-4);
  assert.ok(c.top3SellerShare !== null && Math.abs(c.top3SellerShare - 0.4876) < 1e-4);
  assert.ok(c.sellHerfindahl !== null && Math.abs(c.sellHerfindahl - 0.1138) < 1e-4);
  assert.ok(c.topBuyerShare !== null && Math.abs(c.topBuyerShare - 0.3421) < 1e-4);

  for (const share of [c.topSellerShare, c.top3SellerShare, c.topBuyerShare, c.top3BuyerShare]) {
    assert.ok(share !== null && share > 0 && share <= 1, "a share is a fraction of one side");
  }
  assert.ok(c.top3SellerShare! >= c.topSellerShare!, "top-3 cannot be smaller than top-1");

  assert.equal(c.buyersListed, 16);
  assert.equal(c.sellersListed, 25);
  assert.equal(reading.unreadable, undefined, "every figure in the captured response parses");
});

test("bandar: the reading agrees with the RAW fixture, recomputed independently", async () => {
  // Deliberately computed from the parsed JSON rather than from `getBrokerSummary`, and without
  // reusing any helper the implementation uses. An assertion written as
  // `netValueIdr === buyValueIdr - Math.abs(sellValueIdr)` restates the line it is checking and
  // cannot fail; this recomputes the quantities from the bytes on disk.
  clearCache();
  const reading = await getBandarDetector({ symbol: "BBRI", limit: 50 });
  const rows = fixture.data.broker_summary as {
    brokers_buy: Array<Record<string, string>>;
    brokers_sell: Array<Record<string, string>>;
  };

  let expectedBuy = 0;
  for (const r of rows.brokers_buy) expectedBuy += Number(r.bval);
  let expectedSell = 0;
  for (const r of rows.brokers_sell) expectedSell += Number(r.sval);

  assert.equal(reading.buyValueIdr, expectedBuy);
  assert.equal(reading.sellValueIdr, expectedSell);
  assert.ok(expectedSell < 0, "the fixture's sell side is negative — that is the whole point");
  assert.equal(reading.netValueIdr, expectedBuy + expectedSell, "buy minus the sell side's size");

  // And the ordering, straight off the raw rows.
  const biggestSeller = [...rows.brokers_sell].sort(
    (a, b) => Math.abs(Number(b.sval)) - Math.abs(Number(a.sval)),
  )[0];
  assert.equal(reading.topDistributors[0].code, biggestSeller.netbs_broker_code);
});

test("schema drift throws a typed StockbitError", async () => {
  clearCache();
  await assert.rejects(
    () => getBrokerSummary({ symbol: "DRIFT" }),
    (err: unknown) => err instanceof StockbitError && err.kind === "schema_drift",
  );
});

/* ------------------------------------------------------------------ *
 * Wire-level guards for the date range.
 *
 * These assert what production actually requests. The pure-helper tests in dates.test.ts cannot
 * do that: a mutation replacing `paramsFor(opts, range)` in getBrokerSummary with the pre-feature
 * inline object (period, no dates) left the entire suite green while silently returning the latest
 * session for every ranged query — the exact failure the feature exists to prevent.
 * ------------------------------------------------------------------ */

test("WIRE: a ranged request sends from/to and NO period", async () => {
  clearCache();
  seenUrls.length = 0;
  await getBrokerSummary({ symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" });
  const q = lastMarketUrl().searchParams;
  assert.equal(q.get("from"), "2026-07-28");
  assert.equal(q.get("to"), "2026-08-01");
  assert.equal(
    q.has("period"),
    false,
    "`period` on the wire makes the API ignore the dates and return the latest session with HTTP 200",
  );
});

test("WIRE: aliases are translated to from/to and never sent themselves", async () => {
  for (const input of [
    { date_from: "2026-07-28", date_to: "2026-08-01" },
    { start_date: "2026-07-28", end_date: "2026-08-01" },
    { from: "2026-07-28", end_date: "2026-08-01" },
  ]) {
    clearCache();
    seenUrls.length = 0;
    await getBrokerSummary({ symbol: "BBRI", ...input });
    const q = lastMarketUrl().searchParams;
    assert.equal(q.get("from"), "2026-07-28", `from missing for ${JSON.stringify(input)}`);
    assert.equal(q.get("to"), "2026-08-01", `to missing for ${JSON.stringify(input)}`);
    assert.equal(q.has("period"), false, `period leaked for ${JSON.stringify(input)}`);
    for (const dead of ["date_from", "date_to", "start_date", "end_date"]) {
      assert.equal(q.has(dead), false, `${dead} reached the wire — the API ignores it`);
    }
  }
});

test("WIRE: a single past day is sent as from=to", async () => {
  clearCache();
  seenUrls.length = 0;
  await getBrokerSummary({ symbol: "BBRI", from: "2026-07-30", to: "2026-07-30" });
  const q = lastMarketUrl().searchParams;
  assert.equal(q.get("from"), "2026-07-30");
  assert.equal(q.get("to"), "2026-07-30");
  assert.equal(q.has("period"), false);
});

test("WIRE: with no dates the request is byte-identical to the pre-feature behaviour", async () => {
  clearCache();
  seenUrls.length = 0;
  await getBrokerSummary({ symbol: "BBRI" });
  const q = lastMarketUrl().searchParams;
  assert.equal(q.get("period"), "BROKER_SUMMARY_PERIOD_LATEST");
  assert.equal(q.has("from"), false);
  assert.equal(q.has("to"), false);
  assert.equal(q.get("transaction_type"), "TRANSACTION_TYPE_NET");
  assert.equal(q.get("market_board"), "MARKET_BOARD_REGULER");
  assert.equal(q.get("investor_type"), "INVESTOR_TYPE_ALL");
  assert.equal(q.get("limit"), "50");
});

test("WIRE: an invalid range never reaches the network", async () => {
  for (const bad of [
    { from: "2026-07-28" },
    { from: "2026-08-01", to: "2026-07-28" },
    { from: "20260728", to: "20260801" },
    { from: "2026-02-30", to: "2026-08-01" },
    { from: "2026-07-28", start_date: "2026-07-01", to: "2026-08-01" },
  ]) {
    clearCache();
    seenUrls.length = 0;
    await assert.rejects(
      () => getBrokerSummary({ symbol: "BBRI", ...bad }),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      `should reject ${JSON.stringify(bad)}`,
    );
    assert.equal(
      seenUrls.some((u) => u.includes("/marketdetectors/")),
      false,
      `a request went out for invalid input ${JSON.stringify(bad)}`,
    );
  }
});

test("TTL: a settled range caches long, a live range and no-range do not", () => {
  const now = new Date("2026-08-03T09:00:00Z");
  const settled = brokerSummaryTtlFor({ symbol: "BBRI", from: "2026-07-01", to: "2026-08-02" }, now);
  const live = brokerSummaryTtlFor({ symbol: "BBRI", from: "2026-07-01", to: "2026-08-03" }, now);
  const none = brokerSummaryTtlFor({ symbol: "BBRI" }, now);

  assert.equal(settled, CACHE.brokerSummarySettledTtlMs);
  assert.equal(live, CACHE.brokerSummaryTtlMs);
  assert.equal(none, CACHE.brokerSummaryTtlMs);
  assert.ok(
    settled > live,
    "a closed window must cache longer than one still being written to by the running session",
  );
});

/* ------------------------- auto-rejection bands & foreign flow ------------------------- */

test("bands are extracted from the orderbook payload we already fetched", () => {
  // No new request and no new route — these fields arrive inside the ~19KB depth payload and were
  // simply never surfaced. Reaching them meant knowing they existed and parsing the blob by hand.
  const bands = extractBands("BBRI", {
    ara: 5200,
    arb: 4400,
    next_ara: "5320",
    next_arb: { raw: 4510 },
    fbuy: "1,250,000",
    fsell: 900_000,
    fnet: 350_000,
  });

  assert.equal(bands.ara, 5200);
  assert.equal(bands.arb, 4400);
  assert.equal(bands.nextAra, 5320, "a numeric string parses");
  assert.equal(bands.nextArb, 4510, "so does a {raw} wrapper");
  assert.equal(bands.foreignBuy, 1_250_000, "and thousands separators are stripped");
  assert.equal(bands.foreignNet, 350_000);
  assert.deepEqual(bands.missing, []);
  assert.equal(bands.found.length, 7);
});

test("a missing band is null and NAMED, never zero", () => {
  // Zero is a real value for foreign net flow. Defaulting a missing field to it would make "no
  // foreign participation today" indistinguishable from "this field was not in the payload".
  const bands = extractBands("BBRI", { ara: 5200, fnet: 0 });

  assert.equal(bands.ara, 5200);
  assert.equal(bands.foreignNet, 0, "an explicit zero survives as zero");
  assert.equal(bands.arb, null);
  assert.ok(bands.missing.includes("arb"));
  assert.ok(bands.found.includes("fnet"));
  assert.ok(!bands.found.includes("arb"));
});

test("an empty string is null, not the zero Number('') would give", () => {
  const bands = extractBands("BBRI", { ara: "", arb: "   ", fnet: "abc" });
  assert.equal(bands.ara, null);
  assert.equal(bands.arb, null);
  assert.equal(bands.foreignNet, null);
  assert.equal(bands.missing.length, 7);
});

test("a payload of the wrong shape yields nulls rather than throwing", () => {
  for (const payload of [null, undefined, "nonsense", 42, []]) {
    const bands = extractBands("BBRI", payload);
    assert.equal(bands.symbol, "BBRI");
    assert.equal(bands.ara, null);
    assert.equal(bands.found.length, 0);
  }
});
