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
  | "challenge" // 403 + cf-mitigated: a browser challenge, NOT an entitlement problem
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

/**
 * Whether a 403 is Cloudflare asking for a browser challenge rather than Stockbit refusing.
 *
 * These look identical from the status line and mean opposite things. A real 403 says "this account
 * cannot do that" and the fix is entitlement or a PIN; a challenge says "prove you are a browser"
 * and the fix is to run the flow through the logged-in browser instead. Cloudflare marks the
 * difference with a `cf-mitigated: challenge` response header, and reading it turns a dead end into
 * a next step.
 *
 * This project has twice explained a 403 with a guess — once the Rp 10,000,000 balance requirement,
 * once a Chartbit paywall — and been wrong both times. When the server labels its own refusal,
 * read the label.
 */
export function isChallenge(status: number, headers: Headers): boolean {
  return status === 403 && (headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge";
}

/** The error for a Cloudflare challenge, naming the command that gets past it. */
export function challengeError(route: string): StockbitError {
  return new StockbitError(
    "challenge",
    `Cloudflare asked ${route} to complete a browser challenge (HTTP 403, cf-mitigated: challenge). ` +
      "This is NOT an entitlement or PIN problem — the request never reached Stockbit's handler. " +
      "Re-run the step through the logged-in browser: `stockbit-auth trading-login --browser`.",
    { status: 403 },
  );
}
