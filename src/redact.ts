/**
 * Secret redaction. This MCP's whole job is handling a brokerage credential, so every log
 * line and every thrown error/stack must be scrubbed. A stack trace that echoes request
 * headers is the #1 real-world leak vector — treat redaction as load-bearing, not cosmetic.
 */

// JWT-shaped tokens: three base64url segments separated by dots (header.payload.signature).
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// `authorization: Bearer <anything>` in header dumps / curl strings.
const BEARER_RE = /(authorization\s*[:=]\s*bearer\s+)\S+/gi;
// JSON-ish `"refresh_token":"..."` / `refresh_token=...`.
const REFRESH_RE = /("?refresh_token"?\s*[:=]\s*"?)[^"\s,&}]+/gi;
const ACCESS_RE = /("?access_token"?\s*[:=]\s*"?)[^"\s,&}]+/gi;
/**
 * The credentials the trading path adds, none of which is JWT-shaped.
 *
 * `pin` is the six digits that unlock Stockbit Sekuritas. It is entered at a terminal prompt, used
 * for exactly one request, and never stored — but a thrown error or a debug dump that echoed the
 * request body would put it in a log file, which is the one place it must never be. `login_token`
 * is the short-lived exodus grant exchanged for a securities session, and `securities_token` the
 * session itself; both are bearer-equivalent even though neither matches `JWT_RE`.
 *
 * `PIN_RE` is exported because a PIN also has a shape of its own, and the value-level rules below
 * cannot see one that arrives as a bare argument rather than under a key.
 */
export const PIN_RE = /\b\d{6}\b/;
const PIN_FIELD_RE = /("?pin"?\s*[:=]\s*"?)\d{4,8}/gi;
const LOGIN_TOKEN_RE = /("?login_token"?\s*[:=]\s*"?)[^"\s,&}]+/gi;
const SECURITIES_TOKEN_RE = /("?securities_token"?\s*[:=]\s*"?)[^"\s,&}]+/gi;

const MASK = "[REDACTED]";

/** Redact secrets from an arbitrary string. */
export function redact(input: string): string {
  return input
    .replace(BEARER_RE, `$1${MASK}`)
    .replace(REFRESH_RE, `$1${MASK}`)
    .replace(ACCESS_RE, `$1${MASK}`)
    .replace(LOGIN_TOKEN_RE, `$1${MASK}`)
    .replace(SECURITIES_TOKEN_RE, `$1${MASK}`)
    .replace(PIN_FIELD_RE, `$1${MASK}`)
    .replace(JWT_RE, MASK);
}

/** Deep-redact any value (objects/arrays/strings) for safe logging. Returns a new value. */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Drop known-sensitive keys entirely rather than masking their value.
    // The trading credentials join the list rather than getting their own pass: a PIN under a `pin`
    // key is dropped whole, because masking half of six digits still narrows the search space.
    if (/^(authorization|refresh_token|access_token|token|pin|login_token|securities_token)$/i.test(k)) {
      out[k] = MASK;
    } else {
      out[k] = redactValue(v, seen);
    }
  }
  return out;
}

/** Redact an Error's message and stack in place, returning the same error for chaining. */
export function redactError<E extends Error>(err: E): E {
  if (err.message) err.message = redact(err.message);
  if (err.stack) err.stack = redact(err.stack);
  return err;
}

/** stderr logger (stdout is reserved for the MCP stdio transport). Always redacts. */
export function logStderr(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === "string" ? redact(p) : JSON.stringify(redactValue(p))))
    .join(" ");
  process.stderr.write(line + "\n");
}
