/**
 * One report answering "is this thing working, and if not, what do I run?"
 *
 * Every new user arrives in the same state — installed, not logged in — and until now the only way
 * to find that out from inside a client was to call a market tool and read an error. That error
 * names one missing session at a time and says nothing about the other two, the trading switch, or
 * whether the market is simply shut. Four separate confusions, one of which is not a fault at all.
 *
 * So this is a single structured answer, and both the `status` tool and `stockbit-auth status` read
 * from it rather than each formatting their own version of the truth.
 *
 * ## Two rules it is built around
 *
 * **It must never throw.** The state it is most needed in is the broken one: no store, no
 * directory, a corrupt settings file, a token that is not a JWT. Every read below is wrapped, and a
 * failure becomes a `check` with a reason rather than an exception the user cannot see past.
 *
 * **No token, ever.** The expiry is decoded from the stored JWT and the token itself is never
 * copied into the report — not into a field, not into an error message. A tool result is text a
 * model relays and a client may log. `test/status.test.ts` asserts nothing JWT-shaped appears in
 * the serialised output.
 *
 * ## What an expiry does and does not mean
 *
 * `expiresInDays` comes from the payload's `exp`, which is a claim about time, not a statement of
 * validity: a refresh token can be revoked or rotated out from under this store and not one byte of
 * the payload changes. `live: true` settles it by actually refreshing once — one request — and is
 * off by default because `status` is the thing you call when you suspect the network.
 */
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getStore, type StoreSlot, type StoreState } from "./auth/store.js";
import { DEFAULT_TOOL_PROFILE } from "./tools/_profile.js";
import {
  lastEventFor,
  readHealthJournal,
  slotHealthState,
  type SlotHealthState,
} from "./auth/health.js";
import { webSessionHealth, type WebSessionHealth } from "./auth/websession.js";
import { decodeJwt, forceRefresh } from "./auth/session.js";
import { readBrowserProfile } from "./auth/browserprofile.js";
import { defaultBrowserPath, defaultBrowserAdvice } from "./auth/browsers.js";
import { tradingPolicy, type TradingMode, type TradingPolicy } from "./settings.js";
import { sessionClock, type SessionClock } from "./core/sessionclock.js";
import { stockbitDir } from "./paths.js";
import { VERSION } from "./version.js";

export interface SlotStatus {
  stored: boolean;
  backend: "keychain" | "file" | "unknown";
  /**
   * True when the store could not say whether a credential is there — a locked Keychain, or a
   * declined access prompt. Distinct from `stored: false`, which means it looked and found nothing.
   * Advice built on the two must differ: one says "log in", the other says "unlock your Keychain",
   * and giving the first answer to the second situation destroys a credential that was fine.
   */
  unreadable?: boolean;
  /** Days until the stored token's `exp`. Absent when there is no token or no `exp`. */
  expiresInDays?: number;
  /** True when `exp` is already in the past. */
  expired?: boolean;
  /**
   * What is known about whether this credential still WORKS, as opposed to whether it has expired.
   *
   * An expiry is a claim about time. A token can be revoked, or superseded by another login, and
   * not one byte of its payload changes — so `expiresInDays` has always been able to report health
   * on a token that 401s on its first use. This is derived from what actually happened the last
   * time a refresh was made, which costs nothing and is the only way to say `failing` at zero
   * requests. See `src/auth/health.ts`.
   */
  health?: SlotHealthState;
  /** When the last recorded refresh happened, and whether it worked. Never a token. */
  lastRefresh?: { at: string; ok: boolean; status?: number };
  /** What to do about this slot, when there is something to do. */
  hint?: string;
}

export interface LoginStatus {
  inProgress: boolean;
  startedAt?: string;
  /** `captured`, `timeout`, or `error: <redacted>` from the last attempt this process started. */
  lastResult?: string;
}

