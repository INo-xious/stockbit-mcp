# Drawing on your chart

This server can draw on the real Stockbit chart — the one at `stockbit.com/symbol/{SYMBOL}/chartbit`
— by driving the browser you logged in with. The lines appear in a window you can see, and
Stockbit's own auto-save persists them. The decision record is
[ADR-0005](adr/0005-browser-driven-chartbit.md).

## How it works, and what that means for you

The driver attaches over the Chrome DevTools Protocol to the profile `stockbit-auth login` created,
finds or opens the chart tab, and calls the TradingView widget's own API inside the page. Nothing is
posted to Stockbit by this server: the requests are made by Stockbit's JavaScript, with your
session, exactly as if you had drawn the line yourself.

Consequences worth knowing:

- **The window is visible.** A line appearing on a chart you are looking at is the cheapest possible
  audit trail. (Cloudflare also blanks headless Chrome on stockbit.com.)
- **The browser must be the one you logged in with.** A profile directory is only valid in the
  browser that created it. The choice is pinned at login time in `~/.stockbit/browser-profile.json`;
  if that binary is gone you will get an error saying so, not a silent fallback onto a logged-out
  page.
- **The driver enables only the `Page` and `Runtime` CDP domains.** Never `Network`, never `Fetch` —
  those can read response bodies, and a drawing driver that could read traffic could read your
  session token. A test asserts it against the source.

## The tools

| | |
|---|---|
| `chartbit_open` | Open or focus a symbol's chart, optionally at an interval |
| `chartbit_draw` | Draw levels, trend lines, channels, zones and markers |
| `chartbit_analyze` | Fit the geometry from price and draw it in one call |
| `chartbit_study` | Add an indicator |
| `chartbit_shapes` | List what is on the chart |
| `chartbit_clear` | Remove drawings — **confirm-gated** |
| `chartbit_screenshot` | Capture the chart as a PNG |
| `chartbit_save` | Ask the widget to persist now |
| `chartbit_layouts` / `chartbit_layout` / `chartbit_layout_save` / `chartbit_layout_delete` | The saved-layout REST API |
| `chartbit_drawings` / `chartbit_drawings_save` | The drawing store behind a layout |
| `chartbit_templates` | Named chart templates |

Drawing needs **no confirmation** and clearing does. A line is additive, visible, and one click to
delete in the UI; `chartbit_clear` can destroy work you did by hand that this server never saw and
cannot reconstruct.

## Time is epoch seconds, and anchors have to be on the chart

TradingView points are `{time, price}` with `time` in **epoch seconds**, not milliseconds and not an
ISO string. A horizontal line still needs an anchor time even though it spans the chart, and an
anchor outside the loaded range makes the tool invisible rather than erroring — so every horizontal
tool is anchored to the **last loaded bar's date**, which is inside the range by construction.

The point count decides the API: one point is `createShape`, more than one is
`createMultipointShape`. Getting that wrong is a silent no-op.

## Studies are a closed list

`rsi`, `macd`, `atr`, `bollinger`, `ema`, `sma`, `volume`, `stochastic` — mapped to the charting
library's own names (`Relative Strength Index`, `Moving Average Exponential`, …). An unrecognised
study name is a **silent no-op** in the library, so a free-text name would let a caller be told
"Bolinger Bands" worked. It is refused here instead, with the list in the error.

## Colours

Support is green, resistance red, neutral blue, markers amber, zones grey, two pixels wide.
Overridable per call. Every annotation carries a label with its evidence — how many times a level
was tested and when it was last tested, or a trend line's fit — because a bare line invites more
confidence than the data supports.

## Persistence

Layouts live at `/chartbit/charts` and their drawings at `/chartbit/chart-drawings`; both encode
their content as base64 of a ZIP containing a single `layout.json`, DEFLATE level 9. The per-symbol
`/chartbit/{symbol}/layout` pair that this project targeted for months is a **server-side stub** —
it accepts every valid body and stores nothing. See `docs/research/chartbit-layout-format.md` for that
history and ADR-0003's Amendment 2 for the correction.

Saving through the widget (`chartbit_save`, or just leaving auto-save to fire) is the reliable path,
because the page's own adapter composes the payload. The REST writes exist for reading a layout back
and for round-tripping one.
