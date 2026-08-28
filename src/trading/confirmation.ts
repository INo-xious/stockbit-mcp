/**
 * The one gate every commitment passes through. ADR-0004, amended by ADR-0010.
 *
 * ## What changed, and why it is the whole module
 *
 * The gate used to open like this:
 *
 * ```ts
 * let via = options.confirm === true ? "explicit" : null;
 * …
 * if (!via && options.elicit) { … }          // never reached when confirm was true
 * ```
 *
 * `confirm` is a boolean the *calling model* sets. Elicitation is the only channel in MCP that
 * reaches the *person*. Seeding the gate from the boolean and guarding the ask behind `!via` meant
 * a model could skip the human entirely by asserting that the human had already agreed — and the
 * audit log recorded `via: "explicit"` for both cases, so afterwards nothing could tell them apart.
 * The project's own SECURITY.md already classified that: "a path that satisfies a confirmation the
 * user did not give … is a vulnerability in this project, whatever else it looks like."
 *
 * So the ask now runs BEFORE the `confirm` check, not after it, and it is not behind any `via` test
 * at all. A human who has not been asked gets asked; a human who says no is obeyed whatever the
 * model said; and `confirm: true` on a client that CAN ask is no longer a way past the person.
 *
 * ADR-0004 said elicitation was "in addition to the caller's confirmation, never instead of it".
 * That sentence is superseded and the ADR carries an amendment saying so. Requiring the model's
 * boolean *as well* as a human's click adds nothing — the human already clicked — while training
 * every model to send `confirm: true` unconditionally, which is the only gate left on clients that
 * cannot elicit.
 *
 * ## Why one module rather than two
 *
 * This logic existed twice, in `src/trading/orders.ts` and `src/eipo/order.ts`, and had already
 * drifted: the e-IPO copy had a shorter cap-missing message, no guard for a commitment with no
 * value, and no "Do not set it on their behalf". Two copies of a security gate is one gate and one
 * near-miss. This is the gate; both call it.
 *
 * ## Everything here throws, and nothing here sends
 *
 * Every refusal is a `StockbitError("invalid_param")` — the caller's to fix, not the server's — and
 * it is raised before any caller has built a request body. The callers keep their own ticket
 * handling around this: a ticket is peeked before the gate and spent after it, so a refusal costs
 * the user nothing but a sentence.
 */
import { StockbitError } from "../http/errors.js";
import type { TradingPolicy } from "../settings.js";
import type { ElicitDecision } from "../tools/_define.js";
import { idr } from "./preview.js";
import { rememberCovers, REMEMBER_TTL_MS } from "./remember.js";

/**
 * How the confirmation was satisfied. This is the audit log's vocabulary, and splitting it is the
 * point of the change: `"explicit"` used to mean both "a person clicked yes" and "a model said one
 * had", which is precisely the distinction an audit trail exists to preserve.
 */
export type ConfirmationSource =
  /** The human clicked yes in the dialog. The strongest thing this protocol can record. */
  | "elicited"
  /** A human-granted, in-memory "don't ask again" covered it. See `remember.ts`. */
  | "remembered"
  /** The account owner's capped `autoConfirm` policy, set at a terminal. */
  | "auto-confirm"
  /** `confirm: true`, and the client advertises no way to ask a person. */
  | "explicit-unelicited"
  /** `confirm: true`, and the account owner turned asking off themselves. */
  | "explicit-elicit-disabled";

/** What happened on the human channel, in the words the result and the log both use. */
export type ElicitationOutcome =
  | "accepted"
  | "remembered"
  | "unavailable"
  | "disabled-by-policy"
  | "waived-by-auto-confirm";

export interface ConfirmationRequest {
  /** The caller's boolean. Necessary on a client that cannot ask; never sufficient on one that can. */
  confirm?: boolean;
  /** The channel to a person. Absent means the caller has none to offer. */
  elicit?: ElicitDecision;
  policy: TradingPolicy;
  /** The ticket's `summary` — the exact words the human is shown. */
  summary: string;
  /** `grossIdr` / `amountIdr`. Null when the commitment has no gross value, as a cancel does not. */
  valueIdr: number | null;
  noun: "order" | "subscription";
  /**
   * May a standing "don't ask again" cover this, and may this dialog create one?
   *
   * **Stated by the caller, never inferred here.** An earlier draft of this module inferred it from
   * `valueIdr === null`, reasoning that a cancel and an amend carry no gross value — and that was
   * simply false of an amend, whose ticket resolves the price and lots from the working order and
   * therefore has a real gross. So an amend was silently waived by a grant a person had ticked on a
   * *buy*, which is exactly the class of thing this file exists to make impossible. A security bound
   * that depends on a field happening to be null elsewhere is not a bound.
   *
   * Only a NEW buy or sell is waivable. Not a cancel or an amend: those change something already
   * working, and "I approve orders up to X rupiah" is consent to committing that much money, not to
   * moving or withdrawing an order already on the book — `order_amend`'s own description calls an
   * amend "a real order decision and not an edit". Not an e-IPO subscription either: it is a
   * different commitment with different consequences (the allotment may be smaller than the
   * subscription, and it cannot be cancelled by selling), and the person who ticked a box on an
   * exchange order was never shown any of that.
   */
  waivable: boolean;
}

