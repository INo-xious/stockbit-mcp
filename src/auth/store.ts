/**
 * Refresh-token store. Prefers the macOS Keychain (via the built-in `security` CLI — no native
 * module to compile), and falls back to an AES-256-GCM encrypted file elsewhere.
 *
 * This module persists the long-lived REFRESH token and nothing else. Access tokens are NOT stored
 * here — but they are no longer memory-only either: `accesscache.ts` writes them to `access.enc`,
 * through this file's own `writeFileAtomic`, because rotation makes N processes each minting their
 * own retire each other's credential. That file is deliberately not a `StoreSlot`; see its header
 * for the trade, which on macOS is a real one.
 *
 * File-fallback caveat: the key is derived from machine + user identifiers, which protects against
 * casual disk reads but not a determined local attacker. The Keychain path is strongly preferred.
 */
import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
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
import { stockbitDir } from "../paths.js";

/**
 * What the store can say about a slot.
 *
 * `absent` and `unavailable` are different answers and must not be collapsed. A locked Keychain, a
 * denied access prompt, or a `security` binary that is not there all used to read as `null` — the
 * same value as "you have never logged in" — so `status` told the user their session was gone and
 * `doctor` advised them to log in again, which on a locked Keychain means destroying a credential
 * that was fine. `get()` still returns `null` for both, because every existing caller wants a token
 * or nothing; callers that are about to give the user *advice* ask this instead.
 */
export type StoreState = "present" | "absent" | "unavailable";

/**
 * Which mechanism actually holds the credential. Named because `reflock.ts` sizes its timings off
 * it and needs to reach both branches from an offline test.
 */
export type StoreBackend = "keychain" | "file";

export interface TokenStore {
  get(): string | null;
  /** Whether a credential is there — distinguishing "no" from "could not find out". */
  readState(): StoreState;
  set(token: string): void;
  clear(): void;
  readonly backend: StoreBackend;
  /** Which token this store holds. */
  readonly slot: StoreSlot;
}

/**
 * The three refresh tokens this project can hold, each in its own slot.
 *
 * Kept apart rather than in one record because they are separate sessions with separate
 * consequences: `stockbit-auth trading-logout` must be able to end the securities session without
 * touching market data, and a securities token leaking is a different incident from a market-data
 * token leaking. `main` keeps the original names so an existing Keychain item and an existing
 * `refresh.enc` both survive this change — renaming either would log every current user out.
 */
export type StoreSlot = "main" | "securities" | "eipo";

/* ------------------------------- macOS Keychain ------------------------------- */

function keychainAvailable(): boolean {
  // Test/CI override: force the file backend so we never touch the real Keychain.
  if (process.env.STOCKBIT_FORCE_FILE_STORE === "1") return false;
  if (process.platform !== "darwin") return false;
  const r = spawnSync("security", ["-h"], { stdio: "ignore", timeout: KEYCHAIN_TIMEOUT_MS });
  return r.status === 0 || r.status === 1; // `security -h` exits non-zero but exists
}

/**
 * Build the macOS Keychain write command, WITHOUT the token.
 *
 * `-w` last and with no value is what `man security` recommends: *"Put at end of command to be
 * prompted (recommended)."* Prompted means `security` reads the value rather than taking it from
 * `argv`, and the whole point of this shape is that `argv` is world-readable. A process argument is
 * visible in `ps` to every process running as the same user, which also *bypasses the Keychain ACL*
 * — the thing that would otherwise make reading the item prompt. This project already understands
 * that threat: `docs/FEATURES.md` warns that a Telegram token on the command line "is visible to
 * every user on the machine through `ps`". The credential deserves the same care.
 *
 * Do not pass `-T ""`: Apple documents that option as removing the default trusted creator, which
 * makes every read and every rotation trigger an access-control prompt. Omitting `-T` keeps the
 * Keychain default — the application creating the item is trusted, without granting `-A`
 * (unrestricted access) to every application.
 */
export function keychainWriteArgs(slot: StoreSlot = "main"): string[] {
  return [
    "add-generic-password",
    "-s", KEYCHAIN.service,
    "-a", KEYCHAIN.accounts[slot],
    "-U",
    "-w",
  ];
}

