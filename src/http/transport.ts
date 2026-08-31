/**
 * The authenticated-request boundary. **This is the only module in the codebase that may attach a
 * Stockbit credential to an outbound request**, and `test/transport.test.ts` fails the suite if
 * another one starts doing so.
 *
 * The invariant is ADR-0002's: no mutation of Stockbit account data that no ADR has approved,
 * enforced as an exact host + method + path policy rather than by method alone. "GET only" was never
 * the real property — the process legitimately POSTs `/login/refresh`. So instead of a rule about
 * verbs, there is a closed table of permitted request shapes, and a request that does not match one
 * is not sent.
 *
 * Three properties make that policy a control rather than a convention:
 *
 *   1. **Closed route table.** Callers name a route; they do not pass a path. There is no
 *      caller-supplied host — the `base` override this module replaced let any call site point a
 *      bearer-carrying request at any origin.
 *   2. **The host is part of the route, and part of the check.** Three backends now carry three
 *      different credentials. `isPermitted` resolves the host from the URL's origin and matches
 *      only that host's rows, so an exodus path cannot be reached on carina with a carina token —
 *      which matters because carina answers a foreign path with a well-formed 404 envelope that
 *      reads like "this symbol has no data".
 *   3. **No redirect following.** A 3xx that relocates a bearer-carrying request is a rejection,
 *      not a hop. Undici would otherwise replay the Authorization header at the new location, and
 *      for a WRITE it would apply the mutation somewhere nobody approved.
 *
 * Outbound *notification* delivery is a separate path that never carries this credential and pins
 * its own origins independently. It does not belong here.
 */
import { HOSTS, RATE, defaultHeaders } from "../config.js";
import { StockbitError } from "./errors.js";
import { normalizeSymbol } from "../symbol.js";
import { EXODUS_ROUTES } from "./routes/exodus.js";
import { CARINA_ROUTES } from "./routes/carina.js";
import { SEKURITAS_ROUTES } from "./routes/sekuritas.js";
import type { AuthKind, Host, HttpMethod, RouteSpec } from "./routes/_spec.js";

export type { AuthKind, Host, HttpMethod, RouteSpec } from "./routes/_spec.js";

/* ------------------------------------ host policy ------------------------------------ */

/**
 * The origins permitted to receive a Stockbit credential, one per host.
 *
 * Compared by parsed `URL.origin`, so scheme and port are part of the check and
 * `exodus.stockbit.com.evil.test` cannot match.
 */
export const ORIGINS: Record<Host, string> = {
  exodus: new URL(HOSTS.exodus).origin,
  carina: new URL(HOSTS.carina).origin,
  sekuritas: new URL(HOSTS.sekuritas).origin,
};

/**
 * The exodus origin, under its historical name.
 *
 * Kept because a dozen call sites and tests say `AUTHENTICATED_ORIGIN` and mean "market data". It
 * is no longer *the* authenticated origin — there are three — so new code should name the host.
 */
export const AUTHENTICATED_ORIGIN = ORIGINS.exodus;

/** Reverse lookup: which host an origin belongs to, or undefined for one we never approved. */
function hostForOrigin(origin: string): Host | undefined {
  return (Object.keys(ORIGINS) as Host[]).find((host) => ORIGINS[host] === origin);
}

/* ------------------------------------ route table ------------------------------------ */

/**
 * Hotlist kinds, mapping the name callers use to the spelling that goes on the wire.
 *
 * The two differ, and that is the whole point of this table. Stockbit's own web client requests
 * `/emitten/hotlist/topgainer` — lowercase, one word. This project sent the camelCase spelling it
 * had invented for its own tool schema, and the endpoint answered 200 with an empty list rather
 * than 404, which is indistinguishable from a closed market. The tool description even said so:
 * "returns an empty list when the market is closed — that is expected, not an error." An always-
 * empty hotlist had a cover story, so nobody looked.
 *
 * Keeping both spellings in one table means the friendly name stays in the tool schema (where it
 * reads well) and the wire name stays here (where it must be exact), with no third place for them
 * to disagree.
 */
