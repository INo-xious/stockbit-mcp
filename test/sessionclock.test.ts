/**
 * Where the trading day is, in Jakarta.
 *
 * Every assertion pins a specific instant in UTC and states the WIB answer, because a session clock
 * whose tests only pass on a Tuesday afternoon is not a tested clock. The instants below are chosen
 * to sit on the edges that actually differ: Friday's shorter first session and later second one,
 * the midday break, the pre-closing auction, and the rollover from Friday evening to Monday morning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionClock, isWithinPollingWindow } from "../src/core/sessionclock.ts";

/** WIB is UTC+7, so `wib("2026-08-25T10:00")` is 03:00Z the same day. */
function wib(local: string): Date {
  const [date, time] = local.split("T");
  const [h, m] = time.split(":").map(Number);
  const utcMinutes = h * 60 + m - 7 * 60;
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + utcMinutes * 60_000);
}

test("Tuesday morning is session 1", () => {
  const c = sessionClock(wib("2026-08-25T10:00"));
  assert.equal(c.weekday, "Tuesday");
  assert.equal(c.phase, "session-1");
  assert.equal(c.isTradingHours, true);
  assert.equal(c.nowWib, "2026-08-25 10:00");
  assert.equal(c.nextOpenWib, undefined, "no next open while one is running");
});

test("Friday noon is the break, and Friday's break is the long one", () => {
  // Friday: 09:00–11:30, then 14:00–15:50. Noon is in the middle of the break on a Friday and in
  // session 1 on any other weekday — the single most likely thing to get wrong.
  const friday = sessionClock(wib("2026-08-28T12:00"));
  assert.equal(friday.weekday, "Friday");
  assert.equal(friday.phase, "break");
  assert.equal(friday.isTradingHours, false);
  assert.equal(friday.nextOpenWib, "2026-08-28 14:00");

  const thursday = sessionClock(wib("2026-08-27T12:00"));
  assert.equal(thursday.phase, "break", "Thursday's session 1 ends at 12:00 exactly");
  assert.equal(thursday.nextOpenWib, "2026-08-27 13:30");

  const thursdayJustBefore = sessionClock(wib("2026-08-27T11:59"));
  assert.equal(thursdayJustBefore.phase, "session-1");
});

test("Saturday is the weekend and points at Monday", () => {
  const c = sessionClock(wib("2026-08-29T10:00"));
  assert.equal(c.weekday, "Saturday");
  assert.equal(c.phase, "weekend");
  assert.equal(c.isTradingHours, false);
  assert.equal(c.nextOpenWib, "2026-08-31 09:00");
});

test("Monday evening is closed, and the next open is Tuesday morning", () => {
  const c = sessionClock(wib("2026-08-24T16:30"));
  assert.equal(c.weekday, "Monday");
  assert.equal(c.phase, "closed");
  assert.equal(c.isTradingHours, false);
  assert.equal(c.nextOpenWib, "2026-08-25 09:00");
});

test("the phases around the open and the close are named separately", () => {
  assert.equal(sessionClock(wib("2026-08-25T08:00")).phase, "closed");
  assert.equal(sessionClock(wib("2026-08-25T08:50")).phase, "pre-opening");
  assert.equal(sessionClock(wib("2026-08-25T09:00")).phase, "session-1");
  assert.equal(sessionClock(wib("2026-08-25T14:00")).phase, "session-2");
  assert.equal(sessionClock(wib("2026-08-25T15:55")).phase, "pre-closing");
  assert.equal(sessionClock(wib("2026-08-25T16:10")).phase, "post-closing");
  assert.equal(sessionClock(wib("2026-08-25T16:20")).phase, "closed");
});

test("a WIB day can be a different UTC day, and the clock reports the WIB one", () => {
  // 2026-08-24T20:00Z is 2026-08-25 03:00 WIB — the next day in Jakarta, still Monday in UTC.
  const c = sessionClock(new Date("2026-08-24T20:00:00Z"));
  assert.equal(c.nowWib, "2026-08-25 03:00");
  assert.equal(c.weekday, "Tuesday");
  assert.equal(c.phase, "closed");
  assert.equal(c.nextOpenWib, "2026-08-25 09:00");
});

test("it says out loud that it does not know about holidays", () => {
  // The failure this prevents: a confident "the market is open" on Idul Fitri. The clock cannot
  // know, so it must never let a caller believe it does.
  const c = sessionClock(wib("2026-08-25T10:00"));
  assert.match(c.note, /holiday/i);
  assert.match(c.note, /market_session/);
});

/* ------------------------------ the same instant, both clocks ------------------------------ */

/**
 * One event carried three clock readings in the field — payloads in UTC, this clock in WIB, and a
 * host machine in a third zone — and correlating them was manual arithmetic every time. Each WIB
 * field now has a UTC sibling naming the SAME instant, which is the property these assert.
 */
