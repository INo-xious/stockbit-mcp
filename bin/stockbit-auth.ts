#!/usr/bin/env node
/**
 * Auth CLI.
 *
 *   stockbit-auth login       # one-time browser login; auto-captures your session (recommended)
 *   stockbit-auth bootstrap   # paste a refresh token manually (fallback if `login` can't run)
 *   stockbit-auth status      # show the store backend and verify the token still works
 *   stockbit-auth logout      # clear the stored refresh token
 *
 * Every command answers `--help`/`-h` without running, and an unknown flag or stray argument is an
 * error, never ignored — `src/auth/cli.ts` says why that rule is load-bearing for this bin.
 *
 * `login` opens your existing Chrome/Edge/Brave, you log into Stockbit normally, and the refresh
 * token is captured from the login response — no DevTools, no copy-paste. After that, the MCP
 * auto-refreshes indefinitely.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, rmSync } from "node:fs";
import { bootstrap } from "../src/auth/bootstrap.js";
import { getStore } from "../src/auth/store.js";
import { withCredentialLock } from "../src/auth/reflock.js";
import {
  decodeJwt,
  forceRefresh,
  forgetRotated,
  hasStoredSession,
  missingSessionMessage,
  resetSession,
} from "../src/auth/session.js";
import { loginSecurities, logoutSecurities } from "../src/auth/tradinglogin.js";
import { securitiesTokenUrlAllowed } from "../src/auth/capture.js";
import {
  loadSettings,
  saveSettings,
  settingsPath,
  tradingPolicy,
  type ElicitationPolicy,
} from "../src/settings.js";
import { emptyLedger, loadLedger, paperLedgerPath, saveLedger, snapshot } from "../src/trading/paper.js";
import { captureNeedsProof, captureViaBrowserLogin, defaultProfileDir } from "../src/auth/login.js";
import { clearBrowserProfile } from "../src/auth/browserprofile.js";
import { clearWebSession } from "../src/auth/websession.js";
import { clearAccessCache } from "../src/auth/accesscache.js";
import { clearSessionHealth } from "../src/auth/health.js";
import { removeDirWithRetry } from "../src/auth/tempdir.js";
import { explainMiss, scanHarFile } from "../src/auth/har.js";
import { formatChecks, runDoctor } from "../src/auth/doctor.js";
import { logStderr, redactValue } from "../src/redact.js";
import { collectStatus, formatStatus } from "../src/status.js";
import { resolveToolProfile } from "../src/tools/_profile.js";
import { describeSurface } from "../src/tools/surface.js";
import { CliParseError, formatUsage, gateCommandLine, isHelpToken, isVersionToken } from "../src/cliargs.js";
import { VERSION } from "../src/version.js";
import { AUTH_BIN, AUTH_COMMANDS } from "../src/auth/cli.js";

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Mute echo so the token isn't printed to the terminal as it's typed/pasted.
  const anyOut = stdout as unknown as { write: (s: string) => boolean };
  const origWrite = anyOut.write.bind(stdout);
  let muted = false;
  (stdout as unknown as { write: (s: string) => boolean }).write = (s: string) =>
    muted && s !== "\n" && s !== "\r\n" ? true : origWrite(s);
  stdout.write(question);
  muted = true;
  try {
    const answer = await rl.question("");
    return answer;
  } finally {
    muted = false;
    (stdout as unknown as { write: (s: string) => boolean }).write = origWrite;
    stdout.write("\n");
    rl.close();
  }
}

async function cmdDoctor(argv: string[]): Promise<void> {
  logStderr("stockbit-auth doctor — checking everything the login depends on…\n");
  const checks = await runDoctor({ skipSelfTest: argv.includes("--skip-self-test") });
  logStderr(formatChecks(checks));
  const failed = checks.filter((c) => c.status === "fail");
  logStderr(
    failed.length
      ? `\n${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`
      : "\nAll checks passed.",
  );
  // Say what "all checks passed" does NOT cover, because it has already been read as more than it
  // means. On 2026-08-30 doctor printed that line while the stored credential was being rejected
  // by the API with HTTP 401 on every request — truthfully, since every check here exercises the
  // login MACHINERY (can a browser be driven, can a token be intercepted, can a cookie be read and
  // cleared) and none of them spends the stored token. A summary that omits the distinction lets a
  // green run be taken as proof of something it never tested.
  logStderr(
    "\nNote: these check the login machinery, not the stored credential. Whether the API actually\n" +
      "accepts your token is unproven here — proving it costs a refresh, which rotates the token and\n" +
      "ends the website session. Run `stockbit-auth status --verify` when you want that answer.",
  );
  if (failed.length) process.exit(1);
}

/**
 * Import a login captured in ANY browser via a DevTools HAR export. This is the fallback for
 * browsers that cannot be driven (Safari has no reachable protocol; Firefox dropped CDP in v141).
 */
