/**
 * Reaping browser processes that still hold the saved profile.
 *
 * ## The failure this exists for
 *
 * `launchDebuggableBrowser` spawns a browser against `--user-data-dir=~/.stockbit/browser-profile`.
 * When a process is ALREADY holding that directory, the new one hands off to the running instance
 * and exits immediately, so the debugging port never opens and the only symptom is
 * `ALREADY_OPEN_HINT` — a message about closing windows, for windows that in the observed case had
 * no window at all. Eleven orphaned processes accumulated that way and blocked every subsequent
 * login until they were killed by hand and the profile's `Singleton*` files were removed. Nothing in
 * this server reaped them, because `spawn(…, { stdio: "ignore" })` in `launch.ts` is not detached
 * and the MCP login is fire-and-forget: when the capture promise is abandoned, no cleanup runs.
 *
 * ## Why this is narrow on purpose
 *
 * Killing a browser is not a tidy-up, it is destroying something a person may be using. The profile
 * this matches on is shared with the Chartbit driver, which deliberately keeps its browser open
 * across calls (`launch.ts` documents that). So:
 *
 * - Reaping is never speculative. It runs only after a launch has already failed with the child
 *   exiting before the port opened — which is to say, only when the holder is provably not serving
 *   the DevTools endpoint this server would have used. A driver that is actually working answers
 *   its port and is never a candidate.
 * - The match is the EXACT `--user-data-dir` for the profile in hand, both spellings (`=` and a
 *   space). Not "a Chrome process", not a prefix, not the browser's own default profile.
 * - The caller supplies the directory. This module never guesses which profile is interesting.
 *
 * ## Nothing here reports a command line
 *
 * A Chromium argv can carry a URL, and a Stockbit URL can carry a token in the query string. Every
 * tool test re-scans the whole serialised result for JWT shapes, and a reaper that reported what it
 * matched would be a new way to leak one. `ReapResult` carries PIDs and counts, never argv.
 *
 * ## Testing
 *
 * The process lister and the killer are injected. CI runs three operating systems with no browser
 * installed, so a reaper reachable only behind "skip: no drivable browser" would have no coverage at
 * all — the blind spot `store.ts` names as having already produced two invisible mistakes.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

/** One row of the process table: everything this module needs and nothing it must not report. */
export interface ProcessRow {
  pid: number;
  /** The full command line. Used for matching ONLY — never copied into a result. */
  command: string;
}

export interface ReapDeps {
  /** Enumerate processes. Defaults to the platform's process table. */
  list?: () => ProcessRow[];
  /** Signal one process. Defaults to `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Wait between the polite signal and the impolite one. Injected so tests do not sleep. */
  wait?: (ms: number) => Promise<void>;
}

export interface ReapResult {
  /** Processes matched as holding this profile. */
  found: number;
  /** Of those, how many were gone after the attempt. */
  killed: number;
  /** PIDs only — see the header. */
  pids: number[];
  /** Which of the profile's singleton files were removed. Names, not paths. */
  clearedLocks: string[];
  /** Anything that went wrong, already free of argv. */
  errors: string[];
}

/**
 * The lock files Chromium leaves behind when it dies without cleaning up.
 *
 * `SingletonLock` is a SYMLINK whose target encodes the owning host and pid, and a stale one makes
 * the next launch hand off to a process that is not there. They must be removed with the symlink
 * itself as the target — `existsSync` follows links and answers false for a dangling one, which is
 * exactly the state a crashed browser leaves — so this uses `rmSync({ force: true })`, which acts on
 * the link and treats "already gone" as success.
 */
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

/** Both spellings a Chromium command line can use for the flag. */
function profileFlags(profileDir: string): string[] {
  return [`--user-data-dir=${profileDir}`, `--user-data-dir ${profileDir}`];
}

/** End of string, or the characters that can legitimately terminate an argument. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === " " || ch === "\t" || ch === '"' || ch === "'";
}

/**
 * Does this command line hold exactly this profile?
 *
 * A plain substring test is WRONG here and dangerously so: `--user-data-dir=/x/profile` is a prefix
 * of `--user-data-dir=/x/profile-other`, so matching on containment alone would report a browser
 * holding a SIBLING directory as a holder of this one — and the caller's next act is to kill it.
 * The match must end at an argument boundary on both sides.
 */
function holdsProfile(command: string, profileDir: string): boolean {
  for (const flag of profileFlags(profileDir)) {
    for (let from = 0; ; ) {
      const at = command.indexOf(flag, from);
      if (at < 0) break;
      if (isBoundary(command[at - 1]) && isBoundary(command[at + flag.length])) return true;
      from = at + 1;
    }
  }
  return false;
}

/**
 * Read the process table.
 *
 * `ps -axww` rather than plain `ps`: without `ww` the command column is truncated to the terminal
 * width, and the flag being matched sits far to the right of a Chromium command line — so the
 * truncated form silently matches nothing, which reads exactly like "no orphans".
 */
