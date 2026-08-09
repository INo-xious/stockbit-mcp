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