async function cmdImportHar(argv: string[]): Promise<void> {
  const path = argv.find((a) => !a.startsWith("--"));
  if (!path) {
    // The DevTools tutorial lives in the command table now, so `--help` and this branch tell one story.
    logStderr(formatUsage(AUTH_BIN, AUTH_COMMANDS, "import-har"));
    process.exit(2);
  }

  const report = scanHarFile(path);
  if (!report.match) {
    logStderr(explainMiss(report));
    process.exit(1);
  }

  logStderr(`Found a session token in entry #${report.match.entryIndex} (${report.match.url}).`);
  const result = await bootstrap(report.match.refresh, { verify: argv.includes("--verify") });
  logStderr(`Stored in: ${result.backend}`);
  logStderr(
    result.verified
      ? `Test refresh: ${result.accessOk ? "OK ✓" : "FAILED — the token may already be stale"}`
      : `Stored${result.accessOk ? "" : " — but the token looks expired"}. Not verified against Stockbit: a test refresh would rotate the token and log you out of the website. Pass --verify to do it anyway.`,
  );

  if (argv.includes("--shred")) {
    try {
      rmSync(path, { force: true });
      logStderr(`Deleted ${path}.`);
    } catch (err) {
      logStderr(`Could not delete ${path}: ${String(err)}`);
    }
  } else {
    logStderr("");
    logStderr(`⚠ ${path} still contains your password, cookies and this token in plain text.`);
    logStderr("  Delete it now, or re-run with --shred to have this command remove it.");
  }
  if (!result.accessOk) process.exit(1);
}

async function cmdLogin(argv: string[]): Promise<void> {
  logStderr("Opening a browser for a one-time Stockbit login…");
  const result = await captureViaBrowserLogin({
    profileDir: argv.includes("--fresh-profile") ? "fresh" : undefined,
    switchAccount: argv.includes("--switch-account"),
  });
  if (!result.captured) {
    logStderr("No session captured. You can retry, or use `stockbit-auth bootstrap`.");
    process.exit(1);
  }
  // Validate WITHOUT spending the token.
  //
  // This used to call `forceRefresh()`, and that one line was why a successful login left the user
  // logged out of the website. Stockbit's refresh endpoint ROTATES: spending a refresh token
  // invalidates the previous one, and the browser profile that was just logged in holds that
  // previous one. So the validation step reached back and killed the session it had just validated.
  // Measured: eight HTTP 401s from exodus.stockbit.com on the very next chart load, `/login/refresh`
  // among them, and a page rendering a body of zero height — which the Chartbit driver then reported
  // as "the session is not signed in", sending every diagnosis in the wrong direction.
  //
  // The token arrived seconds ago in a live `/auth/v1/login` response. What is worth checking is that
  // it is a readable, unexpired JWT, and that is a local question. `--verify` keeps the round trip for
  // anyone who wants it, and now says plainly what it costs.
  const stored = getStore("main").get();
  let exp: number | null = null;
  try {
    const claims = stored ? decodeJwt(stored) : null;
    exp = claims && typeof claims["exp"] === "number" ? (claims["exp"] as number) : null;
  } catch {
    exp = null;
  }
  if (!stored) {
    logStderr("Captured a session but nothing reached the store. Tell the maintainer this message.");
    process.exit(1);
  }
  if (exp !== null && exp - Math.floor(Date.now() / 1000) <= 0) {
    logStderr("Captured a token that is already expired. Try logging in again.");
    process.exit(1);
  }

  // A HARVESTED credential does not get the benefit of the reasoning above, and must be proven.
  //
  // The argument for skipping the round trip is specifically that the token "arrived seconds ago in
  // a live /auth/v1/login response". That is true of an intercepted capture and false of a
  // harvested one: nothing logged in, and the token was read out of the browser's own
  // `credentialStorage` because the profile was already signed in. The refresh route never issued
  // it, and measurement says the refresh route will not accept it either — 2026-08-29 and
  // 2026-08-30, four harvested credentials, four HTTP 401s on first use, while this command printed
  // "you're set", `doctor` printed "All checks passed" and `status` showed six days remaining.
  // Every layer reporting healthy while nothing works is worse than a plain failure, because it
  // sends the next hour of diagnosis somewhere else entirely.
  //
  // Yes, verifying rotates, and rotation is what the comment above rightly avoids. The trade is
  // still clearly worth it here: an unverified harvested token is worthless with high probability,
  // so there is almost nothing to protect, and if it does verify the rotation hands back a token
  // the refresh route itself just issued — strictly better than the cookie we started with.
  const harvested = result.method === "harvested";
  if (captureNeedsProof(result.method, argv.includes("--verify"))) {
    resetSession();
    try {
      await forceRefresh();
      logStderr("Test refresh: OK ✓ — note this ROTATED the token, so the browser session is now stale.");
    } catch (err) {
      if (harvested) {
        logStderr("The captured session does NOT work — the API rejected it on first use.");
        logStderr(String(err));
        logStderr("");
        logStderr("Why: nothing was logged in. The browser profile was already signed in, so the");
        logStderr("token was read out of its cookie rather than issued by a login. Those are bound");
        logStderr("to the browser and the refresh route refuses them.");
        logStderr("");
        logStderr("Fix: clear the profile so the next login has to show a real login form —");
        logStderr("  stockbit-auth logout      (clears the token AND the logged-in profile)");
        logStderr("  stockbit-auth login       (sign in when the window appears)");
        logStderr("Look for 'Session captured (intercepted)'. '(harvested…)' means it happened again.");
      } else {
        logStderr("Captured a token but the test refresh failed:", String(err));
        logStderr("The captured token may use a different refresh path — tell the maintainer this message.");
      }
      process.exit(1);
    }
  } else {
    const days = exp === null ? null : Math.floor((exp - Math.floor(Date.now() / 1000)) / 86_400);
    logStderr(`Session stored${days === null ? "" : ` (valid ~${days} day(s))`} — you're set. Run stockbit-mcp.`);
  }
}

