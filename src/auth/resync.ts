/**
 * Adopt the browser's rotated refresh token into the store.
 *
 * ## The bug this closes
 *
 * `/login/refresh` rotates: every successful call mints a new refresh token and retires the one
 * presented. The Stockbit web app calls that route **itself**, on every page load. So every Chartbit
 * tool — which opens a real Stockbit page in a real profile — spends the CLI's credential behind its
 * back. The browser ends up holding token N+1 while `refresh.enc` still holds N, and the next REST
 * call 401s and tells the user their session is gone. One user, one process, one chart is enough.
 *
 * The rotated token was never out of reach: `withChart`'s `finally` already re-captures the browser
 * session, and that blob contains the new token in the `credentialStorage` cookie. Nothing read it.
 *
 * ## Why this is not in `websession.ts`
 *
 * That file's own doc says the web session "is deliberately NOT a fourth `StoreSlot`". A module
 * named `websession` that quietly wrote `refresh.enc` would falsify that sentence for the next
 * reader. The *reader* — `readCredentialStorage` — belongs there, because that file owns the cookie
 * and documents its shape. The *policy* belongs here.
 *
 * ## The lock policy is the opposite of `doRefresh`'s, deliberately
 *
 * `doRefresh` proceeds without the lock because its alternative is a guaranteed outage. Here the
 * alternative is doing nothing, and **doing nothing is safe**: the browser still holds a working
 * token and will offer it again on the next chart call. So a null lock is a no-op, not permission.
 * Same primitive, opposite policy, because the cost of being wrong is not the same.
 *
 * This function never throws. It runs inside a `finally` on the chart path, where an exception would
 * turn a drawing that succeeded into an error, and inside the login capture, where it would turn a
 * captured credential into a failed login.
 *
 * See ADR-0009.
 */
import { getStore } from "./store.js";
import { acquireRefreshLock } from "./reflock.js";
import { decodeJwt } from "./session.js";
import { CREDENTIAL_COOKIE, readCredentialStorage, type WebSession } from "./websession.js";
import { logStderr } from "../redact.js";

/**
 * Why the resync did what it did. A closed union rather than a message, so `STOCKBIT_DEBUG=1` can
 * name the branch and nobody has to invent prose at a call site.
 */
export type ResyncReason =
  /** The capture holds no `credentialStorage` cookie at all. */
  | "no-cookie"
  /** The cookie is there but yielded no JWT — malformed encoding, or a shape that has moved. */
  | "unparsable"
  /** The browser and the store hold the same token. Nothing was written. */
  | "same"
  /** The browser's token has already expired. Never adopt a dead credential over a live one. */
  | "browser-expired"
  /** The store's token is the newer of the two. Three in-repo paths produce this legitimately. */
  | "store-newer"
  /** Neither token could be ordered against the other, so the store was left alone. */
  | "indeterminate"
  /** The store said it could not tell whether it holds anything — a locked Keychain. */
  | "store-unavailable"
  /** The refresh lock was held by someone else. Doing nothing is safe here. */
  | "no-lock"
  /** The comparison said adopt, and the write failed. */
  | "write-failed"
  /** The store now holds the browser's token. */
  | "adopted";

export interface ResyncResult {
  adopted: boolean;
  reason: ResyncReason;
}

/** What a JWT says about when it was issued and when it dies. Absent fields stay absent. */
interface Claims {
  iat?: number;
  exp?: number;
  /** False when the payload could not be decoded at all. */
  decoded: boolean;
}

function claimsOf(token: string): Claims {
  const payload = decodeJwt(token);
  const decoded = Object.keys(payload).length > 0;
  const iat = typeof payload["iat"] === "number" ? (payload["iat"] as number) : undefined;
  const exp = typeof payload["exp"] === "number" ? (payload["exp"] as number) : undefined;
  return { iat, exp, decoded };
}

/**
 * Which of the two tokens the store should end up holding.
 *
 * **Not "the browser always wins."** A directional rule would walk the store *backwards* in three
 * cases this repo can already produce: `login --verify` and `bootstrap --verify` call `forceRefresh`
 * *after* the capture, leaving the store legitimately ahead; `import-har` imports a token of unknown
 * vintage; and any second process refreshing while a chart is open.
 *
 * The rungs are ordered by how well-evidenced they are, and the difference is real:
 *
 *  - That the refresh token carries `exp` is **Observed** — `status` and `doctor` read it live.
 *  - That rotation issues a *fresh* window is **Observed** (`doctor`: "it keeps sliding").
 *  - That `exp` therefore **orders issuance** is an **inference** from those two. It is the rung
 *    this function leans on most, and it is not a measurement.
 *  - `iat` on these tokens is **unverified** — it may not be there at all. Hence "prefer it when
 *    both carry one", never "require it".
 *
 * `capturedAt` is deliberately not a rung. It records when the cookie was *read*, not when the token
 * was *issued*, so a stale capture of a fresh token would order exactly wrong.
 *
 * Exported for the test, which asserts every rung including the ones that refuse.
 */