export interface StatusCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface StatusReport {
  server: {
    name: string;
    version: string;
    node: string;
    platform: string;
    toolProfile: string;
    toolCount?: number;
  };
  auth: Record<StoreSlot, SlotStatus>;
  login: LoginStatus;
  trading: {
    /** `off`, `paper` or `live` — the one field that answers "what happens if I place an order". */
    mode: TradingMode;
    live: boolean;
    enabled: boolean;
    autoConfirm: boolean;
    maxOrderValueIdr: number | null;
    maxLotsPerOrder: number;
    allowedSymbols: string[];
    source: TradingPolicy["source"];
    reason: string;
    settingsPath: string;
    corrupt?: true;
  };
  market: SessionClock;
  /**
   * The BROWSER's Stockbit website session — a different credential from every slot in `auth`.
   *
   * Reported separately because conflating them is what made this confusing to diagnose: `auth.main`
   * could be healthy and refreshing cleanly while the website was logged out, and nothing in the
   * output said those were different things. Judged on the refresh token's expiry and side-effect
   * free; see `webSessionHealth`.
   */
  webSession: WebSessionHealth;
  store: {
    dir: string;
    backend: "keychain" | "file" | "unknown";
    browserPinned: string | null;
    /**
     * When `stockbit-auth login` last ran, and how long ago.
     *
     * This is the question users actually ask — "how old is my login?" — and until now the answer
     * was spread across three different clocks that mean different things: the web session's
     * capture time, the access token's 24h expiry, and the refresh token's ~7d deadline. None of
     * them is the login. `loggedInAt` is written once, by the login itself.
     */
    loggedInAt: string | null;
    loginAgeHours: number | null;
    /** The browser the OS opens links with, and whether it is the pinned one. */
    defaultBrowser: string | null;
    defaultBrowserIsPinned: boolean | null;
  };
  checks: StatusCheck[];
  /** The single next command or sentence. Always present. */
  nextStep: string;
}

export interface CollectStatusOptions {
  /** Also refresh the market-data token to prove it works. One request. */
  live?: boolean;
  /** Injectable so the session clock is testable. */
  now?: Date;
  /** How many tools this server registered. */
  toolCount?: number;
  /** What the active tool profile is called. */
  profileLabel?: string;
  /** Whether that profile is the default rather than something the user asked for. */
  profileIsDefault?: boolean;
  /**
   * Why `STOCKBIT_TOOLS` could not be parsed, when it could not be.
   *
   * This is the state `status` exists for. An unparsable value makes `stockbit-mcp` refuse to start,
   * so the user is looking at a client that says "server failed" and running this command to find
   * out why — and reporting a `toolProfile` as though a server were running would be answering a
   * question nobody asked with a fact that is not true.
   */
  profileError?: string;
  /**
   * Tool NAMES this profile kept out, so `status` can explain a missing tool.
   *
   * Names, not families. A family with one skipped tool is not a family that is absent, and
   * `STOCKBIT_TOOLS=core,order_preview,order_buy,…` registers every order tool while leaving
   * `order_history` and friends behind — which at family granularity read as "no order tools at
   * all" and hijacked `nextStep` away from the advice the user actually needed.
   */
  missingTools?: string[];
}

/* ------------------------------- login progress ------------------------------- */

/**
 * Whether a browser login this process started is still running.
 *
 * Module state rather than a file: it describes *this* process. A server restarted mid-login has
 * abandoned the capture, and reporting "in progress" from a file another process wrote would be a
 * lie the user could not act on.
 */
const loginState: LoginStatus = { inProgress: false };

export function loginStarted(at: Date = new Date()): void {
  loginState.inProgress = true;
  loginState.startedAt = at.toISOString();
  delete loginState.lastResult;
}

export function loginFinished(result: string): void {
  loginState.inProgress = false;
  loginState.lastResult = result;
}

export function loginStatus(): LoginStatus {
  return { ...loginState };
}

/** Test seam: forget any login this process recorded. */
export function resetLoginStatus(): void {
  loginState.inProgress = false;
  delete loginState.startedAt;
  delete loginState.lastResult;
}

/* ---------------------------------- collection ---------------------------------- */

