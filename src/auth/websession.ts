/**
 * The browser WEB session — the second credential this project needs, and the one it never kept.
 *
 * ## Why this file exists
 *
 * `refresh.enc` holds the API refresh token. That is what every REST tool runs on, and it is the
 * only thing `stockbit-auth login` used to persist. But Chartbit does not talk to the REST API — it
 * drives a real Stockbit page in a real browser profile, and that page authenticates with the
 * browser's own cookies and Local Storage. Those are a *different credential*.
 *
 * The consequence was a failure mode that reads as the tool being confused: `stockbit-auth login`
 * reports success, `status --live` refreshes the token against Stockbit and passes, and then the
 * very next chart open is redirected to `/login`. Both reports were true. They were about different
 * things, and nothing in the output said so.
 *
 * So the web session gets stored too, next to the token, under the same protection: AES-256-GCM
 * with a key derived from machine + user, never written to disk. It is deliberately NOT a fourth
 * `StoreSlot` — a slot holds one JWT string and the whole keychain path is built around that shape,
 * whereas this is a structured blob of cookies and origin storage. Bending a slot to hold JSON would
 * make `doctor` and the keychain backends lie about what they are guarding.
 *
 * ## What is in here, and what that means if it leaks
 *
 * A live Stockbit session: session cookies and whatever the web app keeps in Local Storage. That is
 * enough to act as the user on the website. It is exactly as sensitive as `refresh.enc` and is
 * written with the same 0600 discipline. `clearWebSession` exists so `stockbit-auth logout` can
 * take it out along with everything else — a logout that leaves a usable session on disk is not one.
 *
 * ## Why capture and restore both live in `auth/`
 *
 * The Chartbit driver deliberately never enables the `Network` or `Fetch` CDP domains — there is a
 * test asserting it — so that the thing drawing on the user's chart cannot observe the session it is
 * drawing under. Restoring a session means handling that session, so it belongs on this side of that
 * line. The driver's job stays "open a profile that is already signed in", and it never learns why.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileDir, writeFileAtomic } from "./store.js";
import { extractRefresh, looksLikeJwt } from "./capture.js";
import type { CDP } from "./cdp.js";

/** One cookie, in the shape `Storage.setCookies` will take straight back. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** CDP epoch seconds. `-1` / absent means a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** Local Storage for one origin, as ordered pairs. */
export interface StoredOrigin {
  origin: string;
  local: Array<[string, string]>;
}

export interface WebSession {
  /** ISO timestamp, for reporting how old a restored session is. */
  capturedAt: string;
  cookies: StoredCookie[];
  origins: StoredOrigin[];
}

const FILE_NAME = "websession.enc";

/**
 * Hosts whose cookies belong to a Stockbit session.
 *
 * Matched on the parsed host with a leading-dot allowance rather than by substring, for the same
 * reason `capture.ts` parses its URLs: `evil.test/stockbit.com` contains the name and is not the
 * host. Third-party analytics cookies riding on `.stockbit.com` come along, which is harmless — they
 * are already in the profile this writes back into.
 */
export function isStockbitCookieHost(domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  return host === "stockbit.com" || host.endsWith(".stockbit.com");
}

function fileKey(): Buffer {
  // Same derivation as the token store: tied to this machine and user, never stored.
  const material = `${hostname()}:${userInfo().username}:stockbit-mcp/v1`;
  const salt = Buffer.from("stockbit-mcp-websession-salt");
  return scryptSync(material, salt, 32);
}

function sessionPath(): string {
  return join(fileDir(), FILE_NAME);
}

/**
 * Persist a captured session — refusing, by default, to move the credential BACKWARDS.
 *
 * This file has three writers: the login capture, the post-chart re-capture in `chartbit/driver.ts`,
 * and `alignStoredCredential`. They are not ordered with respect to each other and the last write
 * wins. That is fine when every write carries the same or a newer credential, and silently
 * destructive when one does not:
 *
 *   - a capture taken from a page that had not finished restoring holds no `credentialStorage` at
 *     all, and would replace a good one with nothing;
 *   - a capture that began before a rotation and lands after it puts the RETIRED pair back, undoing
 *     the alignment and reintroducing the blank chart it exists to prevent.
 *
 * Both look like a successful save and read afterwards as a logout. A login is never affected: a
 * fresh pair always carries a later expiry than the one it replaces.
 */
