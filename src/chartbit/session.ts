/**
 * The browser session behind Chartbit drawing: which browser, which profile, which tab.
 *
 * ## The browser is pinned, not discovered
 *
 * A Chromium profile is not portable between browsers. `~/.stockbit/browser-profile` was created by
 * whichever binary `stockbit-auth login` used, and opening it with a different one gives a fresh,
 * logged-out browser — or a refusal, depending on version. On a machine with several Chromium-family
 * browsers installed (this one has), `findBrowser()`'s idea of "the best" can change between the
 * login and a run three weeks later for reasons as incidental as an upgrade.
 *
 * So the identity comes from the pin written at login (`src/auth/browserprofile.ts`), and a missing
 * or stale pin is an error naming the fix rather than a silent fall back. The failure it prevents is
 * the expensive one: a logged-out chart page renders an EMPTY WHITE BODY, so drawing into it
 * succeeds, screenshots as blank, and reports the user's chart as having nothing on it.
 *
 * ## Deliberately no Network or Fetch domain
 *
 * This module enables `Page` and `Runtime` and nothing else. It never enables `Network.enable` or
 * `Fetch.enable`, which is what the login capture uses to read response bodies — that is exactly the
 * capability the drawing driver must not have. A driver that could see traffic could see the
 * session token, and a non-HTTP write path the transport's route table cannot inspect is already the
 * thing ADR-0005 had to argue for. `test/chartbit.test.ts` greps this directory for both.
 *
 * ## One browser, shared
 *
 * Claude Code and Claude Desktop each spawn their own copy of this server, and two visible browser
 * windows fighting over one profile is both useless and impossible (the second launch hands off to
 * the first and exits). A small record at `~/.stockbit/chartbit-driver.json` lets a second process
 * attach to the debugging port the first opened.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { CDP } from "../auth/cdp.js";
import { launchDebuggableBrowser } from "../auth/launch.js";
import { defaultProfileDir } from "../auth/login.js";
import { seedWebSession, webSessionHealth } from "../auth/websession.js";
import { pinnedBrowserExists, readBrowserProfile } from "../auth/browserprofile.js";
import { fileDir } from "../auth/store.js";
import { StockbitError } from "../http/errors.js";
import { stockbitUrl } from "../desktop/browser.js";
import { normalizeSymbol } from "../symbol.js";
import { loadSettings } from "../settings.js";
import { evaluateInPage } from "./evaluate.js";
import { READINESS } from "./page-scripts.js";

/** How long to wait for the widget to come up before giving up on a tab. */
export const CHART_READY_TIMEOUT_MS = 45_000;

/**
 * Chrome flags that stop it throttling rendering for a window that is not the OS's frontmost app.
 * Login capture does not need these — it only reads an intercepted request, never a painted pixel —
 * so they are passed as `extraArgs` for the chart driver specifically rather than folded into
 * `launchDebuggableBrowser`'s own defaults.
 */
const CHARTBIT_ANTI_THROTTLE_ARGS = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  // macOS's native window-occlusion tracking is the one that actually bit here: it stops
  // compositing a window it judges to be covered on screen, independent of the Page Visibility API
  // (`document.hidden` can read false while this still holds every paint). Confirmed against a live
  // chart: the series had 1,530 bars loaded (isLoading:false, no error) with nothing painted, and
  // the canvas started rendering the moment this feature was off.
  "--disable-features=CalculateNativeWinOcclusion",
];

interface DriverRecord {
  port: number;
  pid: number;
  browserPath: string;
}

function driverRecordPath(): string {
  return join(fileDir(), "chartbit-driver.json");
}

function readDriverRecord(): DriverRecord | null {
  try {
    const raw = JSON.parse(readFileSync(driverRecordPath(), "utf8")) as Partial<DriverRecord>;
    if (typeof raw.port !== "number" || typeof raw.browserPath !== "string") return null;
    return { port: raw.port, pid: typeof raw.pid === "number" ? raw.pid : 0, browserPath: raw.browserPath };
  } catch {
    return null;
  }
}

