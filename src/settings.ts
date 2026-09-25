/**
 * Local paper-simulation settings. Real-money execution is not supported.
 * ADR-0012 supersedes the former live-trading policy: stale live/enabled settings
 * and all environment values fail closed. Only terminal-written paper mode enables
 * the local ledger. Account reads remain available independently of this setting.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stockbitDir } from "./paths.js";

export type TradingMode = "off" | "paper";

export interface PaperSettings {
  /** What `paper-reset` starts a fresh ledger with. */
  startingCashIdr: number;
}

/** Paper-order consent: require a human dialog, use it when available, or require caller confirmation. */
export type ElicitationPolicy = "required" | "when-available" | "never";

export interface TradingSettings {
  /** Master switch. `off` unless the account owner chose otherwise at a terminal. */
  mode: TradingMode;
  /** Retained for settings compatibility, always false. */
  autoConfirm: boolean;
  /** Ceiling on one order's gross value, in IDR. `null` means no cap. */
  maxOrderValueIdr: number | null;
  /** When non-empty, only these symbols may be traded. */
  allowedSymbols: string[];
  /** Ceiling on lots in one order, whatever the value. */
  maxLotsPerOrder: number;
  /** Whether a person must be asked directly, may be asked, or is never asked. */
  elicitation: ElicitationPolicy;
  /**
   * When the account owner last said "forget every standing confirmation", as an ISO timestamp.
   *
   * The only way a terminal can reach into a server process that is already running: the CLI writes
   * a moment into this file, every order re-reads the policy, and an in-memory "don't ask again"
   * granted before that moment stops covering anything. `null` means it has never been used.
   */
  confirmationsRevokedAt: string | null;
  paper: PaperSettings;
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

/** Version 3 permanently removes the live mode. */
const SETTINGS_VERSION = 3;

/** A paper ledger's opening balance when nobody says otherwise: Rp 100 million. */
export const DEFAULT_PAPER_CASH_IDR = 100_000_000;

/** The safe state: everything that can move money is off. Also what a corrupt file falls back to. */
export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    trading: {
      mode: "off",
      autoConfirm: false,
      maxOrderValueIdr: null,
      allowedSymbols: [],
      maxLotsPerOrder: 50_000,
      // Ask whenever a person can be reached, and do not brick a client that cannot be asked. Not
      // `required`, because that would break every existing install on the day it shipped; not
      // `never`, because the whole point is that the ask happens.
      elicitation: "when-available",
      confirmationsRevokedAt: null,
      paper: { startingCashIdr: DEFAULT_PAPER_CASH_IDR },
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

/** Old live permissions are revoked, never silently converted to a simulation. */
function readMode(trading: { mode?: unknown; enabled?: unknown }): TradingMode {
  return trading.mode === "paper" ? "paper" : "off";
}

/**
 * Read the elicitation switch, whitelisted the way the mode is.
 *
 * Anything unrecognised — a typo, a boolean, an absent field on a file written before this existed
 * — is the DEFAULT rather than the strictest or the loosest value. That is the deliberate
 * difference from `readMode`, whose fallback is `off` because an unreadable *permission* is no
 * permission. This is not a permission: `never` would silently weaken an account and `required`
 * would silently brick one, so an unreadable value means the same thing it means when the field is
 * missing entirely.
 */
function readElicitation(value: unknown): ElicitationPolicy {
  if (value === "required" || value === "when-available" || value === "never") return value;
  return "when-available";
}

/**
 * The revocation moment: any non-empty string, or null.
 *
 * Deliberately NOT "a parseable timestamp, or null". This field is a *revocation*, not a
 * permission, so the two failure directions are not symmetric: reading a bad value as "never
 * revoked" silently keeps a standing confirmation alive, while reading it as "revoked" only means
 * the user is asked again. A non-empty string that is not a date is somebody having written
 * something here, and `rememberCovers` treats an unparseable moment as revoking everything — which
 * is why the string is passed through rather than dropped on the way past.
 *
 * Only the CLI ever writes this, and it writes `new Date().toISOString()`, so an unparseable value
 * means a hand-edited file. `trading-status` prints it back, so a typo is visible rather than
 * merely inert.
 */
function coerceRevokedAt(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
      version: SETTINGS_VERSION,
      trading: {
        mode: readMode(trading),
        autoConfirm: false,
        maxOrderValueIdr: coerceNumberOrNull(trading.maxOrderValueIdr),
        allowedSymbols: Array.isArray(trading.allowedSymbols)
          ? trading.allowedSymbols.filter((s): s is string => typeof s === "string").map((s) => s.toUpperCase())
          : [],
        maxLotsPerOrder:
          typeof trading.maxLotsPerOrder === "number" && trading.maxLotsPerOrder > 0
            ? Math.floor(trading.maxLotsPerOrder)
            : base.trading.maxLotsPerOrder,
        elicitation: readElicitation(trading.elicitation),
        confirmationsRevokedAt: coerceRevokedAt(trading.confirmationsRevokedAt),
        paper: {
          startingCashIdr:
            coerceNumberOrNull((trading.paper as Partial<PaperSettings> | undefined)?.startingCashIdr) ??
            base.trading.paper.startingCashIdr,
        },
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
  /** Local paper simulation is either off or enabled. */
  mode: TradingMode;
  /** Always false: real-money execution is absent from this server. */
  live: false;
  /** `mode !== "off"`. Kept so every existing gate reads the same, whichever mode it is in. */
  enabled: boolean;
  /** The paper ledger's opening balance. */
  paper: PaperSettings;
  /** Always false: configuration cannot automatically confirm an order. */
  autoConfirm: false;
  maxOrderValueIdr: number | null;
  allowedSymbols: string[];
  maxLotsPerOrder: number;
  /**
   * Whether a person must be asked, may be asked, or is never asked. ADR-0010.
   *
   * Applies only to local paper simulation. Real-money execution is unavailable.
   */
  elicitation: ElicitationPolicy;
  /**
   * When the owner last revoked every standing "don't ask again". ISO, or null.
   *
   * A non-empty string that is not a parseable moment is carried through rather than dropped, and
   * revokes everything — see `coerceRevokedAt`. A revocation read wrongly must fail towards asking.
   */
  confirmationsRevokedAt: string | null;
  /** Where the decision came from, so a refusal can be acted on. */
  source: "env-off" | "env-paper" | "settings" | "default-off";
  /** Plain-language reason, always present. Relayed verbatim by the tools. */
  reason: string;
  /** Set when the settings file existed but could not be read. */
  corrupt?: true;
  settingsPath: string;
}

/** Read at call time. Environment variables can disable paper trading, never enable it. */
export function tradingPolicy(env: NodeJS.ProcessEnv = process.env): TradingPolicy {
  const settings = loadSettings();
  const corrupt = settingsWereCorrupt();
  const t = settings.trading;
  const path = settingsPath();
  const envValue = (env.STOCKBIT_TRADING ?? "").trim().toLowerCase();
  const envOff = ["off", "0", "false", "no"].includes(envValue);
  const mode = envOff || corrupt ? "off" : t.mode;
  return {
    mode,
    live: false,
    enabled: mode === "paper",
    paper: t.paper,
    autoConfirm: false,
    maxOrderValueIdr: t.maxOrderValueIdr,
    allowedSymbols: t.allowedSymbols,
    maxLotsPerOrder: t.maxLotsPerOrder,
    elicitation: t.elicitation,
    confirmationsRevokedAt: t.confirmationsRevokedAt,
    source: envOff ? "env-off" : corrupt ? "default-off" : "settings",
    settingsPath: path,
    ...(corrupt ? { corrupt: true as const } : {}),
    reason: mode === "paper"
      ? "PAPER trading is enabled. Orders are recorded only in the local ledger; no real money moves. Real-money execution is unavailable."
      : (corrupt ? `Paper trading is off because ${path} could not be read. ` : envOff
        ? "Paper trading is off because STOCKBIT_TRADING is set to off in the environment. " : "Paper trading is off. ") +
        "Use `stockbit-auth trading-enable --paper` to enable the local simulation. Real-money execution is permanently unavailable.",
  };
}
