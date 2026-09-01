/**
 * Stage the one state in which automatic login recovery can actually fire, so it can be observed.
 *
 * ## Why this exists
 *
 * ADR-0011 describes a recovery path that had never been run. Two attempts to run it failed for the
 * same reason, and the reason is the interesting part: `ensureFresh` has a level three that adopts
 * the BROWSER's access token before any refresh is attempted, so killing the stored credential
 * produces no 401 at all while the browser session is alive. The request is simply served from the
 * cookie, which is exactly what that level was built to do.
 *
 * So the window in which recovery can fire is narrower than "the credential died". Three things must
 * hold AT ONCE:
 *
 *   1. the stored refresh token is rejected by Stockbit;
 *   2. the web session's ACCESS token is expired or unreadable, so level three declines;
 *   3. the web session's REFRESH token is still alive, because the gate in `relogin.ts` requires
 *      `webSessionHealth().likelyValid === true`, and that verdict is computed from the refresh half.
 *
 * Conditions 2 and 3 are the pair nobody had staged: the same artefact must be half dead and half
 * alive, in the right halves. That is an ordinary state to be in — a web session whose 24-hour access
 * token has aged out while its week-long refresh token has days left is what every morning looks
 * like — but it is not the state you land in by deleting a credential, which is why the path stayed
 * unobserved through two attempts.
 *
 * `docs/PENDING-VERIFICATION.md` named a `scripts/p7-recovery-probe.mjs` as "the harness minus that
 * one step". That file was never committed. This is that harness, with the step.
 *
 * ## The trap this walks around
 *
 * `saveWebSession` has a monotonicity guard: `supersedesStored` compares the incoming ACCESS token's
 * expiry against the stored one and DROPS the write if the incoming is older. Ageing out the access
 * half is precisely an older write, so a naive save is a silent no-op. `{ allowOlder: true }` is
 * required, and is very likely why step 2 has never been staged.
 *
 * ## Usage
 *
 *     node --import tsx scripts/probe-relogin.ts inspect
 *     node --import tsx scripts/probe-relogin.ts stage
 *     node --import tsx scripts/probe-relogin.ts restore [<backup dir>]
 *
 * `inspect` changes nothing. `stage` backs the store directory up FIRST and prints where it went.
 * `restore` puts the most recent backup back, or one you name.
 *
 * **`stage` refuses unless the main credential is file-backed**, and that refusal is load-bearing
 * rather than fussiness. On default macOS the credential lives in the Keychain, which is not inside
 * the directory being copied — so overwriting it would destroy the real refresh token with nothing
 * to restore from, while `restore` printed "Restored" and reported a healthy-looking absence. A
 * backup that does not cover the thing being changed is not a backup.
 *
 * Between `stage` and `restore`, drive the BUILT server — `bin/stockbit-mcp.ts` is the only entry
 * point that calls `armAutoRelogin()` — with `STOCKBIT_AUTO_RELOGIN=1` and no `STOCKBIT_NO_BROWSER`,
 * and ask it for a quote. **That opens a browser window.** That is the harvest, and it is the thing
 * being measured.
 *
 * Read the result honestly: `"harvested"` means a credential is in the store, NOT that it works.
 * Four harvested credentials in a row were once rejected on first use while login, doctor and status
 * all reported healthy. The retry is the proof, not the outcome word.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileDir, getStore } from "../src/auth/store.js";
import { accessCachePath } from "../src/auth/accesscache.js";
import {
  CREDENTIAL_COOKIE,
  loadWebSession,
  saveWebSession,
  browserAccessToken,
  webSessionHealth,
  type WebSession,
} from "../src/auth/websession.js";

const BACKUP_PREFIX = "stockbit-backup-";

/** A marker written into every backup this script takes, so `restore` cannot be pointed at junk. */
const MARKER = "PROBE-RELOGIN-BACKUP";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * A syntactically valid JWT with a FUTURE expiry and a nonsense signature.
 *
 * Future on purpose. An expired one would be refused locally, by this project's own expiry check,
 * and the run would prove nothing about what Stockbit does. This one is only rejectable upstream,
 * which is the condition being staged.
 */
function deadButWellFormedJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp, sub: PROBE_SUBJECT })}.not-a-real-signature`;
}

/** The marker this script stamps into its own throwaway JWT, so it can recognise its own work. */
const PROBE_SUBJECT = "stockbit-mcp-probe-relogin";

/** Whether a stored credential is one THIS script wrote — decoded, never substring-matched. */
function isProbeToken(token: string | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown };
    return claims.sub === PROBE_SUBJECT;
  } catch {
    return false;
  }
}

/** The credential cookie's decoded payload, or null if it is not there or not readable. */
function readCookiePayload(session: WebSession): { index: number; payload: Record<string, unknown> } | null {
  const index = session.cookies.findIndex((c) => c.name === CREDENTIAL_COOKIE);
  if (index < 0) return null;
  try {
    return { index, payload: JSON.parse(decodeURIComponent(session.cookies[index].value)) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function describe(): void {
  const health = webSessionHealth();
  const access = browserAccessToken(0);
  const stored = getStore("main").readState();
  process.stdout.write(
    `${JSON.stringify(
      {
        storedRefresh: stored,
        webSession: {
          likelyValid: health.likelyValid,
          expired: health.expired,
          basis: health.basis,
          refreshHoursLeft: health.refreshHoursLeft,
          accessHoursLeft: health.accessHoursLeft,
        },
        // The one that decides whether ensureFresh level three declines.
        browserAccessTokenUsable: access !== null,
        readyToObserveRecovery:
          stored !== "absent" && access === null && health.likelyValid === true
            ? "yes — all three conditions hold"
            : "no",
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Entries not worth copying: the Chromium profile is several hundred megabytes and nothing in this
 * experiment touches it. Matched as whole NAMES at the top level, never as a substring of a path —
 * `src.includes("browser-profile")` also excluded `browser-profile.json` (the profile pin), and
 * would have excluded the store ROOT if its own path happened to contain that string, in which case
 * `cpSync` copies nothing and does not throw.
 */
const SKIP_FROM_BACKUP = new Set(["browser-profile"]);

/**
 * Copy the store aside.
 *
 * Skipping anything makes this a PARTIAL backup, which is only safe because `restore` merges what
 * was skipped back out of the copy it sets aside. If that pairing is ever broken, back up
 * everything instead — a restore that silently drops the logged-in browser profile costs a full
 * interactive re-login, which is the harm this whole script exists to avoid.
 *
 * It also does not inherit the umask: `cpSync` preserves file modes but NOT directory modes, so a
 * 0700 store would land as a 0755 directory in `$HOME`.
 */
function backup(): string {
  const dir = fileDir();
  const dest = join(dir, "..", `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });

  const entries = readdirSync(dir).filter((name) => !SKIP_FROM_BACKUP.has(name));
  for (const name of entries) cpSync(join(dir, name), join(dest, name), { recursive: true });

  // A backup that copied nothing is not a backup, and `cpSync` reports that case by succeeding.
  if (readdirSync(dest).length === 0) {
    fail(`Backup of ${dir} produced an empty directory at ${dest}. Refusing to go further.`);
  }

  chmodSync(dest, 0o700);
  // The source is stamped so an explicit `restore` cannot be pointed at a backup of another store.
  writeFileSync(join(dest, MARKER), `${new Date().toISOString()}\n${dir}\n`, { mode: 0o600 });
  return dest;
}

/** The newest backup this script wrote. Unmarked directories are ignored, not guessed at. */
function newestBackup(): string | null {
  const parent = join(fileDir(), "..");
  const found = readdirSync(parent)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .filter((name) => existsSync(join(parent, name, MARKER)))
    .sort();
  return found.length ? join(parent, found[found.length - 1]) : null;
}

function stage(): void {
  // A directory backup does not cover a credential that is not in the directory.
  //
  // On macOS with no `backend.json` override — the DEFAULT — `getStore("main")` is the Keychain
  // store, and `.set()` writes to the Keychain and nowhere else. `backup()` copies `~/.stockbit`,
  // which holds no copy of it. Restoring would put the files back, print "Restored", and leave the
  // Keychain holding this script's nonsense JWT: the real refresh token destroyed, recoverable only
  // by a full interactive re-login — which `stage` has just made harder by ageing out the web
  // session too.
  //
  // So this refuses rather than pretending the backup is whole. It is not a limitation worth
  // engineering around: the file backend is a supported configuration, and running the experiment
  // there costs one setting.
  const backend = getStore("main").backend;
  if (backend !== "file") {
    fail(
      `Refusing to stage: the main credential is held by the ${backend} backend, and a backup of\n` +
        `${fileDir()} cannot contain it. Overwriting it here would destroy the real refresh token\n` +
        "with nothing to restore from.\n\n" +
        "Run the experiment against a file-backed store instead — either point STOCKBIT_STORE_DIR at\n" +
        "a copy, or record the file fallback for `main` — and re-run.",
    );
  }

  const session = loadWebSession();
  if (!session) fail("No web session on disk — nothing to age out. Log in first.");

  // Staging twice would make the DELIBERATELY BROKEN store the newest backup, which is what a bare
  // `restore` puts back. The probe JWT names itself, so this is detectable — by DECODING it.
  //
  // Substring-matching the encoded form does not work and was wrong here before this comment:
  // base64 encodes in three-byte groups, so the encoding of `"sub":"probe"` appears inside the
  // encoding of the whole payload only when the offset happens to align mod 3 — and the payload
  // carries an `exp` timestamp whose width moves that alignment from run to run. It would have
  // passed the guard most of the time and silently failed to protect anything.
  if (isProbeToken(getStore("main").get())) {
    fail("The stored credential is already this script's probe token. Restore first, then stage again.");
  }

  const cookie = readCookiePayload(session);
  if (!cookie) fail(`No readable ${CREDENTIAL_COOKIE} cookie — cannot stage condition 2.`);

  const state = (cookie.payload as { state?: Record<string, unknown> }).state;
  if (!state || typeof state !== "object") fail("The credential cookie carries no `state` object.");
  if (state.refresh === undefined) fail("The cookie has no refresh half; condition 3 could not hold.");

  const where = backup();
  process.stdout.write(`Backed up ${fileDir()} -> ${where}\n`);

  // Condition 2. `slotExpirySeconds` prefers an explicit `expired_at` over the JWT's own `exp`, so
  // this needs no re-signing — and leaves the token string itself untouched, which keeps the change
  // to exactly the one property being tested.
  const access = state.access;
  const aged = typeof access === "object" && access !== null ? { ...(access as object) } : { token: access };
  (aged as Record<string, unknown>).expired_at = new Date(Date.now() - 3600_000).toISOString();
  state.access = aged;

  session.cookies[cookie.index] = {
    ...session.cookies[cookie.index],
    value: encodeURIComponent(JSON.stringify(cookie.payload)),
  };
  // allowOlder, or the monotonicity guard drops this write and says nothing.
  saveWebSession(session, { allowOlder: true });

  // Condition 1.
  getStore("main").set(deadButWellFormedJwt());

  // And the shared access cache, or level two answers before level three is even reached.
  const cache = accessCachePath();
  if (existsSync(cache)) unlinkSync(cache);

  process.stdout.write("\nStaged. State now:\n");
  describe();
  process.stdout.write(
    "\nNext: run the BUILT server with STOCKBIT_AUTO_RELOGIN=1 and no STOCKBIT_NO_BROWSER,\n" +
      "ask it for a quote, and watch whether a browser opens.\n" +
      `Then: node --import tsx scripts/probe-relogin.ts restore ${where}\n`,
  );
}

/**
 * Put a backup back, without ever leaving the store missing.
 *
 * The obvious implementation — remove the store, then copy the backup over it — has a window in
 * which the credential exists in exactly one place, and if the copy fails inside that window it
 * exists in none. This is a recovery tool used precisely when things have gone wrong, so it moves
 * the current directory ASIDE, copies the backup into place, and only then discards what it moved.
 * A failure at any point leaves either the original or the backup on disk under a name that is
 * printed.
 */
function restore(from?: string): void {
  const source = from ?? newestBackup();
  if (!source) fail("No backup found. Pass one explicitly.");
  if (!existsSync(source)) fail(`No such backup: ${source}`);
  // `existsSync` alone is not validation. A regular file passes it, `cpSync` then SUCCEEDS at
  // writing a file where the store directory was, the catch below never fires, and the real store
  // — already moved aside — is deleted as cleanup. Verified: it turned the store into a 13-byte
  // text file and exited 0. So the source must be a directory, and one this script wrote.
  if (!statSync(source).isDirectory()) fail(`Not a directory, so not a backup: ${source}`);
  const markerPath = join(source, MARKER);
  if (!existsSync(markerPath)) {
    fail(`No ${MARKER} in ${source}. Refusing to overwrite the store with a directory this script did not write.`);
  }

  const dir = fileDir();
  // The marker records which store it came from. A marked backup of a DIFFERENT store is still not
  // a backup of this one, and only the explicit `restore <path>` form can reach one.
  const origin = readFileSync(markerPath, "utf8").split("\n")[1]?.trim();
  if (origin && origin !== dir) {
    fail(`That backup was taken from ${origin}, not ${dir}. Refusing to restore it over a different store.`);
  }

  // `resolve` strips a trailing slash. Without it, a STOCKBIT_STORE_DIR ending in `/` makes this
  // concatenation land INSIDE the store, and `renameSync` fails EINVAL with a raw stack — at the
  // one moment the user needs this tool, while they are sitting in the deliberately broken state.
  const aside = `${resolve(dir)}.replaced-${Date.now()}`;
  const hadOne = existsSync(dir);
  if (hadOne) renameSync(dir, aside);
  try {
    cpSync(source, dir, { recursive: true });

    // Merge back exactly what the backup deliberately skipped. Without this the restore is LOSSY:
    // `browser-profile` is the logged-in Chromium profile, and losing it costs a full interactive
    // re-login — the harm this script exists to avoid, and a regression this file shipped once
    // already.
    //
    // SKIPPED, not "anything missing". Carrying back every absent name would also resurrect files
    // created after the backup was taken — including the access cache `stage` deletes on purpose,
    // which the probe run then rewrites. Restoring a file the staging step removed is not a
    // restore.
    if (hadOne) {
      for (const name of SKIP_FROM_BACKUP) {
        const kept = join(aside, name);
        if (existsSync(kept) && !existsSync(join(dir, name))) {
          cpSync(kept, join(dir, name), { recursive: true });
        }
      }
    }
  } catch (err) {
    // The recovery must not throw on its own. `renameSync` onto a non-empty directory raises
    // ENOTEMPTY, which would replace this explanation with a raw stack and leave the real store
    // under a `.replaced-*` name nothing had printed.
    if (hadOne) {
      try {
        rmSync(dir, { recursive: true, force: true });
        renameSync(aside, dir);
        fail(`Restore failed, and the previous store was put back: ${String(err)}`);
      } catch (recoveryErr) {
        fail(
          `Restore failed (${String(err)}) AND putting the previous store back failed ` +
            `(${String(recoveryErr)}). Your previous store is at ${aside} — move it to ${dir} by hand.`,
        );
      }
    }
    fail(`Restore failed: ${String(err)}`);
  }

  // Not litter in the credential store — and it would otherwise make the store itself satisfy the
  // marker check that exists to tell a backup from anything else.
  rmSync(join(dir, MARKER), { force: true });
  if (hadOne) rmSync(aside, { recursive: true, force: true });

  process.stdout.write(`Restored ${source} -> ${dir}\n\nState now:\n`);
  describe();
  process.stdout.write("\nProve it with a real call before trusting it — a restored file is not a working session.\n");
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case "inspect":
    describe();
    break;
  case "stage":
    stage();
    break;
  case "restore":
    restore(argument);
    break;
  default:
    fail("usage: probe-relogin.ts <inspect|stage|restore [backup-dir]>");
}
