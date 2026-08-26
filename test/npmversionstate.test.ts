/**
 * The gate that decides whether an irreversible `npm publish` happens.
 *
 * This test exists because of a specific, observed defect. The publish workflows used to ask "is
 * this version already on npm?" with an inline
 *
 *     if node -e "…process.exit(d.versions['$version'] ? 0 : 1)"; then …else publish=true; fi
 *
 * and *every* non-zero exit landed in the `else`. A missing file, malformed JSON, a syntax error
 * from the interpolated version string, an OOM — all of them read as "not published yet", which
 * means "publish it". Running that verbatim, `zod@3.23.8` — a version that unquestionably exists —
 * reported `publish=true`, because the temp file could not be read.
 *
 * `scripts/npm-version-state.mjs` replaces the two-outcome exit code with three outcomes:
 * `present`, `absent`, and "could not determine". The last one is the whole point, so the test that
 * matters most here is the one at the bottom: NO internal failure may ever produce `absent`.
 *
 * The registry is injectable — a `fetch` function for the module, a `--registry-file` or a
 * `--registry` pointing at a local `node:http` fixture for the CLI — so none of this touches the
 * network. A test that needed npm to be up could not run in the situation it is written to protect.
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
  npmVersionState,
  packumentUrl,
  parseArgs,
  stateFromPackument,
} from "../scripts/npm-version-state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "npm-version-state.mjs");
const TMP = mkdtempSync(join(tmpdir(), "npm-version-state-"));

/** A packument with the shape the registry actually serves, trimmed to what this reads. */
const PACKUMENT = {
  name: "stockbit-mcp",
  "dist-tags": { latest: "1.0.1" },
  versions: { "1.0.0": { name: "stockbit-mcp" }, "1.0.1": { name: "stockbit-mcp" } },
};

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
  npmVersionState({ name: "stockbit-mcp", version: "1.0.0", sleep: noSleep, ...options });

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

test("a package that has never been published at all is absent, not an error", async () => {
  // HTTP 404 is the legitimate first-publish case and the ONLY error-shaped answer allowed to mean
  // "absent". Getting this wrong makes the very first release of any package impossible.
  const fetchImpl = fakeFetch([{ status: 404 }]);
  assert.equal(await ask({ fetch: fetchImpl }), ABSENT);
  assert.equal(fetchImpl.calls.length, 1, "a 404 is a real answer and must not be retried");
});

test("a version the registry lists is present", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: JSON.stringify(PACKUMENT) }]);
  assert.equal(await ask({ fetch: fetchImpl, version: "1.0.1" }), PRESENT);
});

test("a version the registry does not list, on a package it does, is absent", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: JSON.stringify(PACKUMENT) }]);
  assert.equal(await ask({ fetch: fetchImpl, version: "1.1.0" }), ABSENT);
});

/* ------------------------------- could not determine ------------------------------- */

test("HTTP 500 is undeterminable, and never absent", async () => {
  // The status the old code could not distinguish from "not published". A registry outage must
  // stop a release, not authorise one.
  const fetchImpl = fakeFetch([{ status: 500, body: "upstream error" }]);
  await assert.rejects(
    ask({ fetch: fetchImpl, retries: 0 }),
    (error: Error) => {
      assert.ok(error instanceof UndeterminedError, "must be the undeterminable outcome");
      assert.match(error.message, /HTTP 500/, "the human needs the status to act on");
      assert.doesNotMatch(error.message, /absent/);
      return true;
    },
  );
});

test("a 5xx is retried, then still refuses to guess", async () => {
  const fetchImpl = fakeFetch([{ status: 503 }]);
  await assert.rejects(ask({ fetch: fetchImpl, retries: 2 }), UndeterminedError);
  assert.equal(fetchImpl.calls.length, 3, "one attempt plus two retries");
});

