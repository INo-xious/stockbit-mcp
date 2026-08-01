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
import { AUTH, HOSTS } from "../config.js";
import { getStore } from "./store.js";
import { StockbitError } from "../http/errors.js";
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

/** Normalize the /login/refresh response into an access token (+ optional rotated refresh token). */
export function parseRefresh(body: unknown): { access: string; newRefresh?: string; expiresAt: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  // /login/refresh nests as { data: { data: {...} } }; also accept a single { data } or a bare object.
  let d = (b.data ?? b) as Record<string, unknown>;
  if (d && typeof d === "object" && "data" in d && typeof d.data === "object") {
    d = d.data as Record<string, unknown>;
  }
  const access =
    (d.access_token as string) ?? (d.token as string) ?? (d.accessToken as string);
  if (typeof access !== "string" || !access) {
    throw new StockbitError("auth", "Refresh response missing access token");
  }
  const newRefresh =
    (d.refresh_token as string) ?? (d.refreshToken as string) ?? undefined;
  // Prefer explicit expiry; else read the JWT's exp.
  const explicit = d.expired_at ?? d.expires_at ?? d.expiresAt;
  const expiresAt =
    typeof explicit === "number"
      ? explicit
      : typeof explicit === "string" && /^\d+$/.test(explicit)
        ? Number(explicit)
        : expFromJwt(access);
  return { access, newRefresh: typeof newRefresh === "string" ? newRefresh : undefined, expiresAt };
}

async function doRefresh(): Promise<AccessToken> {
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
    // Contract: refresh token goes in the Authorization header; body is empty. See config.AUTH.
    res = await fetch(AUTH.refreshUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${refreshToken}`,
        origin: HOSTS.web,
        referer: `${HOSTS.web}/`,
      },
    });
  } catch (err) {
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
    throw new StockbitError("auth", `Refresh failed (HTTP ${res.status})`, { status: res.status });
  }

  const { access, newRefresh, expiresAt } = parseRefresh(json);

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
