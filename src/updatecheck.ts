/**
 * Whether a newer release of this package exists.
 *
 * ## Why this is worth an outbound request
 *
 * `npx -y stockbit-mcp` caches a resolved tree under a SemVer RANGE. A cache entry holding
 * `^1.2.2` with 1.2.2 installed is satisfied by 1.2.4, so npx reuses it and never re-resolves — the
 * server stays on the old build indefinitely, and nothing anywhere says so. In the field that cost
 * a whole debugging session against a version whose bug had already been fixed, and the fix was to
 * delete two directories under `~/.npm/_npx` by hand. The version was the first thing that mattered
 * and the last thing that was visible.
 *
 * ## The boundary this does and does not cross
 *
 * `registry.npmjs.org` is not a Stockbit host, so this is outside the route table by construction
 * and no ADR applies: `test/transport.test.ts` scopes its bypass guard to Stockbit hosts, and
 * `src/auth/launch.ts` already fetches `127.0.0.1` under the same rule. No credential is attached
 * and none could be — the request carries a package name and nothing else, which is strictly less
 * than `npx -y stockbit-mcp` already tells the registry on every single launch.
 *
 * It is still an outbound request, so: it is opt-out by environment (`STOCKBIT_NO_UPDATE_CHECK=1`),
 * it is never made by `collectStatus` unless a caller explicitly asks (the same rule the `live`
 * check follows), it is cached for a day, it has a short deadline, and it can never fail a status
 * call — the worst outcome is a `note` saying the check did not happen.
 *
 * ## Absent, not "up to date"
 *
 * A check that could not run reports `latest: undefined` and a note. It does NOT report
 * `isOutdated: false`, because "we could not ask" and "you are current" are different answers and
 * only one of them is a fact. That is the same rule the rest of this server follows for a field it
 * could not read.
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { stockbitPath } from "./paths.js";
import { VERSION } from "./version.js";

/** The package this asks about. Hard-coded: it is asking about ITSELF. */
const PACKAGE_NAME = "stockbit-mcp";

/** The abbreviated `latest` document — a couple of KB, and it answers exactly the question asked. */
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/**
 * How long a registry answer is trusted.
 *
 * A day. Releases are not hourly, and the failure this exists to catch lasted weeks — a stale
 * reading costs nothing next to the request it saves on every status call in a working session.
 */
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** How long the registry gets to answer before the check gives up. Status must stay fast. */
export const UPDATE_TIMEOUT_MS = 2_000;

export interface UpdateStatus {
  /** The version actually running, from the manifest npm installed. */
  installed: string;
  /** The registry's `latest`. ABSENT when the check did not run or could not be read. */
  latest?: string;
  /** Absent exactly when `latest` is — never a default, because "unknown" is not "current". */
  isOutdated?: boolean;
  /** When the answer behind this was fetched, ISO-8601. Absent when there is no answer. */
  checkedAt?: string;
  /** Why there is no `latest`, or how to act on one. Always present. */
  note: string;
}

interface CachedAnswer {
  latest: string;
  checkedAt: string;
}

function cachePath(): string {
  return stockbitPath("update-check.json");
}

function readCache(now: number): CachedAnswer | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<CachedAnswer>;
    if (typeof parsed?.latest !== "string" || typeof parsed?.checkedAt !== "string") return null;
    const age = now - Date.parse(parsed.checkedAt);
    // `Number.isFinite` catches an unparseable stamp; a negative age catches a clock that moved
    // backwards. Both mean "do not trust this", not "it is fresh forever".
    if (!Number.isFinite(age) || age < 0 || age > UPDATE_CACHE_TTL_MS) return null;
    return { latest: parsed.latest, checkedAt: parsed.checkedAt };
  } catch {
    // No cache, or an unreadable one. Asking again is cheap; failing a status call is not.
    return null;
  }
}