test("nowUtc is the same instant as nowWib, and keeps the seconds nowWib drops", () => {
  const at = new Date("2026-08-25T03:00:14Z"); // 10:00:14 WIB, Tuesday
  const c = sessionClock(at);
  assert.equal(c.nowWib, "2026-08-25 10:00");
  assert.equal(c.nowUtc, "2026-08-25T03:00:14.000Z");
});

test("nextOpenUtc accompanies nextOpenWib, and never appears without it", () => {
  const friday = sessionClock(wib("2026-08-28T12:00")); // in the long Friday break
  assert.equal(friday.nextOpenWib, "2026-08-28 14:00");
  assert.equal(friday.nextOpenUtc, "2026-08-28T07:00:00.000Z");

  // While a session is open there is no next open at all — and so no UTC sibling either.
  const open = sessionClock(wib("2026-08-25T10:00"));
  assert.equal(open.nextOpenWib, undefined);
  assert.equal(open.nextOpenUtc, undefined);
});

test("the UTC sibling rolls back a DAY where the WIB reading does not", () => {
  // The case a string rewrite gets wrong. 09:00 WIB on Monday is 02:00Z on Monday, so the date is
  // unchanged — but the weekend jump from Saturday must land on Monday 02:00Z, not Sunday's.
  const saturday = sessionClock(wib("2026-08-29T10:00"));
  assert.equal(saturday.nextOpenWib, "2026-08-31 09:00");
  assert.equal(saturday.nextOpenUtc, "2026-08-31T02:00:00.000Z");

  // And the genuine rollover: pre-opening at 08:45 WIB is 01:45Z the SAME day, while any WIB
  // reading before 07:00 would be the previous UTC day. `wibInstant` is built from the instant
  // rather than the rendered string precisely so this cannot drift.
  const beforeOpen = sessionClock(wib("2026-08-25T06:30"));
  assert.equal(beforeOpen.nowWib, "2026-08-25 06:30");
  assert.equal(beforeOpen.nowUtc, "2026-08-24T23:30:00.000Z", "06:30 WIB is the PREVIOUS day in UTC");
  assert.equal(beforeOpen.nextOpenWib, "2026-08-25 09:00");
  assert.equal(beforeOpen.nextOpenUtc, "2026-08-25T02:00:00.000Z");
});

test("every phase that reports a next open reports both clocks", () => {
  // A sweep rather than a spot check: the pair is set through one helper, and this is what proves
  // no branch was missed when a new phase is added.
  const instants = [
    "2026-08-25T06:30", // closed, before pre-opening
    "2026-08-25T08:50", // pre-opening
    "2026-08-25T12:30", // break
    "2026-08-25T15:55", // pre-closing
    "2026-08-25T16:10", // post-closing
    "2026-08-25T17:00", // closed, after the print
    "2026-08-29T10:00", // weekend
  ];
  for (const at of instants) {
    const c = sessionClock(wib(at));
    assert.ok(c.nextOpenWib, `${at} should have a next open`);
    assert.ok(c.nextOpenUtc, `${at} (${c.phase}) reports nextOpenWib without nextOpenUtc`);
    assert.match(c.nextOpenUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, at);
    // The two readings must be seven hours apart — the definition of WIB, asserted rather than
    // assumed, so a future offset edit cannot silently desynchronise the pair.
    const utc = Date.parse(c.nextOpenUtc);
    const asWib = Date.parse(`${c.nextOpenWib.replace(" ", "T")}:00Z`);
    assert.equal(asWib - utc, 7 * 60 * 60_000, `${at}: ${c.nextOpenWib} vs ${c.nextOpenUtc}`);
  }
});

test("the UTC fields are a plain toISOString, the way the rest of the server stamps time", () => {
  // Not a cosmetic preference. These fields exist so a reading can be compared against the
  // server's other output without thinking about it, and a second timestamp format is the problem
  // this issue removes rather than a polish on it — every other stamp in src/ is a raw
  // toISOString(), milliseconds included.
  const c = sessionClock(new Date("2026-08-25T03:00:14.789Z"));
  assert.equal(c.nowUtc, "2026-08-25T03:00:14.789Z");
  assert.equal(c.nowUtc, new Date("2026-08-25T03:00:14.789Z").toISOString());
});

test("the daemon's polling window is wider than any single session", () => {
  // It deliberately stays true through the midday break: a daemon that stopped at a session
  // boundary would miss an alert that fires on the post-closing print.
  assert.equal(isWithinPollingWindow(wib("2026-08-25T08:50")), true, "pre-opening");
  assert.equal(isWithinPollingWindow(wib("2026-08-25T12:30")), true, "the break");
  assert.equal(isWithinPollingWindow(wib("2026-08-25T16:10")), true, "post-closing");
  assert.equal(isWithinPollingWindow(wib("2026-08-25T08:30")), false, "before pre-opening");
  assert.equal(isWithinPollingWindow(wib("2026-08-25T16:30")), false, "after the print");
  assert.equal(isWithinPollingWindow(wib("2026-08-29T10:00")), false, "Saturday");
});