async function cmdBootstrap(argv: string[]): Promise<void> {
  const token = (await promptSecret("Paste refresh token (input hidden): ")).trim();
  if (!token) {
    logStderr("No token entered. Aborting.");
    process.exit(2);
  }
  const result = await bootstrap(token, { verify: argv.includes("--verify") });
  logStderr(`Stored in: ${result.backend}`);
  logStderr(
    result.verified
      ? `Test refresh: ${result.accessOk ? "OK ✓" : "FAILED — verify the token / refresh host"}`
      : `Stored${result.accessOk ? "" : " — but the token looks expired"}. Not verified against Stockbit: a test refresh would rotate the token and log you out of the website. Pass --verify to do it anyway.`,
  );
  if (!result.accessOk) process.exit(1);
  logStderr("Bootstrap complete. You can now run stockbit-mcp.");
}

/**
 * Report what is stored, and what is known about whether it works.
 *
 * The expiry in the JWT payload is a *claim about time*, not a statement of validity. A refresh
 * token can be revoked, rotated out from under this store by another process, or invalidated
 * server-side, and none of that changes a byte of the payload. So this command could answer
 * "present, expires in ~1.4 day(s)" for a token that 401s on its first use, which is the most
 * expensive kind of wrong answer: it sends you off to debug the thing you were about to do.
 *
 * The fix used to be a live refresh, ON BY DEFAULT. That was worse than the problem. A refresh
 * ROTATES the token family, which ends the website session the Chartbit browser is holding — so the
 * command a confused user runs first was the one that broke the other half of their setup, and the
 * `status` tool description told the model to call it "FIRST whenever anything looks wrong".
 *
 * So the default is off, and the honest answer comes from a journal instead: every refresh this
 * project makes records its outcome, so `status` can say "Stockbit rejected this at 14:12" for free.
 * `--verify` still spends one refresh for anyone who wants proof, and now says what that costs.
 */
