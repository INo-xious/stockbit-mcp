/**
 * Getting a fired alert in front of the user.
 *
 * ## Why there is always a log, and why it is first
 *
 * Every other channel can fail in a way nobody notices: a toast appears while the screen is locked,
 * a webhook 500s, a notification daemon is not running. An alert that fired and was never seen is
 * worse than one that never fired, because the user believes they are being watched. So the JSONL
 * log is written **before** anything else is attempted and is not optional — whatever else happens,
 * there is a durable record with a timestamp, and `alerts.log` is the answer to "did it actually
 * fire?".
 *
 * ## Channels
 *
 *   - **log** — always. Append-only JSONL at `~/.stockbit/alerts.log`.
 *   - **desktop** — a native notification, on by default because it needs nothing configured.
 *     Best-effort: it is one spawn with a short timeout, and a failure is recorded rather than
 *     raised, since a missing notification daemon must not stop the next alert being delivered.
 *   - **webhook** — only when `STOCKBIT_ALERT_WEBHOOK` is set. Off by default on purpose: this is
 *     a channel that sends data off the machine, and that should be a thing the user turned on
 *     deliberately, not a default they discover later. The URL must be https (or explicit
 *     localhost) so a typo cannot silently downgrade to plaintext.
 *   - **Telegram** — only when both `STOCKBIT_TELEGRAM_BOT_TOKEN` and `STOCKBIT_TELEGRAM_CHAT_ID`
 *     are set. This is the channel that reaches a phone, which is the point: a desktop toast fires
 *     at a laptop that is shut. It sends off-machine like the webhook does, and the same rule
 *     applies — the Bot API is https-only, so there is nothing to downgrade.
 *
 * ## The Telegram token lives in the URL
 *
 * The Bot API puts the bot token in the request **path**, not a header. So any error message that
 * quotes the URL carries the credential in full, and whoever reads that log can send as the bot
 * until it is revoked. Every failure string from `postTelegram` is therefore built from the status
 * code and the error's name — never from the URL, and never from the exception's own message. The
 * token is also matched by shape in `src/redact.ts`, as a second line rather than the first.
 *
 * Tokens come from the environment only. A `--telegram-token` flag would put the credential in the
 * process table, where every other user on the machine can read it with `ps`.
 *
 * Nothing here is a trading action. A notification is the whole feature; this project cannot place
 * an order and must not look like it might.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AlertEvaluation } from "./rules.js";
import { stockbitDir } from "../paths.js";

export interface DeliveryResult {
  logged: boolean;
  desktop: "sent" | "failed" | "disabled";
  webhook: "sent" | "failed" | "disabled";
  telegram: "sent" | "failed" | "disabled";
  errors: string[];
}

export function alertLogPath(): string {
  return join(stockbitDir(), "alerts.log");
}

/** One line of JSON per fired alert, appended. Never rewritten, so history cannot be lost. */
export function logAlert(event: AlertEvaluation, at: string): void {
  mkdirSync(stockbitDir(), { recursive: true });
  const line = JSON.stringify({
    at,
    ruleId: event.ruleId,
    symbol: event.symbol,
    name: event.name,
    condition: event.condition,
    barDate: event.barDate,
    left: event.leftValue,
    right: event.rightValue,
  });
  appendFileSync(alertLogPath(), `${line}\n`, "utf8");
}

/** Human text for a fired alert. Kept short: a notification that is truncated says nothing. */
export function alertTitle(event: AlertEvaluation): string {
  return `${event.symbol} — ${event.name}`;
}

export function alertBody(event: AlertEvaluation): string {
  const values =
    event.leftValue !== null && event.leftValue !== undefined
      ? ` (${round(event.leftValue)} vs ${round(event.rightValue ?? 0)})`
      : "";
  return `${event.condition}${values} · ${event.barDate ?? ""}`.trim();
}

function round(value: number): string {
  return Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(2);
}

/* ------------------------------------ desktop ------------------------------------ */

/**
 * Escape a string for embedding in a single-quoted PowerShell literal, where `'` doubles.
 *
 * The alert name is user-supplied and reaches a shell-adjacent context; without this a name
 * containing a quote breaks the command, and a crafted one could append to it.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escape for an AppleScript double-quoted string. */
export function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function desktopCommand(title: string, body: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", `display notification ${osaQuote(body)} with title ${osaQuote(title)}`],
    };
  }
  if (process.platform === "win32") {
    // WinRT toast via PowerShell. No module to install — ToastNotificationManager ships with the OS.
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null",
      "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      `$n = $t.GetElementsByTagName('text'); $n[0].AppendChild($t.CreateTextNode(${psQuote(title)})) > $null; $n[1].AppendChild($t.CreateTextNode(${psQuote(body)})) > $null`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Stockbit MCP').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
    ].join("; ");
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  return { command: "notify-send", args: [title, body] };
}

