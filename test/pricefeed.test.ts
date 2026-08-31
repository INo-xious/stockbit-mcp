/**
 * The intraday close series: what it reads, what it refuses to read, and what it refuses to invent.
 *
 * There was no test of `getIntradayPrices` at all before issue #40, which is how `.map(Number)`
 * survived in a function whose own file documents, 100 lines below, that `Number("")` being 0 is
 * the trap it exists to guard. The series it feeds is the one `settlePaper` fills against.
 *
 * The wire test asserts on the URL the client actually produced rather than on a params helper —
 * `interval` is a parameter nothing else in the suite covers, and a dropped one is invisible in
 * the returned object.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-pricefeed-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { getIntradayPrices, shapeIntraday } from "../src/core/pricefeed.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;
let seen: string[] = [];
let body: unknown = { data: [{ symbol: "BBRI", prices: ["3000", "3010"] }] };

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const text = String(url);
    seen.push(text);
    if (text.includes("login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    if (text.includes("/prices/close")) return json(body);
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
});

beforeEach(() => {
  seen = [];
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/* --------------------------------- the projection --------------------------------- */

test("a wire value that is not a number becomes null, never zero and never NaN", () => {
  // `Number("")` is 0 and `Number("abc")` is NaN. A 0 here is a price, and `0 <= limit` fills every
  // open paper buy; a NaN serialises to null anyway but poisons any arithmetic on the way.
  const shaped = shapeIntraday("BBRI", 1, { prices: ["3000", "", "abc", "3,010", "  ", "0"] });
  assert.deepEqual(shaped.prices, [3000, null, null, 3010, null, 0]);
  assert.equal(shaped.prices.length, 6, "positions are stable — nothing is dropped or compacted");
});

test("a real zero on the wire is kept as a zero", () => {
  // The point of the guard is telling absent from zero, which cuts both ways.
  assert.deepEqual(shapeIntraday("BBRI", 1, { prices: ["0"] }).prices, [0]);
});

test("every other key on the row comes back by name, so one live call settles the shape", () => {
  const shaped = shapeIntraday("BBRI", 5, { symbol: "BBRI", prices: ["3000"], time: ["09:00"], volume: [10] });
  assert.deepEqual([...shaped.unmapped.sampleKeys].sort(), ["time", "volume"]);
  assert.equal(shaped.unmapped.count, 2);
  assert.equal((shaped as Record<string, unknown>).times, undefined, "and no time series is fabricated from them");
});

test("a `prices` that is not an array is an empty series, not a throw", () => {
  // `CloseResponse` enforces `z.array(z.string())` on the way in, but this function is EXPORTED and
  // takes `Record<string, unknown>`, so nothing stops a caller reaching it directly. The cast it
  // used to carry made that `prices.map is not a function`.
  for (const prices of ["3000", 3000, null, {}] as unknown[]) {
    const shaped = shapeIntraday("BBRI", 1, { prices });
    assert.deepEqual(shaped.prices, [], `a ${typeof prices} \`prices\` reads as no series at all`);
    assert.deepEqual(shaped.unmapped, { count: 0, sampleKeys: [] }, "`prices` is a key this module reads, so it is never reported as unrecognised");
  }
});

test("no row at all is an empty series, not an error and not an invented one", () => {
  const shaped = shapeIntraday("BBRI", 1, undefined);
  assert.deepEqual(shaped.prices, []);
  assert.deepEqual(shaped.unmapped, { count: 0, sampleKeys: [] });
  assert.equal(shaped.symbol, "BBRI");
  assert.ok(shaped.note.length > 0, "the note is unconditional — an empty series is still untimed");
});

test("the note names the midday break, which is why index x interval is not a clock", () => {
  const { note } = shapeIntraday("BBRI", 5, { prices: [] });
  assert.match(note, /12:00-13:30/);
  assert.match(note, /11:30-14:00/);
  assert.match(note, /not a zero/i, "and says what a null means, for a caller reading the payload alone");
});

test("interval is echoed as asked for, not measured", () => {
  assert.equal(shapeIntraday("BBRI", 15, { prices: ["1"] }).interval, 15);
});

/* ----------------------------------- the wire ----------------------------------- */

test("the request carries the symbol and the interval, and the answer is cached per interval", async () => {
  const first = await getIntradayPrices("bbri", 5);
  assert.equal(first.symbol, "BBRI", "the symbol is normalized before it reaches the URL");

  const url = new URL(seen.filter((u) => !u.includes("login/refresh"))[0]);
  assert.equal(url.pathname, "/company-price-feed/prices/close");
  assert.deepEqual(Object.fromEntries(url.searchParams.entries()), { symbol: "BBRI", interval: "5" });

  await getIntradayPrices("BBRI", 5);
  assert.equal(seen.filter((u) => u.includes("/prices/close")).length, 1, "the second call is served from cache");

  await getIntradayPrices("BBRI", 1);
  assert.equal(
    seen.filter((u) => u.includes("/prices/close")).length,
    2,
    "a different interval is a different question and must not reuse the answer",
  );
});

test("the projection survives the round trip from a real response body", async () => {
  body = { data: [{ symbol: "BBRI", prices: ["3000", ""], foo: 1 }] };
  const prices = await getIntradayPrices("BBRI", 1);
  assert.deepEqual(prices.prices, [3000, null]);
  assert.deepEqual(prices.unmapped, { count: 1, sampleKeys: ["foo"] });
  body = { data: [{ symbol: "BBRI", prices: ["3000", "3010"] }] };
});
