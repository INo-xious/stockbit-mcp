/**
 * The staleness check — and the guarantee that it never fires unless asked.
 *
 * `npx -y stockbit-mcp` caches a resolved tree under a version RANGE. A cache entry holding `^1.2.2`
 * with 1.2.2 installed is satisfied by 1.2.4, so npx reuses it and never re-resolves; the server
 * stays on the old build indefinitely and nothing anywhere says so. In the field that cost a whole
 * session debugging a bug that had already been fixed.
 *
 * Two properties are asserted here and they matter in different ways. The first is that the check
 * ANSWERS — correctly, and conservatively when it cannot.
 *
 * The second is that `npm test` never reaches the registry, and getting that right took three
 * attempts worth recording, because each one was defeated by a route nobody had listed:
 *
 *   1. "`collectStatus()` makes no request unless asked" — true, and useless on its own: the
 *      `status` TOOL asks, and tests call the tool.
 *   2. "every test that SPAWNS a bin turns it off in the child" — true, and still not enough:
 *      `test/system.test.ts` spawns nothing and calls the tool in-process.
 *   3. `test/_offline.mjs`, loaded by the runner ahead of every test module. A new test file cannot
 *      forget it, because it never has to remember it.
 *
 * (3) is the guarantee. The spawner checks below are defence in depth — they catch a child built
 * with an explicit env allowlist that drops the switch, which (3) cannot reach — and they are
 * deliberately kept even though the harness now covers the common case.
 *
 * Every `fetch` below is injected. Nothing here can reach the network even if all of that were wrong.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What the HARNESS set, captured before this file clears it.
 *
 * `test/_offline.mjs` runs ahead of every test module and sets the switch; this file then removes
 * it, because its whole job is exercising the real check with an injected `fetch`. The captured
 * value is what proves the harness is still wired — see the test at the bottom.
 */
const HARNESS_SWITCH = process.env.STOCKBIT_NO_UPDATE_CHECK;

const STORE = mkdtempSync(join(tmpdir(), "stockbit-updatecheck-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;
delete process.env.STOCKBIT_NO_UPDATE_CHECK;

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  REGISTRY_URL,
  UPDATE_CACHE_TTL_MS,
  checkForUpdate,
  compareVersions,
} from "../src/updatecheck.ts";
import { collectStatus } from "../src/status.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const CACHE = join(STORE, "update-check.json");

beforeEach(() => {
  rmSync(CACHE, { force: true });
  delete process.env.STOCKBIT_NO_UPDATE_CHECK;
});

/** A fetch that answers the registry with `version`, counting how often it was called. */
function registry(version: string): { impl: typeof fetch; calls: () => number; urls: string[] } {
  let calls = 0;
  const urls: string[] = [];
  const impl = (async (url: unknown) => {
    calls++;
    urls.push(String(url));
    return new Response(JSON.stringify({ name: "stockbit-mcp", version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls, urls };
}

/* --------------------------------- version ordering --------------------------------- */

test("compareVersions orders releases numerically, not lexicographically", () => {
  assert.equal(compareVersions("1.2.5", "1.2.4"), 1);
  assert.equal(compareVersions("1.3.0", "1.2.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.4", "1.2.4"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1, "older is behind, not equal");
  // "10" < "9" as TEXT, which would hide every release after x.9.x.
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("v1.2.5", "1.2.4"), 1, "a leading v is tolerated");
});

test("an unparseable version is its OWN outcome, never folded into 'not ahead'", () => {
  // Folding it into "not ahead" is exactly what let this module print "Up to date" for a pair it
  // had never compared.
  for (const junk of ["", "latest", "1.2", "1.2.x", "not-a-version", "1.2.3.4"]) {
    assert.equal(compareVersions(junk, "1.2.4"), null, junk);
    assert.equal(compareVersions("9.9.9", junk), null, junk);
  }
});

test("a prerelease never orders ahead of the release it precedes", () => {
  // This package publishes no prerelease channel. Recommending one by accident is worse than
  // missing it, so the suffix is ignored for ordering.
  assert.equal(compareVersions("1.2.4-beta.1", "1.2.4"), 0);
  assert.equal(compareVersions("1.3.0-beta.1", "1.2.4"), 1, "the CORE version is still ahead");
});

test("an equal ORDER with different strings is not reported as 'the latest release'", async () => {
  // Same self-refutation the ahead case had: "Up to date: 1.3.0 is the latest release" printed
  // beside `latest: "1.3.0-beta.1"`.
  const status = await checkForUpdate({ installed: "1.3.0", fetchImpl: registry("1.3.0-beta.1").impl });
  assert.equal(status.latest, "1.3.0-beta.1");
  assert.equal(status.isOutdated, false);
  assert.match(status.note, /same release/);
  assert.doesNotMatch(status.note, /Up to date/);
});

/* --------------------------------- asking the registry --------------------------------- */

test("a newer release is reported, and the note says why npx will not pick it up", async () => {
  const r = registry("1.9.9");
  const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl });
  assert.equal(status.installed, "1.2.4");
  assert.equal(status.latest, "1.9.9");
  assert.equal(status.isOutdated, true);
  assert.ok(status.checkedAt);
  assert.match(status.note, /1\.9\.9/);
  // The actionable half: npx caching a RANGE is the reason this is needed at all.
  assert.match(status.note, /npx/i);
  assert.deepEqual(r.urls, [REGISTRY_URL]);
});

test("being current says so, without claiming more", async () => {
  const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: registry("1.2.4").impl });
  assert.equal(status.latest, "1.2.4");
  assert.equal(status.isOutdated, false);
});

test("a build AHEAD of the registry is not reported as 'up to date'", async () => {
  // The release-bump case: package.json at 1.2.5 while npm still has 1.2.4. "Up to date: 1.2.5 is
  // the latest release" printed beside `latest: "1.2.4"` is self-refuting.
  const status = await checkForUpdate({ installed: "1.2.5", fetchImpl: registry("1.2.4").impl });
  assert.equal(status.latest, "1.2.4");
  assert.equal(status.isOutdated, false);
  assert.match(status.note, /AHEAD of the registry/);
  assert.doesNotMatch(status.note, /Up to date/);
});

test("a version that cannot be COMPARED is unknown, not 'up to date'", async () => {
  // The registry answered, so `latest` is a fact and is kept — but nothing was compared, so
  // `isOutdated` must be absent rather than defaulted to false.
  const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: registry("weird-build").impl });
  assert.equal(status.latest, "weird-build");
  assert.equal(status.isOutdated, undefined, "absent: no comparison was made");
  assert.match(status.note, /could not be compared/);
  assert.doesNotMatch(status.note, /Up to date/);
});

