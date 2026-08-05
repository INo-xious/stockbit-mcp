// Isolate the store, backups and mutation log before importing anything that reads them.
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-write-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/index.ts";
import { mutationLogPath, saveChartLayout, inspectPayload } from "../src/core/layoutwrite.ts";
import { buildLayout, normalizeSeriesIds } from "../src/core/layoutcodec.ts";
import { StockbitError } from "../src/http/errors.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;

/** The fake account's stored layout, per symbol. */
let stored: Record<string, string> = {};
/** Every request that went out. */
let calls: Array<{ method: string; url: string; body?: unknown }> = [];
/** Knobs to drive each failure mode. */
let failWriteWith: number | null = null;
let failReadWith: number | null = null;
/** Corrupts what the server appears to store, to drive the verification path. */
let mutateOnWrite: ((content: string) => string) | null = null;
/** Fails only the Nth write, so rollback (the 2nd write) can be broken independently. */
let failWriteOnCall: number | null = null;
let writeCount = 0;
/** Observed at the moment a POST is handled, for ordering assertions. */
let onWrite: (() => void) | null = null;
/** Fails only the Nth layout READ, to drive the unverifiable path. */
let failReadOnCall: number | null = null;
let readCount = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(() => {
  getStore().set("REFRESH");
  resetSession();

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: u, body });

    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });

    const layoutMatch = /\/chartbit\/([A-Z0-9-]+)\/layout$/.exec(u);
    if (layoutMatch) {
      const symbol = layoutMatch[1];
      if (method === "POST") {
        writeCount++;
        onWrite?.();
        if (failWriteWith !== null) return json({ message: "nope" }, failWriteWith);
        if (failWriteOnCall !== null && writeCount === failWriteOnCall) return json({ message: "nope" }, 500);
        const content = String((body as { content?: string })?.content ?? "");
        stored[symbol] = mutateOnWrite ? mutateOnWrite(content) : content;
        return json({ message: "saved" });
      }
      readCount++;
      if (failReadWith !== null) return json({ message: "nope" }, failReadWith);
      // 400, not 500: getJson backs off and retries 5xx, so a 500 here would simply succeed on the
      // next attempt and never produce the failed read the test is trying to create.
      if (failReadOnCall !== null && readCount === failReadOnCall) return json({ message: "unreadable" }, 400);
      return json({ data: { layout: stored[symbol] ?? "" } });
    }

    if (u.includes("/chartbit/initial/")) return json({ data: { name: "BBRI", exchange: "IDX" } });
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
});

beforeEach(() => {
  stored = {};
  calls = [];
  failWriteWith = null;
  failReadWith = null;
  failWriteOnCall = null;
  failReadOnCall = null;
  mutateOnWrite = null;
  onWrite = null;
  writeCount = 0;
  readCount = 0;
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
});

const LAYOUT = buildLayout({ theme: "dark" });
const posts = () => calls.filter((c) => c.method === "POST" && c.url.includes("/layout"));

function logLines(): Array<Record<string, unknown>> {
  if (!existsSync(mutationLogPath())) return [];
  return readFileSync(mutationLogPath(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/* ------------------------------- the confirmation gate ------------------------------- */

test("without confirm: true, nothing is sent at all", async () => {
  // The gate has to be before the request, not a check on the response.
  for (const confirm of [false, undefined as unknown as boolean]) {
    await assert.rejects(
      () => saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm }),
      (err: unknown) => err instanceof StockbitError && /confirm: true/.test(err.message),
    );
  }
  assert.equal(posts().length, 0, "a refused write must not reach the network");
});

test("the refusal names the consequence, not just the missing flag", async () => {
  await assert.rejects(
    () => saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: false }),
    /overwrite|cannot be undone/,
  );
});

/* ---------------------------------- payload refusal ---------------------------------- */

