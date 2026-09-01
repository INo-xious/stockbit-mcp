/**
 * The gate that decides whether `mcp-publisher publish` runs.
 *
 * This test exists because of a specific, observed production failure. Only half the release
 * pipeline had ever been made idempotent: the npm half asks "is this version already published?"
 * and skips when it is, while both `registry` jobs ran `mcp-publisher publish` unconditionally. On
 * v1.3.0 the second workflow to arrive re-published what the first had just published:
 *
 *     Error: publish failed: server returned status 400: {"title":"Bad Request","status":400,
 *     "detail":"Failed to publish server","errors":[{"message":"invalid version: cannot publish
 *     duplicate version"}]}
 *
 * — a red run reporting a failure that had in fact already succeeded.
 *
 * `scripts/mcp-registry-version-state.mjs` is the missing question, with the same three outcomes as
 * its npm sibling: `present`, `absent`, and "could not determine". Two properties carry most of the
 * weight here, and neither is obvious:
 *
 *   1. `search` on this endpoint is a SUBSTRING match, so a hit must be confirmed by comparing
 *      `server.name` AND `server.version` exactly. A test below publishes a decoy.
 *   2. A 404 is NOT "absent" here — the deliberate opposite of the npm sibling, where 404 is the
 *      legitimate first-publish answer. This endpoint answers 200 with an empty `servers` array for
 *      a server it has never heard of, so a 404 means the API moved.
 *
 * The registry is injectable — a `fetch` function for the module, a `--response-file` or a
 * `--registry` pointing at a local `node:http` fixture for the CLI — so none of this touches the
 * network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";

import {
  ABSENT,
  PRESENT,
  UndeterminedError,
  mcpRegistryVersionState,
  parseArgs,
  searchUrl,
  serverDefaults,
  stateFromSearch,
} from "../scripts/mcp-registry-version-state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "mcp-registry-version-state.mjs");
const TMP = mkdtempSync(join(tmpdir(), "mcp-registry-state-"));

const NAME = "io.github.INo-xious/stockbit-mcp";

/** One entry in the shape the registry actually serves, trimmed to what this reads. */
function entry(name: string, version: string) {
  return {
    server: { name, version, description: "…", packages: [{ identifier: "stockbit-mcp", version }] },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  };
}

/** The registry's real answer for "nothing matched" — HTTP 200, empty array. Verified live. */
const EMPTY = JSON.stringify({ servers: [], metadata: { count: 0 } });

const found = (...entries: ReturnType<typeof entry>[]) =>
  JSON.stringify({ servers: entries, metadata: { count: entries.length } });

/** `fetch` stand-in: answers once per call from a scripted list, and counts the calls. */
function fakeFetch(replies: Array<{ status: number; body?: string } | Error>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(String(url));
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status,
      text: async () => reply.body ?? "",
    } as unknown as Response;
  };
  return Object.assign(fn, { calls });
}

/** No real waiting between retries — the retry policy is under test, not the clock. */
const noSleep = async () => {};

const ask = (options: Record<string, unknown>) =>
  mcpRegistryVersionState({ name: NAME, version: "1.3.0", sleep: noSleep, ...options });

const execFileAsync = promisify(execFile);

/**
 * Run the CLI and report exactly what a workflow step would see.
 *
 * Asynchronous on purpose. `execFileSync` blocks this process's event loop, which would deadlock
 * the `node:http` fixture below: the server lives here, so a synchronous child would sit waiting
 * for a connection this process could not accept until the child's own timeout expired.
 */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/* --------------------------------- the three outcomes --------------------------------- */

test("a version the registry lists is present", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: found(entry(NAME, "1.3.0")) }]);
  assert.equal(await ask({ fetch: fetchImpl }), PRESENT);
});

test("an empty servers array is absent — the registry's real answer, not an error", async () => {
  // Verified against the live registry: an unknown version and an unknown server BOTH answer
  // HTTP 200 with {"servers":[],"metadata":{"count":0}}. This is the first-publish case, and
  // reading it as anything but "absent" would make every new version unpublishable.
  const fetchImpl = fakeFetch([{ status: 200, body: EMPTY }]);
  assert.equal(await ask({ fetch: fetchImpl }), ABSENT);
});

test("the right server at the wrong version is absent", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: found(entry(NAME, "1.2.4")) }]);
  assert.equal(await ask({ fetch: fetchImpl, version: "1.3.0" }), ABSENT);
});

/* ------------------- the search is a substring match, so the check is not ------------------- */

test("another publisher's server whose name CONTAINS ours does not count as ours", async () => {
  // `search` matches substrings. Someone else publishing `io.github.somebody/stockbit-mcp-fork`,
  // or simply a registry that ranks loosely, must never be able to convince this workflow that OUR
  // version is already published — that would silently omit a release from the registry forever.
  const decoy = found(
    entry("io.github.somebody/stockbit-mcp-fork", "1.3.0"),
    entry("io.github.other/prefixed-io.github.INo-xious/stockbit-mcp", "1.3.0"),
  );
  assert.equal(await ask({ fetch: fakeFetch([{ status: 200, body: decoy }]) }), ABSENT);
});

