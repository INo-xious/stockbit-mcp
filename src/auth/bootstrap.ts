/**
 * One-time bootstrap: take a refresh token captured from a real login (Network tab), persist it, and
 * check it looks usable. See docs/stockbit-api.md §3.
 *
 * Validation is LOCAL by default, and that is the whole point. Stockbit's refresh endpoint rotates:
 * spending a token retires the previous one, and the website session in the Chartbit browser profile
 * is holding that previous one. So a "test refresh" here reaches across and logs the user out of the
 * website — the same defect `cmdLogin` was rewritten to remove, which lived on in this path because
 * `bootstrap` and `import-har` share it. Pass `verify` to opt back into the round trip.
 */
import { getStore } from "./store.js";
import { forceRefresh, decodeJwt, resetSession } from "./session.js";
import { logStderr } from "../redact.js";

export interface BootstrapResult {
  backend: "keychain" | "file";
  refreshExp?: number;
  /** Whether the token is usable. Locally judged unless `verify` was set. */
  accessOk: boolean;
  /** True when `accessOk` came from a live refresh rather than a local expiry check. */
  verified: boolean;
}

export interface BootstrapOptions {
  /**
   * Prove the token by actually refreshing it. Costs the caller their website session, because the
   * refresh rotates the family the browser is also holding.
   */
  verify?: boolean;
}

/**
 * Store `refreshToken` and report whether it looks usable. On a failed verification the token is
 * still stored, so the user can retry later, and `accessOk` is false.
 */
export async function bootstrap(refreshToken: string, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const trimmed = refreshToken.trim();
  if (!trimmed) throw new Error("Empty refresh token");

  const store = getStore();
  store.set(trimmed);
  resetSession();

  const payload = decodeJwt(trimmed);
  const refreshExp = typeof payload["exp"] === "number" ? (payload["exp"] as number) : undefined;
  if (refreshExp) {
    const days = ((refreshExp - Date.now() / 1000) / 86400).toFixed(1);
    logStderr(`Refresh token expires in ~${days} day(s).`);
  }

  if (!options.verify) {
    // A token that decodes and has not expired is as much as can be known without spending it.
    const expired = refreshExp !== undefined && refreshExp - Date.now() / 1000 <= 0;
    if (expired) logStderr("Warning: that token is already expired.");
    return { backend: store.backend, refreshExp, accessOk: !expired, verified: false };
  }

  let accessOk = false;
  try {
    await forceRefresh();
    accessOk = true;
    logStderr("Note: the test refresh rotated the token, so any existing website session is now stale.");
  } catch (err) {
    logStderr("Warning: stored the refresh token but a test refresh failed:", String(err));
  }

  return { backend: store.backend, refreshExp, accessOk, verified: true };
}
