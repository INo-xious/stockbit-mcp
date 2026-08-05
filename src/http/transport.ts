/**
 * The authenticated-request boundary. **This is the only module in the codebase that may attach a
 * Stockbit credential to an outbound request**, and `test/transport.test.ts` fails CI if another
 * one starts doing so.
 *
 * The invariant is ADR-0002's: no mutation of Stockbit account data, enforced as an exact
 * host + method + path policy rather than by method alone. "GET only" was never the real property —
 * the process legitimately POSTs `/login/refresh`. So instead of a rule about verbs, there is a
 * closed table of permitted request shapes below, and a request that does not match one is not
 * sent.
 *
 * Two properties make that policy a control rather than a convention:
 *
 *   1. **Closed route table.** Callers name a route; they do not pass a path. There is no
 *      caller-supplied host — the `base` override this module replaced let any call site point a
 *      bearer-carrying request at any origin.
 *   2. **No redirect following.** A 3xx that relocates a bearer-carrying request is a rejection,
 *      not a hop. Undici would otherwise replay the Authorization header at the new location.
 *
 * Outbound *notification* delivery (M3) is a separate path that never carries this credential and
 * pins its own origins independently. It does not belong here.
 */
import { HOSTS, RATE, defaultHeaders } from "../config.js";
import { StockbitError } from "./errors.js";
import { normalizeSymbol } from "../symbol.js";

/* ------------------------------------ host policy ------------------------------------ */

/**
 * The single origin permitted to receive the Stockbit bearer. Compared by parsed `URL.origin`, so
 * scheme and port are part of the check and `exodus.stockbit.com.evil.test` cannot match.
 */
export const AUTHENTICATED_ORIGIN = new URL(HOSTS.exodus).origin;

/* ------------------------------------ route table ------------------------------------ */

/**
 * Dynamic path segments, by name. A segment's *name in the template* selects its validator, so
 * adding `:symbol` to a route cannot accidentally get a laxer rule than every other `:symbol`.
 */
const SEGMENT_VALIDATORS = {
  symbol: normalizeSymbol,
  moverType: (value: string): string => {
    if (value !== "topGainer" && value !== "topLoser" && value !== "mostActive") {
      throw new StockbitError(
        "invalid_param",
        `Invalid mover type ${JSON.stringify(value)}: expected topGainer, topLoser, or mostActive`,
      );
    }
    return value;
  },
} as const;

type SegmentName = keyof typeof SEGMENT_VALIDATORS;

interface RouteSpec {
  readonly method: "GET" | "POST";
  /** Absolute path; `:name` marks one dynamic segment validated by `SEGMENT_VALIDATORS[name]`. */
  readonly template: string;
}

/**
 * Every authenticated request this project is permitted to make.
 *
 * Market-data reads are `GET`. `loginRefresh` is the sole write and mutates session state only —
 * it lives in this table as an ordinary declared route rather than as the special case
 * `src/auth/session.ts` used to make of it with a direct `fetch`.
 *
 * Adding a row is a deliberate act reviewable in a diff. Anything absent — every `/chartbit/*`
 * write, every other host — is rejected here rather than by convention.
 */
export const ROUTES = {
  /* -- session (the only write) -- */
  loginRefresh: { method: "POST", template: "/login/refresh" },

  /* -- quote, trending, sectors, movers -- */
  emittenInfo: { method: "GET", template: "/emitten/:symbol/info" },
  emittenTrending: { method: "GET", template: "/emitten/trending" },
  emittenSectors: { method: "GET", template: "/emitten/sectors" },
  emittenHotlist: { method: "GET", template: "/emitten/hotlist/:moverType" },

  /* -- price feed -- */
  pricesClose: { method: "GET", template: "/company-price-feed/prices/close" },
  /**
   * Daily OHLCV. Returns exactly 12 rows per page and ignores every widening parameter, so a long
   * series costs many upstream calls — see `src/core/bars.ts` for how the walk is bounded.
   */
  historicalSummary: { method: "GET", template: "/company-price-feed/historical/summary/:symbol" },
  /**
   * The same daily series as `historicalSummary`, served to Stockbit's own charting front-end, which
   * honours `from`/`to` and `limit=0` — a whole range in one request rather than 12 rows at a time.
   *
   * A `/chartbit/*` route in this table is narrower than it looks. ADR-0002 rejects Chartbit
   * *writes* and says in the same breath that Chartbit **reads** "remain desirable and carry no
   * write surface". This is a GET on a price series; it adds no mutation reachability, and the
   * layout/drawing paths the ADR is about stay absent — `test/transport.test.ts` still proves they
   * are unreachable by any method.
   */
  chartbitDaily: { method: "GET", template: "/chartbit/:symbol/price/daily" },
  pricePerformance: { method: "GET", template: "/company-price-feed/price-performance/:symbol" },
  orderbook: { method: "GET", template: "/company-price-feed/v2/orderbook/companies/:symbol" },

  /* -- broker summary / bandarmology -- */
  marketDetectors: { method: "GET", template: "/marketdetectors/:symbol" },
  /**
   * Broker-to-broker flow matrix. Served by the order-trade service rather than marketdetectors,
   * and it takes the symbol as a QUERY parameter, not a path segment — hence no `:symbol` here.
   */
  brokerDistribution: { method: "GET", template: "/order-trade/broker/distribution" },

  /* -- fundamentals -- */
  keystats: { method: "GET", template: "/keystats/:symbol" },
  keystatsRatio: { method: "GET", template: "/keystats/ratio/v1/:symbol" },
  financial: { method: "GET", template: "/findata-view/company/financial" },

  /* -- social / sentiment -- */
  streamSymbol: { method: "GET", template: "/stream/v3/symbol/:symbol" },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/** Query params; `undefined`/`null` values are dropped. */
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** Values for a route's dynamic segments, keyed by segment name. */
export type Segments = Partial<Record<SegmentName, string>>;

/**
 * The permitted (method, path-template) pairs, for tests and for documenting the boundary. Sorted
 * so the assertion in `test/transport.test.ts` reads as a stable list.
 */
export function permittedRequests(): string[] {
  return Object.values(ROUTES)
    .map((route) => `${route.method} ${route.template}`)
    .sort();
}

/* ------------------------------------ URL building ------------------------------------ */

/**
 * Resolve a route template into a path, validating and percent-encoding each dynamic segment.
 *
 * Encoding is applied after validation, so for a valid Symbol it is a no-op. That is the point:
 * the charset makes the encoding unnecessary and the encoding makes a widened charset survivable.
 */
export function resolvePath(name: RouteName, segments: Segments = {}): string {
  const { template } = ROUTES[name];
  return template
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part;
      const segmentName = part.slice(1) as SegmentName;
      const raw = segments[segmentName];
      if (raw === undefined) {
        throw new StockbitError("invalid_param", `Route ${name} requires a ${segmentName} segment`);
      }
      return encodeURIComponent(SEGMENT_VALIDATORS[segmentName](raw));
    })
    .join("/");
}