async function cmdStatus(argv: string[]): Promise<void> {
  // The same report the `status` MCP tool returns. One implementation, so a user reading the
  // terminal and a model reading the tool result cannot be told two different stories.
  // `--verify` opts IN. This used to default to live, which meant the command a confused user runs
  // FIRST was the command that rotated their refresh token and ended their website session. The
  // journal now answers "did it last work" for free, so the round trip is only worth making when
  // somebody deliberately asks for it.
  //
  // `--offline` is kept as an accepted no-op because SECURITY.md tells vulnerability reporters to
  // paste the output of `stockbit-auth status --offline --json`, and a flag error there would turn
  // a security report into a support question.
  const live = argv.includes("--verify");

  // What a server started from THIS environment would register.
  //
  // Without this the report claimed a tool profile it had not computed, and the "trading is on but
  // there are no order tools" warning was dead on the CLI path — which is precisely the terminal the
  // user is standing in when they run `trading-enable --live`. Describing a server this process is
  // not is the whole reason it has to be derived rather than defaulted.
  let profileLabel: string | undefined;
  let profileIsDefault = false;
  let missingTools: string[] | undefined;
  let profileError: string | undefined;
  try {
    const known = new Set(describeSurface().tools.map((t) => t.name));
    const resolved = resolveToolProfile(process.env.STOCKBIT_TOOLS, known);
    profileLabel = resolved.profile.label;
    profileIsDefault = resolved.isDefault;
    missingTools = describeSurface(resolved.profile, resolved.isDefault).skipped;
  } catch (err) {
    // An unparsable STOCKBIT_TOOLS stops `stockbit-mcp` from starting. It must not stop `status` —
    // that is the command someone runs to find out why — but staying silent about it and reporting
    // a profile as though a server were running would answer the wrong question with a wrong fact.
    profileError = err instanceof Error ? err.message : String(err);
  }

  const report = await collectStatus({
    live,
    ...(profileLabel === undefined ? {} : { profileLabel, profileIsDefault }),
    ...(missingTools === undefined ? {} : { missingTools }),
    ...(profileError === undefined ? {} : { profileError }),
  });

  if (argv.includes("--json")) {
    // Redacted on the way out even though `collectStatus` never copies a token in: this output is
    // what SECURITY.md asks a reporter to paste into a public issue.
    stdout.write(`${JSON.stringify(redactValue(report), null, 2)}\n`);
  } else {
    logStderr(formatStatus(report));
    if (!live) {
      logStderr(
        "Validity: not proved by a request, and deliberately. An expiry in the payload does not mean " +
          "a token still works — but proving it means refreshing, which ROTATES the token family and " +
          "ends your website session. What is shown instead comes from what actually happened the " +
          "last time each credential was used: a session that Stockbit rejected says so, and one that " +
          "has never been used says nothing rather than guessing. Pass --verify to spend the refresh.",
      );
    }
  }

  // Exit non-zero when the live check actually ran and failed, so a script can act on it. A missing
  // session is not a failure of this command — it is the answer, and `nextStep` says what to run.
  if (live && report.checks.some((c) => c.name === "live check" && c.status === "fail")) {
    process.exit(1);
  }
}

async function cmdLogout(argv: string[]): Promise<void> {
  // Under the credential lock, like every other credential write. A logout that races a refresh
  // would otherwise be undone by the rotation landing a moment later — the user would be told they
  // were logged out while a working token sat back on disk.
  await withCredentialLock("main", () => getStore().clear());
  logStderr("Cleared stored refresh token.");

  // A THIRD copy: the captured web session (cookies + Local Storage) that the Chartbit driver seeds
  // its browser from. It is a working Stockbit session on its own, so a logout that left it on disk
  // would not be a logout — the same reasoning that already removes the browser profile below.
  clearWebSession();
  // Per slot. `cmdLogout` clears only the MAIN credential above, so clearing all three domains'
  // access tokens here would cost the securities and e-IPO sessions a rotation they did not ask
  // for, and drop health this command never touched.
  clearAccessCache("main");
  clearSessionHealth("main");
  forgetRotated("main");
  logStderr("Cleared the stored browser web session and the main access token.");

  // The pin describes a profile that is about to stop being logged in; leaving it would send the
  // Chartbit driver at a browser with no session and no explanation.
  clearBrowserProfile();

  // The persistent browser profile is a SECOND copy of the session: it holds Stockbit cookies and a
  // Login Data store, so clearing only the token leaves an artifact that can still log straight back
  // in. Logging out should mean logged out.
  const profile = defaultProfileDir();
  if (!existsSync(profile)) return;
  if (argv.includes("--keep-profile")) {
    logStderr(`Kept the browser profile at ${profile} (it still contains a logged-in session).`);
    return;
  }
  logStderr(
    (await removeDirWithRetry(profile))
      ? "Removed the logged-in browser profile."
      : `Could not remove the browser profile at ${profile} — delete it manually; it still ` +
        "contains a logged-in Stockbit session.",
  );
}

/* ------------------------------- trading commands ------------------------------- */

/**
 * Unlock the Stockbit Sekuritas session.
 *
 * The PIN is read through the same hidden prompt the refresh-token bootstrap uses, handed to one
 * request, and never stored. `--browser` is the Cloudflare fallback: Turnstile blocks the direct
 * call often enough that shipping the workaround later would have meant shipping a command that
 * fails for some users with no way forward.
 */
