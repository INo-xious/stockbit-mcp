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
import { eipoLogPath, eipoOrderBody, placeEipoOrder, previewEipoOrder, readVerdict } from "../src/eipo/order.ts";
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
  grantShape: "field" as "field" | "link" | "missing",
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
  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000 });
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

test("Stockbit's own verify is read as accepted, refused, or unreadable — three answers", () => {
  assert.deepEqual(readVerdict({ data: { valid: true } }), { accepted: true });
  assert.equal(readVerdict({ data: { eligible: false, message: "quota exceeded" } }).accepted, false);
  assert.equal(readVerdict({ message: "You are not eligible for this offering" }).accepted, false);
  assert.equal(readVerdict({ data: { something: 1 } }).accepted, null, "unreadable is not a no");
});

/* ------------------------------------ the preview ------------------------------------ */

test("the preview's arithmetic and its summary state what is being committed", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 10, price: 700 });
  assert.equal(ticket.kind, "eipo");
  assert.equal(ticket.shares, 1000);
  assert.equal(ticket.amountIdr, 700_000);
  assert.match(ticket.summary, /SUBSCRIBE to BREN/);
  assert.match(ticket.summary, /Rp 700,000/);
  assert.match(ticket.summary, /allotment is often smaller/);
  assert.match(ticket.summary, /cannot be cancelled by selling/);
});

test("a refusal from Stockbit's own verification blocks the subscription", async () => {
  wire.verifyBody = { data: { valid: false, message: "subscription window closed" } };
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const check = ticket.checks.find((c) => c.name === "server_verified")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /window closed/);
  assert.match(ticket.summary, /CANNOT BE PLACED/);
});

test("a verification that cannot be read passes as unverified rather than blocking", async () => {
  wire.verifyBody = { data: { unexpected: true } };
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const check = ticket.checks.find((c) => c.name === "server_verified")!;
  assert.equal(check.ok, true);
  assert.equal(check.unverified, true);
  assert.match(ticket.warnings.join(" "), /not contradicted/);
});

test("a subscription larger than the RDN balance fails the funding check", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1000, price: 700 });
  const check = ticket.checks.find((c) => c.name === "rdn_sufficient")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /more than the Rp 25,000,000 available/);
});

test("lots and price are validated before any request goes out", async () => {
  sent.length = 0;
  await assert.rejects(() => previewEipoOrder({ emitenCode: "BREN", lots: 0, price: 700 }), /positive whole number/);
  await assert.rejects(() => previewEipoOrder({ emitenCode: "BREN", lots: 1, price: -1 }), /positive number/);
  assert.deepEqual(sent, []);
});

/* ------------------------------------ refusals ------------------------------------ */

async function refuses(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const before = sent.filter((s) => s.url.endsWith("/eipo/order")).length;
  await assert.rejects(fn, pattern);
  const after = sent.filter((s) => s.url.endsWith("/eipo/order")).length;
  assert.equal(after, before, "nothing may reach the subscription endpoint on a refused path");
}

test("trading off refuses the subscription and names the settings file", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  setPolicy({ mode: "off" });
  await refuses(() => placeEipoOrder({ ticketId: ticket.id, confirm: true }), /Trading is off/);
});

test("no confirmation, no subscription", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  await refuses(() => placeEipoOrder({ ticketId: ticket.id }), /without confirmation/);
  assert.ok(peek(ticket.id), "a refused call must not spend the ticket");
});

test("an expired ticket is refused rather than repriced", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  setClock(() => Date.parse(ticket.expiresAt) + 1);
  await refuses(() => placeEipoOrder({ ticketId: ticket.id, confirm: true }), /expired/);
});

test("a doctored ticket is caught by its own fingerprint", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  (peek(ticket.id) as { lots: number }).lots = 500;
  await refuses(() => placeEipoOrder({ ticketId: ticket.id, confirm: true }), /does not match its own fingerprint/);
});

test("a snapshot that cannot be read aborts before the subscription", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  wire.failDetailFrom = 1;
  detailCalls = 0;
  await refuses(() => placeEipoOrder({ ticketId: ticket.id, confirm: true }), /no way to tell whether this one landed/);
});

/* --------------------- elicitation is decisive here too (ADR-0010) --------------------- */

/**
 * The human channel, as the shared gate sees it.
 *
 * This file contained no occurrence of the word `elicit` before ADR-0010, so the whole channel was
 * untested on the one commitment in this project that cannot be undone by selling. Mirrors the
 * harness in `test/trading.test.ts` deliberately: one gate, so one shape of test.
 */