/**
 * The legacy form, kept only as a fallback — the token IS in `argv` here.
 *
 * Retained because nothing here can promise how `security` reads a prompted value on a machine
 * nobody has run this on. It reads through `readpassphrase`, and the observed behaviour on macOS 26
 * is that it takes the value from the pipe and asks for it TWICE — but a build that instead insists
 * on `/dev/tty` would hang, and this is the credential store, not a place to be clever and hope.
 *
 * So `keychainWrite` tries the safe form under a timeout, **reads the value back to confirm it
 * landed**, and only then keeps it. This path runs when that fails, and `doctor` reports which one
 * ran, so the answer is measured on the user's machine rather than assumed on ours.
 */
export function keychainWriteArgsWithToken(token: string, slot: StoreSlot = "main"): string[] {
  return [...keychainWriteArgs(slot), token];
}

/**
 * Which mechanism got the token into the Keychain.
 *
 * `stdin-unverified` is the honest third answer: `security` exited 0, so it says the value is
 * stored, but the read-back could not confirm it — a locked Keychain, a prompt nobody answered, a
 * read that hit its timeout. See `keychainWrite` for why that does NOT fall back to `argv`.
 */
export type KeychainWriteMethod = "stdin" | "stdin-unverified" | "argv";

/**
 * How long any single `security` invocation may run.
 *
 * The failure being bounded is not an error but a *hang*: if `security` opens `/dev/tty` and prompts
 * there, nothing answers, and an unbounded `spawnSync` wedges the process holding the credential
 * lock — which then gets broken as stale while it is still alive, and two processes rotate.
 *
 * Applied to EVERY spawn, not just the prompted write. The read-back, the argv fallback and the
 * delete run on the same code paths, under the same lock; bounding one of them and explaining the
 * bound in terms of the lock would have been the reasoning without the protection. Together they
 * are why `reflock.ts` sizes its cushion the way it does — and that is also why this is three
 * seconds rather than something more generous. `security` either answers in about ten milliseconds
 * or it is waiting on a dialog, and no amount of waiting in-process makes a dialog answer itself;
 * every second here is a second added to how long a crashed holder wedges the credential lock.
 */
const KEYCHAIN_TIMEOUT_MS = 3_000;

/** How long ALL Keychain work in one write may take: the prompted write, the read-back, the fallback. */
export const KEYCHAIN_WORST_CASE_MS = 3 * KEYCHAIN_TIMEOUT_MS;

function keychainRead(slot: StoreSlot): { status: number | null; value: string | null } {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.accounts[slot], "-w"],
    { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS },
  );
  if (r.status !== 0) return { status: r.status, value: null };
  const token = r.stdout.trim();
  return { status: 0, value: token.length ? token : null };
}

/**
 * Put `token` in the Keychain by the safest mechanism that demonstrably works.
 *
 * The read-back is the load-bearing part. Without it this would be a guess about `readpassphrase`'s
 * behaviour under a pipe, made once, on one machine — and a *silently wrong* Keychain write is the
 * worst outcome available here, because the process carries on believing the credential is stored.
 * With it, "did the safe form work" stops being a question anybody has to answer in the abstract:
 * it is settled per write, on the machine it matters on.
 *
 * **Nothing that merely failed to answer may send the token to `argv`.** That rule governs BOTH
 * spawns below, and getting it wrong is a credential leak rather than an inconvenience: the argv
 * form spawns `security … -w <the refresh token>`, where `ps` shows it to every process running as
 * this user and the Keychain ACL is bypassed — undoing the entire reason the value moved to stdin.
 *
 * Two separate places can fail to answer, and an earlier version of this function only guarded one
 * of them:
 *
 *   - **The read-back.** A Keychain prompt raised behind another window makes the read time out.
 *     The fallback fires only on a DEFINITE no — the item read back with a different value, or it
 *     is genuinely not there (44). Anything else keeps the stdin result, which `security` reported
 *     as successful, and says it could not be confirmed.
 *   - **The prompted write itself**, which is the one that raises the unlock dialog *first*, so on
 *     a locked Keychain the read-back is never even reached. A killed child reports
 *     `{ status: null, signal: "SIGTERM" }`, and treating that like a refusal fell straight through
 *     to the argv spawn. It also bought nothing: the argv spawn meets the same dialog, is killed
 *     the same way, and the write fails anyway — so the only lasting effect was the credential in
 *     `ps`, twice per rotation, because `persistRotated` retries.
 *
 * So argv is reached only from a refusal that is both DEFINITE and not a refusal to act: `security`
 * ran, answered, and answered with something other than "the Keychain is locked" or "the prompt was
 * declined". A write that was killed, that could not be spawned, or that hit one of those two,
 * throws instead. The caller retries; a lost rotation is recoverable and a leaked credential is not.
 *
 * Worth being straight about what that leaves: a `security` whose `readpassphrase` blocks on
 * `/dev/tty` rather than erroring is KILLED, not refused, so the fallback the argv form was
 * originally written for is no longer reachable from that cause. If such a machine exists the
 * credential is not written at all, and `doctor` must say so rather than reporting a fallback that
 * will not be taken — which is why `probeKeychainWrite` shares this function instead of carrying
 * its own copy of the rule.
 */