test("compareVersions distinguishes all four outcomes", () => {
  assert.equal(compareVersions("1.2.5", "1.2.4"), 1);
  assert.equal(compareVersions("1.2.4", "1.2.5"), -1);
  assert.equal(compareVersions("1.2.4", "1.2.4"), 0);
  assert.equal(compareVersions("nope", "1.2.4"), null, "unparseable is its OWN outcome, not 'not ahead'");
});

test("a check that could not run is ABSENT, never 'up to date'", async () => {
  // The rule the whole project runs on: a field that could not be read is absent, not a default.
  // "We could not ask" and "you are current" are different answers and only one is a fact.
  const cases: Array<[string, typeof fetch]> = [
    ["a 500", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch],
    ["a 404", (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch],
    ["a thrown request", (async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof fetch],
    ["a body with no version", (async () =>
      new Response(JSON.stringify({ name: "stockbit-mcp" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch],
    ["a body that is not JSON", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch],
  ];
  for (const [what, impl] of cases) {
    const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: impl });
    assert.equal(status.latest, undefined, what);
    assert.equal(status.isOutdated, undefined, `${what}: absent, not false`);
    assert.equal(status.checkedAt, undefined, what);
    assert.equal(status.installed, "1.2.4", what);
    assert.ok(status.note.length > 0, what);
  }
});

test("a failure note quotes no URL and no error text", async () => {
  // A fetch failure quotes the URL it was given, and a note is not the place to widen what this
  // server is willing to write down.
  const impl = (async () => {
    throw new Error("request to https://registry.npmjs.org/stockbit-mcp/latest failed, token=abc123");
  }) as unknown as typeof fetch;
  const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: impl });
  assert.doesNotMatch(status.note, /https?:\/\//);
  assert.doesNotMatch(status.note, /abc123/);
});

test("the check never throws, whatever fetch does", async () => {
  const hostile = [
    (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch,
    (() => {
      throw new Error("threw synchronously");
    }) as unknown as typeof fetch,
    (async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch,
  ];
  for (const impl of hostile) {
    const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: impl });
    assert.equal(status.installed, "1.2.4");
    assert.equal(status.latest, undefined);
  }
});

/* ------------------------------------- the kill switch ------------------------------------- */

test("STOCKBIT_NO_UPDATE_CHECK=1 makes no request at all", async () => {
  process.env.STOCKBIT_NO_UPDATE_CHECK = "1";
  const r = registry("9.9.9");
  const status = await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl });
  assert.equal(r.calls(), 0, "the switch must prevent the request, not just the report");
  assert.equal(status.latest, undefined);
  assert.match(status.note, /STOCKBIT_NO_UPDATE_CHECK/);
});

/* ---------------------------------------- the cache ---------------------------------------- */

test("a second check inside the TTL is served from cache", async () => {
  const r = registry("1.9.9");
  const at = new Date("2026-09-01T00:00:00Z");
  const first = await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl, now: at });
  assert.equal(r.calls(), 1);
  const second = await checkForUpdate({
    installed: "1.2.4",
    fetchImpl: r.impl,
    now: new Date(at.getTime() + UPDATE_CACHE_TTL_MS - 1000),
  });
  assert.equal(r.calls(), 1, "still one request");
  assert.equal(second.latest, first.latest);
  assert.equal(second.isOutdated, true);
  assert.match(second.note, /cached/);
});

