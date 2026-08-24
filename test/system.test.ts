/**
 * The two tools that can do something irreversible to the user's machine.
 *
 * `login` opens a real browser window; `logout` destroys credentials. Neither should be reachable
 * because a model decided it would be helpful, so every gate is asserted here from the outside — by
 * calling the registered tool, not the function behind it, because the gates live in the tool.
 *
 * Nothing in this file may open a browser. `STOCKBIT_NO_BROWSER=1` is set before the module loads,
 * and the one test that goes past that gate takes the login lock first so the capture is refused
 * before it can start. If a browser window ever appears while this file runs, that is the bug.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-system-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;
process.env.STOCKBIT_NO_BROWSER = "1";

/**
 * A file that `findBrowser()` will accept, so the tests past the NO_BROWSER gate behave the same on
 * a developer's Mac and on a bare CI runner with nothing installed. It is never executed: every one
 * of those tests is refused by a later gate — a declined elicitation, or a held lock — before any
 * capture could start.
 */
const FAKE_BROWSER = join(STORE, "chrome-stub");
writeFileSync(FAKE_BROWSER, "#!/bin/sh\nexit 1\n");
process.env.STOCKBIT_BROWSER = FAKE_BROWSER;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeDefiner, type Definer } from "../src/tools/_define.ts";
import { registerSystemTools } from "../src/tools/system.ts";
import { getStore, resetStoreCache } from "../src/auth/store.ts";
import { resetLoginStatus } from "../src/status.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/** Anything that looks like a JWT. Deliberately loose — a partial leak is still a leak. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;

interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; isError: boolean; raw: string }>;
  define: Definer;
}

/** Register the system family against a recording stub and return a way to call it. */
function harness(elicit?: () => Promise<"accepted" | "declined" | "unavailable">): Harness {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Handler) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;

  const define = makeDefiner(server, new Map()).family("system");
  if (elicit) (define as { elicit?: unknown }).elicit = elicit;
  registerSystemTools(define);

  return {
    define,
    async call(name, args = {}) {
      const handler = tools.get(name);
      assert.ok(handler, `no tool named ${name}`);
      const result = await handler(args);
      const raw = result.content.map((c) => c.text ?? "").join("\n");
      return { payload: JSON.parse(raw) as Record<string, unknown>, isError: result.isError === true, raw };
    },
  };
}

function clearAllSlots(): void {
  for (const slot of ["main", "securities", "eipo"] as const) {
    try {
      getStore(slot).clear();
    } catch {
      /* nothing stored */
    }
  }
  resetStoreCache();
}

function fakeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "test", exp: expSeconds })}.c2lnbmF0dXJl`;
}

beforeEach(() => {
  resetLoginStatus();
  process.env.STOCKBIT_NO_BROWSER = "1";
  process.env.STOCKBIT_BROWSER = FAKE_BROWSER;
  mkdirSync(STORE, { recursive: true });
});

/* --------------------------------- registration --------------------------------- */

test("the system family registers exactly status, login and logout", () => {
  const h = harness();
  assert.deepEqual(h.define.names(), ["status", "login", "logout"]);
  assert.deepEqual(h.define.writeNames(), ["login", "logout"]);
});

/* ------------------------------------- login ------------------------------------- */

test("STOCKBIT_NO_BROWSER refuses, and names the terminal command", async () => {
  const h = harness();
  const { payload, isError } = await h.call("login", { confirm: true });
  assert.equal(isError, true);
  assert.equal(payload.started, false);
  assert.match(String(payload.reason), /STOCKBIT_NO_BROWSER/);
  assert.match(String(payload.nextStep), /stockbit-auth login/);
});

test("no confirm is refused before anything else is considered", async () => {
  const h = harness();
  // The environment gate is checked first on purpose, so unset it to reach the confirm gate.
  delete process.env.STOCKBIT_NO_BROWSER;
  try {
    const { payload, isError } = await h.call("login", { confirm: false });
    assert.equal(isError, true);
    assert.equal(payload.started, false);
    assert.match(String(payload.reason), /confirm was not true/);
    assert.match(String(payload.nextStep), /Ask the user/);
  } finally {
    process.env.STOCKBIT_NO_BROWSER = "1";
  }
});

test("an existing session is reported rather than replaced", async () => {
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86400));
  delete process.env.STOCKBIT_NO_BROWSER;
  try {
    const h = harness();
    const { payload } = await h.call("login", { confirm: true });
    assert.equal(payload.started, false);
    assert.equal(payload.alreadyLoggedIn, true);
    assert.match(String(payload.nextStep), /force: true/);
  } finally {
    process.env.STOCKBIT_NO_BROWSER = "1";
    clearAllSlots();
  }
});

test("a declined elicitation stops the login, even with confirm: true", async () => {
  clearAllSlots();
  delete process.env.STOCKBIT_NO_BROWSER;
  try {
    const h = harness(async () => "declined");
    const { payload, isError } = await h.call("login", { confirm: true, force: true });
    assert.equal(isError, true);
    assert.equal(payload.started, false);
    assert.match(String(payload.reason), /declined/);
    assert.match(String(payload.nextStep), /Nothing was opened/);
  } finally {
    process.env.STOCKBIT_NO_BROWSER = "1";
  }
});

test("a held login lock refuses rather than driving the same browser profile twice", async () => {
  clearAllSlots();
  delete process.env.STOCKBIT_NO_BROWSER;
  mkdirSync(join(STORE, "login.lock"), { recursive: true });
  try {
    const h = harness(async () => "accepted");
    const { payload, isError } = await h.call("login", { confirm: true, force: true });
    assert.equal(isError, true);
    assert.equal(payload.started, false);
    assert.match(String(payload.reason), /Another login is already in progress/);
  } finally {
    rmSync(join(STORE, "login.lock"), { recursive: true, force: true });
    process.env.STOCKBIT_NO_BROWSER = "1";
  }
});

/* ------------------------------------ logout ------------------------------------ */

test("logout without confirm destroys nothing", async () => {
  clearAllSlots();
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 86400);
  getStore("main").set(token);
  try {
    const h = harness();
    const { payload, isError } = await h.call("logout", { confirm: false });
    assert.equal(isError, true);
    assert.match(String(payload.reason), /confirm was not true/);
    assert.equal(getStore("main").get(), token, "the token must still be there");
  } finally {
    clearAllSlots();
  }
});

test("logout scope clears exactly what it names", async () => {
  clearAllSlots();
  const main = fakeJwt(Math.floor(Date.now() / 1000) + 86400);
  const eipo = fakeJwt(Math.floor(Date.now() / 1000) + 86400);
  getStore("main").set(main);
  getStore("eipo").set(eipo);
  try {
    const h = harness();
    const { payload } = await h.call("logout", { confirm: true, scope: "eipo" });
    assert.equal((payload.cleared as Record<string, string>).eipo, "cleared");
    assert.equal(getStore("eipo").get(), null);
    assert.equal(getStore("main").get(), main, "a scoped logout must not touch the other slots");
    assert.equal(payload.browserProfile, "kept — it still holds a logged-in Stockbit session");
  } finally {
    clearAllSlots();
  }
});

test("logout all clears every slot and reports what it found", async () => {
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) + 86400));
  try {
    const h = harness();
    const { payload } = await h.call("logout", { confirm: true });
    const cleared = payload.cleared as Record<string, string>;
    assert.equal(cleared.main, "cleared");
    assert.equal(cleared.eipo, "nothing stored", "an empty slot is an answer, not a failure");
    assert.ok(cleared.trading, "the trading slot is always reported");
    assert.equal(getStore("main").get(), null);
    assert.match(String(payload.nextStep), /log/i);
  } finally {
    clearAllSlots();
  }
});

/* ---------------------------------- the invariant ---------------------------------- */

test("no result from any system tool carries anything JWT-shaped", async () => {
  clearAllSlots();
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 7 * 86400);
  getStore("main").set(token);
  getStore("securities").set(token);
  getStore("eipo").set(token);
  try {
    const h = harness(async () => "declined");
    const results = [
      await h.call("status"),
      await h.call("login", { confirm: true }),
      await h.call("login", { confirm: false }),
      await h.call("logout", { confirm: false }),
      await h.call("logout", { confirm: true }),
    ];
    for (const { raw } of results) {
      assert.doesNotMatch(raw, JWT_SHAPED, `a tool result carried something JWT-shaped: ${raw.slice(0, 300)}`);
      assert.ok(!raw.includes(token), "a tool result carried the stored token verbatim");
    }
  } finally {
    clearAllSlots();
  }
});

test("status answers through the tool with an empty store", async () => {
  clearAllSlots();
  const h = harness();
  const { payload, isError } = await h.call("status");
  assert.equal(isError, false);
  const data = (payload as { data: Record<string, unknown> }).data;
  assert.equal((data.auth as Record<string, { stored: boolean }>).main.stored, false);
  assert.match(String(data.nextStep), /stockbit-auth login/);
});