function listProcesses(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), command: m[2] });
      }
      return rows;
    }
    const out = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), command: m[2] });
    }
  } catch {
    // A process table this server cannot read is not an error worth failing a login over. An empty
    // list means "reap nothing", which is the safe direction: the launch failure is reported as it
    // was before, rather than being replaced by a diagnostic about `ps`.
    return [];
  }
  return rows;
}

/**
 * Which processes hold this profile.
 *
 * Excludes this process unconditionally. It has no reason to carry the flag, but a reaper that can
 * signal its own pid is one refactor away from killing the server mid-recovery.
 */
export function holdersOfProfile(profileDir: string, deps: ReapDeps = {}): ProcessRow[] {
  // An empty directory would reduce the match to `--user-data-dir=`, which every Chromium process
  // this server ever launches carries — a wildcard over the whole process table, arriving as a
  // request to kill all of them. Absence is "reap nothing", never "reap everything".
  if (!profileDir.trim()) return [];
  const list = deps.list ?? listProcesses;
  return list().filter((row) => row.pid !== process.pid && holdsProfile(row.command, profileDir));
}

/**
 * Remove the profile's stale singleton files. Returns the NAMES actually removed, never full paths.
 *
 * `lstatSync` decides what was there, and it is the only call that can: `SingletonLock` is a symlink
 * whose target names a host and a pid, so after a crash it is typically DANGLING — and `existsSync`
 * follows the link and answers false for exactly the state this is meant to clean up. `lstat` looks
 * at the link itself.
 *
 * The existence check is also what keeps the return value honest. `rmSync({ force: true })` treats a
 * missing path as success, so reporting every name unconditionally would claim three files were
 * cleared on a profile that had none — a count that reads as evidence and is not.
 */
export function clearSingletonFiles(profileDir: string): string[] {
  if (!profileDir.trim()) return [];
  const cleared: string[] = [];
  for (const name of SINGLETON_FILES) {
    const path = join(profileDir, name);
    try {
      lstatSync(path);
    } catch {
      continue; // Not there. Nothing to report.
    }
    try {
      rmSync(path, { force: true });
      cleared.push(name);
    } catch {
      // Best effort. A singleton file that cannot be removed is reported by its absence from this
      // list, not by failing the reap — the kill above it is the part that matters.
    }
  }
  return cleared;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kill every process holding `profileDir`, then clear the profile's stale singleton files.
 *
 * `SIGTERM` first and `SIGKILL` only for what survives it: a browser given the chance to exit
 * cleanly writes its profile back, and a profile half-written by `SIGKILL` is a second way to lose
 * the very cookies this whole recovery path depends on.
 *
 * Never throws. Every caller is already on a failure path, and a reaper that can raise turns "the
 * login could not start" into a different and less useful error.
 */
export async function reapProfileHolders(profileDir: string, deps: ReapDeps = {}): Promise<ReapResult> {
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const wait = deps.wait ?? sleep;
  const errors: string[] = [];

  const holders = holdersOfProfile(profileDir, deps);
  if (holders.length === 0) {
    // Still clear the singleton files: the observed lockout survived the processes that made it,
    // and a dangling SingletonLock alone is enough to make the next launch hand off to nothing.
    return { found: 0, killed: 0, pids: [], clearedLocks: clearSingletonFiles(profileDir), errors };
  }

  const pids = holders.map((h) => h.pid);
  for (const pid of pids) {
    try {
      kill(pid, "SIGTERM");
    } catch (err) {
      // ESRCH is the ordinary case, not a failure: the process exited between the listing and the
      // signal, which is the outcome being asked for.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") errors.push(`SIGTERM ${pid}: ${code ?? "failed"}`);
    }
  }

  await wait(1_500);

  let remaining = holdersOfProfile(profileDir, deps);
  if (remaining.length > 0) {
    for (const row of remaining) {
      try {
        kill(row.pid, "SIGKILL");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ESRCH") errors.push(`SIGKILL ${row.pid}: ${code ?? "failed"}`);
      }
    }
    // A signalled process stays in the table while it unwinds, so counting immediately would
    // under-report every kill that actually worked — and on Windows each listing is another
    // PowerShell spawn, which is why this is skipped entirely when SIGTERM was enough.
    await wait(500);
    remaining = holdersOfProfile(profileDir, deps);
  }

  return {
    found: holders.length,
    // Clamped: a browser relaunched by the user, or a helper process spawned between the first and
    // last listing, makes `remaining` larger than `holders` and turned this into a negative count —
    // a number that is not merely wrong but impossible, which is worse to read.
    killed: Math.max(0, holders.length - remaining.length),
    pids,
    // ONLY when the profile is actually free. `SingletonLock` is what stops a second Chromium
    // attaching to a `user-data-dir` that one is already using, so removing it while a browser
    // survived — every kill refused with EPERM, say — does not clean anything up: it clears the way
    // for two browsers to write one profile, which is how the profile gets corrupted rather than
    // merely locked.
    clearedLocks: remaining.length === 0 ? clearSingletonFiles(profileDir) : [],
    errors,
  };
}
