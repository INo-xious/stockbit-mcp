/**
 * Is Stockbit already open in the user's browser, and if not, put it there.
 *
 * ## What can actually be detected, and what cannot
 *
 * A Node process cannot read another browser's tab list. There is no API for it; the browser would
 * have to be running a debugger port or an extension, and the user's everyday browser is running
 * neither. So detection is per-platform and honest about its own resolution:
 *
 *   - **macOS** — AppleScript can ask Chrome, Edge, Brave and Safari for the URL of every tab in
 *     every window. This is exact: a Stockbit tab buried behind twenty others is still found.
 *   - **Windows** — there is no equivalent without UI Automation. `tasklist /V` reports each
 *     process's window title, and a browser's window title is *the active tab's* title. So an
 *     inactive Stockbit tab is invisible to this check.
 *   - **Linux** — `wmctrl` gives window titles when it is installed; otherwise only whether a
 *     browser process exists at all.
 *
 * `exact` on the result says which of those happened, and the tool surfaces it. That matters
 * because the inexact case has a visible consequence: Stockbit sitting in a background tab reads as
 * "not open", and opening it again adds a duplicate tab. That is a mild, self-correcting outcome —
 * unlike the alternative, which is claiming Stockbit is open when the user is looking at something
 * else.
 *
 * Detection never launches anything. Asking a browser whether it is running must not be what starts
 * it, or the answer is always yes.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { normalizeSymbol } from "../symbol.js";
import { findBrowsers } from "../auth/browsers.js";

/**
 * Does a window title belong to the Stockbit *site*?
 *
 * Not a bare `/stockbit/i`. That was the first version and it was wrong in a way that showed up
 * immediately: a browser tab open on `INo-xious/stockbit-mcp` — this project's own GitHub page —
 * reported Stockbit as open, so `ensureStockbitOpen` would decide there was nothing to do and the
 * user would be told to look at a chart that was never opened. An editor with the project folder in
 * its title does the same.
 *
 * So "stockbit" must appear as a standalone word: not glued to a `-`, `/`, `.` or another word
 * character, which is what every repo, path and package name looks like. Real titles pass —
 * "Saham: BBRI … | Stockbit" and "Stockbit - Investasi Saham …" — and "stockbit-mcp",
 * "stockbit.com/docs" and "stockbit_notes.txt" do not.
 *
 * This is a heuristic over window titles, which is all Windows and Linux expose, and it is the
 * reason `exact` is false on those platforms. It deliberately stops here: a title like "Harison
 * stockbit project - File Explorer" still matches, because no string rule separates that from
 * "Stockbit - Investasi Saham" without also rejecting real page titles. That is safe because the
 * predicate is only ever applied to titles of processes in `BROWSER_PROCESSES` — the process filter
 * is the guard, not the pattern.
 */
export function looksLikeStockbit(title: string): boolean {
  return /(^|[^\w-])stockbit(?![-/.\w])/i.test(title);
}

/** Browsers worth asking about, by process image name. */
const BROWSER_PROCESSES = [
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "vivaldi.exe",
  "arc.exe",
];

/** macOS/Linux process names for the same set. */
const BROWSER_NAMES = ["Google Chrome", "Microsoft Edge", "Firefox", "Brave Browser", "Safari", "Arc", "Vivaldi"];

export interface BrowserPresence {
  /** Whether any known browser process is running. */
  browserRunning: boolean;
  /** Whether a Stockbit page was found. */
  stockbitOpen: boolean;
  /**
   * True when background tabs were visible to the check. False means only the frontmost tab of each
   * window could be seen, so `stockbitOpen: false` means "not in front", not "not open".
   */
  exact: boolean;
  /** Browsers found running. */
  browsers: string[];
  /** Window titles or tab URLs that matched Stockbit, as evidence for the verdict. */
  matches: string[];
  platform: NodeJS.Platform;
}

/**
 * Run a command with no shell, capturing stdout. Never throws; a missing binary yields "".
 *
 * The timeout is short on purpose. This runs in front of a chart render, so a slow or wedged helper
 * must cost a second and then be treated as "could not tell" — not hold the user's chart hostage.
 */
function run(command: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish("");
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(out);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(out);
    });
  });
}

/* ---------------------------------------- Windows ---------------------------------------- */

/**
 * One PowerShell call for every process that owns a window, as `ProcessName|WindowTitle`.
 *
 * Not `tasklist /V`, which is the obvious choice and the wrong one: it resolves the window title and
 * owner of *every* process on the box, and measured here it did not finish inside 30 seconds. A
 * chart render cannot stall on a presence check. `Get-Process` filtered to windowed processes
 * answers the same question in well under a second.
 *
 * "Owns a window" is also the better definition of a running browser for this purpose — what the
 * caller needs to know is whether there is a browser window to add a tab to, not whether some
 * background updater process exists.
 */
