/**
 * Corporate actions, the dividend and market-wide calendars, and the IPO pipeline.
 *
 * The descriptions carry more warnings than most families here for one reason: every endpoint
 * behind these tools answers a bad request with 200 and plausible rows. An unknown action kind
 * returns an empty page, an unrecognised sort order returns the default order, and the market-wide
 * calendar returns TODAY for any date range it was given. None of those look like errors, so the
 * model has to be told.
 */
import { z } from "zod";
import * as core from "../core/corpaction.js";
import { runTool } from "./_format.js";
import { StockbitError } from "../http/errors.js";
import type { Definer } from "./_define.js";

/** Appended where the row shape has not been observed live. Same words everywhere on purpose. */
const UNVERIFIED =
  "PENDING VERIFICATION: this response shape has not been observed live. `rowsFrom` is never null " +
  "here: `absent` or `unrecognized` with an empty `rows` means NOT PARSED, not none.";

export function registerCorpactionTools(define: Definer): void {
  define.read(
    "corporate_actions",
    "Corporate actions of ONE kind: dividends, rights issues, RUPS (shareholder meetings), bonus " +
      "shares, splits, reverse splits, tender offers, warrants, public expose, IPOs, or the " +
      "economic-events calendar.\n" +
      "Pass `symbol` for one issuer's history of that action, or omit it for the market-wide list. " +
      "An empty `rows` with `rowsFrom: \"data\"` is a real answer: this issuer has never had that " +
      "action. `action_type` is a closed list and an unknown one is rejected here rather than sent, " +
      "because the endpoint answers an unknown kind with an empty page that reads like a quiet " +
      "calendar.\n" +
      "For dividends prefer `dividend_calendar`, which also covers stock dividends. ",
    {
      action_type: z.enum(core.CORPACTION_TYPES).describe("Which action kind, e.g. dividend, rightissue, rups"),
      symbol: z.string().optional().describe("IDX ticker, e.g. BBRI. Omit for the whole market"),
      limit: z.coerce.number().optional().describe("Max rows. Omitted entirely when not given"),
    },
    async (a) =>
      runTool(() =>
        core.getCorpactions(
          a.action_type as core.CorpactionType,
          a.symbol as string | undefined,
          a.limit as number | undefined,
        ),
      ),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "dividend_calendar",
    "Cash dividends AND stock dividends in one list, newest ex-date first.\n" +
      "These are two DIFFERENT instruments and both are included: a cash dividend pays money, a " +
      "stock dividend pays additional shares and dilutes the price the same way a bonus issue does. " +
      "Never read the merged list as cash. Every row carries `corpactionType` (`dividend` or " +
      "`stock_dividend`) saying which one it is, and that field is added by this tool, not by " +
      "Stockbit.\n" +
      "The ex-date spelling is unverified, so a list of candidate keys is tried against EACH ROW " +
      "and the one that produced that row's date is named on it as `exDateFrom` — added by this " +
      "tool, not by Stockbit. `exDateFields` lists every key the merge actually read: empty means " +
      "no candidate matched anything and the rows are in Stockbit's own order, NOT chronological; " +
      "more than one means the rows do not all use one spelling, and the list IS sorted regardless. " +
      "`exDateField` names the earliest of them in the order the candidates are TRIED, which is not " +
      "the same as the first entry of `exDateFields` — that list is in the order the rows were read " +
      "— and it is null exactly when `exDateFields` is empty. Rows with no readable ex-date keep `exDate: null` " +
      "and `exDateFrom: null`, are counted in `undated`, and are placed last rather than dropped.\n" +
      "`limit` applies to each kind separately, so the merged list can hold up to twice it. ",
    {
      symbol: z.string().optional().describe("IDX ticker, e.g. BBRI. Omit for the whole market"),
      limit: z.coerce.number().optional().describe("Max rows PER KIND (cash and stock fetched separately)"),
    },
    async (a) =>
      runTool(() => core.getDividendCalendar(a.symbol as string | undefined, a.limit as number | undefined)),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "calendar_today",
    "Every corporate action happening across the whole market on ONE date, or day by day over a " +
      "short range.\n" +
      "This endpoint takes a single `date` and NOTHING ELSE: it accepts `from`/`to` and silently " +
      "ignores them, answering 200 with today's actions. So a range here is assembled client-side, " +
      "one request per day, and is capped at 31 days. Ask for more and you get the first 31 days " +
      "with truncated: true, daysSkipped, and a note — that result is INCOMPLETE and must not be " +
      "summarised as the whole window; request the rest as a further range.\n" +
      "Call it three ways: no arguments (the server's own idea of today — this tool does not " +
      "substitute a UTC date, which is a day behind WIB for the first seven hours of each day), " +
      "`date` alone for one specific day, or `from` and `to` together for a range. `from` without " +
      "`to` is rejected rather than sent, because a half-specified window is exactly the input this " +
      "endpoint answers with the wrong day. Mixing `date` with `from`/`to` is also rejected.\n" +
      "An empty day is normal: weekends, holidays, and plenty of ordinary sessions have no actions. " +
      UNVERIFIED,
    {
      date: z.string().optional().describe("One day, YYYY-MM-DD. Omit for the server's today"),
      from: z.string().optional().describe("Range start, YYYY-MM-DD. Requires `to`"),
      to: z.string().optional().describe("Range end, YYYY-MM-DD, inclusive. Requires `from`"),
    },
    async (a) =>
      runTool(async () => {
        const hasRange = a.from !== undefined || a.to !== undefined;
        if (hasRange && a.date !== undefined) {
          // Silently preferring one would answer a question the caller did not ask, on an endpoint
          // whose whole failure mode is answering a different question convincingly.
          throw new StockbitError(
            "invalid_param",
            "Pass either `date` for one day or `from`+`to` for a range, not both",
          );
        }
        return hasRange
          ? core.getCalendarRange({ from: a.from, to: a.to })
          : core.getCalendarDay(a.date as string | undefined);
      }),
  );

  define.read(
    "corporate_action_status",
    "UMA (unusual market activity) and IDX special-notation status for several symbols in ONE " +
      "request. This is the cheap way to ask 'is anything flagged on these tickers' across a " +
      "watchlist or a screen result.\n" +
      "`answered` lists the requested symbols the response mentions and `unanswered` the ones it " +
      "does not. Read `unanswered` as 'no row here mentions it' — most likely nothing is flagged — " +
      "and NOT as a confirmed clean bill: the matching is done by value (a row belongs to a symbol " +
      "if one of its fields equals that ticker) because the response's field names are unverified, " +
      "so a deeply nested row would also land a symbol in `unanswered`.\n" +
      "Symbols are deduped and normalised before sending. ",
    {
      symbols: z
        .array(z.string())
        .describe("IDX tickers, e.g. [\"BBRI\",\"GOTO\"]. A single comma-joined string also works"),
    },
    async (a) => runTool(() => core.getCorpactionStatus(a.symbols as string[])),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "stock_conversion",
    "Warrant and rights conversion records for one issuer: the exercises that turned derivative " +
      "instruments into ordinary shares, which is share-count dilution that a price chart does not " +
      "show.\n" +
      "Empty is the normal answer for an issuer that has never issued warrants or rights. " +
      "Pagination is unverified — whether `page` counts from 0 or 1 is not known, so both are " +
      "accepted and neither is sent unless you pass it. " +
      UNVERIFIED,
    {
      symbol: z.string().describe("IDX ticker, e.g. BUKA"),
      page: z.coerce.number().optional().describe("Page number. Base (0 or 1) is unverified"),
      limit: z.coerce.number().optional().describe("Max rows per page"),
    },
    async (a) =>
      runTool(() =>
        core.getStockConversion(
          a.symbol as string,
          a.page as number | undefined,
          a.limit as number | undefined,
        ),
      ),
  );

  define.read(
    "ipo_pipeline",
    "Upcoming and recent IPOs, with whatever offering terms the row carries.\n" +
      "This is `corporate_actions` with `action_type: \"ipo\"`, given its own name because it is the " +
      "one action kind that is about companies not yet listed, so no symbol filter applies. An " +
      "empty list means Stockbit is showing no IPOs right now, which is an ordinary state between " +
      "offerings, not an error. Pair it with `underwriters` for the track record of the houses " +
      "running a deal. ",
    {
      limit: z.coerce.number().optional().describe("Max rows. Omitted entirely when not given"),
    },
    async (a) => runTool(() => core.getCorpactions("ipo", undefined, a.limit as number | undefined)),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "underwriters",
    "The IPO underwriter directory, or ONE underwriter's IPO track record.\n" +
      "With no arguments it lists the underwriting houses and their codes. With `underwriter_code` " +
      "it returns that house's past IPOs and how they performed. The code is 2-6 uppercase letters " +
      "or digits and is validated before the request is built; look it up in the directory first " +
      "rather than guessing it from a house's name.\n" +
      "`sort_by` accepts only the one ordering that has been observed, ARA streak — how many " +
      "consecutive sessions a listing spent locked at the auto-rejection ceiling, the usual IDX " +
      "measure of a hot debut. Any other value is refused here rather than sent, because this " +
      "endpoint ignores an unrecognised sort order and returns the default one, which looks " +
      "identical to having sorted. " +
      UNVERIFIED,
    {
      underwriter_code: z
        .string()
        .optional()
        .describe("Underwriter code from the directory. Omit to list all underwriters"),
      sort_by: z
        .enum(core.UNDERWRITER_SORT_BY)
        .optional()
        .describe("Only valid with `underwriter_code`. The sole observed ordering: ARA streak"),
    },
    async (a) =>
      runTool(async () => {
        const code = a.underwriter_code as string | undefined;
        if (code === undefined) {
          if (a.sort_by !== undefined) {
            // Sorting the directory is not a thing this endpoint does; accepting the argument here
            // would imply it happened.
            throw new StockbitError(
              "invalid_param",
              "`sort_by` applies to an underwriter's IPO performance; pass `underwriter_code` too",
            );
          }
          return core.getUnderwriters();
        }
        return core.getUnderwriterPerformance(code, a.sort_by as string | undefined);
      }),
  );
}
