/**
 * Harvested credentials must be proven before the CLI calls a login a success.
 *
 * The bug these tests exist for, measured on 2026-08-29 and 2026-08-30: four consecutive logins
 * printed "Session captured (harvested from the already-signed-in browser)" and then
 * "Session stored (valid ~6 day(s)) — you're set", while the stored credential was rejected by the
 * API with HTTP 401 on its very first request. `doctor` said "All checks passed" and `status`
 * showed six days remaining at the same time. Six intercepted captures in the same hours worked.
 *
 * Every diagnostic reporting healthy while nothing works is worse than a plain failure: it sends
 * the next hour of diagnosis in the wrong direction. The three checks below are what stops the
 * distinction from being lost again — the type that carries it, the decision that acts on it, and
 * the wiring that keeps the four capture routes labelled correctly.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-authcapture-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { captureNeedsProof, type CaptureMethod } from "../src/auth/login.ts";
import { settleLogin } from "../src/tools/system.ts";
import { collectStatus, loginStatus, resetLoginStatus } from "../src/status.ts";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearAccessCache } from "../src/auth/accesscache.ts";
import { clearWebSession } from "../src/auth/websession.ts";
import { clearSessionHealth } from "../src/auth/health.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const SRC = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/auth/${name}`, import.meta.url)), "utf8");
const BIN = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), "utf8");

/* ------------------------------- the decision ------------------------------- */

test("a harvested capture must be proven", () => {
  assert.equal(captureNeedsProof("harvested", false), true);
});

test("an intercepted capture is trusted, because proving it would rotate the token", () => {
  // Not laziness: the refresh endpoint rotates, and rotation invalidates the browser session the
  // login just established. That is why the unconditional proof was removed in the first place.
  assert.equal(captureNeedsProof("intercepted", false), false);
});

test("--verify proves either kind — an explicit request outranks the heuristic", () => {
  assert.equal(captureNeedsProof("intercepted", true), true);
  assert.equal(captureNeedsProof("harvested", true), true);
});

test("a capture of unknown provenance is proven, not assumed", () => {
  // Should not happen; `captureViaBrowserLogin` always sets a method beside `captured: true`.
  // But "we do not know where this came from" is exactly the case where assuming the happy path
  // is how the original bug existed.
  assert.equal(captureNeedsProof(undefined, false), true);
});

test("the truth table is exhaustive over CaptureMethod", () => {
  const methods: CaptureMethod[] = ["intercepted", "harvested"];
  for (const method of methods) {
    assert.equal(typeof captureNeedsProof(method, false), "boolean");
    assert.equal(captureNeedsProof(method, true), true, "--verify always proves");
  }
});

/* ------------------------------- the wiring ------------------------------- */