export function decideAdoption(browser: string, stored: string | null, nowSeconds: number): ResyncResult {
  const b = claimsOf(browser);

  // An empty store recovers on its own. This rung earns its place alone: it is "the Keychain was
  // wiped but the browser is still signed in", which today forces a full interactive re-login for a
  // credential that is sitting on disk. Guarded, because writing an unreadable or dead token into an
  // empty store turns "no session" into "a broken session", which is worse.
  if (stored === null) {
    if (!b.decoded) return { adopted: false, reason: "unparsable" };
    if (b.exp === undefined) return { adopted: false, reason: "indeterminate" };
    if (b.exp <= nowSeconds) return { adopted: false, reason: "browser-expired" };
    return { adopted: true, reason: "adopted" };
  }

  // Identical: return without writing. Not an optimisation — a write here would mean an fsync, and
  // on macOS a Keychain write, on every single chart call, for no change.
  if (browser === stored) return { adopted: false, reason: "same" };

  // Never adopt a dead token over a live one, whatever the ordering rungs would say.
  if (b.exp !== undefined && b.exp <= nowSeconds) return { adopted: false, reason: "browser-expired" };

  const s = claimsOf(stored);

  if (b.iat !== undefined && s.iat !== undefined) {
    return b.iat > s.iat ? { adopted: true, reason: "adopted" } : { adopted: false, reason: "store-newer" };
  }
  if (b.exp !== undefined && s.exp !== undefined) {
    return b.exp > s.exp ? { adopted: true, reason: "adopted" } : { adopted: false, reason: "store-newer" };
  }
  // The stored token is not readable and the browser's is. Nothing can be compared, but one of them
  // is at least a token this installation can decode.
  if (b.decoded && !s.decoded) return { adopted: true, reason: "adopted" };

  // Two tokens, no way to order them. Refusing is the only answer that cannot make things worse.
  return { adopted: false, reason: "indeterminate" };
}

export interface ResyncOptions {
  /**
   * How long to wait for the refresh lock. Short on the interactive chart path, where giving up is
   * free — the browser still holds the token and the next call will offer it again.
   */
  lockTimeoutMs?: number;
  /** Injectable clock, in epoch seconds. */
  nowSeconds?: number;
  /**
   * The caller already holds the main refresh lock.
   *
   * Set ONLY from inside `doRefresh`'s lock. `acquireDirLock` is not reentrant, so taking the same
   * lock again from in there would block for the whole timeout and then report `no-lock` — silently
   * skipping the recovery this exists to perform, in the one situation where it is needed most.
   */
  alreadyLocked?: boolean;
}

/**
 * Read the browser's refresh token out of a captured session and adopt it if it is the newer one.
 *
 * Never throws. Never calls `resetSession`: rotating the *refresh* token does not invalidate the
 * *access* token this process is holding, and dropping it would force exactly the refresh this
 * function exists to avoid.
 */
export async function syncStoreFromBrowser(
  session: WebSession | null,
  options: ResyncOptions = {},
): Promise<ResyncResult> {
  const debug = process.env.STOCKBIT_DEBUG === "1";
  const done = (result: ResyncResult): ResyncResult => {
    if (debug) logStderr(`[resync:debug] ${result.reason}`);
    return result;
  };

  try {
    if (!session) return done({ adopted: false, reason: "no-cookie" });

    const browser = readCredentialStorage(session);
    if (!browser) {
      const present = session.cookies.some((c) => c.name === CREDENTIAL_COOKIE);
      return done({ adopted: false, reason: present ? "unparsable" : "no-cookie" });
    }

    // Everything from here is inside the lock. The comparison and the write have to be one
    // operation, or a refresh landing between them puts the older token on disk — which is the
    // failure this whole file is about, arriving by a different route.
    const release = options.alreadyLocked
      ? () => {}
      : await acquireRefreshLock(options.lockTimeoutMs, "main");
    if (!release) return done({ adopted: false, reason: "no-lock" });

    try {
      const store = getStore("main");

      // `null` from a locked Keychain is ambiguous, and adopting on it could walk the store
      // backwards over a credential nobody has looked at. `readState` is what tells the two apart.
      if (store.readState() === "unavailable") {
        return done({ adopted: false, reason: "store-unavailable" });
      }

      const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
      const decision = decideAdoption(browser, store.get(), now);
      if (!decision.adopted) return done(decision);

      try {
        store.set(browser);
      } catch (err) {
        if (debug) logStderr("[resync:debug] write failed:", err instanceof Error ? err.message : String(err));
        return done({ adopted: false, reason: "write-failed" });
      }
      return done({ adopted: true, reason: "adopted" });
    } finally {
      release();
    }
  } catch (err) {
    // A resync that throws would turn a drawing that succeeded into an error, and a captured
    // credential into a failed login. There is no failure here worth either of those.
    if (debug) logStderr("[resync:debug] unexpected:", err instanceof Error ? err.message : String(err));
    return { adopted: false, reason: "indeterminate" };
  }
}
