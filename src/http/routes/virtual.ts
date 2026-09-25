/**
 * Stockbit's WEBSITE virtual account, not the local paper ledger. ADR-0013.
 *
 * Paths and request bodies traced through Stockbit's public web bundle on 2026-09-24
 * (build eCXUv0YjiEIhDng_Km-2W). All use the main exodus session. Buy and sell are
 * separate literal routes: no account-mode flag, caller-controlled action segment,
 * securities credential, or fallback can redirect these requests to a live account.
 */
import type { RouteSpec } from "./_spec.js";

export const VIRTUAL_ROUTES = {
  virtualPortfolio: { host: "exodus", method: "GET", template: "/virtualtrading/portfolio", auth: "main" },
  virtualPosition: { host: "exodus", method: "GET", template: "/virtualtrading/portfolio/:symbol", auth: "main" },
  virtualOrders: { host: "exodus", method: "GET", template: "/virtualtrading/order", auth: "main" },
  virtualFormula: { host: "exodus", method: "GET", template: "/virtualtrading/config/formula", auth: "main" },
  virtualActivate: { host: "exodus", method: "POST", template: "/virtualtrading/account/activate", auth: "main" },
  virtualBuy: { host: "exodus", method: "POST", template: "/virtualtrading/buy/:symbol", auth: "main" },
  virtualSell: { host: "exodus", method: "POST", template: "/virtualtrading/sell/:symbol", auth: "main" },
  virtualAmend: { host: "exodus", method: "POST", template: "/virtualtrading/amend", auth: "main" },
  virtualCancel: { host: "exodus", method: "POST", template: "/virtualtrading/cancel", auth: "main" },
} as const satisfies Record<string, RouteSpec>;
