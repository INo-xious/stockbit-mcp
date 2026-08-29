/**
 * e-IPO tools: the offerings, this account's subscriptions, and the two-step commitment.
 *
 * The reads are ordinary. The write is not: `eipo_order` commits money out of the RDN account for an
 * allotment that may be a fraction of what was asked for and cannot be undone by selling. It is
 * under the same trading switch and the same preview→confirm→redeem protocol as an exchange order.
 */
import { z } from "zod";
import * as eipo from "../eipo/api.js";
import { placeEipoOrder, previewEipoOrder } from "../eipo/order.js";
import { COMMITMENT_CONFIRM, runTool } from "./_format.js";
import { elicitationNote } from "../trading/confirmation.js";
import type { Definer } from "./_define.js";

const SESSION_NOTE =
  "The e-IPO session is minted automatically from the user's ordinary Stockbit login — no PIN and no " +
  "extra step. If it cannot be minted the error says to run `stockbit-auth login`.";

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

  define.read(
    "eipo_order_preview",
    "Price and check an IPO subscription WITHOUT committing to it. Step one of two.\n" +
      "It runs Stockbit's OWN verification of the subscription — the server decides whether it would " +
      "be accepted, which is a better check than anything computed here — and puts the answer in " +
      "`checks` as `server_verified`.\n" +
      "RELAY `summary` VERBATIM. It states the lots, the price, the money committed, the RDN cash " +
      "available, and the two facts that make an IPO different from a trade: the allotment may be " +
      "smaller than the subscription, and it cannot be cancelled by selling.\n" +
      "Then ASK the user, in plain words, and wait. A check marked `unverified` passed by default " +
      "because its input could not be read — that means 'not contradicted', never 'confirmed'.",
    {
      emiten_code: z.string().describe("The offering's code, from eipo_list"),
      lots: z.coerce.number().describe("Lots to subscribe for — 1 lot is 100 shares"),
      price: z.coerce.number().describe("Price per share, from the offering's price range"),
    },
    async (a) =>
      runTool(() =>
        previewEipoOrder({
          emitenCode: String(a.emiten_code),
          lots: Number(a.lots),
          price: Number(a.price),
        }),
      ),
  );

  define.write(
    "eipo_order",
    "COMMIT A REAL IPO SUBSCRIPTION with the user's own money. There is no undo — an IPO allotment " +
      "cannot be cancelled by selling, because the stock does not trade yet.\n" +
      "Step two of two. Call `eipo_order_preview` first, relay its `summary` to the user in words, " +
      "ask them, and pass `confirm: true` only after they have agreed to that specific " +
      "subscription. This tool takes a ticket id and nothing else.\n" +
      "Where the client supports MCP elicitation the user is ALSO asked directly, before `confirm` " +
      "is looked at, and their answer is the decisive one: a declined dialog refuses the " +
      "subscription however confirm was set.\n" +
      "READ `outcome` BEFORE REPORTING ANYTHING. Only `ok` means the subscription is recorded and " +
      "was seen there. Anything else means the state is uncertain — relay `message` verbatim and DO " +
      "NOT RESEND.",
    {
      ticket_id: z.string().describe("The id from eipo_order_preview. This tool takes no price and no quantity."),
      confirm: z
        .boolean()
        .optional()
        .describe(COMMITMENT_CONFIRM),
    },
    async (a) =>
      runTool(async () => {
        const result = await placeEipoOrder({
          ticketId: String(a.ticket_id),
          confirm: a.confirm === true,
          // The gate calls this BEFORE it looks at `confirm`, so a client that can reach a person
          // always reaches them. See src/trading/confirmation.ts.
          elicit: define.elicitDecision ? define.elicitDecision.bind(define) : undefined,
        });
        // Mirrors describeOutcome() in tools/trading.ts: the outcome sentence is unchanged and the
        // fact about who agreed rides beside it.
        const note = elicitationNote(result.elicitation);
        const suffix = note ? ` ${note}` : "";
        const message =
          result.outcome === "ok"
            ? `The subscription to ${result.emitenCode} is recorded: ${result.lots} lots committing ${result.amountIdr} rupiah.${suffix}`
            : result.outcome === "write-failed"
              ? `The subscription to ${result.emitenCode} was refused before it was recorded. ${result.error ?? ""}`.trim()
              : result.outcome === "rejected"
                ? `The subscription to ${result.emitenCode} was rejected. ${result.error ?? ""}`.trim()
                : (result.outcomeUnknown ??
                    `The outcome of the subscription to ${result.emitenCode} could not be established. Do not resend it.`) +
                  suffix;
        return {
          ...result,
          message,
          ...(result.logged
            ? { auditLog: result.logPath }
            : {
                auditGap:
                  `This attempt could NOT be written to ${result.logPath}. The subscription itself is ` +
                  "unaffected, but there is no audit line for it — tell the user.",
              }),
        };
      }),
    { destructiveHint: true, idempotentHint: false },
  );
}
