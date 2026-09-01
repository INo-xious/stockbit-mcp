/**
 * Corporate actions, the calendars, the IPO pipeline and the underwriter directory.
 *
 * Every assertion here reads the URL the code actually produced out of `seen`, because the traps in
 * this family are all wire-level: a date range that is accepted and ignored, a symbol list that must
 * be comma-joined in ONE parameter where the broker endpoints repeat theirs, and a sort order that
 * is silently dropped when misspelled. A test that asserted on a params helper would pass through
 * every one of them.
 *
 * The fake fetch also counts concurrent requests. The calendar walks a range one day at a time and
 * MUST NOT fan out — concurrent first calls have burned this project's session token — so
 * `maxInFlight` is asserted rather than assumed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-corpaction-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import {
  MAX_CALENDAR_DAYS,
  getCalendarDay,
  getCalendarRange,
  getCorpactionStatus,
  getCorpactions,
  getDividendCalendar,
  getStockConversion,
  getUnderwriterPerformance,
  getUnderwriters,
  type CorpactionType,
} from "../src/core/corpaction.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* ---------------------------------- fixtures ---------------------------------- */

/** Cash dividends. Field names are plausible, not measured; the code must not depend on them. */
const DIVIDEND = {
  message: "ok",
  data: [
    {
      symbol: "BBRI",
      company_name: "Bank Rakyat Indonesia (Persero) Tbk.",
      dividend_type: "Final",
      cash_dividend: "135",
      cum_date: "2026-04-01",
      ex_date: "2026-04-02",
      payment_date: "2026-04-24",
    },
    {
      symbol: "BBRI",
      dividend_type: "Interim",
      cash_dividend: "80",
      cum_date: "2025-12-17",
      ex_date: "2025-12-18",
      payment_date: "2026-01-09",
    },
  ],
};

/** Stock dividends: shares, not money. One row deliberately carries no ex-date. */
const STOCK_DIVIDEND = {
  data: [
    { symbol: "BBRI", ratio: "1:10", ex_date: "2026-06-11", recording_date: "2026-06-12" },
    { symbol: "BBRI", ratio: "1:25", status: "announced" },
  ],
};

/** The nested shape: rows under a key, pagination beside them. The watchlist detail does this. */
const CONVERSION = {
  data: {
    result: [
      { symbol: "BUKA", instrument: "BUKA-W", converted_shares: "1250000", date: "2026-05-14" },
      { symbol: "BUKA", instrument: "BUKA-W", converted_shares: "430000", date: "2026-05-15" },
    ],
    total: 2,
    pagination: { page: 1, per_page: 20 },
  },
};

const STATUS = {
  data: [
    { symbol: "BBRI", uma: false, notation: [] },
    { symbol: "GOTO", uma: true, notation: ["X"] },
  ],
};

const UNDERWRITERS = {
  data: [
    { code: "YP", name: "Mirae Asset Sekuritas Indonesia" },
    { code: "CC", name: "Mandiri Sekuritas" },
  ],
};

const PERFORMANCE = {
  data: [{ symbol: "RATU", listing_date: "2026-01-08", ara_streak: 4, offering_price: "1100" }],
};

const IPO = { data: [{ symbol: "RATU", offering_price: "1100", listing_date: "2026-01-08" }] };

/**
 * The market-wide day calendar: `data` is BUCKETED, one key per action kind, with a `today` string
 * beside them. Twelve buckets come back every day and most of them are empty.
 *
 * The key ORDER copies the live 2026-09-01 response and is the whole point of the fixture: `bonus`
 * is FIRST and it is EMPTY. A reader that binds to the first array it finds reports a day of
 * nineteen actions as none, with a `rowsFrom` claiming it parsed the payload — which is worse than
 * an empty answer, because `rowsFrom` is what tells "none today" from "not read". The per-bucket
 * counts (dividend 1, economic 8, rups 1, warrant 9) are the live ones; the rows themselves are
 * invented, as are the tickers.
 */
const CALENDAR_BUCKETS = {
  message: "ok",
  data: {
    bonus: [],
    dividend: [{ symbol: "AAAA", cum_date: "2026-09-01", ex_date: "2026-09-02", cash_dividend: "45" }],
    // Not corporate actions — data releases, tied to no issuer. They are in the payload and in the
    // row list all the same; see the test that pins that decision.
    economic: Array.from({ length: 8 }, (_, i) => ({ event: `Release ${i + 1}`, country: "ID" })),
    ipo: [],
    pubex: [],
    rightissue: [],
    rups: [{ symbol: "BBBB", date: "2026-09-01", agenda: "RUPSLB" }],
    // `stock_reverse` and `tender` are the calendar's spellings; the path segment vocabulary says
    // `reversesplit` and `tenderoffer`. Kept as sent — see the tag test.
    stock_reverse: [],
    stocksplit: [],
    tender: [],
    warrant: Array.from({ length: 9 }, (_, i) => ({ symbol: `WRNT${i}`, instrument: `WRNT${i}-W` })),
    stock_dividend: [],
    today: "2026-09-01",
  },
};

/** Every bucket present and empty: a real, quiet day. Not the same answer as a payload nobody read. */
const CALENDAR_EMPTY = {
  data: Object.fromEntries(
    Object.entries(CALENDAR_BUCKETS.data).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  ),
};

