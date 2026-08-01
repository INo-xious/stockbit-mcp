/**
 * Typed errors + mapping of Stockbit's grpc-gateway error envelope.
 *
 * Observed envelope shape:
 *   { "message": "...", "error_type": "INVALID_PARAMETER",
 *     "errors": [{ "key": "...", "error": "..." }] }
 * (404s return a short 34-byte body with no envelope.)
 */
import { redact } from "../redact.js";

export type ErrorKind =
  | "auth" // 401/403 — token missing/expired/invalid; re-bootstrap needed
  | "not_found" // 404 — wrong path/host or symbol has no data
  | "invalid_param" // 400 — bad/missing parameters
  | "rate_limited" // 429
  | "upstream" // 5xx / network
  | "schema_drift" // response didn't match the expected shape
  | "unknown";

export class StockbitError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly errorType?: string;
  readonly details?: Array<{ key?: string; error?: string }>;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: {
      status?: number;
      errorType?: string;
      details?: Array<{ key?: string; error?: string }>;
    } = {},
  ) {
    super(redact(message));
    this.name = "StockbitError";
    this.kind = kind;
    this.status = opts.status;
    this.errorType = opts.errorType;
    this.details = opts.details;
  }

  /** Compact, safe-to-return summary for MCP tool output. */
  toResult(): { success: false; error: string; kind: ErrorKind; status?: number } {
    return { success: false, error: this.message, kind: this.kind, status: this.status };
  }
}

interface GatewayEnvelope {
  message?: string;
  error_type?: string;
  errors?: Array<{ key?: string; error?: string }>;
}

function kindForStatus(status: number): ErrorKind {
  if (status === 400) return "invalid_param";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "unknown";
}

/** Build a StockbitError from an HTTP response status + parsed/raw body. */
export function mapHttpError(status: number, body: unknown): StockbitError {
  const kind = kindForStatus(status);
  let message = `HTTP ${status}`;
  let errorType: string | undefined;
  let details: Array<{ key?: string; error?: string }> | undefined;

  if (body && typeof body === "object") {
    const env = body as GatewayEnvelope;
    if (env.message) message = env.message;
    errorType = env.error_type;
    details = env.errors;
  } else if (typeof body === "string" && body.trim()) {
    message = body.slice(0, 200);
  }

  return new StockbitError(kind, message, { status, errorType, details });
}
