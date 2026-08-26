/**
 * Session manager: holds the short-lived access tokens in memory and mints fresh ones from the
 * stored refresh tokens.
 *
 * ## Three domains, not one
 *
 * There are now three independent sessions, on three hosts, with three refresh chains:
 *
 *   - `main`       — exodus market data. Refresh token in the Authorization header, empty body.
 *   - `securities` — carina, the trading account. Refresh token in the BODY as `refresh_token`.
 *   - `eipo`       — the e-IPO partner backend. Refresh token as a QUERY parameter.
 *
 * They are kept genuinely apart — own store slot, own in-memory token, own in-flight promise, own
 * cross-process lock — rather than folded into one record with a discriminator. The reason is not
 * tidiness: a securities refresh that queued behind a market-data refresh would make
 * `trading-login` appear to hang, and a single `resetSession()` that dropped all three would log a
 * user out of trading because a quote failed.
 *
 * ## What is still unconfirmed
 *
 * The main chain's response shape is observed and handled. The carina and e-IPO shapes are handled
 * defensively by the same `parseRefresh` — it searches the envelope structurally rather than
 * following a fixed path, because the envelope has already moved once across API versions. If a
 * live refresh returns something it cannot read, `STOCKBIT_DEBUG=1` prints the response *shape*
 * (keys and value types, never values) so the next edit is informed rather than guessed.
 */
import { AUTH } from "../config.js";
import { getStore, type StoreSlot, type TokenStore } from "./store.js";
import { acquireRefreshLock, REFRESH_LOCK_TIMEOUT_MS } from "./reflock.js";
import { StockbitError } from "../http/errors.js";
import { authenticatedRequest, type RouteName, type TokenDomain } from "../http/transport.js";
import { logStderr, redact } from "../redact.js";

export type { TokenDomain } from "../http/transport.js";

interface AccessToken {
  token: string;
  /** epoch seconds */
  expiresAt: number;
}

interface DomainState {
  current: AccessToken | null;
  inFlight: Promise<AccessToken> | null;
  /**
   * A rotated refresh token this process holds but could NOT write to the store.
   *
   * `token` is the live credential; `supersedes` is what the store held when the write failed, and
   * is what makes this safe. The moment the store stops holding `supersedes` — another process
   * rotated, a `bootstrap` pasted a new token, a `login` captured one, a `logout` cleared it — this
   * record is stale and is dropped. Without that check a token kept here would shadow a credential
   * the user had just deliberately replaced.
   *
   * It is a credential rather than a cache, which is why `resetSession` does not clear it: dropping
   * it would throw away the only live copy and force an interactive re-login for what may have been
   * a Keychain that was locked for a minute. See `persistRotated` and `currentRefreshToken`.
   */
  rotated: { token: string; supersedes: string | null } | null;
}

/**
 * What each domain needs in order to refresh itself.
 *
 * The `presentation` column is informational here — the transport decides placement from the
 * route's `auth` kind — but it is written down because it is the single fact that most often
 * differs between these three, and a reader debugging a 401 should not have to cross-reference two
 * files to learn it.
 */
interface DomainSpec {
  slot: StoreSlot;
  refreshRoute: RouteName;
  /** Where the refresh credential goes, per the route's auth kind. Documentation, not behaviour. */
  presentation: "header" | "body" | "query";
  /** What to tell a user who has no token for this domain. Names the command that gets one. */
  missing: string;
}

const DOMAINS: Record<TokenDomain, DomainSpec> = {
  main: {
    slot: "main",
    refreshRoute: "loginRefresh",
    presentation: "header",
    missing: "No Stockbit session stored. Run `stockbit-auth login` first.",
  },
  securities: {
    slot: "securities",
    refreshRoute: "carinaAuthRefresh",
    presentation: "body",
    missing:
      "Trading session not set up — run `stockbit-auth trading-login`. " +
      "It asks for your 6-digit trading PIN once; the PIN is never stored and never reaches this server.",
  },
  eipo: {
    slot: "eipo",
    refreshRoute: "eipoRefreshToken",
    presentation: "query",
    missing: "No e-IPO session. It is minted automatically from your Stockbit login — run `stockbit-auth login`.",
  },
};

const state: Record<TokenDomain, DomainState> = {
  main: { current: null, inFlight: null, rotated: null },
  securities: { current: null, inFlight: null, rotated: null },
  eipo: { current: null, inFlight: null, rotated: null },
};

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

/**
 * Normalize a refresh (or login) response into an access token, plus a rotated refresh token when
 * one is returned.
 *
 * Shared by all three domains on purpose. It searches the envelope structurally rather than
 * following a fixed path, because the envelope has already moved once across API versions and the
 * carina and e-IPO shapes are not the same as exodus's. A structural search survives that; a
 * hard-coded path does not.
 */
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

