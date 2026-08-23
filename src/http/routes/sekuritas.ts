/**
 * Routes on `api-sekuritas.stockbit.com` — the e-IPO partner backend.
 *
 * A third token chain, minted from an exodus webview link rather than from the securities session,
 * and refreshed by a GET that carries the token as a query parameter. That last detail is why
 * `AuthKind` distinguishes the three refresh kinds instead of assuming a bearer.
 */
import type { RouteSpec } from "./_spec.js";

export const SEKURITAS_ROUTES = {
  /** Exchange the exodus webview grant for an e-IPO access + refresh pair. */
  eipoAccessToken: { host: "sekuritas", method: "POST", template: "/partner/eipo/access_token", auth: "none" },
  /**
   * Renew it. The token goes in `?token=`, so no Authorization header is sent at all — a bearer
   * here would be a credential on a route that never asked for one.
   */
  eipoRefreshToken: { host: "sekuritas", method: "GET", template: "/partner/refresh_token", auth: "refreshEipo" },

  /* --------------------------------- e-IPO reads --------------------------------- */

  /**
   * The offerings, and everything the app shows about one of them.
   *
   * An IPO subscription is not a market order: there is a window, an allotment that may be smaller
   * than what was asked for, and money held in the RDN account until it settles. Reading `status`
   * and `orderStatus` is how a caller can tell an offering that is still open from one that has
   * closed and is waiting on allotment, which are different answers to "did I get any".
   */
  eipoCompanyList: { host: "sekuritas", method: "GET", template: "/eipo/social/company/list", auth: "eipo" },
  eipoCompanyDetail: { host: "sekuritas", method: "GET", template: "/eipo/company/detail", auth: "eipo" },
  eipoStatus: { host: "sekuritas", method: "GET", template: "/eipo/status", auth: "eipo" },
  eipoOrderDetail: { host: "sekuritas", method: "GET", template: "/eipo/order/detail", auth: "eipo" },
  eipoPriceGroup: { host: "sekuritas", method: "GET", template: "/eipo/price_group", auth: "eipo" },
  /** The cash that can actually be committed. An IPO order is funded from the RDN, not from carina's cash. */
  eipoRdnBalance: { host: "sekuritas", method: "GET", template: "/eipo/rdn_balance", auth: "eipo" },
  eipoUnboxing: { host: "sekuritas", method: "GET", template: "/eipo/company/unboxing", auth: "eipo" },

  /* --------------------------------- e-IPO orders --------------------------------- */

  /**
   * Stockbit's own dry run, and the commitment.
   *
   * `verify` is unusual and worth using: the server itself says whether the order would be accepted,
   * which is a better check than anything this project could compute. It is called by
   * `eipo_order_preview` and its answer goes into the ticket the user reads.
   *
   * `POST /eipo/order` is a real financial commitment under the same trading switch and the same
   * ticket protocol as an exchange order — see ADR-0004. Its body has NOT been observed; see
   * `docs/PENDING-VERIFICATION.md`.
   */
  eipoOrderVerify: { host: "sekuritas", method: "POST", template: "/eipo/order/verify", auth: "eipo" },
  eipoOrderPlace: { host: "sekuritas", method: "POST", template: "/eipo/order", auth: "eipo" },
} as const satisfies Record<string, RouteSpec>;
