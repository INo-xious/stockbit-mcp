/**
 * Automatic login recovery: the gates, and the one attempt.
 *
 * Report #18, in the user's own words: "it has to be able to detect if the session ended and if the
 * refresh token doesn't work anymore, and rerun login." Every signal for that already existed and
 * none of them acted.
 *
 * What these tests protect is not that recovery WORKS — that needs a live Stockbit session and a
 * real browser — but that it never runs when it must not. Each gate is a separate test because each
 * closes a separate way of doing harm: opening a window nobody asked for, opening one during an
 * unattended nine-hour backfill, or spending a rotation on a session that is already dead.
 *
 * Every capture here is injected. If a browser window ever appears while this file runs, that is the
 * bug.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-relogin-"));
process.env.STOCKBIT_NO_UPDATE_CHECK = "1";

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  armAutoRelogin,
  attemptAutoRelogin,
  autoReloginAvailable,
  autoReloginOptedIn,
  autoReloginSpent,
  recordAutoReloginRefused,
  resetAutoReloginForTests,
  type ReloginDeps,
} from "../src/auth/relogin.ts";
import { forceRefresh, resetSession } from "../src/auth/session.ts";
import { loginStatus, resetLoginStatus } from "../src/status.ts";
import { acquireDirLock } from "../src/util/dirlock.ts";
import { stockbitPath } from "../src/paths.ts";
import { getStore } from "../src/auth/store.ts";
import { clearAccessCache } from "../src/auth/accesscache.ts";
import { StockbitError } from "../src/http/errors.ts";

after(() => rmSync(process.env.STOCKBIT_STORE_DIR!, { recursive: true, force: true }));

const ENV_KEYS = ["STOCKBIT_AUTO_RELOGIN", "STOCKBIT_NO_BROWSER"] as const;
beforeEach(() => {
  resetAutoReloginForTests();
  for (const key of ENV_KEYS) delete process.env[key];
});

/** A capture that would be a bug if it ever ran, plus a live web session and a moving store. */
function deps(over: Partial<ReloginDeps> = {}): ReloginDeps {
  let n = 0;
  return {
    webSessionLikelyValid: () => true,
    capture: async () => {
      throw new Error("the capture must not run in this test");
    },
    storedRefresh: () => `refresh-${n++}`,
    ...over,
  };
}

/** A capture that succeeds, and a store that visibly moves because of it. */
function workingCapture(): ReloginDeps {
  let stored = "old-refresh";
  return {
    webSessionLikelyValid: () => true,
    capture: async () => {
      stored = "new-refresh";
      return { captured: true, method: "harvested" };
    },
    storedRefresh: () => stored,
  };
}

/* ------------------------------- the three gates ------------------------------- */

test("disarmed by default — a process that never armed it never opens a window", async () => {
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const r = await attemptAutoRelogin("main", deps());
  assert.equal(r.outcome, "disarmed");
  assert.equal(r.attempted, false);
});

test("armed but not opted in does nothing", async () => {
  armAutoRelogin();
  const r = await attemptAutoRelogin("main", deps());
  assert.equal(r.outcome, "not-opted-in");
  assert.equal(r.attempted, false);
  assert.match(r.detail, /STOCKBIT_AUTO_RELOGIN/);
});

test("STOCKBIT_NO_BROWSER wins over the opt-in", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  process.env.STOCKBIT_NO_BROWSER = "1";
  const r = await attemptAutoRelogin("main", deps());
  assert.equal(r.outcome, "browser-suppressed");
  assert.equal(r.attempted, false);
});

test("the opt-in is parsed truthily, not `=== \"1\"`", () => {
  // Claude Desktop substitutes a ticked boolean setting as the STRING "true". An exact match against
  // "1" would read that as off, which is the mirror of the measured defect in `browserSuppressed`:
  // someone ticks the box and nothing happens.
  for (const on of ["1", "true", "TRUE", " True ", "yes", "on"]) {
    process.env.STOCKBIT_AUTO_RELOGIN = on;
    assert.equal(autoReloginOptedIn(), true, `${JSON.stringify(on)} should be on`);
  }
  for (const off of ["0", "false", "no", "off", ""]) {
    process.env.STOCKBIT_AUTO_RELOGIN = off;
    assert.equal(autoReloginOptedIn(), false, `${JSON.stringify(off)} should be off`);
  }
  delete process.env.STOCKBIT_AUTO_RELOGIN;
  assert.equal(autoReloginOptedIn(), false, "unset is off");
});

