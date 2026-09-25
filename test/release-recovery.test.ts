import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");

/** Execute the code shipped in the workflow, not a second implementation of its policy. */
function stepScript(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `release workflow has no step named ${name}`);
  const boundary = lines.findIndex((line, index) => index > start && (/^      - /.test(line) || /^  \w+:$/.test(line)));
  const step = lines.slice(start, boundary < 0 ? undefined : boundary);
  const run = step.indexOf("        run: |");
  assert.ok(run >= 0, `${name} must have an executable script`);
  return step.slice(run + 1).filter((line) => line.startsWith("          ") || !line.trim())
    .map((line) => line.slice(10)).join("\n").trim();
}

const reuseStep = stepScript("Reuse the published tarball");
const heredoc = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE$/.exec(reuseStep);
assert.ok(heredoc, "the recovery step must expose its inline Node script");
const recoveryBody = heredoc[1].replace(/^import .+ from 'node:(?:crypto|fs\/promises)';\n/gm, "");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const recover = new AsyncFunction(
  "fetch", "readFile", "writeFile", "createHash", "process", "Buffer", "AbortSignal", "console", recoveryBody,
) as (...args: unknown[]) => Promise<void>;

const fixturePackage = { name: "stockbit-mcp", version: "1.4.1", mcpName: "io.github.INo-xious/stockbit-mcp" };
const fixtureBytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x80, 0x0a, 0x42]);
const tarballUrl = "https://registry.npmjs.org/stockbit-mcp/-/stockbit-mcp-1.4.1.tgz";

