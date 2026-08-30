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
import { acquireRefreshLock } from "./reflock.js";
import { StockbitError } from "../http/errors.js";
import { authenticatedRequest, type RouteName, type TokenDomain } from "../http/transport.js";
import { logStderr, redact } from "../redact.js";
import { clearAccessCache, readAccessCache, writeAccessCache } from "./accesscache.js";
import { alignStoredCredential, browserAccessToken } from "./websession.js";
import { recordRefreshFailure, recordRefreshOk } from "./health.js";
import { tokenFingerprint } from "./fingerprint.js";

export type { TokenDomain } from "../http/transport.js";

interface AccessToken {
  token: string;
  /** epoch seconds */
  expiresAt: number;
  /**
   * Fingerprint of the refresh token this was minted from, when that is known.
   *
   * The DISK cache was hardened against a second account's login leaving the first account's token
   * usable for a day; the in-memory copy needs exactly the same binding for exactly the same reason,
   * and by a route the disk cache cannot cover. A long-running server holds `current` for up to 24
   * hours. If the user runs `stockbit-auth login --switch-account` in a terminal, the store gains
   * account B's refresh token, the disk cache correctly misses on fingerprint — and the running
   * server, which never re-checks, keeps answering `portfolio` and `watchlist` as **account A**,
   * with nothing anywhere saying so. The CLI has no way to reach into that process.
   *
   * Absent for `adoptAccessToken` and `STOCKBIT_ACCESS_TOKEN`, which are seeded from something other
   * than a stored refresh token; an absent fingerprint is never treated as a mismatch.
   */
  from?: string;
  /** When the binding was last confirmed, so it is not re-checked on every single request. */
  checkedAt?: number;
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
  /**
   * Do not take the NEXT cache hit for this domain.
   *
   * Set by `forceRefresh`, which runs because the token in hand was rejected. Clearing the cache
   * file is not enough on its own: the file is an unlocked read-modify-write shared with other
   * processes, so a concurrent `writeAccessCache` for another domain can restore the snapshot it
   * read a moment earlier — dead entry and all — between the clear and the re-read. The entry's
   * fingerprint still matches (the refresh token has not rotated yet) and its `expiresAt` is still
   * in the future (a revoked token keeps its expiry), so it reads as a hit and hands back exactly
   * the token that just 401'd.
   *
   * It is also what makes `live: true` honest: a forced refresh must reach the wire, or the check
   * that claims to have proved the token is proving nothing.
   *
   * A COUNTER, not a boolean. `forceRefresh` can nest — the HTTP client calls it on a 401, and that
   * can happen inside a refresh another `forceRefresh` is already driving — and with a boolean the
   * inner call's `finally` would re-enable the cache while the outer one was still running, which
   * is the one moment it must not be enabled.
   */
  forcedRefreshes: number;
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
  main: { current: null, inFlight: null, rotated: null, forcedRefreshes: 0 },
  securities: { current: null, inFlight: null, rotated: null, forcedRefreshes: 0 },
  eipo: { current: null, inFlight: null, rotated: null, forcedRefreshes: 0 },
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

/**
 * How often the in-memory access token is re-checked against the credential in the store.
 *
 * Not every request. `ensureFresh` is on the path of every authenticated call, and on the Keychain
 * backend reading the store is a `spawnSync` — about 9 ms of BLOCKED EVENT LOOP each time, and up
 * to the full Keychain timeout if it raises a prompt nobody answers. A scan over a universe would
 * become hundreds of serialised subprocess spawns. Measured before this bound was added: ten warm
 * `ensureFresh` calls made ten `security` invocations, where the warm path used to touch the store
 * not at all.
 *
 * What the window costs is the only thing it costs: after a `stockbit-auth login --switch-account`
 * in a terminal, a server that is already running can answer as the previous account for up to this
 * long. Half a minute against a subprocess per request is the trade, and it is bounded either way —
 * without the check at all it was the token's full 24 hours.
 */
const CREDENTIAL_RECHECK_MS = 30_000;

/**
 * Whether an in-memory access token was minted from the refresh token that is in the store NOW.
 *
 * A token with no recorded origin passes. `STOCKBIT_ACCESS_TOKEN` is seeded from nothing this
 * process stored, so there is nothing to bind it to; treating "unknown" as a mismatch would also
 * make `adoptAccessToken`'s callers throw away a token they were just handed and spend a rotation
 * replacing it.
 *
 * **An unreadable store is not a mismatch.** `currentRefreshToken` returns null both for "there is
 * nothing there" and for "the Keychain would not answer", and collapsing those here undoes the very
 * distinction `readState()` exists for: a locked Keychain would make this reject a valid, unexpired
 * access token this process is holding, and the user would be told "No Stockbit session stored. Run
 * login" for a session that was working a second earlier.
 *
 * **Every path that decides to trust the token re-arms the window, including that one.** Stamping
 * only on the fingerprint match left the unreadable branch re-checking on EVERY call — and it is
 * the expensive branch, because it spends two `security` subprocesses rather than one (the read
 * that came back empty, then `readState` asking why). On a Keychain that is prompting, each of
 * those burns the full timeout, so the cost was seconds of blocked event loop per authenticated
 * request, unbounded: the failure the window was introduced to remove, in the branch added
 * alongside it. Trusting the token for thirty seconds is what this branch already decided to do;
 * the stamp only stops it paying for that decision over and over.
 */
function mintedFromCurrentCredential(domain: TokenDomain, token: AccessToken): boolean {
  if (!token.from) return true;
  const now = Date.now();
  if (token.checkedAt !== undefined && now - token.checkedAt < CREDENTIAL_RECHECK_MS) return true;

  const refreshToken = currentRefreshToken(domain);
  if (!refreshToken) {
    // Nothing there is a mismatch; could not look is not. See the note above.
    if (getStore(DOMAINS[domain].slot).readState() !== "unavailable") return false;
    token.checkedAt = now;
    return true;
  }
  if (token.from !== tokenFingerprint(refreshToken)) return false;
  token.checkedAt = now;
  return true;
}

/**
 * A cached access token for a domain, if there is one fresh enough to use.
 *
 * The skew is applied HERE rather than baked into what was stored, so changing
 * `AUTH.expirySkewSeconds` takes effect immediately instead of only for tokens minted afterwards —
 * and so this decision reads identically to the in-memory one in `ensureFresh`.
 *
 * Bound to the refresh token currently in the store: an access token minted from a different
 * credential is a miss, not a hit. That is what stops a second account's login from leaving the
 * first account's token on disk and making every request as the wrong person for a day.
 */
function fromAccessCache(domain: TokenDomain, nowSeconds: number): AccessToken | null {
  if (state[domain].forcedRefreshes > 0) return null;
  const refreshToken = currentRefreshToken(domain);
  if (!refreshToken) return null;
  const entry = readAccessCache(domain, refreshToken);
  if (!entry) return null;
  if (entry.expiresAt - nowSeconds <= AUTH.expirySkewSeconds) return null;
  // `checkedAt` is set here because the binding has just been verified: `readAccessCache` only
  // returns an entry whose fingerprint matches the refresh token now in the store. Leaving it unset
  // would make the very next request re-read the store to confirm something this line already knew.
  return { token: entry.token, expiresAt: entry.expiresAt, from: entry.from, checkedAt: Date.now() };
}

async function doRefresh(domain: TokenDomain): Promise<AccessToken> {
  // Serialised across processes, per domain: the refresh token rotates, so two processes refreshing
  // the SAME domain at once invalidate each other and the loser's token is what ends up on disk.
  // See reflock.ts. Failing to take the lock is not fatal — a possible clobber beats a guaranteed
  // outage.
  //
  // No explicit timeout: `reflock` sizes it per domain and per backend. It used to be a hard-coded
  // 10_000, shorter than a single request is allowed to take — so a caller queued behind a perfectly
  // healthy refresh gave up and refreshed in parallel, producing the exact collision the lock is
  // for.
  const release = await acquireRefreshLock(undefined, domain);
  const locked = release !== null;
  try {
    // Double-checked, and this `if` is the whole feature rather than an optimisation on top of it.
    //
    // Without it: two processes both miss the cache, both queue on this lock, the first refreshes
    // and writes a perfectly good token to disk, and the second — already past its own check —
    // refreshes anyway. That second refresh is a wasted rotation, which is precisely what the cache
    // exists to prevent. Re-reading here, after the wait and before the request, is what turns the
    // loser of the race into a cache hit instead of a second rotation.
    const shared = fromAccessCache(domain, Math.floor(Date.now() / 1000));
    if (shared) {
      state[domain].current = shared;
      return shared;
    }
    return await refreshOnce(domain, 0, locked);
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
  const store = getStore(DOMAINS[domain].slot);
  const held = state[domain].rotated;
  if (!held) return store.get();

  // `readState`, not `get() === null`. Those are two different facts and collapsing them destroys
  // the credential this branch exists to save: a LOCKED Keychain returns null from `get()`, which
  // is also what a store that has moved on looks like — and a locked Keychain is precisely the
  // condition that made the write fail and created `rotated` in the first place. Dropping the token
  // here, milliseconds later, would hand the user "No Stockbit session stored. Run login" for a
  // credential this process is holding and could still use.
  if (store.readState() === "unavailable") return held.token;

  const stored = store.get();
  if (stored === held.supersedes) return held.token;
  state[domain].rotated = null;
  return stored;
}

/**
 * Last resort before declaring the main session dead: look in the stored web session.
 *
 * The browser holds the rotated copy — the SPA calls the refresh route on every page load, and this
 * project captures the resulting cookies after every chart call. Until the resync existed, nothing
 * read the token out of that blob, so "you drew on a chart, then asked for a quote" produced this
 * 401 and a message telling the user to log in again for a credential that was sitting on disk.
 *
 * A file read. No browser, no network, nothing interactive. `alreadyLocked` because this runs inside
 * `doRefresh`'s lock and `acquireDirLock` is not reentrant — without it the resync would block for
 * its whole timeout and then decline to do anything.
 *
 * The import is dynamic to keep `resync.ts` → `session.ts` a one-way dependency at module scope;
 * it is paid only on a 401.
 */
async function recoverFromStoredWebSession(
  slot: StoreSlot,
  spent: string,
  alreadyLocked: boolean,
): Promise<boolean> {
  try {
    const [{ loadWebSession }, { syncStoreFromBrowser }] = await Promise.all([
      import("./websession.js"),
      import("./resync.js"),
    ]);
    const web = loadWebSession();
    if (!web) return false;
    // The REAL lock state, not a constant. When `doRefresh` fails to take the lock it proceeds
    // anyway — documented, and correct, because a possible clobber beats a guaranteed outage — but
    // the resync must then take the lock itself rather than be told one is already held. A null
    // lock makes it a no-op, which is exactly its own policy.
    const result = await syncStoreFromBrowser(web, { alreadyLocked, lockTimeoutMs: 2_000 });
    if (!result.adopted) return false;
    // Confirm the store really moved. Adopting the same token we just presented would send the
    // retry straight back into this branch.
    return getStore(slot).get() !== spent;
  } catch {
    return false;
  }
}

/**
 * @param locked Whether `doRefresh` actually holds this domain's lock. Acquisition is best-effort —
 * a null lock is documented as non-fatal — so it cannot be assumed, and the 401 self-heal below
 * writes the store. Claiming a lock that is not held would make that write completely
 * unsynchronised, which is the one thing `resync.ts` says must never happen.
 */
async function refreshOnce(domain: TokenDomain, attempt = 0, locked = false): Promise<AccessToken> {
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
    // Recorded before rethrowing. A transport failure is not evidence the credential is bad — the
    // journal keeps `ok` and `failure` apart precisely so `status` can tell "Stockbit rejected this"
    // from "the network was down", and only the first of those means log in again.
    recordRefreshFailure(spec.slot, refreshToken, undefined, String(err));
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
        return refreshOnce(domain, attempt + 1, locked);
      }
      // Nothing newer on disk — but for the main session there is one more place to look, and it is
      // the place the token most likely went. The browser holds the rotated copy in the web session
      // this project already captures after every chart call; until now nobody read it, so the
      // ordinary consequence of "you drew on a chart, then asked for a quote" was this exact 401
      // and a message telling the user to log in again.
      //
      // A file read. No browser, no network, no interactive step: `websession.enc` is already on
      // disk. If it holds something newer, this stops being a fatal error and becomes a hiccup
      // nobody sees.
      if (domain === "main") {
        const recovered = await recoverFromStoredWebSession(spec.slot, refreshToken, locked);
        if (recovered) return refreshOnce(domain, attempt + 1, locked);
      }
    }
    // Write it down before throwing. This is the whole point of the journal: the next `status` can
    // then say "present and unexpired, but Stockbit rejected it at HH:MM" without spending anything
    // — and a revoked session becomes visible at zero requests instead of only at the next failure.
    recordRefreshFailure(spec.slot, refreshToken, res.status, `HTTP ${res.status}`);
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
  const token: AccessToken = {
    token: access,
    expiresAt,
    // Bound to whichever refresh token is current after this call — the rotated one when there is
    // one, because that is what the store now holds and what any later check compares against.
    from: tokenFingerprint(newRefresh ?? refreshToken),
  };
  state[domain].current = token;