test("a hit needs the name AND the version to match, and finds ours among decoys", async () => {
  const mixed = found(
    entry("io.github.somebody/stockbit-mcp-fork", "1.3.0"),
    entry(NAME, "1.2.4"),
    entry(NAME, "1.3.0"),
  );
  assert.equal(await ask({ fetch: fakeFetch([{ status: 200, body: mixed }]) }), PRESENT);
});

/* ------------------------------- could not determine ------------------------------- */

test("a 404 is undeterminable here, NOT absent", async () => {
  // The deliberate difference from the npm sibling, where 404 legitimately means "never published".
  // This endpoint answers 200 for every real query, so a 404 means the API moved — and treating a
  // moved API as "absent" would be a guess dressed as an answer.
  const fetchImpl = fakeFetch([{ status: 404, body: "not found" }]);
  await assert.rejects(ask({ fetch: fetchImpl, retries: 0 }), (error: Error) => {
    assert.ok(error instanceof UndeterminedError);
    assert.match(error.message, /HTTP 404/);
    return true;
  });
});

test("HTTP 500 is undeterminable, and is retried first", async () => {
  const fetchImpl = fakeFetch([{ status: 500, body: "upstream error" }]);
  await assert.rejects(ask({ fetch: fetchImpl, retries: 2 }), (error: Error) => {
    assert.ok(error instanceof UndeterminedError);
    assert.match(error.message, /HTTP 500/, "the human needs the status to act on");
    return true;
  });
  assert.equal(fetchImpl.calls.length, 3, "one attempt plus two retries");
});

test("a transport failure is reported as a transport failure, not as a verdict", async () => {
  const fetchImpl = fakeFetch([new Error("getaddrinfo ENOTFOUND registry.modelcontextprotocol.io")]);
  await assert.rejects(ask({ fetch: fetchImpl, retries: 1 }), (error: Error) => {
    assert.ok(error instanceof UndeterminedError);
    assert.match(error.message, /transport failure/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
});

test("a malformed body is undeterminable", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: '{"servers": [' }]);
  await assert.rejects(ask({ fetch: fetchImpl }), (error: Error) => {
    assert.ok(error instanceof UndeterminedError);
    assert.match(error.message, /valid JSON/);
    return true;
  });
});

test("a 200 body with no servers ARRAY is undeterminable", async () => {
  // Every real search response has one. A body without it is some other document — an error
  // envelope, a moved API — and reading "no servers, therefore absent" out of it is the fail-open
  // this pair of scripts exists to remove.
  await assert.rejects(ask({ fetch: fakeFetch([{ status: 200, body: '{"error":"gone"}' }]) }), UndeterminedError);
  await assert.rejects(
    ask({ fetch: fakeFetch([{ status: 200, body: '{"servers":{"0":{}}}' }]) }),
    UndeterminedError,
    "an object is not an array",
  );
  await assert.rejects(
    ask({ fetch: fakeFetch([{ status: 200, body: "[1,2,3]" }]) }),
    UndeterminedError,
    "a bare array is not a search response",
  );
});

test("junk entries inside a well-formed servers array do not throw, they just do not match", () => {
  const body = { servers: [null, 42, "x", {}, { server: null }, { server: { name: NAME } }] };
  assert.equal(stateFromSearch(body, NAME, "1.3.0"), ABSENT);
});

/* ---------------------------- the name is data, not a URL ---------------------------- */

test("the name and version are percent-encoded into the query, never concatenated", () => {
  const url = searchUrl(NAME, "1.3.0");
  assert.match(url, /\/v0\/servers\?search=/);
  assert.ok(url.includes(encodeURIComponent(NAME)), "the slash in the name must survive as %2F");
  assert.ok(!url.includes(`search=${NAME}`), "an unencoded slash would change the path");

  // A name or version carrying a `&` must not be able to add a parameter of its own.
  const hostile = searchUrl("evil&version=1.0.0&x", "9&limit=1");
  assert.equal(hostile.split("?")[1].split("&").length, 2, "exactly two parameters, always");
});

test("a trailing slash on the registry does not produce a doubled path", () => {
  assert.equal(
    searchUrl("n", "1", "https://example.test//"),
    searchUrl("n", "1", "https://example.test"),
  );
});

/* ------------------------------------- the CLI ------------------------------------- */

test("the CLI prints the word and exits 0 for both real answers", async () => {
  const present = join(TMP, "present.json");
  writeFileSync(present, found(entry(NAME, "1.3.0")));
  const hit = await runCli(["--name", NAME, "--version", "1.3.0", "--response-file", present]);
  assert.equal(hit.code, 0);
  assert.equal(hit.stdout.trim(), PRESENT);

  const empty = join(TMP, "empty.json");
  writeFileSync(empty, EMPTY);
  const miss = await runCli(["--name", NAME, "--version", "1.3.0", "--response-file", empty]);
  assert.equal(miss.code, 0);
  assert.equal(miss.stdout.trim(), ABSENT);
});