/* ------------------------------- the fake wire ------------------------------- */

type Reply = (pathname: string, params: URLSearchParams) => unknown;

/** The default routing. Individual tests swap this to exercise one payload shape. */
const defaultReply: Reply = (pathname, params) => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "corpaction") {
    if (parts.length === 1) return { data: [{ symbol: "AAAA", action: "rups", date: params.get("date") }] };
    if (parts[1] === "status") return STATUS;
    if (parts[2] === "stock_conversion") return CONVERSION;
    if (parts[1] === "dividend") return DIVIDEND;
    if (parts[1] === "stock_dividend") return STOCK_DIVIDEND;
    if (parts[1] === "ipo") return IPO;
    return { data: [] };
  }
  if (parts[0] === "order-trade" && parts[1] === "underwriters") {
    return parts.length === 2 ? UNDERWRITERS : PERFORMANCE;
  }
  return undefined;
};

const realFetch = globalThis.fetch;
let seen: string[] = [];
let reply: Reply = defaultReply;
let inFlight = 0;
let maxInFlight = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The pathname and query of the n-th request, counted from the end. */
function url(index = -1): URL {
  const raw = seen.at(index);
  assert.ok(raw, `no request at index ${index}; seen ${seen.length}`);
  return new URL(raw);
}

/** The query of a request as a plain object, so a missing parameter is visibly missing. */
function query(index = -1): Record<string, string> {
  return Object.fromEntries(url(index).searchParams);
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (input: unknown) => {
    const raw = String(input);
    const { pathname, searchParams } = new URL(raw);
    // The refresh is plumbing: kept out of `seen` and out of the concurrency count so that request
    // indices in the assertions mean what they say.
    if (pathname.endsWith("login/refresh")) return json({ data: { access_token: farFutureJwt() } });

    seen.push(raw);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // A real await, so an overlapping caller would actually be observed as overlapping.
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;

    const body = reply(pathname, searchParams);
    return body === undefined ? json({ message: "no such route" }, 404) : json(body);
  }) as typeof fetch;
});

beforeEach(() => {
  seen = [];
  reply = defaultReply;
  maxInFlight = 0;
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/* ------------------------------ corporate actions ------------------------------ */

test("the action kind is a path segment and the filters are query parameters", async () => {
  await getCorpactions("dividend", "bbri", 5);
  assert.equal(seen.length, 1);
  assert.equal(url().pathname, "/corpaction/dividend");
  assert.deepEqual(query(), { symbol: "BBRI", limit: "5" });
});

test("an omitted filter is ABSENT from the query, not empty", async () => {
  await getCorpactions("rups");
  assert.equal(url().pathname, "/corpaction/rups");
  assert.deepEqual(query(), {});
  assert.ok(!seen[0].includes("?"), `expected no query string, got ${seen[0]}`);
});

test("an unknown action kind is refused before a request is built", async () => {
  await assert.rejects(
    () => getCorpactions("dividends" as CorpactionType),
    /corporate action type/i,
  );
  assert.equal(seen.length, 0, "a rejected action kind must not reach the wire");
});

test("limit 0 is refused and never sent", async () => {
  await assert.rejects(() => getCorpactions("dividend", "BBRI", 0), /limit/i);
  await assert.rejects(() => getCorpactions("dividend", "BBRI", 2.5), /limit/i);
  assert.equal(seen.length, 0);
});

test("rows are returned exactly as sent, with no renaming", async () => {
  const page = await getCorpactions("dividend", "BBRI");
  assert.equal(page.rowsFrom, "data");
  assert.deepEqual(page.rows, DIVIDEND.data);
  assert.equal(page.symbol, "BBRI");
  assert.equal(page.actionType, "dividend");
});

test("a nested row array is found, and its siblings are kept as meta", async () => {
  reply = () => CONVERSION;
  const page = await getCorpactions("warrant");
  assert.equal(page.rowsFrom, "data.result");
  assert.deepEqual(page.rows, CONVERSION.data.result);
  assert.deepEqual(page.meta, { total: 2, pagination: { page: 1, per_page: 20 } });
});

test("an empty list and a missing data field are different answers", async () => {
  reply = () => ({ data: [] });
  const empty = await getCorpactions("bonus");
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.rowsFrom, "data", "an empty array is a real, empty answer");

  clearCache();
  reply = () => ({ message: "ok", data: null });
  const absent = await getCorpactions("bonus");
  assert.deepEqual(absent.rows, []);
  assert.equal(absent.rowsFrom, "absent", "no data field at all is not the same as zero rows");
});

test("a payload that is not a row list is reported as unrecognized, not as empty", async () => {
  // The failure this guards: reporting `rows: []` for a shape nobody parsed, which reads as
  // "this issuer has no dividends" when it means "we could not find the rows".
  reply = () => ({ data: { message: "maintenance", code: 7 } });
  const page = await getCorpactions("dividend");
  assert.equal(page.rowsFrom, "unrecognized");
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.raw, { message: "maintenance", code: 7 });
});

/* ------------------------------ date-order sanity ------------------------------ */