async function doRefresh(domain: TokenDomain): Promise<AccessToken> {
  // Serialised across processes, per domain: the refresh token rotates, so two processes refreshing
  // the SAME domain at once invalidate each other and the loser's token is what ends up on disk.
  // See reflock.ts. Failing to take the lock is not fatal — a possible clobber beats a guaranteed
  // outage.
  //
  // The timeout is the module's own, which is derived from `RATE.requestTimeoutMs`. It used to be a
  // hard-coded 10_000, shorter than a single request is allowed to take — so a caller queued behind
  // a perfectly healthy refresh gave up and refreshed in parallel, producing the exact collision
  // the lock is for.
  const release = await acquireRefreshLock(REFRESH_LOCK_TIMEOUT_MS, domain);
  try {
    return await refreshOnce(domain);
  } finally {
    release?.();
  }
}

/**
 * Persist a rotated refresh token — and never lose one.
 *
 * `set` can fail for reasons that have nothing to do with the credential: a locked Keychain, a
 * denied access prompt, EPERM from an antivirus holding the temp file, a full disk. Before this,
 * such a failure threw out of `refreshOnce`, and the rotated token was gone *permanently* — the one
 * it replaced had already been retired server-side the moment this pair was issued. A transient
 * disk error cost a forced interactive re-login.
 *
 * So: try twice, then keep it in memory anyway. `state[domain].rotated` is what this process
 * presents on its next refresh, which is what lets a long-running server survive a Keychain that
 * was locked for a minute.
 *
 * The retry is immediate rather than delayed on purpose. The realistic failures here — a locked
 * Keychain, a denied ACL prompt — do not heal in a few hundred milliseconds, and a sleep on the
 * refresh path would be paid by every user for a case that almost never recovers.
 *
 * The warning names no token, and the reason is passed through `redact` because a store error can
 * quote a path and a wrapped `fetch` error can quote a URL.
 */
function persistRotated(
  domain: TokenDomain,
  store: TokenStore,
  newRefresh: string,
  presented: string,
): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      store.set(newRefresh);
      state[domain].rotated = null;
      return;
    } catch (err) {
      if (attempt === 0) continue;
      // Keep the ORIGINAL `supersedes` across a chain of failures. On the second failure the store
      // still holds what it held on the first — not the token we just presented, which never
      // reached it — and recording the wrong one would make the next read drop this record and
      // present a doubly-spent token.
      state[domain].rotated = {
        token: newRefresh,
        supersedes: state[domain].rotated?.supersedes ?? presented,
      };
      logStderr(
        `Warning: the ${domain} refresh token rotated but could not be written to the ` +
          `${store.backend} store (${redact(err instanceof Error ? err.message : String(err))}). ` +
          "This process keeps working; another one starting now would find a spent token. " +
          "Run `stockbit-auth login` when convenient.",
      );
    }
  }
}

/**
 * The refresh token this process would actually present for a domain.
 *
 * Prefers a rotated token held in memory because the store write failed — from here the stored copy
 * is spent, and presenting it is a guaranteed 401. But only while the store still holds exactly what
 * it held when that write failed. Anything else means the store has moved on under us: another
 * process rotated, or the user ran `bootstrap`, `login` or `logout`. In every one of those cases the
 * store is authoritative and the in-memory copy is not, so it is dropped here rather than by asking
 * five call sites to remember to drop it.
 *
 * Every caller that asks "is there a session" goes through this, or a process that is working
 * perfectly well reports that it has none.
 */
function currentRefreshToken(domain: TokenDomain): string | null {
  const stored = getStore(DOMAINS[domain].slot).get();
  const held = state[domain].rotated;
  if (!held) return stored;
  if (stored === held.supersedes) return held.token;
  state[domain].rotated = null;
  return stored;
}

async function refreshOnce(domain: TokenDomain, attempt = 0): Promise<AccessToken> {
  const spec = DOMAINS[domain];
  const store = getStore(spec.slot);
  const refreshToken = currentRefreshToken(domain);
  if (!refreshToken) throw new StockbitError("auth", spec.missing);

  let res: Response;
  try {
    // Through the transport as a declared route — not a direct `fetch`, which is how this call sat
    // outside the ADR-0002 boundary entirely. The transport decides *where* the credential goes
    // from the route's auth kind: header for main, body for carina, query for e-IPO.
    res = await authenticatedRequest(spec.refreshRoute, { token: refreshToken });
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
    //
    // Bounded at one retry. The re-read has to differ for the retry to fire, so in principle it
    // terminates on its own — but "in principle" is doing the work there, and the failure mode of
    // being wrong is an unbounded recursion inside a held lock, issuing a request per level, while
    // every other process waits on it.
    if (res.status === 401 && attempt === 0) {
      const now = getStore(spec.slot).get();
      if (now && now !== refreshToken) {
        return refreshOnce(domain, attempt + 1);
      }
    }
    throw new StockbitError(
      "auth",
      res.status === 401
        ? `Refresh failed (HTTP 401) — the stored ${domain} token is no longer valid. ${spec.missing}`
        : `Refresh failed (HTTP ${res.status}) for the ${domain} session`,
      { status: res.status },
    );
  }

  let parsed: ReturnType<typeof parseRefresh>;
  try {
    parsed = parseRefresh(json);
  } catch (err) {
    if (process.env.STOCKBIT_DEBUG === "1") {
      console.error(`[auth:debug] ${domain} refresh response shape:`, JSON.stringify(responseShape(json)));
    }
    throw err;
  }
  const { access, newRefresh, expiresAt } = parsed;

  // The access token is cached FIRST, and unconditionally. The order is the fix, not a tidy-up.
  //
  // The refresh token we presented is already spent — Stockbit retired it the instant it issued
  // this pair. Letting a storage failure throw from here therefore discarded a working 24-hour
  // access token *on top of* a credential that was gone either way, turning a disk problem into an
  // immediate outage instead of a warning about tomorrow.
  const token = { token: access, expiresAt };
  state[domain].current = token;

  // Rotation: persist the new refresh token the moment we receive one, or the next process to start
  // locks itself out.
  if (newRefresh && newRefresh !== refreshToken) {
    persistRotated(domain, store, newRefresh, refreshToken);
  }

  return token;
}

