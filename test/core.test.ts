// Isolate the token store before importing anything that reads it.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-core-"));

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { getBrokerSummary, clearCache } from "../src/core/index.ts";
import { StockbitError } from "../src/http/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "broker_summary_BBRI.json"), "utf8"),
);

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/login/refresh")) {
      return new Response(JSON.stringify({ data: { access_token: farFutureJwt() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/marketdetectors/BBRI")) {
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/marketdetectors/DRIFT")) {
      // Valid envelope but missing broker_summary → must trip schema_drift.
      return new Response(JSON.stringify({ data: { unexpected: true } }), {
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

test("getBrokerSummary normalizes the real BBRI fixture (XL & XC are net sellers)", async () => {
  const s = await getBrokerSummary({ symbol: "BBRI", limit: 50 });
  assert.equal(s.symbol, "BBRI");
  assert.ok(s.sellers.length > 0 && s.buyers.length > 0);

  const codes = new Map(s.sellers.map((b) => [b.code, b]));
  assert.ok(codes.has("XL"), "XL present on sell side");
  assert.ok(codes.has("XC"), "XC present on sell side");
  // Sells are negative net value (IDR).
  assert.ok(codes.get("XL")!.netValueIdr < 0);
  assert.ok(codes.get("XC")!.netValueIdr < 0);
  // Foreign/local classification survives.
  assert.ok(["Asing", "Lokal", "Pemerintah"].includes(codes.get("XL")!.investorType ?? ""));
});

test("schema drift throws a typed StockbitError", async () => {
  clearCache();
  await assert.rejects(
    () => getBrokerSummary({ symbol: "DRIFT" }),
    (err: unknown) => err instanceof StockbitError && err.kind === "schema_drift",
  );
});