test("an expired cache is refetched, and `force` skips it entirely", async () => {
  const r = registry("1.9.9");
  const at = new Date("2026-09-01T00:00:00Z");
  await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl, now: at });
  await checkForUpdate({
    installed: "1.2.4",
    fetchImpl: r.impl,
    now: new Date(at.getTime() + UPDATE_CACHE_TTL_MS + 1000),
  });
  assert.equal(r.calls(), 2, "past the TTL it must ask again");
  await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl, force: true });
  assert.equal(r.calls(), 3);
});

test("a corrupt or forward-dated cache is ignored rather than trusted", async () => {
  mkdirSync(STORE, { recursive: true });
  const r = registry("1.9.9");
  for (const bad of ["{not json", JSON.stringify({ latest: 5 }), JSON.stringify({ latest: "1.9.9" })]) {
    writeFileSync(CACHE, bad, "utf8");
    const before = r.calls();
    await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl });
    assert.equal(r.calls(), before + 1, `must refetch past: ${bad.slice(0, 24)}`);
  }
  // A stamp in the future means a clock moved, not a reading that stays fresh forever.
  writeFileSync(
    CACHE,
    JSON.stringify({ latest: "1.9.9", checkedAt: new Date("2030-01-01T00:00:00Z").toISOString() }),
    "utf8",
  );
  const before = r.calls();
  await checkForUpdate({ installed: "1.2.4", fetchImpl: r.impl, now: new Date("2026-09-01T00:00:00Z") });
  assert.equal(r.calls(), before + 1);
});

/* ------------------------- the offline guarantee, on collectStatus ------------------------- */

/**
 * Every file that SPAWNS a bin must turn the check off in the child.
 *
 * This guard exists because the obvious version of the offline argument was wrong, and wrong in a
 * way no in-process test could see. `collectStatus()` with no options makes no request — true, and
 * asserted below — but both user-facing callers pass `updateCheck: true`, and the suite spawns
 * those callers as real child processes. A child does not inherit this suite's stubbed `fetch`, so
 * `npm test` and `npm run smoke` were both making live requests to registry.npmjs.org while a
 * comment two files away claimed the suite stayed offline "by construction".
 *
 * DEFENCE IN DEPTH, not the guarantee — `test/_offline.mjs` is. This catches the case the harness
 * cannot: a child spawned with an EXPLICIT env allowlist rather than `...process.env`, which
 * therefore does not inherit the switch. `scripts/smoke.mjs` is exactly that shape.
 *
 * Hard-coded list, on the `WRITES`-list principle: derived from a grep it would agree with whatever
 * the code does. Two known limits, stated rather than papered over — it greps per FILE, so a second
 * spawn site in an already-listed file is not separately checked, and the scan below is
 * non-recursive and idiom-bound. Both are acceptable precisely because they are no longer the
 * thing standing between the suite and the network.
 */
const SPAWNERS = [
  "test/alertscli.test.ts",
  "test/authcli.test.ts",
  "test/batch.test.ts",
  "test/livecli.test.ts",
  "test/mcpcli.test.ts",
  "scripts/smoke.mjs",
];

/**
 * Files the scan below flags that do NOT run a bin, with the reason, so the exemption is a decision
 * on the record rather than a regex quietly tuned until it passed.
 *
 * `build-mcpb.mjs` writes `"main": "dist/bin/stockbit-mcp.js"` into a manifest and spawns npm. It
 * names the path; it never executes it.
 *
 * This file matches its own detector, because it necessarily contains the patterns it searches for.
 */
