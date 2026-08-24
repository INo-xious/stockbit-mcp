/**
 * The alert channel that reaches a phone — and the credential that rides in the URL.
 *
 * The Bot API puts the token in the request **path**, which makes this different from every other
 * outbound call in this project. A `fetch` failure quotes the URL in `err.message` as a matter of
 * routine, so an error handler that does the ordinary thing — pass the message through — writes the
 * bot token into `alerts.log` and into the daemon's stdout, where it stays until someone revokes it.
 *
 * Most of this file is therefore about what does NOT come back from a failure.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-telegram-test-"));
process.env.STOCKBIT_STORE_DIR = STORE;
process.env.STOCKBIT_FORCE_FILE_STORE = "1";

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  postTelegram,
  telegramTargetFromEnv,
  telegramText,
  deliver,
  alertLogPath,
  type TelegramTarget,
} from "../src/alerts/notify.ts";
import { redact, redactValue } from "../src/redact.ts";
import type { AlertEvaluation } from "../src/alerts/rules.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/** A real-shaped bot token: numeric id, colon, 35 URL-safe characters. */
const TOKEN = "123456789:AAHfake_Token_Value_For_Tests_0123456";
const TARGET: TelegramTarget = { botToken: TOKEN, chatId: "-1001234567890" };

const EVENT: AlertEvaluation = {
  ruleId: "r1",
  symbol: "BBRI",
  name: "RSI oversold",
  fired: true,
  condition: "rsi14 < 30",
  barDate: "2026-08-25",
  leftValue: 28.4,
  rightValue: 30,
};

beforeEach(() => {
  delete process.env.STOCKBIT_TELEGRAM_BOT_TOKEN;
  delete process.env.STOCKBIT_TELEGRAM_CHAT_ID;
  delete process.env.STOCKBIT_ALERT_WEBHOOK;
});

/* ------------------------------------ the request ------------------------------------ */

test("it posts to the Bot API with the token in the path and the chat id in the body", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const error = await postTelegram(TARGET, "hello", fetchImpl);
  assert.equal(error, null);
  assert.ok(seen);
  assert.equal(seen.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.redirect, "manual", "a redirect would move the message to another origin");

  const body = JSON.parse(String(seen.init.body)) as Record<string, unknown>;
  assert.equal(body.chat_id, "-1001234567890");
  assert.equal(body.text, "hello");
  assert.equal(body.disable_web_page_preview, true);
  assert.ok(!("parse_mode" in body), "plain text: an alert name with a stray * must not break the send");
});

test("a non-2xx status is reported by code, without the body", async () => {
  // Telegram echoes parts of the request in `description`, which is exactly what must not be logged.
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: false, description: `bad token ${TOKEN}` }), {
      status: 401,
    })) as unknown as typeof fetch;

  const error = await postTelegram(TARGET, "hello", fetchImpl);
  assert.equal(error, "HTTP 401");
  assert.ok(!error.includes(TOKEN));
});

test("a redirect is refused rather than followed", async () => {
  const fetchImpl = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
  const error = await postTelegram(TARGET, "hello", fetchImpl);
  assert.match(String(error), /refused to follow a redirect/);
});

/* --------------------------- the failure that leaks the token --------------------------- */

test("a fetch error whose message contains the URL does not put the token in the result", async () => {
  // This is what a real DNS or TLS failure looks like: the URL, with the token in it, in `message`.
  const fetchImpl = (async () => {
    const err = new TypeError(
      `fetch failed: request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ENOTFOUND`,
    );
    throw err;
  }) as unknown as typeof fetch;

  const error = await postTelegram(TARGET, "hello", fetchImpl);
  assert.ok(error, "a failure must be reported");
  assert.ok(!error.includes(TOKEN), `the error carried the bot token: ${error}`);
  assert.equal(error, "request failed (TypeError)");
});