test("a record date after the meeting it gates is reported, with both keys named", async () => {
  // The row a 2026-08-31 field report found: a RUPS on 2020-01-15 carrying rups_eligible_date
  // 2020-11-19, ten months after the meeting it decides attendance for. Upstream's defect; passing
  // it on looking clean is this server's.
  reply = () => ({
    data: [
      { symbol: "DEWA", date: "2020-01-15", rups_eligible_date: "2020-11-19", agenda: "RUPSLB" },
      { symbol: "DEWA", date: "2021-06-10", rups_eligible_date: "2021-05-20" },
    ],
  });
  const page = await getCorpactions("rups", "DEWA");
  assert.deepEqual(page.suspectDates, [
    { row: 0, earlierKey: "rups_eligible_date", earlier: "2020-11-19", laterKey: "date", later: "2020-01-15" },
  ]);
  // The row itself is handed over untouched — nothing is repaired, and no marker is added to it.
  assert.deepEqual(page.rows[0], {
    symbol: "DEWA",
    date: "2020-01-15",
    rups_eligible_date: "2020-11-19",
    agenda: "RUPSLB",
  });
});

test("a clean page carries no suspectDates key at all", async () => {
  // Absent rather than empty, so a reader cannot mistake "nothing was out of order" for a report
  // that ran. Most rows carry neither side of any pair and are never compared.
  const page = await getCorpactions("dividend", "BBRI");
  assert.equal("suspectDates" in page, false);
});

test("a bare `date` is never the EARLIER side of a pair", async () => {
  // DATE_ORDER's comment says why: `date` is the least specific key this module knows and is as
  // likely to be an announcement date as anything else, so treating it as the side that must come
  // first would flag rows that are in a perfectly ordinary order.
  //
  // This row is the shape that would prove it: a `date` LATER than a qualified key that is on a
  // `later` list. It is clean today because no rule takes `date` as an earlier candidate — append
  // `"date"` to the ex-date rule's `earlier` list and this test fails, which is the point of it.
  reply = () => ({ data: [{ symbol: "BUKA", date: "2026-05-20", recording_date: "2026-05-10" }] });
  const page = await getCorpactions("dividend");
  assert.equal("suspectDates" in page, false);
});

test("equal, missing and unreadable dates are not suspicions", async () => {
  reply = () => ({
    data: [
      // Collapsed onto one day: far likelier a feed rounding them together than an impossibility.
      { cum_date: "2026-04-02", ex_date: "2026-04-02" },
      // One side absent. Absent is not wrong, the same rule as absent is not zero.
      { cum_date: "2026-04-02" },
      // Present but not a date. A pair that could not be read is not evidence of anything.
      { cum_date: "2026-04-05", ex_date: "-" },
    ],
  });
  const page = await getCorpactions("dividend");
  assert.equal("suspectDates" in page, false);
});

test("the dividend calendar checks the same orderings, indexed after the sort", async () => {
  // It has to: the tool description steers callers here for dividends, so a check that fired only
  // on `corporate_actions` would claim a coverage this path does not have.
  reply = (pathname) =>
    pathname.includes("stock_dividend")
      ? { data: [] }
      : {
          data: [
            { symbol: "X", ex_date: "2026-01-10", recording_date: "2026-01-02" },
            { symbol: "X", ex_date: "2026-05-10", recording_date: "2026-05-12" },
          ],
        };
  const calendar = await getDividendCalendar("X");
  // Sorted newest ex-date first, so the offending row moved from index 0 to index 1.
  assert.equal(calendar.rows[1].exDate, "2026-01-10");
  assert.deepEqual(calendar.suspectDates, [
    { row: 1, earlierKey: "ex_date", earlier: "2026-01-10", laterKey: "recording_date", later: "2026-01-02" },
  ]);
});

test("the cache key holds every argument that changes the answer", async () => {
  await getCorpactions("dividend", "BBRI", 5);
  await getCorpactions("dividend", "BBRI", 5);
  assert.equal(seen.length, 1, "identical arguments must be served from cache");

  await getCorpactions("dividend", "BBRI", 10);
  assert.equal(seen.length, 2, "a different limit is a different answer");
  await getCorpactions("dividend", "GOTO", 5);
  assert.equal(seen.length, 3, "a different symbol is a different answer");
  await getCorpactions("rups", "BBRI", 5);
  assert.equal(seen.length, 4, "a different action kind is a different answer");
  await getCorpactions("dividend", undefined, 5);
  assert.equal(seen.length, 5, "market-wide is not the same request as one issuer");
});

/* ------------------------------ dividend calendar ------------------------------ */

test("the dividend calendar fetches both kinds, one after the other", async () => {
  await getDividendCalendar("BBRI", 20);
  assert.equal(seen.length, 2);
  assert.equal(url(-2).pathname, "/corpaction/dividend");
  assert.equal(url(-1).pathname, "/corpaction/stock_dividend");
  assert.deepEqual(query(-1), { symbol: "BBRI", limit: "20" });
  assert.equal(maxInFlight, 1, "the two legs must not be fanned out");
});

