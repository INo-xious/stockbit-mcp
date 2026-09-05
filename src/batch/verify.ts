/**
 * Prove that the data we got back is the data we asked for.
 *
 * This module exists because of the failure mode `core/dates.ts` documents: the broker-summary
 * endpoint answers nearly every malformed date request with **HTTP 200 and the latest session**.
 * There is no error to catch. A backfill walking 500 sessions could therefore write the same
 * Tuesday into 500 rows, and every downstream stage — features, labels, folds, reports — would run
 * happily on it and produce a confident, worthless model.
 *
 * `core/dates.ts` prevents the known ways of triggering that (bad formats, missing `to`, wrong
 * parameter names) on the way OUT. This checks the way BACK IN, which is the half that survives an
 * upstream change nobody told us about. Two independent guards, because the cost of being wrong
 * here is a silently poisoned dataset rather than a visible failure.
 *
 * The returned dates are read from the response body (`parsed.data.from` / `.to` in
 * `getBrokerSummary`), not echoed from the request, so they are real evidence.
 */

/** The outcome of checking one response against what was requested. */
export type WindowVerdict =
  | { ok: true; note?: string }
  | { ok: false; reason: string; observed: string };

export interface DateWindow {
  from: string;
  to: string;
}

/**
 * Check a broker-summary response covers exactly the requested session.
 *
 * An absent `from`/`to` is treated as a FAILURE, not a pass. The pipeline files each response under
 * a date; a response that will not say which date it describes cannot be filed, and guessing "it
 * must be the one we asked for" is precisely the assumption the silent-200 behaviour violates.
 */
export function verifyBrokerWindow(
  requested: DateWindow,
  response: { from?: string; to?: string },
): WindowVerdict {
  const { from, to } = response;

  if (!from || !to) {
    return {
      ok: false,
      reason:
        "the response did not state which dates it covers, so it cannot be filed under one. " +
        "Storing it as the requested window would assume exactly what this check exists to verify.",
      observed: `from=${from ?? "absent"} to=${to ?? "absent"}`,
    };
  }

  if (from !== requested.from || to !== requested.to) {
    const looksLikeLatestSession = from === to && from > requested.to;
    return {
      ok: false,
      reason: looksLikeLatestSession
        ? "the API returned the LATEST session instead of the requested one — the signature of a " +
          "request whose dates were ignored (see core/dates.ts). Nothing was stored."
        : "the response covers a different window than the one requested",
      observed: `requested ${requested.from}..${requested.to}, received ${from}..${to}`,
    };
  }

  return { ok: true };
}

/**
 * Check a bar series against its requested window.
 *
 * Bars are gentler than broker summaries — `getBars` filters to the window itself — so this is
 * about catching what filtering cannot fix: a series whose paging hit the ceiling (`truncated`), or
 * one that came back empty. Empty is NOT treated as an error: IDX holidays are deliberately not
 * modelled, and a symbol can simply not have traded. It is reported so the caller can record "no
 * session" as an observation rather than mistaking it for a failed request.
 */
export function verifyBars(
  requested: DateWindow,
  series: { bars: readonly { date: string }[]; truncated?: boolean; pagesFetched?: number },
): WindowVerdict {
  const bars = series.bars ?? [];

  if (!bars.length) {
    return { ok: true, note: "no bars in range — holiday, suspension, or a symbol that did not trade" };
  }

  const outside = bars.filter((bar) => bar.date < requested.from || bar.date > requested.to);
  if (outside.length) {
    return {
      ok: false,
      reason: `${outside.length} bar(s) fall outside the requested window`,
      observed: `first offender ${outside[0].date}, window ${requested.from}..${requested.to}`,
    };
  }

  const dates = bars.map((bar) => bar.date);
  const sorted = [...dates].sort();
  if (dates.join() !== sorted.join()) {
    return {
      ok: false,
      reason: "bars are not in chronological order; every trailing-window feature assumes they are",
      observed: `${dates[0]}..${dates[dates.length - 1]}`,
    };
  }

  if (new Set(dates).size !== dates.length) {
    return {
      ok: false,
      reason: "the series contains duplicate sessions",
      observed: `${dates.length} bars, ${new Set(dates).size} distinct dates`,
    };
  }

  if (series.truncated) {
    return {
      ok: false,
      reason:
        "paging hit its ceiling before the window was covered, so this series is short at the far " +
        "end. Storing it would look like a data gap rather than an incomplete pull.",
      observed: `pagesFetched=${series.pagesFetched ?? "?"}, earliest ${dates[0]}`,
    };
  }

  return { ok: true };
}

/**
 * Check a news page falls inside the requested window.
 *
 * The stream endpoint takes `from_date`/`to_date`, and the same silent-200 hazard applies: a
 * request whose dates were ignored comes back as the newest posts, not the asked-for ones. Each
 * item's `createdAt` is the evidence, read from the body. An item without one is not a failure of
 * the window check - the raw row is kept verbatim - but it cannot vouch for the window either, so
 * a page where NO item carries a date is refused: nothing on it can be filed.
 *
 * An EMPTY page is a pass. Most symbols have no news on most days; "nothing was written about
 * this name in this window" is a real observation the feature side encodes as its own indicator.
 */
export function verifyNewsWindow(
  requested: DateWindow,
  page: { items?: { createdAt?: string }[]; truncated?: boolean; pagesFetched?: number },
): WindowVerdict {
  const items = page.items ?? [];
  if (items.length === 0) return { ok: true, note: "no news in the window" };

  const dated = items.map((i) => i.createdAt?.slice(0, 10)).filter((d): d is string => !!d);
  if (dated.length === 0) {
    return {
      ok: false,
      reason: "no item on the page carries a date, so none can be filed under the requested window",
      observed: `${items.length} item(s), 0 dated`,
    };
  }

  const outside = dated.filter((d) => d < requested.from || d > requested.to);
  if (outside.length) {
    const newestOutside = [...outside].sort().at(-1);
    return {
      ok: false,
      reason:
        "the page carries posts outside the requested window - the signature of a request whose " +
        "dates were ignored and answered with the newest posts instead. Nothing was stored.",
      observed: `${outside.length} of ${dated.length} dated item(s) outside ${requested.from}..${requested.to}, e.g. ${newestOutside}`,
    };
  }

  if (page.truncated) {
    return {
      ok: false,
      reason:
        "paging hit its ceiling before the window was exhausted, so this page set is incomplete at " +
        "the old end. Storing it would look like quiet days rather than an incomplete pull.",
      observed: `pagesFetched=${page.pagesFetched ?? "?"}, oldest ${[...dated].sort()[0]}`,
    };
  }

  return { ok: true };
}
