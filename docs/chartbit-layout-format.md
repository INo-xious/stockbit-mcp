# The Chartbit layout format

Recovered by reading Stockbit's own front-end bundle (`_next/static/chunks/82241-*.js`, module
`39097` for the API and `85773` for the helpers). Nothing here was guessed, and nothing was written
to an account to obtain it.

This document exists because the format was the blocker on the drawing feature: `GET
/chartbit/{symbol}/layout` returns the empty string for an account that has never saved a chart, and
an empty string reveals nothing about how a populated one is encoded.

## The API

`j = <exodus>/chartbit`

| Purpose | Method + path | Notes |
|---|---|---|
| Chart metadata | `GET {j}/initial/{symbol}` | name, description, type, timezone, ticker, exchange, country |
| Daily prices | `GET {j}/{symbol}/price/daily` | `{from, to, limit: 0}` sent **only when both from and to are given**, merged with any other args |
| Intraday prices | `GET {j}/{symbol}/price/intraday` | same parameter handling |
| Corporate actions | `GET {j}/chart/corpaction` | `{from, to, symbol}` |
| **Read layout** | `GET {j}/{symbol}/layout` | `{ data: { layout: string } }` |
| **Save layout** | `POST {j}/{symbol}/layout` | `{ content: normalizeSeriesIds(JSON.stringify(layout)) }` |
| List templates | `GET {j}/template` | |
| Load template | `GET {j}/{symbol}/template/{name}` | |
| Save template | `POST {j}/template` | `{ name, content: JSON.stringify(layout) }` — **not** id-normalised |
| Delete template | `DELETE {j}/template/{name}` | |
| Custom indicators | `GET {j}/custom/indicator` | |
| Version | `GET {j}/version` | |

## `Fj` is not encryption

The save path passes the serialised layout through `Fj` before sending it. That looked like it might
be an opaque encoding, which would have made the write unimplementable. It is not:

```js
ak = function (a) {
  var b = a;
  ["D4LkIE", "7a6YCE"].forEach(function (a) {
    b = b.replace(RegExp(a, "g"), "_seriesId");
  });
  return b;
};
```

It replaces two literal TradingView-generated series IDs with the placeholder `_seriesId`, so a saved
layout is not bound to the series instance that produced it. The stored `content` is therefore
**plain JSON**.

Two consequences worth stating plainly:

- The magic IDs `D4LkIE` and `7a6YCE` are hardcoded in the bundle. A layout produced by a *different*
  TradingView build may contain a different generated id, which this substitution would not catch —
  so a round-trip must not assume the placeholder is always present.
- Because it is a plain `String.replace`, a layout whose own content happened to contain those
  literals would be corrupted by the save. That is Stockbit's behaviour, not something this project
  can fix, and it is a reason to prefer reading a layout over synthesising one.

## The layout object

Chartbit is a TradingView Charting Library widget (`window.tvWidget`). The saved object is the
library's standard chart state:

```jsonc
{
  "layout": "s",                       // single-chart layout
  "charts": [
    {
      "panes": [
        {
          "sources": [
            { "type": "MainSeries", "id": "_seriesId", "zorder": 0, "state": { /* candle styling */ } }
            // drawings are additional sources here, e.g. type "LineToolHorzLine"
          ],
          "leftAxisesState": [], "rightAxisesState": []
        }
      ],
      "chartProperties": { "paneProperties": { /* background, grid */ } },
      "version": 3,
      "timezone": "Asia/Jakarta",
      "chartId": "1",
      "theme": "light",
      "lineToolsGroups": { "groups": [] },
      "shouldBeSavedEvenIfHidden": true,
      "linkingGroup": null
    }
  ],
  "symbolLock": 0, "intervalLock": 0, "trackTimeLock": 0, "dateRangeLock": 0, "crosshairLock": 1,
  "layoutsSizes": { "s": [{ "percent": 1 }] }
}
```

Stockbit ships named templates in the same shape: `light`, `dark`, `default`, `foreign_flow`,
`bandarmology`.

### What is still unknown

The **line-tool source schema** — the exact `state` a `LineToolHorzLine` or `LineToolTrendLine`
expects — is defined by the TradingView charting library, which is served separately from the Next.js
chunks. Composing brand-new drawings needs it. Reading, round-tripping and modifying an existing
layout does not.

## Why the write is still not enabled here

The format being knowable does not make the write appropriate. `POST {j}/{symbol}/layout`
**overwrites** the user's saved chart, and ADR-0002 makes mutation of account data the property this
codebase is built around — enforced by a closed route table, not by convention. Enabling it is a
change of posture that must arrive with the apparatus that ADR names: read-before-write snapshot,
post-write verification, rollback, a mutation log, and an explicit per-call confirmation.

It also needs the account owner's explicit instruction, which a goal-completion check is not.
