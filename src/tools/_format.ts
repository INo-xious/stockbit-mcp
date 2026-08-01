/** MCP tool result helpers. Wraps values as text content; converts errors to safe result shapes. */
import { StockbitError } from "../http/errors.js";
import { redactValue } from "../redact.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
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
