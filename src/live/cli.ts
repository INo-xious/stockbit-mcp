/**
 * What `stockbit-live` accepts — every command, every flag, one table.
 *
 * Same defect class as the 2026-08-29 `stockbit-auth login --help` incident, milder consequences:
 * this bin's `positionals()` skipped every `--` token, so `stockbit-live --help` fell through to the
 * DEFAULT command and ran a scan, and a typo like `--tpo 5` didn't just lose the flag — `5` became a
 * stray positional. A measuring tool that answers a typo with a measurement is answering a question
 * nobody asked (the same reasoning as `MAX_SCAN_MS` in the bin: refuse, don't reinterpret).
 *
 * `bin/stockbit-live.ts` gates every invocation through this table before dispatch. A bad token is
 * reported through the bin's existing JSON contract (`ok:false, reason:"bad-arguments"`, exit 1) so
 * machine callers — the /watch skill among them — keep the failure shape they already parse.
 * Requested help is the one human-facing exception: plain usage text on stdout, exit 0.
 *
 * `--pretty` is on every command because `emit()` honors it even for failures; whether a REQUIRED
 * positional is missing stays each handler's call (their "Name a symbol." messages already say it
 * better than a generic gate could).
 */
import type { CommandTable } from "../cliargs.js";

export const LIVE_BIN = "stockbit-live";

export const LIVE_COMMANDS: CommandTable = {
  scan: {
    summary: "two readings one window apart, what traded in between, ranked by rupiah",
    usage: "<BBCA,ANTM|watchlist[:Name]|all> <30s|5m|realtime>",
    flags: {
      "--always": "measure even outside IDX hours",
      "--pretty": "indented JSON, for reading by eye",
    },
    valueFlags: {
      "--top": { placeholder: "N", help: "cap the rows printed (default 10)" },
    },
    positionals: [
      { name: "scope", required: true },
      { name: "time-frame", required: true },
    ],
  },
  signals: {
    summary: "one full detection pass: baseline reading, wait, detect (value surge + order-book signals)",
    usage: "<BBCA,ANTM|watchlist|all> <30s|5m> [prompt]",
    flags: {
      "--always": "run even outside IDX hours",
      "--pretty": "indented JSON, for reading by eye",
    },
    positionals: [
      { name: "scope", required: true },
      { name: "time-frame", required: true },
    ],
    variadicTail: true, // Everything after the time frame is the free-text prompt.
  },
  explain: {
    summary: "name the prints behind a move, from the (8-10 minutes late) tape",
    usage: "<SYMBOL> [HH:MM:SS] [HH:MM:SS]",
    flags: {
      "--pretty": "indented JSON, for reading by eye",
    },
    positionals: [
      { name: "SYMBOL", required: true },
      { name: "from", required: false },
      { name: "to", required: false },
    ],
  },
  brokers: {
    summary: "end-of-day broker context for one symbol — context, never an alert",
    usage: "<SYMBOL>",
    flags: {
      "--pretty": "indented JSON, for reading by eye",
    },
    positionals: [{ name: "SYMBOL", required: true }],
  },
};

/** Top-level usage footer. The default matters: it is how `--help` alone used to become a scan. */
export const LIVE_EPILOGUE: readonly string[] = [
  "With no command, `scan` runs. Output is JSON on stdout; progress and errors never pollute it.",
];
