/**
 * Unlocking the Stockbit Sekuritas session for read-only brokerage access.
 *
 * ## The chain
 *
 *   1. `GET exodus/sekuritas/auth/token` → `{data: {token, target: "2"}}`, authorised by the ordinary
 *      market-data session.
 *   2. `POST carina/auth/v2/login {login_token, pin}` → `{access_token, refresh_token}`.
 *   3. The refresh token is persisted in its own store slot. The access token is seeded in memory.
 *
 * ## The PIN
 *
 * Six digits, typed at a hidden terminal prompt, used for exactly one request, and then gone. It is
 * never written to disk, never logged, never returned, and **no MCP tool accepts one** — a model
 * driving this server cannot ask for it, cannot pass it, and cannot see it. That is ADR-0004's
 * central rule and the reason this module lives in `src/auth/` and is called only by the CLI.
 *
 * `src/redact.ts` drops `pin` from every log line as a second line of defence, because the first
 * line — "we never log it" — is a claim about code that will be edited.
 *
 * ## Cloudflare
 *
 * The carina login sits behind Turnstile, and a 403 with `cf-mitigated: challenge` means the request
 * never reached Stockbit's handler. That is not an entitlement problem and not a wrong PIN, and
 * saying so matters: the natural response to "403 on a PIN login" is to retype the PIN, which is
 * both useless and how an account gets locked. The `--browser` path exists for exactly this case.
 */
import { getJson, postJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { getStore } from "./store.js";
import { withCredentialLock } from "./reflock.js";
import { clearAccessCache, writeAccessCache } from "./accesscache.js";
import { clearSessionHealth } from "./health.js";
import { adoptAccessToken, forgetRotated, parseRefresh, resetSession } from "./session.js";

/**
 * Parse the securities grant without mistaking an ordinary access/refresh token for it.
 *
 * Observed 2026-09-24: data.token plus data.target="2". Public frontend build
 * eCXUv0YjiEIhDng_Km-2W, chunk 91095-87012d64a1c5344a.js, proves the mapping:
 * module71515 NEW_CORE="2", module91892 JI checks that target, and module8346
 * postAuthPIN selects carina only when JI is true. Target "1" selects legacy MAS,
 * which is not an allowed credential origin here.
 *
 * Keep the older explicit login_token/loginToken envelope forms, but never ignore
 * an explicit target on the record or its ancestors. Generic `token` keys are
 * accepted only in the observed data.token location with target 2.
 */
export function parseSecuritiesGrant(body: unknown): string {
  const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (row?.error || row?.error_type || row?.success === false) {
    throw new StockbitError("auth", "Stockbit refused the securities login grant. No PIN or grant was submitted.");
  }
  const requireCarina = (target: unknown): void => {
    if (target !== "2" && target !== 2) {
      throw new StockbitError(
        "auth",
        "Stockbit selected an unsupported securities backend. No PIN or grant was submitted. " +
          "Direct login supports Stockbit Sekuritas target 2 only; sign in through the Stockbit website for this account.",
      );
    }
  };
  const tokenString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const data = row?.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown> : undefined;
  if (data && "token" in data) {
    if (row && "target" in row) requireCarina(row.target);
    if (!("target" in data)) {
      throw new StockbitError("schema_drift", "The securities grant did not identify its brokerage target. No PIN or grant was submitted.");
    }
    requireCarina(data.target);
    if (tokenString(data.token)) return data.token;
  }

  const seen = new Set<object>();
  const walk = (value: unknown, targets: unknown[] = []): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const current = value as Record<string, unknown>;
    const inherited = "target" in current ? [...targets, current.target] : targets;
    for (const [key, child] of Object.entries(current)) {
      if (/^login_?token$/i.test(key) && tokenString(child)) {
        inherited.forEach(requireCarina);
        return child;
      }
      const nested = walk(child, inherited);
      if (nested) return nested;
    }
    return undefined;
  };
  const token = walk(body);
  if (token) return token;
  throw new StockbitError(
    "schema_drift",
    "Stockbit returned an unrecognized securities login grant. No PIN or grant was submitted. " +
      "The main session answered successfully; this response does not establish that it expired.",
  );
}

export interface TradingLoginResult {
  /** Where the refresh token was stored. */
  backend: "keychain" | "file";
  /** True when a fresh access token was seeded from the login response. */
  accessSeeded: boolean;
}

/**
 * Exchange the market-data session plus a PIN for a securities session.
 *
 * `pin` exists only in this function's stack frame and in the request body. It is not returned, not
 * stored, and not included in any error message this function throws.
 */