test("cash and stock dividends are merged, tagged and sorted by ex-date descending", async () => {
  const calendar = await getDividendCalendar("BBRI");
  assert.equal(calendar.exDateField, "ex_date");
  assert.deepEqual(
    calendar.rows.map((r) => [r.corpactionType, r.exDate]),
    [
      ["stock_dividend", "2026-06-11"],
      ["dividend", "2026-04-02"],
      ["dividend", "2025-12-18"],
      ["stock_dividend", null],
    ],
  );
  assert.equal(calendar.undated, 1, "the undated row is counted, kept, and placed last");
  assert.equal(calendar.rows.length, 4, "nothing is dropped by the merge");
  assert.deepEqual(calendar.exDateFields, ["ex_date"], "one spelling across both legs");
  assert.deepEqual(
    calendar.rows.map((r) => r.exDateFrom),
    ["ex_date", "ex_date", "ex_date", null],
    "every dated row names the key it was read from; the undated one names none",
  );
  // The rest of each row survives untouched.
  assert.equal(calendar.rows[1].cash_dividend, "135");
  assert.equal(calendar.rows[0].ratio, "1:10");
  assert.deepEqual(calendar.rowsFrom, { dividend: "data", stock_dividend: "data" });
});

test("when no candidate ex-date key is present the list says so instead of faking an order", async () => {
  reply = (pathname) =>
    pathname.endsWith("stock_dividend")
      ? { data: [{ symbol: "AAAA", tanggal_ex: "2026-01-05" }] }
      : { data: [{ symbol: "BBBB", tanggal_ex: "2026-02-05" }] };
  const calendar = await getDividendCalendar();
  assert.equal(calendar.exDateField, null);
  assert.deepEqual(calendar.exDateFields, [], "empty is what tells 'nothing matched' from 'mixed spellings'");
  assert.equal(calendar.undated, 2);
  assert.deepEqual(
    calendar.rows.map((r) => r.corpactionType),
    ["dividend", "stock_dividend"],
    "with no sort key the rows keep Stockbit's own order",
  );
});

test("a compact or epoch ex-date is read as a date, and an empty one stays absent", async () => {
  // Every one of these encodings is plausible on an unmeasured endpoint. 20260402 read as epoch
  // seconds is August 1970, and "" read as a number is 1970-01-01: both are confident wrong dates,
  // which is worse than no date at all.
  reply = (pathname) =>
    pathname.endsWith("stock_dividend")
      ? { data: [{ symbol: "CCCC", exdate: "" }] }
      : {
          data: [
            { symbol: "AAAA", exdate: 20260402 },
            { symbol: "BBBB", exdate: 1775433600 },
          ],
        };
  const calendar = await getDividendCalendar();
  assert.equal(calendar.exDateField, "exdate", "a later candidate is found when the earlier ones are absent");
  assert.deepEqual(
    calendar.rows.map((r) => [r.symbol, r.exDate]),
    [
      ["BBBB", "2026-04-06"],
      ["AAAA", "2026-04-02"],
      ["CCCC", null],
    ],
  );
  assert.equal(calendar.undated, 1);
  assert.deepEqual(calendar.exDateFields, ["exdate"]);
  assert.equal(
    calendar.rows[2].exDateFrom,
    null,
    "an empty string is not a date, so no key is credited with having read one",
  );
});

/*
 * The four below are issue #32: a live cash-dividend row was reported carrying `dividend_exdate`
 * beside `dividend_cumdate`/`dividend_recdate`/`dividend_paydate`, and the candidate list did not
 * hold that spelling. `exDateField` came back null, every row counted as undated, and the
 * documented newest-first sort silently became Stockbit's row order. One row hides it — the DEWA
 * case in the report had exactly one — so these use two.
 */

test("the reported cash-dividend spelling dividend_exdate is read, and the list sorts by it", async () => {
  reply = (pathname) =>
    pathname.endsWith("stock_dividend")
      ? { data: [] }
      : {
          data: [
            { symbol: "AAAA", dividend_exdate: "2026-07-08", dividend_paydate: "2026-07-31" },
            { symbol: "BBBB", dividend_exdate: "2026-09-02", dividend_paydate: "2026-09-25" },
          ],
        };
  const calendar = await getDividendCalendar();
  assert.equal(calendar.exDateField, "dividend_exdate");
  assert.deepEqual(calendar.exDateFields, ["dividend_exdate"]);
  assert.equal(calendar.undated, 0, "the rows are dated, so none of them is undated");
  assert.deepEqual(
    calendar.rows.map((r) => [r.symbol, r.exDate, r.exDateFrom]),
    [
      ["BBBB", "2026-09-02", "dividend_exdate"],
      ["AAAA", "2026-07-08", "dividend_exdate"],
    ],
    "newest ex-date first, which is what the tool documents and what it did not do",
  );
});

test("a qualified ex-date beats a bare `date` on the same row", async () => {
  // `date` is the least specific candidate and stays last for this reason: it is just as likely to
  // be an announcement or record date. A future edit that appends a key at the wrong end fails here.
  reply = (pathname) =>
    pathname.endsWith("stock_dividend")
      ? { data: [] }
      : { data: [{ symbol: "AAAA", date: "2026-01-02", dividend_exdate: "2026-07-08" }] };
  const calendar = await getDividendCalendar();
  assert.equal(calendar.rows[0].exDate, "2026-07-08");
  assert.equal(calendar.rows[0].exDateFrom, "dividend_exdate");
});