test("every capture route labels itself, and exactly one is a harvest", () => {
  // A route added later without a method would not compile — `accept` requires it — but a route
  // added with the WRONG method compiles fine and silently reintroduces the bug. This is the check
  // for that: the cookie read is the only harvest, and everything else is a live login response.
  const login = SRC("login.ts");
  const calls = [...login.matchAll(/accept\((?:refresh|token),\s*"([^"]+)",\s*"(\w+)"\)/g)]
    .map((m) => ({ via: m[1], method: m[2] }));

  assert.ok(calls.length >= 4, `expected every accept() call to carry a method, found ${calls.length}`);

  const harvests = calls.filter((c) => c.method === "harvested");
  assert.equal(harvests.length, 1, "exactly one route reads the browser's own cookie");
  assert.match(harvests[0].via, /harvested from the already-signed-in browser/);

  for (const call of calls.filter((c) => c.method !== "harvested")) {
    assert.equal(call.method, "intercepted", `route "${call.via}" is labelled ${call.method}`);
  }
});

test("the capture method survives into the result the CLI reads", () => {
  // `LoginResult` used to be `{ captured, refresh }` and dropped `via` on the floor, so `cmdLogin`
  // could not tell the two apart even though the login knew.
  const login = SRC("login.ts");
  assert.match(login, /export interface LoginResult\s*{[^}]*method\?: CaptureMethod/s);
  assert.match(login, /finish\(\{ captured: true, refresh, method \}\)/);
});

test("the login command routes its success message through the decision", () => {
  // The failure mode was structural: the reassuring message was the DEFAULT branch, reached
  // whenever --verify was absent. It must now be reachable only when no proof was required.
  const bin = BIN("stockbit-auth.ts");
  assert.match(bin, /captureNeedsProof\(result\.method, argv\.includes\("--verify"\)\)/);

  const decisionAt = bin.indexOf("captureNeedsProof(result.method");
  const messageAt = bin.indexOf("— you're set. Run stockbit-mcp.");
  assert.ok(decisionAt > 0 && messageAt > decisionAt,
    "the 'you're set' message must sit inside the branch the decision guards");
});

test("a failed proof of a harvested token explains the cause and the remedy", () => {
  // "the test refresh failed" is a true statement that helps nobody. The person reading it needs
  // to know that nothing logged in, and that clearing the profile is what fixes it.
  const bin = BIN("stockbit-auth.ts");
  assert.match(bin, /does NOT work/);
  assert.match(bin, /stockbit-auth logout/);
  assert.match(bin, /Session captured \(intercepted\)/);
});

/* ------------------------------- doctor's claim ------------------------------- */

test("doctor no longer lets 'All checks passed' stand unqualified", () => {
  // Its checks exercise the login machinery — drivable browser, interception, cookie read and
  // clear — and none of them spends the stored token. The summary now says so, because that line
  // has already been read as proof of something it never tested.
  const bin = BIN("stockbit-auth.ts");
  const summaryAt = bin.indexOf("All checks passed.");
  assert.ok(summaryAt > 0);
  const after = bin.slice(summaryAt, summaryAt + 900);
  assert.match(after, /not the stored credential/);
  assert.match(after, /status --verify/);
});

/* ------------------------- the MCP tool's own decision ------------------------- */
//
// Everything above is the CLI. The MCP `login` tool had the same bug and none of the same
// defences: it mapped `captured: true` straight to the string "captured" and never read
// `result.method`, so `captureNeedsProof` — extracted precisely so the decision could be tested —
// had exactly one caller, in a bin. Measured on 2026-08-30: the same call twice, nine minutes
// apart, against a browser session that was healthy both times. Both reported "captured" in under
// three seconds with no human interaction. One token worked; the other 401'd on every request.

/** A syntactically real JWT with the given `exp`. Signature is nonsense; nothing here verifies it. */
function jwt(expSeconds: number, tag = "x"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, tag })}.c2ln`;
}

/** Anything that looks like a JWT. Deliberately loose — a partial leak is still a leak. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Seed a stored credential and answer the refresh route with `respond`. Returns the call count. */
function refreshAnswers(respond: () => Response | Promise<Response>): { calls: number } {
  const seen = { calls: 0 };
  globalThis.fetch = (async (url: unknown) => {
    if (!String(url).includes("/login/refresh")) return new Response("not found", { status: 404 });
    seen.calls++;
    return await respond();
  }) as typeof fetch;
  return seen;
}

function freshSession(): void {
  resetLoginStatus();
  resetSession();
  clearAccessCache();
  clearWebSession();
  clearSessionHealth();
  getStore("main").set(jwt(2000000000, "stored-refresh"));
}

test("a capture that produced no token is not called a login", async () => {
  freshSession();
  await settleLogin({ captured: false });
  assert.equal(loginStatus().lastResult, "no-token");
});

test("an intercepted capture is called captured without spending a request", async () => {
  // The asymmetry is the point. Proving an intercepted token costs a rotation, and rotation
  // invalidates the browser session the login just established — which is why the unconditional
  // proof was removed. This asserts the cheap half stays cheap.
  freshSession();
  const seen = refreshAnswers(() => new Response("{}", { status: 200 }));
  try {
    await settleLogin({ captured: true, method: "intercepted" });
    assert.equal(loginStatus().lastResult, "captured");
    assert.equal(seen.calls, 0, "an intercepted capture must not be proven, and must not rotate");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a harvested capture Stockbit accepts is called captured, and it cost a request", async () => {
  freshSession();
  const seen = refreshAnswers(
    () =>
      new Response(
        JSON.stringify({
          data: { access_token: jwt(2000000000, "access"), refresh_token: jwt(2000000000, "rotated") },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  try {
    await settleLogin({ captured: true, method: "harvested" });
    assert.equal(loginStatus().lastResult, "captured");
    assert.equal(seen.calls, 1, "a claim that the credential works must be backed by a request");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a harvested capture Stockbit rejects is NOT called captured", async () => {
  // The whole bug. "captured" used to mean bytes were written to the store, which is a different
  // claim from "a credential Stockbit accepts" — and only the second one is worth anything to a
  // caller deciding whether to retry.
  freshSession();
  const seen = refreshAnswers(
    () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
  );
  try {
    await settleLogin({ captured: true, method: "harvested" });
    const last = loginStatus().lastResult ?? "";
    assert.ok(last.startsWith("captured-but-rejected"), `expected a rejection, got ${last}`);
    assert.equal(seen.calls, 1);
    assert.doesNotMatch(last, JWT_SHAPED, "no outcome string may carry a token");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the tool proves a capture of unknown provenance too, rather than assuming", async () => {
  // `captureViaBrowserLogin` always sets a method. If that ever stops being true, the untrustworthy
  // branch is the safe one to land in.
  freshSession();
  const seen = refreshAnswers(
    () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
  );
  try {
    await settleLogin({ captured: true });
    assert.ok((loginStatus().lastResult ?? "").startsWith("captured-but-rejected"));
    assert.equal(seen.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 403 is a refusal too, not an unprovable credential", async () => {
  // `refreshOnce` labels every non-2xx `kind: "auth"`, so the kind cannot carry this distinction
  // and the status has to. 401 and 403 are what `kindForStatus` itself calls an auth failure;
  // testing only 401 would tell a user with a forbidden credential that nothing is known about it.
  freshSession();
  const seen = refreshAnswers(
    () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
  );
  try {
    await settleLogin({ captured: true, method: "harvested" });
    assert.ok((loginStatus().lastResult ?? "").startsWith("captured-but-rejected"));
    assert.equal(seen.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Stockbit outage is not reported as a rejection", async () => {
  // The other side of the same line, and the reason `kind` could not be used: a 500 also arrives as
  // `kind: "auth"`. Saying "Stockbit REJECTED this token — log in again" over an outage destroys a
  // credential that was fine.
  freshSession();
  const seen = refreshAnswers(() => new Response("upstream is down", { status: 502 }));
  try {
    await settleLogin({ captured: true, method: "harvested" });
    assert.ok((loginStatus().lastResult ?? "").startsWith("captured-unproven"));
    assert.equal(seen.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a proof that could not be made is not reported as a rejection", async () => {
  // `refreshOnce` writes a STATUS-LESS journal entry for a transport error, deliberately, so that
  // "Stockbit rejected this" stays distinguishable from "the network was down" — and only the
  // first of those means log in again. Collapsing them here would put that back: a dropped Wi-Fi
  // connection would tell the user their session was revoked.
  freshSession();
  globalThis.fetch = (async () => {
    throw new Error("network is unreachable");
  }) as typeof fetch;
  try {
    await settleLogin({ captured: true, method: "harvested" });
    const last = loginStatus().lastResult ?? "";
    assert.ok(last.startsWith("captured-unproven"), `expected an unproven outcome, got ${last}`);
    assert.doesNotMatch(last, /reject/i, "nothing rejected it; do not say Stockbit did");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rejected capture is a FAILING check in status, not just a string in a field", async () => {
  // The login tool cannot report this at its own call site — it returns before the person has
  // finished typing — so `status`, which is where that tool's closing message sends the user, is
  // the only place it can be unmissable. `lastResult` alone is a field a model may not read.
  freshSession();
  const seen = refreshAnswers(
    () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
  );
  try {
    await settleLogin({ captured: true, method: "harvested" });
    const report = await collectStatus();
    const check = report.checks.find((c) => c.name === "last login");
    assert.ok(check, "a rejected login must produce a check");
    assert.equal(check.status, "fail");
    assert.doesNotMatch(JSON.stringify(report), JWT_SHAPED, "and the report still carries no token");
  } finally {
    globalThis.fetch = realFetch;
    freshSession();
  }
});

test("the MCP login tool routes its outcome through the same decision", () => {
  // The structural mirror of the bin test above. The bug was that this branch did not exist: the
  // reassuring outcome was unconditional, so `captureNeedsProof` guarded nothing here.
  const tool = readFileSync(fileURLToPath(new URL("../src/tools/system.ts", import.meta.url)), "utf8");
  assert.match(tool, /captureNeedsProof\(result\.method, false\)/);

  const decisionAt = tool.indexOf("captureNeedsProof(result.method");
  const rejectedAt = tool.indexOf("captured-but-rejected");
  assert.ok(
    decisionAt > 0 && rejectedAt > decisionAt,
    "the failure outcome must sit inside the branch the decision guards",
  );
});