const SLOT_HINTS: Record<StoreSlot, string> = {
  main: "Say \"log me into Stockbit\" (opens your browser), or run `npx -y -p stockbit-mcp stockbit-auth login`.",
  securities:
    "Optional. Needed for portfolio, positions and orders: run `stockbit-auth trading-login` in a terminal (it asks for your 6-digit PIN, which no tool here accepts).",
  eipo: "Optional. Minted on first use from your main session; nothing to run.",
};

function slotStatus(slot: StoreSlot, checks: StatusCheck[]): SlotStatus {
  let token: string | null = null;
  let backend: SlotStatus["backend"] = "unknown";
  let state: StoreState = "absent";
  try {
    const store = getStore(slot);
    backend = store.backend;
    state = store.readState();
    token = state === "present" ? store.get() : null;
  } catch (err) {
    checks.push({
      name: `credential store (${slot})`,
      status: "fail",
      detail: `Could not be read: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { stored: false, backend, hint: SLOT_HINTS[slot] };
  }

  // "I could not find out" is not "there is nothing here". Saying the second when the first is true
  // is how a user with a locked Keychain gets told to log in again — which means throwing away a
  // credential that was never in doubt.
  if (state === "unavailable") {
    checks.push({
      name: `credential store (${slot})`,
      status: "warn",
      detail:
        "The Keychain would not answer — it is locked, or an access prompt was declined. Whether " +
        "a session is stored is unknown; this is NOT the same as having none.",
    });
    return {
      stored: false,
      unreadable: true,
      backend,
      hint:
        "Unlock your login Keychain (open Keychain Access, or run any command that prompts) and " +
        "ask again. Do not log in again yet — the stored credential may be perfectly good.",
    };
  }

  if (!token) return { stored: false, backend, hint: SLOT_HINTS[slot] };

  const result: SlotStatus = { stored: true, backend };
  const exp = decodeJwt(token)["exp"];
  if (typeof exp === "number") {
    const days = (exp - Date.now() / 1000) / 86400;
    result.expiresInDays = Math.round(days * 10) / 10;
    if (days <= 0) {
      result.expired = true;
      result.hint =
        slot === "main"
          ? "The stored token's expiry has passed. Log in again."
          : `${SLOT_HINTS[slot]} The stored one has expired.`;
      checks.push({
        name: `${slot} session`,
        status: "warn",
        detail: "The stored token's expiry has passed. It will not refresh.",
      });
    }
  }

  // What is RECORDED about this token, which is a different question from what its payload claims.
  // Wrapped because this function must never throw: a corrupt journal is a diagnostic that is
  // missing, never a status report that fails.
  try {
    const journal = readHealthJournal();
    result.health = slotHealthState(slot, token, result.expired === true, journal);
    const event = lastEventFor(slot, journal);
    if (event) {
      result.lastRefresh = {
        at: event.at,
        ok: event.reason === undefined,
        ...(event.status === undefined ? {} : { status: event.status }),
      };
    }
    if (result.health === "failing") {
      checks.push({
        name: `${slot} session`,
        status: "fail",
        detail:
          `Stockbit REJECTED this token at ${event ? formatTime(event.at) : "an unrecorded time"}` +
          `${event?.status ? ` (HTTP ${event.status})` : ""}. It is present and unexpired, so an ` +
          "expiry check cannot see this — it has been revoked, or superseded by another login.",
      });
      result.hint =
        slot === "main"
          ? "Log in again — this token is present and unexpired but Stockbit no longer accepts it."
          : `${SLOT_HINTS[slot]} The stored one was rejected.`;
    }
  } catch {
    /* the journal is diagnostics; its absence is not a status failure */
  }

  return result;
}

/** `HH:MM` in local time, or the raw string if it will not parse. Never throws. */
function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The one thing to do next, chosen from the state rather than listed as options. */
function nextStepFor(
  auth: Record<StoreSlot, SlotStatus>,
  trading: StatusReport["trading"],
  surface: { tradingToolsMissing: boolean; profileLabel: string; profileError?: string } = {
    tradingToolsMissing: false,
    profileLabel: DEFAULT_TOOL_PROFILE,
  },
): string {
  // Before anything else: if the store would not answer, every branch below is reasoning from a
  // fact nobody established. "Log in again" is the one piece of advice that must not be given here.
  // Before anything about credentials: if the server cannot start, no advice about sessions is
  // actionable, because there is nothing to use them.
  if (surface.profileError) {
    return (
      `Fix STOCKBIT_TOOLS in the client's config — the server refuses to start with it: ` +
      `${surface.profileError} Removing it entirely is also valid and gives the default profile.`
    );
  }
  if (auth.main.unreadable) return auth.main.hint!;
  // The branch that was missing. Present, unexpired, and rejected — which every expiry-based check
  // reports as healthy, and which is what a revoked or superseded session actually looks like.
  if (auth.main.health === "failing") {
    const when = auth.main.lastRefresh ? ` at ${formatTime(auth.main.lastRefresh.at)}` : "";
    return (
      `The stored market-data token is present and unexpired, but Stockbit rejected it${when} — ` +
      "revoked, or superseded by another login. Log in again: say \"log me into Stockbit\", or run " +
      "`npx -y -p stockbit-mcp stockbit-auth login`."
    );
  }
  if (!auth.main.stored || auth.main.expired) {
    return (
      'Say "log me into Stockbit" (a browser window opens — sign in there), or run ' +
      "`npx -y -p stockbit-mcp stockbit-auth login` in a terminal. Then call status again."
    );
  }
  // Above the securities branch on purpose. If this server has no order tools, then telling the
  // user to run `trading-login` is advice that leads nowhere: they would complete it and still have
  // nothing to place an order with. The contradiction is the more urgent fact, and it is the one
  // nothing else anywhere reports.
  if (surface.tradingToolsMissing) {
    return (
      `Trading is ${trading.mode}, but this server did not register the order-entry tools — the ` +
      `\`${surface.profileLabel}\` tool profile does not include them. Set ` +
      `STOCKBIT_TOOLS=${surface.profileLabel},trading in the client's config and restart it.`
    );
  }
  if (!auth.securities.stored) {
    return (
      "Market data works. Portfolio, positions and order entry additionally need " +
      "`stockbit-auth trading-login` in a terminal (optional) — or try paper trading first with " +
      "`stockbit-auth trading-enable --paper`."
    );
  }
  if (trading.mode === "off") {
    return (
      "Everything reads. Order entry is off — try it on paper first with " +
      "`stockbit-auth trading-enable --paper`, which needs no PIN and no real money."
    );
  }
  if (trading.mode === "paper") {
    return 'Paper trading is on. Try: "preview a buy of 1 lot of BBRI", then agree to it.';
  }
  return 'You are set. Try: "broker summary for BBRI".';
}

/** Build the report. Never throws. */
export async function collectStatus(options: CollectStatusOptions = {}): Promise<StatusReport> {
  const checks: StatusCheck[] = [];

  const auth: Record<StoreSlot, SlotStatus> = {
    main: slotStatus("main", checks),
    securities: slotStatus("securities", checks),
    eipo: slotStatus("eipo", checks),
  };

  let policy: TradingPolicy;
  try {
    policy = tradingPolicy();
  } catch (err) {
    checks.push({
      name: "settings",
      status: "fail",
      detail: `Could not be read, so trading is off: ${err instanceof Error ? err.message : String(err)}`,
    });
    policy = {
      mode: "off",
      live: false,
      enabled: false,
      paper: { startingCashIdr: 0 },
      autoConfirm: false,
      maxOrderValueIdr: null,
      allowedSymbols: [],
      maxLotsPerOrder: 0,
      source: "default-off",
      reason: "The settings file could not be read, and an unreadable policy file is treated as no permission.",
      settingsPath: "(unknown)",
    };
  }

  const trading: StatusReport["trading"] = {
    mode: policy.mode,
    live: policy.live,
    enabled: policy.enabled,
    autoConfirm: policy.autoConfirm,
    maxOrderValueIdr: policy.maxOrderValueIdr,
    maxLotsPerOrder: policy.maxLotsPerOrder,
    allowedSymbols: policy.allowedSymbols,
    source: policy.source,
    reason: policy.reason,
    settingsPath: policy.settingsPath,
    ...(policy.corrupt ? { corrupt: true as const } : {}),
  };
  if (policy.corrupt) {
    checks.push({
      name: "settings",
      status: "warn",
      detail: `${policy.settingsPath} could not be parsed. Trading is off until it is fixed or deleted.`,
    });
  }

  const web = webSessionHealth();
  let browserPinned: string | null = null;
  let loggedInAt: string | null = null;
  let loginAgeHours: number | null = null;
  let pinnedPath: string | null = null;
  try {
    const pinned = readBrowserProfile();
    browserPinned = pinned ? `${pinned.browserName}${pinned.version ? ` ${pinned.version}` : ""}` : null;
    pinnedPath = pinned?.browserPath ?? null;
    // `loggedInAt` is "" when the record predates the field, and an unparseable value must read as
    // "unknown" rather than as an age of 56 years.
    const at = pinned?.loggedInAt ? Date.parse(pinned.loggedInAt) : Number.NaN;
    if (Number.isFinite(at)) {
      loggedInAt = new Date(at).toISOString();
      loginAgeHours = (Date.now() - at) / 3_600_000;
    }
  } catch {
    browserPinned = null;
  }

  // Which browser the OS would open a link with. Read here rather than in `formatStatus` so the
  // structured report a model reads and the line a human reads cannot disagree.
  let defaultBrowser: string | null = null;
  let defaultBrowserIsPinned: boolean | null = null;
  try {
    defaultBrowser = defaultBrowserPath();
    defaultBrowserIsPinned =
      defaultBrowser && pinnedPath ? defaultBrowser.toLowerCase() === pinnedPath.toLowerCase() : null;
  } catch {
    defaultBrowser = null;
  }
  if (web.present && web.expired) {
    // `expired`, NOT `!likelyValid`. Under the three-state verdict those are different things:
    // `!likelyValid` is also true for "unknown", where the credential simply could not be read and
    // nothing is claimed either way. Warning on unknown would put "your website session is in
    // trouble" in front of a user whose session is fine — a quieter version of the same conflation
    // that produced a login prompt every day.
    //
    // Distinct from the token slots on purpose: this is the credential Chartbit needs, and it can be
    // dead while every slot above is perfectly healthy. That combination is what made the original
    // failure so hard to read.
    checks.push({ name: "website session", status: "warn", detail: web.hint });
  }
  checks.push(runningCodeCheck());

  // Safari and Firefox cannot be driven for charting — they do not implement the Chrome DevTools
  // Protocol. Say so once, with what to install, rather than letting the user discover it as a
  // failed chart. Everything else works regardless, which the message says explicitly.
  try {
    const advice = defaultBrowserAdvice();
    if (advice) checks.push({ name: "default browser", status: "warn", detail: advice });
  } catch {
    // Detection is best-effort; its absence is not a finding.
  }
  if (!browserPinned) {
    checks.push({
      name: "browser profile",
      status: "warn",
      detail: "Not pinned. Chart drawing needs a browser recorded by `stockbit-auth login`.",
    });
  }

  checks.push({
    name: "market-data session",
    status: auth.main.stored && !auth.main.expired ? "ok" : "fail",
    detail: auth.main.stored
      ? auth.main.expired
        ? "Stored, but its expiry has passed."
        : "Stored."
      : "Not stored. Nothing can be read until you log in.",
  });

  if (options.profileError) {
    checks.push({
      name: "tool profile",
      status: "fail",
      detail:
        `STOCKBIT_TOOLS cannot be parsed, so the server will not start: ${options.profileError} ` +
        "Nothing else in this report describes a running server.",
    });
  }

  // The trap the default profile creates, and the reason it is worth a check of its own.
  //
  // `core` deliberately contains no order-entry tools. So a user who went to the trouble of running
  // `trading-enable --live` at their own terminal — a deliberate, two-step, opt-in act — finds no
  // order tool in the server and NOTHING anywhere saying why. Trading reports "on", the tools are
  // simply absent, and the natural conclusion is that order entry is broken.
  // By NAME, and with two different lists on purpose.
  //
  // `ORDER_ENTRY_CORE` is what "place an order" means, and is what TRIGGERS the warning — amend
  // without preview and buy is not a coherent thing to warn about separately, and a profile that
  // registers all four correctly produces no warning. But the sentence "it has no order-entry tools
  // AT ALL" has to be measured against every order-entry tool including `order_amend`, or the
  // report asserts something false about a registered, destructive write that changes a live order
  // on the exchange.
  //
  // `eipo_order` is one of those tools and was missing from this list. It is a `destructiveHint`
  // write that commits real money out of the RDN, it is gated on the same `policy.enabled`, and
  // `instructions.ts` counts it as order entry — so under `STOCKBIT_TOOLS=eipo` this report said
  // "no order-entry tools at all" on the same server whose instructions page said "PLACING AN ORDER
  // IS TWO STEPS, ALWAYS: eipo_order_preview…". Whichever of the two the user believed, one of them
  // was lying to them about a live money write.
  const missing = new Set(options.missingTools ?? []);
  const ORDER_ENTRY_CORE = ["order_preview", "order_buy", "order_sell", "order_cancel"];
  const ORDER_ENTRY_ALL = [
    ...ORDER_ENTRY_CORE,
    "order_amend",
    "eipo_order_preview",
    "eipo_order",
  ];
  const absentOrderTools = ORDER_ENTRY_CORE.filter((name) => missing.has(name));
  const noOrderToolsAtAll = ORDER_ENTRY_ALL.every((name) => missing.has(name));
  const tradingToolsMissing = trading.enabled && absentOrderTools.length > 0;
  if (tradingToolsMissing) {
    const label = options.profileLabel ?? DEFAULT_TOOL_PROFILE;
    checks.push({
      name: "trading tools",
      status: "warn",
      detail:
        `Trading is ${trading.mode}, but this server did not register ${absentOrderTools.join(", ")}` +
        `${noOrderToolsAtAll ? " — it has no order-entry tools at all" : ""}. ` +
        `The \`${label}\` profile does not include them` +
        `${options.profileIsDefault ? ", and it is the default" : ""}. Set ` +
        `STOCKBIT_TOOLS=${label},trading and restart the client.`,
    });
  }

  if (options.live) {
    try {
      // `forceRefresh`, NOT `ensureFresh`. `ensureFresh` consults the shared access cache before it
      // ever reaches the wire, so on a warm cache this check made ZERO requests and still reported
      // "the stored token refreshed against Stockbit" — for a token that may have been revoked an
      // hour earlier. That is the precise failure this whole release was written to remove, and it
      // would have been reported as a proof. `forceRefresh` drops the in-memory copy, clears the
      // cache and refuses the next cache hit, so the request the description promises is the
      // request that happens.
      await forceRefresh("main");
      checks.push({ name: "live check", status: "ok", detail: "The stored token refreshed against Stockbit." });
    } catch (err) {
      checks.push({
        name: "live check",
        status: "fail",
        detail:
          `The stored token did not refresh: ${err instanceof Error ? err.message : String(err)}. ` +
          "An expiry in the payload does not mean a token still works — log in again.",
      });
    }
  } else {
    checks.push({
      name: "live check",
      status: "warn",
      detail:
        "Not run, and it is not free: proving the token means refreshing it, which ROTATES the " +
        "token family and ends the website session the chart tools run on. The `health` on each " +
        "session above answers the same question from what actually happened last time, for nothing.",
    });
  }

  let dir = "(unknown)";
  try {
    dir = stockbitDir();
  } catch {
    /* keep the placeholder */
  }

  return {
    server: {
      name: "stockbit",
      version: VERSION,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      // `all`, because no label means no profile was applied and nothing was filtered. Callers that
      // know better say so: the `status` tool passes the server's real label, and the CLI passes what
      // its own environment would produce. Defaulting to `core` here made `createServer()` with no
      // options report `toolProfile: "core"` beside `toolCount: 138`, which is self-refuting.
      toolProfile: options.profileError ? "unparsable" : (options.profileLabel ?? "all"),
      ...(options.toolCount === undefined ? {} : { toolCount: options.toolCount }),
    },
    auth,
    login: loginStatus(),
    trading,
    market: sessionClock(options.now),
    webSession: web,
    store: {
      dir,
      backend: auth.main.backend,
      browserPinned,
      loggedInAt,
      loginAgeHours,
      defaultBrowser,
      defaultBrowserIsPinned,
    },
    checks,
    nextStep: nextStepFor(auth, trading, {
      tradingToolsMissing,
      profileLabel: options.profileLabel ?? DEFAULT_TOOL_PROFILE,
      ...(options.profileError === undefined ? {} : { profileError: options.profileError }),
    }),
  };
}

/**
 * How old the login is, in words a person can act on.
 *
 * Users ask "how old is my login?" and the answer used to be nowhere. Three different clocks were on
 * screen — the web session's capture time, the access token's 24h expiry, the refresh token's ~7d
 * deadline — and none of them is the login. This one is: `loggedInAt` is written once, by the login.
 */
function describeLoginAge(store: StatusReport["store"]): string {
  if (store.loggedInAt === null || store.loginAgeHours === null) {
    return store.browserPinned
      ? "unknown — this profile predates login-time recording; the next `stockbit-auth login` will set it"
      : "never — run `stockbit-auth login`";
  }
  const h = store.loginAgeHours;
  const age =
    h < 1
      ? `${Math.round(h * 60)} minute(s) ago`
      : h < 48
        ? `${h.toFixed(1)} hour(s) ago`
        : `${(h / 24).toFixed(1)} day(s) ago`;
  // The age is not a countdown. A login stays good as long as its refresh token keeps being rotated
  // forward, which regular use does — so the website-session line above is the deadline, not this.
  return `${age}  (${store.loggedInAt})`;
}

/** The pinned browser, and whether it is the one the OS would have opened. */
function describeBrowserPin(store: StatusReport["store"]): string {
  if (!store.browserPinned) return "not pinned";
  if (store.defaultBrowserIsPinned === false && store.defaultBrowser) {
    // Not an error. The pin is authoritative because a Chromium profile is not portable between
    // browsers, so this says what IS rather than demanding a change.
    return `${store.browserPinned} — your default is ${store.defaultBrowser}; log in again to move the chart there`;
  }
  return store.browserPinned + (store.defaultBrowserIsPinned ? " (your default browser)" : "");
}

/**
 * One line describing the website session, from the verdict rather than from the clock.
 *
 * This line used to be computed independently of the structured report, against a 24-hour constant.
 * Once `webSessionHealth` started judging the refresh token, the two disagreed: the report would say
 * a session was good for six more days while this printed `AGED OUT — a fresh login is needed`, and
 * past 24 hours it printed a NEGATIVE hours-remaining. The verdict already carries the reason it
 * reached it; this line's only job is to say it out loud.
 *
 * Age is still shown because it is useful context, but it is never the basis for the verdict.
 */
/**
 * Is this process running the code that is currently on disk?
 *
 * A long-lived server loads its modules once. Rebuild underneath it and it keeps serving the old
 * ones, indefinitely and without a hint — and a stale server is not merely out of date here, it is
 * actively harmful: one that predates the session fixes still rotates the token family without
 * carrying the rotation to the browser, so it logs the chart out while a freshly built copy of the
 * same code, tested from a terminal, passes every check.
 *
 * That produced a wrong diagnosis twice in one day. Comparing this module's mtime against the
 * process start time costs one `stat` and turns an invisible failure into a line of output.
 */
function runningCodeCheck(): StatusCheck {
  try {
    const builtAtMs = statSync(fileURLToPath(import.meta.url)).mtimeMs;
    const startedAtMs = Date.now() - process.uptime() * 1000;
    if (builtAtMs > startedAtMs) {
      const behindMin = (builtAtMs - startedAtMs) / 60_000;
      return {
        name: "running code",
        status: "warn",
        detail:
          `This server started ${behindMin.toFixed(0)} minute(s) before the code on disk was built, so it is ` +
          "running the OLDER build. Restart it before trusting anything above — a stale server can rotate " +
          "the session out from under the browser even when the code on disk no longer would.",
      };
    }
    return { name: "running code", status: "ok", detail: "This process is running the build that is on disk." };
  } catch {
    // Bundled, packed, or a read-only mount: unknowable, and not worth a scary warning.
    return { name: "running code", status: "warn", detail: "Could not tell whether this build is current." };
  }
}

function describeWebSession(web: WebSessionHealth): string {
  if (!web.present) return "not stored — chart drawing needs a login";

  const age = web.ageHours === null ? "age unknown" : `captured ${web.ageHours.toFixed(1)}h ago`;

  if (web.basis === "unknown") {
    // Unknown is not dead. Demanding a login here is the same pessimism that cost a daily one.
    return `stored, ${age} — validity unreadable, the chart will settle it`;
  }
  if (web.expired) {
    return `EXPIRED — its refresh token lapsed${
      web.refreshExpiresAt ? ` at ${web.refreshExpiresAt}` : ""
    }; run \`stockbit-auth login\``;
  }

  const left =
    web.refreshHoursLeft === null
      ? ""
      : web.refreshHoursLeft > 48
        ? `, ~${(web.refreshHoursLeft / 24).toFixed(1)}d left`
        : `, ~${web.refreshHoursLeft.toFixed(1)}h left`;
  // A lapsed access token is the normal overnight state and says nothing about the session, so it
  // is reported as a note rather than folded into the verdict.
  const access =
    web.accessHoursLeft !== null && web.accessHoursLeft < 0
      ? " (access token lapsed; renews on next page load)"
      : "";
  return `stored, ${age}${left}${access}`;
}

/** A few lines for a terminal, from the same report the tool returns. */
export function formatStatus(report: StatusReport): string {
  const slot = (name: string, s: SlotStatus): string => {
    if (s.unreadable) return `${name.padEnd(16)} UNREADABLE${s.hint ? ` — ${s.hint}` : ""}`;
    if (!s.stored) return `${name.padEnd(16)} not set${s.hint ? ` — ${s.hint}` : ""}`;
    const expiry =
      s.expiresInDays === undefined
        ? "no exp in payload"
        : s.expired
          ? `EXPIRED ${Math.abs(s.expiresInDays)} day(s) ago`
          : `expires in ~${s.expiresInDays} day(s)`;
    // `health` is rendered whenever it says something an expiry cannot, and stays silent when it
    // says nothing. `unknown` is the ordinary state before this credential has ever been used, and
    // printing "unknown" beside a healthy-looking line reads as a fault rather than as an absence.
    const when = s.lastRefresh ? ` at ${formatTime(s.lastRefresh.at)}` : "";
    const health =
      s.health === "failing"
        ? `, REJECTED by Stockbit${when}`
        : s.health === "ok"
          ? `, last refresh OK${when}`
          : "";
    return `${name.padEnd(16)} stored (${s.backend}), ${expiry}${health}`;
  };

  const lines = [
    `stockbit-mcp ${report.server.version} on Node ${report.server.node} (${report.server.platform})`,
    `Store            ${report.store.dir} (${report.store.backend})`,
    `Browser profile  ${describeBrowserPin(report.store)}`,
    `Last login       ${describeLoginAge(report.store)}`,
    `Website session  ${describeWebSession(report.webSession)}`,
    slot("Market data", report.auth.main),
    slot("Trading", report.auth.securities),
    slot("e-IPO", report.auth.eipo),
    `Order placing    ${report.trading.mode.toUpperCase()} — ${report.trading.reason}`,
    `Market           ${report.market.nowWib} WIB (${report.market.weekday}), ${report.market.phase}` +
      (report.market.nextOpenWib ? `; next open ${report.market.nextOpenWib}` : ""),
  ];
  if (report.login.inProgress) lines.push(`Login            in progress since ${report.login.startedAt}`);
  else if (report.login.lastResult) lines.push(`Login            last result: ${report.login.lastResult}`);

  for (const check of report.checks) {
    if (check.status === "ok") continue;
    lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
  }
  lines.push("", `Next: ${report.nextStep}`);
  return lines.join("\n");
}
