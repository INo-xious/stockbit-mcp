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
      "An empty `rows` with `rowsFrom: \"data\"` is a real answer, but it means NONE IN THE PERIOD " +
      "THIS FEED COVERS — nothing in the response says where that period starts, so an empty page " +
      "is 'none on record here' and is NOT evidence the issuer never did it. " +
      "`action_type` is a closed list and an unknown one is rejected here rather than sent, " +
      "because the endpoint answers an unknown kind with an empty page that reads like a quiet " +
      "calendar.\n" +
      "`warrant` is a corporate action on the ISSUER's own share count. A structured call warrant — " +
      "the separately listed instrument a securities house issues against a stock under its own " +
      "ticker — is not one, and nothing here ties such a ticker back to its underlying. An empty " +
      "`warrant` list therefore answers for the issuer alone: it is not evidence that no warrant " +
      "trades on the symbol.\n" +
      "`suspectDates` appears only when a row's own dates are in an order that cannot have " +
      "happened — a RUPS record date after the meeting it gates, a cum date after its ex-date, a " +
      "payment before the record date. That is UPSTREAM data being wrong, not a failure here: the " +
      "row is still returned exactly as Stockbit sent it, and each entry names both wire keys and " +
      "both values so you can judge the pair yourself — the values NORMALIZED to YYYY-MM-DD, not " +
      "the wire strings, so read the row itself to see what was actually sent. The key spellings " +
      "are candidates, so a suspicion can be a misread field rather than a bad date. Absent means " +
      "nothing was out of " +
      "order — it does NOT mean the dates were checked and cleared, because most rows carry " +
      "neither side of any pair.\n" +
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
      "`limit` applies to each kind separately, so the merged list can hold up to twice it.\n" +
      "`suspectDates` carries the same meaning it has on `corporate_actions` — rows whose own dates " +
      "are impossible in that order, indexing `rows` after the sort, absent when none are. Absent " +
      "is not a clean bill: most rows carry neither side of any pair. ",
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
      "The response is BUCKETED, one key per action kind, and all of them are returned. Every row " +
      "carries `corpactionType` naming the bucket it came from — added by this tool, not by " +
      "Stockbit, and spelled exactly as the response spelled it. Two of those spellings are NOT the " +
      "`action_type` vocabulary: the calendar says `stock_reverse` and `tender` where " +
      "`corporate_actions` takes `reversesplit` and `tenderoffer`, and neither is translated here " +
      "because nothing has verified they name the same thing.\n" +
      "`buckets` lists every kind the response carried with its row count, zeros included. That is " +
      "the difference between a kind that came back EMPTY today and one that was not in the " +
      "response at all: the first is in `buckets` with 0, the second is missing from it. `rowsFrom` " +
      "names the buckets that actually contributed rows (`data.{dividend,rups}`), so " +
      "`data.{}` with a populated `buckets` is a genuinely empty day rather than an unread payload.\n" +
      "`economic` is one of the buckets and its rows ARE in the list. An economic event is a data " +
      "release, not a corporate action and not tied to an issuer — filter `corpactionType` on it, " +
      "or subtract `buckets.economic`, when you need corporate actions alone.\n" +
      "`date` is the day requested, or the `today` the response itself carried when none was sent, " +
      "and `dateFrom` says which. Null `date` with no `dateFrom` means no usable day was available " +
      "— either none was sent and the response carried none, or it carried one this server would " +
      "not parse, in which case the raw value is still in `meta.today`. Check there before " +
      "concluding the server said nothing about the date.\n" +
      "BEFORE REPORTING AN EMPTY DAY, CHECK WHICH KIND OF EMPTY IT IS. `rowsFrom: \"absent\"` or " +
      "`\"unrecognized\"` with `rows: []` and NO `buckets` key means the payload was NOT PARSED — " +
      "not that nothing is happening. Only `rows: []` alongside a populated `buckets` (every kind " +
      "listed, all zero) is a genuinely quiet day. Reporting the first as the second is the exact " +
      "defect this tool was fixed for: it reported a market-wide day of 19 corporate actions as " +
      "none, because it bound to an empty bucket and never said it had failed to read the rest.\n" +
      "The bucketed shape above was read off ONE live call, and that call sent no arguments. The " +
      "`date` and `from`/`to` forms have not been measured, so if a dated call comes back as a " +
      "flat list you will get rows with no `corpactionType` and no `buckets` — read `rowsFrom` " +
      "rather than assuming the bucketed shape.\n" +
      "An empty day is otherwise normal: weekends, holidays, and plenty of ordinary sessions have " +
      "no actions.",
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
    // PROJECTED, deliberately, and it was `observed` for a few hours before this comment replaced
    // that claim.
    //
    // What WAS measured, live on 2026-09-01: `GET /corpaction` with NO arguments answered from a
    // real account, and the twelve bucket keys and the `today` string this tool names were read out
    // of that response. That call is also what exposed the defect — the reader had been binding to
    // the empty `bonus` bucket and reporting a market-wide day of 19 actions as none.
    //
    // What was NOT measured is the rest of this tool's surface: `date`, and `from`/`to`, which
    // `getCalendarRange` issues as one DATED request per day. Whether the dated form also returns
    // buckets is unknown, and the code keeps a flat-shape branch whose output has neither
    // `corpactionType` nor `buckets`.
    //
    // This repo has already settled how to grade that. `shareholding` was fixed and verified on one
    // mode and STAYED `projected` because its other three were unprobed — `docs/PENDING-
    // VERIFICATION.md` says so in as many words. One call form out of three is the same situation,
    // and `observed` here would tell a caller the shape was seen live for a request nobody has
    // sent. One live `GET /corpaction?date=<a past trading day>` settles it.
    { evidence: "projected" },
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
      "Empty means no conversions IN THE PERIOD THIS FEED COVERS, which is not the same as none " +
      "ever: as with `corporate_actions`, the period's start is not in the response. " +
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
      "running a deal.\n" +
      "This is the same reader as `corporate_actions`, so the response CAN carry `suspectDates`. In " +
      "practice it almost never will: the date pairs that check compares are RUPS and dividend " +
      "ones, and no IPO date pair is on the list, so expect the field to be absent here even on a " +
      "row whose own dates are wrong. Read it if it appears; do not read its absence as anything. ",
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