async function cmdTradingLogin(argv: string[]): Promise<void> {
  if (argv.includes("--browser")) {
    // NOT `/trade`. That path is a Stockbit USERNAME route, so it opened a stranger's profile page
    // — reported by an account owner who read the page they were sent to.
    //
    // There is no trading PAGE to send them to instead. Confirmed by the same account owner: the
    // PIN prompt is a MODAL that appears when a buy or sell is clicked, anywhere on the site. So
    // this opens the site and says what to click; a URL here could only ever be wrong again.
    const startUrl = process.env.STOCKBIT_TRADING_URL || "https://stockbit.com/";
    logStderr("Opening the logged-in browser so Cloudflare sees a real one.");
    logStderr("Click Buy or Sell on any stock in that window — the 6-digit PIN prompt appears as a");
    logStderr("pop-up. Enter it there. There is no separate trading page, so nothing to navigate to.");
    logStderr("The capture watches for the carina session response and closes itself when it sees one.");
    const result = await captureViaBrowserLogin({
      startUrl,
      isTokenUrl: securitiesTokenUrlAllowed,
      fetchPatterns: ["*carina.stockbit.com/auth/*"],
      slot: "securities",
    });
    if (!result.captured) {
      logStderr("No trading session captured.");
      process.exit(1);
    }
    logStderr("Trading session captured.");
  } else {
    const pin = (await promptSecret("Trading PIN (6 digits, input hidden): ")).trim();
    if (!pin) {
      logStderr("No PIN entered. Aborting; nothing was sent.");
      process.exit(2);
    }
    try {
      const result = await loginSecurities({ pin });
      logStderr(`Trading session stored in: ${result.backend}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logStderr(`Trading login failed: ${message}`);
      if (/challenge/i.test(message)) {
        logStderr("");
        logStderr("This was a Cloudflare browser challenge, NOT a wrong PIN — do not retype it.");
        logStderr("Run `stockbit-auth trading-login --browser` instead.");
      }
      process.exit(1);
    }
  }

  // Prove it works before saying it does. A stored token that 401s on first use is the most
  // expensive kind of "success".
  try {
    await forceRefresh("securities");
    logStderr("Test refresh: OK - the trading session is live.");
  } catch (err) {
    logStderr(`Stored the trading session but the test refresh failed: ${String(err)}`);
    process.exit(1);
  }

  const policy = tradingPolicy();
  logStderr("");
  logStderr(
    policy.enabled
      ? "Trading is ENABLED in settings. Orders still require confirmation per call unless autoConfirm is on."
      : "Trading is still OFF. Logging in unlocks the account READS; run `stockbit-auth trading-enable` to " +
        "allow orders.",
  );
}

/** What the trading side is currently able to do, and why. */
async function cmdTradingStatus(argv: string[]): Promise<void> {
  const policy = tradingPolicy();
  logStderr(`Settings file: ${policy.settingsPath}`);
  logStderr(`Trading: ${policy.enabled ? "ENABLED" : "OFF"} (${policy.source})`);
  logStderr(`  ${policy.reason}`);
  if (policy.corrupt) logStderr("  WARNING: the settings file could not be parsed and was treated as no permission.");
  if (policy.autoConfirmIgnored) logStderr(`  ${policy.autoConfirmIgnored}`);
  logStderr(
    `  autoConfirm: ${policy.autoConfirm ? "on" : "off"}; ` +
      `elicitation: ${policy.elicitation}; ` +
      `maxOrderValueIdr: ${policy.maxOrderValueIdr ?? "none"}; ` +
      `maxLotsPerOrder: ${policy.maxLotsPerOrder}; ` +
      `allowedSymbols: ${policy.allowedSymbols.length ? policy.allowedSymbols.join(", ") : "any"}`,
  );
  logStderr(`  ${ELICITATION_MEANING[policy.elicitation]}`);
  if (policy.confirmationsRevokedAt) {
    logStderr(
      `  Standing "don't ask again" grants made before ${policy.confirmationsRevokedAt} are revoked ` +
        "(`trading-forget`).",
    );
  }

  if (!hasStoredSession("securities")) {
    logStderr(`Securities session: NOT set. ${missingSessionMessage("securities")}`);
    return;
  }
  if (argv.includes("--offline")) {
    logStderr("Securities session: present. Validity NOT CHECKED (--offline).");
    return;
  }
  logStderr("Securities session: present. Checking it against Stockbit...");
  try {
    await forceRefresh("securities");
    logStderr("Validity: OK - the trading token refreshed successfully.");
  } catch (err) {
    logStderr(`Validity: FAILED - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function cmdTradingLogout(): Promise<void> {
  const result = await logoutSecurities();
  logStderr("Cleared the stored trading session.");
  if (result.remote === "ok") logStderr("Stockbit was told to end the session too.");
  else if (result.remote !== "skipped") {
    logStderr(`Note: the server-side logout did not succeed (${result.remote}).`);
    logStderr("The credential is gone from this machine either way; the session may still be open in your app.");
  }
}

/** Numeric flag value, e.g. `--max-order-value 5000000`. */
function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

/** One line each, for `trading-status`. Written for the person who set the switch a month ago. */
const ELICITATION_MEANING: Record<ElicitationPolicy, string> = {
  required:
    "A person must be asked directly before every order. A client that cannot ask is REFUSED, and " +
    "confirm: true does not substitute.",
  "when-available":
    "A person is asked directly wherever the client supports it, and their answer decides it. On a " +
    "client that cannot ask, confirm: true proceeds and the order is marked as unelicited.",
  never: "Nobody is asked directly, whatever the client supports. confirm: true is the only gate.",
};

/**
 * Read the elicitation switch off the command line.
 *
 * Three spellings for the same dial, because `--auto-confirm` / `--no-auto-confirm` already set
 * that precedent and a user who has learned one pair should not have to learn a different shape for
 * the next. Contradictions are rejected rather than resolved by precedence: `--require-elicitation
 * --no-elicitation` is not a preference, it is a mistake, and the same is true of `--paper --live`
 * two commands up.
 */
function readElicitationFlags(argv: string[]): ElicitationPolicy | undefined {
  const chosen: ElicitationPolicy[] = [];
  if (argv.includes("--require-elicitation")) chosen.push("required");
  if (argv.includes("--no-elicitation")) chosen.push("never");

  const explicit = flagValue(argv, "--elicitation");
  // `flagValue` returns undefined both for "not given" and for "given with nothing usable after
  // it", and those must not be the same answer here. `--elicitation --max-order-value 5000000`
  // would otherwise leave the switch untouched with no diagnostic, and the user would believe they
  // had set it. That is tolerable for a numeric cap; it is not tolerable for the switch that
  // decides whether a person is asked before their money moves.
  if (explicit === undefined && argv.some((a) => a === "--elicitation" || a.startsWith("--elicitation="))) {
    logStderr("--elicitation needs a value: required, when-available or never.");
    process.exit(2);
  }
  if (explicit !== undefined) {
    if (explicit !== "required" && explicit !== "when-available" && explicit !== "never") {
      logStderr(
        `--elicitation must be required, when-available or never; got ${JSON.stringify(explicit)}.`,
      );
      process.exit(2);
    }
    chosen.push(explicit);
  }

  if (chosen.length === 0) return undefined;
  if (new Set(chosen).size > 1) {
    logStderr(
      `Pick one: --elicitation ${[...new Set(chosen)].join(" and --elicitation ")} cannot both be what you meant. ` +
        "(--require-elicitation is --elicitation required; --no-elicitation is --elicitation never.)",
    );
    process.exit(2);
  }
  return chosen[0];
}

/**
 * Turn trading on — but say which kind.
 *
 * A bare `trading-enable` used to mean "real orders with real money". It is refused now, and that
 * is the point of the change rather than a side effect of it: the two things this command can do
 * differ by everything, and a default is a decision made for someone who did not make it.
 */
async function cmdTradingEnable(argv: string[]): Promise<void> {
  const paper = argv.includes("--paper");
  const live = argv.includes("--live");
  if (paper && live) {
    logStderr("Pick one: --paper or --live.");
    process.exit(2);
  }
  if (!paper && !live) {
    logStderr("Say which: `trading-enable --paper` or `trading-enable --live`.");
    logStderr("");
    logStderr("  --paper   orders go to a local ledger. No real money, no PIN, no session needed.");
    logStderr("            Start here. The protocol is identical, so nothing is a surprise later.");
    logStderr("  --live    orders reach the exchange and move real money. Needs a trading session");
    logStderr("            (`stockbit-auth trading-login`) and its 6-digit PIN.");
    logStderr("");
    logStderr("A bare `trading-enable` used to mean --live. It no longer means anything, on purpose.");
    process.exit(2);
  }

  const settings = loadSettings();
  settings.trading.mode = paper ? "paper" : "live";

  const cash = flagValue(argv, "--cash");
  if (cash !== undefined) {
    const parsed = Number(cash);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logStderr(`--cash must be a positive number of rupiah; got ${JSON.stringify(cash)}.`);
      process.exit(2);
    }
    settings.trading.paper.startingCashIdr = parsed;
  }

  if (argv.includes("--auto-confirm")) settings.trading.autoConfirm = true;
  if (argv.includes("--no-auto-confirm")) settings.trading.autoConfirm = false;

  const elicitation = readElicitationFlags(argv);
  if (elicitation !== undefined) settings.trading.elicitation = elicitation;

  const maxValue = flagValue(argv, "--max-order-value");
  if (maxValue !== undefined) {
    const parsed = Number(maxValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logStderr(`--max-order-value must be a positive number of rupiah; got ${JSON.stringify(maxValue)}.`);
      process.exit(2);
    }
    settings.trading.maxOrderValueIdr = parsed;
  }

  const maxLots = flagValue(argv, "--max-lots");
  if (maxLots !== undefined) {
    const parsed = Number(maxLots);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logStderr(`--max-lots must be a positive number of lots; got ${JSON.stringify(maxLots)}.`);
      process.exit(2);
    }
    settings.trading.maxLotsPerOrder = Math.floor(parsed);
  }

  const symbols = flagValue(argv, "--symbols");
  if (symbols !== undefined) {
    settings.trading.allowedSymbols = symbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  saveSettings(settings);
  const policy = tradingPolicy();

  if (paper) {
    logStderr(`PAPER trading enabled. Wrote ${settingsPath()}.`);
    logStderr(`Ledger: ${paperLedgerPath()} (created on the first order).`);
    logStderr(
      `Starting cash Rp ${settings.trading.paper.startingCashIdr.toLocaleString("en-US")}. ` +
        "Reset any time with `stockbit-auth paper-reset`.",
    );
    logStderr("");
    logStderr("Nothing reaches the exchange. No PIN and no trading session are needed — the account");
    logStderr("reads and the order tools are served from the ledger instead.");
    logStderr("Every order still needs confirm: true, because rehearsing without it rehearses the");
    logStderr("wrong thing. Fills are approximate: close-only data, no queue position, no partials.");
    logStderr(`Elicitation: ${policy.elicitation}. ${ELICITATION_MEANING[policy.elicitation]}`);
    return;
  }

  logStderr(`LIVE trading ENABLED. Wrote ${settingsPath()}.`);
  logStderr("Orders now reach the exchange and move real money.");
  logStderr(`Elicitation: ${policy.elicitation}. ${ELICITATION_MEANING[policy.elicitation]}`);
  if (policy.autoConfirmIgnored) logStderr(policy.autoConfirmIgnored);
  else if (policy.autoConfirm) {
    logStderr(
      `autoConfirm is ON for orders up to Rp ${policy.maxOrderValueIdr?.toLocaleString("en-US")}. ` +
        "Anything above that still needs confirm: true.",
    );
  } else {
    logStderr("Every order needs confirm: true. That is the default and it is the safe one.");
  }
  if (!hasStoredSession("securities")) {
    logStderr("");
    logStderr(`No trading session yet. ${missingSessionMessage("securities")}`);
  }
}

/**
 * Start the paper account over.
 *
 * Explicit rather than automatic. The ledger is the only record of what the practice account did,
 * and a command that silently discarded it — or a loader that replaced a corrupt one — would throw
 * away the only thing paper mode produces.
 */
async function cmdPaperReset(argv: string[]): Promise<void> {
  const settings = loadSettings();
  const cash = flagValue(argv, "--cash");
  let startingCashIdr = settings.trading.paper.startingCashIdr;
  if (cash !== undefined) {
    const parsed = Number(cash);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logStderr(`--cash must be a positive number of rupiah; got ${JSON.stringify(cash)}.`);
      process.exit(2);
    }
    startingCashIdr = parsed;
    settings.trading.paper.startingCashIdr = parsed;
    saveSettings(settings);
  }

  saveLedger(emptyLedger(startingCashIdr));
  logStderr(`Paper ledger reset. Cash Rp ${startingCashIdr.toLocaleString("en-US")}.`);
  logStderr(`Wrote ${paperLedgerPath()}. Everything the old ledger held is gone.`);
}

async function cmdTradingDisable(): Promise<void> {
  const settings = loadSettings();
  const was = settings.trading.mode;
  settings.trading.mode = "off";
  settings.trading.autoConfirm = false;
  // Turning trading off must also end any standing "don't ask again" held in a server process that
  // is still running. It cannot reach that memory, but it can stamp a moment every server reads.
  //
  // `elicitation` is deliberately NOT reset. Two of its three values are stricter than the default,
  // and quietly loosening a stricter setting on the way to "off" would mean that turning trading
  // back on later restored it weaker than the user left it.
  settings.trading.confirmationsRevokedAt = new Date().toISOString();
  saveSettings(settings);
  logStderr(`Trading DISABLED (was ${was}). Wrote ${settingsPath()}.`);
  logStderr("The order tools still exist and will now refuse, naming this file. The session is untouched.");
  logStderr("Any standing \"don't ask again\" is revoked; the elicitation setting is left as you set it.");
  if (was === "paper") logStderr(`The paper ledger is left alone at ${paperLedgerPath()}.`);
}

/**
 * Revoke every standing "don't ask again", everywhere, without turning trading off.
 *
 * The grants live in server memory and a terminal cannot reach it. What it can do is write a
 * moment into the settings file: every order re-reads the policy before it runs the gate, so a
 * grant made before that moment stops covering anything — including in server processes that were
 * already running when this command was typed. That is the whole mechanism, and it is why this is
 * a settings write rather than an IPC channel nobody would trust with an order.
 */
async function cmdTradingForget(): Promise<void> {
  const settings = loadSettings();
  const at = new Date().toISOString();
  settings.trading.confirmationsRevokedAt = at;
  saveSettings(settings);
  logStderr(`Standing "don't ask again" grants revoked as of ${at}. Wrote ${settingsPath()}.`);
  logStderr("Every order from now on asks you directly again, in every client, wherever it can.");
  logStderr("Nothing else changed: the trading mode, the caps and the elicitation setting are untouched.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const argv = process.argv.slice(3);

  // `--version` as the command word, answered on the same rule as help: a question ABOUT the
  // package, so stdout and exit 0, and never by running a command. `login --version` is still an
  // unknown flag on `login` — this is the bare form only.
  if (isVersionToken(cmd)) {
    stdout.write(`${VERSION}\n`);
    return;
  }

  // `--help`, `-h` or `help [command]` as the command word. Requested help is the command's product,
  // so it goes to stdout and exits 0 — the same rule that already puts `status --json` there.
  // (`help wat` is an unknown-command error like any other.)
  if (cmd === "help" || isHelpToken(cmd)) {
    const topic = argv[0];
    if (topic !== undefined && !(topic in AUTH_COMMANDS)) {
      logStderr(formatUsage(AUTH_BIN, AUTH_COMMANDS));
      process.exit(2);
    }
    stdout.write(formatUsage(AUTH_BIN, AUTH_COMMANDS, topic));
    return;
  }

  // Every command line passes this gate before ANY handler runs. On 2026-08-29, `login --help`
  // reached cmdLogin and opened a real browser login, because flags were read with `argv.includes()`
  // and an unknown token was invisible. An unknown token is an error, not a shrug (the
  // STOCKBIT_TOOLS rule) — and it is a USAGE error: exit 2, not the catch-all's 1. `--help` on a
  // subcommand prints usage and stops right here, which for this bin is the entire point: several
  // of these handlers log out, wipe a ledger, or launch a browser.
  try {
    if (gateCommandLine(AUTH_BIN, AUTH_COMMANDS, cmd, argv, (text) => stdout.write(text)) === "help") return;
  } catch (err) {
    if (err instanceof CliParseError) {
      logStderr(err.message);
      process.exit(2);
    }
    throw err;
  }

  switch (cmd) {
    case "login":
      await cmdLogin(argv);
      break;
    case "bootstrap":
      await cmdBootstrap(argv);
      break;
    case "import-har":
      await cmdImportHar(argv);
      break;
    case "doctor":
      await cmdDoctor(argv);
      break;
    case "status":
      await cmdStatus(argv);
      break;
    case "logout":
      await cmdLogout(argv);
      break;
    case "trading-login":
      await cmdTradingLogin(argv);
      break;
    case "trading-status":
      await cmdTradingStatus(argv);
      break;
    case "trading-logout":
      await cmdTradingLogout();
      break;
    case "trading-enable":
      await cmdTradingEnable(argv);
      break;
    case "trading-disable":
      await cmdTradingDisable();
      break;
    case "trading-forget":
      await cmdTradingForget();
      break;
    case "paper-reset":
      await cmdPaperReset(argv);
      break;
    default:
      // Generated from the same table the gate validates against, so this text cannot drift from
      // what the commands actually accept. Unrequested usage is a diagnostic: stderr, exit 2.
      logStderr(formatUsage(AUTH_BIN, AUTH_COMMANDS));
      process.exit(2);
  }
}

main().catch((err) => {
  logStderr("stockbit-auth: error:", String(err));
  process.exit(1);
});
