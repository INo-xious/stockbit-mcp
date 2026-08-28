/**
 * Stream, news and research tools.
 *
 * Every description here is written for a model that will otherwise misread this family in one of
 * three ways: as price data (it is not — it is text people wrote), as an offset-paged list (it is
 * cursor-paged), and as broken when it answers with nothing (an empty stream is an ordinary answer).
 */
import { z } from "zod";
import * as stream from "../core/stream.js";
import * as research from "../core/research.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

/** Repeated in the tools that page, because a cursor misunderstood is a silently repeated page. */
const CURSOR_NOTE =
  "Paging is a CURSOR, not an offset: there is no page number or `offset`. Take `nextCursor` from " +
  "the result and send it as last_stream_id to get the rows AFTER the ones you have seen; calling " +
  "again without it returns the same rows. `nextCursor` is null when the page is empty or its last " +
  "row carried no id, which means the walk cannot be continued rather than that it has ended.";

/** Repeated wherever a page is returned, because "empty" and "unreadable" must not look alike. */
const EMPTY_NOTE =
  "An empty `items` with a non-null `source` is a genuine zero — a quiet symbol or a narrow " +
  "keyword — and not a reason to retry.";

/** Repeated because the row shape is projected, not measured. */
const PENDING_NOTE =
  "PENDING VERIFICATION: only the per-symbol stream has been observed live, so id/content/" +
  "created_at/author are projected and may be absent; every row carries its wire object as `raw`.";

const NOT_DATA_NOTE =
  "This is community- and media-written Indonesian text, not market data. Use it for sentiment and " +
  "as a pointer to a source; never quote a price, a ratio or an earnings figure from a post.";

