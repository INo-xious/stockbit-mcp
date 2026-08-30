/** MCP tool result helpers. Wraps values as text content; converts errors to safe result shapes. */
import { StockbitError } from "../http/errors.js";
import { redactValue } from "../redact.js";

/**
 * The `confirm` blurb for an IRREVERSIBLE commitment — an exchange order, an e-IPO subscription.
 *
 * One wording, shared, because these two are the same risk class and were describing it in two
 * different sets of words. What stays is what a model reading only this schema has to see; the
 * surrounding protocol — two steps, relay the summary verbatim, never resend a non-ok outcome — is
 * in the server instructions, stated once. Do not shorten this further: every clause is
 * load-bearing and ADR-0010 is why.
 *
 * Account writes deliberately do NOT use this: those are reversible in the Stockbit app, and telling
 * a model that renaming a watchlist carries an order's weight teaches it to discount the warning
 * where it matters.
 */
export const COMMITMENT_CONFIRM =
  "Must be true, and only after the user has agreed to THIS ticket's summary in words. Never set it " +
  "on their behalf. Where the client can ask a person directly, it does, and their answer decides " +
  "it either way.";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * An image result, plus a text block carrying the machine-readable summary.
 *
 * Both are returned because a caller that cannot display the image still needs the numbers, and a
 * caller that can still benefits from having them in a form it can quote. The image data is NOT run
 * through `redactValue` — it is base64 of markup this process just generated from data already
 * returned to the caller, and re-encoding it would corrupt it.
 */
function imageResult(
  base64: string,
  mimeType: string,
  summary: unknown,
): ToolResult {
  return {
    content: [
      { type: "image", data: base64, mimeType },
      { type: "text", text: JSON.stringify(redactValue(summary), null, 2) },
    ],
  };
}

/** Serialize a value as a JSON text result (redacted for safety). */
export function jsonResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(redactValue(value), null, 2) }],
    isError,
  };
}

/** Run a core call and format success/failure uniformly. */
export async function runTool<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    return jsonResult({ success: true, data: await fn() });
  } catch (err) {
    if (err instanceof StockbitError) return jsonResult(err.toResult(), true);
    return jsonResult({ success: false, error: String(err) }, true);
  }
}

/** Run a call that produces an image, formatting success/failure the same way `runTool` does. */
export async function runImageTool(
  fn: () => Promise<{ base64: string; mimeType: string; summary: unknown }>,
): Promise<ToolResult> {
  try {
    const { base64, mimeType, summary } = await fn();
    return imageResult(base64, mimeType, summary);
  } catch (err) {
    if (err instanceof StockbitError) return jsonResult(err.toResult(), true);
    return jsonResult({ success: false, error: String(err) }, true);
  }
}