test("a transport failure is reported as a transport failure, not as a verdict", async () => {
  // DNS or TLS dying is the case Finding 13 is about: the old shell died on curl's bare exit code
  // with no annotation. The distinction between "could not reach" and "answered something odd"
  // is what tells the operator whether to retry or to investigate.
  const fetchImpl = fakeFetch([new Error("getaddrinfo ENOTFOUND registry.npmjs.org")]);
  await assert.rejects(ask({ fetch: fetchImpl, retries: 1 }), (error: Error) => {
    assert.ok(error instanceof UndeterminedError);
    assert.match(error.message, /transport failure/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
});

test("a malformed body is undeterminable", async () => {
  // A truncated CDN response is not "no versions".
  const fetchImpl = fakeFetch([{ status: 200, body: '{"versions": {' }]);
  await assert.rejects(ask({ fetch: fetchImpl }), (error: Error) => {
    assert.ok(error instanceof UndeterminedError);
    assert.match(error.message, /valid JSON/);
    return true;
  });
});

test("a 200 body with no versions map is undeterminable", async () => {
  // Every real packument has `versions`. A body without one is some other document — an error
  // envelope, a fully-unpublished placeholder — and reading "no versions, therefore absent" out of
  // it is exactly the fail-open this script removes.
  const fetchImpl = fakeFetch([{ status: 200, body: '{"error":"Not found"}' }]);
  await assert.rejects(ask({ fetch: fetchImpl }), UndeterminedError);

  await assert.rejects(
    ask({ fetch: fakeFetch([{ status: 200, body: "[1,2,3]" }]) }),
    UndeterminedError,
    "an array is not a packument either",
  );
});

/* ---------------------------- the version is data, not code ---------------------------- */

test("a version full of quotes, backslashes and newlines is looked up as a key", () => {
  // The old code pasted the version into JavaScript source, so a single quote closed the string
  // literal and the resulting SyntaxError exited non-zero — which the caller read as "publish".
  // Here the same input is an ordinary object key: no crash, and the verdict stays correct.
  const hostile = "1.0.0'\" \\ \n || process.exit(0); //";
  assert.equal(stateFromPackument(PACKUMENT, hostile), ABSENT);

  const listed = { versions: { [hostile]: {} } };
  assert.equal(stateFromPackument(listed, hostile), PRESENT, "even as a key it is just a key");
});

test("an inherited Object property is not a published version", () => {
  // `versions['constructor']` is truthy through the prototype chain, so the truthiness test this
  // replaces reported "already published" for it — a skipped publish with no error anywhere.
  for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(stateFromPackument(PACKUMENT, key), ABSENT, key);
  }
});

test("a scoped name stays one path segment and cannot inject a path or a query", () => {
  assert.equal(packumentUrl("stockbit-mcp"), "https://registry.npmjs.org/stockbit-mcp");
  assert.equal(packumentUrl("@scope/pkg"), "https://registry.npmjs.org/@scope%2Fpkg");
  assert.equal(
    packumentUrl("evil/../../other?x=1"),
    "https://registry.npmjs.org/evil%2F..%2F..%2Fother%3Fx%3D1",
  );
});

/* ------------------------------------- the CLI ------------------------------------- */

test("the CLI prints a word and exits 0 for both real answers", async () => {
  const file = join(TMP, "packument.json");
  writeFileSync(file, JSON.stringify(PACKUMENT));

  const present = await runCli(["--registry-file", file, "--version", "1.0.1"]);
  assert.equal(present.code, 0);
  assert.equal(present.stdout.trim(), "present");

  const absent = await runCli(["--registry-file", file, "--version", "9.9.9"]);
  assert.equal(absent.code, 0);
  assert.equal(absent.stdout.trim(), "absent");
});

test("the CLI passes a hostile version through argv without evaluating it", async () => {
  const file = join(TMP, "packument.json");
  writeFileSync(file, JSON.stringify(PACKUMENT));
  const result = await runCli(["--registry-file", file, "--version", "1.0.0'; process.exit(0); //"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "absent", "an unlisted version is absent, however it is spelled");
});

test("the CLI rejects an unusable argument rather than falling back to a default", async () => {
  const result = await runCli(["--nope", "1"]);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stdout, /absent/);
});

test("the CLI reports a real HTTP status end to end", async () => {
  // A `node:http` fixture on 127.0.0.1, so the CLI's own fetch, retry and status handling run for
  // real without npm being involved.
  const server: Server = createServer((req, res) => {
    if (req.url?.includes("gone")) {
      res.writeHead(404).end("{}");
    } else if (req.url?.includes("broken")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"versions":');
    } else {
      res.writeHead(500).end("upstream is unwell");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const registry = `http://127.0.0.1:${port}`;

  try {
    const missing = await runCli(["--registry", registry, "--name", "gone", "--version", "1.0.0"]);
    assert.equal(missing.code, 0);
    assert.equal(missing.stdout.trim(), "absent", "404 means the package has never been published");

    const broken = await runCli(["--registry", registry, "--name", "broken", "--version", "1.0.0", "--retries", "0"]);
    assert.equal(broken.code, 2);
    assert.doesNotMatch(broken.stdout, /absent/);

    const failing = await runCli(["--registry", registry, "--name", "boom", "--version", "1.0.0", "--retries", "0"]);
    assert.equal(failing.code, 2);
    assert.match(failing.stderr, /HTTP 500/);
    assert.doesNotMatch(failing.stdout, /absent/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/* ------------------------------- THE REGRESSION ------------------------------- */

test("no internal failure can ever produce the word absent", async () => {
  // This is the test the whole file is for. Each entry is a way the old inline check exited
  // non-zero and was therefore read as "not published, publish it".
  const file = join(TMP, "packument.json");
  const failures: Array<{ what: string; args: string[] }> = [
    { what: "the packument file does not exist", args: ["--registry-file", join(TMP, "absent.json")] },
    { what: "the packument file is not JSON", args: ["--registry-file", join(TMP, "garbage.json")] },
    { what: "the packument file is JSON but not a packument", args: ["--registry-file", join(TMP, "empty.json")] },
    { what: "the version is empty", args: ["--registry-file", file, "--version", ""] },
    { what: "a flag has no value", args: ["--registry-file"] },
    { what: "the flag is not one this script has", args: ["--publish-anyway"] },
  ];
  writeFileSync(join(TMP, "garbage.json"), "<!doctype html><h1>502 Bad Gateway</h1>");
  writeFileSync(join(TMP, "empty.json"), "{}");

  for (const { what, args } of failures) {
    const result = await runCli([...args, ...(args.includes("--version") ? [] : ["--version", "1.0.0"])]);
    assert.notEqual(result.code, 0, `${what}: must not exit 0`);
    assert.doesNotMatch(result.stdout, /absent/, `${what}: must not print absent`);
    assert.ok(result.stderr.length > 0, `${what}: must say why on stderr`);
  }

  // And the same guarantee at the module boundary, where the workflows' successor might call it.
  for (const broken of [{ status: 418 }, { status: 200, body: "not json" }, { status: 200, body: "null" }]) {
    const state = await ask({ fetch: fakeFetch([broken]), retries: 0 }).then(
      (value) => value,
      () => "threw",
    );
    assert.notEqual(state, ABSENT, `${JSON.stringify(broken)} must not resolve to absent`);
  }
});

/* ---------------------------------- argument parsing ---------------------------------- */

test("flags are accepted in both spellings and validated", () => {
  assert.deepEqual(parseArgs(["--name", "a", "--version=1.2.3"]), { name: "a", version: "1.2.3" });
  assert.deepEqual(parseArgs(["--retries=3", "--timeout", "500"]), { retries: 3, timeoutMs: 500 });
  assert.throws(() => parseArgs(["--retries", "soon"]), UndeterminedError);
  assert.throws(() => parseArgs(["--timeout", "-1"]), UndeterminedError);
});
