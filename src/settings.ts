/**
 * `~/.stockbit/settings.json` — the file that decides whether this server may place an order at all.
 *
 * ## Two switches, and why neither is enough alone
 *
 * `trading.enabled` is the master. Off by default, and turning it on is a deliberate act at a
 * terminal (`stockbit-auth trading-enable`) rather than something a model can do. With it off,
 * every order tool still exists and still answers — with a refusal that names this file — because a
 * tool that vanishes when disabled teaches a caller that the feature is broken rather than off.
 *
 * `trading.autoConfirm` is the second, and it is the one that needed an argument. ADR-0003's rule
 * is that a per-call `confirm` is never satisfied by configuration: config gets set once and
 * forgotten, and the whole risk is a write nobody meant to make. `autoConfirm` is the account
 * owner's deliberate exception to that rule, and it is guard-railed rather than trusted — it is
 * honoured **only when `maxOrderValueIdr` is set**, so "I trust it for small orders" cannot silently
 * become "I trust it for any order". With no cap the policy reports itself as ignored and says why.
 *
 * ## Precedence
 *
 * `STOCKBIT_TRADING=off` (environment) > this file > default-off. The environment can only turn
 * trading **off**, never on: a variable is the easiest thing in a process tree to set by accident,
 * and an accident that disables trading is harmless while the reverse is not.
 *
 * Read at call time rather than cached at start-up, so `trading-disable` takes effect on the next
 * order rather than the next restart.
 *
 * ## Who writes it
 *
 * `stockbit-auth trading-enable/disable/logout`, or the user by hand. Nothing under `src/tools/` or
 * `src/trading/` imports `saveSettings`, and `test/settings.test.ts` asserts that — a server that
 * can widen its own permissions has no permissions.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stockbitDir } from "./paths.js";

export interface TradingSettings {
  /** Master switch. Off unless the account owner turned it on at a terminal. */
  enabled: boolean;
  /** Skip the per-order confirmation. Honoured ONLY when `maxOrderValueIdr` is set. */
  autoConfirm: boolean;
  /** Ceiling on one order's gross value, in IDR. `null` means no cap — and no autoConfirm. */
  maxOrderValueIdr: number | null;
  /** When non-empty, only these symbols may be traded. */
  allowedSymbols: string[];
  /** Ceiling on lots in one order, whatever the value. */
  maxLotsPerOrder: number;
}

export interface ChartbitSettings {
  /** Drive the chart in a headless window. Off: Cloudflare blanks headless Chrome on stockbit.com. */
  headless: boolean;
  /** Leave the driven browser running between calls, so Claude Code and Desktop can share one. */
  keepBrowserOpen: boolean;
}

export interface Settings {
  version: number;
  trading: TradingSettings;
  chartbit: ChartbitSettings;
}

export const SETTINGS_VERSION = 1;

/** The safe state: everything that can move money is off. Also what a corrupt file falls back to. */
export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    trading: {
      enabled: false,
      autoConfirm: false,
      maxOrderValueIdr: null,
      allowedSymbols: [],
      maxLotsPerOrder: 50_000,
    },
    chartbit: { headless: false, keepBrowserOpen: true },
  };
}

export function settingsPath(): string {
  return join(stockbitDir(), "settings.json");
}

/** True when a file exists but could not be understood — surfaced rather than silently defaulted. */
let lastReadCorrupt = false;

function coerceNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read the settings file, falling back to the safe defaults.
 *
 * A malformed file is **default-off plus a flag**, never a throw and never a partial merge of
 * whatever parsed. Half-applying a corrupt trading block is how "enabled" survives while the cap
 * that bounded it does not.
 */
export function loadSettings(): Settings {
  lastReadCorrupt = false;
  let raw: string;
  try {
    raw = readFileSync(settingsPath(), "utf8");
  } catch {
    return defaultSettings(); // no file is not corruption; it is the default state
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const base = defaultSettings();
    const trading = (parsed.trading ?? {}) as Partial<TradingSettings>;
    const chartbit = (parsed.chartbit ?? {}) as Partial<ChartbitSettings>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : SETTINGS_VERSION,
      trading: {
        enabled: trading.enabled === true,
        autoConfirm: trading.autoConfirm === true,
        maxOrderValueIdr: coerceNumberOrNull(trading.maxOrderValueIdr),
        allowedSymbols: Array.isArray(trading.allowedSymbols)
          ? trading.allowedSymbols.filter((s): s is string => typeof s === "string").map((s) => s.toUpperCase())
          : [],
        maxLotsPerOrder:
          typeof trading.maxLotsPerOrder === "number" && trading.maxLotsPerOrder > 0
            ? Math.floor(trading.maxLotsPerOrder)
            : base.trading.maxLotsPerOrder,
      },
      chartbit: {
        headless: chartbit.headless === true,
        keepBrowserOpen: chartbit.keepBrowserOpen !== false,
      },
    };
  } catch {
    lastReadCorrupt = true;
    return defaultSettings();
  }
}

