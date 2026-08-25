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

export function saveWebSession(session: WebSession): void {
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
export async function captureWebSession(cdp: CDP): Promise<WebSession | null> {
  let cookies: StoredCookie[] = [];
  try {
    const res = (await cdp.send("Storage.getCookies", {}, undefined, 8_000)) as {
      cookies?: Array<Record<string, unknown>>;
    };
    cookies = (res.cookies ?? [])
      .filter((c) => isStockbitCookieHost(String(c.domain ?? "")))
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
 * DO NOT add a "write the CLI's rotated tokens back into credentialStorage" path here.
 *
 * It was built, and it was wrong, and the shape of it is inviting enough that it will be proposed
 * again — so this is the record of why it cannot work.
 *
 * The idea: the CLI refreshes, receives a new access token and a rotated refresh token, and those
 * are the same two fields the website keeps in `credentialStorage`. Writing them back looks like it
 * would keep both sides on the same rotation instead of fighting over it.
 *
 * It does not. MEASURED: a pair minted 0.6 seconds earlier through `forceRefresh`, planted as all 16
 * cookies PLUS 53 localStorage keys into a clean Chrome profile, is rejected by the website — it
 * redirects to /login and answers five requests with 401. The tokens are the right shape, the right
 * issuer, and unexpired. The site still refuses them, because its own tokens carry a device binding
 * the CLI's refresh route does not reproduce: `docs/stockbit-api.md` records `dvc` (device
 * fingerprint) and `ses` (session id) inside the JWT `data` claim, and nothing in this project sends
 * either.
 *
 * So writing CLI tokens into the cookie does not extend the website session. It OVERWRITES a working
 * one with credentials the site will not accept, turning a healthy profile into a logged-out one.
 *
 * What actually works is already here: capture the browser's OWN session (login, and after every
 * chart use in `chartbit/driver.ts`) and seed it back. The website session can be preserved within
 * its ~24h life. It cannot be renewed from this side. See `webSessionHealth` below.
 */

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
export const WEB_SESSION_LIFETIME_HOURS = 24;

export interface WebSessionHealth {
  present: boolean;
  ageHours: number | null;
  /** Age-based only. A session can also die early — anything that rotates the family ends it. */
  likelyValid: boolean;
  hint: string;
}

/**
 * How healthy is the stored website session, as far as can be told WITHOUT spending anything?
 *
 * Deliberately age-based rather than a live check: proving a session works means using it, using it
 * means refreshing, and refreshing is exactly what kills it. So this answers the cheap question and
 * is honest that the answer is a floor — `likelyValid` says the session has not aged out, never that
 * it is definitely alive.
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
  if (!session) {
    return {
      present: false,
      ageHours: null,
      likelyValid: false,
      hint: "No website session stored — the chart needs a login before it will open.",
    };
  }
  const age = sessionAgeHours(session);
  if (age === null) {
    return {
      present: true,
      ageHours: null,
      likelyValid: false,
      hint: "A website session is stored but its age is unreadable; treat it as needing a login.",
    };
  }
  const left = WEB_SESSION_LIFETIME_HOURS - age;
  if (left <= 0) {
    return {
      present: true,
      ageHours: age,
      likelyValid: false,
      hint:
        `The stored website session is ${age.toFixed(1)}h old and Stockbit's lasts about ` +
        `${WEB_SESSION_LIFETIME_HOURS}h, so it has aged out. A fresh login is needed.`,
    };
  }
  return {
    present: true,
    ageHours: age,
    likelyValid: true,
    hint:
      `Website session is ${age.toFixed(1)}h old, roughly ${left.toFixed(1)}h before it ages out. ` +
      "It can still end sooner if something rotates the token family.",
  };
}
