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
