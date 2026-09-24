/** Drawings save verification must distinguish an unchanged key from a persisted edit. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-chartbit-save-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { chartbitLogPath, saveChartDrawings } from "../src/chartbit/api.ts";
import { decodeLayoutContent, type StoredDrawings, type StoredSource } from "../src/chartbit/codec.ts";

const original: StoredSource = {
  key: "line-1",
  value: { type: "LineToolHorzLine", symbol: "IDX:BBRI", state: { text: "Old level", points: [{ time: 100, price: 3000 }] } },
};
const changed: StoredSource = {
  key: "line-1",
  value: { type: "LineToolHorzLine", symbol: "IDX:BBRI", state: { text: "New level", points: [{ time: 100, price: 3200 }] } },
};
const older: StoredSource = { key: "older-line", value: { type: "LineToolHorzLine", state: { text: "Keep this" } } };
const base = { layoutId: "8801", chartId: "1", symbol: "BBRI", confirm: true };
const realFetch = globalThis.fetch;
let stored: StoredDrawings;
let ignoreWrites = false;
let writeStatus = 200;
let writeCount = 0;
let transform: ((value: StoredDrawings) => StoredDrawings) | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function lastOutcome(): string {
  const lines = readFileSync(chartbitLogPath(), "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1)!).outcome;
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/login/refresh") {
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return json({ data: { access_token: `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig` } });
    }
    assert.equal(path, "/chartbit/chart-drawings", "only the mocked chart endpoint may be called");
    if ((init?.method ?? "GET") === "GET") return json({ data: { content: stored } });
    assert.equal(init?.method, "POST");
    writeCount++;
    if (!ignoreWrites) {
      const body = JSON.parse(String(init?.body));
      const payload = decodeLayoutContent(body.content) as StoredDrawings;
      const deletes = new Set((payload.deleted_sources ?? []).map(source => source.key));
      const updates = new Map(payload.sources.map(source => [source.key, source]));
      stored = {
        sources: [
          ...stored.sources.filter(source => !deletes.has(source.key) && !updates.has(source.key)),
          ...payload.sources,
        ],
        groups: payload.groups.length ? payload.groups : stored.groups,
      };
      if (transform) stored = transform(stored);
    }
    return json(writeStatus === 200 ? { data: { status: "ok" } } : { message: "write response failed" }, writeStatus);
  }) as typeof fetch;
});

beforeEach(() => {
  stored = structuredClone({ sources: [original, older], groups: [] });
  ignoreWrites = false;
  writeStatus = 200;
  writeCount = 0;
  transform = undefined;
  clearCache();
});

after(() => { globalThis.fetch = realFetch; });

test("ignored deletion-only save is unverified even though its requested source list is empty", async () => {
  ignoreWrites = true;
  const result = await saveChartDrawings({ ...base, sources: [], deletedSources: [{ key: original.key }] });
  assert.equal(result.verified, false);
  assert.equal(lastOutcome(), "not-persisted");
  assert.deepEqual(JSON.parse(readFileSync(result.snapshotPath, "utf8")), [original, older]);
  assert.equal(writeCount, 1, "verification never retries or restores over the chart");
});

test("ignored source update is unverified when the old state has the same entity key", async () => {
  ignoreWrites = true;
  const result = await saveChartDrawings({ ...base, sources: [changed] });
  assert.equal(result.verified, false);
  assert.equal(lastOutcome(), "not-persisted");
  assert.deepEqual(stored.sources[0], original);
});

test("changed values and requested deletions verify after JSON property reordering", async () => {
  transform = value => ({
    ...value,
    sources: value.sources.map(source => ({
      key: source.key,
      value: JSON.parse(JSON.stringify(source.value), (_key, nested) => {
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
          return Object.fromEntries(Object.entries(nested).reverse());
        }
        return nested;
      }),
    })),
  });
  const result = await saveChartDrawings({ ...base, sources: [changed], deletedSources: [{ key: older.key }] });
  assert.equal(result.verified, true);
  assert.equal(lastOutcome(), "ok");
  assert.deepEqual(stored.sources, [changed]);
  assert.equal(writeCount, 1);
});

test("verification permits unrelated sources while checking the exact values being edited", async () => {
  const result = await saveChartDrawings({ ...base, sources: [changed] });
  assert.equal(result.verified, true);
  assert.deepEqual(stored.sources, [older, changed]);
});

for (const operation of ["deletion", "update"] as const) {
  test(`an error with an ignored ${operation} cannot report landed-despite-error`, async () => {
    ignoreWrites = true;
    writeStatus = 503;
    await assert.rejects(() => saveChartDrawings({
      ...base,
      sources: operation === "update" ? [changed] : [],
      deletedSources: operation === "deletion" ? [{ key: original.key }] : [],
    }));
    assert.equal(lastOutcome(), "write-failed");
    assert.equal(writeCount, 1);
  });
}

test("an applied update and deletion are verified even if their response fails", async () => {
  writeStatus = 503;
  const result = await saveChartDrawings({ ...base, sources: [changed], deletedSources: [{ key: older.key }] });
  assert.equal(result.verified, true);
  assert.equal(lastOutcome(), "landed-despite-error");
  assert.deepEqual(stored.sources, [changed]);
  assert.equal(writeCount, 1);
});

test("verification compares the normalized wire source values", async () => {
  const source = { key: "generated-series", value: { id: "D4LkIE", state: { text: "Level" } } };
  const result = await saveChartDrawings({ ...base, sources: [source] });
  assert.equal(result.verified, true);
  assert.deepEqual(stored.sources.find(item => item.key === source.key)?.value, { id: "_seriesId", state: { text: "Level" } });
});

test("explicitly supplied groups must also match the stored state", async () => {
  ignoreWrites = true;
  const result = await saveChartDrawings({ ...base, sources: [original], groups: [{ id: "group-1", name: "Analysis" }] });
  assert.equal(result.verified, false);
  assert.equal(lastOutcome(), "not-persisted");
});