export async function loginSecurities({ pin }: { pin: string }): Promise<TradingLoginResult> {
  if (!/^\d{4,8}$/.test(pin)) {
    // Says what is wrong with the SHAPE without echoing the value.
    throw new StockbitError("invalid_param", "The trading PIN must be 4–8 digits.");
  }

  const grantBody = await getJson("sekuritasAuthToken");
  const loginToken = parseSecuritiesGrant(grantBody);

  let loginResponse: unknown;
  try {
    loginResponse = await postJson("carinaAuthLogin", {
      body: { login_token: loginToken, pin },
    });
  } catch (error) {
    // Do not depend on key-based redaction if an upstream error echoes a bare PIN
    // or opaque grant. Rebuild the error so its message, details, and stack are safe.
    const scrub = (text: string) => text.split(pin).join("[REDACTED]").split(loginToken).join("[REDACTED]");
    if (error instanceof StockbitError) {
      throw new StockbitError(error.kind, scrub(error.message), {
        status: error.status,
        errorType: error.errorType ? scrub(error.errorType) : undefined,
        details: error.details?.map((item) => ({
          key: item.key ? scrub(item.key) : undefined,
          error: item.error ? scrub(item.error) : undefined,
        })),
      });
    }
    throw new StockbitError("upstream", scrub(error instanceof Error ? error.message : String(error)));
  }

  let parsed: ReturnType<typeof parseRefresh>;
  try {
    parsed = parseRefresh(loginResponse);
  } catch {
    throw new StockbitError(
      "auth",
      "The securities login succeeded but no access token could be found in the response. " +
        "Re-run with STOCKBIT_DEBUG=1 to print the response SHAPE (keys and types, never values).",
    );
  }

  if (!parsed.newRefresh) {
    throw new StockbitError(
      "auth",
      "The securities login returned an access token but no refresh token, so the session could not be " +
        "persisted. Nothing was stored.",
    );
  }

  const store = getStore("securities");
  await withCredentialLock("securities", () => store.set(parsed.newRefresh!));
  // Seed the access token rather than throwing it away: the alternative is an immediate refresh
  // that spends the token we were just handed.
  adoptAccessToken("securities", parsed.access, parsed.expiresAt, parsed.newRefresh);
  // The CLI exits after login. Share the fresh access token through the existing encrypted,
  // refresh-bound cache so the MCP process can use this session without an immediate rotation.
  writeAccessCache("securities", parsed.access, parsed.expiresAt, parsed.newRefresh);
  clearSessionHealth("securities");

  // A refused Keychain write swaps the active store to encrypted-file fallback.
  // The captured `store` object still says keychain, so ask the active selector again.
  return { backend: getStore("securities").backend, accessSeeded: true };
}

/** Prove the adopted access token works with a read, without rotating a fresh refresh token. */
export async function verifySecuritiesSession(): Promise<void> {
  const response = await getJson("portfolioList");
  if (!response || typeof response !== "object") {
    throw new StockbitError("schema_drift", "The securities portfolio check returned an unrecognized response.");
  }
  const envelope = response as Record<string, unknown>;
  if (envelope.error || envelope.error_type || envelope.success === false || !("data" in envelope)) {
    throw new StockbitError("schema_drift", "The securities portfolio check did not return usable data. The stored session was retained.");
  }
}

/**
 * End the securities session.
 *
 * The server-side logout is best-effort: if it fails, the local credential is still dropped, because
 * "logout" must mean the token is gone from this machine whatever the network did. Reporting the
 * remote failure is still worthwhile — a session Stockbit still considers open is a fact the user
 * may want to act on in their app.
 */
export async function logoutSecurities(): Promise<{ remote: "ok" | "skipped" | string; cleared: boolean }> {
  const store = getStore("securities");
  let remote: "ok" | "skipped" | string = "skipped";

  if (store.get()) {
    try {
      await postJson("carinaAuthLogout", { body: {} });
      remote = "ok";
    } catch (err) {
      remote = err instanceof Error ? err.message : String(err);
    }
  }

  await withCredentialLock("securities", () => store.clear());
  // The access token too. This function's own doc says a logout "must mean the token is gone from
  // this machine whatever the network did" — and the carina ACCESS token is a bearer credential for
  // the brokerage account, good for up to 24 hours, sitting in a file whose key anything running as
  // this user can derive. It matters most in the case this function already handles specially: the
  // remote logout failing, leaving the session open at Stockbit's end as well.
  clearAccessCache("securities");
  clearSessionHealth("securities");
  // And any rotated token this process rescued but could not persist — see `forgetRotated`. Without
  // this, a trading-logout on a locked Keychain reports success and the session is live again on
  // the next call.
  forgetRotated("securities");
  resetSession("securities");
  return { remote, cleared: true };
}