test("an EMPTY higher-precedence key falls through to a populated one", async () => {
  // The probe tests the VALUE, not `key in row`. A future "optimisation" to a key-presence check
  // would shadow the readable date with the empty one and this is what catches it.
  reply = (pathname) =>
    pathname.endsWith("stock_dividend")
      ? { data: [] }
      : { data: [{ symbol: "AAAA", dividend_exdate: "", ex_date: "2026-07-08" }] };
  const calendar = await getDividendCalendar();
  assert.equal(calendar.rows[0].exDate, "2026-07-08");
  assert.equal(calendar.rows[0].exDateFrom, "ex_date");
  assert.equal(calendar.undated, 0);
});

test("the two kinds may spell the ex-date differently and both are still read", async () => {
  // The hazard the per-row probe exists for. Resolved once for the merged list, the first leg to
  // match would pick the key for both, and the other leg would come back entirely undated while
  // `exDateField` named a key its rows do not carry.
  reply = (pathname) =>
    pathname.endsWith("stock_dividend")
      ? { data: [{ symbol: "BBBB", stock_dividend_exdate: "2026-09-01" }] }
      : { data: [{ symbol: "AAAA", dividend_exdate: "2026-07-08" }] };
  const calendar = await getDividendCalendar();
  assert.equal(calendar.undated, 0, "neither leg is left undated by the other leg's spelling");
  assert.deepEqual(
    calendar.rows.map((r) => [r.corpactionType, r.exDate, r.exDateFrom]),
    [
      ["stock_dividend", "2026-09-01", "stock_dividend_exdate"],
      ["dividend", "2026-07-08", "dividend_exdate"],
    ],
    "and the cross-leg sort actually happened",
  );
  assert.deepEqual(calendar.exDateFields, ["dividend_exdate", "stock_dividend_exdate"]);
  assert.equal(calendar.exDateField, "dividend_exdate", "the first of them in candidate order");
});

test("an unreadable leg is visible in rowsFrom rather than merged away", async () => {
  reply = (pathname) => (pathname.endsWith("stock_dividend") ? { data: { error: "nope" } } : DIVIDEND);
  const calendar = await getDividendCalendar();
  assert.deepEqual(calendar.rowsFrom, { dividend: "data", stock_dividend: "unrecognized" });
  assert.equal(calendar.rows.length, 2, "the readable leg is still returned");
});

/* -------------------------------- day calendar -------------------------------- */

test("the day calendar with no date sends no parameters at all", async () => {
  const day = await getCalendarDay();
  assert.equal(url().pathname, "/corpaction");
  assert.deepEqual(query(), {}, "this tool must not substitute a UTC 'today' of its own");
  assert.equal(day.date, null);
});

test("a date is sent as the only parameter", async () => {
  const day = await getCalendarDay("2026-08-03");
  assert.deepEqual(query(), { date: "2026-08-03" });
  assert.equal(day.date, "2026-08-03");
  assert.equal(day.rows[0].date, "2026-08-03", "the row came back for the day we asked for");
});

test("an impossible date is refused before the request", async () => {
  await assert.rejects(() => getCalendarDay("2026-02-30"), /calendar date/i);
  await assert.rejects(() => getCalendarDay("20260803"), /YYYY-MM-DD/);
  assert.equal(seen.length, 0);
});

test("EVERY bucket is read, not the first one that happens to be an array", async () => {
  // The defect, exactly: `bonus` sorts first in the live payload and is empty, so the reader bound
  // to it and reported a nineteen-action day as `rows: []` with `rowsFrom: "data.bonus"` — the two
  // together saying "parsed, and there is nothing", while the dividend, RUPS, warrant and economic
  // rows sat in `meta`. BBCA going ex-dividend read as an empty calendar.
  reply = () => CALENDAR_BUCKETS;
  const day = await getCalendarDay();

  assert.equal(day.rows.length, 19, "1 dividend + 8 economic + 1 rups + 9 warrant");
  assert.notEqual(day.rowsFrom, "data.bonus", "binding to the first empty bucket is the regression");
  assert.equal(
    day.rowsFrom,
    "data.{dividend,economic,rups,warrant}",
    "rowsFrom names every bucket that contributed, because naming one implies the rest were read",
  );
  // Zeros included: a kind here with 0 came back empty, a kind missing from this map was not in the
  // response at all. Nothing else in the answer can tell those two apart.
  assert.deepEqual(day.buckets, {
    bonus: 0,
    dividend: 1,
    economic: 8,
    ipo: 0,
    pubex: 0,
    rightissue: 0,
    rups: 1,
    stock_reverse: 0,
    stocksplit: 0,
    tender: 0,
    warrant: 9,
    stock_dividend: 0,
  });
  // The non-array sibling is kept beside the rows rather than dropped, as it always was.
  assert.deepEqual(day.meta, { today: "2026-09-01" });
});

