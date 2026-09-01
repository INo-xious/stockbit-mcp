/**
 * The report a user reads when nothing is working.
 *
 * Three properties, and each exists because of a specific way this could be worse than useless:
 *
 *   1. **It answers on an empty store.** The state it is most needed in is the broken one. A
 *      `status` that throws when there is no credential directory tells a new user nothing at all,
 *      which is exactly when they need it.
 *   2. **It never carries a token.** It decodes the stored JWT to read one number out of it. A tool
 *      result is text a model relays and a client may log, so the whole serialised report is
 *      checked for anything JWT-shaped rather than each field being trusted.
 *   3. **`nextStep` is one instruction, and it is the right one.** A list of things you could try
 *      is what the error messages already were.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-status-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;
delete process.env.STOCKBIT_TRADING;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { collectStatus, formatStatus, loginStarted, loginFinished, resetLoginStatus } from "../src/status.ts";
import { getStore, resetStoreCache } from "../src/auth/store.ts";
import { settingsPath } from "../src/settings.ts";
import { clearSessionHealth, recordRefreshFailure, recordRefreshOk } from "../src/auth/health.ts";
import { clearAccessCache } from "../src/auth/accesscache.ts";
import { resetSession } from "../src/auth/session.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

beforeEach(() => {
  resetLoginStatus();
  delete process.env.STOCKBIT_TRADING;
});

/** A syntactically real JWT with the given `exp`. Signature is nonsense; nothing here verifies it. */
function fakeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "test", exp: expSeconds })}.c2lnbmF0dXJl`;
}

/** Anything that looks like a JWT. Deliberately loose — a partial leak is still a leak. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

function clearAllSlots(): void {
  for (const slot of ["main", "securities", "eipo"] as const) {
    try {
      getStore(slot).clear();
    } catch {
      /* nothing stored */
    }
  }
  resetStoreCache();
}

test("an empty store produces a report, not an exception", async () => {
  clearAllSlots();
  const report = await collectStatus({ now: new Date("2026-08-25T03:00:00Z") });

  assert.equal(report.auth.main.stored, false);
  assert.equal(report.auth.securities.stored, false);
  assert.equal(report.auth.eipo.stored, false);
  assert.equal(report.server.name, "stockbit");
  assert.match(report.server.version, /^\d+\.\d+\.\d+/);
  assert.ok(report.checks.length > 0);
});

test("with no session at all, nextStep names login and nothing else", async () => {
  clearAllSlots();
  const report = await collectStatus();
  assert.match(report.nextStep, /log me into Stockbit/);
  assert.match(report.nextStep, /stockbit-auth login/);
  assert.doesNotMatch(report.nextStep, /trading-login/, "one instruction, not a menu");
});

test("a store that cannot be read is a failed check, not a crash", async () => {
  clearAllSlots();
  const saved = process.env.STOCKBIT_STORE_DIR;
  // A path whose parent is a file, so any read or write under it fails.
  process.env.STOCKBIT_STORE_DIR = join(STORE, "not-a-dir", "deeper");
  try {
    resetStoreCache();
    const report = await collectStatus();
    assert.equal(report.auth.main.stored, false);
    assert.ok(report.nextStep.length > 0);
  } finally {
    process.env.STOCKBIT_STORE_DIR = saved;
    resetStoreCache();
  }
});

test("a store that will not say whether it holds a credential must not advise logging in", async () => {
  // The bug this prevents, end to end: a locked login Keychain answers every read with a non-zero
  // exit, `get()` returns null, `status` reports "not set", and `nextStep` tells the user to log in
  // again — which on macOS means overwriting a credential that was never in doubt. "I could not
  // find out" and "there is nothing here" are different answers and must produce different advice.
  clearAllSlots();
  const store = getStore("main");
  const realReadState = store.readState.bind(store);
  (store as unknown as { readState: () => string }).readState = () => "unavailable";
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.unreadable, true, "the report must say the answer is unknown");
    assert.equal(report.auth.main.stored, false, "and must not claim a credential is present either");
    assert.match(
      report.nextStep,
      /Keychain/i,
      "nextStep must point at the Keychain, not at logging in",
    );
    assert.doesNotMatch(
      report.nextStep,
      /stockbit-auth login/,
      "advising a re-login here destroys a credential that may be perfectly good",
    );
    assert.match(formatStatus(report), /UNREADABLE/, "the terminal rendering must not read as 'not set'");
    assert.ok(
      report.checks.some((c) => c.name === "credential store (main)" && c.status === "warn"),
      "and it is a warning, because something really is wrong",
    );
  } finally {
    (store as unknown as { readState: unknown }).readState = realReadState;
  }
});

test("a stored token yields an expiry and never the token", async () => {
  clearAllSlots();
  mkdirSync(STORE, { recursive: true });
  const inSevenDays = Math.floor(Date.now() / 1000) + 7 * 86400;
  const token = fakeJwt(inSevenDays);
  getStore("main").set(token);
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.stored, true);
    assert.ok(
      report.auth.main.expiresInDays !== undefined && Math.abs(report.auth.main.expiresInDays - 7) < 0.1,
      `expected ~7 days, got ${report.auth.main.expiresInDays}`,
    );
    assert.notEqual(report.auth.main.expired, true);

    const serialised = JSON.stringify(report);
    assert.doesNotMatch(serialised, JWT_SHAPED, "the report carried something JWT-shaped");
    assert.ok(!serialised.includes(token));
    assert.doesNotMatch(formatStatus(report), JWT_SHAPED);
  } finally {
    clearAllSlots();
  }
});

test("a token Stockbit rejected is reported as failing, and nextStep says so", async () => {
  // The gap this closes. A refresh token can be revoked, or superseded by another login, and not
  // one byte of its payload changes — so `expiresInDays` reported "healthy, ~7 days" for a token
  // that 401s on its first use, which is the most expensive kind of wrong answer. Proving it live
  // costs a rotation and ends the user's website session, so instead the last outcome is recorded
  // and read back for free.
  clearAllSlots();
  clearSessionHealth();
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  getStore("main").set(token);
  recordRefreshFailure("main", token, 401, "HTTP 401");

  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.stored, true, "it IS stored");
    assert.equal(report.auth.main.expired, undefined, "and it has not expired");
    assert.equal(report.auth.main.health, "failing", "but it does not work, and that is knowable");
    assert.equal(report.auth.main.lastRefresh?.status, 401);
    assert.match(report.nextStep, /rejected/i, "nextStep must name what actually happened");
    assert.match(report.nextStep, /log in again|stockbit-auth login/i);
    assert.ok(
      report.checks.some((c) => c.name === "main session" && c.status === "fail"),
      "and it is a failed check, not a warning",
    );
    assert.match(formatStatus(report), /REJECTED/, "the terminal rendering must not read as healthy");

    const serialised = JSON.stringify(report);
    assert.doesNotMatch(serialised, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./, "still no token anywhere");
  } finally {
    clearSessionHealth();
    clearAllSlots();
  }
});

test("a credential nothing has been recorded about says nothing rather than guessing", async () => {
  // `unknown` is the ordinary state before a credential has ever been used. Printing "unknown"
  // beside an otherwise healthy line reads as a fault; the closing sentence in the CLI would also
  // point at a value that is not there.
  clearAllSlots();
  clearSessionHealth();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400));
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.health, "unknown");
    const rendered = formatStatus(report);
    assert.doesNotMatch(rendered, /unknown/i);
    assert.doesNotMatch(rendered, /REJECTED|last refresh/);
  } finally {
    clearAllSlots();
  }
});

test("a rejection recorded against a token that has since been replaced is not reported", async () => {
  // Otherwise `status` tells a user to log in again over a credential they replaced ten minutes ago.
  clearAllSlots();
  clearSessionHealth();
  const older = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  const fresh = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400 + 1);
  recordRefreshFailure("main", older, 401, "HTTP 401");
  getStore("main").set(fresh);
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.health, "unknown", "nothing is known about the NEW token");
    assert.doesNotMatch(report.nextStep, /rejected/i);
    // `health` was fingerprint-filtered and `lastRefresh` was not, so one payload described two
    // different credentials: a verdict about the token in the store beside a 401 belonging to the
    // one it replaced. The verdict was the only half anybody had checked.
    assert.equal(
      report.auth.main.lastRefresh,
      undefined,
      "a 401 against the PREVIOUS token is not a fact about this one",
    );
    assert.doesNotMatch(formatStatus(report), /401|REJECTED|last refresh/);
  } finally {
    clearSessionHealth();
    clearAllSlots();
  }
});

test("a success belonging to another credential cannot out-date this one's rejection", async () => {
  // The other direction, and the worse one, because it reads as good news. A matching failure
  // compared against an UNFILTERED lastOk let a success for a different token demote this token's
  // own 401 to `unknown` — and `status` then printed "last refresh OK at HH:MM" where HH:MM was
  // the timestamp of the refresh that failed.
  clearAllSlots();
  clearSessionHealth();
  const stored = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  const other = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400 + 1);
  recordRefreshFailure("main", stored, 401, "HTTP 401");
  await new Promise((r) => setTimeout(r, 15)); // distinct timestamps
  recordRefreshOk("main", other);
  getStore("main").set(stored);
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.health, "failing", "this token WAS rejected, whatever happened to another");
    assert.equal(report.auth.main.lastRefresh?.ok, false);
    assert.equal(report.auth.main.lastRefresh?.status, 401);
    assert.doesNotMatch(formatStatus(report), /last refresh OK/);
  } finally {
    clearSessionHealth();
    clearAllSlots();
  }
});

test("the verdict and the timestamp always describe the same credential", async () => {
  // The invariant the defect violated, asserted directly rather than through one scenario:
  // `unknown` means nothing is recorded about THIS token, so there is no event to quote.
  clearAllSlots();
  clearSessionHealth();
  const stored = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  const other = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400 + 1);
  recordRefreshFailure("main", other, 401, "HTTP 401");
  getStore("main").set(stored);
  try {
    const report = await collectStatus();
    for (const [slot, state] of Object.entries(report.auth)) {
      if (state.health === "unknown") {
        assert.equal(state.lastRefresh, undefined, `${slot}: unknown must quote no event`);
      }
      if (state.health === "ok") assert.equal(state.lastRefresh?.ok, true, `${slot}: ok must quote a success`);
      if (state.health === "failing") assert.equal(state.lastRefresh?.ok, false, `${slot}: failing must quote a failure`);
    }
  } finally {
    clearSessionHealth();
    clearAllSlots();
  }
});

test("a token that last refreshed successfully reports ok, and stays quiet about it", async () => {
  clearAllSlots();
  clearSessionHealth();
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  getStore("main").set(token);
  recordRefreshOk("main", token);
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.health, "ok");
    const rendered = formatStatus(report);
    assert.doesNotMatch(rendered, /REJECTED/);
    assert.match(rendered, /last refresh OK/, "a recorded success is worth saying, and it is free");
  } finally {
    clearSessionHealth();
    clearAllSlots();
  }
});

test("trading on with no trading tools registered is called out, and nextStep names the fix", async () => {
  // The trap the default profile creates. `core` has no order-entry tools, so a user who went to
  // the trouble of running `trading-enable --live` at their own terminal finds no order tool and
  // NOTHING anywhere saying why — trading reports "on", the tools are simply absent, and the
  // natural conclusion is that order entry is broken.
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400));
  // The settings FILE, not the environment: STOCKBIT_TRADING can only lower the mode, never raise
  // it (ADR-0008), so `paper` on an `off` file stays off.
  writeFileSync(settingsPath(), JSON.stringify({ version: 2, trading: { mode: "paper" } }), "utf8");
  try {
    const report = await collectStatus({
      profileLabel: "core",
      profileIsDefault: true,
      missingTools: ["order_preview", "order_buy", "order_sell", "order_cancel", "order_amend", "pine_script"],
    });
    assert.equal(report.trading.enabled, true, "trading really is on");
    assert.ok(
      report.checks.some((c) => c.name === "trading tools" && c.status === "warn"),
      "and the absence of the tools must be a check of its own",
    );
    assert.match(report.nextStep, /STOCKBIT_TOOLS=core,trading/, "nextStep must give the exact value to set");
  } finally {
    rmSync(settingsPath(), { force: true });
    clearAllSlots();
  }
});

test("the 'no order tools at all' claim is measured against every order tool, amend included", async () => {
  // `order_amend` is a destructiveHint write that changes a live order on the exchange. It is
  // deliberately not part of the TRIGGER — amend without preview and buy is not a coherent state to
  // warn about on its own — but saying "no order-entry tools at all" while one is registered is the
  // report asserting something false.
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400));
  writeFileSync(settingsPath(), JSON.stringify({ version: 2, trading: { mode: "paper" } }), "utf8");
  try {
    const withAmend = await collectStatus({
      profileLabel: "core,order_amend",
      missingTools: ["order_preview", "order_buy", "order_sell", "order_cancel"],
    });
    const row = withAmend.checks.find((c) => c.name === "trading tools");
    assert.ok(row, "the warning still fires — you cannot place an order");
    assert.doesNotMatch(row!.detail, /at all/, "but order_amend IS registered, so not 'at all'");

    // e-IPO subscription is order entry too. `eipo_order` is a destructiveHint write that commits
    // real money out of the RDN and is gated on the same `policy.enabled`, and `instructions.ts`
    // counts it — so leaving it out of this list made the report say "no order-entry tools at all"
    // on the very server whose instructions page opened with "PLACING AN ORDER IS TWO STEPS,
    // ALWAYS: eipo_order_preview…". The fixtures below are the reason that was invisible: they
    // never mentioned an e-IPO tool, so the principle this test encodes passed while the report
    // contradicted it.
    const withEipo = await collectStatus({
      profileLabel: "eipo",
      missingTools: ["order_preview", "order_buy", "order_sell", "order_cancel", "order_amend"],
    });
    assert.doesNotMatch(
      withEipo.checks.find((c) => c.name === "trading tools")!.detail,
      /at all/,
      "eipo_order is registered under this profile, so 'no order-entry tools at all' is false",
    );

    const none = await collectStatus({
      profileLabel: "core",
      missingTools: [
        "order_preview",
        "order_buy",
        "order_sell",
        "order_cancel",
        "order_amend",
        "eipo_order_preview",
        "eipo_order",
      ],
    });
    assert.match(
      none.checks.find((c) => c.name === "trading tools")!.detail,
      /at all/,
      "with every one of them missing, 'at all' is exactly right",
    );
  } finally {
    rmSync(settingsPath(), { force: true });
    clearAllSlots();
  }
});

test("trading off with no trading tools registered is not worth mentioning", async () => {
  // Nothing is wrong: order entry is off, and the tools for it are absent. Warning here would train
  // people to ignore the warning that matters.
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400));
  const report = await collectStatus({
    profileLabel: "core",
    profileIsDefault: true,
    missingTools: ["order_preview", "order_buy", "order_sell", "order_cancel"],
  });
  assert.equal(report.trading.mode, "off");
  assert.equal(report.checks.some((c) => c.name === "trading tools"), false);
  clearAllSlots();
});

test("a family with nothing registered is named, with the exact env value that adds it back", async () => {
  // The trap this closes: under `core`, all seventeen `chartbit` tools are withheld. Asking for one
  // got the SDK's bare "not found", and `STOCKBIT_TOOLS` was named nowhere in this report except
  // the trading branch — so finding the fix meant reading the FAMILIES array out of `dist/`.
  clearAllSlots();
  const report = await collectStatus({
    profileLabel: "core",
    profileIsDefault: true,
    missingTools: ["chartbit_draw", "chartbit_save"],
    missingFamilies: ["chartbit", "corpaction"],
  });
  assert.deepEqual(report.server.withheldFamilies, ["chartbit", "corpaction"]);

  const text = formatStatus(report);
  assert.match(text, /chartbit, corpaction/, "the withheld families must be named");
  assert.match(text, /STOCKBIT_TOOLS=core,<family>/, "and the exact value that adds one back");
  // FAMILIES, not tools — `screener` is both a withheld family and a registered tool, so a reader
  // who takes these for tool names is being misled by a report whose point is not misleading them.
  assert.match(text, /family names, not tool names/);

  // A fact, not a fault. The trading warn above fires on a genuine contradiction; a default install
  // that withheld nothing the user asked for must not carry a permanent warning.
  assert.equal(report.checks.some((c) => c.status !== "ok" && /famil/i.test(c.name)), false);
  clearAllSlots();
});

test("withholding nothing says nothing — the profile line stays bare", async () => {
  clearAllSlots();
  const report = await collectStatus({ profileLabel: "all" });
  assert.equal(report.server.withheldFamilies, undefined, "absent, not an empty array");
  assert.doesNotMatch(formatStatus(report), /have nothing registered/);
  clearAllSlots();
});

test("an expired token says so rather than reporting a negative countdown as health", async () => {
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) - 86400));
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.expired, true);
    assert.match(report.nextStep, /log/i, "an expired session needs the same next step as a missing one");
    assert.ok(report.checks.some((c) => c.name === "market-data session" && c.status === "fail"));
  } finally {
    clearAllSlots();
  }
});

test("STOCKBIT_TRADING=off is reported as env-off, with the reason", async () => {
  clearAllSlots();
  process.env.STOCKBIT_TRADING = "off";
  try {
    const report = await collectStatus();
    assert.equal(report.trading.enabled, false);
    assert.equal(report.trading.source, "env-off");
    assert.match(report.trading.reason, /environment/i);
  } finally {
    delete process.env.STOCKBIT_TRADING;
  }
});

test("the live check is explicitly not run unless it is asked for", async () => {
  clearAllSlots();
  const report = await collectStatus();
  const live = report.checks.find((c) => c.name === "live check");
  assert.ok(live);
  assert.equal(live.status, "warn");
  assert.match(live.detail, /Not run/);
});

test("live: true actually makes a request, even when the access cache is warm", async () => {
  // The worst kind of bug: a check that reports success without checking. `collectStatus` proved
  // liveness with `ensureFresh`, which consults the shared access cache before it ever reaches the
  // wire — so in a fresh process with a warm cache, `--verify` / `live: true` made ZERO requests and
  // still reported "The stored token refreshed against Stockbit". A user could revoke their session
  // from Stockbit's own web UI and be told, for the next 24 hours, that it was fine.
  //
  // Worse, the tool description tells the model this costs the user their website session and to ask
  // permission first. Spending that consent on a no-op is the part that makes it indefensible.
  clearAllSlots();
  clearAccessCache();
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  getStore("main").set(token);

  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(
      JSON.stringify({ data: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600) } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    // Warm the cache the way any ordinary tool call would.
    await collectStatus({ live: true });
    assert.equal(requests, 1, "precondition: the first live check refreshes");

    requests = 0;
    resetSession();
    const report = await collectStatus({ live: true });
    assert.equal(requests, 1, "a second live check must ALSO refresh — that is what live: true means");
    assert.ok(report.checks.some((c) => c.name === "live check" && c.status === "ok"));
  } finally {
    globalThis.fetch = real;
    clearAccessCache();
    clearAllSlots();
    resetSession();
  }
});

test("an unparsable STOCKBIT_TOOLS is diagnosed, not papered over", async () => {
  // This is the state `status` exists for. An unparsable value makes `stockbit-mcp` refuse to start,
  // so the user is looking at a client that says the server failed and running this to find out
  // why. Reporting a toolProfile as though a server were running answers the wrong question with a
  // fact that is not true — and every other line about sessions is advice they cannot act on until
  // the server starts.
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86_400));
  try {
    const report = await collectStatus({ profileError: 'unknown family or tool "nonsense"' });
    assert.equal(report.server.toolProfile, "unparsable", "it must not name a profile it does not have");
    assert.ok(
      report.checks.some((c) => c.name === "tool profile" && c.status === "fail"),
      "and it is a failure, not a warning — nothing works at all",
    );
    assert.match(report.nextStep, /STOCKBIT_TOOLS/, "nextStep must point at the variable");
    assert.match(report.nextStep, /nonsense/, "and quote what was wrong with it");
    assert.doesNotMatch(
      report.nextStep,
      /trading-login/,
      "advice about sessions is unreachable until the server starts",
    );
  } finally {
    clearAllSlots();
  }
});

test("a login in progress is reported, and forgotten when it finishes", async () => {
  clearAllSlots();
  loginStarted(new Date("2026-08-25T02:00:00Z"));
  let report = await collectStatus();
  assert.equal(report.login.inProgress, true);
  assert.equal(report.login.startedAt, "2026-08-25T02:00:00.000Z");

  loginFinished("captured");
  report = await collectStatus();
  assert.equal(report.login.inProgress, false);
  assert.equal(report.login.lastResult, "captured");
});

test("the terminal rendering says the same things as the structure", async () => {
  clearAllSlots();
  const report = await collectStatus({ now: new Date("2026-08-25T03:00:00Z") });
  const text = formatStatus(report);
  assert.ok(text.includes(report.server.version));
  assert.ok(text.includes(report.nextStep));
  assert.ok(text.includes(report.market.phase));
});

/* ------------------------------ how old is my login? ------------------------------ */

/**
 * The question users actually ask, which had no answer.
 *
 * Three clocks were already on screen and none of them is the login: the web session's CAPTURE time
 * (which moves every time a chart opens), the access token's 24h expiry, and the refresh token's
 * ~7d deadline. Someone asking "how old is my login" was reading one of those and drawing the wrong
 * conclusion. `loggedInAt` is written once, by the login itself.
 *
 * It is deliberately NOT a countdown. A login has no fixed lifetime — the refresh token slides
 * forward on every use — so a three-week-old login can be perfectly healthy while yesterday's is
 * dead. Age is a fact; the expiry is the deadline. The tests keep those two apart.
 */

function writeProfile(loggedInAt: string | undefined, browserPath = "/tmp/chrome"): void {
  writeFileSync(
    join(STORE, "browser-profile.json"),
    JSON.stringify({
      browserPath,
      browserName: "chrome",
      family: "chromium",
      ...(loggedInAt === undefined ? {} : { loggedInAt }),
    }),
  );
}

test("the login age is reported in hours, alongside the timestamp it came from", async () => {
  const at = new Date(Date.now() - 5 * 3_600_000).toISOString();
  writeProfile(at);

  const report = await collectStatus();
  assert.equal(report.store.loggedInAt, at);
  assert.ok(report.store.loginAgeHours !== null);
  assert.ok(Math.abs(report.store.loginAgeHours! - 5) < 0.1, "about five hours");
  assert.match(formatStatus(report), /Last login\s+5\.\d hour\(s\) ago/);
});

test("a login under an hour old reads in minutes, not '0.2 hours'", async () => {
  writeProfile(new Date(Date.now() - 12 * 60_000).toISOString());
  assert.match(formatStatus(await collectStatus()), /Last login\s+1[12] minute\(s\) ago/);
});

test("a login older than two days reads in days", async () => {
  writeProfile(new Date(Date.now() - 5 * 24 * 3_600_000).toISOString());
  assert.match(formatStatus(await collectStatus()), /Last login\s+5\.\d day\(s\) ago/);
});

test("a profile written before this field existed says so, rather than claiming an age", async () => {
  // The old record has no `loggedInAt`. Reporting that as 1970 — an age of fifty-six years — is
  // worse than saying it is unknown.
  writeProfile(undefined);
  const report = await collectStatus();
  assert.equal(report.store.loggedInAt, null);
  assert.equal(report.store.loginAgeHours, null);
  assert.match(formatStatus(report), /Last login\s+unknown/);
});

test("an unparseable timestamp is unknown, not an age", async () => {
  writeProfile("not-a-date");
  const report = await collectStatus();
  assert.equal(report.store.loginAgeHours, null);
  assert.doesNotMatch(formatStatus(report), /56 year|NaN|Invalid/);
});

test("no profile at all says never, and names the command", async () => {
  rmSync(join(STORE, "browser-profile.json"), { force: true });
  const report = await collectStatus();
  assert.equal(report.store.loggedInAt, null);
  assert.match(formatStatus(report), /Last login\s+never/);
  assert.match(formatStatus(report), /stockbit-auth login/);
});

test("the login age never leaks a token, like everything else in the report", async () => {
  writeProfile(new Date().toISOString());
  const serialised = JSON.stringify(await collectStatus());
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(serialised), false);
});

/* ------------------------------- auto-recovery ------------------------------- */

test("auto-recovery reports the whole conjunction, and is off by default", async () => {
  const report = await collectStatus();
  // Every field, because a reader that has to reassemble "can this happen?" from three booleans is
  // a reader who will get it wrong in the direction of assuming it will.
  assert.deepEqual(report.login.autoRecovery, {
    available: false,
    armed: false,
    optedIn: false,
    spent: false,
    running: false,
  });
});

test("the rendered status stays silent about recovery where it cannot happen", async () => {
  // Only the MCP server arms it. Printing "auto-recovery: off" into `stockbit-auth status` would
  // name a switch that does nothing in that process, and send the reader off to turn it on.
  assert.doesNotMatch(formatStatus(await collectStatus()), /Auto-recovery/);
});

test("the opt-in alone does not report recovery as available", async () => {
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  try {
    const auto = (await collectStatus()).login.autoRecovery;
    assert.equal(auto.optedIn, true);
    assert.equal(auto.armed, false);
    assert.equal(auto.available, false, "the env var grants nothing on its own");
  } finally {
    delete process.env.STOCKBIT_AUTO_RELOGIN;
  }
});