test("a payload that is not a layout is refused before sending", async () => {
  for (const bad of [null, {}, { charts: [] }, { charts: [{}] }, "a string"]) {
    await assert.rejects(
      () => saveChartLayout({ symbol: "BBRI", layout: bad, confirm: true }),
      (err: unknown) => err instanceof StockbitError && /does not look like a Chartbit layout/.test(err.message),
    );
  }
  assert.equal(posts().length, 0);
});

test("a payload Stockbit's save would corrupt is refused, and allow_lossy is not the default", async () => {
  const risky = buildLayout({ sources: [{ type: "Note", state: { text: "watch D4LkIE here" } }] });
  await assert.rejects(() => saveChartLayout({ symbol: "BBRI", layout: risky, confirm: true }), /would corrupt/);
  assert.equal(posts().length, 0);

  // Explicitly opting in sends it.
  const result = await saveChartLayout({ symbol: "BBRI", layout: risky, confirm: true, allowLossy: true });
  assert.equal(result.verified, true);
});

/* -------------------------------------- snapshot -------------------------------------- */

test("the snapshot holds the PREVIOUS layout, byte for byte", async () => {
  // The earlier version of this test compared the file to itself, so it passed for any content
  // including an empty file — which is exactly the state the MAX_RAW bug produced.
  const previous = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  stored.BBRI = previous;
  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.ok(existsSync(result.snapshotPath), "the snapshot file should exist");
  assert.equal(readFileSync(result.snapshotPath, "utf8"), previous, "the snapshot must be the old layout");
  assert.equal(result.bytesBefore, previous.length);
});

test("the snapshot is on disk BEFORE the write goes out", async () => {
  // Ordering is the whole guarantee: a snapshot written after the POST protects nothing.
  const previous = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  stored.BBRI = previous;
  let snapshotExistedAtWriteTime: string | null = null;
  onWrite = () => {
    const dir = join(process.env.STOCKBIT_STORE_DIR!, "layout-backups");
    const file = readdirSync(dir).filter((f) => f.startsWith("BBRI-")).sort().at(-1);
    snapshotExistedAtWriteTime = file ? readFileSync(join(dir, file), "utf8") : null;
  };

  await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
  assert.equal(snapshotExistedAtWriteTime, previous, "the old layout must already be durable when the POST fires");
});

/* ------------------------- the MAX_RAW truncation, which destroyed data ------------------------- */

test("a layout LARGER than the display cap is snapshotted in full, not as an empty file", async () => {
  // getChartLayout omits `raw` above 4000 bytes. Reading the write path through it made every real
  // chart look empty: 0-byte snapshot, failed verification, and a "rollback" that wrote "" over the
  // user's drawings while reporting that nothing had changed.
  const big = normalizeSeriesIds(
    JSON.stringify(buildLayout({ sources: Array.from({ length: 80 }, (_, i) => ({ type: "LineToolHorzLine", id: `L${i}`, state: { price: 1000 + i, text: "level".repeat(6) } })) })),
  );
  assert.ok(big.length > 4000, `fixture must exceed the display cap, got ${big.length}`);
  stored.BBRI = big;

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.bytesBefore, big.length, "bytesBefore must be the real size, not 0");
  assert.equal(readFileSync(result.snapshotPath, "utf8"), big, "the snapshot must hold the whole layout");
  assert.equal(result.verified, true);
});

test("writing back a LARGE layout unchanged verifies instead of erasing it", async () => {
  // The worse half of the same bug: an honest round-trip failed verification, then "restored" the
  // empty string over a chart that was correct.
  const big = buildLayout({ sources: Array.from({ length: 80 }, (_, i) => ({ type: "LineToolHorzLine", id: `L${i}`, state: { price: 2000 + i, text: "zone".repeat(8) } })) });
  const encoded = normalizeSeriesIds(JSON.stringify(big));
  assert.ok(encoded.length > 4000);
  stored.BBRI = encoded;

  const result = await saveChartLayout({ symbol: "BBRI", layout: big, confirm: true });

  assert.equal(result.verified, true, "a faithful round-trip must verify");
  assert.equal(result.rolledBack, undefined, "and must not trigger a rollback");
  assert.equal(stored.BBRI, encoded, "the account must still hold the layout");
  assert.equal(posts().length, 1, "no second write");
});

