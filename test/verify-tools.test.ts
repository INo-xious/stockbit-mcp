import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { summarizeVerificationFailure, verificationSkipReason } from "../scripts/verify-tools-policy.ts";

test("verification failure summaries never return account data or arbitrary upstream prose", () => {
  const secret = "account-owner@example.test portfolio BBRI 998877665544 balance 123456789";
  const failures = [
    summarizeVerificationFailure({ kind: "auth", status: 403, error: secret }, `Account permission denied: ${secret}`),
    summarizeVerificationFailure({ kind: secret, status: secret, code: secret }, secret),
    summarizeVerificationFailure(new Error(secret)),
    summarizeVerificationFailure({ kind: "upstream", status: 502 }, secret),
  ];
  for (const failure of failures) {
    assert.ok(!JSON.stringify(failure).includes(secret));
    assert.ok(!JSON.stringify(failure).includes("998877665544"));
    assert.ok(!JSON.stringify(failure).includes("example.test"));
  }
  assert.equal(failures[0].status, "blocked");
  assert.equal(failures[0].errorKind, "auth");
  assert.equal(failures[0].httpStatus, 403);
  assert.equal(failures[1].errorKind, undefined);
  assert.equal(failures[3].status, "failed");
  assert.equal(failures[3].httpStatus, 502);
  const unavailable = summarizeVerificationFailure({ kind: "not_found", status: 404 }, "The e-IPO session handoff is unavailable");
  assert.equal(unavailable.status, "blocked");
  assert.match(unavailable.note, /handoff endpoint is unavailable/);
});

test("verification excludes local settlement, ticket creation, workflows, and remote writes", () => {
  for (const name of ["paper_portfolio", "paper_orders", "paper_order_preview", "workflow_run", "chartbit_open", "alert_create"]) {
    assert.ok(verificationSkipReason(name, true), name);
  }
  for (const name of ["virtual_order", "virtual_activate", "watchlist_create"]) {
    assert.ok(verificationSkipReason(name, false), name);
  }
  for (const name of ["portfolio", "virtual_portfolio", "virtual_orders", "quote", "pine_script"]) {
    assert.equal(verificationSkipReason(name, true), undefined, name);
  }
});

test("CLI verification preserves user artifacts, skips paper state, and removes temporary renders", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const store = mkdtempSync(join(tmpdir(), "stockbit-verification-test-"));
  const localTmp = join(store, "temporary");
  const pine = join(store, "pine");
  const report = join(store, "coverage.json");
  mkdirSync(localTmp);
  mkdirSync(pine);
  mkdirSync(join(store, "paper"));
  const original = "USER FILE: must never be replaced by the sweep";
  const originalPine = join(pine, "BBRI-price.pine");
  const originalLedger = join(store, "paper", "ledger.json");
  writeFileSync(originalPine, original);
  writeFileSync(originalLedger, original);
  writeFileSync(report, "old report", { mode: 0o644 });
  try {
    const result = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "scripts/verify-tools.ts", "--live", "--only",
      "pine_script,paper_portfolio,paper_order_preview,workflow_run", "--output", report,
    ], {
      cwd: root,
      env: { ...process.env, TMPDIR: localTmp, STOCKBIT_STORE_DIR: store, STOCKBIT_FORCE_FILE_STORE: "1", STOCKBIT_NO_BROWSER: "1", STOCKBIT_NO_UPDATE_CHECK: "1" },
      timeout: 20_000,
    });
    const coverage = JSON.parse(readFileSync(report, "utf8"));
    const statuses = Object.fromEntries(coverage.tools.map((row: { name: string; status: string }) => [row.name, row.status]));
    assert.equal(statuses.pine_script, "passed");
    assert.equal(statuses.paper_portfolio, "not-run");
    assert.equal(statuses.paper_order_preview, "not-run");
    assert.equal(statuses.workflow_run, "not-run");
    assert.equal(readFileSync(originalPine, "utf8"), original);
    assert.equal(readFileSync(originalLedger, "utf8"), original);
    assert.deepEqual(readdirSync(pine), ["BBRI-price.pine"]);
    // tsx may maintain its own cache here; only this tool's private render directory must be gone.
    assert.deepEqual(readdirSync(localTmp).filter((name) => name.startsWith("stockbit-verification-")), []);
    assert.equal(statSync(report).mode & 0o777, 0o600);
    assert.ok(!result.stdout.includes(original));
  } finally { rmSync(store, { recursive: true, force: true }); }
});
