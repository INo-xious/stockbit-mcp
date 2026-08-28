/**
 * Launching a Chromium-family browser with remote debugging, and waiting for its DevTools endpoint.
 *
 * Extracted from `login.ts` because two features now need exactly this: the one-time login capture,
 * and the Chartbit driver that draws on the user's real chart (ADR-0005). Both must launch the *same
 * binary against the same persistent profile*, and both hit the same startup failure modes, so
 * having one copy of the flags and one copy of the wait loop is the difference between the driver
 * inheriting the fixes login already has and rediscovering them.
 *
 * ## The flags are not cosmetic
 *
 * `--user-data-dir` is mandatory rather than tidy: Chrome 136+ refuses remote debugging against the
 * default profile directory outright. `--disable-extensions` is here because a fresh profile still
 * inherits browser-managed extensions, which open their own tabs — an OAuth prompt once stole focus
 * from the login page and buried the responses being watched.
 *
 * ## The wait loop watches the child
 *
 * The most common startup failure is launching against a profile another window already has open:
 * the new process hands off to the running instance and exits immediately, so the debugging port
 * never opens. Polling on a long timeout alone turned that into a fifteen-minute silent hang with no
 * window to look at, so the child's exit is a distinct, named error.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Ceiling on browser startup, independent of whatever the caller then does with the browser. */
export const BROWSER_START_TIMEOUT_MS = 30_000;

/** The diagnostic for the failure that looks like nothing happening at all. */
const ALREADY_OPEN_HINT =
  "The browser exited immediately without opening a debugging port. This usually means a window " +
  "is already open using this profile — close every window of that browser and retry, or use " +
  "`--fresh-profile`.";

export interface LaunchOptions {
  /** Absolute path to the browser executable. The caller decides which; this module does not guess. */
  bin: string;
  /** `--user-data-dir`. Must not be the browser's default profile — Chrome 136+ refuses debugging there. */
  profileDir: string;
  /** Run without a visible window. Off by default: Cloudflare blanks headless Chrome on stockbit.com. */
  headless?: boolean;
  /** Extra command-line flags, appended after the ones this module insists on. */
  extraArgs?: string[];
  /** Ceiling on the wait for the DevTools endpoint. */
  startTimeoutMs?: number;
}

export interface LaunchedBrowser {
  child: ChildProcess;
  port: number;
  /** Browser-level DevTools WebSocket URL, ready for `CDP.connect`. */
  wsUrl: string;
}

/**
 * Spawn a debuggable browser and resolve once its DevTools endpoint answers.
 *
 * Rejects — after killing the child — when the port never opens. The child is returned rather than
 * managed here: only the caller knows whether the browser should outlive the operation (the Chartbit
 * driver keeps it open across calls; the login capture kills it).
 */
export async function launchDebuggableBrowser({
  bin,
  profileDir,
  headless = false,
  extraArgs = [],
  startTimeoutMs = BROWSER_START_TIMEOUT_MS,
}: LaunchOptions): Promise<LaunchedBrowser> {
  const port = 9500 + Math.floor(Math.random() * 400);
  const child: ChildProcess = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      // Chrome 136+ refuses remote debugging against the DEFAULT profile directory, so this flag
      // is mandatory, not merely tidy.
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // A fresh --user-data-dir still inherits browser-managed extensions, which open their own
      // tabs (an OAuth prompt stole focus from the login page here) and bury the responses we watch.
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      ...(headless ? ["--headless=new"] : ["--start-maximized", "--new-window"]),
      // Start blank so any interception the caller arms is live before a real page loads.
      "about:blank",
      ...extraArgs,
    ],
    { stdio: "ignore" },
  );

  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  const deadline = Date.now() + startTimeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const wsUrl = ((await r.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
        return { child, port, wsUrl };
      }
    } catch {
      /* not up yet */
    }
    if (childExited) throw new Error(ALREADY_OPEN_HINT);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        "Browser did not start in time (no debugging port after " +
          `${Math.round(startTimeoutMs / 1000)}s). ` +
          "If a window using this profile is already open, close it and retry.",
      );
    }
    await delay(250);
  }
}