export function saveWebSession(session: WebSession, options: { allowOlder?: boolean } = {}): void {
  if (!options.allowOlder && !supersedesStored(session)) return;
  mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  // Atomic, matching the token store: this file has two writers — the login capture and the
  // post-chart re-capture in `chartbit/driver.ts` — and a reader that hits a partially written file
  // cannot tell a torn write from a corrupt one. Both decrypt to nothing, both read as "no session",
  // and the user is asked to log in for no reason. A temp file plus rename removes the window.
  writeFileAtomic(sessionPath(), Buffer.concat([iv, cipher.getAuthTag(), data]));
}

export function loadWebSession(): WebSession | null {
  const path = sessionPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path);
    if (raw.length <= 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", fileKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(out) as WebSession;
    // A blob that decrypts but holds nothing usable is "no session", not a corrupt store: the same
    // answer the token store gives, so callers do not need two ways to ask.
    if (!Array.isArray(parsed?.cookies) || parsed.cookies.length === 0) return null;
    return parsed;
  } catch {
    // Tampered, key mismatch, or written on another machine. Indistinguishable from absent, and the
    // right response to all three is the same: log in again.
    return null;
  }
}

/**
 * Is `incoming` at least as current as what is already stored?
 *
 * Compares the ACCESS token's expiry, the one field that moves monotonically with each rotation.
 * Anything unreadable on the incoming side, when the stored side IS readable, counts as older — an
 * unreadable credential cannot be shown to be an improvement, and assuming it is one is how a good
 * session gets replaced by a half-loaded page's cookies.
 */
function supersedesStored(incoming: WebSession): boolean {
  const stored = loadWebSession();
  if (!stored) return true;
  const storedAt = readSessionAccessToken(stored)?.expiresAt ?? null;
  if (storedAt === null) return true;
  const incomingAt = readSessionAccessToken(incoming)?.expiresAt ?? null;
  if (incomingAt === null) return false;
  return incomingAt >= storedAt;
}

export function clearWebSession(): void {
  // Truncate rather than unlink, matching `TokenStore.clear` — an empty file and a missing one must
  // read the same way, and truncating cannot fail on a locked directory the way unlink can.
  if (existsSync(sessionPath())) writeFileAtomic(sessionPath(), Buffer.alloc(0));
}

/** Local Storage read/write, kept as literal strings for the same reason the chartbit page scripts are. */
const READ_LOCAL_STORAGE = `(function () {
  try {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      out.push([k, localStorage.getItem(k)]);
    }
    return JSON.stringify({ ok: true, origin: location.origin, local: out });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String(e && e.message ? e.message : e) });
  }
})()`;

/**
 * Find an attached page session sitting on a Stockbit origin.
 *
 * Returns null rather than throwing when there is none: capture is best-effort by design. A login
 * that captured the API token but could not read Local Storage is still a successful login, and
 * failing it here would trade a working credential for a missing one.
 */
async function attachToStockbitPage(cdp: CDP): Promise<{ sessionId: string; url: string } | null> {
  try {
    const { targetInfos } = (await cdp.send("Target.getTargets", {}, undefined, 5_000)) as {
      targetInfos?: Array<{ targetId: string; type?: string; url?: string }>;
    };
    const page = (targetInfos ?? []).find(
      (t) => t.type === "page" && /^https:\/\/[^/]*stockbit\.com\//i.test(t.url ?? ""),
    );
    if (!page) return null;
    const { sessionId } = (await cdp.send(
      "Target.attachToTarget",
      { targetId: page.targetId, flatten: true },
      undefined,
      5_000,
    )) as { sessionId?: string };
    if (!sessionId) return null;
    await cdp.send("Runtime.enable", {}, sessionId, 5_000).catch(() => {});
    return { sessionId, url: page.url ?? "" };
  } catch {
    return null;
  }
}

/**
 * Snapshot the live browser session out of a browser this module is already driving.
 *
 * `Storage.getCookies` is used rather than `Network.getAllCookies` because it does not require the
 * `Network` domain to be enabled — the same restraint the Chartbit driver is held to, applied here
 * so that turning capture on never widens what any component can see beyond cookies it is explicitly
 * asking for.
 */
export interface CaptureOptions {
  /**
   * Which cookie hosts belong to the session being captured. Defaults to Stockbit's.
   *
   * A test seam, and the same one `captureViaBrowserLogin`'s `isTokenUrl` sets: proving this
   * function works end to end means driving a real browser against a local fixture, and a fixture
   * on 127.0.0.1 is dropped by the real predicate. Overriding it here is how the capture path gets
   * exercised without Stockbit being involved at all.
   */
  hostFilter?: (domain: string) => boolean;
}