test("an empty previous layout still snapshots — that IS the state to restore", async () => {
  const result = await saveChartLayout({ symbol: "TLKM", layout: LAYOUT, confirm: true });
  assert.ok(existsSync(result.snapshotPath));
  assert.equal(result.bytesBefore, 0);
});

test("if the snapshot cannot be taken, the write is NOT attempted", async () => {
  // A rollback path with nothing to roll back to is not a safety net.
  failReadWith = 500;
  await assert.rejects(
    () => saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true }),
    /Could not snapshot|was not attempted/,
  );
  assert.equal(posts().length, 0, "nothing may be written without a snapshot");
  assert.equal(logLines().some((l) => l.outcome === "aborted-no-snapshot"), true);
});

test("snapshots accumulate rather than overwrite each other", async () => {
  await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
  clearCache();
  await saveChartLayout({ symbol: "BBRI", layout: buildLayout({ theme: "light" }), confirm: true });
  const dir = join(process.env.STOCKBIT_STORE_DIR!, "layout-backups");
  assert.ok(readdirSync(dir).filter((f) => f.startsWith("BBRI-")).length >= 2, "each write keeps its own snapshot");
});

/* ------------------------------ verification and rollback ------------------------------ */

test("a write that reads back identical is reported verified", async () => {
  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
  assert.equal(result.verified, true);
  assert.equal(result.rolledBack, undefined);
  assert.equal(posts().length, 1, "a verified write needs no second request");
  assert.equal(logLines().at(-1)?.outcome, "ok");
});

test("a write that reads back DIFFERENT is rolled back to the snapshot", async () => {
  // The failure that matters: the write succeeded and put something wrong there.
  stored.BBRI = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  const original = stored.BBRI;
  // Corrupt only the forward write; the restore is allowed to land correctly so this test is about
  // rollback happening at all. The corrupt-restore case has its own test.
  mutateOnWrite = (content) => (writeCount === 1 ? `${content} tampered` : content);

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.verified, false);
  assert.equal(result.rolledBack, true);
  assert.equal(posts().length, 2, "the second POST is the restore");
  assert.equal(posts()[1].body && (posts()[1].body as { content: string }).content, original);
  assert.equal(logLines().at(-1)?.outcome, "rolled-back");
});

test("a failed rollback is reported LOUDLY rather than swallowed", async () => {
  // The account is now in an unknown state; saying nothing would be the worst outcome here.
  mutateOnWrite = (content) => `${content} tampered`;
  failWriteOnCall = 2; // let the write land, break the restore

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.verified, false);
  assert.equal(result.rolledBack, false, "an explicit false, not an absent field — 'no' and 'unknown' differ here");
  assert.ok(result.rollbackFailed, "the rollback failure must be surfaced");
  assert.equal(logLines().at(-1)?.outcome, "rollback-failed");
});

test("a write that never lands throws, and says where the snapshot is", async () => {
  failWriteWith = 500;
  await assert.rejects(() => saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true }));
  const last = logLines().at(-1);
  assert.equal(last?.outcome, "write-failed");
  assert.ok(last?.snapshotPath, "the snapshot path must be recoverable from the log");
  const path = String(last!.snapshotPath);
  assert.ok(existsSync(path), "and a file must actually be there");
});

test("a rollback is READ BACK, not assumed from a 2xx", async () => {
  // A 2xx does not prove the right bytes landed — that is the whole reason the forward write is
  // verified, so the recovery path cannot be held to a weaker standard.
  const previous = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  stored.BBRI = previous;
  // Corrupt the first write to force a rollback, then let the restore land correctly.
  mutateOnWrite = (content) => (writeCount === 1 ? `${content} tampered` : content);

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.verified, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackVerified, true, "the restore must be confirmed by reading it back");
  assert.equal(stored.BBRI, previous, "and the account must really hold the old layout again");
  assert.equal(logLines().at(-1)?.outcome, "rolled-back");
});

