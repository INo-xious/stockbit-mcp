/**
 * e-IPO: the third token domain, and the commitment that is not a trade.
 *
 * Two things here are unlike anything else in the project and most of the file is about them.
 *
 * The session is MINTED rather than logged in to — derived from the market-data login the user
 * already did, across two hosts, from a grant issued for a webview. That is a credential appearing
 * where there was none, so it happens in the open (`ensureEipoSession`) rather than as a side effect
 * inside the HTTP client, and it is asserted here that a read does not silently re-mint.
 *
 * And the subscription cannot be undone by selling, because the stock does not trade yet. So the
 * refusal tests matter more than the success ones, and each asserts that ZERO requests reached the
 * order endpoints.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-eipo-"));
delete process.env.STOCKBIT_TRADING;

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { hasStoredSession, resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { defaultSettings, settingsPath, tradingPolicy } from "../src/settings.ts";
import { clearTickets, peek, setClock, resetClock } from "../src/trading/tickets.ts";
import { forgetRemember, grantRemember } from "../src/trading/remember.ts";
import { findGrant, ensureEipoSession } from "../src/eipo/session.ts";
import { getMyOrder, getRdnBalance, listOfferings, normalizeEmiten } from "../src/eipo/api.ts";
import { registerEipoTools } from "../src/tools/eipo.ts";
import type { Definer, ToolHandler } from "../src/tools/_define.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* ------------------------------- the fake e-IPO host ------------------------------- */

const SECRET_ID = "9988776655443322";

const wire = {
  /** How the webview link answers: a token field, a link with one in its query, or neither. */
  grantShape: "field" as "field" | "link" | "missing" | "unavailable",
  /** Answer the place with this status instead of recording it. */
  rejectPlaceWith: null as null | { status: number; body: unknown },
  /** Fail the place at the socket. `landed` records it anyway; `lost` does not. */
  dropPlaceResponse: null as null | "landed" | "lost",
  /** Fail every order-detail read from the Nth call onward (retries are why it is "from"). */
  failDetailFrom: null as null | number,
  /** What Stockbit's own verify says. */
  verifyBody: { data: { valid: true } } as unknown,
  /** Record the subscription but never show it. */
  hideOrder: false,
};

let subscription: Record<string, unknown> | null = null;
let detailCalls = 0;
let mintCalls = 0;
const sent: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OFFERINGS = { data: { list: [{ emiten_code: "BREN", name: "Barito Renewables", price_min: 700 }] } };
const RDN = { data: { available: 25_000_000, balance: 30_000_000, internal_client_ref: SECRET_ID } };

