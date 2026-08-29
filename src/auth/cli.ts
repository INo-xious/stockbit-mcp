/**
 * What `stockbit-auth` accepts — every subcommand, every flag, one table.
 *
 * This table exists because on 2026-08-29 `stockbit-auth login --help` opened a real browser login:
 * the bin read flags with `argv.includes()`, so `--help` matched nothing, and matching nothing meant
 * running anyway. For THIS bin that rule is at its most dangerous — `logout --help` would clear the
 * credential and delete the logged-in browser profile, `doctor --help` would launch a browser,
 * `paper-reset --help` would wipe the paper ledger. Asking what a command does must never do it.
 *
 * `bin/stockbit-auth.ts` gates every invocation through this table (`gateCommandLine`) before
 * dispatch, and generates its usage text from it (`formatUsage`), so validation and help cannot
 * drift apart. The help wording below is the bin's original usage block, kept verbatim where a line
 * existed; flags that block never documented (`login --verify`, `import-har --shred`,
 * `trading-enable --no-auto-confirm`) are written down here for the first time.
 *
 * `status --offline` stays an accepted no-op ON PURPOSE: offline is the default now, but
 * SECURITY.md tells vulnerability reporters to paste `stockbit-auth status --offline --json`, and a
 * flag error there would turn a security report into a support question.
 */
import type { CommandTable } from "../cliargs.js";

export const AUTH_BIN = "stockbit-auth";

export const AUTH_COMMANDS: CommandTable = {
  login: {
    summary: "one-time browser login, auto-captures your session (recommended)",
    flags: {
      "--fresh-profile": "use a throwaway browser profile",
      "--switch-account": "sign the current account out first, then show a real form",
      "--verify": "prove the captured token with a live refresh — this ROTATES it, ending the browser session",
    },
  },
  "import-har": {
    summary: "import a login captured in ANY browser via a DevTools HAR export",
    usage: "<file.har>",
    flags: {
      "--shred": "delete the .har file after import — it holds your password and cookies in plain text",
      "--verify": "prove the imported token with a live refresh — rotates it and logs the website out",
    },
    positionals: [{ name: "file.har", required: true }],
    details: [
      "1. Open your browser's DevTools → Network panel.",
      "2. Turn ON 'Preserve log' (Firefox: 'Persist Logs', Safari: 'Preserve Requests').",
      "3. Clear the log, then log into stockbit.com with username + password.",
      "4. Export the log to a .har file — in Chrome/Edge use the Export (download)",
      "   button, NOT 'Copy all as HAR' (that one omits response bodies).",
      "5. Run this command on the file.",
    ],
  },
  doctor: {
    summary: "diagnose browsers, token store, and the capture path",
    flags: {
      "--skip-self-test": "skip the capture self-test (the one check that launches a browser)",
    },
  },
  bootstrap: {
    summary: "paste a refresh token manually (fallback)",
    flags: {
      "--verify": "prove the pasted token with a live refresh — rotates it and logs the website out",
    },
  },
  status: {
    summary: "show store backend, every session, the trading mode and the IDX clock",
    flags: {
      "--verify": "spend one refresh to prove the token works — this ROTATES it",
      "--offline": "accepted, and now the default: nothing is spent",
      "--json": "print the whole report as JSON (redacted; safe to paste)",
    },
  },
  logout: {
    summary: "clear the stored refresh token AND the logged-in browser profile",
    flags: {
      "--keep-profile": "keep the browser profile (still logged in)",
    },
  },
  "trading-login": {
    summary: "unlock Stockbit Sekuritas with your 6-digit PIN (never stored)",
    flags: {
      "--browser": "complete it in the logged-in browser (Cloudflare fallback)",
    },
  },
  "trading-status": {
    summary: "show the trading policy and whether the session still works",
    flags: {
      "--offline": "skip the live validity check",
    },
  },
  "trading-enable": {
    summary: "ALLOW this server to place orders. Off until you run this.",
    flags: {
      "--paper": "a local ledger. No real money, no PIN. Start here.",
      "--live": "real orders on the exchange, with real money",
      "--auto-confirm": "skip per-order confirmation (live only; needs --max-order-value)",
      "--no-auto-confirm": "turn per-order confirmation back on",
    },
    valueFlags: {
      "--cash": { placeholder: "N", help: "paper starting balance (default Rp 100,000,000)" },
      "--max-order-value": { placeholder: "N", help: "cap one order's value in IDR" },
      "--max-lots": { placeholder: "N", help: "cap one order's size in lots" },
      "--symbols": { placeholder: "A,B", help: "restrict trading to these tickers" },
    },
  },
  "trading-disable": {
    summary: "turn ordering off again. The session and the ledger are left alone.",
  },
  "paper-reset": {
    summary: "start the paper ledger over",
    valueFlags: {
      "--cash": { placeholder: "N", help: "the new starting balance (default: keep the current setting)" },
    },
  },
  "trading-logout": {
    summary: "end the trading session and delete its credential",
  },
};
