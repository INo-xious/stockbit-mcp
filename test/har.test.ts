import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainMiss, scanHar, scanHarFile } from "../src/auth/har.ts";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig-part";
const BODY = JSON.stringify({ data: { token_data: { refresh: { token: JWT } } } });

const entry = (url: string, content: Record<string, unknown> | null) => ({
  request: { url },
  response: { content: content ?? {} },
});

const har = (...entries: unknown[]) => ({ log: { version: "1.2", entries } });

test("scanHar finds a token in a plaintext login response", () => {
  const r = scanHar(
    har(
      entry("https://stockbit.com/_next/static/chunks/login.js", { text: "console.log(1)" }),
      entry("https://exodus.stockbit.com/login/v6/username", { text: BODY, mimeType: "application/json" }),
    ),
  );
  assert.equal(r.match?.refresh, JWT);
  assert.equal(r.match?.entryIndex, 1);
});

test("scanHar decodes base64 bodies (Chrome encodes even textual JSON sometimes)", () => {
  const r = scanHar(
    har(entry("https://exodus.stockbit.com/login/v6/social", {
      text: Buffer.from(BODY, "utf8").toString("base64"),
      encoding: "base64",
    })),
  );
  assert.equal(r.match?.refresh, JWT);
});

test("scanHar accepts the new-device verify response (how a real login actually lands)", () => {
  const r = scanHar(
    har(entry("https://exodus.stockbit.com/login/v4/new-device/prompt/verify", { text: BODY })),
  );
  assert.equal(r.match?.refresh, JWT);
});

test("scanHar ignores token sources for other audiences", () => {
  const r = scanHar(
    har(
      entry("https://api-sekuritas.stockbit.com/partner/eipo/access_token", { text: BODY }),
      entry("https://carina.stockbit.com/auth/refresh", { text: BODY }),
      entry("https://evil.test/login/v6/username", { text: BODY }),
    ),
  );
  assert.equal(r.match, null);
  assert.equal(r.candidateUrls.length, 0);
});

test("scanHar reports body-less candidates separately — the 'Copy all as HAR' mistake", () => {
  const r = scanHar(har(entry("https://exodus.stockbit.com/login/v6/username", null)));
  assert.equal(r.match, null);
  assert.equal(r.candidateUrls.length, 1);
  assert.equal(r.candidatesWithoutBody, 1);
  assert.match(explainMiss(r), /Export \(download\) button/);
});

test("explainMiss distinguishes an empty log from a log with no login in it", () => {
  assert.match(explainMiss(scanHar(har())), /no entries at all/);
  const noLogin = scanHar(har(entry("https://stockbit.com/", { text: "<html>" })));
  assert.match(explainMiss(noLogin), /Preserve log/);
});

test("scanHar rejects a non-HAR file with an actionable message", () => {
  assert.throws(() => scanHar({ nope: true }), /not a HAR archive/);
  assert.throws(() => scanHar(null), /not a HAR archive/);
});

test("scanHar tolerates malformed entries without throwing", () => {
  const r = scanHar(har(null, 42, "string", {}, { request: {} }, { request: { url: 5 } }));
  assert.equal(r.match, null);
  assert.equal(r.totalEntries, 6);
});

test("scanHarFile reads and parses from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "har-test-"));
  const file = join(dir, "login.har");
  writeFileSync(
    file,
    JSON.stringify(har(entry("https://exodus.stockbit.com/login/v6/username", { text: BODY }))),
  );
  assert.equal(scanHarFile(file).match?.refresh, JWT);
});

test("scanHarFile errors clearly on unreadable and non-JSON input", () => {
  assert.throws(() => scanHarFile(join(tmpdir(), "definitely-missing.har")), /Cannot read/);
  const dir = mkdtempSync(join(tmpdir(), "har-test-"));
  const bad = join(dir, "bad.har");
  writeFileSync(bad, "{not json");
  assert.throws(() => scanHarFile(bad), /not valid JSON/);
});

// V8 produces two different SyntaxError shapes: input that STARTS with a valid JSON token fails
// with a positional message that quotes nothing, while input that does not fails with
// `Unexpected token 'h', "hunter2..." is not valid JSON` — which embeds the file's own bytes.
// Testing only the first shape would pass while the leaking branch went unexercised, so both are
// covered here.
for (const [shape, contents] of [
  ["truncated but JSON-shaped", `{"password":"hunter2","cookie":"SESSION=abc"`],
  ["not JSON at all", `hunter2 SESSION=abc refresh_token=eyJhbGciOiJIUzI1NiJ9.payload.sig`],
  ["an HTML error page", `<!doctype html><body>hunter2 SESSION=abc</body>`],
] as const) {
  test(`a HAR parse error never echoes file contents — ${shape}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "har-test-"));
    const bad = join(dir, "secret.har");
    writeFileSync(bad, contents);
    try {
      scanHarFile(bad);
      assert.fail("should have thrown");
    } catch (err) {
      const msg = `${String(err)} ${err instanceof Error ? (err.stack ?? "") : ""}`;
      assert.ok(!msg.includes("hunter2"), `error leaked file contents: ${msg}`);
      assert.ok(!msg.includes("SESSION=abc"), `error leaked a cookie: ${msg}`);
      assert.ok(!msg.includes("eyJhbGciOiJIUzI1NiJ9"), `error leaked a token: ${msg}`);
      assert.match(msg, /not valid JSON/);
    }
  });
}
