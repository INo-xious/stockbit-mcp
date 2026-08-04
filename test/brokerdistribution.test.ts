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
  buildDistributionParams,
  getBrokerDistribution,
} from "../src/core/brokerdistribution.ts";
import { StockbitError } from "../src/http/errors.ts";

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
      if (nextStatus !== 200) {
        return new Response(JSON.stringify({ message: "Forbidden", error_type: "FORBIDDEN" }), {
          status: nextStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(FIXTURE), {
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

test("VOLUME selects the other block and reports the unit as shares", async () => {
  clearCache();
  nextStatus = 200;
  const d = await getBrokerDistribution({ symbol: "BBRI", dataType: "VOLUME" });
  assert.equal(d.amountUnit, "shares");
  // The fixture's by_volume is empty, mirroring the live API when data_type is VALUE-vs-VOLUME.
  assert.deepEqual(d.topBuyers, []);
  assert.deepEqual(d.topSellers, []);
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
