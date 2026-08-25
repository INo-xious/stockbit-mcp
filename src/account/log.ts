/**
 * The audit trail for account edits, and the lock that keeps two of them apart. ADR-0006.
 *
 * A separate file from `order-mutations.log` because these are separate questions. "What did this
 * server do to my money" and "what did this server do to my lists" are asked at different times and
 * by different people, and interleaving them makes the first one harder to read — which is the one
 * that matters when something has gone wrong.
 *
 * The apparatus is ADR-0003's, unchanged: read before, write, read after, and report what the
 * read-back actually showed rather than what the status code implied. What is missing here is the
 * rollback, and deliberately so — see `verifiedWrite`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactValue } from "../redact.js";
import { acquireDirLock } from "../util/dirlock.js";
import { StockbitError } from "../http/errors.js";
import { stockbitDir } from "../paths.js";

/** Where every account edit is recorded, whatever its outcome. */
export function accountLogPath(): string {
  return join(stockbitDir(), "account-mutations.log");
}

/** A lock older than this belongs to a process that died mid-edit. */
export const ACCOUNT_LOCK_STALE_MS = 30_000;

/**
 * One append-only line per attempt. Returns whether it was written.
 *
 * A failed log never masks the edit it describes, but it is reported: advertising an audit trail
 * that does not exist is worse than having none.
 */
export function logAccountMutation(entry: Record<string, unknown>): boolean {
  try {
    mkdirSync(stockbitDir(), { recursive: true });
    appendFileSync(accountLogPath(), `${JSON.stringify(redactValue(entry))}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export type AccountOutcome = "ok" | "not-visible" | "landed-despite-error" | "outcome-unknown" | "write-failed";

export interface AccountResult<T> {
  target: string;
  action: string;
  outcome: AccountOutcome;
  /** True only when the read-back actually showed the intended state. */
  verified: boolean;
  /** Present when the state could not be established. Relay it verbatim. */
  outcomeUnknown?: string;
  error?: string;
  /** Whatever the caller's verification produced — the new id, the resulting list, a count. */
  detail?: T;
  logged: boolean;
  logPath: string;
  at: string;
}

export interface VerifiedWriteOptions<T> {
  /** For the log and the result. `watchlist_add`, `screener_delete`, … */
  action: string;
  /** What is being changed, in words a user would recognise. */
  target: string;
  /** Serialises edits to the same target across processes. */
  lockKey: string;
  /** The request. */
  write: () => Promise<unknown>;
  /**
   * Read the account back and say whether it now holds what was intended.
   *
   * Returning `{ verified: false }` is a real answer — the write did not take — and is different
   * from throwing, which means the read-back itself failed and nothing can be concluded.
   */
  verify: () => Promise<{ verified: boolean; detail?: T }>;
  /** Dropped from the cache after the write, before the verification reads anything. */
  invalidate?: () => void;
}

/**
 * Write, then look.
 *
 * ## Why there is no rollback here
 *
 * ADR-0003's chart save restores its snapshot when the read-back disagrees. That is right for a
 * blob the user cannot reconstruct. It is wrong for these: undoing a failed `watchlist_add` means
 * sending a delete, on a guess, about a state we just said we could not read — and if the add
 * actually worked, that delete is the destructive operation. Every edit here is one action a person
 * can reverse in the Stockbit app in seconds. So this reports, and stops.
 *
 * Throws only before the request. Afterwards it returns a description, including "we do not know".
 */
export async function verifiedWrite<T>(options: VerifiedWriteOptions<T>): Promise<AccountResult<T>> {
  const at = new Date().toISOString();
  const base = { action: options.action, target: options.target, logPath: accountLogPath(), at };

  const release = await acquireDirLock(join(stockbitDir(), `account-${options.lockKey}.lock`), {
    staleMs: ACCOUNT_LOCK_STALE_MS,
    timeoutMs: 5_000,
  });
  if (!release) {
    logAccountMutation({ ...base, outcome: "refused-lock" });
    throw new StockbitError(
      "invalid_param",
      `Another edit to ${options.target} is in flight in this or another process. Nothing was sent — try again.`,
    );
  }

  try {
    let writeError: Error | null = null;
    try {
      await options.write();
    } catch (err) {
      writeError = err instanceof Error ? err : new Error(String(err));
    }

    options.invalidate?.();

    let verified = false;
    let detail: T | undefined;
    let verifyError: string | undefined;
    try {
      const result = await options.verify();
      verified = result.verified;
      detail = result.detail;
    } catch (err) {
      verifyError = err instanceof Error ? err.message : String(err);
    }

    const finish = (
      outcome: AccountOutcome,
      ok: boolean,
      extra: { outcomeUnknown?: string; error?: string } = {},
    ): AccountResult<T> => {
      const logged = logAccountMutation({ ...base, outcome, verified: ok, ...extra });
      return {
        ...base,
        outcome,
        verified: ok,
        ...(detail === undefined ? {} : { detail }),
        ...extra,
        logged,
      };
    };

    if (writeError) {
      const message = writeError.message;
      const status = writeError instanceof StockbitError ? writeError.status : undefined;
      if (verified) {
        return finish("landed-despite-error", true, {
          error: message,
          outcomeUnknown:
            `The request errored (${message}) but the change IS there. It was not retried; check before ` +
            "sending it again.",
        });
      }
      if (verifyError) {
        return finish("outcome-unknown", false, {
          error: message,
          outcomeUnknown:
            `The request errored (${message}) AND the account could not be read back (${verifyError}), so ` +
            "whether it took effect is unknown. Look in the Stockbit app before retrying.",
        });
      }
      return finish(status !== undefined && status >= 400 && status < 500 ? "write-failed" : "not-visible", false, {
        error: message,
      });
    }

    if (verifyError) {
      return finish("outcome-unknown", false, {
        error: verifyError,
        outcomeUnknown:
          `The request succeeded but the account could not be read back (${verifyError}), so the change is ` +
          "unconfirmed. Check in the Stockbit app rather than repeating it.",
      });
    }

    if (verified) return finish("ok", true);
    return finish("not-visible", false, {
      outcomeUnknown:
        "The request was accepted but reading the account back does not show the change. Do not repeat it " +
        "blindly — read the list again first.",
    });
  } finally {
    release();
  }
}
