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
import { getStore, type StoreSlot, type StoreState } from "./auth/store.js";
import { DEFAULT_TOOL_PROFILE } from "./tools/_profile.js";
import {
  lastEventFor,
  readHealthJournal,
  slotHealthState,
  type SlotHealthState,
} from "./auth/health.js";
import { WEB_SESSION_LIFETIME_HOURS, webSessionHealth, type WebSessionHealth } from "./auth/websession.js";
import { decodeJwt, ensureFresh } from "./auth/session.js";
import { readBrowserProfile } from "./auth/browserprofile.js";
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
   * output said those were different things. Age-based and side-effect free; see `webSessionHealth`.
   */
  webSession: WebSessionHealth;
  store: {
    dir: string;
    backend: "keychain" | "file" | "unknown";
    browserPinned: string | null;
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
  /** Families this profile kept out entirely, so `status` can explain a missing tool. */
  missingFamilies?: string[];
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
  surface: { tradingToolsMissing: boolean; profileLabel: string } = {
    tradingToolsMissing: false,
    profileLabel: DEFAULT_TOOL_PROFILE,
  },
): string {
  // Before anything else: if the store would not answer, every branch below is reasoning from a
  // fact nobody established. "Log in again" is the one piece of advice that must not be given here.
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
      `Trading is ${trading.mode}, but this server registered no order tools — the ` +
      `\`${surface.profileLabel}\` tool profile does not include the \`trading\` family. Set ` +
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
  try {
    const pinned = readBrowserProfile();
    browserPinned = pinned ? `${pinned.browserName}${pinned.version ? ` ${pinned.version}` : ""}` : null;
  } catch {
    browserPinned = null;
  }
  if (web.present && !web.likelyValid) {
    // Distinct from the token slots on purpose: this is the credential Chartbit needs, and it can be
    // dead while every slot above is perfectly healthy. That combination is exactly what made the
    // failure so hard to read.
    checks.push({ name: "website session", status: "warn", detail: web.hint });
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

  // The trap the default profile creates, and the reason it is worth a check of its own.
  //
  // `core` deliberately contains no order-entry tools. So a user who went to the trouble of running
  // `trading-enable --live` at their own terminal — a deliberate, two-step, opt-in act — finds no
  // order tool in the server and NOTHING anywhere saying why. Trading reports "on", the tools are
  // simply absent, and the natural conclusion is that order entry is broken.
  const missingFamilies = new Set(options.missingFamilies ?? []);
  const tradingToolsMissing = trading.enabled && missingFamilies.has("trading");
  if (tradingToolsMissing) {
    const label = options.profileLabel ?? DEFAULT_TOOL_PROFILE;
    checks.push({
      name: "trading tools",
      status: "warn",
      detail:
        `Trading is ${trading.mode}, but the \`trading\` family is not registered, so this server ` +
        `has no order tools at all. The \`${label}\` profile does not include them` +
        `${options.profileIsDefault ? " and it is the default" : ""}. Set ` +
        `STOCKBIT_TOOLS=${label},trading and restart the client.`,
    });
  }

  if (options.live) {
    try {
      await ensureFresh("main");
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
      // `core`, not `all`: that is what a server started with no STOCKBIT_TOOLS registers. The CLI
      // reaches here without a server at all, so this is the honest answer to "what would run".
      toolProfile: options.profileLabel ?? DEFAULT_TOOL_PROFILE,
      ...(options.toolCount === undefined ? {} : { toolCount: options.toolCount }),
    },
    auth,
    login: loginStatus(),
    trading,
    market: sessionClock(options.now),
    webSession: web,
    store: { dir, backend: auth.main.backend, browserPinned },
    checks,
    nextStep: nextStepFor(auth, trading, { tradingToolsMissing, profileLabel: options.profileLabel ?? DEFAULT_TOOL_PROFILE }),
  };
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
    `Browser profile  ${report.store.browserPinned ?? "not pinned"}`,
    `Website session  ${
      !report.webSession.present
        ? "not stored — chart drawing needs a login"
        : report.webSession.ageHours === null
          ? "stored, age unknown — treat as needing a login"
          : `${report.webSession.likelyValid ? "stored" : "AGED OUT"}, ${report.webSession.ageHours.toFixed(1)}h old` +
            (report.webSession.likelyValid
              ? `, ~${(WEB_SESSION_LIFETIME_HOURS - report.webSession.ageHours).toFixed(1)}h left`
              : " — a fresh login is needed")
    }`,
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