function recoveryHarness(options: {
  metadata?: (metadata: Record<string, any>) => unknown;
  metadataStatus?: number;
  tarballStatus?: number;
  bytes?: Buffer;
  fetchError?: Error;
} = {}) {
  const metadata = {
    ...fixturePackage,
    dist: { tarball: tarballUrl, integrity: `sha512-${createHash("sha512").update(fixtureBytes).digest("base64")}` },
  };
  const responseMetadata = options.metadata ? options.metadata(metadata) : metadata;
  const calls: string[] = [];
  const writes: Array<{ path: string; bytes: Buffer }> = [];
  const fetch = async (url: string | URL) => {
    calls.push(String(url));
    if (options.fetchError) throw options.fetchError;
    const isMetadata = calls.length === 1;
    const status = (isMetadata ? options.metadataStatus : options.tarballStatus) ?? 200;
    assert.ok(calls.length <= 2, "recovery must not retry an unexpected request");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => { assert.ok(isMetadata); return responseMetadata; },
      arrayBuffer: async () => {
        assert.ok(!isMetadata);
        const bytes = options.bytes ?? fixtureBytes;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  const run = () => recover(
    fetch,
    async (path: string, encoding: string) => {
      assert.equal(path, "package.json");
      assert.equal(encoding, "utf8");
      return JSON.stringify(fixturePackage);
    },
    async (path: string, bytes: Buffer) => { writes.push({ path, bytes: Buffer.from(bytes) }); },
    createHash,
    { env: { VERSION: fixturePackage.version } },
    Buffer,
    AbortSignal,
    { log() {} },
  );
  return { run, calls, writes };
}

test("release recovery attaches exactly the verified npm bytes", async () => {
  const harness = recoveryHarness();
  await harness.run();
  assert.deepEqual(harness.calls, ["https://registry.npmjs.org/stockbit-mcp/1.4.1", tarballUrl]);
  assert.deepEqual(harness.writes, [{ path: "stockbit-mcp-1.4.1.tgz", bytes: fixtureBytes }]);
});

for (const [field, value] of [
  ["name", "another-package"], ["version", "1.4.0"], ["mcpName", "io.github.someone/stockbit-mcp"],
] as const) {
  test(`release recovery refuses a different published ${field}`, async () => {
    const harness = recoveryHarness({ metadata: (metadata) => ({ ...metadata, [field]: value }) });
    await assert.rejects(harness.run, /identity does not match/);
    assert.equal(harness.calls.length, 1, "wrong identity must stop before the tarball request");
    assert.deepEqual(harness.writes, []);
  });
}

for (const [stage, options] of [
  ["metadata", { metadataStatus: 404 }], ["tarball", { tarballStatus: 503 }],
] as const) {
  test(`release recovery refuses an HTTP failure fetching ${stage}`, async () => {
    const harness = recoveryHarness(options);
    await assert.rejects(harness.run, new RegExp(`npm ${stage} returned HTTP`));
    assert.equal(harness.calls.length, stage === "metadata" ? 1 : 2);
    assert.deepEqual(harness.writes, []);
  });
}

for (const url of [
  "http://registry.npmjs.org/stockbit-mcp.tgz",
  "https://example.test/stockbit-mcp.tgz",
  "https://registry.npmjs.org.example.test/stockbit-mcp.tgz",
]) {
  test(`release recovery refuses tarball origin ${new URL(url).origin}`, async () => {
    const harness = recoveryHarness({ metadata: (metadata) => ({ ...metadata, dist: { ...metadata.dist, tarball: url } }) });
    await assert.rejects(harness.run, /Unexpected npm tarball host/);
    assert.equal(harness.calls.length, 1, "untrusted origins must never be fetched");
    assert.deepEqual(harness.writes, []);
  });
}

test("release recovery does not save a tampered tarball", async () => {
  const harness = recoveryHarness({ bytes: Buffer.concat([fixtureBytes, Buffer.from("tampered")]) });
  await assert.rejects(harness.run, /integrity mismatch/);
  assert.deepEqual(harness.writes, []);
});

test("release recovery refuses metadata with no integrity proof", async () => {
  const harness = recoveryHarness({ metadata: (metadata) => ({ ...metadata, dist: { tarball: metadata.dist.tarball } }) });
  await assert.rejects(harness.run, /integrity mismatch/);
  assert.deepEqual(harness.writes, []);
});

test("release recovery never treats malformed metadata as an artifact", async () => {
  for (const metadata of [null, {}, { ...fixturePackage, dist: null }]) {
    const harness = recoveryHarness({ metadata: () => metadata });
    await assert.rejects(harness.run);
    assert.deepEqual(harness.writes, []);
  }
});

test("release recovery propagates a transport failure without an output or retry", async () => {
  const harness = recoveryHarness({ fetchError: new Error("fixture transport failure") });
  await assert.rejects(harness.run, /fixture transport failure/);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.writes, []);
});

function runReleaseShell(script: string, env: Record<string, string>) {
  // Hosted Windows runners include Git Bash. Avoid the Windows System32 WSL launcher.
  const bash = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
  if (process.platform === "win32") assert.ok(existsSync(bash), "Git Bash is required to exercise the release workflow shell");
  const result = spawnSync(bash, ["-c", script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}

test("release tag validation accepts version tags and rejects branch names and shell input", () => {
  const script = stepScript("Validate the release tag");
  for (const [tag, expected] of [
    ["v1.4.1", 0], ["v1.4.1-rc.1+build.2", 0],
    ["main", 1], ["refs/tags/v1.4.1", 1], ["1.4.1", 1], ["", 1],
    ["v1.4.1; printf TAG_INJECTION", 1], ["v1.4.1$(printf TAG_INJECTION)", 1],
    ["v1.4.1`printf TAG_INJECTION`", 1], ["v1.4.1\nVERSION=1.4.2", 1],
  ] as const) {
    const result = runReleaseShell(script, { RELEASE_TAG: tag });
    assert.equal(result.status, expected, `tag ${JSON.stringify(tag)}: ${result.stderr}`);
    assert.ok(!result.stdout.includes("TAG_INJECTION"));
  }
});

test("manual recovery cannot authorize a new npm publish, while tag pushes retain that path", () => {
  const source = stepScript("Is this version still unpublished?");
  const lookup = "node scripts/npm-version-state.mjs";
  assert.ok(source.includes(lookup), "replace only the registry lookup, keeping the real shell policy");
  const script = source.replace(lookup, 'printf "%s" "$FIXTURE_NPM_STATE"');
  for (const [event, state, expected, needed] of [
    ["workflow_dispatch", "absent", 1, undefined],
    ["workflow_dispatch", "present", 0, "false"],
    ["push", "absent", 0, "true"],
    ["push", "present", 0, "false"],
    ["workflow_dispatch", "unexpected", 1, undefined],
  ] as const) {
    const result = runReleaseShell(script, {
      RELEASE_EVENT: event,
      FIXTURE_NPM_STATE: state,
      VERSION: fixturePackage.version,
      GITHUB_OUTPUT: "/dev/stdout",
    });
    assert.equal(result.status, expected, `${event}/${state}: ${result.stderr}`);
    const output = /^needed=(true|false)$/m.exec(result.stdout)?.[1];
    assert.equal(output, needed, `${event}/${state} must not authorize the wrong action`);
  }
});