function writeDriverRecord(record: DriverRecord): void {
  try {
    mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
    writeFileSync(driverRecordPath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    // Losing the record costs a second browser window on the next call, not correctness.
  }
}

function clearDriverRecord(): void {
  try {
    rmSync(driverRecordPath(), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/** Whether a debugging port is answering, and its browser-level WebSocket URL if so. */
async function probePort(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return null;
    return ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Which browser to drive, or an error a user can act on.
 *
 * `STOCKBIT_BROWSER` overrides the pin, because a user who moved their browser needs a way through
 * without re-logging in — but it warns, since the override's likeliest outcome is a profile that
 * browser has never been logged into.
 */
export function resolveDriverBrowser(): { path: string; warning?: string } {
  const override = process.env.STOCKBIT_BROWSER?.trim();
  if (override) {
    return {
      path: override,
      warning:
        `Using STOCKBIT_BROWSER (${override}) instead of the browser this profile was created with. ` +
        "A Chromium profile is only valid in the browser that made it, so if the chart comes up logged " +
        "out, that is why.",
    };
  }

  const pinned = readBrowserProfile();
  if (!pinned) {
    throw new StockbitError(
      "auth",
      "No browser profile is recorded, so there is no logged-in browser to draw in. " +
        "Run `stockbit-auth login` first — it opens a browser, captures the session, and remembers which " +
        "browser the profile belongs to.",
    );
  }
  if (pinned.family === "firefox") {
    throw new StockbitError(
      "invalid_param",
      `The recorded browser is ${pinned.browserName}, which cannot be driven — Firefox removed CDP support ` +
        "in v141. Re-run `stockbit-auth login` with a Chromium-family browser (Chrome, Edge, Brave).",
    );
  }
  if (!pinnedBrowserExists(pinned)) {
    throw new StockbitError(
      "not_found",
      `The browser this profile belongs to is gone: ${pinned.browserPath}. Re-run \`stockbit-auth login\` ` +
        "with a browser that is installed, or point STOCKBIT_BROWSER at the one you moved it to.",
    );
  }
  return { path: pinned.browserPath };
}

export interface ChartTab {
  cdp: CDP;
  sessionId: string;
  targetId: string;
  symbol: string;
  /** The widget key the page exposed; carried so callers can report which context they drove. */
  widgetKey: string | null;
}

export interface OpenOptions {
  symbol: string;
  /** Off by default: Cloudflare blanks headless Chrome on stockbit.com. */
  headless?: boolean;
  /** Keep the browser alive after this session closes, so a second process can reuse it. */
  keepOpen?: boolean;
  readyTimeoutMs?: number;
}

/**
 * A live handle on the chart page for one symbol.
 *
 * Owns the browser process only when it launched one. When it attached to a browser another process
 * started, `close()` drops the socket and leaves the window alone — killing a browser this session
 * did not open would take the other server's chart down with it.
 */
export class ChartbitSession {
  private constructor(
    readonly cdp: CDP,
    private readonly child: ChildProcess | null,
    private readonly warnings: string[],
    private readonly keepOpen: boolean,
  ) {}

  /** Warnings worth relaying to the user: an overridden browser, a reused window. */
  get notes(): string[] {
    return [...this.warnings];
  }

  /**
   * Add a note. Use this, never `session.notes.push(...)`.
   *
   * `notes` hands out a COPY, so pushing through the getter compiles, runs, and silently does
   * nothing. That is exactly what happened to the "applied the stored web session" note: it was
   * written, it never once reached a caller, and it is precisely the line that would have shown —
   * during a week of chasing a session bug — whether the stored session was being applied at all
   * and how old it was.
   *
   * The getter is right to copy; writing through it was the mistake.
   */
  addNote(note: string): void {
    this.warnings.push(note);
  }

  static async open(options: OpenOptions): Promise<{ session: ChartbitSession; tab: ChartTab }> {
    const settings = loadSettings();
    const headless = options.headless ?? settings.chartbit.headless;
    const keepOpen = options.keepOpen ?? settings.chartbit.keepBrowserOpen;
    const browser = resolveDriverBrowser();
    const warnings: string[] = [];
    if (browser.warning) warnings.push(browser.warning);

    // Reuse a debuggable browser another process left running, when the record still answers AND is
    // the same binary. A record pointing at a different browser is stale, not a shortcut.
    const record = readDriverRecord();
    let wsUrl: string | null = null;
    let child: ChildProcess | null = null;
    if (record && record.browserPath === browser.path) {
      wsUrl = await probePort(record.port);
      if (wsUrl) warnings.push("Reused the browser window already open for charting.");
      else clearDriverRecord();
    }

    if (!wsUrl) {
      const launched = await launchDebuggableBrowser({
        bin: browser.path,
        profileDir: defaultProfileDir(),
        headless,
        // Chromium pauses a backgrounded page's render loop by default, which is invisible from
        // here: the widget still reports `hasChart: true` and the datafeed still returns real bars,
        // but the canvas never paints, so a screenshot or a drawing lands on a chart that LOOKS
        // empty while the window is not the user's frontmost app. These flags keep it rendering
        // regardless of OS focus; `Target.activateTarget` below is the belt to this suspenders.
        extraArgs: CHARTBIT_ANTI_THROTTLE_ARGS,
      });
      child = launched.child;
      wsUrl = launched.wsUrl;
      writeDriverRecord({ port: launched.port, pid: launched.child.pid ?? 0, browserPath: browser.path });
    }

    const cdp = await CDP.connect(wsUrl);
    const session = new ChartbitSession(cdp, child, warnings, keepOpen);
    try {
      // Seed the browser with the session captured at login, before anything navigates. The driver
      // never learns what is in it — `auth/websession` owns the credential and this only asks it to
      // apply itself — but the effect is that a profile which has gone stale opens signed in instead
      // of bouncing to `/login` and demanding another interactive login.
      try {
        const seeded = await seedWebSession(session.cdp);
        if (seeded.seeded && seeded.cookies > 0) {
          const age = seeded.ageHours === null ? "unknown age" : `${Math.round(seeded.ageHours)}h old`;
          session.addNote(`Applied the stored Stockbit web session (${seeded.cookies} cookies, ${age}).`);
        }
      } catch {
        // A profile that is already signed in does not need this at all.
      }

      const tab = await session.openChartTab(options.symbol, options.readyTimeoutMs ?? CHART_READY_TIMEOUT_MS);
      return { session, tab };
    } catch (err) {
      await session.close();
      throw err;
    }
  }

  /**
   * Find the chart tab for a symbol, or create it, then wait for the widget.
   *
   * Find-or-create rather than always-create: a user watching their own chart should see it change,
   * not watch a second tab open beside it.
   */
  private async openChartTab(symbolInput: string, readyTimeoutMs: number): Promise<ChartTab> {
    const symbol = normalizeSymbol(symbolInput);
    const url = stockbitUrl(symbol, "chart");

    const targets = (await this.cdp.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    };
    const existing = (targets?.targetInfos ?? []).find((t) => t.type === "page" && t.url.startsWith(url));
    const targetId =
      existing?.targetId ??
      ((await this.cdp.send("Target.createTarget", { url })) as { targetId: string }).targetId;

    const attached = (await this.cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId?: string;
    };
    const sessionId = attached?.sessionId;
    if (!sessionId) {
      throw new StockbitError("upstream", "Could not attach to the chart tab.");
    }

    // Belt to the launch flags' suspenders: raise the tab even if something else (the user's own
    // work) is the frontmost window. Without this, `hasChart`/`symbol` below can both be true while
    // the canvas never painted a single bar — a chart that reads as ready but screenshots as empty.
    await this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
    await this.raiseWindow(targetId);

    // Page and Runtime only. Never Network or Fetch — see the module note; the driver must not be
    // able to observe the session token it is drawing under.
    await this.cdp.send("Page.enable", {}, sessionId, 5_000).catch(() => {});
    await this.cdp.send("Runtime.enable", {}, sessionId, 5_000).catch(() => {});

    // No re-navigate for `existing`: it was found by an exact match on this symbol's own chartbit
    // URL, so it is already the right page. Reloading it anyway was the bug behind "the chart looks
    // ready but screenshots empty" — `waitForChart` below only waits for the widget object and the
    // right symbol to appear, which happens well before a freshly reloaded page's canvas has
    // actually painted a bar, so every call against an open tab raced a reload it didn't need.

    const widgetKey = await this.waitForChart(sessionId, symbol, readyTimeoutMs);
    return { cdp: this.cdp, sessionId, targetId, symbol, widgetKey };
  }

  /**
   * Raise the OS window, not just the tab inside it.
   *
   * `Target.activateTarget` selects the tab within its window; it does nothing about a window that is
   * minimised or buried behind the user's own work. The point of drawing on the user's REAL chart
   * rather than rendering a picture is that they can look at it and keep using it, so a window they
   * cannot see is the feature failing quietly. `windowState: "normal"` un-minimises; sending it on an
   * already-normal window is a no-op rather than an error.
   *
   * Best-effort throughout: a browser that will not raise its own window is not a reason to fail a
   * draw that otherwise succeeded, so every step swallows its error.
   */
  private async raiseWindow(targetId: string): Promise<void> {
    try {
      const found = (await this.cdp.send("Browser.getWindowForTarget", { targetId })) as {
        windowId?: number;
        bounds?: { windowState?: string };
      };
      if (typeof found?.windowId !== "number") return;
      if (found.bounds?.windowState === "minimized") {
        await this.cdp.send("Browser.setWindowBounds", {
          windowId: found.windowId,
          bounds: { windowState: "normal" },
        });
      }
      // Re-assert focus after the state change; on Windows the un-minimise alone can restore the
      // window behind whatever was in front of it.
      await this.cdp.send("Target.activateTarget", { targetId });
    } catch {
      // A browser that refuses to raise itself still drew the chart correctly.
    }
  }

  /**
   * Poll until the TradingView widget is up and showing the right symbol.
   *
   * The three failure states are reported separately because they need three different messages, and
   * two of them are invisible from a screenshot: a signed-out chart page is a blank white body, and
   * a headless Chrome that Cloudflare decided to challenge is the same blank body for a different
   * reason.
   */
  private async waitForChart(sessionId: string, symbol: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let last: Readiness | null = null;
    let lastThrow: string | null = null;

    for (;;) {
      try {
        last = await evaluateInPage<Readiness>(this.cdp, sessionId, READINESS);
      } catch (err) {
        // A page that throws is not a page that failed: for the first second or so of a cold boot
        // the widget answers `typeof activeChart === "function"` while calling it still throws from
        // inside TradingView's own bundle. That is "not ready yet" wearing an exception, and it is
        // exactly what this loop exists to wait out. Keep the reason and retry until the deadline,
        // so a genuinely broken page still reports something rather than an empty timeout.
        lastThrow = err instanceof Error ? err.message : String(err);
        if (Date.now() >= deadline) break;
        await delay(500);
        continue;
      }
      if (last?.loggedOut) {
        throw new StockbitError(
          "auth",
          "The chart page redirected to the login screen, so this browser profile is not signed in. " +
            "Run `stockbit-auth login` and complete the login in the window it opens.",
        );
      }
      if (last?.hasChart && last.hasBars && (last.symbol ?? "").toUpperCase().endsWith(symbol)) {
        return last.widgetKey;
      }
      if (Date.now() >= deadline) break;
      await delay(500);
    }

    if (last?.shellOnly) {
      // The document arrived and rendered nothing. That is not "not signed in" and not "still
      // loading" — it is an app whose own API calls are being refused, which on Stockbit means the
      // browser profile's session has gone stale even though the CLI's API token is fine. Those are
      // two different credentials and only one of them is being reported by `status`.
      throw new StockbitError(
        "auth",
        `The chart page for ${symbol} loaded but rendered nothing: the markup is there and its height ` +
          "is zero, which is what Stockbit does when the browser session is stale and every request " +
          "behind the page is answered with 401. The API token being valid does not help here — the " +
          "website session is a SEPARATE credential and cannot be minted from the API one. " +
          webSessionHealth().hint,
      );
    }
    if (last?.blank) {
      throw new StockbitError(
        "auth",
        "The chart page loaded an empty body, which is what Stockbit renders when the session is not " +
          "signed in — and also what Cloudflare returns to a headless browser. Run `stockbit-auth login`, " +
          "and if the driver is running headless, turn that off (chartbit.headless in the settings file).",
      );
    }
    throw new StockbitError(
      "upstream",
      `The chart for ${symbol} did not finish loading within ${Math.round(timeoutMs / 1000)}s ` +
        (lastThrow ? `(the page kept throwing: ${lastThrow}) ` : "") +
        `(widget ${last?.widgetKey ? "found" : "not found"}, showing ${last?.symbol ?? "nothing"}` +
        `${last?.hasChart ? `, bars ${last.hasBars ? "loaded" : "not loaded yet"}` : ""}).`,
    );
  }

  /**
   * Drop the connection.
   *
   * The browser is killed only if this session launched it AND was not asked to keep it open. A
   * window another process opened is left alone — closing it would take that server's chart down.
   */
  async close(): Promise<void> {
    this.cdp.close();
    if (this.child && !this.keepOpen) {
      this.child.kill();
      clearDriverRecord();
    }
  }
}

interface Readiness {
  loggedOut: boolean;
  blank: boolean;
  widgetKey: string | null;
  hasChart: boolean;
  hasBars: boolean;
  symbol: string | null;
  shellOnly?: boolean;
  readyState: string;
}

/** Whether a drivable, logged-in browser is configured at all — for `stockbit-auth doctor`. */
export function driverAvailability(): { ok: boolean; detail: string } {
  try {
    const browser = resolveDriverBrowser();
    const profile = defaultProfileDir();
    if (!existsSync(profile)) {
      return { ok: false, detail: `no browser profile at ${profile} — run \`stockbit-auth login\`` };
    }
    return { ok: true, detail: `${browser.path}${browser.warning ? " (overridden by STOCKBIT_BROWSER)" : ""}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
