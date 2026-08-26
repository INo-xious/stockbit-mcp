/**
 * Unlocking the Stockbit Sekuritas session — the credential every trading read and write needs.
 *
 * ## The chain
 *
 *   1. `GET exodus/sekuritas/auth/token` → a short-lived `login_token`, authorised by the ordinary
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
import { adoptAccessToken, parseRefresh, resetSession } from "./session.js";

/** The `login_token` grant, wherever the envelope puts it. */
function findLoginToken(body: unknown): string | undefined {
  const seen = new Set<object>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^login_?token$/i.test(key) && typeof child === "string" && child) return child;
      const nested = walk(child);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(body);
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
  const loginToken = findLoginToken(grantBody);
  if (!loginToken) {
    throw new StockbitError(
      "auth",
      "Stockbit did not return a securities login token. Your market-data session may have expired — " +
        "run `stockbit-auth login` and try again.",
    );
  }

  const loginResponse = await postJson("carinaAuthLogin", {
    body: { login_token: loginToken, pin },
  });

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
  adoptAccessToken("securities", parsed.access, parsed.expiresAt);

  return { backend: store.backend, accessSeeded: true };
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
  resetSession("securities");
  return { remote, cleared: true };
}
