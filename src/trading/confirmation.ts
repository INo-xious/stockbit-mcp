/**
 * Local paper-simulation consent. Ask through MCP elicitation before considering
 * the caller's confirm boolean; a declined dialog always refuses. ADR-0010/0012.
 * No setting can automatically confirm an order. A person may explicitly grant
 * a short-lived waiver for subsequent local simulations of equal or lower value.
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
  /** `confirm: true`, and the client advertises no way to ask a person. */
  | "explicit-unelicited"
  /** `confirm: true`, and the account owner turned asking off themselves. */
  | "explicit-elicit-disabled";

/** What happened on the human channel, in the words the result and the log both use. */
export type ElicitationOutcome =
  | "accepted"
  | "remembered"
  | "unavailable"
  | "disabled-by-policy";

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
  noun: "order";
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
   * Only a NEW local paper buy or sell is waivable. A cancel and an amend modify
   * an existing paper order, so they always require their own confirmation.
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

/** The calling model must relay the summary and obtain consent. */
function noConfirmation(): never {
  refuse(
    "Refusing to record a paper order without confirmation. Show the user the ticket's `summary`, " +
    "in words, and pass confirm: true only after they agree to THAT order. Do not set it on their behalf.",
  );
}

/** The dialog always identifies the operation as a local simulation. */
function promptFor(
  policy: TradingPolicy,
  waivable: boolean,
  valueIdr: number | null,
): { title: string; description: string; remember?: string } {
  const base = {
    title: "Place this PAPER order?",
    description: "Yes records it in a local ledger on this machine. No real money moves.",
  };

  // Never offered when the owner demanded the ask: a switch that says "always ask me" must not come
  // with a box that turns itself off. And never on a commitment a grant may not cover, because a box
  // that does nothing is worse than no box — the person believes they have answered for next time.
  //
  // `valueIdr === null` is part of that same rule and not a separate one: a grant is "each order up
  // to X rupiah", so with no X there is nothing to cap it at and `grantRemember` would refuse to
  // record anything. Reachable on a waivable commitment — `paper_order_preview action=buy` with no
  // `price` yields a null gross — so it has to be checked here rather than assumed away.
  if (policy.elicitation === "required" || !waivable || valueIdr === null) return base;
  return {
    ...base,
    // "each" rather than "orders up to": the grant has no cumulative budget, so a person reading
    // this must not take it to mean a total. It covers any number of orders, each within the cap.
    remember: `Don't ask again for ${REMEMBER_TTL_MS / 60_000} minutes — each new order this size or smaller`,
  };
}

/** Ask first; caller confirmation is considered only when no human can be reached. */
export async function resolveConfirmation(req: ConfirmationRequest): Promise<ConfirmationVerdict> {
  const { policy, noun, valueIdr } = req;

  // Caps apply to every simulated order and are re-read after preview.
  if (policy.maxOrderValueIdr !== null && valueIdr !== null && valueIdr > policy.maxOrderValueIdr) {
    refuse(`This paper order is ${idr(valueIdr)} and the per-order cap is now ${idr(policy.maxOrderValueIdr)}. ` +
      "The cap changed after this ticket was priced. Nothing was recorded. Run paper_order_preview again.");
  }

  // A grant the human made themselves, still inside its time, its value and its policy — and
  //    only on the kind of commitment they were actually shown. See `waivable`.
  if (req.waivable && policy.elicitation !== "required" && rememberCovers(policy, valueIdr)) {
    return { via: "remembered", elicitation: "remembered", rememberRequested: false };
  }

  // The owner turned the human channel off. `confirm` is then the only gate there is, and it has
  //    to actually be passed.
  if (policy.elicitation === "never") {
    if (req.confirm !== true) noConfirmation();
    return { via: "explicit-elicit-disabled", elicitation: "disabled-by-policy", rememberRequested: false };
  }

  // Ask. Always. This line is the fix.
  if (req.elicit) {
    const prompt = promptFor(policy, req.waivable, valueIdr);
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

  // Nobody can be asked.
  if (policy.elicitation === "required") {
    refuse(
      "This account requires that a person is asked directly before a paper order is recorded, and this client cannot ask — it advertises no MCP elicitation support. Nothing was sent. " +
        "Use a client that supports elicitation, or run `stockbit-auth trading-enable " +
        "--paper --elicitation when-available` at your own terminal to allow confirm: true where a person cannot be " +
        "reached.",
    );
  }
  if (req.confirm !== true) noConfirmation();
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
        "`stockbit-auth trading-enable --paper --elicitation required` makes this refuse instead."
      );
    case "disabled-by-policy":
      return (
        "No human was asked directly: this account has `trading.elicitation` set to `never`, so " +
        "`confirm: true` was the only gate. `stockbit-auth trading-enable --paper --elicitation when-available` " +
        "turns asking back on."
      );
    case "remembered":
      return (
        "The user was not asked about this one: they ticked \"don't ask again\" on an earlier " +
        `${REMEMBER_TTL_MS / 60_000}-minute grant covering this value or less. \`trading_forget\` ends it.`
      );
    default:
      return null;
  }
}