/** Fire a desktop notification. Resolves to an error string, or null on success. */
export function notifyDesktop(title: string, body: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { command, args } = desktopCommand(title, body);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      done(err instanceof Error ? err.message : String(err));
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      done(err.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? null : `exit ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`);
    });
  });
}

/* ------------------------------------ webhook ------------------------------------ */

/**
 * Accept a webhook URL only if it cannot silently send in plaintext.
 *
 * https anywhere, or http on loopback for someone wiring this into a local script. An http URL to a
 * remote host is refused rather than downgraded, because the payload names the user's watchlist.
 */
export function isAcceptableWebhook(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
}

async function postWebhook(url: string, payload: unknown, timeoutMs = 8000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // A redirect would move the payload to an origin the user never approved.
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) return `refused to follow a redirect (HTTP ${res.status})`;
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------ telegram ------------------------------------ */

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/**
 * Read a Telegram target from the environment, or null when it is not configured.
 *
 * Both halves are required and the chat id is validated: `getUpdates` returns it as a number and a
 * group's is negative, so `/^-?\d+$/` is the whole vocabulary. A user who pasted an @username here
 * gets no delivery rather than a per-alert HTTP 400 in the log — the shape is checked once, at
 * startup, where the message can say what to fix.
 */
export function telegramTargetFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramTarget | null {
  const botToken = env.STOCKBIT_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.STOCKBIT_TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return null;
  if (!/^-?\d+$/.test(chatId)) return null;
  return { botToken, chatId };
}

/**
 * Send one message. Resolves to an error string, or null on success.
 *
 * The error string is built from the status code and the error's `name` — never from the URL and
 * never from `err.message`, either of which can quote the request and therefore the token.
 *
 * Plain text with no `parse_mode`: an alert name is user-supplied, and under Markdown or HTML an
 * unbalanced `*` or `<` makes Telegram reject the whole message. The alert that fires is exactly
 * the one you cannot afford to lose to a formatting error.
 */
export async function postTelegram(
  target: TelegramTarget,
  text: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target.chatId, text, disable_web_page_preview: true }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) return `refused to follow a redirect (HTTP ${res.status})`;
    if (res.ok) return null;
    // Deliberately not the body: Telegram echoes parts of the request in its error descriptions.
    return `HTTP ${res.status}`;
  } catch (err) {
    // `err.message` on a fetch failure routinely contains the full URL. Only the class is safe.
    return err instanceof Error ? `request failed (${err.name})` : "request failed";
  } finally {
    clearTimeout(timer);
  }
}

/** What a fired alert looks like in a chat window. */
export function telegramText(event: AlertEvaluation, at: string): string {
  return `${alertTitle(event)}\n${alertBody(event)}\n${at}`;
}

/* ------------------------------------ delivery ------------------------------------ */

export interface DeliveryOptions {
  desktop?: boolean;
  webhookUrl?: string;
  /** A target, or `false` to skip the channel even when the environment configures one. */
  telegram?: TelegramTarget | false;
}

/**
 * Deliver one fired alert. The log is written first and always; other channels are best-effort and
 * their failures are reported rather than thrown, so one broken channel cannot stop the next alert.
 */
export async function deliver(event: AlertEvaluation, at: string, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const result: DeliveryResult = {
    logged: false,
    desktop: "disabled",
    webhook: "disabled",
    telegram: "disabled",
    errors: [],
  };

  try {
    logAlert(event, at);
    result.logged = true;
  } catch (err) {
    result.errors.push(`log: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (options.desktop !== false) {
    const error = await notifyDesktop(alertTitle(event), alertBody(event));
    result.desktop = error ? "failed" : "sent";
    if (error) result.errors.push(`desktop: ${error}`);
  }

  const url = options.webhookUrl ?? process.env.STOCKBIT_ALERT_WEBHOOK?.trim();
  if (url) {
    if (!isAcceptableWebhook(url)) {
      result.webhook = "failed";
      result.errors.push("webhook: must be https, or http on localhost");
    } else {
      const error = await postWebhook(url, {
        at,
        symbol: event.symbol,
        name: event.name,
        condition: event.condition,
        barDate: event.barDate,
        left: event.leftValue,
        right: event.rightValue,
        source: "stockbit-mcp",
      });
      result.webhook = error ? "failed" : "sent";
      if (error) result.errors.push(`webhook: ${error}`);
    }
  }

  // Last, because it is the slowest and the least likely to be configured. The log has already been
  // written, so a Telegram outage costs the notification, never the record.
  const telegram = options.telegram === false ? null : (options.telegram ?? telegramTargetFromEnv());
  if (telegram) {
    const error = await postTelegram(telegram, telegramText(event, at));
    result.telegram = error ? "failed" : "sent";
    if (error) result.errors.push(`telegram: ${error}`);
  }

  return result;
}
