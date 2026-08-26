/**
 * The 24-hour access token, shared across processes.
 *
 * ## Why this exists
 *
 * The refresh token rotates. Minting an access token spends it and retires the previous one. So the
 * cost of running N clients is not N cheap requests — it is N rotations of a credential only one of
 * them can hold at a time, and there are normally several: Claude Code and Claude Desktop each spawn
 * a server, a watch daemon is a third, any CLI invocation a fourth. The refresh lock stops them
 * clobbering each other; it does not stop them each burning a rotation for a token that is good for
 * a day and that all of them could have used.
 *
 * So they share one. An access token is valid for 24 hours regardless of who asked for it.
 *
 * ## The honest cost
 *
 * An access token is now written to disk, and `SECURITY.md` used to promise that none ever is. On
 * Linux and Windows the protection is exactly what already guards the refresh token: AES-256-GCM
 * under `~/.stockbit`, mode 0600, key derived from machine and user. **On macOS this is a genuine
 * reduction**, because there the refresh token lives in the Keychain and this file does not. That
 * clause is not softened here or in `SECURITY.md`. `STOCKBIT_NO_ACCESS_CACHE=1` turns both
 * directions off for anyone who would rather pay the rotations.
 *
 * ## Shape
 *
 * **One file, not three.** Three would mean three fsyncs for no benefit, and would make logout three
 * truncations instead of one. It is deliberately not a fourth `StoreSlot`, for the same reason the
 * website session is not: a slot holds one JWT and the whole Keychain path is built around that.
 *
 * **No lock, and the reason is worth writing down.** A lost update here costs a cache miss. A lost
 * update on `refresh.enc` costs a forced re-login. Those are not the same kind of write and do not
 * deserve the same ceremony.
 *
 * **Every entry is bound to the refresh token it was minted from**, by fingerprint. Without that,
 * logging in as a second account leaves the first account's access token on disk and usable for a
 * day — the store would hold account B's refresh token while every request went out as account A.
 * A fingerprint mismatch is a miss, which costs one refresh and is always safe.
 *
 * `expiresAt` is stored RAW. `AUTH.expirySkewSeconds` is applied at every comparison and never baked
 * in, so changing the skew changes behaviour immediately rather than only for tokens minted after
 * the change.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileDir, writeFileAtomic } from "./store.js";
import { tokenFingerprint } from "./fingerprint.js";
import type { TokenDomain } from "../http/transport.js";

const FILE_NAME = "access.enc";

export interface CachedAccess {
  token: string;
  /** Epoch seconds, exactly as the refresh response gave it. No skew baked in. */
  expiresAt: number;
  /** Fingerprint of the refresh token this was minted from. Never the token itself. */
  from: string;
}

type CacheFile = Partial<Record<TokenDomain, CachedAccess>>;

/**
 * Read dynamically rather than captured at import, so a test can toggle it and so a user who sets it
 * in one client's environment is not surprised by another client's cached state.
 */
export function accessCacheDisabled(): boolean {
  return process.env.STOCKBIT_NO_ACCESS_CACHE === "1";
}

function fileKey(): Buffer {
  // Same derivation as the token store and the web session, with its OWN salt — so a ciphertext
  // from one file can never be decrypted as another, even though all three share key material.
  const material = `${hostname()}:${userInfo().username}:stockbit-mcp/v1`;
  return scryptSync(material, Buffer.from("stockbit-mcp-access-cache-salt"), 32);
}

function cachePath(): string {
  return join(fileDir(), FILE_NAME);
}

function readFile(): CacheFile {
  const path = cachePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path);
    if (raw.length <= 28) return {};
    const decipher = createDecipheriv("aes-256-gcm", fileKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(out) as CacheFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Tampered, truncated, key mismatch, or written on another machine. A cache that cannot be read
    // is an empty cache — the only cost is one refresh, so there is nothing here worth an error.
    return {};
  }
}

function writeFile(cache: CacheFile): void {
  mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(cache), "utf8"), cipher.final()]);
  writeFileAtomic(cachePath(), Buffer.concat([iv, cipher.getAuthTag(), data]));
}

/**
 * The cached access token for a domain, if it was minted from `refreshToken`.
 *
 * Expiry is NOT checked here — the caller applies `AUTH.expirySkewSeconds`, the same way it does for
 * the in-memory copy, so there is one place that decides what "fresh enough" means.
 */
export function readAccessCache(domain: TokenDomain, refreshToken: string): CachedAccess | null {
  if (accessCacheDisabled()) return null;
  const entry = readFile()[domain];
  if (!entry || typeof entry.token !== "string" || typeof entry.expiresAt !== "number") return null;
  if (entry.from !== tokenFingerprint(refreshToken)) return null;
  return entry;
}

/** Cache an access token, recording which refresh token minted it. Never throws. */
export function writeAccessCache(
  domain: TokenDomain,
  token: string,
  expiresAt: number,
  refreshToken: string,
): void {
  if (accessCacheDisabled()) return;
  try {
    const cache = readFile();
    cache[domain] = { token, expiresAt, from: tokenFingerprint(refreshToken) };
    writeFile(cache);
  } catch {
    // A cache that cannot be written is a cache miss next time. Never a reason to fail a request
    // that has already succeeded.
  }
}

/**
 * Drop one domain's cached token, or all of them.
 *
 * `forceRefresh` calls this, and it is the single most important line in the feature: without it,
 * the next `ensureFresh` re-hydrates from disk the very token that just 401'd, and the session 401s
 * forever. `logout` calls it too — an access token left on disk after a logout is a working
 * credential, for up to a day.
 */
export function clearAccessCache(domain?: TokenDomain): void {
  try {
    if (!domain) {
      // One file makes this one truncation rather than three, which is most of the reason it is one
      // file. Truncate rather than unlink, matching every other credential this project holds.
      if (existsSync(cachePath())) writeFileAtomic(cachePath(), Buffer.alloc(0));
      return;
    }
    const cache = readFile();
    if (!(domain in cache)) return;
    delete cache[domain];
    writeFile(cache);
  } catch {
    /* best effort; a cache that cannot be cleared still expires */
  }
}

/** Where the cache lives, so `doctor` and `status` can report it without duplicating the path. */
export function accessCachePath(): string {
  return cachePath();
}
