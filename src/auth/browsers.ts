/**
 * Browser discovery.
 *
 * The previous implementation was a hard-coded list of three absolute Windows paths. That misses
 * the most common Chrome install on Windows (per-user, under %LOCALAPPDATA%, which is what you get
 * without admin rights), every Chromium fork, and any browser the user installed somewhere else.
 * A user with a perfectly good browser was told "no Chromium-family browser found".
 *
 * Resolution order, most-specific first:
 *   1. STOCKBIT_BROWSER — an explicit path. Always wins; the escape hatch when discovery is wrong.
 *   2. Windows "App Paths" registry — where installers actually record themselves.
 *   3. PATH lookup.
 *   4. Well-known absolute paths.
 *
 * Firefox is discovered and reported but cannot be driven by this project's CDP client: Firefox
 * removed CDP in v141 and now speaks only WebDriver BiDi. It is listed so `doctor` can say
 * "found, but unsupported" instead of silently ignoring it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type BrowserFamily = "chromium" | "firefox";

export interface BrowserInfo {
  /** Display name, e.g. "Microsoft Edge". */
  name: string;
  /** Absolute path to the executable. */
  path: string;
  family: BrowserFamily;
  /** True when this project can actually drive it (CDP). */
  supported: boolean;
}

interface Candidate {
  name: string;
  family: BrowserFamily;
  /** Executable basename, for registry/PATH lookup. */
  exe: string;
  /** Absolute fallbacks, may contain `%ENV%` placeholders. */
  paths: string[];
}

