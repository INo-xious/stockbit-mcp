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
 * `inspect` changes nothing. `stage` takes a full backup of the store directory FIRST and prints
 * where it went. `restore` puts the most recent backup back, or one you name.
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
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp, sub: "probe" })}.not-a-real-signature`;
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

function backup(): string {
  const dir = fileDir();
  const dest = join(dir, "..", `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dest, { recursive: true });
  cpSync(dir, dest, { recursive: true });
  return dest;
}

function newestBackup(): string | null {
  const parent = join(fileDir(), "..");
  const found = readdirSync(parent)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort();
  return found.length ? join(parent, found[found.length - 1]) : null;
}

function stage(): void {
  const session = loadWebSession();
  if (!session) fail("No web session on disk — nothing to age out. Log in first.");

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

  const dir = fileDir();
  const aside = `${dir}.replaced-${Date.now()}`;
  const hadOne = existsSync(dir);
  if (hadOne) renameSync(dir, aside);
  try {
    cpSync(source, dir, { recursive: true });
  } catch (err) {
    if (hadOne) renameSync(aside, dir);
    fail(`Restore failed, and the previous store was put back: ${String(err)}`);
  }
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