test("each row says which bucket it came from, in the response's own spelling", async () => {
  reply = () => CALENDAR_BUCKETS;
  const day = await getCalendarDay();
  const counted = day.rows.reduce<Record<string, number>>((acc, row) => {
    const kind = String(row.corpactionType);
    acc[kind] = (acc[kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counted, { dividend: 1, economic: 8, rups: 1, warrant: 9 });
  // The row is otherwise untouched: the tag is added, nothing is renamed or dropped.
  assert.deepEqual(day.rows[0], {
    symbol: "AAAA",
    cum_date: "2026-09-01",
    ex_date: "2026-09-02",
    cash_dividend: "45",
    corpactionType: "dividend",
  });
});

test("a bucket name is never translated into the action_type vocabulary", async () => {
  // The calendar spells two of the twelve kinds differently from the `/corpaction/{actionType}`
  // path: `stock_reverse` and `tender` against `reversesplit` and `tenderoffer`. Rewriting one to
  // the other would be a claim that they name the same thing, and no call here has settled that.
  // The cost of not rewriting is visible and small: feeding `tender` to `corporate_actions` is
  // refused as an unknown kind, which is a question, not a wrong answer.
  reply = () => ({
    data: {
      bonus: [],
      stock_reverse: [{ symbol: "CCCC", ratio: "10:1" }],
      tender: [{ symbol: "DDDD", price: "980" }],
    },
  });
  const day = await getCalendarDay();
  assert.deepEqual(
    day.rows.map((row) => row.corpactionType),
    ["stock_reverse", "tender"],
  );
  assert.deepEqual(day.rowsFrom, "data.{stock_reverse,tender}");
});

test("the economic bucket is in the same list, and is countable on its own", async () => {
  // Deliberate: an economic event is a data release, not a corporate action — but `economic` is
  // already one of CORPACTION_TYPES and `corporate_actions(action_type:"economic")` fetches it from
  // the same family, so splitting it out only here would be a second convention. Dropping it would
  // also lose eight rows from a list whose question is "what is happening today". A caller who
  // wants corporate actions alone has both handles: the tag and the count.
  reply = () => CALENDAR_BUCKETS;
  const day = await getCalendarDay();
  assert.equal(day.buckets?.economic, 8);
  assert.equal(day.rows.filter((row) => row.corpactionType !== "economic").length, 11);
});

test("all buckets empty is an empty DAY; a payload nobody read is still not", async () => {
  reply = () => CALENDAR_EMPTY;
  const day = await getCalendarDay();
  assert.deepEqual(day.rows, []);
  assert.equal(day.rowsFrom, "data.{}", "no bucket contributed, and all twelve were read");
  assert.equal(Object.keys(day.buckets ?? {}).length, 12);
  assert.deepEqual(
    Object.values(day.buckets ?? {}),
    Array(12).fill(0),
    "every kind came back and every kind is empty — that is a quiet day, not an unread response",
  );

  clearCache();
  reply = () => ({ data: { message: "maintenance", code: 7 } });
  const unread = await getCalendarDay();
  assert.equal(unread.rowsFrom, "unrecognized");
  assert.equal("buckets" in unread, false, "no buckets key at all: nothing was bucketed");
});

test("the single-list shapes still read the way they always did", async () => {
  // The bucket reader is an ADDITION. `corpaction/:actionType` and the rest answer with one list,
  // and one array beside its siblings is still the nested shape, not a two-bucket calendar.
  reply = () => ({ data: [{ symbol: "EEEE", action: "rups" }] });
  const flat = await getCalendarDay();
  assert.equal(flat.rowsFrom, "data");
  assert.equal(flat.rows.length, 1);
  assert.equal("buckets" in flat, false);
  assert.equal("corpactionType" in flat.rows[0], false, "an untagged shape is never tagged by guess");

  clearCache();
  reply = () => CONVERSION;
  const nested = await getCalendarDay();
  assert.equal(nested.rowsFrom, "data.result", "one array with pagination beside it is not a bucket map");
  assert.deepEqual(nested.meta, { total: 2, pagination: { page: 1, per_page: 20 } });
  assert.equal("buckets" in nested, false);
});

test("the server's own today fills in the date, and dateFrom says where it came from", async () => {
  reply = () => CALENDAR_BUCKETS;
  const served = await getCalendarDay();
  assert.equal(served.date, "2026-09-01", "null was wrong: the response said what day it is");
  assert.equal(served.dateFrom, "data.today");

  // A requested date wins — it is what was asked for. The server's value stays visible in `meta`,
  // because whether `today` echoes the request or names the server's own day is not known here.
  clearCache();
  const asked = await getCalendarDay("2026-08-03");
  assert.equal(asked.date, "2026-08-03");
  assert.equal(asked.dateFrom, "request");
  assert.deepEqual(asked.meta, { today: "2026-09-01" });
});

test("a today this code cannot read leaves the date null rather than guessing a day", async () => {
  // `Date.parse("01/09/2026")` is the 9th of January, and this value is read as the day the rows
  // describe. A confident wrong day is worse than no day; the raw string stays in `meta`.
  reply = () => ({ data: { bonus: [], rups: [{ symbol: "FFFF" }], today: "01/09/2026" } });
  const day = await getCalendarDay();
  assert.equal(day.date, null);
  assert.equal("dateFrom" in day, false, "no dateFrom without a date to have a provenance for");
  assert.deepEqual(day.meta, { today: "01/09/2026" });
});

test("a range counts every bucket's rows, not the first bucket's", async () => {
  // `rowsTotal` is what a caller skims to decide whether a window is worth reading.
  reply = () => CALENDAR_BUCKETS;
  const range = await getCalendarRange({ from: "2026-08-03", to: "2026-08-04" });
  assert.equal(range.rowsTotal, 38, "19 rows on each of the two days");
  assert.deepEqual(range.days.map((d) => d.dateFrom), ["request", "request"]);
});

/* ------------------------------- calendar range ------------------------------- */

test("a range is walked one day at a time, sequentially", async () => {
  const range = await getCalendarRange({ from: "2026-08-03", to: "2026-08-05" });
  assert.equal(seen.length, 3, "one request per day: this endpoint has no range form");
  assert.deepEqual(
    seen.map((u) => new URL(u).searchParams.get("date")),
    ["2026-08-03", "2026-08-04", "2026-08-05"],
  );
  assert.equal(maxInFlight, 1, "the days must be fetched one after the other, never fanned out");
  assert.equal(range.truncated, false);
  assert.equal(range.daysRequested, 3);
  assert.equal(range.daysFetched, 3);
  assert.equal(range.daysSkipped, 0);
  assert.equal(range.note, undefined, "a complete answer carries no truncation note");
  assert.equal(range.rowsTotal, 3);
  assert.deepEqual(range.days.map((d) => d.date), ["2026-08-03", "2026-08-04", "2026-08-05"]);
});

test("a range longer than the cap returns what it fetched and says what it skipped", async () => {
  const range = await getCalendarRange({ from: "2026-01-01", to: "2026-03-31" });
  assert.equal(seen.length, MAX_CALENDAR_DAYS);
  assert.equal(range.daysRequested, 90);
  assert.equal(range.daysFetched, MAX_CALENDAR_DAYS);
  assert.equal(range.daysSkipped, 59);
  assert.equal(range.truncated, true);
  assert.equal(range.coveredFrom, "2026-01-01");
  assert.equal(range.coveredTo, "2026-01-31", "the covered end is the real end of the answer");
  assert.equal(range.requestedTo, "2026-03-31");
  // The note has to be unmissable: a capped result read as a complete one is a wrong answer about
  // an empty calendar, not a missing one.
  assert.match(String(range.note), /INCOMPLETE/);
  assert.match(String(range.note), /59 day/);
  assert.match(String(range.note), /2026-03-31/);
});

test("a half-specified range is refused rather than sent as one ignored day", async () => {
  // This is the endpoint's worst input: `from` alone comes back 200 with today's actions.
  await assert.rejects(() => getCalendarRange({ from: "2026-08-03" }), /both ends/i);
  await assert.rejects(() => getCalendarRange({ to: "2026-08-03" }), /both ends/i);
  await assert.rejects(() => getCalendarRange({}), /from and to/i);
  await assert.rejects(() => getCalendarRange({ from: "2026-08-05", to: "2026-08-03" }), /must not be after/);
  assert.equal(seen.length, 0);
});

test("days already fetched are served from cache when ranges overlap", async () => {
  await getCalendarRange({ from: "2026-08-03", to: "2026-08-05" });
  assert.equal(seen.length, 3);
  await getCalendarRange({ from: "2026-08-04", to: "2026-08-06" });
  assert.equal(seen.length, 4, "only the one new day is fetched again");
});

/* ---------------------------------- status ---------------------------------- */

test("status sends ONE comma-joined symbol parameter, not repeated ones", async () => {
  await getCorpactionStatus(["bbri", "goto", "brms"]);
  assert.equal(url().pathname, "/corpaction/status");
  assert.deepEqual(url().searchParams.getAll("symbol"), ["BBRI,GOTO,BRMS"]);
  assert.equal(
    url().searchParams.getAll("symbol").length,
    1,
    "repeated parameters are the broker-activity convention; this endpoint takes a list in one",
  );
});

test("a comma-joined string argument is accepted and deduped", async () => {
  const status = await getCorpactionStatus("bbri,GOTO,bbri");
  assert.deepEqual(status.requested, ["BBRI", "GOTO"]);
  assert.deepEqual(url().searchParams.getAll("symbol"), ["BBRI,GOTO"]);
});

test("a symbol the response never mentions is unanswered, not silently clean", async () => {
  const status = await getCorpactionStatus(["BBRI", "GOTO", "TLKM"]);
  assert.deepEqual(status.answered, ["BBRI", "GOTO"]);
  assert.deepEqual(status.unanswered, ["TLKM"], "TLKM has no row here; that is not 'confirmed clean'");
  assert.deepEqual(status.rows, STATUS.data);
});

test("a map keyed by symbol is matched on its keys", async () => {
  // The plausible alternative shape. Matching by value alone would call every symbol unanswered.
  reply = () => ({ data: { BBRI: { uma: false }, GOTO: { uma: true } } });
  const status = await getCorpactionStatus(["BBRI", "GOTO", "TLKM"]);
  assert.deepEqual(status.answered, ["BBRI", "GOTO"]);
  assert.deepEqual(status.unanswered, ["TLKM"]);
  assert.equal(status.rowsFrom, "unrecognized", "and the payload itself is still handed back");
});

test("an empty or invalid symbol list never reaches the wire", async () => {
  await assert.rejects(() => getCorpactionStatus([]), /at least one symbol/i);
  await assert.rejects(() => getCorpactionStatus("  ,  "), /at least one symbol/i);
  await assert.rejects(() => getCorpactionStatus(["BBRI", "../etc"]), /Invalid Symbol/);
  assert.equal(seen.length, 0);
});

test("the status cache key is the symbol set", async () => {
  await getCorpactionStatus(["BBRI", "GOTO"]);
  await getCorpactionStatus(["bbri", "goto"]);
  assert.equal(seen.length, 1, "the same set normalizes to the same key");
  await getCorpactionStatus(["BBRI", "TLKM"]);
  assert.equal(seen.length, 2);
});

/* ------------------------------ stock conversion ------------------------------ */

test("stock conversion takes the symbol as a path segment", async () => {
  const conversion = await getStockConversion("buka", 1, 20);
  assert.equal(url().pathname, "/corpaction/BUKA/stock_conversion");
  assert.deepEqual(query(), { page: "1", limit: "20" });
  assert.equal(conversion.symbol, "BUKA");
  assert.equal(conversion.rowsFrom, "data.result");
  assert.deepEqual(conversion.rows, CONVERSION.data.result);
});

test("page 0 is sent, and a negative page is refused", async () => {
  // Whether pagination is 0- or 1-based is unverified, so 0 must survive as a value rather than be
  // dropped as falsy.
  await getStockConversion("BUKA", 0);
  // `limit` rides along because the endpoint refuses a request without it; see the test below.
  assert.deepEqual(query(), { page: "0", limit: "20" });
  await assert.rejects(() => getStockConversion("BUKA", -1), /page/i);
  await assert.rejects(() => getStockConversion("BUKA", undefined, 0), /limit/i);
  assert.equal(seen.length, 1, "only the valid call reached the wire");
});

test("omitted pagination is DEFAULTED, because this endpoint has no default of its own", async () => {
  // This test used to assert the opposite, and that assertion was pinning the bug: with neither
  // supplied the server answers 400 "Page is a required field;Limit is a required field;", so
  // stock_conversion had never returned a row. Settled live on 2026-08-29.
  await getStockConversion("BUKA");
  assert.deepEqual(query(), { page: "1", limit: "20" });
});

test("the conversion cache key holds symbol, page and limit", async () => {
  await getStockConversion("BUKA", 1, 20);
  await getStockConversion("BUKA", 1, 20);
  assert.equal(seen.length, 1);
  await getStockConversion("BUKA", 2, 20);
  await getStockConversion("BUKA", 1, 50);
  await getStockConversion("BBRI", 1, 20);
  assert.equal(seen.length, 4);
});

/* ------------------------------- ipo & underwriters ------------------------------- */

test("the IPO pipeline is the ipo action kind", async () => {
  const page = await getCorpactions("ipo", undefined, 25);
  assert.equal(url().pathname, "/corpaction/ipo");
  assert.deepEqual(query(), { limit: "25" });
  assert.deepEqual(page.rows, IPO.data);
});

test("the underwriter directory takes no parameters", async () => {
  const directory = await getUnderwriters();
  assert.equal(url().pathname, "/order-trade/underwriters");
  assert.deepEqual(query(), {});
  assert.deepEqual(directory.rows, UNDERWRITERS.data);
});

test("underwriter performance puts the code in the path and the ordering in the query", async () => {
  const performance = await getUnderwriterPerformance(
    "yp",
    "GET_UNDERWRITER_IPO_PERFORMANCE_SORT_BY_ARA_STREAK",
  );
  assert.equal(url().pathname, "/order-trade/underwriters/YP/ipo-performance");
  assert.deepEqual(query(), { sort_by: "GET_UNDERWRITER_IPO_PERFORMANCE_SORT_BY_ARA_STREAK" });
  assert.equal(performance.underwriterCode, "YP");
  assert.deepEqual(performance.rows, PERFORMANCE.data);
});

test("an omitted ordering is absent, and an invented one is refused", async () => {
  await getUnderwriterPerformance("CC");
  assert.deepEqual(query(), {}, "no sort_by parameter at all when none was asked for");
  // The endpoint ignores an unrecognised ordering and returns the default one, which is
  // indistinguishable from having sorted. So it is refused here.
  await assert.rejects(() => getUnderwriterPerformance("CC", "ara_streak"), /sort_by/);
  assert.equal(seen.length, 1);
});

test("a malformed underwriter code is refused by the transport, not sent", async () => {
  await assert.rejects(() => getUnderwriterPerformance("Y!"), /underwriter code/i);
  await assert.rejects(() => getUnderwriterPerformance("TOOLONGCODE"), /underwriter code/i);
  assert.equal(seen.length, 0);
});

test("the underwriter cache key holds the code and the ordering", async () => {
  await getUnderwriterPerformance("YP");
  await getUnderwriterPerformance("YP");
  assert.equal(seen.length, 1);
  await getUnderwriterPerformance("CC");
  await getUnderwriterPerformance("YP", "GET_UNDERWRITER_IPO_PERFORMANCE_SORT_BY_ARA_STREAK");
  assert.equal(seen.length, 3);
});