export async function captureWebSession(
  cdp: CDP,
  options: CaptureOptions = {},
): Promise<WebSession | null> {
  const hostFilter = options.hostFilter ?? isStockbitCookieHost;
  let cookies: StoredCookie[] = [];
  try {
    const res = (await cdp.send("Storage.getCookies", {}, undefined, 8_000)) as {
      cookies?: Array<Record<string, unknown>>;
    };
    cookies = (res.cookies ?? [])
      .filter((c) => hostFilter(String(c.domain ?? "")))
      .map((c) => ({
        name: String(c.name ?? ""),
        value: String(c.value ?? ""),
        domain: String(c.domain ?? ""),
        path: String(c.path ?? "/"),
        expires: typeof c.expires === "number" ? c.expires : undefined,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: typeof c.sameSite === "string" ? c.sameSite : undefined,
      }));
  } catch {
    return null;
  }
  if (cookies.length === 0) return null;

  const origins: StoredOrigin[] = [];
  const page = await attachToStockbitPage(cdp);
  if (page) {
    try {
      const r = (await cdp.send(
        "Runtime.evaluate",
        { expression: READ_LOCAL_STORAGE, returnByValue: true },
        page.sessionId,
        8_000,
      )) as { result?: { value?: string } };
      const parsed = JSON.parse(String(r.result?.value ?? "{}")) as {
        ok?: boolean;
        origin?: string;
        local?: Array<[string, string]>;
      };
      if (parsed.ok && parsed.origin && Array.isArray(parsed.local)) {
        origins.push({ origin: parsed.origin, local: parsed.local });
      }
    } catch {
      // Cookies alone are still worth keeping; some of Stockbit's session lives there.
    }
  }

  return { capturedAt: new Date().toISOString(), cookies, origins };
}

/**
 * Write a stored session back into whatever browser this cdp is driving.
 *
 * Cookies go in first and unconditionally. Local Storage needs a document on the origin to write
 * into, so it is injected with `Page.addScriptToEvaluateOnNewDocument` — which runs before the
 * page's own scripts on the NEXT navigation, so the app reads a populated store on first paint
 * rather than booting logged-out and being corrected afterwards.
 */
export async function restoreWebSession(cdp: CDP, session: WebSession): Promise<boolean> {
  try {
    await cdp.send("Storage.setCookies", { cookies: session.cookies }, undefined, 8_000);
  } catch {
    return false;
  }

  for (const origin of session.origins) {
    // Built by JSON-encoding the pairs and concatenating — never by interpolating values into
    // source. A Local Storage value is attacker-influenced content as far as this process is
    // concerned, and it must land as data on both the capture and the restore leg.
    const script =
      "(function () { try { var pairs = " +
      JSON.stringify(origin.local) +
      "; if (location.origin !== " +
      JSON.stringify(origin.origin) +
      ") return; for (var i = 0; i < pairs.length; i++) { try { localStorage.setItem(pairs[i][0], pairs[i][1]); } catch (e) {} } } catch (e) {} })()";
    try {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }, undefined, 5_000);
    } catch {
      // Browser-level add is not available on every build; the cookies may still be enough.
    }
  }
  return true;
}

/**
 * Write one origin's Local Storage into a document that is ALREADY on that origin.
 *
 * The sibling path in `restoreWebSession` uses `addScriptToEvaluateOnNewDocument`, which is right
 * when the caller is about to navigate anyway. It is wrong for seeding a profile: that registration
 * lives on the CDP session and dies with it, so nothing would be left on disk. Local Storage is
 * per-origin and only reachable from a document on it, so seeding means actually opening the origin
 * and writing — and then closing the browser gracefully, which is what commits it to the profile.
 *
 * Returns how many keys were written, so the caller can report a restore that silently wrote nothing.
 */
export async function writeOriginStorage(cdp: CDP, sessionId: string, origin: StoredOrigin): Promise<number> {
  const script =
    "(function () { var pairs = " +
    JSON.stringify(origin.local) +
    "; if (location.origin !== " +
    JSON.stringify(origin.origin) +
    ") return 0; var n = 0; for (var i = 0; i < pairs.length; i++) { try { localStorage.setItem(pairs[i][0], pairs[i][1]); n++; } catch (e) {} } return n; })()";
  try {
    const r = (await cdp.send(
      "Runtime.evaluate",
      { expression: script, returnByValue: true },
      sessionId,
      8_000,
    )) as { result?: { value?: number } };
    return typeof r.result?.value === "number" ? r.result.value : 0;
  } catch {
    return 0;
  }
}

