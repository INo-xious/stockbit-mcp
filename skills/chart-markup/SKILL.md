---
name: chart-markup
description: Read and draw on the user's own Stockbit chart — levels, trend lines, studies, screenshots and saving the layout. Use when the user asks to draw, mark up, annotate or look at their chart.
---

# Chart markup

This drives the browser the user is already signed into, over the Chrome DevTools Protocol, on
Stockbit's own chart page. It is the one place this server touches a UI, and everything it draws
lands in the user's real saved layout.

## The sequence

1. **`chartbit_open symbol=… `** — put the chart in front of them. `resolution` and `chart_type`
   set the timeframe and style. Do this first; everything below acts on the open chart.
2. **`chartbit_analyze symbol=…`** — derive support, resistance and trend lines from the bars.
   `min_touches` controls how much evidence a level needs; `lookback` how far back to look. With
   `draw=true` it draws what it found in one step, and `replace=true` clears the previous set
   instead of stacking on it.
3. **`chartbit_draw symbol=… annotations=… anchor_date=…`** for anything specific.
   **Times are epoch seconds**, and `anchor_date` is what the annotation coordinates are relative
   to. Getting this wrong puts a line in 1970, which is visible but not useful.
4. **`chartbit_study symbol=… study=…`** for indicators. The studies are a **closed list** — the
   tool description names them. A study Stockbit does not have cannot be added by asking twice.
5. **`chartbit_screenshot symbol=…`** to see the result, and **`chartbit_save symbol=…`** to keep
   it.

## Rules

- **Saving is explicit.** Stockbit autosaves on its own schedule, which is not yours: if the user
  wants the markup to survive, call `chartbit_save`. Say that you did.
- **`replace` versus stacking.** Running `chartbit_analyze` three times without `replace=true`
  leaves three sets of lines on the user's real chart. Prefer `replace=true` unless they asked to
  add to what is there.
- **This is their chart.** Do not clear a layout you did not draw without asking. There is no undo.
- **Check the drawing landed.** Take the screenshot. The CDP call can succeed while the chart
  rejects the annotation.
- **A blank white page means signed out.** Stockbit's chart renders nothing at all when there is no
  session — no login prompt, nothing. If the screenshot is blank, that is what happened, and the fix
  is a login in that browser, not a retry.
