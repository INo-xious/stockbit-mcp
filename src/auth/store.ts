/**
 * Refresh-token store. Prefers the macOS Keychain (via the built-in `security` CLI — no native
 * module to compile), and falls back to an AES-256-GCM encrypted file elsewhere.
 *
 * Only the long-lived REFRESH token is persisted. Access tokens are short-lived and derived at
 * runtime, so they never touch disk.
 *
 * File-fallback caveat: the key is derived from machine + user identifiers, which protects against
 * casual disk reads but not a determined local attacker. The Keychain path is strongly preferred.
 */
import { spawnSync } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { KEYCHAIN } from "../config.js";

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
  readonly backend: "keychain" | "file";
}

/* ------------------------------- macOS Keychain ------------------------------- */

function keychainAvailable(): boolean {
  // Test/CI override: force the file backend so we never touch the real Keychain.
  if (process.env.STOCKBIT_FORCE_FILE_STORE === "1") return false;
  if (process.platform !== "darwin") return false;
  const r = spawnSync("security", ["-h"], { stdio: "ignore" });
  return r.status === 0 || r.status === 1; // `security -h` exits non-zero but exists
}

const keychainStore: TokenStore = {
  backend: "keychain",
  get() {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return null;
    const token = r.stdout.trim();
    return token.length ? token : null;
  },
  set(token: string) {
    // -U updates if it already exists. Value passed via -w.
    const r = spawnSync(
      "security",
      [
        "add-generic-password",
        "-s", KEYCHAIN.service,
        "-a", KEYCHAIN.account,
        "-w", token,
        "-U",
        "-T", "", // no app is pre-authorized; prompts on access
      ],
      { stdio: "ignore" },
    );
    if (r.status !== 0) throw new Error("Keychain write failed");
  },
  clear() {
    spawnSync(
      "security",
      ["delete-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account],
      { stdio: "ignore" },
    );
  },
};

/* --------------------------------- File fallback --------------------------------- */

// STOCKBIT_STORE_DIR lets tests point the encrypted file at an isolated temp dir. Read dynamically
// (not a module-load const) so multiple test files with different dirs don't collide on a stale path.
function fileDir(): string {
  return process.env.STOCKBIT_STORE_DIR || join(homedir(), ".stockbit");
}
function filePath(): string {
  return join(fileDir(), "refresh.enc");
}

function fileKey(): Buffer {
  // Derived, not stored. Ties the ciphertext to this machine+user.
  const material = `${hostname()}:${userInfo().username}:stockbit-mcp/v1`;
  const salt = Buffer.from("stockbit-mcp-refresh-store-salt");
  return scryptSync(material, salt, 32);
}

const fileStore: TokenStore = {
  backend: "file",
  get() {
    const FILE_PATH = filePath();
    if (!existsSync(FILE_PATH)) return null;
    try {
      const raw = readFileSync(FILE_PATH);
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", fileKey(), iv);
      decipher.setAuthTag(tag);
      const out = Buffer.concat([decipher.update(data), decipher.final()]);
      const token = out.toString("utf8");
      return token.length ? token : null;
    } catch {
      return null; // tampered or key mismatch (e.g. moved machines)
    }
  },
  set(token: string) {
    mkdirSync(fileDir(), { recursive: true });
    const FILE_PATH = filePath();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
    const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileSync(FILE_PATH, Buffer.concat([iv, tag, data]), { mode: 0o600 });
    chmodSync(FILE_PATH, 0o600);
  },
  clear() {
    const FILE_PATH = filePath();
    if (existsSync(FILE_PATH)) writeFileSync(FILE_PATH, Buffer.alloc(0), { mode: 0o600 });
  },
};

/* ----------------------------------- selector ----------------------------------- */

let cached: TokenStore | null = null;

/** Returns the best available store for this platform (Keychain on macOS, else file). */
export function getStore(): TokenStore {
  if (cached) return cached;
  cached = keychainAvailable() ? keychainStore : fileStore;
  return cached;
}

/** Reset the cached backend selection (tests). */
export function resetStoreCache(): void {
  cached = null;
}