export const MOVER_WIRE = {
  topGainer: "topgainer",
  topLoser: "toploser",
  mostActive: "mostactive",
} as const;

export type MoverTypeName = keyof typeof MOVER_WIRE;

/**
 * The corporate-action kinds that appear as a path segment.
 *
 * A closed table for the same reason `MOVER_WIRE` is one: these go into the URL, and Stockbit
 * answers an unknown action with an empty list rather than a 404. A typo would look like a quiet
 * calendar.
 */
export const CORPACTION_TYPES = [
  "bonus",
  "dividend",
  "economic",
  "ipo",
  "pubex",
  "reversesplit",
  "rightissue",
  "rups",
  "stock_dividend",
  "stocksplit",
  "tenderoffer",
  "warrant",
] as const;

export type CorpactionType = (typeof CORPACTION_TYPES)[number];

/** A Stockbit numeric id, as a path segment. Digits only — never a caller-supplied path fragment. */
function numericId(name: string) {
  return (value: string): string => {
    if (!/^[0-9]{1,20}$/.test(value)) {
      throw new StockbitError("invalid_param", `Invalid ${name} ${JSON.stringify(value)}: expected a numeric id`);
    }
    return value;
  };
}

/**
 * A segment matched against a fixed pattern.
 *
 * Every validator is **idempotent on its own output**, because `isPermitted` re-validates the path
 * it is judging: one that rejected the very form `resolvePath` produced would refuse every request
 * the builder made.
 */
function pattern(name: string, re: RegExp, expected: string) {
  return (value: string): string => {
    if (!re.test(value)) {
      throw new StockbitError("invalid_param", `Invalid ${name} ${JSON.stringify(value)}: expected ${expected}`);
    }
    return value;
  };
}

/** A segment drawn from a closed list. Case-sensitive: these are wire spellings, not friendly names. */
function oneOf(name: string, values: readonly string[]) {
  return (value: string): string => {
    if (!values.includes(value)) {
      throw new StockbitError(
        "invalid_param",
        `Invalid ${name} ${JSON.stringify(value)}: expected one of ${values.join(", ")}`,
      );
    }
    return value;
  };
}

/**
 * Dynamic path segments, by name. A segment's *name in the template* selects its validator, so
 * adding `:symbol` to a route cannot accidentally get a laxer rule than every other `:symbol`.
 */
