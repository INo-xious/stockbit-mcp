/**
 * Which browser the logged-in profile belongs to.
 *
 * A Chromium profile directory is **not portable between browsers**. `~/.stockbit/browser-profile`
 * is created by whichever binary `stockbit-auth login` happened to pick, and opening it with a
 * different one (Chrome's profile in Brave, Edge's in Chrome) gives a fresh, logged-out browser —
 * or a refusal, depending on version. On a machine with several Chromium-family browsers installed,
 * `findBrowser()`'s idea of "the best one" can differ between the login and a later run for reasons
 * as incidental as an upgrade, so the identity is *pinned at login* rather than rediscovered.
 *
 * This matters now because the Chartbit driver (ADR-0005) launches that profile long after the
 * login. Without the pin, its most likely failure is opening a logged-out browser and reporting the
 * user's chart as empty — a wrong answer, not an error.
 *
 * The record holds no credential. It is a path, a name, a family and a version.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDir } from "./store.js";
import { browserVersion, familyForPath, type BrowserFamily } from "./browsers.js";

export interface BrowserProfileRecord {
  /** Absolute path to the executable that created the profile. */
  browserPath: string;
  /** Its file name, for a message a user can act on ("Brave Browser"). */
  browserName: string;
  family: BrowserFamily;
  /** Version string at login time, when it could be read. Informational. */
  version?: string;
  /** ISO timestamp of the successful capture. */
  loggedInAt: string;
}

export function profileRecordPath(): string {
  return join(fileDir(), "browser-profile.json");
}

/** Persist the browser identity a freshly-captured profile belongs to. Best-effort. */
export function writeBrowserProfile(browserPath: string, at = new Date()): BrowserProfileRecord | null {
  const record: BrowserProfileRecord = {
    browserPath,
    browserName: browserPath.split("/").pop() ?? browserPath,
    family: familyForPath(browserPath),
    version: browserVersion(browserPath) ?? undefined,
    loggedInAt: at.toISOString(),
  };
  try {
    mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
    writeFileSync(profileRecordPath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  } catch {
    // A missing pin degrades the driver to "guess the browser", which is what it did before this
    // existed. Failing the login over it would be worse.
    return null;
  }
}

/**
 * The pinned identity, or null when no login has recorded one.
 *
 * A malformed file reads as null rather than throwing: the caller's next step is the same either
 * way — tell the user to run `stockbit-auth login`.
 */
export function readBrowserProfile(): BrowserProfileRecord | null {
  try {
    const raw = JSON.parse(readFileSync(profileRecordPath(), "utf8")) as Partial<BrowserProfileRecord>;
    if (typeof raw.browserPath !== "string" || !raw.browserPath) return null;
    return {
      browserPath: raw.browserPath,
      browserName: raw.browserName ?? raw.browserPath.split("/").pop() ?? raw.browserPath,
      family: raw.family === "firefox" ? "firefox" : "chromium",
      version: typeof raw.version === "string" ? raw.version : undefined,
      loggedInAt: typeof raw.loggedInAt === "string" ? raw.loggedInAt : "",
    };
  } catch {
    return null;
  }
}

/** Whether the pinned executable is still on disk. A renamed or uninstalled browser is nameable. */
export function pinnedBrowserExists(record: BrowserProfileRecord): boolean {
  return existsSync(record.browserPath);
}

/** Remove the pin. Called by `logout`, alongside the profile it describes. */
export function clearBrowserProfile(): void {
  try {
    rmSync(profileRecordPath(), { force: true });
  } catch {
    /* nothing to clean up */
  }
}