/**
 * Access-token-only mode for the MAIN session (testing / immediate unblock).
 *
 * Deliberately main-only: an env var cannot unlock trading. `STOCKBIT_TRADING=off` can turn trading
 * off and nothing in the environment can turn it on (ADR-0004), and a `STOCKBIT_SECURITIES_TOKEN`
 * would be exactly that hole.
 */
function adoptEnvAccessToken(): string | null {
  const raw = process.env.STOCKBIT_ACCESS_TOKEN?.trim();
  if (!raw) return null;
  state.main.current = { token: raw, expiresAt: expFromJwt(raw) };
  return raw;
}

/** Returns a valid access token for a domain, refreshing if missing or within the skew window. */
export async function ensureFresh(domain: TokenDomain = "main"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const slotState = state[domain];
  if (slotState.current && slotState.current.expiresAt - now > AUTH.expirySkewSeconds) {
    return slotState.current.token;
  }
  // Env-injected access token takes precedence when there's no stored refresh token — main only.
  if (domain === "main" && !currentRefreshToken("main")) {
    const env = adoptEnvAccessToken();
    if (env) {
      if (state.main.current!.expiresAt - now <= 0) {
        throw new StockbitError(
          "auth",
          "STOCKBIT_ACCESS_TOKEN has expired. Provide a fresh one, or bootstrap a refresh token.",
        );
      }
      return env;
    }
  }
  // Coalesce concurrent refreshes of the same domain into one in-flight request.
  if (!slotState.inFlight) {
    slotState.inFlight = doRefresh(domain).finally(() => {
      slotState.inFlight = null;
    });
  }
  return (await slotState.inFlight).token;
}

/** Force a refresh of one domain (used by the HTTP client on a 401). */
export async function forceRefresh(domain: TokenDomain = "main"): Promise<string> {
  state[domain].current = null;
  return ensureFresh(domain);
}

/**
 * Seed a domain's in-memory access token directly.
 *
 * Used by `trading-login`, which receives the access token and the refresh token together and would
 * otherwise throw the access token away and immediately refresh to get another one.
 */
export function adoptAccessToken(domain: TokenDomain, token: string, expiresAt?: number): void {
  state[domain].current = { token, expiresAt: expiresAt ?? expFromJwt(token) };
}

/**
 * Drop in-memory access tokens (tests / logout).
 *
 * With no argument it clears every domain, which is what a test wants. Callers ending ONE session —
 * `trading-logout` — must name theirs, or logging out of trading would also drop the market-data
 * token and cost an extra refresh on the next quote.
 *
 * `rotated` is deliberately NOT cleared. It holds a refresh token that could not be written to the
 * store, which makes it a credential rather than a cache — the only live copy on this machine.
 * Dropping it here would turn "the Keychain was locked for a minute" into a forced re-login, which
 * is the opposite of what this function is for. It stops being used on its own the moment the store
 * stops holding what it superseded, which covers `logout` — see `currentRefreshToken`.
 */
export function resetSession(domain?: TokenDomain): void {
  const domains: TokenDomain[] = domain ? [domain] : ["main", "securities", "eipo"];
  for (const d of domains) {
    state[d].current = null;
    state[d].inFlight = null;
  }
}

/** Whether a domain has a stored refresh token at all — a question `status` asks without a round trip. */
export function hasStoredSession(domain: TokenDomain): boolean {
  return Boolean(currentRefreshToken(domain));
}

/** The store slot backing a domain, so the CLI can report its backend without duplicating the table. */
export function storeSlotFor(domain: TokenDomain): StoreSlot {
  return DOMAINS[domain].slot;
}

/** The "you have no session" message for a domain, so callers do not each invent their own. */
export function missingSessionMessage(domain: TokenDomain): string {
  return DOMAINS[domain].missing;
}