test("a timeout is reported without the URL either", async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    // Behave like a real abort: reject with the reason the signal carries.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const err = new Error(`The operation was aborted: https://api.telegram.org/bot${TOKEN}/sendMessage`);
    err.name = "AbortError";
    throw err;
  }) as unknown as typeof fetch;

  const error = await postTelegram(TARGET, "hello", fetchImpl, 5);
  assert.ok(error && !error.includes(TOKEN));
  assert.match(error, /AbortError/);
});

/* ------------------------------------ configuration ------------------------------------ */

test("both halves are required, and the chat id must be numeric", () => {
  assert.equal(telegramTargetFromEnv({}), null);
  assert.equal(telegramTargetFromEnv({ STOCKBIT_TELEGRAM_BOT_TOKEN: TOKEN }), null, "no chat id");
  assert.equal(telegramTargetFromEnv({ STOCKBIT_TELEGRAM_CHAT_ID: "123" }), null, "no token");

  // An @username is the mistake people make; `getUpdates` returns a number, and a group's is negative.
  assert.equal(
    telegramTargetFromEnv({ STOCKBIT_TELEGRAM_BOT_TOKEN: TOKEN, STOCKBIT_TELEGRAM_CHAT_ID: "@marvel" }),
    null,
  );

  assert.deepEqual(
    telegramTargetFromEnv({ STOCKBIT_TELEGRAM_BOT_TOKEN: TOKEN, STOCKBIT_TELEGRAM_CHAT_ID: " 42 " }),
    { botToken: TOKEN, chatId: "42" },
  );
  assert.deepEqual(
    telegramTargetFromEnv({ STOCKBIT_TELEGRAM_BOT_TOKEN: TOKEN, STOCKBIT_TELEGRAM_CHAT_ID: "-1001234567890" }),
    TARGET,
  );
});

/* -------------------------------------- redaction -------------------------------------- */

test("a bot token is masked by shape, wherever it appears", () => {
  const line = `GET https://api.telegram.org/bot${TOKEN}/sendMessage failed`;
  const masked = redact(line);
  assert.ok(!masked.includes(TOKEN));
  assert.match(masked, /\[REDACTED\]/);

  // And under a key, dropped whole rather than masked in part.
  const value = redactValue({ bot_token: TOKEN, note: `token is ${TOKEN}` }) as Record<string, string>;
  assert.equal(value.bot_token, "[REDACTED]");
  assert.ok(!value.note.includes(TOKEN));
});

/* -------------------------------------- delivery -------------------------------------- */

test("delivery reports telegram as disabled when nothing is configured", async () => {
  const result = await deliver(EVENT, new Date().toISOString(), { desktop: false });
  assert.equal(result.telegram, "disabled");
  assert.equal(result.logged, true, "the log is written whatever else happens");
});

test("telegram: false skips the channel even when the environment configures one", async () => {
  process.env.STOCKBIT_TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.STOCKBIT_TELEGRAM_CHAT_ID = "42";
  try {
    const result = await deliver(EVENT, new Date().toISOString(), { desktop: false, telegram: false });
    assert.equal(result.telegram, "disabled");
  } finally {
    delete process.env.STOCKBIT_TELEGRAM_BOT_TOKEN;
    delete process.env.STOCKBIT_TELEGRAM_CHAT_ID;
  }
});

test("the log is written before the network is touched, so an outage costs the ping not the record", async () => {
  const at = new Date().toISOString();
  await deliver(EVENT, at, { desktop: false });
  const log = readFileSync(alertLogPath(), "utf8").trim().split("\n");
  const last = JSON.parse(log[log.length - 1]) as Record<string, unknown>;
  assert.equal(last.symbol, "BBRI");
  assert.equal(last.name, "RSI oversold");
});

test("the message a person reads carries the symbol, the condition and the values", () => {
  const text = telegramText(EVENT, "2026-08-25T03:00:00.000Z");
  assert.match(text, /BBRI/);
  assert.match(text, /RSI oversold/);
  assert.match(text, /rsi14 < 30/);
  assert.match(text, /28\.40/);
  assert.ok(!text.includes(TOKEN));
});
