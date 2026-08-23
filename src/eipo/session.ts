/**
 * Minting the e-IPO session.
 *
 * The third token domain, and the only one that needs no new consent from the user. The securities
 * session costs a PIN typed at a terminal; this one is derived from the market-data login the user
 * already did:
 *
 *   1. `GET exodus/auth/eipo/webview/link` — the app opens e-IPO in a webview and this is the URL
 *      it opens, carrying a short-lived grant in its query string.
 *   2. `POST sekuritas/partner/eipo/access_token` with that grant → `{access_token, refresh_token}`.
 *   3. The refresh token goes into the `eipo` store slot; the access token is seeded in memory.
 *
 * After that `ensureFresh("eipo")` keeps it alive on its own, through `GET /partner/refresh_token`
 * with the token in the query string — the one refresh in this project that sends no header at all.
 *
 * ## Why minting is explicit rather than automatic inside the HTTP client
 *
 * `getJson` refreshes an expired token by itself, which is right: a refresh is invisible plumbing.
 * Minting is not. It reaches across two hosts, spends a grant issued for a webview, and creates a
 * credential that did not exist. A read that quietly did that as a side effect would make "this tool
 * only reads market data" false in a way nobody would notice. So every e-IPO read calls
 * `ensureEipoSession()` first, in the open.
 *
 * ## The grant's shape is not known
 *
 * Neither the link response nor the exchange body has been observed. Both are searched
 * structurally rather than matched against a fixed path: the token is found wherever a token-shaped
 * key or a URL query parameter holds it, and the exchange is attempted with the field names
 * Stockbit's other exchanges use. A failure here says exactly what it looked for.
 */
import { getJson, postJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { getStore } from "../auth/store.js";
import { adoptAccessToken, ensureFresh, hasStoredSession, parseRefresh } from "../auth/session.js";

/** Keys that plausibly carry the webview grant, and the query parameters that plausibly hold it. */
const GRANT_KEYS = /^(token|access_?token|grant|code|auth_?token)$/i;
const LINK_KEYS = /^(link|url|webview_?url|webview_?link|redirect_?url)$/i;

/**
 * Find the grant in the webview-link response.
 *
 * Two shapes are accepted because both are plausible and neither has been seen: a token sitting in
 * a field of its own, or a URL whose query string carries one. A URL is tried second so a response
 * that has both prefers the explicit field.
 */
export function findGrant(body: unknown): string | undefined {
  const seen = new Set<object>();
  const links: string[] = [];

  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" && child) {
        if (GRANT_KEYS.test(key)) return child;
        if (LINK_KEYS.test(key) && /^https?:\/\//i.test(child)) links.push(child);
      }
      const nested = walk(child);
      if (nested) return nested;
    }
    return undefined;
  };

  const direct = walk(body);
  if (direct) return direct;

  for (const link of links) {
    try {
      const url = new URL(link);
      for (const [key, value] of url.searchParams) {
        if (GRANT_KEYS.test(key) && value) return value;
      }
    } catch {
      /* not a URL after all */
    }
  }
  return undefined;
}

/**
 * Make sure an e-IPO access token is available, minting the session if there is none.
 *
 * Returns how the token was obtained, so a caller can say "this created a new e-IPO session" rather
 * than reporting a read that silently did.
 */
export async function ensureEipoSession(): Promise<{ minted: boolean }> {
  if (hasStoredSession("eipo")) {
    await ensureFresh("eipo");
    return { minted: false };
  }

  const linkBody = await getJson("eipoWebviewLink");
  const grant = findGrant(linkBody);
  if (!grant) {
    throw new StockbitError(
      "auth",
      "Stockbit returned no e-IPO grant. The response carried no token-shaped field and no link with a " +
        "token in its query string. Your market-data session may have expired — run `stockbit-auth login`.",
    );
  }

  // Both spellings, in one body. The exchange has not been observed and an extra field is far more
  // likely to be ignored than a missing one is to be defaulted.
  const exchanged = await postJson("eipoAccessToken", { body: { token: grant, access_token: grant } });

  let parsed: ReturnType<typeof parseRefresh>;
  try {
    parsed = parseRefresh(exchanged);
  } catch {
    throw new StockbitError(
      "auth",
      "The e-IPO token exchange returned no access token this project could find. Re-run with " +
        "STOCKBIT_DEBUG=1 to print the response SHAPE (keys and types, never values).",
    );
  }

  if (parsed.newRefresh) getStore("eipo").set(parsed.newRefresh);
  adoptAccessToken("eipo", parsed.access, parsed.expiresAt);
  return { minted: true };
}
