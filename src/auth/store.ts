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
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
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

/**
 * Build the macOS Keychain write command.
 *
 * Do not pass `-T ""`: Apple documents that option as removing the default trusted creator,
 * which makes every read/rotation trigger an access-control prompt. Omitting `-T` keeps the
 * Keychain default: the application creating the item is trusted without granting `-A`
 * (unrestricted access) to every application.
 *
 * The built-in `security` CLI requires the value as the `-w` argument for non-interactive use.
 */
export function keychainWriteArgs(token: string): string[] {
  return [
    "add-generic-password",
    "-s", KEYCHAIN.service,
    "-a", KEYCHAIN.account,
    "-U",
    "-w", token,
  ];
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
    // -U updates an existing item without resetting its trusted-application ACL.
    const r = spawnSync("security", keychainWriteArgs(token), { stdio: "ignore" });
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

/**
 * Replace the credential file's contents atomically: write a fresh temp file in the same directory,
 * flush it to disk, then rename over the target.
 *
 * This matters because the refresh token is the *sole* credential and refresh may rotate it — a
 * truncating in-place write that is interrupted (crash, power loss, full disk) leaves a
 * partial ciphertext that `get()` cannot decrypt, and there is no second copy to fall back to. The
 * failure mode is a forced interactive re-login, which is exactly what the persisted token exists to
 * avoid. `rename` within one filesystem is atomic, so a reader sees either the old token or the new
 * one and never a half-written file.
 *
 * `fsync` before the rename orders the data ahead of the directory entry; the directory fsync after
 * it makes the rename itself durable. Both are best-effort — some filesystems reject fsync on a
 * directory handle, and failing the whole write over that would be worse than the risk.
 *
 * This is single-process atomicity only. Two processes rotating concurrently still race, with the
 * last rename winning; cross-process lock coordination is deferred to M3, when the daemon makes a
 * third writer actually exist.
 */
function writeFileAtomic(target: string, contents: Buffer): void {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    // Mode on the temp file, not chmod after: the secret must never exist as world-readable.
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }

  try {
    const dirFd = openSync(fileDir(), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems; the rename still happened.
  }
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
    mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
    const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileAtomic(filePath(), Buffer.concat([iv, tag, data]));
  },
  clear() {
    const FILE_PATH = filePath();
    // An empty file rather than an unlink, so `get()`'s decrypt failure path reports "no token"
    // identically either way. Atomic for the same reason `set` is.
    if (existsSync(FILE_PATH)) writeFileAtomic(FILE_PATH, Buffer.alloc(0));
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