const SEGMENT_VALIDATORS = {
  symbol: normalizeSymbol,
  watchlistId: numericId("watchlist id"),
  templateId: numericId("screener template id"),
  companyId: numericId("company id"),
  postId: numericId("stream post id"),
  sectorId: numericId("sector id"),
  insiderId: numericId("insider id"),
  /**
   * A Chartbit layout id. NOT numeric, though this validator said it was until 2026-09-01.
   *
   * `GET /chartbit/charts` was called live on that date and every id it returned looked like
   * `53e5877c-64f5-471b-82a9-e572db648ad1-3355424` — a UUID, a hyphen, and what is presumably the
   * account number. `numericId` refused all of them, and refused them HERE, before the request was
   * built: every route taking this segment (read one layout, save one, delete one, and the chart-id
   * derivation that `chartbit_drawings` needs) was unreachable with any id the account actually
   * has. `chartbit_layouts` listing them fine is what hid it — the ids were right there and nothing
   * could spend one.
   *
   * Deliberately loose, on the same reasoning `orderId` above spells out: the charset excludes
   * every path metacharacter, so a rule looser than reality is survivable, while a rule TIGHTER
   * than reality refuses the user's own data. That is the mistake being corrected, so it is not
   * the one to make again by pinning this to the exact shape of two observed ids.
   */
  layoutId: pattern("chart layout id", /^[A-Za-z0-9_-]{1,80}$/, "a chart layout id (letters, digits, _ or -)"),
  /**
   * A broker code: two to four uppercase alphanumerics (YP, CC, BK, …).
   *
   * Narrow on purpose — this goes into a bearer-carrying path, and the codes are a fixed IDX
   * vocabulary rather than free text.
   */
  brokerCode: pattern("broker code", /^[A-Z0-9]{2,4}$/, "2–4 uppercase letters or digits, e.g. YP"),
  underwriterCode: pattern("underwriter code", /^[A-Z0-9]{2,6}$/, "2–6 uppercase letters or digits"),
  indexCode: pattern("index code", /^[A-Z0-9]{2,20}$/, "an uppercase index code, e.g. IDX30"),
  /**
   * A Stockbit order id. Deliberately loose (any URL-safe token up to 64 chars) until one has been
   * observed — and then tightened. A looser rule than reality is survivable here because the
   * charset excludes every path metacharacter; a *tighter* rule than reality would refuse the
   * user's real order.
   */
  orderId: pattern("order id", /^[A-Za-z0-9_-]{1,64}$/, "an order id (letters, digits, _ or -)"),
  username: pattern("username", /^[A-Za-z0-9_.]{1,40}$/, "a Stockbit username"),
  /**
   * A named chart template. Stockbit's own client enforces this charset client-side and the server
   * rejects anything else, so matching it here turns a 400 into a message that names the rule.
   */
  templateName: pattern("template name", /^[A-Za-z0-9 ]{1,40}$/, "letters, digits and spaces only"),
  /** The financial-statement subject kind (`company`, `bank`, …) in the v2 emitten paths. */
  emittenType: pattern("emitten type", /^[a-z_]{2,20}$/, "a lowercase emitten type, e.g. company"),
  /** Which portfolio performance series to return. */
  performanceKind: pattern("performance kind", /^[a-z-]{2,40}$/, "a lowercase performance kind"),
  actionType: oneOf("corporate action type", CORPACTION_TYPES),
  /**
   * Accepts either hotlist spelling and always returns the wire one.
   */
  moverType: (value: string): string => {
    if (value in MOVER_WIRE) return MOVER_WIRE[value as MoverTypeName];
    if ((Object.values(MOVER_WIRE) as readonly string[]).includes(value)) return value;
    throw new StockbitError(
      "invalid_param",
      `Invalid mover type ${JSON.stringify(value)}: expected ${Object.keys(MOVER_WIRE).join(", ")}`,
    );
  },
} as const;

type SegmentName = keyof typeof SEGMENT_VALIDATORS;

/** Every segment name the transport knows how to validate. Asserted against the table in tests. */
export const SEGMENT_NAMES = Object.keys(SEGMENT_VALIDATORS) as SegmentName[];

/**
 * Merge the three host tables into one, refusing a duplicate route name.
 *
 * A silently-shadowed name would be the worst kind of bug this table can have: the call site would
 * still compile, still send a request, and send it to the wrong host with the wrong credential.
 *
 * Exported for `test/transport.test.ts` only. It builds `ROUTES`, so it is load-bearing rather than
 * a helper, and the throw is the whole point of it — that deserves a test that does not need a
 * deliberately broken route file to exist.
 */
export function mergeRoutes<
  A extends Record<string, RouteSpec>,
  B extends Record<string, RouteSpec>,
  C extends Record<string, RouteSpec>,
>(a: A, b: B, c: C): A & B & C {
  const merged: Record<string, RouteSpec> = {};
  for (const table of [a, b, c] as Array<Record<string, RouteSpec>>) {
    for (const [name, spec] of Object.entries(table)) {
      if (name in merged) {
        throw new Error(
          `Duplicate route name ${JSON.stringify(name)}: ${merged[name].host} and ${spec.host} both declare it. ` +
            "One would silently shadow the other and send the wrong credential to the wrong host.",
        );
      }
      merged[name] = spec;
    }
  }
  // The intersection is the honest type: the keys are exactly the three tables' keys, which is what
  // `RouteName` is built from. The cast is the one place that has to be asserted, and the loop above
  // is what earns it.
  return merged as A & B & C;
}

/**
 * Every authenticated request this project is permitted to make, across all three hosts.
 *
 * Adding a row is a deliberate act reviewable in a diff. Anything absent — every undeclared write,
 * every other host — is rejected here rather than by convention.
 *
 * Built BY the guard rather than beside it. This used to be an object spread with a discarded
 * `mergeRoutes(...)` call underneath it, which meant the table existed twice: the one everything
 * read was assembled by `...`, which resolves a duplicate name by silently keeping the last one —
 * the exact failure the guard was written to catch — while the guard threw over a second copy
 * nothing used. Two constructions can drift; one cannot.
 */
