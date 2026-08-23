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
} as const satisfies Record<string, RouteSpec>;