const WIN_CANDIDATES: Candidate[] = [
  {
    name: "Google Chrome",
    family: "chromium",
    exe: "chrome.exe",
    paths: [
      "%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe",
      "%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe",
      // The per-user install — no admin required, and the one the old list forgot.
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    name: "Microsoft Edge",
    family: "chromium",
    exe: "msedge.exe",
    paths: [
      "%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
  {
    name: "Brave",
    family: "chromium",
    exe: "brave.exe",
    paths: [
      "%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%PROGRAMFILES(X86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ],
  },
  {
    name: "Vivaldi",
    family: "chromium",
    exe: "vivaldi.exe",
    paths: [
      "%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe",
      "%PROGRAMFILES%\\Vivaldi\\Application\\vivaldi.exe",
    ],
  },
  {
    name: "Opera",
    family: "chromium",
    exe: "opera.exe",
    paths: ["%LOCALAPPDATA%\\Programs\\Opera\\opera.exe", "%PROGRAMFILES%\\Opera\\opera.exe"],
  },
  {
    name: "Chromium",
    family: "chromium",
    exe: "chromium.exe",
    paths: ["%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe"],
  },
  {
    name: "Mozilla Firefox",
    family: "firefox",
    exe: "firefox.exe",
    paths: [
      "%PROGRAMFILES%\\Mozilla Firefox\\firefox.exe",
      "%PROGRAMFILES(X86)%\\Mozilla Firefox\\firefox.exe",
    ],
  },
];

const MAC_CANDIDATES: Candidate[] = [
  { name: "Google Chrome", family: "chromium", exe: "google-chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
  { name: "Microsoft Edge", family: "chromium", exe: "msedge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
  { name: "Brave", family: "chromium", exe: "brave", paths: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] },
  { name: "Vivaldi", family: "chromium", exe: "vivaldi", paths: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"] },
  { name: "Chromium", family: "chromium", exe: "chromium", paths: ["/Applications/Chromium.app/Contents/MacOS/Chromium"] },
  { name: "Mozilla Firefox", family: "firefox", exe: "firefox", paths: ["/Applications/Firefox.app/Contents/MacOS/firefox"] },
];

const LINUX_CANDIDATES: Candidate[] = [
  { name: "Google Chrome", family: "chromium", exe: "google-chrome", paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] },
  { name: "Chromium", family: "chromium", exe: "chromium", paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"] },
  { name: "Microsoft Edge", family: "chromium", exe: "microsoft-edge", paths: ["/usr/bin/microsoft-edge"] },
  { name: "Brave", family: "chromium", exe: "brave-browser", paths: ["/usr/bin/brave-browser"] },
  { name: "Mozilla Firefox", family: "firefox", exe: "firefox", paths: ["/usr/bin/firefox", "/snap/bin/firefox"] },
];

function candidates(): Candidate[] {
  if (process.platform === "win32") return WIN_CANDIDATES;
  if (process.platform === "darwin") return MAC_CANDIDATES;
  return LINUX_CANDIDATES;
}

/** Expand `%VAR%` placeholders. Returns null when the variable is unset, so we skip the path. */
export function expandEnvPath(raw: string): string | null {
  let missing = false;
  const out = raw.replace(/%([^%]+)%/g, (_, name: string) => {
    const value = process.env[name] ?? process.env[name.toUpperCase()];
    if (!value) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? null : out;
}

/**
 * Look an executable up in the Windows "App Paths" registry key, where installers record
 * themselves. This is how you find a browser that was installed somewhere non-standard.
 */
function fromRegistry(exe: string): string | null {
  if (process.platform !== "win32") return null;
  for (const hive of ["HKCU", "HKLM"]) {
    const r = spawnSync(
      "reg",
      ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout) continue;
    // `    (Default)    REG_SZ    C:\path\to\browser.exe`
    const m = r.stdout.match(/REG_SZ\s+(.+?)[\r\n]/);
    const path = m?.[1]?.trim().replace(/^"|"$/g, "");
    if (path && existsSync(path)) return path;
  }
  return null;
}

/**
 * Resolve an executable through PATH, ourselves.
 *
 * Deliberately NOT `where`: on Windows it searches the **current directory before PATH**, so a
 * `chrome.exe` sitting in whatever directory the user happened to run the command from would be
 * selected as "the browser" and launched — with a debugging port open and the user about to type
 * their brokerage password into it. Resolving PATH here lets us exclude the working directory
 * outright, and it removes a subprocess from the hot path.
 */
function fromPath(exe: string): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  let cwd = "";
  try {
    cwd = resolve(process.cwd()).toLowerCase();
  } catch {
    /* cwd may not exist; then there is nothing to exclude */
  }
  for (const raw of (process.env.PATH ?? "").split(sep)) {
    const dir = raw.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    let abs: string;
    try {
      abs = resolve(dir);
    } catch {
      continue;
    }
    if (abs.toLowerCase() === cwd) continue;
    const candidate = join(abs, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveCandidate(c: Candidate): string | null {
  const registry = fromRegistry(c.exe);
  if (registry) return registry;
  const onPath = fromPath(c.exe);
  if (onPath) return onPath;
  for (const raw of c.paths) {
    const expanded = expandEnvPath(raw);
    if (expanded && existsSync(expanded)) return expanded;
  }
  return null;
}

/** Guess a family from an executable path, for the STOCKBIT_BROWSER override. */
export function familyForPath(path: string): BrowserFamily {
  return /firefox|librewolf|waterfox/i.test(path) ? "firefox" : "chromium";
}

/**
 * Every browser we can find, most-preferred first. Chromium-family entries come first because they
 * are the only ones this project can drive.
 */
export function findBrowsers(): BrowserInfo[] {
  const override = process.env.STOCKBIT_BROWSER?.trim();
  const found: BrowserInfo[] = [];

  if (override) {
    if (!existsSync(override)) {
      throw new Error(`STOCKBIT_BROWSER points at a path that does not exist: ${override}`);
    }
    const family = familyForPath(override);
    found.push({ name: "STOCKBIT_BROWSER", path: override, family, supported: family === "chromium" });
  }

  // Dedup by path: the same executable is reachable through several routes (an override that also
  // sits on PATH, Chrome resolving from both the registry and a known path), and listing it twice
  // makes `doctor` claim two browsers where one exists. Case-insensitive because Windows and macOS
  // paths are.
  const seen = new Set(found.map((b) => b.path.toLowerCase()));
  for (const c of candidates()) {
    const path = resolveCandidate(c);
    if (!path || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    found.push({ name: c.name, path, family: c.family, supported: c.family === "chromium" });
  }

  // Drivable browsers first. Array.prototype.sort is stable, so preference order within each group
  // (and the override's position at the head of its group) is preserved.
  return found.sort((a, b) => Number(b.supported) - Number(a.supported));
}

/** Best drivable browser, or null. */
export function findBrowser(): string | null {
  return findBrowsers().find((b) => b.supported)?.path ?? null;
}

const VERSION_DIR_RE = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Version from the on-disk layout, which is how you read it on Windows.
 *
 * Chromium browsers there do not answer `--version` on the console: the process detaches, prints
 * nothing to stdout, and any output you do get is unrelated runtime noise (an Edge install here
 * emitted a native-messaging error instead of a version). But every Chromium install keeps its
 * payload in a sibling directory named for the version — `Application\152.0.3512.81\` — so the
 * filesystem answers the question without spawning anything.
 */
export function browserVersionFromLayout(path: string): string | null {
  try {
    const dir = dirname(path);
    const versions = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VERSION_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      });
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort version string for diagnostics. Never throws, and never reports garbage: output that
 * contains no version number at all is treated as no answer rather than shown to the user.
 */
export function browserVersion(path: string): string | null {
  const fromLayout = browserVersionFromLayout(path);
  if (fromLayout) return fromLayout;
  try {
    const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const line = `${r.stdout ?? ""}`.trim().split(/\r?\n/).find((l) => /\d+\.\d+/.test(l));
    return line?.trim() || null;
  } catch {
    return null;
  }
}
