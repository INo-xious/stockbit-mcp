import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandEnvPath, familyForPath, findBrowser, findBrowsers } from "../src/auth/browsers.ts";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("expandEnvPath substitutes set variables", () => {
  withEnv({ STOCKBIT_TEST_DIR: "C:\\Base" }, () => {
    assert.equal(expandEnvPath("%STOCKBIT_TEST_DIR%\\app.exe"), "C:\\Base\\app.exe");
  });
});

test("expandEnvPath returns null when a variable is unset, so the path is skipped", () => {
  withEnv({ STOCKBIT_TEST_MISSING: undefined }, () => {
    assert.equal(expandEnvPath("%STOCKBIT_TEST_MISSING%\\app.exe"), null);
  });
});

test("familyForPath separates Gecko from Chromium", () => {
  assert.equal(familyForPath("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), "firefox");
  assert.equal(familyForPath("/usr/bin/librewolf"), "firefox");
  assert.equal(familyForPath("C:\\...\\msedge.exe"), "chromium");
  assert.equal(familyForPath("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"), "chromium");
});

test("STOCKBIT_BROWSER overrides discovery and wins the ordering", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-test-"));
  const fake = join(dir, "my-chrome.exe");
  writeFileSync(fake, "");
  withEnv({ STOCKBIT_BROWSER: fake }, () => {
    const found = findBrowsers();
    assert.equal(found[0].path, fake);
    assert.equal(found[0].name, "STOCKBIT_BROWSER");
    assert.equal(found[0].supported, true);
    assert.equal(findBrowser(), fake);
  });
});

test("STOCKBIT_BROWSER pointing at nothing fails loudly instead of silently falling back", () => {
  withEnv({ STOCKBIT_BROWSER: join(tmpdir(), "no-such-browser-here.exe") }, () => {
    assert.throws(() => findBrowsers(), /does not exist/);
  });
});

test("a Firefox override is reported but marked unsupported (CDP removed in v141)", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-test-"));
  const fake = join(dir, "firefox.exe");
  writeFileSync(fake, "");
  withEnv({ STOCKBIT_BROWSER: fake }, () => {
    // Located by path, not by index: unsupported entries deliberately sort to the end even when
    // they came from the override.
    const entry = findBrowsers().find((b) => b.path === fake);
    assert.ok(entry, "the override should still be reported");
    assert.equal(entry.family, "firefox");
    assert.equal(entry.supported, false);
    // findBrowser only returns something it can actually drive.
    assert.notEqual(findBrowser(), fake);
  });
});

test("discovery returns no duplicate executables", () => {
  const paths = findBrowsers().map((b) => b.path.toLowerCase());
  assert.equal(new Set(paths).size, paths.length, "the same browser was listed twice");
});

test("drivable browsers sort ahead of unsupported ones", () => {
  const found = findBrowsers();
  const firstUnsupported = found.findIndex((b) => !b.supported);
  if (firstUnsupported !== -1) {
    assert.ok(
      found.slice(firstUnsupported).every((b) => !b.supported),
      "a supported browser was listed after an unsupported one",
    );
  }
});
