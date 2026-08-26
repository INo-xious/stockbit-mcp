/**
 * Turning an `Annotation` into a TradingView shape request.
 *
 * Pure and offline: annotations in, request objects out. That matters because everything else in
 * this directory needs a browser to exercise, and the mapping — which tool name, how many points,
 * which override keys — is where the mistakes actually are. `test/chartbit.test.ts` asserts the
 * requests without opening anything.
 *
 * ## The two things that are easy to get wrong
 *
 * **Time is epoch SECONDS.** TradingView anchors a point at `{time, price}` with `time` in seconds.
 * A millisecond value places the shape roughly fifty thousand years in the future, which renders as
 * nothing at all rather than as an error. `epochSeconds` in `src/core/dates.ts` is the one
 * conversion, and it validates the date on the way through.
 *
 * **Point count selects the API.** A one-point tool goes through `createShape`, a two-point tool
 * through `createMultipointShape`, and the library answers `null` rather than throwing when they are
 * mismatched — so the caller believes it drew something. The request carries its points and the page
 * script branches on their number, which keeps that decision in one place.
 *
 * ## Override names are not guessed
 *
 * The `overrides` keys below are TradingView's documented line-tool properties. Where a name has not
 * been confirmed against Stockbit's build of the library, the request still carries it — an unknown
 * override is ignored by the library rather than rejected — but `docs/chartbit-drawing.md` records
 * which have actually been observed via `getShapeById(id).getProperties()` on a real chart. A colour
 * that silently does nothing is a cosmetic miss; inventing a *point* would be a wrong drawing.
 */
import { epochSeconds } from "../core/dates.js";
import type { Annotation } from "../render/candles.js";
import { StockbitError } from "../http/errors.js";

/** A channel: two parallel trend lines drawn as one tool. */
export interface ChannelAnnotation {
  kind: "channel";
  fromDate: string;
  fromPrice: number;
  toDate: string;
  toPrice: number;
  /** Price offset of the second boundary from the first. */
  offset: number;
  label?: string;
  color?: string;
}

/**
 * A Fibonacci retracement between two swing points.
 *
 * Two points, exactly like a trend line, and the tool derives its own levels from them — which is
 * the reason to use TradingView's native tool rather than drawing seven horizontal lines at computed
 * prices. The native one keeps the ratios when the user drags an endpoint, labels each level with
 * its ratio and price, and survives a resolution change. Seven fixed lines are a photograph of a
 * retracement; this is the retracement.
 *
 * `fromDate`/`fromPrice` is the START of the move being retraced and `toDate`/`toPrice` its END, so
 * for an up-move that is the swing LOW then the swing HIGH. Reversing them flips the ratios, which
 * is a legitimate thing to want on a down-move and a silent mistake otherwise.
 */
export interface FibAnnotation {
  kind: "fib";
  fromDate: string;
  fromPrice: number;
  toDate: string;
  toPrice: number;
  label?: string;
  color?: string;
}

/** A vertical marker at one date — an earnings day, an ex-dividend date. */
export interface VerticalLineAnnotation {
  kind: "vline";
  date: string;
  label?: string;
  color?: string;
}

/** Everything the driver can draw. The first four are the renderer's own union, unchanged. */
export type DrawableAnnotation = Annotation | ChannelAnnotation | VerticalLineAnnotation | FibAnnotation;

export interface ShapePoint {
  time: number;
  price?: number;
}

export interface ShapeRequest {
  /** TradingView's shape name, e.g. `horizontal_line`. */
  shape: string;
  points: ShapePoint[];
  options: {
    shape: string;
    lock?: boolean;
    disableSelection?: boolean;
    disableSave?: boolean;
    text?: string;
    overrides: Record<string, string | number | boolean>;
  };
  /** Our own label for this shape, recorded locally so `clear ours` can be exact. */
  ours: { kind: string; label?: string };
}

/** Palette for drawn annotations. Deliberately the renderer's, so one level looks the same in both. */
export interface ShapeStyle {
  support: string;
  resistance: string;
  neutral: string;
  marker: string;
  zone: string;
  lineWidth: number;
}

export const DEFAULT_STYLE: ShapeStyle = {
  support: "#2ea043",
  resistance: "#f85149",
  neutral: "#58a6ff",
  marker: "#d29922",
  zone: "#8b949e",
  lineWidth: 2,
};

/**
 * How many bars of a horizontal line to draw.
 *
 * TradingView's `horizontal_line` needs an anchor time even though it extends across the chart, and
 * an anchor outside the loaded range makes the tool invisible. The caller supplies the last bar's
 * date, which is always inside the range by construction.
 */
