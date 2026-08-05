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

## The layout endpoint pair does not work (measured)

Enabled under ADR-0003 and exercised against a live account, `POST {j}/{symbol}/layout` **accepts and
discards**. This is not a payload problem, and the elimination is worth recording so nobody repeats
it:

| what was tried | result |
|---|---|
| `{content: <raw JSON>}` | 200 `"Retrieved Save Layout"`, nothing stored |
| `{content: <plain string>}` | 200, nothing stored |
| `{content: <base64 ZIP>}` (the encoding user-settings uses) | 200, nothing stored |
| `{content, name}` / `{layout}` | **400 INVALID_PARAMETER** — so `{content}` is definitively the schema |
| `?version=1`, `?user_setting_type=1`, `?symbol=` | 200, nothing stored |
| `GET` with key `BBRI`, `bbri`, `59` (company id) | 200, `layout: ""` for all three |

A GET that answers 200-with-empty for *any* key, and a POST that answers 200 for any body it accepts,
is the shape of a stub — the pair looks deprecated or entitlement-gated rather than misused.
`GET {j}/version` returns `{is_new: false}`, a user flag, not a schema version.

`POST {j}/template` — the *other* mechanism Stockbit's client uses for the same job, and additive
rather than destructive — behaves the same: accepted, and the template list comes back empty.

The base URL was verified rather than assumed: module `93053` defines `q7 = "https://exodus.stockbit.com"`,
so these requests went to the right host. There is no separate Chartbit service among the twenty-odd
origins that module lists.

**Conclusion: chart persistence through this API is non-functional on the account tested.** Both
mechanisms accept and discard. That is a property of Stockbit's server, not of the payload, the
host, the key, or the encoding — each of which was eliminated separately above.

### It is NOT a paywall — the account is eligible

An earlier revision of this document concluded that Chartbit is a paid feature and that saves from a
non-Pro account are discarded. **That was wrong, and it is left here as a correction rather than
deleted**, because the mistake is instructive: it was inferred from the paywall UI in the page
bundle instead of asked of the server.

Stockbit exposes the question directly:

```
GET /paywall/eligibility/check?features=PAYWALL_FEATURE_CHARTBIT&company=BBRI
→ {"features":[{"feature":"PAYWALL_FEATURE_CHARTBIT","is_eligible":true}],
   "company":{"company":"BBRI","is_eligible":true}}
```

`is_eligible: true`, on the same account for which broker distribution — itself behind a Rp
10,000,000 balance gate — works. `PAYWALL_FEATURE_KEYSTATS` and `PAYWALL_FEATURE_FINANCIALS` also
return eligible.

This is the second time this project has reached for a gate as an explanation; the first was blaming
every 403 on the balance requirement. Same lesson: when the server will answer, ask it rather than
reading the UI's intentions. The route is declared as `paywallEligibility` so the question is cheap
to ask next time.

### What it appears to be instead: saving is not wired up

The page chunk `pages/symbol/[symbol]/chartbit-*.js` contains **no save wiring at all** — no
`save_load_adapter`, no `auto_save_delay`, no `onAutoSaveNeeded`, no `saveLayout` call site. The API
function exists in the client module and nothing calls it.

Server-side the pair behaves like a stub, and drawing a trendline in Stockbit's own UI and saving it
does not persist either. The client's axios instance was checked too, in case a header was missing:
it sets only `Accept: application/json`, an optional `User-Agent`, and the bearer — nothing this
project does not already send.

So chart-layout saving looks retired on both sides. Stated as an observation about behaviour, not a
diagnosis of someone else's backend.

### The original (incorrect) paywall reasoning, kept for the record

The chart page chunk (`_next/static/chunks/pages/symbol/[symbol]/chartbit-*.js`) gates itself on the
account's Pro status:

```js
{ isPro: a.company.isPro, isRenewal, isLoading, getStatus, addCounter }
…
var b = p.qU.CHARTBIT;               // PAYWALL_FEATURE_CHARTBIT
f({ key: o.P.company, feature: b, company: a });
g({ feature: b, company: a });       // addCounter — a usage counter for non-subscribers
```

The same enum carries `PAYWALL_FEATURE_KEYSTATS`, `PAYWALL_FEATURE_ANALYSIS`,
`PAYWALL_FEATURE_FINANCIALS` and `PAYWALL_FEATURE_FUNDACHART`, and the chunk ships the paywall copy
*"Berlangganan mulai dari Rp15 ribu/hari untuk nikmati semua fitur tanpa batas."*

Notably the page chunk contains **no save wiring at all** — no `save_load_adapter`,
`auto_save_delay`, `onAutoSaveNeeded` or `saveLayout` call site. A non-Pro account is served the
chart with a usage counter and no save path, which is consistent with the server accepting a save
and discarding it.

This is the same shape as the Rp 10,000,000 balance gate on broker distribution, and it is treated
the same way in `src/core/layoutwrite.ts`: name the likely cause, and say plainly that it is an
inference. Stockbit returns no entitlement error on this path — a 200 with no effect — so asserting
it as fact would repeat the mistake of blaming every 403 on the balance gate.

**What would confirm it:** a Pro subscription, or a network trace of a save from a Pro account.

## Where the chart configuration actually lives

`GET /user-setting/configurations?user_setting_type=1` → `content` is **base64 of a ZIP containing a
single `layout.json`**. ~12KB decoded on the account tested, holding the real TradingView settings:
`chartproperties`, `current_theme.name`, `ChartDrawingToolbarWidget.visible`,
`chart.lastUsedTimeBasedResolution`, `chartbitCustomSetting`, 18 keys in all.

That is a chart's *properties*, which TradingView's charting library persists separately from a
chart's *layout* — so an empty per-symbol layout does not mean the user has configured nothing.
`src/core/chartsettings.ts` reads it.

`GET {j}/template` (the named-layout list) returns `[]` on this account.

## What remains untried

`POST {j}/template` with `{name, content: JSON.stringify(layout)}` — Stockbit's *named layout* save,
a different route from the per-symbol slot. It is additive rather than destructive (it creates a
named object instead of replacing a slot), which makes it lower-risk than the write already enabled.

It is untried because **ADR-0003 scoped the approved mutation to `POST {j}/{symbol}/layout` and says
in its own terms that a further write needs a fourth ADR** — an instruction to enable one route is
not an instruction to enable the next one. Whether the intent behind "enable the write" covers it is
the account owner's call, not an inference to make on their behalf.