test("availability is the whole conjunction", () => {
  assert.equal(autoReloginAvailable(), false);
  armAutoRelogin();
  assert.equal(autoReloginAvailable(), false, "armed alone grants nothing");
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  assert.equal(autoReloginAvailable(), true);
  process.env.STOCKBIT_NO_BROWSER = "1";
  assert.equal(autoReloginAvailable(), false, "suppression still wins");
});

/* ------------------------------- preconditions ------------------------------- */

test("only the market-data slot may be recovered from the browser", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  for (const domain of ["securities", "eipo"] as const) {
    const r = await attemptAutoRelogin(domain, deps());
    assert.equal(r.outcome, "wrong-domain");
    assert.equal(r.attempted, false);
  }
});

test("a web session that is merely UNKNOWN does not authorise a window", async () => {
  // `likelyValid` and `expired` are not complements: `!likelyValid` is also true for "unknown",
  // where the credential simply could not be read. Gating on the negative is what made an earlier
  // check demand a fresh login daily on a session with six days left. Recovery requires the
  // POSITIVE verdict.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const r = await attemptAutoRelogin("main", deps({ webSessionLikelyValid: () => false }));
  assert.equal(r.outcome, "no-web-session");
  assert.equal(r.attempted, false);
});

/* --------------------------------- the latch --------------------------------- */

test("exactly one attempt per process, and a failure still spends it", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  let captures = 0;
  const d: ReloginDeps = {
    webSessionLikelyValid: () => true,
    capture: async () => {
      captures++;
      return { captured: false };
    },
    storedRefresh: () => "unchanged",
  };

  const first = await attemptAutoRelogin("main", d);
  assert.equal(first.outcome, "harvest-failed");
  assert.equal(captures, 1);

  const second = await attemptAutoRelogin("main", d);
  assert.equal(second.outcome, "already-attempted");
  assert.equal(captures, 1, "the browser must not open a second time");
  // Refresh tokens rotate and are single-use, and the proof of a harvest is itself a refresh that
  // stales the browser session the next harvest would read. A second attempt is not merely wasteful,
  // it starts from a worse position than the first.
  assert.match(second.detail, /rotat/i);
});

test("a THROWN capture still spends the attempt", async () => {
  // Otherwise a browser that always fails to start becomes the loop this module exists to prevent.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  let captures = 0;
  const d = deps({
    capture: async () => {
      captures++;
      throw new Error("browser did not start");
    },
  });
  const first = await attemptAutoRelogin("main", d);
  assert.equal(first.outcome, "harvest-failed");
  assert.equal(first.attempted, true);
  assert.equal((await attemptAutoRelogin("main", d)).outcome, "already-attempted");
  assert.equal(captures, 1);
});

test("the no-web-session GATE does not spend the attempt", async () => {
  // The latch used to be set before this check. Nothing is opened, rotated or written on this path,
  // so there is no attempt to have spent — and `webSessionHealth().likelyValid` is false for absent,
  // unknown, expired AND rejected, which is the common state at the moment of a first 401. Burning
  // it here disabled recovery for the whole process on one unreadable read, and `status` then
  // reported "already used its one attempt" for a process that had made none.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  let live = false;
  const d = deps({ webSessionLikelyValid: () => live, capture: async () => ({ captured: true }) });

  const blocked = await attemptAutoRelogin("main", d);
  assert.equal(blocked.outcome, "no-web-session");
  assert.equal(autoReloginSpent("main"), false, "a gate must not consume the one attempt");

  // The web session becomes readable — a chart call re-captured it, say. Recovery must still work.
  live = true;
  let stored = "old";
  const after = await attemptAutoRelogin("main", {
    webSessionLikelyValid: () => true,
    capture: async () => {
      stored = "new";
      return { captured: true };
    },
    storedRefresh: () => stored,
  });
  assert.equal(after.outcome, "harvested");
});

test("recovery stands aside while a login holds the profile lock", async () => {
  // Someone signing in has a window open and fifteen minutes to type. A background 401 must not
  // launch a second browser into that same profile.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const held = await acquireDirLock(stockbitPath("login.lock"), { staleMs: 60_000, timeoutMs: 0 });
  assert.ok(held, "precondition: the test holds the login lock");
  try {
    let captures = 0;
    // No injected `capture`, so the real lock is consulted.
    const r = await attemptAutoRelogin("main", {
      webSessionLikelyValid: () => true,
      storedRefresh: () => `refresh-${captures++}`,
    });
    assert.equal(r.outcome, "login-in-progress");
    assert.equal(r.attempted, false);
    // Standing aside is not an attempt: once the human's login finishes, recovery is still available.
    assert.equal(autoReloginSpent("main"), false);
  } finally {
    held!();
  }
});

