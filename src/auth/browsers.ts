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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  /** True when the OS opens links with this one. Preferred, never required — see `defaultBrowserPath`. */
  isDefault?: boolean;
  /** True when `STOCKBIT_BROWSER` named it. An explicit choice outranks the OS default. */
  isOverride?: boolean;
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
    found.push({
      name: "STOCKBIT_BROWSER",
      path: override,
      family,
      supported: family === "chromium",
      isOverride: true,
    });
  }

  // Ask the OS which browser it opens links with. Compared case-insensitively because Windows and
  // macOS paths are, and the registry's casing need not match the candidate table's.
  const osDefault = defaultBrowserPath();
  const isDefault = (path: string) => Boolean(osDefault) && path.toLowerCase() === osDefault!.toLowerCase();

  // Dedup by path: the same executable is reachable through several routes (an override that also
  // sits on PATH, Chrome resolving from both the registry and a known path), and listing it twice
  // makes `doctor` claim two browsers where one exists. Case-insensitive because Windows and macOS
  // paths are.
  const seen = new Set(found.map((b) => b.path.toLowerCase()));
  for (const c of candidates()) {
    const path = resolveCandidate(c);
    if (!path || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    found.push({
      name: c.name,
      path,
      family: c.family,
      supported: c.family === "chromium",
      isDefault: isDefault(path),
    });
  }

  // The OS default may be a browser the candidate table does not list at all — a Chromium fork, a
  // portable install, something installed somewhere unusual. It is still the user's browser, so it
  // belongs in the list rather than being invisible.
  if (osDefault && !seen.has(osDefault.toLowerCase())) {
    const family = familyForPath(osDefault);
    found.push({
      name: "Default browser",
      path: osDefault,
      family,
      supported: family === "chromium",
      isDefault: true,
    });
  }

  // Three keys, in this order, and the order is the whole design:
  //
  //   1. DRIVABLE first. Chartbit speaks the Chrome DevTools Protocol; Firefox and Safari do not.
  //      A browser that cannot be driven is listed so it can be explained, never chosen.
  //   2. An explicit STOCKBIT_BROWSER next. Someone who named a browser outranks the OS.
  //   3. The OS DEFAULT next. This is the fix: the table below is a preference order, and preference
  //      order is the wrong question to ask on someone else's machine. It put Chrome first, so a user
  //      whose default is Edge or Opera — but who has Chrome installed for something else — was given
  //      a browser they do not use and asked to log in to Stockbit again inside it.
  //
  // Only then does the table's own order break the tie. `sort` is stable, so it survives untouched.
  const rank = (b: BrowserInfo) => (b.isOverride ? 0 : b.isDefault ? 1 : 2);
  return found.sort((a, b) => Number(b.supported) - Number(a.supported) || rank(a) - rank(b));
}

/**
 * What to tell a user whose default browser cannot be driven.
 *
 * Returns null when there is nothing to say — the default is drivable, or there is no detectable
 * default at all. Otherwise a sentence naming their browser, why it cannot be used for charting, and
 * what to install. Safari and Firefox are not deficient browsers; they simply do not implement the
 * Chrome DevTools Protocol, which is the only way this project can draw on a real Stockbit chart.
 *
 * Deliberately a RECOMMENDATION rather than a refusal: everything except Chartbit works regardless,
 * because the REST tools never open a browser at all.
 */
export function defaultBrowserAdvice(): string | null {
  const osDefault = defaultBrowserPath();
  if (!osDefault) return null;
  if (familyForPath(osDefault) === "chromium") return null;

  const name = /firefox/i.test(osDefault)
    ? "Firefox"
    : /safari/i.test(osDefault)
      ? "Safari"
      : "your default browser";
  const drivable = findBrowsers().filter((b) => b.supported);

  const suggestion = drivable.length
    ? `Chart drawing will use ${drivable[0].name} instead, which is already installed.`
    : "Install a Chromium-based browser to enable it — Google Chrome (google.com/chrome), " +
      "Microsoft Edge (microsoft.com/edge) or Brave (brave.com). Any one of them is enough; " +
      "you do not have to make it your default.";

  return (
    `${name} is your default browser, and it cannot be used for chart drawing: that needs the ` +
    `Chrome DevTools Protocol, which only Chromium-based browsers implement. ${suggestion} ` +
    "Everything else — quotes, bandarmology, fundamentals, your portfolio — is unaffected, because " +
    "those never open a browser."
  );
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

/* ---------------------------- the user's own default browser ---------------------------- */

/**
 * The browser the operating system opens a link with.
 *
 * ## Why this exists
 *
 * The candidate table below is a PREFERENCE ORDER, and preference order is the wrong question to ask
 * on someone else's machine. It put Chrome first, so a user whose default browser is Edge, Opera or
 * Brave — but who also happens to have Chrome installed for something else — got Chrome: a browser
 * they do not use, holding a profile they never see, asking them to log in to Stockbit a second time.
 * Measured on the machine this was written on, whose default is Opera and which was being driven
 * through Chrome for exactly that reason.
 *
 * Asking the OS removes the guess. It is only ever a PREFERENCE though — never a requirement — for
 * two reasons that both matter:
 *
 *  1. **Chartbit needs the Chrome DevTools Protocol.** Firefox and Safari do not speak it, so a
 *     default of Firefox cannot be honoured for charting no matter how much the user wants it. The
 *     caller falls back to the best drivable browser and `doctor` explains why.
 *  2. **A Chromium profile is not portable between browsers.** Once `stockbit-auth login` pins one,
 *     that pin is authoritative for every later run — see `chartbit/session.ts`. Changing the default
 *     browser afterwards does not silently move an existing logged-in session; it changes what the
 *     NEXT login picks.
 *
 * ## Never throws
 *
 * Every platform path is a best-effort read of something outside this project's control: a registry
 * key, a plist, an `xdg-settings` binary that may not be installed. A failure here must degrade to
 * "no opinion" and let the preference order decide, because a browser that cannot be detected is not
 * a reason to refuse to open one.
 */
export function defaultBrowserPath(): string | null {
  try {
    if (process.platform === "win32") return winDefaultBrowser();
    if (process.platform === "darwin") return macDefaultBrowser();
    return linuxDefaultBrowser();
  } catch {
    return null;
  }
}

/** Pull the executable out of a Windows `shell\open\command` value. */
function exeFromCommand(command: string): string | null {
  // Formats differ per browser and the difference is not cosmetic:
  //   Chrome  "C:\...\chrome.exe" --single-argument %1
  //   Opera   "C:\...\opera.exe" -noautoupdate -- "%1"
  //   Firefox "C:\...\firefox.exe" -osint -url "%1"
  // Taking the first QUOTED run handles all of them; splitting on spaces would truncate at
  // "Program Files".
  const quoted = /^"([^"]+)"/.exec(command.trim());
  const path = quoted ? quoted[1] : command.trim().split(/\s+/)[0];
  return path && existsSync(path) ? path : null;
}