export interface ShapeContext {
  /** `YYYY-MM-DD` of the most recent bar. Used to anchor tools that have no time of their own. */
  anchorDate: string;
  style?: Partial<ShapeStyle>;
}

function timeOf(date: string, field: string): number {
  return epochSeconds(date, field);
}

/**
 * A fib coordinate, or a refusal.
 *
 * Dates are already checked — `timeOf` runs them through `epochSeconds`, which throws on anything
 * unparseable. Prices are not, anywhere in this file, and an `undefined` price travels all the way
 * to the widget, which anchors the shape at whatever it likes. Observed on a real chart with a
 * different tool: a zone sent with the wrong field names became a zero-size rectangle at the day's
 * high, reported back as `drawn: 1` with an empty `failed`. The caller is told it drew something,
 * the user sees nothing, and the two never reconcile — worse than an error.
 *
 * Applied here because a retracement is defined ENTIRELY by its two prices: get one wrong and every
 * level below it is wrong too, quietly and plausibly. The other annotation kinds in this file are
 * still unguarded; that is a separate change.
 */
function fibPrice(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StockbitError(
      "invalid_param",
      `A fib annotation needs a finite numeric \`${field}\`, got ${JSON.stringify(value)}. Nothing was ` +
        "drawn for it — a coordinate that arrives undefined becomes a shape at an arbitrary price " +
        "rather than a visible failure.",
    );
  }
  return value;
}

/**
 * Map one annotation to a shape request.
 *
 * Throws for an annotation kind with no mapping rather than skipping it: a caller who asked for six
 * drawings and silently got five would report six.
 */