async function windowsPresence(): Promise<BrowserPresence> {
  const out = await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }",
  ]);

  const browsers = new Set<string>();
  const matches: string[] = [];

  for (const line of out.split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const name = line.slice(0, sep).trim();
    const title = line.slice(sep + 1).trim();
    // Get-Process reports the name without ".exe"; the table carries it for readability.
    if (!BROWSER_PROCESSES.some((p) => p.replace(/\.exe$/, "") === name.toLowerCase())) continue;
    browsers.add(name);
    if (looksLikeStockbit(title)) matches.push(`${name}: ${title}`);
  }

  return {
    browserRunning: browsers.size > 0,
    stockbitOpen: matches.length > 0,
    exact: false, // a window title is the ACTIVE tab; background tabs are invisible here
    browsers: [...browsers],
    matches,
    platform: process.platform,
  };
}

/* ----------------------------------------- macOS ----------------------------------------- */

/**
 * Ask each *already-running* browser for its tab URLs.
 *
 * The `running of application` guard is load-bearing: addressing a non-running app by name in
 * AppleScript launches it, which would make the check itself the reason a browser is open.
 */
const MAC_SCRIPT = `
set found to {}
set names to {"Google Chrome", "Microsoft Edge", "Brave Browser", "Vivaldi", "Arc"}
repeat with n in names
  try
    if running of application n then
      set found to found & {n & "|RUNNING"}
      tell application n
        repeat with w in windows
          repeat with t in tabs of w
            set found to found & {n & "|" & (URL of t)}
          end repeat
        end repeat
      end tell
    end if
  end try
end repeat
try
  if running of application "Safari" then
    set found to found & {"Safari|RUNNING"}
    tell application "Safari"
      repeat with w in windows
        repeat with t in tabs of w
          set found to found & {"Safari|" & (URL of t)}
        end repeat
      end repeat
    end tell
  end if
end try
set AppleScript's text item delimiters to linefeed
return found as text
`;

async function macPresence(): Promise<BrowserPresence> {
  const out = await run("osascript", ["-e", MAC_SCRIPT], 10_000);
  const browsers = new Set<string>();
  const matches: string[] = [];

  for (const line of out.split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const app = line.slice(0, sep);
    const rest = line.slice(sep + 1);
    browsers.add(app);
    if (rest !== "RUNNING" && /(^|\/\/)([a-z0-9-]+\.)*stockbit\.com/i.test(rest)) matches.push(rest);
  }

  return {
    browserRunning: browsers.size > 0,
    stockbitOpen: matches.length > 0,
    // Only exact if osascript actually answered; an empty result may mean automation was denied.
    exact: out.trim().length > 0,
    browsers: [...browsers],
    matches,
    platform: process.platform,
  };
}

/* ----------------------------------------- Linux ----------------------------------------- */

async function linuxPresence(): Promise<BrowserPresence> {
  const titles = await run("wmctrl", ["-l"]);
  const haveWmctrl = titles.trim().length > 0;
  const matches = titles
    .split(/\r?\n/)
    .filter((l) => looksLikeStockbit(l))
    .map((l) => l.trim());

  const ps = await run("ps", ["-eo", "comm="]);
  const browsers = [...new Set(ps.split(/\r?\n/).map((l) => l.trim()))].filter((name) =>
    BROWSER_NAMES.concat(BROWSER_PROCESSES).some((b) =>
      name.toLowerCase().includes(b.toLowerCase().replace(".exe", "")),
    ),
  );

  return {
    browserRunning: browsers.length > 0 || haveWmctrl,
    stockbitOpen: matches.length > 0,
    exact: false,
    browsers,
    matches,
    platform: process.platform,
  };
}

/** Whether Stockbit is currently open, at the best resolution this platform allows. */
export function detectStockbit(): Promise<BrowserPresence> {
  if (process.platform === "win32") return windowsPresence();
  if (process.platform === "darwin") return macPresence();
  return linuxPresence();
}

/* ------------------------------------- opening it ------------------------------------- */

/**
 * Which Stockbit page to land on. Both were checked against the live site.
 *
 * There is deliberately no "broker" view. Stockbit's Broker Analysis page is `/broker-analysis/broker`
 * with no symbol in the path, and `?symbol=` on it redirects away rather than deep-linking, so a
 * broker-flow render anchors on the symbol page instead of a guessed URL that would open the wrong
 * stock — or nothing.
 */
export type StockbitView = "chart" | "symbol" | "home";

/**
 * A Stockbit URL. Built here so no caller can choose the destination — a caller-supplied URL would
 * make this an open-redirect with the user's default browser as the sink. The only input is a
 * symbol, which `normalizeSymbol` has already constrained to an IDX ticker charset.
 */
export function stockbitUrl(symbol?: string, view: StockbitView = "chart"): string {
  if (!symbol || view === "home") return "https://stockbit.com/";
  const base = `https://stockbit.com/symbol/${encodeURIComponent(normalizeSymbol(symbol))}`;
  return view === "chart" ? `${base}/chartbit` : base;
}

/**
 * The platform's "open this in the default handler" command, as argv — never a shell string. There
 * is no string a symbol could contain that gets reinterpreted as a command, and on Windows
 * `rundll32` sidesteps `cmd`'s `start` builtin, which does parse `&` and consume quotes.
 */