export const ROUTES = mergeRoutes(
  EXODUS_ROUTES,
  CARINA_ROUTES,
  SEKURITAS_ROUTES,
) satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/* ------------------------------- credential placement ------------------------------- */

/** Which token domain a route's credential comes from, or null when it takes none of ours. */
export type TokenDomain = "main" | "securities" | "eipo";

const AUTH_DOMAIN: Record<AuthKind, TokenDomain | null> = {
  main: "main",
  refreshMain: "main",
  securities: "securities",
  refreshSecurities: "securities",
  eipo: "eipo",
  refreshEipo: "eipo",
  none: null,
};

/**
 * Where the credential goes on the wire, per auth kind.
 *
 * Three placements exist because the three refresh chains disagree, and pretending otherwise would
 * mean a call site quietly sending a bearer to a route that reads a query parameter — which fails
 * as a 401 with no hint about why.
 */
type Placement = "header" | "bodyRefreshToken" | "queryToken" | "none";

const PLACEMENT: Record<AuthKind, Placement> = {
  main: "header",
  securities: "header",
  eipo: "header",
  refreshMain: "header",
  refreshSecurities: "bodyRefreshToken",
  refreshEipo: "queryToken",
  none: "none",
};

/** The token domain a route draws on — what `src/http/client.ts` asks `ensureFresh` for. */
export function domainOf(name: RouteName): TokenDomain | null {
  return AUTH_DOMAIN[ROUTES[name].auth];
}

/** Whether a route is one of the three refresh routes. Refresh routes never retry on a 401. */
export function isRefreshRoute(name: RouteName): boolean {
  return ROUTES[name].auth.startsWith("refresh");
}

/* --------------------------------- params & segments --------------------------------- */

/**
 * Query params; `undefined`/`null` values are dropped.
 *
 * An array value becomes **repeated** parameters (`?x=a&x=b`), not a comma-joined one. Stockbit's
 * broker-activity endpoint is the reason: it takes several `market_type` and `investor_type` values
 * and reads only the first when they arrive comma-joined, so the joined form returns a confident,
 * narrower answer rather than an error.
 */
export type QueryParamValue = string | number | boolean | undefined | null | readonly string[];
export type QueryParams = Record<string, QueryParamValue>;

/** Values for a route's dynamic segments, keyed by segment name. */
export type Segments = Partial<Record<SegmentName, string>>;

/**
 * The permitted (host, method, path-template) triples, for tests and for documenting the boundary.
 *
 * Sorted so the assertions in `test/transport.test.ts` read as stable lists. Pass a host to get
 * that host's rows alone — which is how the snapshot stays reviewable now that there are three.
 */