test("a gate refusal does NOT spend the attempt", async () => {
  // A window was never opened and nothing was rotated, so there is nothing to have spent. Burning
  // the latch here would mean turning the switch on mid-session could never take effect.
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  await attemptAutoRelogin("main", deps());
  assert.equal(autoReloginSpent("main"), false);
  armAutoRelogin();
  const r = await attemptAutoRelogin("main", workingCapture());
  assert.equal(r.outcome, "harvested");
});

/* ------------------------------- what it claims ------------------------------- */

test("a capture that does not move the store is NOT a recovery", async () => {
  // Reporting success for a credential nothing wrote is issue #3 in a new place, and it would send
  // the retry straight back into the same dead token.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const r = await attemptAutoRelogin(
    "main",
    deps({ capture: async () => ({ captured: true, method: "harvested" }), storedRefresh: () => "same" }),
  );
  assert.equal(r.outcome, "harvest-failed");
  assert.match(r.detail, /did not change/);
});

test("a successful harvest does not claim to be proven", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const r = await attemptAutoRelogin("main", workingCapture());
  assert.equal(r.outcome, "harvested");
  assert.equal(r.attempted, true);
  // Nothing logged in, so the credential's expiry says nothing about whether Stockbit accepts it.
  // Four harvested credentials in a row were rejected on first use while login, doctor and status
  // all reported healthy. The caller's retry is the proof.
  assert.match(r.detail, /not been proven/i);
});

test("a capture error is redacted before it reaches the verdict", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.qqqq";
  const r = await attemptAutoRelogin(
    "main",
    deps({
      capture: async () => {
        // A `fetch` failure quotes the URL, and a URL here can carry a token.
        throw new Error(`fetch failed: https://exodus.stockbit.com/x?token=${secret}`);
      },
    }),
  );
  assert.equal(r.outcome, "harvest-failed");
  assert.ok(!r.detail.includes(secret), "no token may reach the verdict");
});

test("a recovery shows up in status as a login, and never claims to be captured", async () => {
  // `status` used to report no login in progress while a recovery had a window open on the user's
  // screen, and `login`'s lock refusal blamed "probably a terminal or a second client" for a lock
  // this same server was holding. A status that is confidently wrong about what the machine is
  // doing is worse than one that says nothing.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const r = await attemptAutoRelogin("main", workingCapture());
  assert.equal(r.outcome, "harvested");
  const after = loginStatus();
  assert.equal(after.inProgress, false, "the login it opened is closed again");
  assert.match(String(after.lastResult), /^auto-recovery: harvested$/);
  // NOT "captured". Nothing has proven it — that word is reserved for a credential Stockbit
  // accepted, and `status` renders `lastResult` verbatim to the user.
  assert.doesNotMatch(String(after.lastResult), /\bcaptured\b/);
});

test("a SUCCESSFUL recovery is not later reported as having failed", async () => {
  // The latch used to remember only THAT an attempt happened, so `already-attempted` covered a
  // recovery that worked. A fresh 401 hours later was then told recovery "did not fix it" — false,
  // it had — and pointed at signing the user out of Stockbit, on the strength of a website-session
  // reading taken before the harvest that replaced it.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const first = await attemptAutoRelogin("main", workingCapture());
  assert.equal(first.outcome, "harvested");

  const later = await attemptAutoRelogin("main", workingCapture());
  assert.equal(later.outcome, "already-recovered");
  assert.match(later.detail, /it worked/);
  assert.doesNotMatch(later.detail, /did not fix it/);
});

test("a 401 arriving WHILE a recovery runs is told nothing, not told it failed", async () => {
  // Not a narrow race. A dead session 401s every request already on the wire and the client runs
  // three at a time, so the second and third failures of one session death land inside this window
  // by construction — and the window is the whole capture.
  //
  // The latch is set to `failed` provisionally the moment an attempt starts, so reading it alone
  // told the concurrent caller that recovery "already ran and did not fix it" — and pointed at
  // signing the user out of Stockbit — while the recovery it was describing went on to succeed.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";

  let releaseCapture: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  let stored = "old";
  const slow = attemptAutoRelogin("main", {
    webSessionLikelyValid: () => true,
    capture: async () => {
      await held;
      stored = "new";
      return { captured: true };
    },
    storedRefresh: () => stored,
  });

  // Yield so the in-flight attempt reaches its capture.
  await new Promise((r) => setImmediate(r));

  const concurrent = await attemptAutoRelogin("main", workingCapture());
  assert.equal(concurrent.outcome, "recovery-in-flight");
  assert.equal(concurrent.attempted, false);
  assert.doesNotMatch(concurrent.detail, /did not fix it/);

  releaseCapture!();
  assert.equal((await slow).outcome, "harvested", "the attempt it was describing did in fact work");
});