/**
 * What to do after the prompted write, given only what the spawns reported. Pure, and exported, so
 * the rule above is ASSERTED rather than described.
 *
 * That is not a stylistic preference here. The rule has now been got wrong twice — once for the
 * read-back and once for the write — and both times the mistake was invisible to a suite that
 * cannot spawn `security` at all (it is offline, and CI runs on Windows). A decision function that
 * takes the two exit statuses as arguments can be checked on every platform, including the case
 * that matters: **a killed child must never produce `argv`.**
 *
 * `readBack` is null when no read was attempted, which is every case where the prompted write did
 * not exit 0.
 */
/**
 * `security` exit codes that mean "I could not act", not "the answer is no".
 *
 * The distinction decides whether the refresh token may be passed in `argv`, so it is named once
 * and used on both sides of `keychainWriteDecision` rather than spelled out twice — spelling it out
 * twice is how the two sides came to disagree.
 */
const KEYCHAIN_REFUSED_TO_ACT = new Set([
  45, // errSecInteractionNotAllowed — the Keychain is locked and nothing may prompt
  51, // errSecAuthFailed — someone declined the prompt
]);

export function keychainWriteDecision(
  promptedStatus: number | null,
  readBack: { matched: boolean; status: number | null } | null,
): "stdin" | "stdin-unverified" | "argv" | "fail" {
  // Killed by the timeout, or never ran. NOT a refusal, and the credential does not go in `argv`
  // on the strength of a non-answer.
  if (promptedStatus === null) return "fail";
  // Nor on the strength of a refusal to ACT. `readState` below already classifies these two, and
  // the read-back branch of this very function honours that classification — an earlier version
  // did not apply it here, so a locked Keychain (45) or a user clicking Deny (51) was read as
  // "security answered, and the answer was no" and the credential went into `argv` anyway. Same
  // function, same two codes, opposite verdicts. They are non-answers on both sides, and the argv
  // spawn could not have helped in either case: it meets the same lock and the same prompt.
  if (KEYCHAIN_REFUSED_TO_ACT.has(promptedStatus)) return "fail";
  // `security` ran and refused for some other reason. This is the only thing left that reaches the
  // fallback.
  if (promptedStatus !== 0) return "argv";
  if (!readBack) return "fail";
  if (readBack.matched) return "stdin";
  // 0 is a successful read (of a different value) and 44 is "not there". Only those two are
  // answers; anything else is a read that could not answer, and keeps the stdin result.
  if (readBack.status !== 0 && readBack.status !== 44) return "stdin-unverified";
  return "argv";
}

function keychainWrite(token: string, slot: StoreSlot): KeychainWriteMethod {
  const prompted = spawnSync("security", keychainWriteArgs(slot), {
    // TWICE. `security` prompts for the value and then for a retype, and it reads both from the
    // pipe. Sending it once exits 0 and stores an EMPTY string — measured, and the single most
    // dangerous outcome available here, because everything downstream then believes the credential
    // was saved. It is also the reason the read-back below is not optional.
    input: `${token}\n${token}\n`,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: KEYCHAIN_TIMEOUT_MS,
  });

  const back = prompted.status === 0 ? keychainRead(slot) : null;
  const decision = keychainWriteDecision(
    prompted.status,
    back ? { matched: back.value === token, status: back.status } : null,
  );
  if (decision === "stdin" || decision === "stdin-unverified") return decision;
  if (decision === "fail") throw new Error("Keychain write failed");

  const viaArgv = spawnSync("security", keychainWriteArgsWithToken(token, slot), {
    stdio: "ignore",
    timeout: KEYCHAIN_TIMEOUT_MS,
  });
  if (viaArgv.status !== 0) throw new Error("Keychain write failed");
  return "argv";
}

