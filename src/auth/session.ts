/**
 * Session manager: holds the short-lived access token in memory and mints fresh ones from the
 * stored refresh token via POST /auth/refresh.
 *
 * ⚠️ Plan Step 0 (unconfirmed until a real refresh is observed):
 *   - the exact refresh host/response field names, and that this renews the MAIN/exodus bearer
 *   - whether refresh ROTATES the refresh token (returns a new one)
 * The code below handles rotation defensively: if the response carries a new refresh_token we
 * persist it immediately. If those assumptions change, adjust AUTH in config.ts + parseRefresh().
 */
import { AUTH } from "../config.js";
import { getStore } from "./store.js";
import { acquireRefreshLock } from "./reflock.js";
import { StockbitError } from "../http/errors.js";
import { authenticatedRequest } from "../http/transport.js";
import { redact } from "../redact.js";

interface AccessToken {
  token: string;
  /** epoch seconds */
  expiresAt: number;
}

let current: AccessToken | null = null;
let inFlight: Promise<AccessToken> | null = null;

/** Decode a JWT payload without verifying (we only read exp). Returns {} on failure. */
export function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) return {};
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function expFromJwt(token: string, fallbackSeconds = 3600): number {
  const exp = decodeJwt(token)["exp"];
  return typeof exp === "number" ? exp : Math.floor(Date.now() / 1000) + fallbackSeconds;
}

interface NestedToken {
  token: string;
  expired_at?: unknown;
  expires_at?: unknown;
}

/** Find an `access` or `refresh` object containing a token through API response envelopes. */
function findNestedToken(value: unknown, kind: "access" | "refresh"): NestedToken | undefined {
  const seen = new Set<object>();
  const keyPattern = kind === "access" ? /^(access|access_token)$/i : /^(refresh|refresh_token)$/i;

  const walk = (current: unknown): NestedToken | undefined => {
    if (!current || typeof current !== "object" || seen.has(current)) return undefined;
    seen.add(current);

    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (keyPattern.test(key)) {
        if (typeof child === "string" && child) return { token: child };
        if (child && typeof child === "object") {
          const tokenObject = child as Record<string, unknown>;
          if (typeof tokenObject.token === "string" && tokenObject.token) {
            return {
              token: tokenObject.token,
              expired_at: tokenObject.expired_at,
              expires_at: tokenObject.expires_at,
            };
          }
        }
      }

      const nested = walk(child);
      if (nested) return nested;
    }
    return undefined;
  };

  return walk(value);
}

/** Describe response keys and value types without ever logging credential values. */
function responseShape(value: unknown, depth = 0): unknown {
  if (depth >= 8) return "object";
  if (Array.isArray(value)) return value.length ? [responseShape(value[0], depth + 1)] : [];
  if (!value || typeof value !== "object") return typeof value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      responseShape(child, depth + 1),
    ]),
  );
}

/** Normalize the /login/refresh response into an access token (+ optional rotated refresh token). */
export function parseRefresh(body: unknown): { access: string; newRefresh?: string; expiresAt: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  // /login/refresh nests as { data: { data: {...} } }; also accept a single { data } or a bare object.
  let d = (b.data ?? b) as Record<string, unknown>;
  if (d && typeof d === "object" && "data" in d && typeof d.data === "object") {
    d = d.data as Record<string, unknown>;
  }

  // Current login/refresh responses use
  // { token_data: { access: { token, expired_at }, refresh: { token, expired_at } } }.
  const loginData = d.login as Record<string, unknown> | undefined;
  const tokenData = (
    d.token_data ?? d.tokenData ?? loginData?.token_data ?? loginData?.tokenData
  ) as Record<string, unknown> | undefined;
  const accessData = tokenData?.access as Record<string, unknown> | undefined;
  const refreshData = tokenData?.refresh as Record<string, unknown> | undefined;
  const nestedAccess = findNestedToken(d, "access");
  const nestedRefresh = findNestedToken(d, "refresh");
  const access =
    (d.access_token as string) ??
    (d.token as string) ??
    (d.accessToken as string) ??
    (accessData?.token as string) ??
    nestedAccess?.token;
  if (typeof access !== "string" || !access) {
    throw new StockbitError("auth", "Refresh response missing access token");
  }
  const newRefresh =
    (d.refresh_token as string) ??
    (d.refreshToken as string) ??
    (refreshData?.token as string) ??
    nestedRefresh?.token ??
    undefined;
  // Prefer explicit expiry; else read the JWT's exp.
  const explicit =
    d.expired_at ??
    d.expires_at ??
    d.expiresAt ??
    accessData?.expired_at ??
    accessData?.expires_at ??
    nestedAccess?.expired_at ??
    nestedAccess?.expires_at;
  const parsedDate = typeof explicit === "string" ? Date.parse(explicit) : Number.NaN;
  const expiresAt =
    typeof explicit === "number"
      ? explicit
      : typeof explicit === "string" && /^\d+$/.test(explicit)
        ? Number(explicit)
        : Number.isFinite(parsedDate)
          ? Math.floor(parsedDate / 1000)
        : expFromJwt(access);
  return { access, newRefresh: typeof newRefresh === "string" ? newRefresh : undefined, expiresAt };
}