export function permittedRequests(host?: Host): string[] {
  return Object.values(ROUTES)
    .filter((route) => host === undefined || route.host === host)
    .map((route) => (host === undefined ? `${route.host} ${route.method} ${route.template}` : `${route.method} ${route.template}`))
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

/** Build the absolute URL for a route. The origin comes from the route's host, never a caller's. */
export function buildUrl(name: RouteName, segments?: Segments, params?: QueryParams): string {
  const url = new URL(resolvePath(name, segments), ORIGINS[ROUTES[name].host]);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      // `append`, not `set`, for an array: repeated keys are the wire form these endpoints want.
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/* ------------------------------------ policy check ------------------------------------ */

/**
 * Whether a fully-formed (method, url) pair is permitted to carry a credential.
 *
 * `buildUrl` cannot produce a non-matching URL, so in production this is a redundant check —
 * kept because "the builder is correct" is exactly the assumption a future refactor breaks
 * silently, and because it gives the permitted-set test something to probe with hostile input.
 *
 * Matching is scoped to the URL's own host. A path that exists on exodus is not thereby permitted
 * on carina, and the reverse matters more: `/order/v2/list` must never become reachable on the
 * market-data host with the market-data token.
 */
export function isPermitted(method: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = hostForOrigin(parsed.origin);
  if (!host) return false;
  // `https://user:pass@exodus.stockbit.com/...` has the right origin but carries credentials in the
  // URL. buildUrl cannot produce one; rejecting it keeps this check honest as a second line.
  if (parsed.username || parsed.password) return false;
  // A path is compared post-parse, so `..` has already been resolved away by the URL parser and
  // cannot smuggle a traversal past an exact-match table.
  const actual = parsed.pathname.split("/");

  return Object.values(ROUTES).some((route) => {
    if (route.host !== host) return false;
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
  /**
   * The credential to present. An access token for ordinary routes; the refresh token for the three
   * refresh routes. Not required for `auth: "none"`.
   */
  token?: string;
  segments?: Segments;
  params?: QueryParams;
  /**
   * JSON body, for declared non-GET routes only.
   *
   * Rejected on a GET rather than silently dropped: a caller passing a body to a read has
   * misunderstood something, and quietly discarding it would hide that until the data was wrong.
   */
  body?: unknown;
}

/**
 * Issue an authenticated request against a declared route and return the raw `Response`.
 *
 * Status handling is the caller's: `src/http/client.ts` owns retry, backoff, and error mapping, and
 * `src/auth/session.ts` owns the refresh response contract. This function owns exactly one thing —
 * that the request which goes out is one the policy permits, carrying the credential the route
 * declared, in the place that route puts it.
 */
export async function authenticatedRequest(
  name: RouteName,
  { token, segments, params, body }: AuthenticatedRequest,
): Promise<Response> {
  const route = ROUTES[name] as RouteSpec;
  const method: HttpMethod = route.method;
  const placement = PLACEMENT[route.auth];

  // The e-IPO refresh carries its credential as a query parameter, so it has to join `params`
  // before the URL is built — and it is added here rather than by the caller, so that a token in a
  // URL is this module's decision rather than something any call site can do incidentally.
  //
  // It is not a property this code enforces, and the comment used to say it was. `getShareholders`
  // in src/core/company.ts puts a minted one-shot token into `params` itself, because `params` is
  // an open record and there is no header channel to put it anywhere else: neither
  // `AuthenticatedRequest` below nor `GetOptions` in client.ts carries headers, and outbound
  // headers are one literal further down. That call is the only one in `src/` that does this
  // (`grep -rn "params: {.*token" src/`), and where its token actually belongs is unsettled —
  // see the note on `readShareholdersChart`. Opening a general per-call headers option to give it
  // somewhere better to go would let any call site attach arbitrary headers to a bearer-carrying
  // request, which is a wider change than the one bug needs.
  const effectiveParams: QueryParams =
    placement === "queryToken" ? { ...(params ?? {}), token: token ?? "" } : (params ?? {});
  const url = buildUrl(name, segments, effectiveParams);

  if (!isPermitted(method, url)) {
    // Unreachable via buildUrl; a loud failure beats a silently-sent request if that changes.
    throw new StockbitError("invalid_param", `Blocked by request policy: ${method} ${url}`);
  }
  if (placement !== "none" && !token) {
    throw new StockbitError("auth", `No credential available for ${name}`);
  }
  if (body !== undefined && method === "GET") {
    throw new StockbitError("invalid_param", `Route ${name} is a GET and cannot carry a body`);
  }

  // Carina's refresh takes the token in the body. Merged here so the credential never has to be
  // assembled into a body by a call site.
  const effectiveBody =
    placement === "bodyRefreshToken"
      ? { ...((body as Record<string, unknown>) ?? {}), refresh_token: token }
      : body;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE.requestTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...defaultHeaders(),
        ...(placement === "header" ? { authorization: `Bearer ${token}` } : {}),
        ...(effectiveBody !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(effectiveBody !== undefined ? { body: JSON.stringify(effectiveBody) } : {}),
      // Do not follow: a 3xx would replay this Authorization header at an origin the policy above
      // never approved. See ADR-0002. For a WRITE this is doubly important — a redirected POST
      // would apply the mutation somewhere we never approved.
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