test("the CLI exits 2 and prints NOTHING on stdout when it cannot determine", async () => {
  // The workflow reads the WORD. If a failure ever printed `absent`, the release pipeline would act
  // on a guess; if it printed nothing but exited 0, the `case` would fall through to the default.
  const broken = join(TMP, "broken.json");
  writeFileSync(broken, "{ not json");
  const result = await runCli(["--name", NAME, "--version", "1.3.0", "--response-file", broken]);
  assert.equal(result.code, 2, "2, not 1, so a caller can tell it from a shell error");
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /mcp-registry-version-state:/);
  assert.doesNotMatch(result.stdout, /absent|present/);
});

test("an unreadable response file is undeterminable, not absent", async () => {
  const result = await runCli([
    "--name", NAME, "--version", "1.3.0",
    "--response-file", join(TMP, "does-not-exist.json"),
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout.trim(), "");
});

test("an unknown flag is a hard error rather than a silently ignored argument", async () => {
  assert.throws(() => parseArgs(["--registry-file", "x"]), UndeterminedError);
  assert.throws(() => parseArgs(["--name"]), /needs a value/);
  assert.throws(() => parseArgs(["--retries", "-1"]), /non-negative/);
  assert.deepEqual(parseArgs(["--name=a", "--version", "1"]), { name: "a", version: "1" });

  const result = await runCli(["--nope"]);
  assert.equal(result.code, 2, "an unrecognised flag must not be treated as a default lookup");
});

test("the CLI talks to a real HTTP registry over --registry", async () => {
  // Proves the network path end to end without the network: the same code the workflow runs, over
  // a real socket, against a server that answers what the registry answers.
  let lastPath = "";
  const server: Server = createServer((req, res) => {
    lastPath = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(found(entry(NAME, "1.3.0")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await runCli(["--name", NAME, "--version", "1.3.0", "--registry", `http://127.0.0.1:${port}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), PRESENT);
    assert.match(lastPath, /^\/v0\/servers\?search=/, "the endpoint the registry actually serves");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a registry that 500s makes the CLI exit 2, never absent", async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("upstream error");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await runCli([
      "--name", NAME, "--version", "1.3.0",
      "--registry", `http://127.0.0.1:${port}`, "--retries", "0",
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout.trim(), "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* --------------------------- the defaults come from server.json --------------------------- */

test("the defaults are server.json's, because that is the document mcp-publisher sends", () => {
  // Not package.json. `test/distribution.test.ts` pins the two equal, but the workflow must ask
  // about the version it is actually about to publish, whatever any other file says.
  const defaults = serverDefaults();
  assert.equal(typeof defaults.name, "string");
  assert.ok(defaults.name.length > 0);
  assert.match(defaults.version, /^\d+\.\d+\.\d+/);
});

test("an unreadable server.json is undeterminable rather than an empty lookup", () => {
  assert.throws(() => serverDefaults(join(TMP, "no-such-dir")), UndeterminedError);
});

/* ------------- the property that matters most: nothing invents an answer ------------- */

test("NO internal failure produces present or absent", async () => {
  // The sweep. `present` would silently omit a release from the registry; `absent` would send a
  // publish the registry refuses. Every one of these must be the third outcome instead.
  const disasters: Array<[string, Record<string, unknown>]> = [
    ["no name", { name: "" }],
    ["no version", { version: "" }],
    ["name is not a string", { name: undefined }],
    ["version is not a string", { version: 130 as unknown as string }],
    ["404", { fetch: fakeFetch([{ status: 404 }]), retries: 0 }],
    ["401", { fetch: fakeFetch([{ status: 401 }]), retries: 0 }],
    ["truncated JSON", { fetch: fakeFetch([{ status: 200, body: "{" }]), retries: 0 }],
    ["HTML error page", { fetch: fakeFetch([{ status: 200, body: "<html>502</html>" }]), retries: 0 }],
    ["null body", { fetch: fakeFetch([{ status: 200, body: "null" }]), retries: 0 }],
    ["servers missing", { fetch: fakeFetch([{ status: 200, body: "{}" }]), retries: 0 }],
    ["fetch throws", { fetch: fakeFetch([new Error("boom")]), retries: 0 }],
    // `null`, not `undefined`: a destructuring default only fills in `undefined`, so this actually
    // exercises "the injected fetch is unusable" rather than quietly falling back to the global one.
    ["fetch is not a function", { fetch: null as unknown as typeof fetch, retries: 0 }],
  ];

  for (const [label, options] of disasters) {
    await assert.rejects(
      ask(options),
      (error: unknown) => {
        assert.ok(error instanceof Error, `${label}: threw a non-Error`);
        return true;
      },
      `${label} must never resolve to a verdict`,
    );
  }
});