function winDefaultBrowser(): string | null {
  // The UserChoice key is what the Settings app writes, and it is per-user — which is the level that
  // matters. HKCR\<ProgId>\shell\open\command then gives the executable.
  const userChoice = regValue(
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "ProgId",
  );
  if (!userChoice) return null;
  const command =
    regValue(`HKCR\\${userChoice}\\shell\\open\\command`, "") ??
    regValue(`HKCU\\Software\\Classes\\${userChoice}\\shell\\open\\command`, "");
  return command ? exeFromCommand(command) : null;
}

/** One registry value, or null. `valueName` empty means the key's default value. */
function regValue(key: string, valueName: string): string | null {
  const args = ["query", key];
  if (valueName) args.push("/v", valueName);
  else args.push("/ve");
  const out = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
  if (out.status !== 0 || !out.stdout) return null;
  // `reg query` prints `    <name>    REG_SZ    <value>` — the value can contain spaces, so split on
  // the type and take everything after it.
  const line = out.stdout.split(/\r?\n/).find((l) => /\s+REG_(SZ|EXPAND_SZ)\s+/.test(l));
  if (!line) return null;
  const value = line.split(/\s+REG_(?:SZ|EXPAND_SZ)\s+/)[1];
  return value ? value.trim() : null;
}

/**
 * macOS: LaunchServices records the handler for the `https` scheme as a bundle identifier.
 *
 * NOT VERIFIED on a real Mac — written from the documented plist shape. It is defensive by
 * construction and returns null on anything unexpected, so the worst case is the preference order
 * deciding, exactly as before this function existed.
 */
function macDefaultBrowser(): string | null {
  const out = spawnSync(
    "defaults",
    ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
    { encoding: "utf8" },
  );
  if (out.status !== 0 || !out.stdout) return null;

  // Find the entry whose LSHandlerURLScheme is https and read its role handler.
  const entry = out.stdout
    .split(/\}\s*,?/)
    .find((block) => /LSHandlerURLScheme\s*=\s*https\b/.test(block));
  if (!entry) return null;
  const bundle = /LSHandlerRoleAll\s*=\s*"?([\w.\-]+)"?/.exec(entry)?.[1];
  if (!bundle) return null;

  const byBundle: Record<string, string> = {
    "com.google.chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "com.microsoft.edgemac": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "com.brave.browser": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "com.vivaldi.vivaldi": "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    "com.operasoftware.opera": "/Applications/Opera.app/Contents/MacOS/Opera",
    "org.chromium.chromium": "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "org.mozilla.firefox": "/Applications/Firefox.app/Contents/MacOS/firefox",
  };
  const path = byBundle[bundle.toLowerCase()];
  return path && existsSync(path) ? path : null;
}

/**
 * Linux: `xdg-settings` names a .desktop file; the executable is its `Exec=` line.
 *
 * NOT VERIFIED on a real desktop Linux session. `xdg-settings` may not be installed at all, which is
 * a null rather than an error.
 */
function linuxDefaultBrowser(): string | null {
  const out = spawnSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout?.trim()) return null;
  const desktop = out.stdout.trim();

  const dirs = [
    join(process.env.HOME ?? "", ".local/share/applications"),
    "/usr/local/share/applications",
    "/usr/share/applications",
    "/var/lib/flatpak/exports/share/applications",
  ];
  for (const dir of dirs) {
    const file = join(dir, desktop);
    if (!existsSync(file)) continue;
    let exec: string | null = null;
    try {
      exec = /^Exec=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1] ?? null;
    } catch {
      continue;
    }
    if (!exec) continue;
    // Strip the field codes a .desktop Exec line carries (%u, %U, %f, …) and any leading wrapper.
    const first = exec.replace(/%[a-zA-Z]/g, "").trim().split(/\s+/)[0];
    if (!first) continue;
    if (first.startsWith("/") && existsSync(first)) return first;
    const onPath = fromPath(first);
    if (onPath) return onPath;
  }
  return null;
}