function fakeElicit(...answers: Array<"accepted" | "declined" | "unavailable" | { remember: true }>) {
  const calls: Array<{ message: string; prompt?: Record<string, unknown> }> = [];
  let index = 0;
  const elicit = async (message: string, prompt?: Record<string, unknown>) => {
    calls.push({ message, prompt });
    const answer = answers[Math.min(index++, answers.length - 1)];
    return typeof answer === "string"
      ? { answer, remember: false }
      : { answer: "accepted" as const, remember: true };
  };
  return { elicit, calls };
}

test("confirm: true cannot skip a declined elicitation on an IPO subscription either", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const asked = fakeElicit("declined");
  await refuses(
    () => placeEipoOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit }),
    /declined this subscription/,
  );
  assert.equal(asked.calls.length, 1, "the human must have been asked");
  assert.ok(peek(ticket.id), "and a refused call does not spend the ticket");
});

test("an elicited yes commits it, and the result says a person was asked", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 10, price: 700 });
  const asked = fakeElicit("accepted");
  const result = await placeEipoOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "accepted");
  const entry = JSON.parse(readFileSync(eipoLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "elicited");
  assert.equal(entry.elicitation, "accepted");
});

test("the subscription dialog says what an IPO is, not what an order is", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const asked = fakeElicit("accepted");
  await placeEipoOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(asked.calls[0].message, ticket.summary);
  assert.match(String(asked.calls[0].prompt?.title), /IPO subscription/);
  assert.match(String(asked.calls[0].prompt?.description), /RDN/);
  assert.match(String(asked.calls[0].prompt?.description), /cannot be cancelled by selling/);
});

test("no human reachable plus confirm: true proceeds, marked as unelicited", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const result = await placeEipoOrder({
    ticketId: ticket.id,
    confirm: true,
    elicit: fakeElicit("unavailable").elicit,
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "unavailable");
  const entry = JSON.parse(readFileSync(eipoLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "explicit-unelicited");
});

test("elicitation: required refuses a client that cannot ask, and names the way out", async () => {
  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000, elicitation: "required" });
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  await refuses(
    () => placeEipoOrder({ ticketId: ticket.id, confirm: true }),
    /--elicitation when-available/,
  );
});

test("the de-drifted refusal now carries the sentence the e-IPO copy had lost", async () => {
  // The duplicated gate's own wording had drifted: it never told a model not to set confirm on the
  // user's behalf, which is the single most load-bearing sentence in the whole refusal.
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  await refuses(() => placeEipoOrder({ ticketId: ticket.id }), /Do not set it on their behalf/);
});

test("a grant ticked on an exchange order does NOT waive an IPO subscription", async () => {
  // The grant store is one slot shared with `src/trading/orders.ts`, and the first implementation
  // bounded it by time, value and policy but not by what KIND of commitment it was. So a box ticked
  // on a cancellable share order silently waived the dialog for the one commitment in this project
  // that cannot be undone even by selling — and the person never saw the words about the allotment
  // possibly being smaller, because the dialog was never shown.
  const policy = tradingPolicy();
  grantRemember(policy, 10_000_000);

  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 }); // Rp 700,000
  assert.ok(ticket.amountIdr < 10_000_000, "well inside the grant's cap, so only the KIND bound can refuse it");

  const asked = fakeElicit("declined");
  await refuses(
    () => placeEipoOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit }),
    /declined this subscription/,
  );
  assert.equal(asked.calls.length, 1, "the human MUST have been asked despite the standing grant");
});

test("an IPO dialog never offers the waiver box", async () => {
  // It could not be honoured, and a box that does nothing tells the person they have answered for
  // next time when they have not.
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const asked = fakeElicit("accepted");
  await placeEipoOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(asked.calls[0].prompt?.remember, undefined);
});

test("an unplaceable subscription is refused before anyone is asked", async () => {
  // The same guard `passGates` has, on the same gate's other caller. An e-IPO ticket has six
  // failable checks — including the RDN balance — so without it a person could be asked to commit
  // money out of an account that does not have it, and only then be refused.
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1000, price: 700 });
  assert.equal(ticket.checks.find((c) => c.name === "rdn_sufficient")!.ok, false, "precondition");

  const asked = fakeElicit("accepted");
  await refuses(
    () => placeEipoOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit }),
    /cannot be placed: rdn_sufficient/,
  );
  assert.equal(asked.calls.length, 0, "nobody is asked to approve a subscription the ticket already blocks");
});

