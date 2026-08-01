/**
 * One-time bootstrap: take a refresh token captured from a real login (Network tab), validate it
 * by performing one refresh, and persist it to the store. See STOCKBIT-API.md §3 / plan Step 0.
 */
import { getStore } from "./store.js";
import { forceRefresh, decodeJwt, resetSession } from "./session.js";
import { logStderr } from "../redact.js";

export interface BootstrapResult {
  backend: "keychain" | "file";
  refreshExp?: number;
  accessOk: boolean;
}

/**
 * Store `refreshToken`, then try one refresh to prove it works. On failure the token is still
 * stored (so the user can retry a refresh later), but we report accessOk=false.
 */
export async function bootstrap(refreshToken: string): Promise<BootstrapResult> {
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

  let accessOk = false;
  try {
    await forceRefresh();
    accessOk = true;
  } catch (err) {
    logStderr("Warning: stored the refresh token but a test refresh failed:", String(err));
  }

  return { backend: store.backend, refreshExp, accessOk };
}
