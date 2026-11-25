/** Cross-process regression for #45. All Keychain commands are simulated; stores are temporary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a running process adopts another process's file fallback without restarting", () => {
  const dir = mkdtempSync(join(tmpdir(), "stockbit-store-handoff-"));
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", String.raw`
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";

        const realSpawnSync = childProcess.spawnSync;
        let keychainCalls = 0;
        childProcess.spawnSync = (command, args) => {
          assert.equal(command, "security", "no real Keychain or unexpected command may run");
          keychainCalls++;
          if (args[0] === "-h") return { status: 0, stdout: "" };
          if (args[0] === "find-generic-password") return { status: 44, stdout: "" };
          throw new Error("Unexpected simulated Keychain operation: " + args[0]);
        };
        syncBuiltinESMExports();
        Object.defineProperty(process, "platform", { value: "darwin" });

        const moduleUrl = process.argv[1];
        const { getStore } = await import(moduleUrl);
        const old = getStore("securities");
        const other = getStore("eipo");
        assert.equal(old.backend, "keychain");
        assert.equal(old.readState(), "absent");
        assert.equal(getStore("securities"), old, "reuse a current backend choice");

        // A separate login process writes the encrypted credential and the fallback marker.
        const writer = realSpawnSync(process.execPath, [
          "--import", "tsx", "--input-type=module", "--eval",
          'const { getStore, recordBackendFallback } = await import(process.argv[1]);' +
          'getStore("securities").set("fixture-session-after-fallback");' +
          'recordBackendFallback("securities");',
          moduleUrl,
        ], {
          env: { ...process.env, STOCKBIT_FORCE_FILE_STORE: "1" },
          encoding: "utf8",
          timeout: 20_000,
        });
        assert.equal(writer.status, 0, writer.stderr);

        const current = getStore("securities");
        assert.equal(current.backend, "file", "the cached Keychain choice must be replaced");
        assert.equal(current.readState(), "present");
        assert.equal(current.get(), "fixture-session-after-fallback");
        assert.equal(getStore("eipo"), other, "another slot's backend must stay unchanged");
        const callsAfterHandoff = keychainCalls;
        current.set("fixture-rotated-session");
        assert.equal(getStore("securities").get(), "fixture-rotated-session");
        assert.equal(getStore("securities"), current, "reuse the adopted file store");
        current.clear();
        assert.equal(current.readState(), "absent");
        assert.equal(keychainCalls, callsAfterHandoff, "file operations must not use the Keychain");
      `,
      new URL("../src/auth/store.ts", import.meta.url).href,
    ], {
      env: { ...process.env, STOCKBIT_STORE_DIR: dir, STOCKBIT_FORCE_FILE_STORE: "0" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