function opener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    case "darwin":
      return { command: "open", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Pick which browser to open in.
 *
 * ## Why the default browser is not good enough
 *
 * Stockbit's chart page renders an empty white body when signed out — no login wall, no message,
 * just nothing. So opening it in a browser that does not hold the user's session produces a blank
 * page that looks like a broken feature. Observed exactly that: the OS default here is Opera, the
 * session is in Edge, and the tab opened correctly and showed nothing.
 *
 * `STOCKBIT_WEB_BROWSER` names the browser to view in, falling back to `STOCKBIT_BROWSER` (which
 * this project already uses to pick the login-capture browser — usually the same one, since both
 * questions are really "where am I signed in?").
 *
 * ## Why a name and not a path
 *
 * A caller-supplied path would let anything that can call this tool launch an arbitrary executable.
 * So `preferred` is matched against the *discovered* browser list and nothing else. Only the
 * environment — which the user sets on their own machine — may name an absolute path.
 */
export function resolveBrowser(preferred?: string): { name: string; path: string } | null {
  const installed = findBrowsers();
  const byName = (want: string) => {
    const needle = want.trim().toLowerCase();
    if (!needle) return null;
    const hit =
      installed.find((b) => b.name.toLowerCase() === needle) ??
      installed.find((b) => b.name.toLowerCase().includes(needle));
    return hit ? { name: hit.name, path: hit.path } : null;
  };

  if (preferred) return byName(preferred);

  const fromEnv = (process.env.STOCKBIT_WEB_BROWSER ?? process.env.STOCKBIT_BROWSER ?? "").trim();
  if (!fromEnv) return null;
  // The user's own setting may be a full path; a caller's may not.
  if (isAbsolute(fromEnv) && existsSync(fromEnv)) return { name: basename(fromEnv), path: fromEnv };
  return byName(fromEnv);
}

/** Browsers this machine has, for a tool to report when the requested one is not among them. */
export function installedBrowsers(): string[] {
  return findBrowsers().map((b) => b.name);
}

/**
 * Open a URL, in a named browser when one is chosen and the OS default handler otherwise. The
 * default handler launches a browser when none is running and adds a tab when one is, which is why
 * "force open the browser" needs no separate branch.
 *
 * The child is detached with stdio ignored because this process speaks MCP over stdio — a child
 * inheriting stdout would interleave bytes into the protocol stream and break the session. Failure
 * is silent: a headless box or a locked-down desktop must not turn a successful render into an
 * error.
 */
export function openUrl(url: string, preferred?: string): { opened: boolean; via: string } {
  if (process.env.STOCKBIT_NO_BROWSER === "1") return { opened: false, via: "suppressed" };

  const chosen = resolveBrowser(preferred);
  const { command, args } = chosen ? { command: chosen.path, args: [url] } : opener(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Errors arrive asynchronously; without a listener an ENOENT here is an unhandled 'error' event
    // that takes the whole server down over a browser that is not installed.
    child.on("error", () => {});
    child.unref();
    return { opened: true, via: chosen ? chosen.name : "system default" };
  } catch {
    return { opened: false, via: chosen ? chosen.name : "system default" };
  }
}

/** What `ensureStockbitOpen` did. */
export type BrowserAction =
  | "already-open" // a Stockbit page was found; nothing was touched
  | "opened-tab" // a browser was running, so this added a tab to it
  | "launched-browser" // no browser was running; the default one was started
  | "suppressed"; // STOCKBIT_NO_BROWSER=1

export interface EnsureResult extends BrowserPresence {
  action: BrowserAction;
  url: string;
  /** Which browser it was opened in — a name, or "system default". */
  via?: string;
  /** Set when a requested browser is not installed, so the caller can say so instead of guessing. */
  browserNotFound?: string;
  /** What is installed, populated only alongside `browserNotFound`. */
  installed?: string[];
}

/**
 * Make sure Stockbit is on screen: check first, and only open if it is not already there.
 *
 * `force` skips the check and always opens — the honest escape hatch for the Windows/Linux case
 * where a background Stockbit tab is invisible to detection and the user knows better.
 */
export async function ensureStockbitOpen(opts: {
  symbol?: string;
  view?: StockbitView;
  force?: boolean;
  browser?: string;
} = {}): Promise<EnsureResult> {
  const url = stockbitUrl(opts.symbol, opts.view);

  // A named-but-missing browser is reported, never silently downgraded to the default — falling
  // back is how the user ends up staring at a blank page in the browser they are not signed into.
  if (opts.browser && !resolveBrowser(opts.browser)) {
    const presence = await detectStockbit();
    return {
      ...presence,
      action: "suppressed",
      url,
      browserNotFound: opts.browser,
      installed: installedBrowsers(),
    };
  }

  const presence = await detectStockbit();
  if (presence.stockbitOpen && !opts.force) {
    return { ...presence, action: "already-open", url };
  }

  const { opened, via } = openUrl(url, opts.browser);
  return {
    ...presence,
    action: !opened ? "suppressed" : presence.browserRunning ? "opened-tab" : "launched-browser",
    url,
    via,
  };
}