export interface ConfirmationVerdict {
  via: ConfirmationSource;
  elicitation: ElicitationOutcome;
  /**
   * The human ticked "don't ask again". **Reported, not acted on.**
   *
   * This module runs against a PEEKED ticket, on purpose: a call about to be refused must not cost
   * the user their ticket. So it must not create a durable side effect either — and an earlier draft
   * called `grantRemember` right here, which meant every refusal that happens AFTER the gate left a
   * live fifteen-minute waiver behind for an order that never happened.
   *
   * The realistic case is not exotic. The dialog runs at human speed and a ticket lasts 120
   * seconds, so a person who reads carefully loses the ticket — and used to be left with a waiver
   * for an order they watched get refused, with nothing in the refusal saying so.
   *
   * The caller creates the grant, after the ticket is spent and its fingerprint rechecked. The
   * waiver rides with the commitment.
   */
  rememberRequested: boolean;
}

function refuse(message: string): never {
  throw new StockbitError("invalid_param", message);
}

/**
 * The refusal for "nobody confirmed this".
 *
 * When `autoConfirm` was configured but is not in effect, that is the fact worth saying instead:
 * the user set a switch and it is doing nothing, and falling through to the generic sentence would
 * be correct and useless. Both wordings end at the same place — nothing was sent.
 */
function noConfirmation(policy: TradingPolicy, noun: ConfirmationRequest["noun"]): never {
  if (policy.autoConfirmIgnored) refuse(`${policy.autoConfirmIgnored} Nothing was sent.`);
  refuse(
    `Refusing to send ${noun === "order" ? "an order" : "an IPO subscription"} without confirmation. Show the ` +
      "user the ticket's `summary`, in words, and pass confirm: true only after they agree to THAT " +
      `${noun}. Do not set it on their behalf.`,
  );
}

/** The dialog an order or a subscription puts in front of a person. */
function promptFor(
  policy: TradingPolicy,
  noun: ConfirmationRequest["noun"],
  waivable: boolean,
  valueIdr: number | null,
): { title: string; description: string; remember?: string } {
  const base =
    noun === "subscription"
      ? {
          title: "Commit this IPO subscription?",
          description:
            "Yes commits money out of your RDN account. The allotment may be smaller than the " +
            "subscription, and it cannot be cancelled by selling.",
        }
      : policy.mode === "paper"
        ? {
            title: "Place this PAPER order?",
            description: "Yes records it in a local ledger on this machine. No real money moves.",
          }
        : {
            title: "Place this order?",
            description: "Yes places it on the exchange with your own money. There is no undo.",
          };

  // Never offered when the owner demanded the ask: a switch that says "always ask me" must not come
  // with a box that turns itself off. And never on a commitment a grant may not cover, because a box
  // that does nothing is worse than no box — the person believes they have answered for next time.
  //
  // `valueIdr === null` is part of that same rule and not a separate one: a grant is "each order up
  // to X rupiah", so with no X there is nothing to cap it at and `grantRemember` would refuse to
  // record anything. Reachable on a waivable commitment — `order_preview action=buy` with no
  // `price` yields a null gross — so it has to be checked here rather than assumed away.
  if (policy.elicitation === "required" || !waivable || valueIdr === null) return base;
  return {
    ...base,
    // "each" rather than "orders up to": the grant has no cumulative budget, so a person reading
    // this must not take it to mean a total. It covers any number of orders, each within the cap.
    remember: `Don't ask again for ${REMEMBER_TTL_MS / 60_000} minutes — each new order this size or smaller`,
  };
}

/**
 * Decide whether this commitment may proceed, asking a person whenever there is one to ask.
 *
 * The order of the branches below is the security property, so it is worth reading as an order
 * rather than as a set:
 *
 *  1. `autoConfirm` — the owner's deliberate, capped exception, set at a terminal. It is the only
 *     thing that skips the ask, and it is never in force in paper mode or without a value cap.
 *  2. A live "don't ask again" grant the human made for themselves, within its bounds.
 *  3. The owner having turned asking off entirely.
 *  4. **Ask the person.** Unconditional. Not behind `confirm`, not behind anything.
 *  5. Only then, with no person reachable, does `confirm: true` mean anything at all.
 */