export function registerStreamTools(define: Definer): void {
  define.read(
    "stream",
    "Posts from Stockbit's social stream: news, trading ideas, filed reports, insider posts, charts, " +
      "polls and predictions.\n" +
      "With no symbol this is the market-wide stream; with a symbol it is that company's stream, which " +
      "is the same feed the Stockbit symbol page shows.\n" +
      NOT_DATA_NOTE +
      "\n" +
      "category selects the tab and is sent verbatim: STREAM_CATEGORY_NEWS is the News tab, " +
      "_REPORTS the filed-research tab, _INSIDER insider posts. STREAM_CATEGORY_LIKED and _SAVED are " +
      "the signed-in account's own, not the market's, and the three *_WATCHLIST values scope the feed " +
      "to the user's lists — watchlist_ids narrows that to named lists (ids come from the watchlist " +
      "tools; they are numeric).\n" +
      "report_type only narrows STREAM_CATEGORY_REPORTS. It is sent as given for any other category " +
      "and Stockbit is free to ignore it there.\n" +
      "from_date/to_date are YYYY-MM-DD and are calendar-checked before the request goes out, so a " +
      "typo (2026-02-30, 20260803) fails loudly instead of quietly returning today. Either end may " +
      "stand alone; an inverted pair is rejected.\n" +
      CURSOR_NOTE +
      "\n" +
      EMPTY_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      symbol: z.string().optional().describe("IDX ticker, e.g. BBRI. Omit for the market-wide stream."),
      category: z.enum(stream.STREAM_CATEGORIES).optional().describe("Wire spelling, case-sensitive. Omitted = Stockbit's default feed."),
      report_type: z.enum(stream.REPORT_TYPES).optional().describe("Narrows STREAM_CATEGORY_REPORTS only."),
      keyword: z.string().optional().describe("Full-text search over post content."),
      from_date: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      to_date: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      limit: z.coerce.number().optional().describe("Max rows. Omitted = Stockbit's own page size (30 on the route observed)."),
      last_stream_id: z.string().optional().describe("Cursor: the `nextCursor` from the previous page."),
      last_reply: z.string().optional().describe("Second cursor Stockbit's client sends beside last_stream_id; its role is unverified, so leave it unset."),
      watchlist_ids: z.array(z.string()).optional().describe("Numeric watchlist ids, for the *_WATCHLIST categories."),
    },
    async (a) => {
      const query: stream.StreamQuery = {
        category: a.category as string | undefined,
        reportType: a.report_type as string | undefined,
        keyword: a.keyword as string | undefined,
        fromDate: a.from_date as string | undefined,
        toDate: a.to_date as string | undefined,
        limit: a.limit as number | undefined,
        lastStreamId: a.last_stream_id as string | undefined,
        lastReply: a.last_reply as string | undefined,
        watchlistIds: a.watchlist_ids as string[] | undefined,
      };
      const symbol = a.symbol as string | undefined;
      return runTool(() =>
        symbol === undefined || symbol === "" ? stream.getStream(query) : stream.getSymbolStream(symbol, query),
      );
    },
  );

  define.read(
    "news",
    "News posts, market-wide or for one symbol.\n" +
      "There is no separate news endpoint: news IS the stream with category=STREAM_CATEGORY_NEWS, and " +
      "the Stockbit symbol page's News tab is exactly this call with a symbol. So `news` routes to the " +
      "per-symbol stream when given a symbol and to the market-wide one when not, and fixes the " +
      "category — pass `stream` a category instead if you want anything else.\n" +
      NOT_DATA_NOTE +
      "\n" +
      "Headlines are Indonesian-language and mostly link out to the publisher; the link, image and " +
      "publisher fields are not named by this projection, so read `raw` for them.\n" +
      "from_date/to_date are YYYY-MM-DD and calendar-checked.\n" +
      CURSOR_NOTE +
      "\n" +
      EMPTY_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      symbol: z.string().optional().describe("IDX ticker, e.g. BBRI. Omit for market-wide news."),
      keyword: z.string().optional().describe("Full-text search over headlines and body."),
      from_date: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      to_date: z.string().optional().describe("YYYY-MM-DD, inclusive"),
      limit: z.coerce.number().optional().describe("Max rows. Omitted = Stockbit's own page size."),
      last_stream_id: z.string().optional().describe("Cursor: the `nextCursor` from the previous page."),
    },
    async (a) =>
      runTool(() =>
        stream.getNews({
          symbol: a.symbol as string | undefined,
          keyword: a.keyword as string | undefined,
          fromDate: a.from_date as string | undefined,
          toDate: a.to_date as string | undefined,
          limit: a.limit as number | undefined,
          lastStreamId: a.last_stream_id as string | undefined,
        }),
      ),
  );

  define.read(
    "stream_trending",
    "The posts Stockbit is currently promoting as trending, market-wide.\n" +
      "Trending is Stockbit's own ranking of engagement, not a measure of price movement or of " +
      "accuracy: a post trends because people replied to it. For stocks that are moving, use the " +
      "market-mover and hotlist tools instead.\n" +
      NOT_DATA_NOTE +
      "\n" +
      "date is YYYY-MM-DD and calendar-checked; omitted, Stockbit picks the current day itself. Asking " +
      "for a date with no session (a weekend, a holiday) is answered with an empty list, not an error.\n" +
      CURSOR_NOTE +
      "\n" +
      EMPTY_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      date: z.string().optional().describe("YYYY-MM-DD. Omit for Stockbit's current day."),
      limit: z.coerce.number().optional().describe("Max rows."),
      last_stream_id: z.string().optional().describe("Cursor: the `nextCursor` from the previous page."),
    },
    async (a) =>
      runTool(() =>
        stream.getTrendingStream({
          date: a.date as string | undefined,
          limit: a.limit as number | undefined,
          lastStreamId: a.last_stream_id as string | undefined,
        }),
      ),
  );

  define.read(
    "stream_post_detail",
    "Read ONE post by id, with the whole payload the detail endpoint returns. This is a READ — it " +
      "does not post anything, and nothing in this server can post to the stream.\n" +
      "Use it to read a post a stream page truncated, or to see the replies and counters a list row " +
      "does not carry. The id is the `id` of a row from any stream tool (or `nextCursor`), and it is " +
      "numeric — a profile slug or a URL fragment is rejected before any request is made.\n" +
      "`post` is the named projection and `raw` is the entire `data` object, always included because " +
      "replies, attachments and engagement counts are not mapped by name.\n" +
      "`post: null` with `source: null` means the response held nothing this code could read as a " +
      "post; `raw` shows what came back. A deleted or private post is answered upstream as an error, " +
      "not as an empty success.\n" +
      PENDING_NOTE,
    {
      post_id: z.string().describe("Numeric stream post id, from a row's `id`."),
    },
    async (a) => runTool(() => stream.getPost(a.post_id as string)),
  );

  define.read(
    "stream_pinned",
    "The posts pinned to a symbol's page — what Stockbit or the company has chosen to keep at the top.\n" +
      "Usually a handful at most, and an empty list is the normal answer for most symbols: it means " +
      "nothing is pinned, NOT that the symbol has no stream. For the symbol's actual feed use `stream` " +
      "or `news` with a symbol.\n" +
      "Takes no filters and no cursor: this list is short and hand-curated, and no paging parameter " +
      "has been observed on it.\n" +
      NOT_DATA_NOTE +
      "\n" +
      EMPTY_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
    },
    async (a) => runTool(() => stream.getPinnedPosts(a.symbol as string)),
  );

  define.read(
    "stream_user",
    "One Stockbit user's posts, by username.\n" +
      "Reads a public profile feed, so it says nothing about who the user is, whether they hold the " +
      "stocks they post about, or whether they are right. Track record is not returned and must not be " +
      "inferred from post count.\n" +
      "The username is the handle (letters, digits, `_` and `.`), not a display name and not an id; " +
      "anything else is rejected before a request is made. An unknown handle is an upstream error, " +
      "while a real handle with nothing posted is an empty list.\n" +
      NOT_DATA_NOTE +
      "\n" +
      CURSOR_NOTE +
      "\n" +
      EMPTY_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      username: z.string().describe("Stockbit handle, e.g. some_user"),
      limit: z.coerce.number().optional().describe("Max rows."),
      last_stream_id: z.string().optional().describe("Cursor: the `nextCursor` from the previous page."),
    },
    async (a) =>
      runTool(() =>
        stream.getUserStream(a.username as string, {
          limit: a.limit as number | undefined,
          lastStreamId: a.last_stream_id as string | undefined,
        }),
      ),
  );

  define.read(
    "research",
    "Stockbit's research metadata. Two answers from one tool, selected by whether a symbol is given.\n" +
      "With NO symbol: the research category list — the vocabulary behind Stockbit's research filter. " +
      "Rows are returned exactly as sent, because their field names have not been mapped; `source` " +
      "reports where in the envelope they were found and is null when no list was recognised.\n" +
      "With a symbol: the new-research indicator for that company, returned unprojected under `data`. " +
      "It is a badge check, so a null or empty `data` means there is nothing new — an answer, not a " +
      "failure.\n" +
      "This tool does NOT return research content. Analyst reports and filed research arrive through " +
      "`stream` with category=STREAM_CATEGORY_REPORTS (narrow with report_type), and analyst price " +
      "targets are a different family entirely.\n" +
      "Pending verification: neither route has been observed live, which is why nothing here is " +
      "renamed and no field is invented.",
    {
      symbol: z.string().optional().describe("IDX ticker. Omit for the category list."),
    },
    async (a) => {
      const symbol = a.symbol as string | undefined;
      // The two shapes are deliberately different, so the union is named rather than widened away.
      return runTool<research.ResearchCategories | research.ResearchIndicator>(() =>
        symbol === undefined || symbol === ""
          ? research.getResearchCategories()
          : research.getResearchIndicator(symbol),
      );
    },
  );
}