test("a harvest the PROOF then refused is remembered as a failure, not a success", async () => {
  // `attemptAutoRelogin` can only report what the harvest did; whether Stockbit accepts the
  // credential is settled one frame up, by the caller's retry. Without the caller telling the latch,
  // a harvest that was then refused would be remembered as "it worked", and the next failure in the
  // process would be told recovery had succeeded — the false-history defect through the other door.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const first = await attemptAutoRelogin("main", workingCapture());
  assert.equal(first.outcome, "harvested");

  recordAutoReloginRefused("main");

  const later = await attemptAutoRelogin("main", workingCapture());
  assert.equal(later.outcome, "already-attempted");
  assert.match(later.detail, /did not fix it/);
});

test("recording a refusal cannot invent an attempt that never happened", async () => {
  // It downgrades an existing entry; it must never create one, or a proof failure would spend an
  // attempt that recovery never made.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  recordAutoReloginRefused("main");
  assert.equal(autoReloginSpent("main"), false);
  assert.equal((await attemptAutoRelogin("main", workingCapture())).outcome, "harvested");
});

test("a FAILED recovery is still reported as having failed", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const d = deps({ capture: async () => ({ captured: false }), storedRefresh: () => "unchanged" });
  assert.equal((await attemptAutoRelogin("main", d)).outcome, "harvest-failed");
  const later = await attemptAutoRelogin("main", d);
  assert.equal(later.outcome, "already-attempted");
  assert.match(later.detail, /did not fix it/);
});