test("a rollback that lands WRONG is reported as unconfirmed, not as restored", async () => {
  stored.BBRI = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  mutateOnWrite = (content) => `${content} tampered`; // corrupts the restore too

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.rolledBack, true, "the restore POST did succeed");
  assert.equal(result.rollbackVerified, false, "but it did not put the right bytes back");
  assert.equal(logLines().at(-1)?.outcome, "rollback-unverified");
});

/* ------------------------------ outcomes that are UNKNOWN ------------------------------ */

test("a write that errors but LANDED is not reported as a failure", async () => {
  // A timeout or a proxy 5xx can arrive after the server committed. Calling that a clean failure
  // would tell the user their chart is untouched when it is not.
  stored.BBRI = "";
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (String(init?.method) === "POST" && u.includes("/layout")) {
      // Apply it, then fail the response — the shape of a proxy 502 after the server committed.
      stored.BBRI = String(JSON.parse(String(init?.body)).content);
      return new Response(JSON.stringify({ message: "gateway" }), { status: 502 });
    }
    return stubbed(url as string, init);
  }) as typeof fetch;

  try {
    const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
    assert.equal(result.verified, true, "the read-back proves it landed");
    assert.equal(logLines().at(-1)?.outcome, "landed-despite-error");
  } finally {
    // Restoring is not optional: leaking this wrapper silently rewrote the results of every test
    // that ran after it.
    globalThis.fetch = stubbed;
  }
});

test("a write whose outcome cannot be determined says UNKNOWN rather than guessing", async () => {
  failWriteWith = 502;
  failReadOnCall = 2; // snapshot read succeeds, the post-error read-back fails

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.verified, false);
  assert.match(result.outcomeUnknown ?? "", /unknown whether it was applied/);
  assert.equal(logLines().at(-1)?.outcome, "outcome-unknown");
});

test("an UNREADABLE verification does not trigger a blind rollback", async () => {
  // Rolling back on a state we could not read would be a second blind write — and if the first was
  // fine, the rollback is the destructive one.
  const previous = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  stored.BBRI = previous;
  failReadOnCall = 2; // snapshot read ok, verification read fails

  const result = await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  assert.equal(result.verified, false);
  assert.ok(result.verifyError, "the read failure must be surfaced, not folded into 'mismatch'");
  assert.match(result.outcomeUnknown ?? "", /No rollback was attempted/);
  assert.equal(posts().length, 1, "exactly one write — no rollback POST");
  assert.equal(logLines().at(-1)?.outcome, "unverifiable");
});

/* --------------------------------------- the cache --------------------------------------- */

test("a later read cannot be served the pre-write layout from cache", async () => {
  const { getChartLayout } = await import("../src/core/layout.ts");
  stored.BBRI = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  await getChartLayout("BBRI"); // populate the cache with the OLD layout
  await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });

  const after = await getChartLayout("BBRI");
  assert.equal(JSON.parse(after.raw!).charts[0].theme, "dark", "the cache must not serve the pre-write state");
});

/* ------------------------------------ mutation log ------------------------------------ */

test("every attempt is logged, whatever the outcome", async () => {
  const before = logLines().length;
  await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
  failWriteWith = 500;
  await assert.rejects(() => saveChartLayout({ symbol: "TLKM", layout: LAYOUT, confirm: true }));

  const lines = logLines();
  assert.equal(lines.length, before + 2);
  for (const line of lines.slice(-2)) {
    assert.ok(line.at, "each entry needs a timestamp");
    assert.ok(line.symbol, "and the symbol it touched");
    assert.ok(line.outcome, "and what happened");
  }
});

