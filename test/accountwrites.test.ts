/**
 * Watchlist and screener edits. ADR-0006.
 *
 * These are the mildest writes in the project and the tests are still mostly about refusals, for a
 * reason that is easy to miss: a watchlist is the universe several tools sweep. A symbol quietly
 * added changes what the next scan is about, and a list quietly deleted changes what the user is
 * shown without them ever asking why. Nothing here touches money; everything here changes what
 * later answers MEAN.
 *
 * The other theme is that a status code is never the answer. Every edit reads the account back and
 * reports what it actually saw — and when it cannot see, it says so rather than rolling back, because
 * an undo sent on a guess about a state we could not read is a second blind write.
 */
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-accountwrites-"));

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { accountLogPath } from "../src/account/log.ts";
import {
  addToWatchlist,
  createWatchlist,
  deleteWatchlist,
  favoriteWatchlist,
  removeFromWatchlist,
  renameWatchlist,
} from "../src/account/watchlist.ts";
import { buildSavedScreenBody, deleteScreen, favoriteScreen, saveScreen } from "../src/account/screener.ts";
import { buildScreenBody } from "../src/core/screenerrun.ts";
import { registerAccountWriteTools } from "../src/tools/account.ts";
import type { Definer, ToolHandler } from "../src/tools/_define.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* -------------------------------- the fake account -------------------------------- */

interface Row {
  watchlist_id: string;
  name: string;
  is_favorite?: boolean;
  members: Array<{ symbol: string; id: string }>;
}

let lists: Row[] = [];
let templates: Array<{ id: string; name: string; type: string; favorite: string }> = [];
const sent: Array<{ method: string; url: string; body: unknown }> = [];

const wire = {
  /** Accept the request and change nothing, so the read-back disagrees. */
  ignoreWrites: false,
  /** Answer writes with this status. */
  rejectWith: null as null | number,
  /** Fail the verification read from the Nth call onward (retries are why it is "from"). */
  failReadFrom: null as null | number,
};
let readCalls = 0;

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