before(() => {
  getStore("main").set("MAIN-REFRESH");
  resetSession();

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const path = new URL(u).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (path.includes("/login/refresh") || path.includes("/partner/refresh_token")) {
      return json({ data: { access_token: farFutureJwt() } });
    }
    if (path.includes("/auth/eipo/webview/link")) {
      if (wire.grantShape === "unavailable") return json({ message: "Unrecognized Command" }, 404);
      if (wire.grantShape === "missing") return json({ data: {} });
      return wire.grantShape === "link"
        ? json({ data: { link: "https://eipo.stockbit.com/open?token=GRANT-FROM-LINK&lang=id" } })
        : json({ data: { token: "GRANT-FROM-FIELD" } });
    }
    if (path.includes("/partner/eipo/access_token")) {
      mintCalls++;
      sent.push({ url: u, body });
      return json({ data: { access_token: farFutureJwt(), refresh_token: "EIPO-REFRESH" } });
    }

    if (path.includes("/eipo/order/verify")) {
      sent.push({ url: u, body });
      return json(wire.verifyBody);
    }
    if (path.includes("/eipo/order/detail")) {
      detailCalls++;
      if (wire.failDetailFrom !== null && detailCalls >= wire.failDetailFrom) {
        return new Response("upstream is down", { status: 503 });
      }
      return json({ data: wire.hideOrder ? null : subscription });
    }
    if (path.endsWith("/eipo/order")) {
      sent.push({ url: u, body });
      const row = { emiten_code: body.emiten_code, lot: body.lot, price: body.price, status: "SUBMITTED" };
      if (wire.rejectPlaceWith) return json(wire.rejectPlaceWith.body, wire.rejectPlaceWith.status);
      if (wire.dropPlaceResponse) {
        if (wire.dropPlaceResponse === "landed") subscription = row;
        throw new TypeError("socket hang up");
      }
      subscription = row;
      return json({ data: { status: "ok" } });
    }

    if (path.includes("/eipo/social/company/list")) return json(OFFERINGS);
    if (path.includes("/eipo/rdn_balance")) return json(RDN);
    if (path.includes("/eipo/status")) return json({ data: { status: "OPEN" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  resetClock();
  getStore("main").clear();
  getStore("eipo").clear();
});

function setPolicy(trading: Partial<ReturnType<typeof defaultSettings>["trading"]>): void {
  const settings = defaultSettings();
  settings.trading = { ...settings.trading, ...trading };
  mkdirSync(process.env.STOCKBIT_STORE_DIR!, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings), "utf8");
}

beforeEach(() => {
  clearCache();
  clearTickets();
  // Process memory shared with exchange orders, so it would otherwise leak between tests. No e-IPO
  // path can create one today — a subscription is never waivable — but the store is one slot and a
  // test that forgot this would pass for the wrong reason.
  forgetRemember();
  resetClock();
  resetSession();
  getStore("main").set("MAIN-REFRESH");
  getStore("eipo").clear();
  subscription = null;
  detailCalls = 0;
  mintCalls = 0;
  sent.length = 0;
  wire.grantShape = "field";
  wire.rejectPlaceWith = null;
  wire.dropPlaceResponse = null;
  wire.failDetailFrom = null;
  wire.verifyBody = { data: { valid: true } };
  wire.hideOrder = false;
  setPolicy({ mode: "off", maxOrderValueIdr: 100_000_000 });
});

/* ------------------------------------ the grant ------------------------------------ */

test("the grant is found in a token field, or in a link's query string", () => {
  assert.equal(findGrant({ data: { token: "abc" } }), "abc");
  assert.equal(findGrant({ data: { link: "https://x.test/open?access_token=xyz" } }), "xyz");
  assert.equal(findGrant({ data: { nested: { auth_token: "deep" } } }), "deep");
});

test("a token field wins over a link, and neither invents one", () => {
  assert.equal(findGrant({ data: { link: "https://x.test/?token=fromlink", token: "fromfield" } }), "fromfield");
  assert.equal(findGrant({ data: { link: "https://x.test/open" } }), undefined);
  assert.equal(findGrant({ data: {} }), undefined);
  assert.equal(findGrant(null), undefined);
});

test("the session is minted once, and a second read does not mint again", async () => {
  assert.equal(hasStoredSession("eipo"), false);
  const first = await ensureEipoSession();
  assert.equal(first.minted, true);
  assert.equal(getStore("eipo").get(), "EIPO-REFRESH", "the refresh token is persisted, not just held");

  const second = await ensureEipoSession();
  assert.equal(second.minted, false);
  assert.equal(mintCalls, 1, "minting reaches across two hosts and must not happen on every read");
});

test("a link-shaped grant mints just as well as a field-shaped one", async () => {
  wire.grantShape = "link";
  const result = await ensureEipoSession();
  assert.equal(result.minted, true);
  const exchange = sent.find((s) => s.url.includes("access_token"))!;
  assert.equal((exchange.body as { token: string }).token, "GRANT-FROM-LINK");
});

test("no grant at all is an auth error that names the fix, not a crash", async () => {
  wire.grantShape = "missing";
  await assert.rejects(() => ensureEipoSession(), /stockbit-auth login/);
});

/* ------------------------------------- the reads ------------------------------------- */

test("an emiten code is validated before it reaches a query string", () => {
  assert.equal(normalizeEmiten(" bren "), "BREN");
  assert.throws(() => normalizeEmiten("BR EN"), /not an emiten code/);
  assert.throws(() => normalizeEmiten(""), /not an emiten code/);
});

test("offering data is returned whole — it is public, and hiding a field loses information", async () => {
  const offerings = (await listOfferings()) as { list: Array<Record<string, unknown>> };
  assert.equal(offerings.list[0].emiten_code, "BREN");
  assert.equal(offerings.list[0].price_min, 700, "a field nobody named is still information here");
});

test("the RDN balance is projected, and an unrecognised field's VALUE does not cross the boundary", async () => {
  // The other half of the module's rule: this describes the user's money, not the offering.
  const rdn = await getRdnBalance();
  assert.equal(rdn.availableIdr, 25_000_000);
  assert.equal(rdn.readFrom.availableIdr, "available");
  const serialised = JSON.stringify(rdn);
  assert.ok(serialised.includes("internal_client_ref"), "the name is reported so drift is visible");
  assert.equal(serialised.includes(SECRET_ID), false, "the value is not");
});

test("no subscription is an answer, not an error", async () => {
  const mine = await getMyOrder("BREN");
  assert.equal(mine.order, null);
});

/* ----------------------------------- the verdict ----------------------------------- */

test("e-IPO exposes only the seven research and account reads", () => {
  const reads: string[] = [];
  const writes: string[] = [];
  registerEipoTools({ read: (name) => { reads.push(name); }, write: (name) => { writes.push(name); }, writeNames: () => writes });
  assert.deepEqual(reads.sort(), ["eipo_detail", "eipo_list", "eipo_my_order", "eipo_price_groups", "eipo_rdn_balance", "eipo_status", "eipo_unboxing"]);
  assert.deepEqual(writes, []);
});

test("an unavailable e-IPO handoff reports integration unavailability instead of asking for another login", async () => {
  wire.grantShape = "unavailable";
  await assert.rejects(() => listOfferings(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /handoff endpoint is unavailable/);
    assert.match(error.message, /ipo_pipeline/);
    assert.match(error.message, /do not repeatedly log in/);
    return true;
  });
  assert.equal(mintCalls, 0, "no speculative exchange or subscription request is attempted");
});
