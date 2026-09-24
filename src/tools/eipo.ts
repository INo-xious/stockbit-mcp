/** Read-only e-IPO research and existing subscription data. No subscription execution. */
import { z } from "zod";
import * as eipo from "../eipo/api.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

const SESSION_NOTE =
  "Requires a separate e-IPO session. Stockbit's legacy automatic handoff currently returns HTTP 404 " +
  "for some sessions (observed 2026-09-24); report that as an unavailable integration, not an expired " +
  "market-data login. Use ipo_pipeline for public listings and Stockbit's e-IPO page for account data " +
  "when the handoff is unavailable. This server cannot submit subscriptions.";

const PROJECTION_NOTE =
  "PENDING VERIFICATION: nothing on this host has been observed live. Offering data comes back as " +
  "the server sent it; only what describes THIS account's money is projected.";

export function registerEipoTools(define: Definer): void {
  define.read(
    "eipo_list",
    "Every IPO Stockbit is offering: upcoming, open for subscription, and recently closed.\n" +
      "Start here when the user asks about IPOs. The `emiten_code` in each row is what every other " +
      "e-IPO tool takes.\n" +
      SESSION_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {},
    async () => runTool(() => eipo.listOfferings()),
  );

  define.read(
    "eipo_detail",
    "One offering in full: the price range, the timetable, the underwriters, the use of proceeds.\n" +
      "This is prospectus material, returned as Stockbit sent it. Read `eipo_status` alongside it — " +
      "the detail says what the offering IS, not whether it is still open.\n" +
      SESSION_NOTE,
    { emiten_code: z.string().describe("The offering's code, from eipo_list, e.g. BREN") },
    async (a) => runTool(() => eipo.getOffering(String(a.emiten_code))),
  );

  define.read(
    "eipo_status",
    "Where one offering is in its timetable: open for subscription, closed and awaiting allotment, " +
      "or allotted.\n" +
      "These are three different answers to two different questions — 'can I subscribe' and 'did I " +
      "get any' — and the detail payload alone does not distinguish them. Read this before telling a " +
      "user they can still subscribe.\n" +
      SESSION_NOTE,
    { emiten_code: z.string().describe("The offering's code, from eipo_list") },
    async (a) => runTool(() => eipo.getOfferingStatus(String(a.emiten_code))),
  );

  define.read(
    "eipo_my_order",
    "This account's own subscription to an offering, and what was actually allotted.\n" +
      "`order: null` means no subscription — a normal answer.\n" +
      "The `allotted*` fields matter more than the subscription: an oversubscribed IPO routinely " +
      "grants a fraction of what was asked for, so reporting the subscription as the holding " +
      "overstates it. When they are absent, allotment has not happened yet — say that rather than " +
      "reporting zero.\n" +
      SESSION_NOTE +
      "\n" +
      PROJECTION_NOTE,
    { emiten_code: z.string().describe("The offering's code") },
    async (a) => runTool(() => eipo.getMyOrder(String(a.emiten_code))),
  );

  define.read(
    "eipo_price_groups",
    "The price bands a subscription may be placed at.\n" + SESSION_NOTE,
    {},
    async () => runTool(() => eipo.getPriceGroups()),
  );

  define.read(
    "eipo_rdn_balance",
    "The RDN cash an IPO subscription is funded from.\n" +
      "NOT the same money as `cash_balance`: an account can have trading buying power on the " +
      "brokerage side while having nothing available here, because an IPO order holds funds in the " +
      "investor's RDN account until allotment. Quoting one for the other tells the user they can " +
      "subscribe when they cannot.\n" +
      SESSION_NOTE +
      "\n" +
      PROJECTION_NOTE,
    {},
    async () => runTool(() => eipo.getRdnBalance()),
  );

  define.read(
    "eipo_unboxing",
    "Stockbit's own write-up of an offering. Editorial, not a filing — useful for what the market is " +
      "being told about a company with no trading history, and to be attributed to Stockbit rather " +
      "than presented as fact.\n" +
      SESSION_NOTE,
    { emiten_code: z.string().describe("The offering's code") },
    async (a) => runTool(() => eipo.getUnboxing(String(a.emiten_code))),
  );

}
