/**
 * Screener runs and watchlist reads.
 *
 * Every tool here is registered with `define.read`, including `screener_run` — which is a POST.
 * That is deliberate and it is the one judgement call in this file: `read` versus `write` in
 * `_define.ts` is about whether a tool changes account state, not about which verb it uses, and an
 * ad-hoc run carries Stockbit's own run-do-not-save flag and creates nothing (see the module note on
 * `src/core/screenerrun.ts`). Registering it as a read is what makes it usable from a saved workflow;
 * the screen-SAVING tool is a different tool in a later increment, and it will be a `write`.
 */
import { z } from "zod";
import * as core from "../core/screenerrun.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

export function registerScreenerTools(define: Definer): void {
  define.read(
    "screener_run",
    "Run an ad-hoc stock screen over Stockbit's IDX metric catalogue and get the matching stocks.\n" +
      "Creates NOTHING. The request carries Stockbit's own run-but-do-not-save flag, and no argument " +
      "to this tool can change it — saving a screen is a separate tool that does not exist yet.\n" +
      "Rules are combined with AND. There is NO OR: for \"A or B\", call this twice and union the " +
      "symbols yourself. A single call cannot express it, and pretending otherwise would return a " +
      "confident answer to a different question.\n" +
      "`metric` is an id from the screenable-metric catalogue — call the `screener` tool with " +
      "catalogue:true to see them. The catalogue is IDX-specific and includes Bandarmology metrics " +
      "built on broker-level flow.\n" +
      "`watchlist_id` scopes the screen to that watchlist's members instead of the default universe, " +
      "which is how \"which of MY stocks is accumulating\" becomes one call. Scoping to an index " +
      "(IDX30, LQ45…) is NOT supported: the scope spelling for an index has not been observed.\n" +
      "`limit` trims the returned list after the fact; `count` stays the true number of matches and " +
      "`truncated` says the list was cut.\n" +
      "PENDING: apart from the save flag, this request shape has not been observed on the wire. The " +
      "body that was sent comes back in `request`, and `matches: null` means the rows were not where " +
      "they were looked for in the response — that is NOT \"no stock matched\" (which is `matches: []` " +
      "with `count: 0`). When it is null the whole payload is attached as `raw` so the real shape can " +
      "be reported.",
    {
      rules: z
        .array(
          z.object({
            metric: z.string().describe("Metric id from the screener catalogue"),
            operator: z.enum(core.SCREEN_OPERATORS),
            value: z.union([z.number(), z.string()]).describe("Threshold to compare the metric against"),
          }),
        )
        .min(1)
        .describe("Filters, combined with AND. At least one is required."),
      watchlist_id: z
        .string()
        .optional()
        .describe("Screen only this watchlist's members. Numeric id from the `watchlist` tool."),
      limit: z.coerce.number().optional().describe("Trim the returned matches to this many"),
    },
    async (a) =>
      runTool(() =>
        core.runScreen(a.rules as core.ScreenRule[], {
          scope: a.watchlist_id === undefined ? undefined : core.watchlistScope(a.watchlist_id as string),
          limit: a.limit as number | undefined,
        }),
      ),
  );

  define.read(
    "screener_favorites",
    "The screens the user has marked as favourites.\n" +
      "PENDING: this route has not been probed. The rows are returned as they arrive, under `rows`, " +
      "with `foundAt` naming the response key they came from. `rows: null` means no list was found " +
      "where one was looked for — not that there are no favourites — and the raw body is attached so " +
      "the shape can be reported. `count: 0` with `rows: []` is the real \"none\".\n" +
      "The saved-screen listing from the `screener` tool already carries a favourite flag and IS " +
      "verified, so use that if this answers oddly.",
    {},
    async () => runTool(() => core.getScreenerFavorites()),
  );

  define.read(
    "screener_finitems",
    "Stockbit's fin-item watchlist: the financial-statement line items saved for use as screener " +
      "columns. These are not stocks and not a watchlist of tickers.\n" +
      "PENDING: this route has not been probed and what a row means is not confirmed, so rows are " +
      "returned unprojected rather than renamed into fields that would be a guess. `rows: null` means " +
      "the list was not found, not that it is empty.",
    {},
    async () => runTool(() => core.getScreenerFinItems()),
  );

  define.read(
    "watchlist_symbols",
    "The tickers in one watchlist, from Stockbit's dedicated symbols route. Takes a numeric watchlist " +
      "id — get one from the `watchlist` tool. A non-numeric id is refused before any request is made.\n" +
      "PENDING: this route has not been probed. For a universe you are going to act on, the " +
      "`watchlist` tool with an `id` is the verified path — it reads a different endpoint, returns " +
      "quotes alongside the tickers, and is capped at 500 symbols.\n" +
      "`symbols: null` means the rows were not found in the response, NOT that the watchlist is " +
      "empty; an empty list is `symbols: []` with `count: 0`. Rows that held no recognisable ticker " +
      "are counted in `unprojected` rather than silently dropped.",
    { watchlist_id: z.string().describe("Numeric watchlist id, from the `watchlist` tool") },
    async (a) => runTool(() => core.getWatchlistSymbolList(a.watchlist_id as string)),
  );

  define.read(
    "watchlist_search",
    "Search Stockbit's company directory by keyword — the lookup behind the watchlist's add-a-stock " +
      "box. Use it to turn a company name into an IDX ticker.\n" +
      "An empty keyword is refused rather than sent, because the endpoint would answer it with either " +
      "everything or nothing and both read like a real result.\n" +
      "PENDING: this route has not been probed, so rows are returned unprojected — which key holds the " +
      "ticker is not confirmed and naming one now would ship a field that is always empty. " +
      "`rows: []` with `count: 0` means nothing matched the keyword; `rows: null` means the response " +
      "held no list where one was looked for, and the raw body is attached.\n" +
      "This searches ALL listed companies, not the user's watchlists.",
    { keyword: z.string().describe("Company name or ticker fragment, e.g. \"bank rakyat\" or \"BBR\"") },
    async (a) => runTool(() => core.searchCompanies(a.keyword as string)),
  );
}