export async function resolveConfirmation(req: ConfirmationRequest): Promise<ConfirmationVerdict> {
  const { policy, noun, valueIdr } = req;

  // 1. autoConfirm. `tradingPolicy()` already reports it as false when it is not in force — this
  //    re-checks the cap anyway, because a single guard is enough right up until somebody edits the
  //    other file, and this one is the one standing next to the money.
  if (policy.autoConfirm && policy.elicitation !== "required") {
    const cap = policy.maxOrderValueIdr;
    if (cap === null) {
      refuse(
        "autoConfirm is set but no maxOrderValueIdr is configured, so it is ignored. Pass confirm: true after " +
          "asking the user, or set a cap with `stockbit-auth trading-enable --max-order-value N`.",
      );
    }
    if (valueIdr !== null && valueIdr > cap) {
      // **Reachable, and do not delete this branch.** `maxOrderValueIdr` is both caps — autoConfirm's
      // and the preview's `value_within_cap` — so on the ordinary path a ticket over it has already
      // failed its own checks and is refused before this module is reached. But the two caps are
      // read at different MOMENTS: the check is computed at preview, this is read at the write. Lower
      // the cap in between (`trading-enable --live --max-order-value …` with a ticket outstanding)
      // and a ticket that passed its check arrives here over the new one. Falling through would then
      // return `auto-confirm` and send an order the owner's current policy forbids, unasked.
      //
      // It refuses rather than asking, because the cap is not a confirmation the person can supply:
      // an order over `maxOrderValueIdr` may not be placed at all, whoever agrees to it.
      refuse(
        `This ${noun} is ${idr(valueIdr)} and the per-order cap is now ${idr(cap)}, so it cannot be placed — ` +
          "the cap changed after this ticket was priced. Nothing was sent, and confirming will not help: the " +
          "cap is not a confirmation. Run order_preview again to see it checked against the current policy, " +
          "or raise the cap with `stockbit-auth trading-enable --max-order-value N`.",
      );
    }
    // A commitment with no gross value is not "over the cap" — it is outside what a value cap can
    // speak to at all. So autoConfirm simply does not answer for it, and it falls through to the
    // ask rather than being refused. Cancelling an order should not be harder than placing one.
    if (valueIdr !== null) return { via: "auto-confirm", elicitation: "waived-by-auto-confirm", rememberRequested: false };
  }

  // 2. A grant the human made themselves, still inside its time, its value and its policy — and
  //    only on the kind of commitment they were actually shown. See `waivable`.
  if (req.waivable && policy.elicitation !== "required" && rememberCovers(policy, valueIdr)) {
    return { via: "remembered", elicitation: "remembered", rememberRequested: false };
  }

  // 3. The owner turned the human channel off. `confirm` is then the only gate there is, and it has
  //    to actually be passed.
  if (policy.elicitation === "never") {
    if (req.confirm !== true) noConfirmation(policy, noun);
    return { via: "explicit-elicit-disabled", elicitation: "disabled-by-policy", rememberRequested: false };
  }

  // 4. Ask. Always. This line is the fix.
  if (req.elicit) {
    const prompt = promptFor(policy, noun, req.waivable, valueIdr);
    const answer = await req.elicit(req.summary, prompt);
    if (answer.answer === "declined") {
      refuse(`The user declined this ${noun} when asked directly. Nothing was sent.`);
    }
    if (answer.answer === "accepted") {
      // `prompt.remember` is re-checked rather than trusting `answer.remember` alone: a client that
      // returns a tick for a box that was never offered has not been given consent to waive
      // anything. The caller does the granting — see `rememberRequested`.
      return { via: "elicited", elicitation: "accepted", rememberRequested: answer.remember && !!prompt.remember };
    }
    // "unavailable" — the client advertised elicitation and then could not answer. Falls through to
    // the no-person branch rather than being read as either a yes or a no.
  }

  // 5. Nobody can be asked.
  if (policy.elicitation === "required") {
    refuse(
      `This account requires that a person is asked directly before ${
        noun === "order" ? "an order" : "a subscription"
      } is sent, and this client cannot ask — it advertises no MCP elicitation support. Nothing was sent. ` +
        "Use a client that supports elicitation, or run `stockbit-auth trading-enable " +
        "--elicitation when-available` at your own terminal to allow confirm: true where a person cannot be " +
        "reached.",
    );
  }
  if (req.confirm !== true) noConfirmation(policy, noun);
  return { via: "explicit-unelicited", elicitation: "unavailable", rememberRequested: false };
}

/**
 * The sentence a person needs when nobody was asked directly.
 *
 * ADR-0003's rule is that the core returns facts and the tool layer turns them into words. This is
 * the one sentence both tool layers need to agree on word for word, so it is written once here and
 * called from both — the alternative is exactly the drift this module was created to end.
 */
export function elicitationNote(outcome: ElicitationOutcome): string | null {
  switch (outcome) {
    case "unavailable":
      return (
        "No human was asked directly: this client advertises no MCP elicitation support, so the only " +
        "confirmation behind this was the `confirm: true` the caller passed. Tell the user that. " +
        "`stockbit-auth trading-enable --elicitation required` makes this refuse instead."
      );
    case "disabled-by-policy":
      return (
        "No human was asked directly: this account has `trading.elicitation` set to `never`, so " +
        "`confirm: true` was the only gate. `stockbit-auth trading-enable --elicitation when-available` " +
        "turns asking back on."
      );
    case "remembered":
      return (
        "The user was not asked about this one: they ticked \"don't ask again\" on an earlier " +
        `${REMEMBER_TTL_MS / 60_000}-minute grant covering this value or less. \`trading_forget\` ends it.`
      );
    case "waived-by-auto-confirm":
      return (
        "No human was asked: the account owner turned on `autoConfirm` at a terminal, capped by " +
        "`maxOrderValueIdr`, and this one was under the cap."
      );
    default:
      return null;
  }
}
