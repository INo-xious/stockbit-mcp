/**
 * "Don't ask again" — a grant the human makes for themselves, and nothing else can make for them.
 *
 * ## Why this exists at all
 *
 * Asking a person before every order is the point of ADR-0010, and asking them about the fourth
 * order in a row they are placing deliberately is how a dialog becomes a thing people click through
 * without reading. A confirmation nobody reads is worse than no confirmation, because it still
 * produces the record that says they agreed.
 *
 * So the ask can be waived — but only by the person doing the asking, only by ticking a second box
 * in the dialog they were already reading, and only inside four bounds that all have to hold at
 * once:
 *
 *  1. **Time.** Fifteen minutes. Long enough for a sitting; short enough that it cannot follow
 *     someone into tomorrow.
 *  2. **Value.** The order they actually approved. They agreed to spend X rupiah, so the grant
 *     covers orders up to X and not a rupiah more. Self-limiting, and it needs no new setting —
 *     it mirrors `src/settings.ts`'s existing rule that a waiver must be capped.
 *  3. **The policy.** A fingerprint of the trading policy in force when it was granted. Change the
 *     mode, the caps, the symbol list or the elicitation switch and every outstanding grant dies,
 *     because it was made against a different set of rules.
 *  4. **Revocation.** `trading.confirmationsRevokedAt` in the settings file. The CLI cannot reach a
 *     running server's memory, but every order re-reads the policy, so a `stockbit-auth
 *     trading-forget` at a terminal drops every grant made before that moment — including grants
 *     held by server processes that were already running.
 *
 * ## When a grant is created
 *
 * By the CALLER, after the ticket has been spent and its fingerprint rechecked — never by the gate
 * that asked the question. The gate runs against a peeked ticket so that a refusal costs the user
 * nothing, which means it must not leave anything behind either. An earlier draft granted inside the
 * gate, and every refusal that happens after it — an expired ticket, failed checks, a fingerprint
 * mismatch — left a live fifteen-minute waiver behind for an order that never happened. The trigger
 * was not exotic: the dialog runs at human speed and a ticket lasts two minutes, so a person who
 * read the summary properly could watch their order be refused and have silently turned off their
 * own confirmations in the process.
 *
 * ## In memory, and never on disk
 *
 * Two reasons, and either alone would be enough. A grant that survived a restart would outlive the
 * conversation that produced it, and the person who ticked the box was agreeing to something inside
 * that conversation. And writing it would mean this module editing the settings file — which the
 * modules under `src/trading/` are forbidden to do, on purpose, by an invariant with a test behind
 * it. A server that can widen its own permissions has no permissions.
 *
 * ## What a grant may cover, and why this module does not decide it
 *
 * Only a NEW buy or sell. Not an amend, not a cancel, not an e-IPO subscription. That bound is
 * `ConfirmationRequest.waivable`, stated by the caller in `src/trading/confirmation.ts`, and it is
 * stated rather than inferred on purpose: an earlier draft inferred it here from `valueIdr === null`
 * on the reasoning that a cancel and an amend carry no gross value, and that was simply false of an
 * amend — its ticket resolves price and lots from the working order, so its gross is a real number.
 * Every amend was therefore waived by a box ticked on a buy. A bound that depends on a field
 * happening to be null somewhere else is not a bound.
 *
 * The `valueIdr === null` check below survives as a second guard, not as the reason: a grant is
 * "orders up to X rupiah", which says nothing about an instruction whose value is not a number.
 *
 * ## What a grant does NOT bound
 *
 * There is no cumulative budget, no symbol list and no side. After one approved buy of X, any number
 * of new orders each worth X or less proceed unasked until the grant expires — including sells, and
 * including symbols never mentioned. That is what "each new order this size or smaller" on the box
 * says, and the fifteen minutes is what bounds the total.
 */
import type { TradingPolicy } from "../settings.js";
import { now } from "./tickets.js";

/** How long a grant lives. Fifteen minutes: one sitting, not one day. */
export const REMEMBER_TTL_MS = 15 * 60_000;

