/**
 * Token-recognition rules, shared by every capture route.
 *
 * These are pure functions on purpose. The live browser capture (`login.ts`) and the offline HAR
 * importer (`har.ts`) must agree exactly on *which response may carry a session token* and *how a
 * token is read out of one* — if those rules ever diverge, one route accepts a credential the other
 * rejects, and the difference shows up as an intermittent login bug rather than a test failure.
 */

/** JWT shape: three base64url segments. Not a signature check — we only ever carry these. */
export function looksLikeJwt(v: unknown): v is string {
  return typeof v === "string" && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v);
}

/**
 * Whether a response URL is allowed to be a *main-session* refresh-token source.
 *
 * Stockbit issues `refresh` fields on several token domains and only one of them authorizes the
 * exodus market-data reads this project makes. Accepting the wrong one stores a credential that
 * refreshes into a token the API rejects — an auth failure hours later, far from its cause.
 */
export function tokenUrlAllowed(url: string): boolean {
  // Securities / e-IPO partner tokens. Different audience; never the main session.
  if (/api-sekuritas\.stockbit\.com|eipo|\/partner\//i.test(url)) return false;
  if (/wssocial\.stockbit\.com/i.test(url)) return true;
  if (!/exodus\.stockbit\.com/i.test(url)) return false;

  // For email/password accounts with phone verification, this final verification response issues
  // the usable session token. No additional token response occurs after the logged-in page loads.
  if (/\/login\/v\d+\/new-device\/(?:prompt\/)?verify(?:[/?]|$)/i.test(url)) return true;
  if (/verification|\/otp(?:[/?]|$)/i.test(url)) return false;

  // Direct credential logins issue the session on their final response.
  //   /login/v6/username, /login/v3/username/browser  — password
  //   /login/v6/social                                — Google/Facebook (current build)
  //   /login/v4/google, /login/v4/facebook            — legacy social, still in the bundle
  return (
    /\/login\/v\d+\/(?:username(?:\/browser)?|social|google|facebook)(?:[/?]|$)/i.test(url) ||
    /\/auth\/v\d+\/login(?:[/?]|$)/i.test(url)
  );
}

/**
 * Find a `refresh` / `refresh_token` JWT anywhere in a parsed response body.
 *
 * Walks the whole object because the envelope has moved across API versions — currently
 * `data.token_data.refresh.token`, historically a bare top-level `refresh`. A structural search
 * survives that drift; a hard-coded path does not.
 */
export function extractRefresh(body: unknown): string | null {
  const seen = new Set<object>();
  const walk = (o: unknown): string | null => {
    if (!o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/^refresh(_token)?$/i.test(k) && looksLikeJwt(v)) return v;
      if (/^refresh(_token)?$/i.test(k) && v && typeof v === "object") {
        const token = (v as Record<string, unknown>).token;
        if (looksLikeJwt(token)) return token;
      }
      const nested = walk(v);
      if (nested) return nested;
    }
    return null;
  };
  return walk(body);
}

/**
 * Pull a refresh token out of a response body that may be base64-encoded.
 *
 * Both CDP (`Network.getResponseBody`, `Fetch.getResponseBody`) and HAR
 * (`response.content.encoding`) hand back bodies that are *sometimes* base64 — Chrome encodes even
 * textual payloads when they contain code points it considers unsafe to inline. Branching on the
 * flag rather than sniffing the text is the only reliable read.
 */
export function refreshFromRawBody(raw: string, base64Encoded: boolean): string | null {
  if (!raw) return null;
  const text = base64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  try {
    return extractRefresh(JSON.parse(text));
  } catch {
    // Not JSON. Fall back to a direct scan so a token embedded in a non-JSON envelope
    // (an HTML postMessage shim, a JSONP wrapper) is still found.
    const m = text.match(
      /"refresh(?:_token)?"\s*:\s*(?:"|\{\s*"token"\s*:\s*")(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[^"]+)/i,
    );
    return m?.[1] ?? null;
  }
}

/**
 * Whether a response URL may carry a *securities* (Stockbit Sekuritas) token.
 *
 * A separate predicate from `tokenUrlAllowed` rather than a widening of it, and deliberately so:
 * the main-session rule REJECTS carina, and it must keep rejecting it. Storing a trading token in
 * the market-data slot would refresh into a token exodus does not accept, and the failure would
 * arrive hours later as an unexplained 401 far from its cause. Two predicates, two slots, no
 * overlap — and `test/login.test.ts` asserts the exclusion in both directions.
 *
 * This exists for the `--browser` fallback: when Cloudflare Turnstile blocks the direct PIN login,
 * the user completes it in the logged-in browser and the response is captured the same way the
 * original login was.
 */
export function securitiesTokenUrlAllowed(url: string): boolean {
  // The HOST is parsed, not matched as a substring. `https://evil.test/x/carina.stockbit.com/auth/refresh`
  // contains the host name and is not the host — a substring test would accept a token from an
  // attacker-controlled origin, which is the one mistake this predicate exists to prevent.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname.toLowerCase() !== "carina.stockbit.com") return false;
  // The login and refresh responses are the two that carry a session. PIN validation does not.
  return /^\/auth\/v\d+\/login\/?$/i.test(parsed.pathname) || /^\/auth\/refresh\/?$/i.test(parsed.pathname);
}