async function doRefresh(): Promise<AccessToken> {
  // Serialised across processes: the refresh token rotates, so two processes refreshing at once
  // invalidate each other and the loser's token is what ends up on disk. See reflock.ts. Failing to
  // take the lock is not fatal — a possible clobber beats a guaranteed outage.
  const release = await acquireRefreshLock();
  try {
    return await refreshOnce();
  } finally {
    release?.();
  }
}

async function refreshOnce(): Promise<AccessToken> {
  const store = getStore();
  const refreshToken = store.get();
  if (!refreshToken) {
    throw new StockbitError(
      "auth",
      "No refresh token stored. Run `stockbit-auth bootstrap` first.",
    );
  }

  let res: Response;
  try {
    // Contract: the refresh token goes in the Authorization header; body is empty. This is the sole
    // permitted write (ADR-0002), and it goes through the transport as the declared `loginRefresh`
    // route — not a direct `fetch`, which is how this call sat outside the boundary entirely.
    res = await authenticatedRequest("loginRefresh", { token: refreshToken });
  } catch (err) {
    if (err instanceof StockbitError) throw err;
    throw new StockbitError("upstream", `Refresh request failed: ${redact(String(err))}`);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = text;
  }
  if (!res.ok) {
    // A 401 here usually means another process rotated the token while this one was queued behind
    // the lock: our copy was valid when we read it and was superseded before we presented it.
    // Re-reading the store and retrying once turns that lockout into a hiccup.
    if (res.status === 401) {
      const current = getStore().get();
      if (current && current !== refreshToken) {
        return refreshOnce();
      }
    }
    throw new StockbitError(
      "auth",
      res.status === 401
        ? "Refresh failed (HTTP 401) — the stored refresh token is no longer valid. " +
          "Run `stockbit-auth login` to re-authenticate."
        : `Refresh failed (HTTP ${res.status})`,
      { status: res.status },
    );
  }

  let parsed: ReturnType<typeof parseRefresh>;
  try {
    parsed = parseRefresh(json);
  } catch (err) {
    if (process.env.STOCKBIT_DEBUG === "1") {
      console.error("[auth:debug] refresh response shape:", JSON.stringify(responseShape(json)));
    }
    throw err;
  }
  const { access, newRefresh, expiresAt } = parsed;

  // Rotation: persist a new refresh token the moment we receive one, or we lock ourselves out.
  if (newRefresh && newRefresh !== refreshToken) {
    store.set(newRefresh);
  }

  current = { token: access, expiresAt };
  return current;
}

/**
 * Access-token-only mode (testing / immediate unblock). If STOCKBIT_ACCESS_TOKEN is set, use it
 * directly and skip refresh. It stops working when the token expires (≤24h) and there's no refresh
 * token to renew it — a clear error is thrown then. Use the refresh-token bootstrap for hands-off.
 */
function adoptEnvAccessToken(): string | null {
  const raw = process.env.STOCKBIT_ACCESS_TOKEN?.trim();
  if (!raw) return null;
  current = { token: raw, expiresAt: expFromJwt(raw) };
  return raw;
}

/** Returns a valid access token, refreshing if missing or within the skew window. */
export async function ensureFresh(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (current && current.expiresAt - now > AUTH.expirySkewSeconds) {
    return current.token;
  }
  // Env-injected access token takes precedence when there's no stored refresh token.
  if (!getStore().get()) {
    const env = adoptEnvAccessToken();
    if (env) {
      if (current!.expiresAt - now <= 0) {
        throw new StockbitError(
          "auth",
          "STOCKBIT_ACCESS_TOKEN has expired. Provide a fresh one, or bootstrap a refresh token.",
        );
      }
      return env;
    }
  }
  // Coalesce concurrent refreshes into one in-flight request.
  if (!inFlight) {
    inFlight = doRefresh().finally(() => {
      inFlight = null;
    });
  }
  return (await inFlight).token;
}

/** Force a refresh (used by the HTTP client on a 401). */
export async function forceRefresh(): Promise<string> {
  current = null;
  return ensureFresh();
}

/** Drop the in-memory access token (tests / logout). */
export function resetSession(): void {
  current = null;
  inFlight = null;
}