/** Put the stored cookies into whatever browser this cdp drives. Cookies alone persist in a profile. */
export async function writeCookies(cdp: CDP, session: WebSession): Promise<boolean> {
  try {
    await cdp.send("Storage.setCookies", { cookies: session.cookies }, undefined, 8_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put the stored session into a freshly launched browser, before it opens anything.
 *
 * This is the whole point of the file, seen from the Chartbit side: the driver launches its profile
 * and calls this once, and from then on the page it opens is signed in. No interactive login, no
 * second browser, no page needed — `Storage.setCookies` is a browser-level call.
 *
 * Deliberately best-effort and silent about the reason. A caller that could not seed should go on to
 * open the chart anyway: the profile may already hold a perfectly good session, and failing here
 * would turn "we could not help" into "you cannot draw".
 */
export async function seedWebSession(
  cdp: CDP,
): Promise<{ seeded: boolean; cookies: number; ageHours: number | null }> {
  const session = loadWebSession();
  if (!session) return { seeded: false, cookies: 0, ageHours: null };
  const ok = await writeCookies(cdp, session);
  return { seeded: ok, cookies: ok ? session.cookies.length : 0, ageHours: sessionAgeHours(session) };
}

/**
 * The cookie the Stockbit web app authenticates from.
 *
 * Observed shape, URL-encoded JSON:
 *   { "state": { "access": <JWT>, "refresh": <JWT>, "user": {...} }, "version": 0 }
 *
 * The browser therefore holds BOTH tokens, and its access token is a 24-hour one while the CLI's
 * refresh token runs a week. That asymmetry is why the two drift apart so fast.
 */
/*
 * Writing the CLI's rotated tokens back into `credentialStorage`: forbidden in general, REQUIRED in
 * one narrow case. Read both halves before touching `alignStoredCredential` below.
 *
 * ## What the original experiment actually showed
 *
 * An earlier attempt planted a pair minted 0.6s earlier by `forceRefresh` — all 16 cookies plus 53
 * localStorage keys — into a CLEAN Chrome profile. The site redirected to /login and answered five
 * requests with 401. That was read as proof that the CLI cannot produce tokens the website accepts,
 * because Stockbit's JWTs carry a `dvc` (device fingerprint) and `ses` (session id) in the `data`
 * claim and nothing here sends either.
 *
 * The conclusion was broader than the experiment. A clean profile varies TWO things at once: the
 * tokens AND every device-identifying cookie the site sets on first contact. It cannot distinguish a
 * rejected token from an unrecognised browser.
 *
 * ## What is measured now
 *
 * The CLI and the browser do not hold related tokens — they hold THE SAME STRINGS. Verified against
 * a live store: the CLI's stored refresh token and this cookie's refresh token are byte-identical,
 * as are the two access tokens, sharing one `jti`, one `ses`, one `dvc`, one `iat`. One pair, kept
 * in two places. The CLI is not a second client; it is the same client with a second copy.
 *
 * That is what makes rotation different from minting. A rotated pair is issued BY the site FROM the
 * pair it just retired, so it inherits that pair's `ses` and `dvc` — the CLI never has to forge a
 * device binding, because it never mints one. Verified end to end: a deliberate rotation moved the
 * family to a new `jti`, the binding was unchanged, the rewritten cookie was accepted by the website
 * (chart page loaded signed in as the real user, normal body height, no login form), and drawing
 * worked on three symbols.
 *
 * Also measured, and it is the reason any of this matters: the refresh deadline moves FORWARD by the
 * elapsed time on each rotation. The ~7 days runs from the last rotation, not from the login. The
 * paragraph that used to stand here — "the website session can be preserved within its ~24h life; it
 * cannot be renewed from this side" — is wrong in both halves, and believing it is what produced a
 * login prompt roughly every day.
 *
 * ## The rule
 *
 * MINTING a website session from this side remains impossible and must not be attempted.
 *
 * PROPAGATING a rotation is necessary. Without it the two copies diverge the first time the CLI
 * refreshes on its own — about 24 hours after each login, when the shared access token lapses — and
 * the chart renders a zero-height body that reads as "logged out" on a session with six days left.
 *
 * The guard is what makes it safe: `alignStoredCredential` writes ONLY when the cookie holds the very
 * pair the refresh just retired. Such a cookie is ALREADY DEAD — the refresh killed it — so replacing
 * it can restore a session and cannot cost one.
 *
 * The OPPOSITE direction — reading the browser's token into the CLI's store — was never what this
 * forbade, and is done in `readCredentialStorage` and `resync.ts`. See ADR-0009.
 */

/** The cookie name the Stockbit web app keeps its token pair in. */
export const CREDENTIAL_COOKIE = "credentialStorage";

/**
 * Read the browser's CURRENT refresh token out of a captured session.
 *
 * This is the whole reason the chart's re-capture was not enough on its own. `saveWebSession` writes
 * the blob and stops; nothing ever read `state.refresh` as a token, so the rotated credential sat on
 * disk, encrypted, once per chart call, unread — while the next REST call presented the spent one
 * and 401'd.
 *
 * Three parsing facts, each of which produced a wrong answer when assumed away:
 *
 *  1. **The value is URL-encoded, and `decodeURIComponent` throws** on a malformed `%` escape. A
 *     cookie that cannot be decoded is "no token", never an exception — this runs inside a `finally`
 *     block on the chart path, and a drawing that succeeded must not become an error.
 *  2. **It is sometimes DOUBLE-encoded.** Decode up to twice, stopping as soon as `JSON.parse`
 *     succeeds, rather than decoding a fixed number of times: a JSON body legitimately contains `%`
 *     inside string values, and decoding once more than necessary corrupts it.
 *  3. **The host must be checked first.** `isStockbitCookieHost` parses the host rather than
 *     substring-matching it, for the reason `capture.ts` gives: `evil.test/stockbit.com` contains
 *     the name and is not the host. A capture is filtered on that already, but this function is
 *     public and must not depend on its caller having done so.
 *
 * The explicit `state.refresh` path is tried first and `extractRefresh` is the fallback. Order
 * matters: the cookie also carries `state.user`, and a structural search over the whole blob could
 * in principle find a `refresh`-keyed value somewhere else in it. The explicit path says which field
 * this project means; the fallback survives the envelope moving, which it has done before.
 */
/**
 * The credential cookie, decoded once, with everything a reader OR a writer needs.
 *
 * Split out of `readCredentialStorage` because there are now four things that need this cookie —
 * the refresh token, the access token, the two expiries, and the write-back — and four copies of a
 * three-pass decode loop is four chances to disagree about what the cookie says.
 *
 * `decodes` is carried because a writer has to re-encode exactly as many times as the reader peeled.
 * Writing plain JSON over a value that arrived URL-encoded parses fine here and not in the browser.
 */
interface ParsedCredential {
  /** Where the cookie sits in `session.cookies`, so a writer can put it back in place. */
  index: number;
  /** How many `decodeURIComponent` passes were needed to reach JSON. */
  decodes: number;
  payload: unknown;
}

function parseCredentialCookie(session: WebSession, options: CaptureOptions = {}): ParsedCredential | null {
  const hostFilter = options.hostFilter ?? isStockbitCookieHost;
  const index = session.cookies.findIndex((c) => c.name === CREDENTIAL_COOKIE && hostFilter(c.domain));
  if (index < 0) return null;
  const cookie = session.cookies[index];
  if (!cookie?.value) return null;

  let text = cookie.value;
  for (let decodes = 0; decodes < 3; decodes++) {
    try {
      return { index, decodes, payload: JSON.parse(text) as unknown };
    } catch {
      // Not JSON yet. Peel one layer of URL encoding and try again — but only if peeling actually
      // changes something, or a value that is simply not JSON spins for the full three passes.
      let next: string;
      try {
        next = decodeURIComponent(text);
      } catch {
        return null; // malformed % escape
      }
      if (next === text) return null;
      text = next;
    }
  }
  return null;
}

/**
 * One slot of the cookie's token pair, in either shape it has been seen in.
 *
 * The header above documents `{ "access": <JWT>, "refresh": <JWT> }`, and that is what
 * `readCredentialStorage` was written against. The live cookie on a current Stockbit build carries
 * `{ "access": { "token": <JWT>, "expired_at": <ISO> }, ... }` instead. Both are handled, because
 * assuming either one exclusively is how this stops working on a Tuesday.
 */
function slotToken(slot: unknown): string | null {
  if (looksLikeJwt(slot)) return slot;
  const nested = (slot as { token?: unknown } | undefined)?.token;
  return looksLikeJwt(nested) ? nested : null;
}

/** A slot's expiry: the explicit `expired_at` when present, else the JWT's own `exp`. */
function slotExpirySeconds(slot: unknown): number | null {
  const explicit = (slot as { expired_at?: unknown } | undefined)?.expired_at;
  if (typeof explicit === "string") {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  const token = slotToken(slot);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

export function readCredentialStorage(
  session: WebSession,
  options: CaptureOptions = {},
): string | null {
  const parsed = parseCredentialCookie(session, options);
  if (!parsed) return null;
  const state = (parsed.payload as { state?: unknown } | null)?.state;
  const direct = (state as { refresh?: unknown } | undefined)?.refresh;
  // `slotToken` rather than `looksLikeJwt` alone: the explicit path must find the token in the
  // object shape too, or a current cookie falls through to the structural search for no reason.
  const explicit = slotToken(direct);
  if (explicit) return explicit;
  return extractRefresh(parsed.payload);
}

/** How old a restored session is, for reporting. */
export function sessionAgeHours(session: WebSession): number | null {
  const t = Date.parse(session.capturedAt);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
}

/**
 * Stockbit's website session lasts about a day.
 *
 * Measured on the real `credentialStorage` cookie: its access token carries `exp = iat + 24h`, while
 * the CLI's refresh token in `refresh.enc` runs a week. That asymmetry is not a detail — it is why
 * the website logs out while `status` still reports a healthy token, and why the two must be reported
 * as separate things rather than as one "are you logged in".
 */
/**
 * The ACCESS token's life, which is NOT the session's life.
 *
 * Measured on the real `credentialStorage` cookie: `state.access` carries `exp = iat + 24h`. That
 * number used to stand in for the whole session, and that was the bug — see `webSessionHealth`.
 */
export const ACCESS_TOKEN_LIFETIME_HOURS = 24;

/** The two expiries carried inside the credential cookie, and who it belongs to. Safe to log. */
export interface WebSessionCredential {
  /** ISO timestamp the 24h access token dies. Expiring is normal and not fatal — the SPA renews it. */
  accessExpiresAt: string | null;
  /** ISO timestamp the ~7d refresh token dies. THIS is the session's real deadline. */
  refreshExpiresAt: string | null;
  username: string | null;
}

/**
 * Pull the expiries out of a stored session, and nothing else.
 *
 * Deliberately returns no tokens, so it stays safe to log and to put in a status report. Tolerant by
 * construction: every failure is `null` rather than a throw, because `collectStatus` requires a
 * health probe that cannot fail.
 */
export function readSessionCredential(session: WebSession): WebSessionCredential | null {
  const parsed = parseCredentialCookie(session);
  if (!parsed) return null;
  const state = (parsed.payload as { state?: Record<string, unknown> } | null)?.state;
  if (!state || typeof state !== "object") return null;

  const iso = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());
  const user = (state as { user?: { username?: unknown } }).user;
  return {
    accessExpiresAt: iso(slotExpirySeconds(state.access)),
    refreshExpiresAt: iso(slotExpirySeconds(state.refresh)),
    username: typeof user?.username === "string" ? user.username : null,
  };
}

/**
 * The ACCESS token the browser is currently holding.
 *
 * Separate from `readSessionCredential`, which returns expiries only and must stay safe to log.
 * This one hands back a live bearer credential, so it exists for exactly one purpose: letting the
 * CLI adopt the browser's token instead of minting one and retiring the browser's in the process.
 */
export function readSessionAccessToken(session: WebSession): { token: string; expiresAt: number } | null {
  const parsed = parseCredentialCookie(session);
  if (!parsed) return null;
  const state = (parsed.payload as { state?: Record<string, unknown> } | null)?.state;
  if (!state || typeof state !== "object") return null;
  const token = slotToken(state.access);
  const expiresAt = slotExpirySeconds(state.access);
  // A token with no readable deadline is worse than none: it would be served until it 401s.
  if (!token || expiresAt === null) return null;
  return { token, expiresAt };
}

/**
 * Three states, not two — and only one of them may stop a browser from launching.
 *
 * `likelyValid` and `expired` are NOT complements. Both are false in the third state, "unknown",
 * where the credential could not be read at all. That distinction is the entire fix: treating
 * unknown as dead is what made a readable-but-old session block, and treating it as alive would
 * hide a real logout. Unknown means "go and look".
 */
export interface WebSessionHealth {
  present: boolean;
  /** Capture age. Informational — it is NOT what decides anything any more. */
  ageHours: number | null;
  /** PROVABLY alive: the refresh token's expiry was read and is in the future. */
  likelyValid: boolean;
  /** PROVABLY dead: the refresh token's expiry was read and has passed. Only this blocks a launch. */
  expired: boolean;
  hint: string;
  /** What the verdict rests on. `unknown` means nothing is claimed either way. */
  basis: "refresh-token" | "unknown" | "absent";
  /** Hours until the ~7d refresh token dies — the session's real deadline. Null if unreadable. */
  refreshHoursLeft: number | null;
  refreshExpiresAt: string | null;
  /** Hours until the 24h access token dies. Negative is NORMAL and not fatal. */
  accessHoursLeft: number | null;
  accessExpiresAt: string | null;
}

/**
 * How healthy is the stored website session, as far as can be told WITHOUT spending anything?
 *
 * ## Judge the refresh token, not the clock
 *
 * This used to answer "is the stored session younger than 24 hours", and that was wrong in the
 * expensive direction. 24 hours is the ACCESS token's life. The same cookie carries a REFRESH token
 * good for about a week, and the SPA spends it on boot. So a session whose access token lapsed
 * overnight is not dead — it is one page load from being renewed.
 *
 * Reporting it as aged out made `withChart` refuse to launch a browser that would have worked, and
 * told the user to log in again roughly every day on a credential with six days left. The old code
 * even said so out loud: "Stockbit's lasts about 24h, so it has aged out."
 *
 * The tell was an inversion. The guard only fired when a session was PRESENT, so a missing
 * `websession.enc` sailed through while a readable 25-hour-old one was refused — deleting the file
 * behaved better than keeping it. Whenever absence outperforms evidence, the test is backwards.
 *
 * Never throws: `collectStatus` requires that, and a health probe that can fail is not one.
 */
export function webSessionHealth(): WebSessionHealth {
  let session: WebSession | null = null;
  try {
    session = loadWebSession();
  } catch {
    session = null;
  }

  const base = {
    ageHours: null,
    likelyValid: false,
    expired: false,
    refreshHoursLeft: null,
    refreshExpiresAt: null,
    accessHoursLeft: null,
    accessExpiresAt: null,
  };

  if (!session) {
    return {
      ...base,
      present: false,
      basis: "absent" as const,
      hint: "No website session stored — the chart needs a login before it will open.",
    };
  }

  const age = sessionAgeHours(session);
  const credential = readSessionCredential(session);
  const hoursUntil = (iso: string | null) => (iso === null ? null : (Date.parse(iso) - Date.now()) / 3_600_000);
  const refreshHoursLeft = hoursUntil(credential?.refreshExpiresAt ?? null);
  const accessHoursLeft = hoursUntil(credential?.accessExpiresAt ?? null);
  const shared = {
    ...base,
    present: true,
    ageHours: age,
    refreshExpiresAt: credential?.refreshExpiresAt ?? null,
    accessExpiresAt: credential?.accessExpiresAt ?? null,
    refreshHoursLeft,
    accessHoursLeft,
  };

  // Unknown. Say so, and do not stand in the way — the chart's own logged-out detection is a better
  // answer than a guess made from here.
  if (refreshHoursLeft === null) {
    return {
      ...shared,
      basis: "unknown" as const,
      hint:
        "A website session is stored but its credential could not be read, so nothing is claimed " +
        "about it either way. Opening a chart will settle it.",
    };
  }

  if (refreshHoursLeft <= 0) {
    return {
      ...shared,
      expired: true,
      basis: "refresh-token" as const,
      hint:
        `The stored website session's refresh token expired ${Math.abs(refreshHoursLeft).toFixed(1)}h ago, ` +
        "so the chart cannot open. Run `stockbit-auth login`. The REST tools use a separate credential " +
        "and are unaffected.",
    };
  }

  const days = (refreshHoursLeft / 24).toFixed(1);
  const accessNote =
    accessHoursLeft !== null && accessHoursLeft <= 0
      ? " Its 24h access token has lapsed, which is normal overnight — the page re-mints one on load."
      : "";
  return {
    ...shared,
    likelyValid: true,
    basis: "refresh-token" as const,
    hint:
      `Website session is alive — its refresh token is good for another ${days} day(s)` +
      (age === null ? "" : ` (captured ${age.toFixed(1)}h ago)`) +
      `.${accessNote} Each token refresh slides that deadline forward, so regular use keeps it alive.`,
  };
}

/**
 * The reason a chart must NOT be opened, or null.
 *
 * Split out from the health report so the launch decision has exactly one input and cannot drift
 * from the reasoning behind it. Only a PROVABLY expired refresh token blocks. Unknown does not, and
 * that is the point: the previous guard blocked on `!likelyValid`, which lumped "cannot read this"
 * in with "this is dead" and refused perfectly good sessions.
 */
export function webSessionLaunchBlocker(): string | null {
  const health = webSessionHealth();
  return health.present && health.expired ? health.hint : null;
}

/* ------------- keeping the CLI's copy and the browser's copy on one generation ------------- */

/** Why an alignment did or did not happen. Reported, never thrown — this must not fail a refresh. */
export type CredentialAlignment =
  | "aligned"
  | "already-current"
  | "no-session"
  | "unreadable"
  | "different-generation"
  | "binding-mismatch";

/** The `ses`/`dvc` pair a token is bound to, or null when it cannot be read. */
function tokenBinding(token: string): { ses: unknown; dvc: unknown } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const data = (claims.data ?? claims) as Record<string, unknown>;
    if (data.ses === undefined && data.dvc === undefined) return null;
    return { ses: data.ses, dvc: data.dvc };
  } catch {
    return null;
  }
}

function sameBinding(before: string, after: string): boolean {
  const a = tokenBinding(before);
  const b = tokenBinding(after);
  // Unreadable on either side is not evidence of a mismatch. Refusing to align on an unparseable
  // claim would reinstate the bug for anyone whose tokens stop being JWTs.
  if (!a || !b) return true;
  return a.ses === b.ses && a.dvc === b.dvc;
}

/**
 * Write a rotated token into one slot of the cookie, preserving the shape that slot arrived in.
 *
 * The cookie has been seen carrying a bare JWT string AND an object with `token`/`expired_at`.
 * Rewriting one shape as the other would parse cleanly here and confuse the web app, so the incoming
 * shape decides the outgoing one.
 */
function writeSlot(state: Record<string, unknown>, key: "access" | "refresh", token: string, expiresAt?: number): void {
  const existing = state[key];
  if (looksLikeJwt(existing)) {
    state[key] = token;
    return;
  }
  state[key] = {
    ...(typeof existing === "object" && existing !== null ? existing : {}),
    token,
    // A rotation with no readable expiry keeps the old deadline rather than inventing one.
    // Overstating it would hide a dead session behind a confident-looking date.
    ...(expiresAt === undefined ? {} : { expired_at: new Date(expiresAt * 1000).toISOString() }),
  };
}

/**
 * Carry a rotation the CLI just performed across to the browser's copy of the same credential.
 *
 * Called after a successful `main` refresh, with the refresh token that was SPENT. Two guards decide
 * whether anything is written, and both must pass:
 *
 *  1. The cookie must hold the exact refresh token that was spent. That is what proves this cookie is
 *     the generation the refresh retired — already dead, so replacing it risks nothing. Any other
 *     value belongs to a generation this process did not retire and must be left alone.
 *  2. The new pair must carry the same `ses` and `dvc` as the old one. Rotation inherits the device
 *     binding; minting does not. If that ever stops holding, the tokens would be useless to the
 *     browser and writing them would destroy a session instead of extending it.
 *
 * Never throws: a failure to align must not turn a working refresh into a failed request.
 */
export function alignStoredCredential(
  spentRefreshToken: string,
  next: { access: string; accessExpiresAt: number; refresh?: string; refreshExpiresAt?: number },
): CredentialAlignment {
  try {
    const session = loadWebSession();
    if (!session) return "no-session";
    const parsed = parseCredentialCookie(session);
    if (!parsed) return "unreadable";

    const state = (parsed.payload as { state?: Record<string, unknown> } | null)?.state;
    if (!state || typeof state !== "object") return "unreadable";

    const heldRefresh = slotToken(state.refresh);
    const heldAccess = slotToken(state.access);
    if (!heldRefresh) return "unreadable";

    if (heldAccess === next.access && heldRefresh === (next.refresh ?? heldRefresh)) return "already-current";
    if (heldRefresh !== spentRefreshToken) return "different-generation";
    if (!sameBinding(heldRefresh, next.access)) return "binding-mismatch";

    writeSlot(state, "access", next.access, next.accessExpiresAt);
    if (next.refresh) writeSlot(state, "refresh", next.refresh, next.refreshExpiresAt);

    // Re-encode exactly as many times as the reader peeled, or the browser gets a value it cannot
    // read — the same corruption in the opposite direction.
    let value = JSON.stringify(parsed.payload);
    for (let i = 0; i < parsed.decodes; i++) value = encodeURIComponent(value);

    session.cookies[parsed.index] = { ...session.cookies[parsed.index], value };
    // `allowOlder`: this write moves the credential FORWARD by construction, but it is doing so
    // through the same monotonicity guard that exists to stop stale captures. The guard compares
    // against what is on disk, which is what this is replacing.
    saveWebSession(session, { allowOlder: true });
    return "aligned";
  } catch {
    return "unreadable";
  }
}

/**
 * The browser's access token, when it is live enough to use — the read half of the same alignment.
 *
 * The browser can rotate without this process knowing: the SPA may spend its refresh token on boot,
 * and the chart driver captures whatever it finds on the way out. When the cookie ends up AHEAD of
 * the CLI, the CLI must follow it rather than refresh past it — refreshing past it would retire the
 * generation the chart is using, the same failure as the write side from the other direction.
 *
 * `resync.ts` already does this for the REFRESH token. This is the access token, which is what a
 * request actually presents, and following it is what makes a refresh unnecessary rather than merely
 * recoverable.
 */
export function browserAccessToken(skewSeconds = 0): { token: string; expiresAt: number } | null {
  const session = loadWebSession();
  if (!session) return null;
  const access = readSessionAccessToken(session);
  if (!access) return null;
  const now = Math.floor(Date.now() / 1000);
  return access.expiresAt - now > skewSeconds ? access : null;
}
