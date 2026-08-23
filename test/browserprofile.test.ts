/**
 * The pinned browser identity.
 *
 * The property that matters: a missing or malformed record reads as "not pinned" rather than
 * throwing, because the caller's next step is the same either way — tell the user to log in — and a
 * throw from a helper this small would surface as a stack trace in an MCP tool result.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-profile-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearBrowserProfile,
  pinnedBrowserExists,
  profileRecordPath,
  readBrowserProfile,
  writeBrowserProfile,
} from "../src/auth/browserprofile.ts";

test("no record means not pinned, not an error", () => {
  clearBrowserProfile();
  assert.equal(readBrowserProfile(), null);
});

test("a written record round-trips with the browser's name and family", () => {
  const record = writeBrowserProfile("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
  assert.ok(record);
  const read = readBrowserProfile();
  assert.equal(read?.browserPath, record!.browserPath);
  assert.equal(read?.browserName, "Brave Browser");
  assert.equal(read?.family, "chromium");
  assert.ok(read?.loggedInAt, "the record says when it was pinned");
});

test("the record carries no credential", () => {
  writeBrowserProfile("/usr/bin/chromium");
  const raw = JSON.stringify(readBrowserProfile());
  for (const secret of ["token", "refresh", "cookie", "password", "pin"]) {
    assert.doesNotMatch(raw, new RegExp(secret, "i"), `the pin must not carry a ${secret}`);
  }
});

test("a malformed record reads as not pinned", () => {
  writeFileSync(profileRecordPath(), "{ not json", "utf8");
  assert.equal(readBrowserProfile(), null);
  writeFileSync(profileRecordPath(), JSON.stringify({ browserName: "no path here" }), "utf8");
  assert.equal(readBrowserProfile(), null, "a record without a path names no browser");
});

test("a pinned browser that has been uninstalled is nameable", () => {
  // The point of the pin is a message the user can act on: "the browser you logged in with is
  // gone", rather than a silent fall back to a different browser with no session.
  const record = writeBrowserProfile("/nonexistent/Some Browser");
  assert.ok(record);
  assert.equal(pinnedBrowserExists(record!), false);
  assert.equal(record!.browserName, "Some Browser");
});

test("clear removes the record", () => {
  writeBrowserProfile("/usr/bin/chromium");
  clearBrowserProfile();
  assert.equal(readBrowserProfile(), null);
});
