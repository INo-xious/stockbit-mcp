/** The capability is absent, including when stale settings request it. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-no-money-"));
import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES, isPermitted } from "../src/http/transport.ts";
import { settingsPath } from "../src/settings.ts";
import { submitOrder } from "../src/trading/orders.ts";

const forbiddenNames = ["orderBuy", "orderSell", "orderAmend", "orderCancel", "eipoOrderPlace", "eipoOrderVerify"];
const forbiddenPaths = [
  ...["buy", "sell", "amend", "cancel", "amend/bulk", "bulk-cancel"].map((action) => `https://carina.stockbit.com/order/v2/${action}`),
  "https://api-sekuritas.stockbit.com/eipo/order",
  "https://api-sekuritas.stockbit.com/eipo/order/verify",
];

test("real-money endpoints are absent from the closed transport policy", () => {
  for (const name of forbiddenNames) assert.equal(Object.hasOwn(ROUTES, name), false, name);
  for (const url of forbiddenPaths) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(isPermitted(method, url), false, `${method} ${url}`);
    }
  }
  for (const route of Object.values(ROUTES)) {
    if (route.host !== "carina" && route.host !== "sekuritas") continue;
    if (route.method === "GET") continue;
    assert.match(route.template, /^\/(auth\/|partner\/eipo\/access_token$)/,
      `Securities non-GET route must only authenticate: ${route.template}`);
  }
});

test("legacy settings cannot submit even a fabricated order ticket", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No request may leave this test"); };
  try {
    for (const trading of [{ mode: "live", autoConfirm: true }, { enabled: true }, { mode: "off" }]) {
      writeFileSync(settingsPath(), JSON.stringify({ version: 2, trading }));
      await assert.rejects(() => submitOrder({ ticketId: "old-live-ticket", confirm: true }), /Real-money execution is permanently unavailable/);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});