/**
 * Find out which write mechanism works here, without touching the real credential.
 *
 * Writes a throwaway value under its own account name, reads it back, and deletes it. `doctor` calls
 * this so the answer is machine-checked on the user's machine rather than inferred from a comment.
 */
export function probeKeychainWrite(): { available: boolean; method: KeychainWriteMethod | null; detail: string } {
  if (!keychainAvailable()) {
    return { available: false, method: null, detail: "no Keychain on this platform (or forced off)" };
  }
  const probeSlot = "main";
  const account = `${KEYCHAIN.accounts[probeSlot]}-doctor-probe`;
  const value = "stockbit-mcp-doctor-probe-not-a-credential";
  const args = ["add-generic-password", "-s", KEYCHAIN.service, "-a", account, "-U", "-w"];
  const readBack = (): string | null => {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN.service, "-a", account, "-w"],
      { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const remove = () =>
    spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN.service, "-a", account], {
      stdio: "ignore",
      timeout: KEYCHAIN_TIMEOUT_MS,
    });

  try {
    const prompted = spawnSync("security", args, {
      input: `${value}\n${value}\n`,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: KEYCHAIN_TIMEOUT_MS,
    });
    // THE SAME DECISION FUNCTION THE REAL WRITE USES. It used to be a second copy of the rule, and
    // the copies drifted the moment the rule changed: on a machine where the prompted write hangs,
    // `keychainWrite` throws and stores nothing while the probe fell through, succeeded via argv,
    // and reported `method: "argv"` — which `doctor` renders as a WARNING that the fallback is in
    // use and the token is briefly visible in `ps`. Both halves false, on a machine where in fact
    // no credential can be written at all and the honest answer is `fail`. `doctor` is what someone
    // runs when login is not working; it must not describe a path the writer will not take.
    const back = prompted.status === 0 ? readBack() : null;
    const decision = keychainWriteDecision(
      prompted.status,
      prompted.status === 0 ? { matched: back === value, status: back === null ? null : 0 } : null,
    );
    if (decision === "stdin") {
      return {
        available: true,
        method: "stdin",
        detail: "the token is passed on stdin — never visible in `ps`",
      };
    }
    if (decision === "stdin-unverified") {
      return {
        available: true,
        method: "stdin-unverified",
        detail:
          "the stdin write reported success but could not be read back — probably a Keychain " +
          "prompt nobody answered. The token is NOT put in `ps` to find out; if a session goes " +
          "missing after a rotation, this row is where to look",
      };
    }
    if (decision === "fail") {
      return {
        available: true,
        method: null,
        detail:
          "`security` would not carry out the write — it was killed, the Keychain is locked, or a " +
          "prompt was declined. No credential can be stored here, and the argv fallback is NOT " +
          "tried, because it meets the same refusal and would put the token in `ps` on the way",
      };
    }
    const viaArgv = spawnSync("security", [...args, value], {
      stdio: "ignore",
      timeout: KEYCHAIN_TIMEOUT_MS,
    });
    if (viaArgv.status === 0 && readBack() === value) {
      return {
        available: true,
        method: "argv",
        detail:
          "`security` would not take the value on stdin here, so the fallback is used and the " +
          "token is briefly visible in `ps` to processes running as you",
      };
    }
    return { available: true, method: null, detail: "neither write mechanism succeeded" };
  } finally {
    remove();
  }
}

