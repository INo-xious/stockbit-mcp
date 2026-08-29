/**
 * What `stockbit-alerts` accepts — every command, every flag, one table.
 *
 * Same defect class as the 2026-08-29 `stockbit-auth login --help` incident, with this bin's own
 * worst case: `stockbit-alerts watch --help` didn't print anything — it STARTED the long-lived
 * daemon, because unknown flags were invisible to `argv.includes()`. A process meant to run for
 * weeks is exactly the wrong thing to start by accident.
 *
 * `bin/stockbit-alerts.ts` gates every invocation through this table before dispatch, keeping its
 * own conventions: errors go to `console.error` and set `process.exitCode = 2` (never
 * `process.exit` — the daemon relies on natural exits), requested help prints to stdout and exits 0.
 *
 * The delivery flags are accepted on all three commands because the bin builds ONE options object
 * before dispatch and always has; `check --no-telegram` and `test --dry-run` are meaningful, and the
 * rest stay accepted-and-inert rather than becoming errors retroactively (the `status --offline`
 * principle: tightening must not break invocations that were documented as fine). `--interval` is
 * the exception — only `watch` reads it, and a `check --interval 30` almost certainly meant `watch`.
 *
 * Telegram is configured by environment only (STOCKBIT_TELEGRAM_BOT_TOKEN, STOCKBIT_TELEGRAM_CHAT_ID)
 * — deliberately not flags; a bot token on a command line is visible to every user through `ps`.
 */
import type { CommandTable } from "../cliargs.js";

export const ALERTS_BIN = "stockbit-alerts";

/** The delivery options every command shares, because the bin resolves them before dispatch. */
const DELIVERY_FLAGS = {
  "--always": "ignore market hours",
  "--dry-run": "evaluate without firing or delivering",
  "--no-desktop": "skip desktop notifications",
  "--no-telegram": "skip Telegram even when the environment configures it",
} as const;

const DELIVERY_VALUE_FLAGS = {
  "--symbol": { placeholder: "BBRI", help: "only evaluate rules for this symbol" },
  "--webhook": { placeholder: "URL", help: "POST fired alerts to this URL (or set STOCKBIT_ALERT_WEBHOOK)" },
} as const;

export const ALERTS_COMMANDS: CommandTable = {
  watch: {
    summary: "poll during IDX hours until stopped — the daemon",
    flags: DELIVERY_FLAGS,
    valueFlags: {
      "--interval": { placeholder: "N", help: "seconds between passes (default 60)" },
      ...DELIVERY_VALUE_FLAGS,
    },
  },
  check: {
    summary: "one pass, then exit",
    flags: DELIVERY_FLAGS,
    valueFlags: DELIVERY_VALUE_FLAGS,
  },
  test: {
    summary: "send a sample notification through every channel",
    flags: DELIVERY_FLAGS,
    valueFlags: DELIVERY_VALUE_FLAGS,
  },
};

/** Top-level usage footer: the default command, and the one thing flags can never configure. */
export const ALERTS_EPILOGUE: readonly string[] = [
  "With no command, `watch` runs.",
  "Telegram is environment-only: STOCKBIT_TELEGRAM_BOT_TOKEN and STOCKBIT_TELEGRAM_CHAT_ID.",
];