  // Rotation: persist the new refresh token the moment we receive one, or the next process to start
  // locks itself out.
  if (newRefresh && newRefresh !== refreshToken) {
    persistRotated(domain, store, newRefresh, refreshToken);
  }

  // Share it, keyed to whichever refresh token is now current — the rotated one when there is one,
  // because that is what the next process reads out of the store and checks against.
  writeAccessCache(domain, access, expiresAt, newRefresh ?? refreshToken);

  // And record the success against the token that is now current, for the same reason: `status`
  // reports on what is in the store, so the journal has to be keyed to that and not to the token
  // that has just been retired.
  recordRefreshOk(spec.slot, newRefresh ?? refreshToken);

  // ...and carry the rotation to the BROWSER, which holds a copy of the very pair this call retired.
  //
  // This is the other half of the daily-login bug, and the half that survives fixing the health
  // verdict. The CLI and the browser hold the SAME token strings, so they lapse at the same instant —
  // about 24 hours after each login. The next request refreshes, the refresh retires the pair the
  // browser is still holding, and the chart renders a zero-height body that reads as "logged out" on
  // a session with six days left on its refresh token.
  //
  // Only `main` has a browser side; `securities` and `eipo` are API-only chains with no cookie to
  // fall out of step with. Best-effort by construction: `alignStoredCredential` reports rather than
  // throws, and writes only when the cookie provably holds the retired generation. A refresh that
  // succeeded must never be turned into a failure by a bookkeeping step — which is the same reason
  // the access token is cached first, above.
  if (domain === "main") {
    try {
      const alignment = alignStoredCredential(refreshToken, {
        access,
        accessExpiresAt: expiresAt,
        refresh: newRefresh,
        refreshExpiresAt: newRefresh ? expFromJwt(newRefresh, 7 * 24 * 3600) : undefined,
      });
      if (process.env.STOCKBIT_DEBUG === "1") {
        logStderr(`[auth:debug] web session alignment after main refresh: ${alignment}`);
      }
    } catch {
      // Loading or running the alignment must not cost a refresh that already worked.
    }
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
  // Deliberately NOT written to the access cache. This token belongs to whoever set the variable in
  // THIS process's environment; caching it would hand it to every other process on the machine,
  // including ones the user never pointed at it. It is the CI and headless escape hatch, where a
  // token pasted for one run must not outlive that run.
  state.main.current = { token: raw, expiresAt: expFromJwt(raw) };
  return raw;
}

/** Returns a valid access token for a domain, refreshing if missing or within the skew window. */
export async function ensureFresh(domain: TokenDomain = "main"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const slotState = state[domain];
  if (
    slotState.current &&
    slotState.current.expiresAt - now > AUTH.expirySkewSeconds &&
    mintedFromCurrentCredential(domain, slotState.current)
  ) {
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
  // Level two: the shared on-disk cache. An access token is good for 24 hours whoever asked for it,
  // and minting one SPENDS a rotation of a credential only one process can hold at a time — so N
  // clients each minting their own is N rotations for a token all of them could have used.
  const cached = fromAccessCache(domain, now);
  if (cached) {
    slotState.current = cached;
    return cached.token;
  }

  // Level three: the BROWSER's copy of this same pair, before spending a rotation on a new one.
  //
  // `resync.ts` already follows the browser's REFRESH token. This follows its ACCESS token, which is
  // what a request actually presents — and following it makes a refresh unnecessary rather than
  // merely recoverable. The SPA re-mints on boot and the chart driver captures the result, so the
  // cookie is routinely ahead of this process; refreshing past it would retire the generation the
  // chart is drawing under.
  //
  // Skipped during a forced refresh: that runs because a token was REJECTED, and the cookie may well
  // hold the same rejected token. `forceRefresh` does its own browser check, where it still knows
  // which token failed and can compare against it.
  if (domain === "main" && slotState.forcedRefreshes === 0) {
    const fromBrowser = browserAccessToken(AUTH.expirySkewSeconds);
    if (fromBrowser) {
      const adopted: AccessToken = {
        token: fromBrowser.token,
        expiresAt: fromBrowser.expiresAt,
        // Bound to the refresh token currently in the store: this access token belongs to the same
        // family, and binding it to anything else would make `mintedFromCurrentCredential` drop it.
        from: tokenFingerprint(currentRefreshToken("main") ?? fromBrowser.token),
      };
      slotState.current = adopted;
      return adopted.token;
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
  const rejected = state[domain].current?.token ?? null;
  state[domain].current = null;

  // Before spending a rotation, ask the BROWSER whether it has already moved on.
  //
  // A 401 has two very different causes and they need opposite responses. The session may be dead —
  // then a refresh is right. Or this process is simply BEHIND: the SPA rotated on boot, the chart
  // driver captured the new pair, and the token in hand was retired by that rotation rather than by
  // any expiry. Refreshing in the second case retires the generation the chart is using and turns
  // "you were behind" into "you are both logged out".
  //
  // Anything the cookie holds that is not the token that just failed is newer by definition — the
  // two sides only ever hold one pair — so the comparison against `rejected` is the whole guard.
  if (domain === "main") {
    const fromBrowser = browserAccessToken(AUTH.expirySkewSeconds);
    if (fromBrowser && fromBrowser.token !== rejected) {
      const adopted: AccessToken = {
        token: fromBrowser.token,
        expiresAt: fromBrowser.expiresAt,
        from: tokenFingerprint(currentRefreshToken("main") ?? fromBrowser.token),
      };
      state[domain].current = adopted;
      writeAccessCache(domain, adopted.token, adopted.expiresAt, currentRefreshToken("main") ?? adopted.token);
      return adopted.token;
    }
  }
  // The single most important line in the access cache. `forceRefresh` runs because the token in
  // hand was rejected — and that same token is on disk, shared with every other process. Without
  // this, the very next `ensureFresh` re-hydrates the dead token from the cache and the session
  // 401s forever, having "refreshed" each time.
  clearAccessCache(domain);
  // And refuse the cache outright while this runs. See `DomainState.forcedRefreshes`: clearing the
  // file is not enough, because another process can restore the snapshot it read a moment ago.
  state[domain].forcedRefreshes++;
  try {
    return await ensureFresh(domain);
  } finally {
    state[domain].forcedRefreshes = Math.max(0, state[domain].forcedRefreshes - 1);
  }
}

/**
 * Seed a domain's in-memory access token directly.
 *
 * Used by `trading-login`, which receives the access token and the refresh token together and would
 * otherwise throw the access token away and immediately refresh to get another one.
 */
export function adoptAccessToken(
  domain: TokenDomain,
  token: string,
  expiresAt?: number,
  mintedFrom?: string,
): void {
  // `mintedFrom` is the refresh token this access token came with. Both callers HAVE it — they were
  // handed the pair together and store the refresh token a line or two earlier — so leaving it out
  // exempted the securities and e-IPO sessions from the account binding for their whole 24-hour
  // life, while a comment claimed neither had a stored credential to bind to.
  state[domain].current = {
    token,
    expiresAt: expiresAt ?? expFromJwt(token),
    ...(mintedFrom === undefined ? {} : { from: tokenFingerprint(mintedFrom), checkedAt: Date.now() }),
  };
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
 * is the opposite of what this function is for.
 *
 * It used to say that this "covers `logout`, see `currentRefreshToken`" — that the comparison there
 * would drop it once the store stopped holding what it superseded. That is not true on the Keychain
 * backend: a locked Keychain makes `clear()` fail silently AND makes the read unreadable, so the
 * comparison is short-circuited and the rescued token is still offered. A logout that leaves a
 * usable credential is not one, least of all on the securities slot. `logout` calls `forgetRotated`
 * explicitly now, because a deliberate act deserves a deliberate drop rather than an inference.
 */
export function resetSession(domain?: TokenDomain): void {
  const domains: TokenDomain[] = domain ? [domain] : ["main", "securities", "eipo"];
  for (const d of domains) {
    state[d].current = null;
    state[d].inFlight = null;
    // `forcedRefreshes` is deliberately NOT reset here. It is owned by the `finally` in
    // `forceRefresh`, which runs on every path including a throw — and zeroing it from outside
    // would drive it negative when that `finally` then decrements, which reads as "not forcing"
    // for the NEXT forced refresh. The decrement clamps at zero for the same reason.
  }
}

/**
 * Drop a rescued, unwritten refresh token for a domain.
 *
 * Only `logout` calls this, and it must: see the note on `resetSession` for why the comparison in
 * `currentRefreshToken` cannot be relied on to do it.
 */
export function forgetRotated(domain: TokenDomain): void {
  state[domain].rotated = null;
}

/** Whether a domain has a stored refresh token at all — a question `status` asks without a round trip. */
export function hasStoredSession(domain: TokenDomain): boolean {
  return Boolean(currentRefreshToken(domain));
}


/** The "you have no session" message for a domain, so callers do not each invent their own. */
export function missingSessionMessage(domain: TokenDomain): string {
  return DOMAINS[domain].missing;
}
