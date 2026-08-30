/**
 * What `stockbit-batch` accepts — every command, every flag, one table.
 *
 * Gated through `src/cliargs.ts` before any dispatch, for the reason that module documents: on
 * 2026-08-29 a `--help` that nobody validated ran the command it was asking about. This bin's worst
 * case is the same shape and considerably more expensive — `broker --help` starting an overnight
 * drip against an unofficial API on Darren's own session.
 *
 * Defaults are chosen so that the DANGEROUS thing requires a flag and the safe thing does not:
 * `plan` performs no requests at all, and every fetching command is off-hours-only unless `--force`
 * says otherwise.
 */
import type { CommandTable } from "../cliargs.js";

export const BATCH_BIN = "stockbit-batch";

/** Where the work list comes from and where its output goes — shared by every fetching command. */
const SELECTION_VALUE_FLAGS = {
  "--symbols": { placeholder: "A,B,C", help: "explicit tickers (comma-separated)" },
  "--symbols-file": { placeholder: "PATH", help: "one ticker per line; blank lines and # comments ignored" },
  "--from": { placeholder: "YYYY-MM-DD", help: "earliest session, inclusive" },
  "--to": { placeholder: "YYYY-MM-DD", help: "latest session, inclusive" },
} as const;

const OUTPUT_VALUE_FLAGS = {
  "--out": { placeholder: "DIR", help: "raw-response zone (default ./raw)" },
  "--checkpoint": { placeholder: "PATH", help: "completed-key log; resume reads it (default <out>/checkpoint.ndjson)" },
} as const;

const PACING_VALUE_FLAGS = {
  "--rate-ms": { placeholder: "N", help: "base delay between requests (default 1750)" },
  "--jitter-ms": { placeholder: "N", help: "extra uniform delay 0..N (default 500)" },
  "--max-requests": { placeholder: "N", help: "stop after N requests — a night's ration" },
  "--kill-file": { placeholder: "PATH", help: "stop cleanly the moment this file exists" },
  "--order": { placeholder: "MODE", help: "recent-first (default), oldest-first, symbol-major" },
} as const;

const PACING_FLAGS = {
  "--force": "run even during IDX trading hours (see the warning in `plan --help`)",
} as const;

export const BATCH_COMMANDS: CommandTable = {
  plan: {
    summary: "show what WOULD be fetched, and how much is already done — makes no requests",
    valueFlags: { ...SELECTION_VALUE_FLAGS, ...OUTPUT_VALUE_FLAGS, "--kind": { placeholder: "bars|broker", help: "which backfill to plan" }, "--order": PACING_VALUE_FLAGS["--order"] },
    details: [
      "Always run this first. It is free, and it tells you the request count before you spend it.",
      "",
      "Why off-hours matters: this pulls through Darren's own Stockbit session, whose refresh token",
      "is single-use and rotates. Two processes refreshing at once invalidate each other and lock",
      "the account out until a manual browser login — measured, not theorised (2026-08-29).",
    ],
  },
  bars: {
    summary: "daily OHLCV + per-bar foreign flow for each symbol (one request-set per symbol)",
    flags: PACING_FLAGS,
    valueFlags: { ...SELECTION_VALUE_FLAGS, ...OUTPUT_VALUE_FLAGS, ...PACING_VALUE_FLAGS },
    details: [
      "Cheap relative to broker: getBars pages internally, ~10k requests for 239 symbols over 2y.",
      "Run this first — it delivers prices AND foreign flow, which is enough to train on while the",
      "broker drip is still going.",
    ],
  },
  broker: {
    summary: "broker-summary bandarmology, one request per (symbol, session) — the long drip",
    flags: PACING_FLAGS,
    valueFlags: { ...SELECTION_VALUE_FLAGS, ...OUTPUT_VALUE_FLAGS, ...PACING_VALUE_FLAGS },
    details: [
      "~120,000 requests for 239 symbols over 2 years, because broker_summary aggregates its whole",
      "window into one table — per-day bandar behaviour needs a per-day request.",
      "",
      "Resumable: every completed key is appended to the checkpoint, so re-running skips what is",
      "done. Order defaults to most-recent-first, so an interruption leaves every symbol covering",
      "the most recent sessions rather than a few symbols covering everything.",
    ],
  },
  probe: {
    summary: "a tiny live check (few symbols, few days) that also records test fixtures",
    valueFlags: { ...SELECTION_VALUE_FLAGS, "--out": OUTPUT_VALUE_FLAGS["--out"] },
    details: ["Proves auth, shapes and the window assertion against the live API before a long run."],
  },
  status: {
    summary: "how far a backfill has got, read from its checkpoint — makes no requests",
    valueFlags: { ...SELECTION_VALUE_FLAGS, ...OUTPUT_VALUE_FLAGS, "--kind": { placeholder: "bars|broker", help: "which backfill to report" } },
  },
};

export const BATCH_EPILOGUE: readonly string[] = [
  "No default command — `stockbit-batch` with no arguments prints this usage.",
  "Start with `plan`: it costs nothing and tells you what the run will cost.",
  "Fetching commands refuse to run during IDX trading hours unless --force is given.",
];
