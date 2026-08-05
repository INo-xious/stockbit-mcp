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
 *     the one channel that sends data off the machine, and that should be a thing the user turned
 *     on deliberately, not a default they discover later. The URL must be https (or explicit
 *     localhost) so a typo cannot silently downgrade to plaintext.
 *
 * Nothing here is a trading action. A notification is the whole feature; this project cannot place
 * an order and must not look like it might.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AlertEvaluation } from "./rules.js";

export interface DeliveryResult {
  logged: boolean;
  desktop: "sent" | "failed" | "disabled";
  webhook: "sent" | "failed" | "disabled";
  errors: string[];
}

function stockbitDir(): string {
  return process.env.STOCKBIT_STORE_DIR || join(homedir(), ".stockbit");
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

/* ------------------------------------ delivery ------------------------------------ */

export interface DeliveryOptions {
  desktop?: boolean;
  webhookUrl?: string;
}

/**
 * Deliver one fired alert. The log is written first and always; other channels are best-effort and
 * their failures are reported rather than thrown, so one broken channel cannot stop the next alert.
 */
export async function deliver(event: AlertEvaluation, at: string, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const result: DeliveryResult = { logged: false, desktop: "disabled", webhook: "disabled", errors: [] };

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

  return result;
}