export interface RememberGrant {
  /** When the human ticked the box, on the same injectable clock the tickets use. */
  grantedAt: number;
  grantedAtIso: string;
  expiresAt: number;
  /** The gross value of the order they actually approved. The grant covers nothing larger. */
  capIdr: number;
  /** Fingerprint of the policy in force when it was granted. */
  policyKey: string;
}

/**
 * At most one, because it belongs to the person rather than to a symbol or a ticket.
 *
 * A per-symbol map would be a set of standing permissions with no single place to look at what is
 * outstanding, and "which of my don't-ask-agains are still live" is exactly the question a person
 * needs answered in one line by `status`.
 */
let grant: RememberGrant | null = null;

/**
 * What the grant was made against.
 *
 * Every field that could make an order more permissive than it was at the moment of the tick, and
 * nothing else. Not a hash: it never leaves the process, comparing strings is the whole use, and a
 * readable value is one a person debugging this can look at. `confirmationsRevokedAt` is
 * deliberately NOT in here — it is checked separately in `rememberCovers`, so that a revocation
 * reads as a revocation rather than as an incidental fingerprint change.
 */
function policyKey(policy: TradingPolicy): string {
  return JSON.stringify([
    policy.mode,
    policy.autoConfirm,
    policy.maxOrderValueIdr,
    policy.maxLotsPerOrder,
    [...policy.allowedSymbols].sort(),
    policy.elicitation,
  ]);
}

/** Record a grant the human just made. Overwrites any earlier one — the newest tick is the answer. */
export function grantRemember(policy: TradingPolicy, valueIdr: number): void {
  const at = now();
  grant = {
    grantedAt: at,
    grantedAtIso: new Date(at).toISOString(),
    expiresAt: at + REMEMBER_TTL_MS,
    capIdr: valueIdr,
    policyKey: policyKey(policy),
  };
}

/**
 * Does an outstanding grant cover THIS commitment?
 *
 * Every branch below returns false, and each is a separate `if` rather than one boolean chain
 * because a reader has to be able to see that "no grant" and "the policy moved" are different
 * facts that happen to have the same answer.
 *
 * Whether the commitment is the KIND a grant may cover is decided before this is called — see
 * `ConfirmationRequest.waivable`. This answers only "is there a live grant, and does it reach this
 * far".
 */
export function rememberCovers(policy: TradingPolicy, valueIdr: number | null): boolean {
  if (!grant) return false;
  // Not a number, so "up to X rupiah" cannot be said to cover it. A second guard behind `waivable`,
  // never the reason on its own — see the module note.
  if (valueIdr === null) return false;
  if (now() >= grant.expiresAt) return false;
  if (grant.policyKey !== policyKey(policy)) return false;
  if (valueIdr > grant.capIdr) return false;

  const revoked = policy.confirmationsRevokedAt;
  if (revoked !== null) {
    const revokedAt = Date.parse(revoked);
    // An unreadable timestamp is treated as a revocation rather than as an absent one. Somebody
    // wrote something into that field, and the safe reading of an intention that cannot be parsed
    // is the one that asks the human again.
    if (!Number.isFinite(revokedAt) || grant.grantedAt <= revokedAt) return false;
  }
  return true;
}

/** Drop the grant. `trading_forget`, and the tests. */
export function forgetRemember(): void {
  grant = null;
}

/**
 * What `status` says when someone asks "will I be asked?".
 *
 * `active` answers that question and not a narrower one, so it accounts for expiry AND — when a
 * policy is passed — for the policy having moved since. `stale` distinguishes "there is no grant"
 * from "there is one and it no longer applies", because those lead a user to different places.
 */
export function describeRemember(policy?: TradingPolicy): {
  active: boolean;
  expiresAt?: string;
  capIdr?: number;
  stale?: true;
} {
  if (!grant) return { active: false };
  if (now() >= grant.expiresAt) return { active: false };

  const shape = { expiresAt: new Date(grant.expiresAt).toISOString(), capIdr: grant.capIdr };
  if (policy && !rememberCovers(policy, grant.capIdr)) return { active: false, ...shape, stale: true };
  return { active: true, ...shape };
}
