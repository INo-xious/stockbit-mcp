// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-dist-"));

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/index.ts";
import {
  ENTITLEMENT_MESSAGE,
  REQUIRED_BALANCE_IDR,
  brokerDistributionTtlFor,
  buildDistributionParams,
  getBrokerDistribution,
} from "../src/core/brokerdistribution.ts";
import { StockbitError } from "../src/http/errors.ts";
import { CACHE } from "../src/config.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/** Shaped exactly like the live response, trimmed to two brokers a side. */
const FIXTURE = {
  message: "Successfully loaded Broker Distribution data",
  data: {
    date_info: "2026-08-01",
    start_date: "2026-07-28",
    end_date: "2026-08-01",
    by_value: {
      top_broker_buy: [
        {
          detail: { code: "AK", type: "Asing", amount: 445525972000 },
          distribute_to: [
            { code: "BK", type: "Asing", amount: 77101438000 },
            { code: "DX", type: "Pemerintah", amount: 55573481000 },
          ],
        },
      ],
      top_broker_sell: [
        { detail: { code: "BK", type: "Asing", amount: 432073013000 }, distribute_to: [] },
      ],
    },
    by_volume: { top_broker_buy: [], top_broker_sell: [] },
  },
};

const realFetch = globalThis.fetch;
/** How many distribution requests actually went out — lets a test prove a cache HIT or MISS. */
let distRequests = 0;
const seenUrls: string[] = [];
/** What the API should answer next; lets a test drive the 403 path. */
let nextStatus = 200;

