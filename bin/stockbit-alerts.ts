#!/usr/bin/env node
/**
 * The alert daemon's entry point.
 *
 * Separate from the MCP server on purpose. An MCP server lives only as long as a client holds it
 * open, so a rule that fires at 14:20 on a Tuesday reaches nobody unless something else is running.
 * This is the something else, and it is a plain long-lived process you can put behind Task Scheduler,
 * launchd or systemd.
 *
 *   stockbit-alerts watch                 poll every 60s during IDX hours
 *   stockbit-alerts watch --interval 30   ...every 30s
 *   stockbit-alerts watch --always        ignore market hours
 *   stockbit-alerts check                 one pass, then exit
 *   stockbit-alerts check --dry-run       evaluate without firing or delivering
 *   stockbit-alerts test                  send a sample notification through every channel
 *
 * Flags: --symbol BBRI, --no-desktop, --no-telegram, --webhook <url> (or STOCKBIT_ALERT_WEBHOOK).
 *
 * Telegram is configured by environment only — `STOCKBIT_TELEGRAM_BOT_TOKEN` and
 * `STOCKBIT_TELEGRAM_CHAT_ID`. Deliberately not a flag: a bot token on the command line is visible
 * to every other user on the machine through `ps`, and this process is meant to run for weeks.
 * Get the token from @BotFather, then message your bot once and read the chat id from
 * `https://api.telegram.org/bot<token>/getUpdates`.
 */
import { getBars } from "../src/core/bars.js";
import { tick, watch, isMarketOpen, type TickResult } from "../src/alerts/daemon.js";
import { alertLogPath, deliver, telegramTargetFromEnv } from "../src/alerts/notify.js";
import { loadRules } from "../src/alerts/store.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Bars for the daemon, through the same core path the MCP tools use. */
async function fetchBars(symbol: string, bars: number) {
  return (await getBars({ symbol, bars })).bars;
}

function report(result: TickResult): void {
  const stamp = result.at.replace("T", " ").slice(0, 19);
  if (result.skipped === "market-closed") {
    console.log(`${stamp}  market closed — skipping (use --always to override)`);
    return;
  }
  if (result.skipped === "no-rules") {
    console.log(`${stamp}  no enabled rules`);
    return;
  }
  const parts = [`checked ${result.checked}`, `fired ${result.fired.length}`];
  if (result.errors.length) parts.push(`errors ${result.errors.length}`);
  console.log(`${stamp}  ${parts.join("  ")}`);
  for (const event of result.fired) {
    console.log(`   FIRED  ${event.symbol}  ${event.name}  (${event.condition})  bar ${event.barDate}`);
  }
  for (const error of result.errors) console.error(`   error: ${error}`);
  for (const delivery of result.deliveries) {
    if (delivery.errors.length) console.error(`   delivery: ${delivery.errors.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "watch";
  const options = {
    always: flag("always"),
    symbol: value("symbol"),
    dryRun: flag("dry-run"),
    desktop: !flag("no-desktop"),
    webhookUrl: value("webhook"),
    // `false` means "skip even if the environment configures it"; `undefined` means "use whatever
    // the environment says", which is what `deliver` resolves.
    telegram: flag("no-telegram") ? (false as const) : undefined,
  };

  if (command === "test") {
    const result = await deliver(
      {
        ruleId: "test", symbol: "BBRI", name: "notification test", fired: true,
        condition: "this is a test", barDate: new Date().toISOString().slice(0, 10),
        leftValue: 1, rightValue: 0,
      },
      new Date().toISOString(),
      options,
    );
    console.log(JSON.stringify(result, null, 2));
    console.log(`channels: ${describeChannels(options)}`);
    console.log(`log: ${alertLogPath()}`);
    process.exitCode = result.errors.length ? 1 : 0;
    return;
  }

  if (command === "check") {
    report(await tick(fetchBars, new Date(), options));
    return;
  }

  if (command !== "watch") {
    console.error(`Unknown command ${JSON.stringify(command)}. Use watch, check or test.`);
    process.exitCode = 2;
    return;
  }

  const interval = Number(value("interval") ?? 60) * 1000;
  const rules = loadRules().filter((r) => r.enabled);
  console.log(
    `stockbit-alerts watching ${rules.length} rule(s), every ${interval / 1000}s` +
      `${options.always ? "" : ", IDX hours only"}${isMarketOpen(new Date()) ? "" : " — market is currently closed"}`,
  );
  console.log(`channels: ${describeChannels(options)}`);
  console.log(`log: ${alertLogPath()}`);

  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log("\nstopping");
      controller.abort();
    });
  }
  await watch(fetchBars, { ...options, intervalMs: interval, onTick: report, signal: controller.signal });
}

/**
 * Which channels are live, so a user who configured one and sees nothing knows which end is wrong.
 *
 * Names the channels, never the credentials: the bot token is not printed, and neither is the chat
 * id, which identifies the account.
 */
function describeChannels(options: { desktop: boolean; webhookUrl?: string; telegram?: false }): string {
  const channels = ["log"];
  if (options.desktop) channels.push("desktop");
  if (options.webhookUrl ?? process.env.STOCKBIT_ALERT_WEBHOOK?.trim()) channels.push("webhook");
  if (options.telegram === false) {
    channels.push("telegram (off: --no-telegram)");
  } else if (telegramTargetFromEnv()) {
    channels.push("telegram");
  } else if (process.env.STOCKBIT_TELEGRAM_BOT_TOKEN || process.env.STOCKBIT_TELEGRAM_CHAT_ID) {
    // Half-configured is the case worth naming: the user believes it is on.
    channels.push(
      "telegram (NOT configured: needs both STOCKBIT_TELEGRAM_BOT_TOKEN and a numeric " +
        "STOCKBIT_TELEGRAM_CHAT_ID)",
    );
  }
  return channels.join(", ");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