export function toShapeRequest(annotation: DrawableAnnotation, context: ShapeContext): ShapeRequest {
  const style = { ...DEFAULT_STYLE, ...(context.style ?? {}) };
  const anchor = timeOf(context.anchorDate, "anchor date");

  switch (annotation.kind) {
    case "level": {
      const color = annotation.color ?? style.neutral;
      return {
        shape: "horizontal_line",
        points: [{ time: anchor, price: annotation.price }],
        options: {
          shape: "horizontal_line",
          disableSelection: false,
          ...(annotation.label ? { text: annotation.label } : {}),
          overrides: {
            linecolor: color,
            linewidth: style.lineWidth,
            linestyle: annotation.dashed ? 2 : 0,
            showLabel: Boolean(annotation.label),
            textcolor: color,
          },
        },
        ours: { kind: "level", label: annotation.label },
      };
    }

    case "zone": {
      const color = annotation.color ?? style.zone;
      // A rectangle needs two corners: the same anchor time for both, with the two prices. A zone
      // has no time extent of its own, and inventing one would place a band over a date range the
      // caller never described.
      return {
        shape: "rectangle",
        points: [
          { time: anchor, price: annotation.from },
          { time: anchor, price: annotation.to },
        ],
        options: {
          shape: "rectangle",
          ...(annotation.label ? { text: annotation.label } : {}),
          overrides: {
            color,
            backgroundColor: color,
            fillBackground: true,
            transparency: 80,
            linewidth: 1,
          },
        },
        ours: { kind: "zone", label: annotation.label },
      };
    }

    case "trend": {
      const color = annotation.color ?? style.neutral;
      return {
        shape: "trend_line",
        points: [
          { time: timeOf(annotation.fromDate, "trend start date"), price: annotation.fromPrice },
          { time: timeOf(annotation.toDate, "trend end date"), price: annotation.toPrice },
        ],
        options: {
          shape: "trend_line",
          ...(annotation.label ? { text: annotation.label } : {}),
          overrides: {
            linecolor: color,
            linewidth: style.lineWidth,
            showLabel: Boolean(annotation.label),
            textcolor: color,
          },
        },
        ours: { kind: "trend", label: annotation.label },
      };
    }

    case "marker": {
      const color = annotation.color ?? style.marker;
      // `above` decides which arrow, because an up-arrow drawn below a bar and a down-arrow drawn
      // above it both read as the opposite signal.
      const shape = annotation.price === undefined ? "text" : annotation.above ? "arrow_down" : "arrow_up";
      return {
        shape,
        points: [{ time: timeOf(annotation.date, "marker date"), ...(annotation.price === undefined ? {} : { price: annotation.price }) }],
        options: {
          shape,
          text: annotation.label,
          overrides: { color, textcolor: color, fontsize: 12 },
        },
        ours: { kind: "marker", label: annotation.label },
      };
    }

    case "channel": {
      const color = annotation.color ?? style.neutral;
      const from = timeOf(annotation.fromDate, "channel start date");
      const to = timeOf(annotation.toDate, "channel end date");
      // A parallel channel takes THREE points: the two ends of the first line, then one point on the
      // parallel. The third is the offset applied to the second end.
      return {
        shape: "parallel_channel",
        points: [
          { time: from, price: annotation.fromPrice },
          { time: to, price: annotation.toPrice },
          { time: to, price: annotation.toPrice + annotation.offset },
        ],
        options: {
          shape: "parallel_channel",
          ...(annotation.label ? { text: annotation.label } : {}),
          overrides: { linecolor: color, linewidth: style.lineWidth, fillBackground: true, transparency: 90 },
        },
        ours: { kind: "channel", label: annotation.label },
      };
    }

    case "fib": {
      const color = annotation.color ?? style.neutral;
      // Two points, so this goes through `createMultipointShape` — the same path as a trend line.
      // The levels are the tool's own; nothing here computes 0.618.
      return {
        shape: "fib_retracement",
        points: [
          { time: timeOf(annotation.fromDate, "fib start date"), price: fibPrice(annotation.fromPrice, "fromPrice") },
          { time: timeOf(annotation.toDate, "fib end date"), price: fibPrice(annotation.toPrice, "toPrice") },
        ],
        options: {
          shape: "fib_retracement",
          // NO `text`. Measured against Stockbit's TradingView v29.6 by probing the live widget:
          // `createMultipointShape` with a `text` property on this tool throws "Value is undefined"
          // and draws nothing, while the identical call without it succeeds. Every other tool here
          // takes `text` happily, which is exactly why this needs saying — it looks like an omission.
          //
          // The label is not lost: it is kept in `ours` below, which is what `chartbit_clear
          // scope:"ours"` matches on. And a retracement labels its own levels with ratio and price,
          // so a title on top of that adds little.
          overrides: {
            linecolor: color,
            linewidth: 1,
            // The prices matter more than the ratios when reading a retracement against real support
            // levels, and the tool hides them by default.
            showCoeffs: true,
            showPrices: true,
            textcolor: color,
          },
        },
        ours: { kind: "fib", label: annotation.label },
      };
    }

    case "vline": {
      const color = annotation.color ?? style.marker;
      return {
        shape: "vertical_line",
        points: [{ time: timeOf(annotation.date, "vertical line date") }],
        options: {
          shape: "vertical_line",
          ...(annotation.label ? { text: annotation.label } : {}),
          overrides: { linecolor: color, linewidth: 1, showLabel: Boolean(annotation.label), textcolor: color },
        },
        ours: { kind: "vline", label: annotation.label },
      };
    }

    default: {
      const kind = (annotation as { kind?: unknown }).kind;
      throw new StockbitError(
        "invalid_param",
        `No chart tool is mapped for annotation kind ${JSON.stringify(kind)}, so it was not drawn. ` +
          "Nothing was skipped silently.",
      );
    }
  }
}

/** Map a whole set. Order is preserved so a caller can correlate results to inputs by index. */
export function toShapeRequests(annotations: DrawableAnnotation[], context: ShapeContext): ShapeRequest[] {
  return annotations.map((annotation) => toShapeRequest(annotation, context));
}

/**
 * The studies the driver will add, by friendly name.
 *
 * A closed list rather than a free string: `createStudy` takes a name that goes straight into the
 * charting library, and the failure for an unknown one is a silent no-op. A caller asking for
 * "Bolinger Bands" would be told it worked.
 */
export const STUDIES = {
  rsi: "Relative Strength Index",
  macd: "MACD",
  atr: "Average True Range",
  bollinger: "Bollinger Bands",
  ema: "Moving Average Exponential",
  sma: "Moving Average",
  volume: "Volume",
  stochastic: "Stochastic",
} as const;

export type StudyName = keyof typeof STUDIES;

export const STUDY_NAMES = Object.keys(STUDIES) as StudyName[];

/** Resolve a friendly study name to the library's, refusing anything not on the list. */
export function studyRequest(name: string, inputs: Array<string | number> = []): { name: string; inputs: Array<string | number> } {
  if (!(name in STUDIES)) {
    throw new StockbitError(
      "invalid_param",
      `Unknown study ${JSON.stringify(name)}. Available: ${STUDY_NAMES.join(", ")}. ` +
        "An unrecognised name is a silent no-op in the charting library, so it is refused here instead.",
    );
  }
  return { name: STUDIES[name as StudyName], inputs };
}