function keychainStore(slot: StoreSlot): TokenStore {
  const account = KEYCHAIN.accounts[slot];
  return {
    backend: "keychain",
    slot,
    get() {
      return keychainRead(slot).value;
    },
    readState() {
      const { status, value } = keychainRead(slot);
      if (status === 0) return value ? "present" : "absent";
      // 44 is errSecItemNotFound — the item genuinely is not there, which is a real answer.
      // Everything else is not: 45 is errSecInteractionNotAllowed (the Keychain is locked and
      // nothing may prompt), 51 is errSecAuthFailed (someone declined the prompt), and a missing
      // binary has no status at all. Reporting any of those as "absent" is how a user ends up
      // being advised to log in again over a credential that was never in doubt.
      if (status === 44) return "absent";
      return "unavailable";
    },
    set(token: string) {
      // -U updates an existing item without resetting its trusted-application ACL. The token goes
      // in on stdin when `security` will take it there, and only falls back to `argv` — where `ps`
      // can see it — when a read-back proves the safe form did not land. See `keychainWrite`.
      keychainWrite(token, slot);
    },
    clear() {
      // Bounded like the rest. `delete-generic-password` prompts on a locked Keychain exactly as the
      // others do, and every logout path calls this while holding the credential lock — so an
      // unanswered prompt here wedges the holder, and `STALE_MS` later everyone else breaks the
      // lock as stale and two processes rotate. That is the failure the timeouts exist to prevent,
      // arriving through the one call that did not have one.
      spawnSync(
        "security",
        ["delete-generic-password", "-s", KEYCHAIN.service, "-a", account],
        { stdio: "ignore", timeout: KEYCHAIN_TIMEOUT_MS },
      );
    },
  };
}

/* --------------------------------- File fallback --------------------------------- */

// STOCKBIT_STORE_DIR lets tests point the encrypted file at an isolated temp dir. Read dynamically
// (not a module-load const) so multiple test files with different dirs don't collide on a stale path.
/** Directory holding the credential file. Exported so the refresh lock lives beside it. */
export function fileDir(): string {
  return stockbitDir();
}
function filePath(slot: StoreSlot): string {
  return join(fileDir(), KEYCHAIN.files[slot]);
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
/**
 * Exported so `websession.ts` can hold its own credential to the same standard. A plain
 * `writeFileSync` there would let a concurrent reader observe a half-written file, decrypt-fail, and
 * report "no session" — which surfaces to the user as a login prompt they did not need.
 */
export function writeFileAtomic(target: string, contents: Buffer): void {
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

function fileRead(slot: StoreSlot): string | null {
  const FILE_PATH = filePath(slot);
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
}

function fileStore(slot: StoreSlot): TokenStore {
  return {
  backend: "file",
  slot,
  get() {
    return fileRead(slot);
  },
  readState() {
    // Deliberately a strict refinement of `get()` rather than a third answer.
    //
    // A file that exists but will not decrypt — a moved machine, a changed hostname, a truncated
    // write — holds nothing this installation can use, and reporting `unavailable` would make the
    // resync in `resync.ts` refuse to adopt over it. Refusing there is exactly wrong: overwriting
    // an unreadable file with a token the browser is still holding is how "the credential store was
    // wiped but you are still signed in" recovers without an interactive login. There is no locked
    // -Keychain equivalent on this backend, so there is no case that needs the third answer.
    if (!existsSync(filePath(slot))) return "absent";
    return fileRead(slot) ? "present" : "absent";
  },
  set(token: string) {
    mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
    const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileAtomic(filePath(slot), Buffer.concat([iv, tag, data]));
  },
  clear() {
    const FILE_PATH = filePath(slot);
    // An empty file rather than an unlink, so `get()`'s decrypt failure path reports "no token"
    // identically either way. Atomic for the same reason `set` is.
    if (existsSync(FILE_PATH)) writeFileAtomic(FILE_PATH, Buffer.alloc(0));
  },
  };
}

/* ----------------------------------- selector ----------------------------------- */

const cached = new Map<StoreSlot, TokenStore>();

/**
 * The best available store for this platform (Keychain on macOS, else file), for one slot.
 *
 * Defaults to `main` so every existing call site keeps meaning the market-data session.
 */
export function getStore(slot: StoreSlot = "main"): TokenStore {
  const hit = cached.get(slot);
  if (hit) return hit;
  const store = keychainAvailable() ? keychainStore(slot) : fileStore(slot);
  cached.set(slot, store);
  return store;
}

/** Reset the cached backend selection (tests). */
export function resetStoreCache(): void {
  cached.clear();
}
