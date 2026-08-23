/**
 * Running one of the page scripts in the chart tab, and getting a value back.
 *
 * ## Arguments never become code
 *
 * A script from `page-scripts.ts` contains placeholder identifiers (`SHAPE_REQUEST`, `SHAPE_IDS`,
 * …). This module replaces each with the `JSON.stringify` of its value and nothing else. There is
 * no concatenation of caller text into an expression, so a symbol, a label or a colour cannot
 * become executable code in a page holding the user's live Stockbit session — which is the whole
 * reason the scripts are constants in a separate file rather than built where they are used.
 *
 * ## What comes back
 *
 * `returnByValue` so the result is plain JSON rather than a remote object handle that would have to
 * be released. `awaitPromise` because the save path resolves asynchronously. An exception in the
 * page becomes a typed error naming the page as the source — a raw CDP `exceptionDetails` blob
 * relayed to a model reads like an internal failure of this server, which sends debugging in the
 * wrong direction entirely.
 */
import type { CDP } from "../auth/cdp.js";
import { StockbitError } from "../http/errors.js";

/** How long one page call may take. Chart operations are local; a slow one means something is wrong. */
export const EVALUATE_TIMEOUT_MS = 20_000;

export interface EvaluateOptions {
  /** Values substituted into the script's placeholder identifiers, by placeholder name. */
  substitutions?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Substitute a script's placeholders with JSON literals.
 *
 * Exported so `test/chartbit.test.ts` can assert the property directly: that a hostile label ends up
 * inside a JSON string and never outside one.
 */
export function substitute(script: string, substitutions: Record<string, unknown> = {}): string {
  let out = script;
  for (const [name, value] of Object.entries(substitutions)) {
    const json = JSON.stringify(value ?? null);
    // A placeholder is a bare identifier, so the replacement is anchored on word boundaries. An
    // unbounded replace would also rewrite a longer identifier that happens to contain this one.
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), json);
  }
  return out;
}

/**
 * Evaluate a page script in one attached target.
 *
 * Throws rather than returning a failure shape: every caller here treats a page that cannot run our
 * script as fatal to the operation, and folding that into a value would make each of them re-check
 * it.
 */
export async function evaluateInPage<T = unknown>(
  cdp: CDP,
  sessionId: string,
  script: string,
  options: EvaluateOptions = {},
): Promise<T> {
  const expression = substitute(script, options.substitutions);

  let result: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  try {
    result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId,
      options.timeoutMs ?? EVALUATE_TIMEOUT_MS,
    );
  } catch (err) {
    throw new StockbitError(
      "upstream",
      `The chart page did not answer (${err instanceof Error ? err.message : String(err)}). ` +
        "It may have navigated away or been closed.",
    );
  }

  if (result?.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown error";
    throw new StockbitError("upstream", `Chart page threw: ${detail}`);
  }

  return result?.result?.value as T;
}