function lastDistUrl(): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes("/order-trade/broker/distribution"));
  assert.ok(found, "no distribution request was made");
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
    if (u.includes("/order-trade/broker/distribution")) {
      distRequests++;
      if (nextStatus !== 200) {
        return new Response(JSON.stringify({ message: "Forbidden", error_type: "FORBIDDEN" }), {
          status: nextStatus,
          headers: { "content-type": "application/json" },
        });
      }
      // Echo the requested data_type into the amounts so two different queries are distinguishable.
      const wantsVolume = u.includes("DATA_TYPE_VOLUME");
      const body = JSON.parse(JSON.stringify(FIXTURE));
      if (wantsVolume) {
        body.data.by_volume = {
          top_broker_buy: [{ detail: { code: "AK", type: "Asing", amount: 1503094 }, distribute_to: [] }],
          top_broker_sell: [],
        };
      }
      return new Response(JSON.stringify(body), {
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

/* ------------------------------- request shape ------------------------------- */

test("period is the default window and from/to are absent", () => {
  const p = buildDistributionParams({ symbol: "BBRI" });
  assert.equal(p.period, "TB_PERIOD_LAST_1_DAY");
  assert.equal("from" in p, false);
  assert.equal("to" in p, false);
  assert.equal(p.data_type, "BROKER_DISTRIBUTION_DATA_TYPE_VALUE");
  assert.equal(p.investor_type, "INVESTOR_TYPE_ALL");
});

test("REGRESSION: a date range replaces period entirely — they are mutually exclusive", () => {
  for (const input of [
    { from: "2026-07-28", to: "2026-08-01" },
    { date_from: "2026-07-28", date_to: "2026-08-01" },
    { start_date: "2026-07-28", end_date: "2026-08-01" },
  ]) {
    const p = buildDistributionParams({ symbol: "BBRI", period: "LAST_1_YEAR", ...input });
    assert.equal(p.from, "2026-07-28");
    assert.equal(p.to, "2026-08-01");
    assert.equal("period" in p, false, `period leaked alongside a range for ${JSON.stringify(input)}`);
  }
});

test("REGRESSION: market_board is never sent — the endpoint 400s on it", () => {
  // broker_summary requires market_board; this endpoint rejects it. Measured, and easy to
  // "helpfully" re-add by copying the summary builder.
  for (const opts of [
    { symbol: "BBRI" },
    { symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" },
    { symbol: "BBRI", dataType: "VOLUME" as const, investorType: "FOREIGN" as const },
  ]) {
    assert.equal("market_board" in buildDistributionParams(opts), false);
  }
});

test("aliases never reach the wire", () => {
  const p = buildDistributionParams({ symbol: "BBRI", date_from: "2026-07-28", end_date: "2026-08-01" });
  for (const dead of ["date_from", "date_to", "start_date", "end_date"]) {
    assert.equal(dead in p, false, `${dead} must not be sent`);
  }
});

test("data_type and investor_type map onto the API's enum spelling", () => {
  const p = buildDistributionParams({ symbol: "bbri", dataType: "VOLUME", investorType: "DOMESTIC" });
  assert.equal(p.data_type, "BROKER_DISTRIBUTION_DATA_TYPE_VOLUME");
  assert.equal(p.investor_type, "INVESTOR_TYPE_DOMESTIC");
  assert.equal(p.symbol, "BBRI", "symbol should be normalized");
});

test("an invalid symbol or half-specified range is rejected before any request", () => {
  assert.throws(() => buildDistributionParams({ symbol: "../etc" }), /Invalid Symbol/);
  assert.throws(() => buildDistributionParams({ symbol: "BBRI", from: "2026-07-28" }), /needs both ends/);
  assert.throws(() => buildDistributionParams({ symbol: "BBRI", from: "20260728", to: "20260801" }), /YYYY-MM-DD/);
});

/* --------------------------------- wire + shape --------------------------------- */

test("WIRE: the request carries the expected query and no market_board", async () => {
  clearCache();
  seenUrls.length = 0;
  nextStatus = 200;
  await getBrokerDistribution({ symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" });
  const q = lastDistUrl().searchParams;
  assert.equal(q.get("symbol"), "BBRI");
  assert.equal(q.get("from"), "2026-07-28");
  assert.equal(q.get("to"), "2026-08-01");
  assert.equal(q.get("data_type"), "BROKER_DISTRIBUTION_DATA_TYPE_VALUE");
  assert.equal(q.has("period"), false);
  assert.equal(q.has("market_board"), false);
});

test("the response is normalized into brokers and their counterparties", async () => {
  clearCache();
  nextStatus = 200;
  const d = await getBrokerDistribution({ symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" });
  assert.equal(d.symbol, "BBRI");
  assert.equal(d.dataType, "VALUE");
  assert.equal(d.amountUnit, "IDR");
  assert.equal(d.from, "2026-07-28");
  assert.equal(d.to, "2026-08-01");
  assert.equal(d.asOf, "2026-08-01");

  assert.equal(d.topBuyers.length, 1);
  const ak = d.topBuyers[0];
  assert.equal(ak.code, "AK");
  assert.equal(ak.investorType, "Asing");
  assert.equal(ak.amount, 445525972000);
  assert.deepEqual(
    ak.distributedWith.map((c) => c.code),
    ["BK", "DX"],
  );
  assert.equal(ak.distributedWith[0].amount, 77101438000);

  assert.equal(d.topSellers.length, 1);
  assert.deepEqual(d.topSellers[0].distributedWith, []);
});

test("VOLUME selects the other block and reports the unit as LOTS, not shares", async () => {
  clearCache();
  nextStatus = 200;
  const d = await getBrokerDistribution({ symbol: "BBRI", dataType: "VOLUME" });
  // Verified arithmetically against live data: value/volume for BBRI/TLKM top brokers gives
  // ~296,000 and ~260,000, nonsense per share but correct per LOT (2,964 / 2,609 IDR).
  // Labelling this "shares" understates every quantity by 100x.
  assert.equal(d.amountUnit, "lots");
  // VOLUME must read by_volume, NOT by_value — the amounts differ by roughly the share price.
  assert.equal(d.topBuyers.length, 1);
  assert.equal(d.topBuyers[0].code, "AK");
  assert.equal(d.topBuyers[0].amount, 1503094, "should be the by_volume figure, not by_value");
  assert.notEqual(d.topBuyers[0].amount, 445525972000, "read the wrong block: that is the VALUE amount");
});

/* -------------------------------- entitlement -------------------------------- */

test("a 403 is reported as the balance requirement, not a bare auth error", async () => {
  // The account used for development is entitled, so this path cannot be exercised live. The
  // mapping is asserted here instead: HTTP 403 must surface the requirement, naming the amount.
  clearCache();
  nextStatus = 403;
  await assert.rejects(
    () => getBrokerDistribution({ symbol: "BBRI" }),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError);
      assert.equal(err.status, 403);
      assert.match(err.message, /Broker Distribution/);
      assert.match(err.message, /10,000,000/);
      return true;
    },
  );
  nextStatus = 200;
});

test("a 401 stays a genuine auth failure and is NOT blamed on the balance", async () => {
  clearCache();
  nextStatus = 401;
  await assert.rejects(
    () => getBrokerDistribution({ symbol: "BBRI" }),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError);
      assert.equal(
        /10,000,000/.test(err.message),
        false,
        "an expired token must not be reported as an insufficient balance",
      );
      return true;
    },
  );
  nextStatus = 200;
});

test("the entitlement message states the requirement in full", () => {
  assert.equal(REQUIRED_BALANCE_IDR, 10_000_000);
  assert.match(ENTITLEMENT_MESSAGE, /10,000,000/);
  assert.match(ENTITLEMENT_MESSAGE, /Broker Distribution/);
});

/* ------------------------- TTL + cache-key integrity ------------------------- */

test("TTL: a settled window caches long; a live window and a preset do not", () => {
  const now = new Date("2026-08-03T09:00:00Z");
  const settled = brokerDistributionTtlFor({ symbol: "BBRI", from: "2026-07-01", to: "2026-08-02" }, now);
  const live = brokerDistributionTtlFor({ symbol: "BBRI", from: "2026-07-01", to: "2026-08-03" }, now);
  const preset = brokerDistributionTtlFor({ symbol: "BBRI", period: "LAST_1_MONTH" }, now);

  assert.equal(settled, CACHE.brokerSummarySettledTtlMs);
  assert.equal(live, CACHE.brokerSummaryTtlMs);
  assert.equal(preset, CACHE.brokerSummaryTtlMs, "a preset window may include today, so it stays live");
  assert.ok(settled > live, "a closed window must cache longer than one still being written to");
});

test("CACHE: two different queries never share an entry", async () => {
  // Deliberately does NOT clear the cache between calls. If the key collapsed — a constant, or one
  // that omits data_type — the second call would be served the first call's data.
  clearCache();
  nextStatus = 200;

  const value = await getBrokerDistribution({ symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" });
  const volume = await getBrokerDistribution({
    symbol: "BBRI",
    from: "2026-07-28",
    to: "2026-08-01",
    dataType: "VOLUME",
  });

  assert.equal(value.amountUnit, "IDR");
  assert.equal(volume.amountUnit, "lots");
  assert.notEqual(
    value.topBuyers[0].amount,
    volume.topBuyers[0].amount,
    "VOLUME was served the VALUE cache entry — the cache key is not discriminating",
  );

  // A repeat of the first query must be a cache HIT, proving the key is stable as well as unique.
  const before = distRequests;
  await getBrokerDistribution({ symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" });
  assert.equal(distRequests, before, "an identical repeat query should hit the cache, not refetch");
});

/* --------------------------- 403 must not fabricate --------------------------- */

test("a 403 keeps the server's own message instead of destroying it", async () => {
  // The earlier version replaced the upstream error outright, so a Cloudflare block or a revoked
  // session told the user to deposit Rp 10,000,000 — a remedy that cannot fix either.
  clearCache();
  nextStatus = 403;
  await assert.rejects(
    () => getBrokerDistribution({ symbol: "BBRI" }),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError);
      assert.match(err.message, /Forbidden/, "the server's own message must survive");
      assert.match(err.message, /most likely cause/i, "the balance gate must be a hypothesis, not a verdict");
      assert.match(err.message, /10,000,000/);
      assert.equal(err.errorType, "FORBIDDEN", "upstream error_type must be preserved");
      return true;
    },
  );
  nextStatus = 200;
});