test("the log is append-only", async () => {
  await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
  const first = logLines().length;
  clearCache();
  await saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true });
  assert.equal(logLines().length, first + 1);
});

/* --------------------------------------- request --------------------------------------- */

test("the write goes to the declared route with the encoded body", async () => {
  await saveChartLayout({ symbol: "bbri", layout: LAYOUT, confirm: true });
  const post = posts()[0];
  assert.equal(new URL(post.url).pathname, "/chartbit/BBRI/layout", "the symbol is normalised");
  const content = (post.body as { content: string }).content;
  assert.equal(content, normalizeSeriesIds(JSON.stringify(LAYOUT)));
  assert.equal(JSON.parse(content).charts[0].theme, "dark");
});

test("a write is never retried blindly on a server error", async () => {
  // Retrying a mutation whose response was lost could apply it twice.
  failWriteWith = 500;
  await assert.rejects(() => saveChartLayout({ symbol: "BBRI", layout: LAYOUT, confirm: true }));
  assert.equal(posts().length, 1, `expected exactly one attempt, saw ${posts().length}`);
});

/* ------------------------------ the tool the user reaches ------------------------------ */

/** Register the real tools and hand back the handler map, so these tests exercise production wiring. */
async function toolHandlers(): Promise<Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>>> {
  const { registerTools } = await import("../src/tools/register.ts");
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>> = {};
  registerTools({
    tool: (name: string, ...rest: unknown[]) => {
      handlers[name] = rest[rest.length - 1] as (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    },
  } as never);
  return handlers;
}

const payload = (res: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text!);

test("the chart_layout_save TOOL enforces confirm, not just the function underneath it", async () => {
  // Nothing previously imported registerTools, so every guarantee was asserted against a signature
  // rather than against the thing the user actually reaches.
  const handlers = await toolHandlers();
  assert.ok(handlers.chart_layout_save, "the tool must be registered");

  const refused = payload(await handlers.chart_layout_save({ symbol: "BBRI", layout: LAYOUT, confirm: false }));
  assert.equal(refused.success, false);
  assert.match(refused.error, /confirm: true/);
  assert.equal(posts().length, 0, "a refused tool call must not reach the network");
});

test("the tool forwards the layout and reports the verified result", async () => {
  const handlers = await toolHandlers();
  const ok = payload(await handlers.chart_layout_save({ symbol: "BBRI", layout: LAYOUT, confirm: true }));
  assert.equal(ok.success, true);
  assert.equal(ok.data.verified, true);
  assert.match(ok.data.message, /replaced and verified/);
  assert.equal(stored.BBRI, normalizeSeriesIds(JSON.stringify(LAYOUT)), "the account holds what was sent");
});

test("the tool never claims 'nothing was left changed' unless the restore was confirmed", async () => {
  // A caller relaying this message repeats whatever confidence it finds in it.
  const handlers = await toolHandlers();
  stored.BBRI = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "light" })));
  mutateOnWrite = (content) => `${content} tampered`; // corrupts the restore too

  const res = payload(await handlers.chart_layout_save({ symbol: "BBRI", layout: LAYOUT, confirm: true }));
  assert.equal(res.data.rollbackVerified, false);
  assert.equal(/Nothing was left changed/.test(res.data.message), false, "an unconfirmed restore must not read as safe");
  assert.match(res.data.message, /could NOT be confirmed|uncertain/);
});

/* -------------------------------------- inspection -------------------------------------- */

test("inspectPayload reports both problems without sending anything", () => {
  assert.deepEqual(inspectPayload(LAYOUT), { plausible: true, wouldRewrite: [] });
  assert.deepEqual(inspectPayload({}), { plausible: false, wouldRewrite: [] });
  const risky = buildLayout({ sources: [{ type: "Note", state: { text: "D4LkIE" } }] });
  assert.deepEqual(inspectPayload(risky).wouldRewrite, ["D4LkIE"]);
});
