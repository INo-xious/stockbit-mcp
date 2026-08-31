/**
 * The shape of one row in the route table, and the vocabulary the three host files share.
 *
 * Kept out of `transport.ts` so the route files can import the type without importing the module
 * that imports them. Nothing here builds a request or holds a credential.
 */

/** The three Stockbit backends this project is permitted to reach. */
export type Host = "exodus" | "carina" | "sekuritas";

/**
 * Which credential a route consumes, and — implicitly — how it is presented.
 *
 * The three `refresh*` kinds exist because a refresh route does not carry the session token; it
 * carries the token that *mints* one, and the three domains do not agree on where to put it.
 * Stockbit's main refresh takes it as a bearer, carina's takes it in the body, and the e-IPO
 * partner refresh takes it as a query parameter. Naming the kind rather than the placement means a
 * call site says what it needs and `transport.ts` decides how to present it, in one place.
 *
 * `none` is for a route that takes no credential of ours at all.
 */
export type AuthKind =
  | "main"
  | "securities"
  | "eipo"
  | "refreshMain"
  | "refreshSecurities"
  | "refreshEipo"
  /**
   * A one-shot token minted by another route and presented RAW in `Authorization` — no `Bearer`.
   *
   * The odd one out: its credential does not come from a token store, so the call site supplies it
   * and the transport still decides where it goes. Captured from Stockbit's own client on
   * 2026-09-01, which sends `Authorization: <64 hex>` and no `token` query parameter at all.
   */
  | "webviewToken"
  | "none";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteSpec {
  readonly host: Host;
  readonly method: HttpMethod;
  /** Absolute path; `:name` marks one dynamic segment validated by the transport's validator table. */
  readonly template: string;
  readonly auth: AuthKind;
}