function writeCache(answer: CachedAnswer): void {
  // Atomic, for the reason every other store in this project is: several copies of this server run
  // at once, and a truncating write that loses a race leaves a file that parses as nothing.
  try {
    mkdirSync(stockbitPath(), { recursive: true, mode: 0o700 });
    const target = cachePath();
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(answer, null, 2)}\n`, "utf8");
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  } catch {
    // A cache that cannot be written costs one request next time. It is not worth an error.
  }
}

/**
 * Compare two SemVer-ish versions.
 *
 * Deliberately small, and deliberately NOT a dependency. It answers one question — is `latest`
 * ahead of `installed` — and it is conservative: anything it cannot parse compares as "not ahead",
 * so an unexpected version string produces silence rather than a false alarm telling a user to
 * upgrade to something that does not exist.
 *
 * A prerelease suffix (`1.3.0-beta.1`) is IGNORED on both sides for ordering, which means a
 * prerelease is never announced as an upgrade over the release it precedes. That is the safe
 * direction: this package publishes no prerelease channel today, and recommending one by accident
 * would be worse than missing it.
 */
export function isNewer(latest: string, installed: string): boolean {
  return compareVersions(latest, installed) === 1;
}

/**
 * Order two versions: 1 if `a` is ahead, -1 if behind, 0 if equal, and `null` if either could not
 * be parsed.
 *
 * `null` is a distinct outcome rather than a fold into "not ahead", because the caller has three
 * things to say and not two. Collapsing "cannot compare" into "not ahead" is what let this module
 * print "Up to date" for a version it had never successfully compared.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    const core = v.trim().replace(/^v/, "").split(/[-+]/)[0];
    const parts = core.split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.some((n) => !Number.isInteger(n)) ? null : nums;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

export interface UpdateCheckOptions {
  /** The version to compare against. Defaults to this build's. */
  installed?: string;
  /** Injected for tests, and so no test can ever reach the network. */
  fetchImpl?: typeof fetch;
  /** Injected so cache expiry is testable without waiting a day. */
  now?: Date;
  /** Skip the cache and ask. */
  force?: boolean;
}

/**
 * Ask whether a newer release exists, cheaply and without ever throwing.
 *
 * Every failure path returns an `UpdateStatus` with no `latest` and a `note`. There is no error
 * case for the caller to handle, because a status report must not be able to fail over a
 * convenience.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const installed = options.installed ?? VERSION;
  const now = options.now ?? new Date();

  if (process.env.STOCKBIT_NO_UPDATE_CHECK === "1") {
    return { installed, note: "Update check disabled by STOCKBIT_NO_UPDATE_CHECK=1." };
  }

  const cached = options.force ? null : readCache(now.getTime());
  if (cached) return describe(installed, cached.latest, cached.checkedAt, true);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { installed, note: "Update check unavailable: no fetch implementation." };
  }

  // `AbortSignal.timeout` rather than a manual race: it actually cancels the request, where a race
  // leaves the socket open and the process alive after the answer stopped being wanted.
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { installed, note: `Update check could not read the registry (HTTP ${response.status}).` };
    }
    const body = (await response.json()) as { version?: unknown };
    if (typeof body?.version !== "string" || !body.version) {
      return { installed, note: "Update check could not read a version from the registry's answer." };
    }
    const checkedAt = now.toISOString();
    writeCache({ latest: body.version, checkedAt });
    return describe(installed, body.version, checkedAt, false);
  } catch {
    // Offline, blocked, timed out, or a registry that answered something unparseable. The note says
    // the check did not happen; it deliberately quotes nothing from the failure, because a fetch
    // error quotes its URL and a note is not the place to widen what this server writes down.
    return { installed, note: "Update check did not complete (offline, blocked, or timed out)." };
  }
}

function describe(installed: string, latest: string, checkedAt: string, fromCache: boolean): UpdateStatus {
  const order = compareVersions(latest, installed);
  const age = fromCache ? " (cached)" : "";

  // Four outcomes, not two. "Up to date" used to be printed for all three of the non-behind cases,
  // which meant a release bump — package.json ahead of what npm has published yet — reported
  // "Up to date: 1.2.5 is the latest release" beside `latest: "1.2.4"`, and an unparseable version
  // reported the same thing having compared nothing at all.
  if (order === null) {
    return {
      installed,
      latest,
      checkedAt,
      note:
        `The registry's latest is ${latest} and this build reports ${installed}${age}, and those ` +
        "could not be compared as versions, so whether an update exists is unknown.",
    };
  }
  if (order === 1) {
    return {
      installed,
      latest,
      isOutdated: true,
      checkedAt,
      note:
        `A newer release exists: ${latest}, you are on ${installed}${age}. ` +
        "npx caches a resolved tree under a version RANGE, so it will NOT pick this up on its own — " +
        "run `npx -y stockbit-mcp@latest` or clear `~/.npm/_npx`, then restart the client.",
    };
  }
  if (order === -1) {
    return {
      installed,
      latest,
      isOutdated: false,
      checkedAt,
      note:
        `This build reports ${installed}, which is AHEAD of the registry's latest (${latest})${age} — ` +
        "normally a local build or an unpublished release. Nothing to update.",
    };
  }
  return {
    installed,
    latest,
    isOutdated: false,
    checkedAt,
    note: `Up to date: ${installed} is the latest release${age}.`,
  };
}