before(() => {
  getStore("main").set("MAIN-REFRESH");
  resetSession();

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(u).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });

    if (method !== "GET") {
      sent.push({ method, url: u, body });
      if (wire.rejectWith !== null) return json({ message: "no" }, wire.rejectWith);
      if (!wire.ignoreWrites) applyWrite(method, path, body);
      return json({ data: { status: "ok" } });
    }

    if (path === "/watchlist") {
      readCalls++;
      if (wire.failReadFrom !== null && readCalls >= wire.failReadFrom) {
        return new Response("down", { status: 503 });
      }
      return json({ data: lists.map((l) => ({ watchlist_id: l.watchlist_id, name: l.name, is_favorite: l.is_favorite === true })) });
    }
    const detail = /^\/watchlist\/([^/]+)$/.exec(path);
    if (detail) {
      readCalls++;
      if (wire.failReadFrom !== null && readCalls >= wire.failReadFrom) {
        return new Response("down", { status: 503 });
      }
      const list = lists.find((l) => l.watchlist_id === detail[1]);
      if (!list) return new Response("not found", { status: 404 });
      return json({ data: { result: list.members.map((m) => ({ symbol: m.symbol, id: m.id })), total: list.members.length, name: list.name } });
    }
    if (path === "/screener/templates") {
      readCalls++;
      if (wire.failReadFrom !== null && readCalls >= wire.failReadFrom) {
        return new Response("down", { status: 503 });
      }
      return json({ data: templates });
    }
    if (path.startsWith("/emitten/") && path.endsWith("/info")) {
      const symbol = path.split("/")[2];
      return json({ data: { id: symbol === "TLKM" ? "7001" : "5901", name: symbol, price: "1000" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

/** What the fake account does when a write is accepted. */
function applyWrite(method: string, path: string, body: Record<string, unknown> | undefined): void {
  if (method === "POST" && path === "/watchlist") {
    lists.push({ watchlist_id: `${200 + lists.length}`, name: String(body?.name ?? ""), members: [] });
    return;
  }
  const rename = /^\/watchlist\/([^/]+)$/.exec(path);
  if (method === "PUT" && rename) {
    const list = lists.find((l) => l.watchlist_id === rename[1]);
    if (list) list.name = String(body?.name ?? list.name);
    return;
  }
  if (method === "DELETE" && rename) {
    lists = lists.filter((l) => l.watchlist_id !== rename[1]);
    return;
  }
  const add = /^\/watchlist\/([^/]+)\/company\/item$/.exec(path);
  if (method === "POST" && add) {
    const list = lists.find((l) => l.watchlist_id === add[1]);
    const companyId = String(body?.company_id ?? "");
    if (list) list.members.push({ symbol: companyId === "7001" ? "TLKM" : "BBRI", id: companyId });
    return;
  }
  const remove = /^\/watchlist\/([^/]+)\/company\/([^/]+)\/item$/.exec(path);
  if (method === "DELETE" && remove) {
    const list = lists.find((l) => l.watchlist_id === remove[1]);
    if (list) list.members = list.members.filter((m) => m.id !== remove[2]);
    return;
  }
  const favorite = /^\/watchlist\/favorite\/([^/]+)$/.exec(path);
  if (method === "PUT" && favorite) {
    for (const list of lists) list.is_favorite = list.watchlist_id === favorite[1];
    return;
  }
  if (method === "POST" && path === "/screener/templates") {
    templates.push({ id: `${400 + templates.length}`, name: String(body?.name ?? ""), type: "TEMPLATE_TYPE_CUSTOM", favorite: "0" });
    return;
  }
  const deleteTemplate = /^\/screener\/templates\/([^/]+)$/.exec(path);
  if (method === "DELETE" && deleteTemplate) {
    templates = templates.filter((t) => t.id !== deleteTemplate[1]);
    return;
  }
  if (path === "/screener/favorites") {
    const id = String(body?.template_id ?? "");
    const template = templates.find((t) => t.id === id);
    if (template) template.favorite = method === "POST" ? "1" : "0";
  }
}

after(() => {
  globalThis.fetch = realFetch;
  getStore("main").clear();
});

beforeEach(() => {
  clearCache();
  resetSession();
  getStore("main").set("MAIN-REFRESH");
  sent.length = 0;
  readCalls = 0;
  wire.ignoreWrites = false;
  wire.rejectWith = null;
  wire.failReadFrom = null;
  lists = [
    { watchlist_id: "101", name: "Main", is_favorite: true, members: [{ symbol: "BBRI", id: "5901" }] },
    { watchlist_id: "102", name: "Empty", members: [] },
  ];
  templates = [
    { id: "301", name: "My screen", type: "TEMPLATE_TYPE_CUSTOM", favorite: "0" },
    { id: "302", name: "Stockbit's own", type: "TEMPLATE_TYPE_GURU", favorite: "0" },
  ];
});

const RULES = [{ metric: "per", operator: "<" as const, value: 10 }];

/** Every refusal below must leave `sent` empty. That assertion IS the test. */
async function refuses(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  sent.length = 0;
  await assert.rejects(fn, pattern);
  assert.deepEqual(sent, [], "nothing may be written on a refused path");
}

/* ------------------------------------ watchlist ------------------------------------ */

test("every watchlist edit refuses without confirm, and sends nothing", async () => {
  await refuses(() => createWatchlist({ name: "New", confirm: false }), /confirm: true/);
  await refuses(() => renameWatchlist({ watchlistId: "101", name: "X", confirm: false }), /confirm: true/);
  await refuses(() => deleteWatchlist({ watchlistId: "102", confirm: false }), /confirm: true/);
  await refuses(() => addToWatchlist({ watchlistId: "101", symbol: "TLKM", confirm: false }), /confirm: true/);
  await refuses(() => removeFromWatchlist({ watchlistId: "101", symbol: "BBRI", confirm: false }), /confirm: true/);
  await refuses(() => favoriteWatchlist({ watchlistId: "102", confirm: false }), /confirm: true/);
});

test("creating a list is verified by re-listing, not by the response", async () => {
  const result = await createWatchlist({ name: "Coal", confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.verified, true);
  assert.equal(result.detail?.name, "Coal");
  assert.ok(result.detail?.id, "the id comes from the re-listing, which is where it is actually known");
});

test("a rename is checked against the name the account reports afterwards", async () => {
  const result = await renameWatchlist({ watchlistId: "101", name: "Core holdings", confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.detail?.name, "Core holdings");
});

test("adding a symbol resolves it to a company id first, and the ticker never reaches the wire", async () => {
  const result = await addToWatchlist({ watchlistId: "102", symbol: "tlkm", confirm: true });
  assert.equal(result.outcome, "ok");
  const write = sent.find((s) => s.method === "POST")!;
  assert.deepEqual(write.body, { company_id: "7001" }, "the wire takes an id, not a ticker");
  assert.equal(result.detail?.symbol, "TLKM");
});

test("removing a symbol that is not there is an answer, and sends nothing", async () => {
  await refuses(
    () => removeFromWatchlist({ watchlistId: "102", symbol: "BBRI", confirm: true }),
    /is not in watchlist/,
  );
});

test("removal addresses the company id the LIST holds, not one looked up separately", async () => {
  const result = await removeFromWatchlist({ watchlistId: "101", symbol: "BBRI", confirm: true });
  assert.equal(result.outcome, "ok");
  const write = sent.find((s) => s.method === "DELETE")!;
  assert.ok(write.url.includes("/company/5901/item"));
});

test("deleting a non-empty list refuses and NAMES THE COUNT", async () => {
  // The whole argument for the second flag: a model that has learned to pass `confirm: true` will
  // pass it here too, and 116 symbols would go with it.
  await refuses(() => deleteWatchlist({ watchlistId: "101", confirm: true }), /still holds 1 symbol/);
});

test("the second flag gets past it, and the count is reported back", async () => {
  const result = await deleteWatchlist({ watchlistId: "101", confirm: true, confirmDeleteMembers: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.detail?.deletedMembers, 1);
});

test("an empty list needs only the ordinary confirmation", async () => {
  const result = await deleteWatchlist({ watchlistId: "102", confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.detail?.deletedMembers, 0);
});

test("the favourite flag is read back from the field the index actually carries", async () => {
  const result = await favoriteWatchlist({ watchlistId: "102", confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.verified, true);
});

test("a malformed id is refused before it reaches a path segment", async () => {
  await refuses(() => renameWatchlist({ watchlistId: "../../etc", name: "x", confirm: true }), /not a watchlist id/);
  await refuses(() => createWatchlist({ name: "   ", confirm: true }), /needs a name/);
});

/* ------------------------------------ outcomes ------------------------------------ */

test("not-visible: the write was accepted and the account does not show it", async () => {
  wire.ignoreWrites = true;
  const result = await addToWatchlist({ watchlistId: "102", symbol: "TLKM", confirm: true });
  assert.equal(result.outcome, "not-visible");
  assert.equal(result.verified, false);
  assert.match(result.outcomeUnknown!, /Do not repeat it blindly/);
});

test("write-failed: a 4xx leaves the account alone", async () => {
  wire.rejectWith = 400;
  const result = await addToWatchlist({ watchlistId: "102", symbol: "TLKM", confirm: true });
  assert.equal(result.outcome, "write-failed");
  assert.equal(result.verified, false);
});

test("outcome-unknown: the write went out and the read-back failed", async () => {
  const result = await createWatchlist({ name: "Unknowable", confirm: true });
  assert.equal(result.outcome, "ok", "control: it works when the read-back works");

  // The cache is cleared so the pre-read hits the wire and the counter means what it says: call 1
  // is the read before the write, call 2 is the verification.
  clearCache();
  readCalls = 0;
  wire.failReadFrom = 2;
  const unknown = await createWatchlist({ name: "Unknowable 2", confirm: true });
  assert.equal(unknown.outcome, "outcome-unknown");
  assert.match(unknown.outcomeUnknown!, /Check in the Stockbit app rather than repeating it/);
});

test("nothing rolls back — the result says what happened and stops", async () => {
  // Deliberate: undoing a change we could not read means sending a delete on a guess, and if the
  // write actually worked that delete is the destructive operation.
  wire.ignoreWrites = true;
  sent.length = 0;
  await addToWatchlist({ watchlistId: "102", symbol: "TLKM", confirm: true });
  assert.equal(sent.filter((s) => s.method === "DELETE").length, 0, "no compensating write may be sent");
});

/* ------------------------------------ screener ------------------------------------ */

test("the saved body carries save:\"1\" and the ad-hoc one still cannot", () => {
  const saved = buildSavedScreenBody("Cheap", RULES);
  assert.equal(saved.save, "1");
  assert.equal(saved.name, "Cheap");
  assert.equal(buildScreenBody(RULES).save, "0", "the read path's literal is untouched");
});

test("the saved body reuses the ad-hoc validation rather than reimplementing it", () => {
  assert.throws(() => buildSavedScreenBody("x", []), /at least one rule/);
  assert.throws(() => buildSavedScreenBody("x", [{ metric: "", operator: "<", value: 1 }]), /non-empty metric/);
  assert.throws(() => buildSavedScreenBody("", RULES), /needs a name/);
});

test("saving posts to the write route and is verified by re-listing", async () => {
  const result = await saveScreen({ name: "Cheap", rules: RULES, confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.detail?.name, "Cheap");
  const write = sent.find((s) => s.method === "POST")!;
  assert.equal((write.body as { save: string }).save, "1");
  assert.ok(write.url.endsWith("/screener/templates"));
});

test("a name that already exists is refused rather than posted", async () => {
  // Replace-or-duplicate has never been observed, and those are very different outcomes for someone
  // who curated a screen.
  await refuses(() => saveScreen({ name: "My screen", rules: RULES, confirm: true }), /already exists/);
});

test("Stockbit's own built-in screens are not the user's to delete", async () => {
  await refuses(() => deleteScreen({ templateId: "302", confirm: true }), /built-in/);
});

test("deleting the user's own screen is verified by its absence", async () => {
  const result = await deleteScreen({ templateId: "301", confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.detail?.name, "My screen");
});

test("an unknown template id is refused before anything is sent", async () => {
  await refuses(() => deleteScreen({ templateId: "999", confirm: true }), /No saved screen with id/);
});

test("the favourite flag is set and cleared, and each is read back", async () => {
  const on = await favoriteScreen({ templateId: "301", favorite: true, confirm: true });
  assert.equal(on.outcome, "ok");
  assert.equal(on.detail?.favorite, true);

  const off = await favoriteScreen({ templateId: "301", favorite: false, confirm: true });
  assert.equal(off.outcome, "ok");
  assert.equal(off.detail?.favorite, false);
});

test("every screener edit refuses without confirm", async () => {
  await refuses(() => saveScreen({ name: "Cheap", rules: RULES, confirm: false }), /confirm: true/);
  await refuses(() => deleteScreen({ templateId: "301", confirm: false }), /confirm: true/);
  await refuses(() => favoriteScreen({ templateId: "301", favorite: true, confirm: false }), /confirm: true/);
});

/* ------------------------------------- the log ------------------------------------- */

test("every edit appends one line naming the action, the target and the outcome", async () => {
  await createWatchlist({ name: "Logged", confirm: true });
  const lines = readFileSync(accountLogPath(), "utf8").trim().split("\n");
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.action, "watchlist_create");
  assert.equal(entry.target, "Logged");
  assert.equal(entry.outcome, "ok");
  assert.ok(accountLogPath().endsWith("account-mutations.log"), "a separate file from the order log");
});

test("the account log never carries a credential", async () => {
  await createWatchlist({ name: "Logged again", confirm: true });
  const contents = readFileSync(accountLogPath(), "utf8");
  assert.equal(contents.includes("MAIN-REFRESH"), false);
  assert.equal(/eyJ[A-Za-z0-9_-]+\./.test(contents), false);
});

test("a held lock refuses rather than waiting the edit out", async () => {
  mkdirSync(join(process.env.STOCKBIT_STORE_DIR!, "account-watchlist.lock"), { recursive: true });
  try {
    await refuses(() => createWatchlist({ name: "Contended", confirm: true }), /Another edit to/);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(join(process.env.STOCKBIT_STORE_DIR!, "account-watchlist.lock"), { recursive: true, force: true });
  }
});

/* ------------------------------------- the tools ------------------------------------- */

test("nine writes, no reads — and none of them is reachable from a saved workflow recipe", () => {
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
  registerAccountWriteTools(definer);
  assert.deepEqual(reads.size, 0);
  assert.deepEqual(
    [...writes].sort(),
    [
      "screener_delete",
      "screener_favorite",
      "screener_save",
      "watchlist_add",
      "watchlist_create",
      "watchlist_delete",
      "watchlist_favorite",
      "watchlist_remove",
      "watchlist_rename",
    ],
  );
});

test("the delete tool's description tells the model about the second flag", () => {
  const descriptions = new Map<string, string>();
  registerAccountWriteTools({
    read: () => {},
    write: (name, description) => {
      descriptions.set(name, description);
    },
    writeNames: () => [...descriptions.keys()],
  });
  assert.match(descriptions.get("watchlist_delete")!, /confirm_delete_members/);
  assert.match(descriptions.get("watchlist_delete")!, /HOW MANY/);
  assert.match(descriptions.get("watchlist_favorite")!, /repoints/);
  for (const description of descriptions.values()) assert.match(description, /outcome/);
});

test("the tool wrapper composes a message and reports the audit line", async () => {
  const handlers = new Map<string, ToolHandler>();
  registerAccountWriteTools({
    read: () => {},
    write: (name, _d, _s, handler) => {
      handlers.set(name, handler);
    },
    writeNames: () => [...handlers.keys()],
  });
  const result = await handlers.get("watchlist_add")!({ watchlist_id: "102", symbol: "TLKM", confirm: true });
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text).data;
  assert.equal(payload.outcome, "ok");
  assert.match(payload.message, /TLKM was added to the watchlist, confirmed/);
  assert.ok(payload.auditLog.endsWith("account-mutations.log"));
});
