/**
 * Where alert rules live between processes.
 *
 * A plain JSON file under `~/.stockbit`, beside the credential store and the charts. Not the
 * encrypted store: a rule is "tell me when BBRI's RSI drops below 30", which is not a secret, and
 * putting it behind the Keychain would make it unreadable to the user who wrote it.
 *
 * Writes go through the same temp-file-then-rename dance as the credential store, for the same
 * reason: more than one process runs this server (Claude Code and Claude Desktop each spawn their
 * own), and a truncating in-place write that loses a race leaves a half-written file that parses as
 * nothing. Losing every alert to an interrupted write would be silent — the next read would just
 * report no rules, which is indistinguishable from never having created any.
 *
 * `rename` is atomic within a filesystem, so a concurrent reader sees either the old set or the new
 * one. It does NOT make two concurrent *writers* safe: last rename wins, and a rule added by the
 * loser is lost. That is a real limitation and it is bounded — rules are created by hand, one at a
 * time, so the window is small. The refresh token had the same shape of problem and needed a lock
 * because rotation made every write load-bearing; here a lost write is a rule the user can see is
 * missing and add again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AlertRule } from "./rules.js";
import { stockbitDir as alertsDir } from "../paths.js";

function alertsPath(): string {
  return join(alertsDir(), "alerts.json");
}

interface AlertsFile {
  version: 1;
  rules: AlertRule[];
}

/**
 * Read every rule.
 *
 * A corrupt or unreadable file yields an empty list rather than throwing: alerts are a side feature,
 * and taking down every tool in the server because one JSON file got mangled is the wrong trade.
 * The file is left in place so it can be inspected rather than silently rewritten.
 */
export function loadRules(): AlertRule[] {
  const path = alertsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AlertsFile;
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

/** Replace the rule set atomically. */
export function saveRules(rules: AlertRule[]): void {
  mkdirSync(alertsDir(), { recursive: true });
  const target = alertsPath();
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const body: AlertsFile = { version: 1, rules };
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** A short, collision-resistant id. Random rather than sequential so two processes cannot clash. */
export function newRuleId(): string {
  return randomBytes(6).toString("hex");
}

export function addRule(rule: AlertRule): AlertRule {
  const rules = loadRules();
  rules.push(rule);
  saveRules(rules);
  return rule;
}

/** Remove by id. Returns the removed rule, or null when there was nothing to remove. */
export function removeRule(id: string): AlertRule | null {
  const rules = loadRules();
  const index = rules.findIndex((r) => r.id === id);
  if (index < 0) return null;
  const [removed] = rules.splice(index, 1);
  saveRules(rules);
  return removed;
}

/**
 * Apply a change to one rule, re-reading first.
 *
 * Read-modify-write against the file rather than against a caller's stale copy, so recording a fire
 * does not resurrect a rule another process just deleted.
 */
export function updateRule(id: string, change: Partial<AlertRule>): AlertRule | null {
  const rules = loadRules();
  const found = rules.find((r) => r.id === id);
  if (!found) return null;
  Object.assign(found, change, { id: found.id });
  saveRules(rules);
  return found;
}