/** Build the absolute URL for a route. The origin is ours, never a caller's. */
export function buildUrl(name: RouteName, segments?: Segments, params?: QueryParams): string {
  const url = new URL(resolvePath(name, segments), AUTHENTICATED_ORIGIN);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/* ------------------------------------ policy check ------------------------------------ */

/**
 * Whether a fully-formed (method, url) pair is permitted to carry the bearer.
 *
 * `buildUrl` cannot produce a non-matching URL, so in production this is a redundant check —
 * kept because "the builder is correct" is exactly the assumption a future refactor breaks
 * silently, and because it gives the permitted-set test something to probe with hostile input.
 */
export function isPermitted(method: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== AUTHENTICATED_ORIGIN) return false;
  // `https://user:pass@exodus.stockbit.com/...` has the right origin but carries credentials in the
  // URL. buildUrl cannot produce one; rejecting it keeps this check honest as a second line.
  if (parsed.username || parsed.password) return false;
  // A path is compared post-parse, so `..` has already been resolved away by the URL parser and
  // cannot smuggle a traversal past an exact-match table.
  const actual = parsed.pathname.split("/");

  return Object.values(ROUTES).some((route) => {
    if (route.method !== method) return false;
    const expected = route.template.split("/");
    if (expected.length !== actual.length) return false;
    return expected.every((part, i) => {
      if (!part.startsWith(":")) return part === actual[i];
      const segmentName = part.slice(1) as SegmentName;
      try {
        // Compare against the *encoded* validated form: the wire path is what we are judging.
        return encodeURIComponent(SEGMENT_VALIDATORS[segmentName](decodeURIComponent(actual[i]))) === actual[i];
      } catch {
        return false;
      }
    });
  });
}

/* ------------------------------------ the request ------------------------------------ */

export interface AuthenticatedRequest {
  /** The credential to present. An access token for reads; the refresh token for `loginRefresh`. */
  token: string;
  segments?: Segments;
  params?: QueryParams;
}

/**
 * Issue an authenticated request against a declared route and return the raw `Response`.
 *
 * Status handling is the caller's: `src/http/client.ts` owns retry, backoff, and error mapping for
 * market-data reads, and `src/auth/session.ts` owns the refresh response contract. This function
 * owns exactly one thing — that the request which goes out is one the policy permits.
 */
export async function authenticatedRequest(
  name: RouteName,
  { token, segments, params }: AuthenticatedRequest,
): Promise<Response> {
  const { method } = ROUTES[name];
  const url = buildUrl(name, segments, params);

  if (!isPermitted(method, url)) {
    // Unreachable via buildUrl; a loud failure beats a silently-sent request if that changes.
    throw new StockbitError("invalid_param", `Blocked by request policy: ${method} ${url}`);
  }
  if (!token) {
    throw new StockbitError("auth", `No credential available for ${name}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE.requestTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...defaultHeaders(), authorization: `Bearer ${token}` },
      // Do not follow: a 3xx would replay this Authorization header at an origin the policy above
      // never approved. See ADR-0002.
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    // The Location value is upstream-controlled and deliberately not echoed into the message.
    throw new StockbitError(
      "upstream",
      `Refusing to follow a redirect on an authenticated request (HTTP ${res.status} from ${name})`,
      { status: res.status },
    );
  }
  return res;
}
