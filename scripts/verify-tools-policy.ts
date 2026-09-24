/** A verification report carries coverage, never upstream error prose or account payloads. */
const ERROR_KINDS = new Set([
  "auth", "challenge", "not_found", "invalid_param", "rate_limited", "upstream", "schema_drift", "unknown",
]);
const MCP_CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32000]);

export interface VerificationFailure {
  status: "blocked" | "failed";
  note: string;
  errorKind?: string;
  httpStatus?: number;
  protocolCode?: number;
}

/** Raw details are used only for classification in memory; no part of them is returned. */
export function summarizeVerificationFailure(value: unknown, detail?: string): VerificationFailure {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const errorKind = typeof record.kind === "string" && ERROR_KINDS.has(record.kind) ? record.kind : undefined;
  const httpStatus = typeof record.status === "number" && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599
    ? record.status : undefined;
  const protocolCode = typeof record.code === "number" && MCP_CODES.has(record.code) ? record.code : undefined;
  const text = detail ?? (value instanceof Error ? value.message : typeof value === "string" ? value : "");
  const handoffUnavailable = httpStatus === 404 && /handoff/i.test(text);
  const blocked = errorKind === "auth" || errorKind === "challenge" || httpStatus === 401 || httpStatus === 403 ||
    /auth|log.?in|session|credential|subscription|premium|entitlement|not.enabled|paper mode|permission|cloudflare/i.test(text);
  return {
    status: blocked ? "blocked" : "failed",
    note: handoffUnavailable
      ? "Stockbit's session handoff endpoint is unavailable (404); the dependent capability could not run."
      : blocked
      ? "Authentication, account access, or an interactive prerequisite is required; response details were not saved."
      : "The MCP call failed; response details were not saved.",
    ...(errorKind ? { errorKind } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    ...(protocolCode ? { protocolCode } : {}),
  };
}

/** Some historical read annotations cover local mutations or browser effects. Exclude them. */
export function verificationSkipReason(name: string, readOnly: boolean): string | undefined {
  if (name.startsWith("paper_")) return "Local paper tools can settle the ledger or issue tickets; use isolated fixture tests.";
  if (name === "workflow_run") return "Workflows can render files or update alerts; verify their individual reads instead.";
  if (!readOnly || new Set([
    "alert_create", "alert_delete", "stockbit_web", "chartbit_open", "chartbit_shapes", "chartbit_screenshot", "trading_forget",
  ]).has(name)) {
    return "Mutation/browser tool: covered by isolated tests; requires a separate controlled live scenario.";
  }
  return undefined;
}