const NOT_ACTUALLY_SPAWNERS = ["scripts/build-mcpb.mjs", "test/updatecheck.test.ts"];

test("the HARNESS makes the suite offline, so no test file has to remember to", () => {
  // The primary guarantee, and the one that actually holds. Two rounds of review found two
  // different routes to the network from `npm test`: the tests that SPAWN a bin, and then
  // test/system.test.ts, which spawns nothing and just calls the `status` tool in-process. The
  // second proved that fixing call sites one at a time only ever covers the places someone already
  // thought of.
  //
  // `test/_offline.mjs` is loaded by the runner ahead of every test module. If it is dropped from
  // the `test` script in package.json, this fails — which is the point, because nothing else would
  // notice until a CI box without network access started timing out.
  assert.equal(
    HARNESS_SWITCH,
    "1",
    "test/_offline.mjs did not run — check that `npm test` still passes --import ./test/_offline.mjs",
  );

  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(
    pkg.scripts.test,
    /--import \.\/test\/_offline\.mjs/,
    "the test script must preload the offline switch",
  );
});

test("every file that spawns a bin disables the update check in the child", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const rel of SPAWNERS) {
    const source = readFileSync(join(root, rel), "utf8");
    assert.match(
      source,
      /STOCKBIT_NO_UPDATE_CHECK:\s*"1"/,
      `${rel} spawns a bin without disabling the update check — the child will reach registry.npmjs.org`,
    );
  }
});

test("the SPAWNERS list still covers everything that spawns a bin", () => {
  // The list above is only as good as its coverage, so this finds spawners mechanically and checks
  // none has appeared outside it. A new one fails HERE, with the reason, rather than silently
  // adding a network call to the gate.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found: string[] = [];
  for (const dir of ["test", "scripts"]) {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`;
      const full = join(root, rel);
      if (!statSync(full).isFile()) continue;
      if (!/\.(ts|mjs|cjs)$/.test(entry)) continue;
      const source = readFileSync(full, "utf8");
      // Spawns a child that runs one of this package's bins.
      const spawnsABin =
        /\b(spawn|execFile|execFileSync|StdioClientTransport)\b/.test(source) &&
        /["'`](?:\.\.\/)?(?:bin|dist\/bin)\/|join\(\s*ROOT\s*,\s*"bin"|args:\s*\[\s*entry\s*\]/.test(source);
      if (spawnsABin) found.push(rel);
    }
  }
  const missing = found.filter((f) => !SPAWNERS.includes(f) && !NOT_ACTUALLY_SPAWNERS.includes(f));
  assert.deepEqual(
    missing,
    [],
    "these spawn a bin but are not in SPAWNERS — add them there AND set STOCKBIT_NO_UPDATE_CHECK in the child",
  );
});

test("collectStatus makes NO update request unless the caller asks", async () => {
  // This is what keeps the whole offline suite offline. If the check fired merely because a status
  // report was assembled, every test that touches status would reach for the network.
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const report = await collectStatus();
    assert.equal(called, 0, "collectStatus() must not reach the registry on its own");
    assert.equal(report.server.update, undefined, "and must not report an update field it never got");
  } finally {
    globalThis.fetch = real;
  }
});

test("collectStatus reports the update when asked, and warns only when behind", async () => {
  const behind = await collectStatus({
    checkUpdate: async () => ({
      installed: "1.2.4",
      latest: "1.9.9",
      isOutdated: true,
      checkedAt: "2026-09-01T00:00:00.000Z",
      note: "A newer release exists: 1.9.9",
    }),
  });
  assert.equal(behind.server.update?.latest, "1.9.9");
  assert.ok(
    behind.checks.some((c) => c.name === "version" && c.status === "warn"),
    "being behind must surface as a check, since that is what the human-readable output prints",
  );

  const current = await collectStatus({
    checkUpdate: async () => ({ installed: "1.2.4", latest: "1.2.4", isOutdated: false, note: "Up to date" }),
  });
  assert.equal(current.server.update?.isOutdated, false);
  assert.equal(
    current.checks.some((c) => c.name === "version"),
    false,
    "an up-to-date install is not worth a check line on every run",
  );
});

test("an update check that throws cannot fail the status report", async () => {
  const report = await collectStatus({
    checkUpdate: async () => {
      throw new Error("registry exploded");
    },
  });
  assert.equal(report.server.update?.latest, undefined);
  assert.ok(report.server.version, "the rest of the report is unaffected");
});