test("the tool layer wires the human channel through to the subscription", async () => {
  const reads = new Map<string, ToolHandler>();
  const writes = new Map<string, ToolHandler>();
  const asked = fakeElicit("declined");
  registerEipoTools({
    read: (name, _d, _s, handler) => {
      reads.set(name, handler);
    },
    write: (name, _d, _s, handler) => {
      writes.set(name, handler);
    },
    writeNames: () => [...writes.keys()],
    elicitDecision: asked.elicit,
  });

  const preview = await reads.get("eipo_order_preview")!({ emiten_code: "BREN", lots: 1, price: 700 });
  const ticketId = JSON.parse((preview as { content: Array<{ text: string }> }).content[0].text).data.id;

  const before = sent.filter((s) => s.url.endsWith("/eipo/order")).length;
  const placed = (await writes.get("eipo_order")!({ ticket_id: ticketId, confirm: true })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assert.equal(placed.isError, true);
  assert.match(placed.content[0].text, /declined this subscription/);
  assert.equal(asked.calls.length, 1);
  assert.equal(sent.filter((s) => s.url.endsWith("/eipo/order")).length, before, "nothing was committed");
});

/* --------------------------------- the outcomes --------------------------------- */

test("ok: recorded, and seen on the read-back", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 10, price: 700 });
  const result = await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.verified, true);
  assert.equal(result.logged, true);
});

test("the body is what the module documents, in lots", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 10, price: 700 });
  assert.deepEqual(eipoOrderBody(ticket), { emiten_code: "BREN", price: 700, lot: 10 });
  await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  const placed = sent.find((s) => s.url.endsWith("/eipo/order"))!;
  assert.deepEqual(placed.body, { emiten_code: "BREN", price: 700, lot: 10 });
});

test("not-visible: accepted but absent, and the user is told not to resend", async () => {
  wire.hideOrder = true;
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const result = await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "not-visible");
  assert.match(result.outcomeUnknown!, /Do NOT resend/);
});

test("landed-despite-error: the request failed and the subscription exists anyway", async () => {
  wire.dropPlaceResponse = "landed";
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const result = await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "landed-despite-error");
  assert.equal(result.verified, true);
});

test("outcome-unknown: the request failed and so did the read-back", async () => {
  wire.dropPlaceResponse = "lost";
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  detailCalls = 0;
  wire.failDetailFrom = 2;
  const result = await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "outcome-unknown");
  assert.match(result.outcomeUnknown!, /Do not resend/);
});

test("write-failed: a 4xx means nothing was committed", async () => {
  wire.rejectPlaceWith = { status: 400, body: { message: "lot below minimum" } };
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  const result = await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "write-failed");
  assert.equal(result.verified, false);
});

test("the audit line lands in the same log an exchange order writes to", async () => {
  const ticket = await previewEipoOrder({ emitenCode: "BREN", lots: 1, price: 700 });
  await placeEipoOrder({ ticketId: ticket.id, confirm: true });
  assert.ok(eipoLogPath().endsWith("order-mutations.log"), "one audit trail, whatever the venue");
  const lines = readFileSync(eipoLogPath(), "utf8").trim().split("\n");
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.venue, "eipo");
  assert.equal(entry.emitenCode, "BREN");
  assert.equal(entry.outcome, "ok");
});

/* ------------------------------------ the tools ------------------------------------ */

test("eight reads and one write, and the write is the only thing that commits money", () => {
  const reads = new Map<string, ToolHandler>();
  const writes: string[] = [];
  const definer: Definer = {
    read: (name, _d, _s, handler) => {
      reads.set(name, handler);
    },
    write: (name) => {
      writes.push(name);
    },
    writeNames: () => [...writes],
  };
  registerEipoTools(definer);
  assert.deepEqual(
    [...reads.keys()].sort(),
    [
      "eipo_detail",
      "eipo_list",
      "eipo_my_order",
      "eipo_order_preview",
      "eipo_price_groups",
      "eipo_rdn_balance",
      "eipo_status",
      "eipo_unboxing",
    ],
  );
  assert.deepEqual(writes, ["eipo_order"], "and it is not reachable from a saved workflow recipe");
});

test("the write's description says there is no undo and forbids a resend", () => {
  const descriptions = new Map<string, string>();
  registerEipoTools({
    read: () => {},
    write: (name, description) => {
      descriptions.set(name, description);
    },
    writeNames: () => [...descriptions.keys()],
  });
  const description = descriptions.get("eipo_order")!;
  assert.match(description, /no undo/i);
  assert.match(description, /confirm: true/);
  assert.match(description, /RESEND/);
});