test("no verdict ever carries a JWT", async () => {
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  const r = await attemptAutoRelogin("main", workingCapture());
  assert.doesNotMatch(JSON.stringify(r), /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
});

/* ------------------- escalation, through the real forceRefresh ------------------- */

function jwt(exp: number, tag = "x"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, tag })}.sig`;
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  getStore("main").clear();
  resetSession();
});

/** Every refresh is refused, which is the state a dead session is actually in. */
async function whenRefreshIsRefused(fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = (async (url: unknown) => {
    if (!String(url).includes("/login/refresh")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }) as typeof fetch;
  getStore("main").set(jwt(2_000_000_000, "stored"));
  resetSession();
  clearAccessCache("main");
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    getStore("main").clear();
    resetSession();
    clearAccessCache("main");
  }
}

test("in a disarmed process the 401 is unchanged — batch fails fast and quietly", async () => {
  await whenRefreshIsRefused(async () => {
    const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof StockbitError);
    assert.equal(err.kind, "auth");
    // A nine-hour unattended backfill must not have every failure padded with advice about a
    // recovery mode it cannot use.
    assert.doesNotMatch(err.message, /switch_account/);
  });
});

test("a rejected credential with recovery switched off names the switch, and ONLY the switch", async () => {
  armAutoRelogin();
  await whenRefreshIsRefused(async () => {
    const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof StockbitError);
    assert.match(err.message, /STOCKBIT_AUTO_RELOGIN/, "names the switch the user asked for");
    // NOT the switch_account advice. Nothing looked at the website session on this path — the
    // opt-in gate returns before that read — so claiming a plain login cannot work would be a
    // verdict on evidence that was never gathered.
    assert.doesNotMatch(err.message, /switch_account/);
    // Still an auth error carrying its status, not a new kind of failure.
    assert.equal(err.kind, "auth");
    assert.equal(err.status, 401);
  });
});

test("when recovery LOOKED and the website session is unusable, it escalates to switch_account", async () => {
  // Issue #7. With a stale website session Stockbit shows an expiry modal and closes the window
  // before the user can type, so a plain login was measured failing 4 times out of 4 while
  // switch_account worked every time. Naming the wrong one is what cost the reporter the session.
  //
  // Opted in and armed, so recovery runs its checks — and the store directory has no website
  // session, so `likelyValid` is false and the outcome rests on an actual read.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  try {
    await whenRefreshIsRefused(async () => {
      const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof StockbitError);
      assert.match(err.message, /switch_account/);
      assert.match(err.message, /signs that browser profile out/i);
      assert.equal(err.kind, "auth");
      assert.equal(err.status, 401);
    });
  } finally {
    delete process.env.STOCKBIT_AUTO_RELOGIN;
  }
});

test("a TRANSPORT failure is never reclassified as an auth failure", async () => {
  // The escalation used to build `new StockbitError("auth", …)` for every main refresh failure. But
  // `refreshOnce` also throws for the transport — kind `upstream` — and a dropped Wi-Fi is not a
  // stale browser session. `analyze.ts` and `company.ts` both branch on `kind === "auth"`, so this
  // turned a network blip into a dead-session report that offered to sign the user out to fix it.
  armAutoRelogin();
  getStore("main").set(jwt(2_000_000_000, "stored"));
  resetSession();
  clearAccessCache("main");
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof StockbitError);
    assert.notEqual(err.kind, "auth", "a transport failure must keep its own kind");
    assert.doesNotMatch(err.message, /switch_account/);
    assert.doesNotMatch(err.message, /STOCKBIT_AUTO_RELOGIN/);
  } finally {
    globalThis.fetch = realFetch;
    getStore("main").clear();
    resetSession();
    clearAccessCache("main");
  }
});

test("a Stockbit 5xx never triggers the destructive advice", async () => {
  // `refreshOnce` labels EVERY non-ok status on the refresh route `auth` — its ternary picks the
  // message, not the kind — so a 502 arrives at the escalation looking exactly like a refusal. The
  // kind test alone therefore let a partial outage, which clears by itself, be answered with
  // "sign your browser out of Stockbit". Only 401/403 means a credential was refused.
  armAutoRelogin();
  process.env.STOCKBIT_AUTO_RELOGIN = "1";
  getStore("main").set(jwt(2_000_000_000, "stored"));
  resetSession();
  clearAccessCache("main");
  globalThis.fetch = (async (url: unknown) => {
    if (!String(url).includes("/login/refresh")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ message: "Bad Gateway" }), { status: 502 });
  }) as typeof fetch;
  try {
    const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof StockbitError);
    assert.equal(err.status, 502);
    assert.doesNotMatch(err.message, /switch_account/, "an outage is not a reason to sign the user out");
    assert.doesNotMatch(err.message, /signs that browser profile out/i);
  } finally {
    delete process.env.STOCKBIT_AUTO_RELOGIN;
    globalThis.fetch = realFetch;
    getStore("main").clear();
    resetSession();
    clearAccessCache("main");
  }
});

test("a machine that never logged in is told to log in, and nothing else", async () => {
  // With no stored session the failure is "No Stockbit session stored". Recovery could not have
  // helped and no website session was ever examined, so neither the auto-recovery switch nor the
  // switch_account advice belongs here — the second would be a claim about a session that does not
  // exist, and it points a first-time user at a destructive flag.
  armAutoRelogin();
  getStore("main").clear();
  resetSession();
  clearAccessCache("main");
  const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof StockbitError);
  assert.match(err.message, /No Stockbit session stored/);
  assert.doesNotMatch(err.message, /switch_account/);
  assert.doesNotMatch(err.message, /STOCKBIT_AUTO_RELOGIN/);
});

test("the escalated error still carries no token", async () => {
  armAutoRelogin();
  await whenRefreshIsRefused(async () => {
    const err = await forceRefresh("main", jwt(2_000_000_000, "presented")).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof StockbitError);
    assert.doesNotMatch(err.message, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
  });
});

/* --------------------- the batch constraint, enforced not assumed --------------------- */

test("only the MCP server arms recovery — batch and the CLIs cannot", () => {
  // The hard constraint: "Do NOT auto-relogin inside stockbit-batch. A long unattended drip must
  // fail fast." Batch reaches `forceRefresh` through the same `src/http/client.ts` as everything
  // else and there is no run-mode marker anywhere in this repo, so a condition inside the auth layer
  // would have nothing to test. A capability the batch process never grants itself is the only
  // version of this that a later edit cannot quietly undo — which makes WHO CALLS `armAutoRelogin`
  // the security property, and therefore the thing a test has to pin.
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const callers: string[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "bin"))]) {
    const rel = file.slice(ROOT.length);
    // The definition itself, not a call.
    if (rel.endsWith("auth/relogin.ts")) continue;
    if (/\barmAutoRelogin\s*\(/.test(readFileSync(file, "utf8"))) callers.push(rel);
  }
  assert.deepEqual(callers, ["bin/stockbit-mcp.ts"]);
});