/** Whether the last `loadSettings` fell back because the file could not be parsed. */
export function settingsWereCorrupt(): boolean {
  return lastReadCorrupt;
}

/**
 * Write the settings file atomically.
 *
 * Atomic for the same reason the credential store is: an interrupted truncating write leaves a file
 * that `loadSettings` reads as corrupt, and the fallback for corrupt is default-off — which would
 * silently disable trading rather than merely losing an edit.
 */
export function saveSettings(settings: Settings): void {
  mkdirSync(stockbitDir(), { recursive: true, mode: 0o700 });
  const target = settingsPath();
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/* ----------------------------------- the policy ----------------------------------- */

export interface TradingPolicy {
  /** Whether an order may be placed at all. */
  enabled: boolean;
  /** Whether a per-order `confirm` may be satisfied by configuration instead of by the caller. */
  autoConfirm: boolean;
  maxOrderValueIdr: number | null;
  allowedSymbols: string[];
  maxLotsPerOrder: number;
  /** Where the decision came from, so a refusal can be acted on. */
  source: "env-off" | "settings" | "default-off";
  /** Plain-language reason, always present. Relayed verbatim by the tools. */
  reason: string;
  /** Set when the settings file existed but could not be read. */
  corrupt?: true;
  /** Set when `autoConfirm` was requested but is not being honoured, and why. */
  autoConfirmIgnored?: string;
  settingsPath: string;
}

/**
 * The trading policy in force right now.
 *
 * Read at call time. Precedence is `STOCKBIT_TRADING=off` > file > default-off, and the environment
 * is one-directional: any value other than a recognised "off" is ignored entirely rather than
 * treated as an enable.
 */
export function tradingPolicy(env: NodeJS.ProcessEnv = process.env): TradingPolicy {
  const settings = loadSettings();
  const corrupt = settingsWereCorrupt();
  const path = settingsPath();
  const t = settings.trading;

  const envValue = (env.STOCKBIT_TRADING ?? "").trim().toLowerCase();
  const envOff = envValue === "off" || envValue === "0" || envValue === "false" || envValue === "no";

  if (envOff) {
    return {
      enabled: false,
      autoConfirm: false,
      maxOrderValueIdr: t.maxOrderValueIdr,
      allowedSymbols: t.allowedSymbols,
      maxLotsPerOrder: t.maxLotsPerOrder,
      source: "env-off",
      reason:
        "Trading is off because STOCKBIT_TRADING is set to off in this process's environment. " +
        "The environment can only turn trading off; unset it and use `stockbit-auth trading-enable` to turn it on.",
      ...(corrupt ? { corrupt: true as const } : {}),
      settingsPath: path,
    };
  }

  if (!t.enabled) {
    return {
      enabled: false,
      autoConfirm: false,
      maxOrderValueIdr: t.maxOrderValueIdr,
      allowedSymbols: t.allowedSymbols,
      maxLotsPerOrder: t.maxLotsPerOrder,
      source: corrupt ? "default-off" : "settings",
      reason: corrupt
        ? `Trading is off: ${path} could not be read, and an unreadable policy file is treated as no permission. ` +
          "Fix or delete the file, then run `stockbit-auth trading-enable`."
        : `Trading is off. Turn it on with \`stockbit-auth trading-enable\` (writes ${path}).`,
      ...(corrupt ? { corrupt: true as const } : {}),
      settingsPath: path,
    };
  }

  // autoConfirm is honoured only with a value cap. "I trust it for small orders" must not silently
  // become "I trust it for any order" the day the cap is removed.
  const capMissing = t.autoConfirm && t.maxOrderValueIdr === null;
  return {
    enabled: true,
    autoConfirm: t.autoConfirm && !capMissing,
    maxOrderValueIdr: t.maxOrderValueIdr,
    allowedSymbols: t.allowedSymbols,
    maxLotsPerOrder: t.maxLotsPerOrder,
    source: "settings",
    reason: "Trading is enabled in " + path + ".",
    ...(capMissing
      ? {
          autoConfirmIgnored:
            "autoConfirm is set but is NOT in effect: it is honoured only when maxOrderValueIdr is also set. " +
            "Every order still needs confirm: true. Set a cap with `stockbit-auth trading-enable --max-order-value N`.",
        }
      : {}),
    settingsPath: path,
  };
}
