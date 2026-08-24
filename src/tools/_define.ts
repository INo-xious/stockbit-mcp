/**
 * How a tool gets registered — and, more importantly, what registering it as a *write* means.
 *
 * ## The hole this closes
 *
 * `workflow_run` executes saved recipes by calling tool handlers directly. It found those handlers
 * by intercepting `server.tool`, which meant **every** registered tool was reachable from a recipe.
 * With reads that is exactly right: a recipe is a sequence of readings. With a write it is not. A
 * recipe is data — a name, a list of steps — and data must never be able to place an order, empty a
 * watchlist, or overwrite a chart. Before this module the only thing standing between a recipe and
 * `order_buy` was that no such tool existed yet.
 *
 * So the two are registered through different doors. `read()` registers the tool *and* adds it to
 * the handler map. `write()` registers the tool and **never** touches the map. That is enforced by
 * construction rather than by a list someone must remember to update, and `test/tools.test.ts`
 * asserts the map holds no write tool.
 *
 * ## Families
 *
 * A family is one registration module, which is one section of the Stockbit UI. It is not a
 * decoration: it is what `STOCKBIT_TOOLS` filters on, what `docs/TOOLS.md` groups by, and what a
 * client with a tool-count cap selects with. `define.family("market")` returns a child definer that
 * shares this one's handler map and write list but stamps its own family onto everything it
 * registers, so a module cannot forget to say what it is.
 *
 * ## Evidence
 *
 * Every tool carries one of three words — see `CONTEXT.md`. It rides on `_meta` so a client, the
 * generated reference and a reviewer all read the same value rather than three drifting copies.
 *
 * The default is **derived from the description**, because the description is where the fact
 * already lives: dozens of tools say "PENDING VERIFICATION: this route has not been observed live"
 * and a second, hand-maintained flag saying the same thing would be a second thing to forget. An
 * explicit `evidence` still wins — except that claiming a tool is Observed while its own
 * description says it has never been observed throws at registration, which is a contradiction
 * nobody should be able to ship.
 *
 * ## Annotations
 *
 * MCP's `ToolAnnotations` are hints to the client, not a security boundary — the SDK says so and
 * this project agrees; the boundary is the transport's route table and the confirmation gates. They
 * are still worth getting right, because a client that surfaces "this tool modifies your account"
 * before the call is one more place the user can say no.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape, ZodTypeAny, objectOutputType } from "zod";

/**
 * One registration module = one section of the Stockbit UI.
 *
 * `system` is the exception: `status`, `login` and `logout` are how a user finds out what is wrong,
 * so they are never filtered out of a profile.
 */
export const FAMILIES = [
  "system",
  "market",
  "bandarmology",
  "analysis",
  "company",
  "fundamentals",
  "insider",
  "corpaction",
  "stream",
  "screener",
  "account",
  "chartbit",
  "alerts",
  "pine",
  "workflows",
  "trading",
  "eipo",
] as const;
export type Family = (typeof FAMILIES)[number];

/** How a tool's field mapping is known. Defined once in `CONTEXT.md`; this is the machine copy. */
export type Evidence = "observed" | "read-back" | "projected";

/** `_meta` keys. Namespaced because `_meta` is shared with the client and the SDK. */
export const FAMILY_META_KEY = "stockbit-mcp/family";
export const EVIDENCE_META_KEY = "stockbit-mcp/evidence";

/**
 * A description that says, in this project's own words, that nobody has seen this route answer.
 *
 * Kept broad on purpose: the phrasing varies across modules ("PENDING VERIFICATION", "Pending
 * verification", "PENDING:", "has not been observed live"), and a marker that only matched one
 * spelling would silently let the others through as Observed.
 */
const NEVER_OBSERVED = /PENDING[ _]?VERIFICATION|PENDING:|(has|have) not been observed/i;

/** What a registered handler looks like once the schema has been applied and the type forgotten. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** The handler a caller writes: its argument is typed from the shape, exactly as the SDK types it. */
export type TypedHandler<S extends ZodRawShape> = (
  args: objectOutputType<S, ZodTypeAny>,
) => Promise<unknown>;

/** Per-tool overrides. `evidence` overrides the family default; the rest are MCP annotations. */
export interface ToolOptions extends ToolAnnotations {
  evidence?: Evidence;
}

/**
 * Which families and tools a server instance registers.
 *
 * Structural on purpose so `_profile.ts` can own the parsing without this module importing it —
 * registration must not depend on configuration.
 */
export interface ToolProfile {
  /** What to call this profile in an error message or in `status`. */
  label: string;
  allows(family: Family, name: string): boolean;
}

/** One registered tool, as the surface recorder and the doc generator see it. */
export interface ToolRecord {
  name: string;
  family: Family;
  evidence: Evidence;
  kind: "read" | "write";
  description: string;
  annotations: ToolAnnotations;
  inputs: { name: string; required: boolean }[];
}

export interface Definer {
  /** The family everything registered through this definer belongs to. */
  readonly familyName: Family;

  /** A child definer for one family, sharing this one's handler map, write list and skip list. */
  family(name: Family, options?: { evidence?: Evidence }): Definer;

  /** A tool that only reads. Registered, and reachable from `workflow_run`. */
  read<S extends ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: TypedHandler<S>,
    options?: { evidence?: Evidence },
  ): void;

  /**
   * A tool that changes something. Registered, and deliberately NOT reachable from `workflow_run`.
   *
   * `options` overrides the annotation defaults per tool: an order is destructive and
   * non-idempotent, a watchlist add is neither, and a Chartbit drawing is reversible in the user's
   * own UI. Saying so accurately is the point — marking everything destructive teaches a client to
   * ignore the flag.
   */
  write<S extends ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: TypedHandler<S>,
    options?: ToolOptions,
  ): void;

  /** The names registered as writes, for the guard test and for the instructions. */
  writeNames(): string[];

  /** Every name actually registered, in registration order. */
  names(): string[];

  /** Names a profile kept out. Empty when the profile is `all`. */
  skippedNames(): string[];

  /** The same, with the family each one would have belonged to, so a refusal can say what to enable. */
  skipped(): { name: string; family: Family }[];

  /** Everything registered, with its family, evidence and shape. Feeds `docs/TOOLS.md`. */
  records(): ToolRecord[];

  /**
   * Ask the human directly, when the client can.
   *
   * MCP elicitation is the only channel in this protocol that reaches a person rather than a model.
   * For an order that matters: `confirm: true` says a model decided the user agreed, and this says
   * the user themselves clicked yes. Both are required — this is an additional gate, never a
   * replacement for the confirmation the caller passes.
   *
   * Optional so a caller can be constructed without one (tests build a Definer by hand), and it
   * answers "unavailable" rather than throwing when the client advertises no elicitation support,
   * because a client that cannot ask must not become a client that cannot trade.
   */
  elicit?(
    message: string,
    prompt?: { title?: string; description?: string },
  ): Promise<"accepted" | "declined" | "unavailable">;
}

/** Everything the definers of one server share. */
interface Shared {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
  writes: string[];
  registered: string[];
  skipped: { name: string; family: Family }[];
  records: ToolRecord[];
  profile?: ToolProfile;
}

/**
 * Build the read/write registration pair for one server.
 *
 * `handlers` is the same map `workflow_run` looks names up in; passing it in rather than owning it
 * keeps the workflow engine's view and this module's decision about what belongs in it in one
 * place — the `read`/`write` call itself.
 */
export function makeDefiner(
  server: McpServer,
  handlers: Map<string, ToolHandler>,
  options: { profile?: ToolProfile } = {},
): Definer {
  const shared: Shared = {
    server,
    handlers,
    writes: [],
    registered: [],
    skipped: [],
    records: [],
    profile: options.profile,
  };
  return makeScoped(shared, "system", undefined);
}

function makeScoped(shared: Shared, familyName: Family, familyEvidence: Evidence | undefined): Definer {
  const resolveEvidence = (name: string, description: string, explicit?: Evidence): Evidence => {
    const looksUnobserved = NEVER_OBSERVED.test(description);
    if (explicit) {
      if (looksUnobserved && explicit !== "projected") {
        throw new Error(
          `Tool ${JSON.stringify(name)} is declared evidence "${explicit}" but its own description ` +
            `says it has not been observed live. One of the two is wrong.`,
        );
      }
      return explicit;
    }
    if (looksUnobserved) return "projected";
    return familyEvidence ?? "observed";
  };

  const shapeInputs = (shape: ZodRawShape): ToolRecord["inputs"] =>
    Object.entries(shape).map(([name, schema]) => ({
      name,
      required: !(schema as { isOptional?: () => boolean }).isOptional?.(),
    }));

  const register = (
    kind: "read" | "write",
    name: string,
    description: string,
    shape: ZodRawShape,
    handler: ToolHandler,
    annotations: ToolAnnotations,
    evidence: Evidence,
  ): boolean => {
    // `system` is never skippable: it is how a user finds out why everything else is missing.
    if (familyName !== "system" && shared.profile && !shared.profile.allows(familyName, name)) {
      shared.skipped.push({ name, family: familyName });
      return false;
    }
    shared.server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations,
        _meta: { [FAMILY_META_KEY]: familyName, [EVIDENCE_META_KEY]: evidence },
      },
      handler as never,
    );
    shared.registered.push(name);
    shared.records.push({
      name,
      family: familyName,
      evidence,
      kind,
      description,
      annotations,
      inputs: shapeInputs(shape),
    });
    return true;
  };

  return {
    familyName,

    family(name, options) {
      return makeScoped(shared, name, options?.evidence);
    },

    read(name, description, shape, handler, options) {
      const evidence = resolveEvidence(name, description, options?.evidence);
      const registered = register(
        "read",
        name,
        description,
        shape,
        handler as ToolHandler,
        {
          readOnlyHint: true,
          destructiveHint: false,
          // Every read here goes to Stockbit's API, whose responses are not enumerable in advance.
          openWorldHint: true,
        },
        evidence,
      );
      if (registered) shared.handlers.set(name, handler as ToolHandler);
    },

    write(name, description, shape, handler, options) {
      const { evidence: explicit, ...annotations } = options ?? {};
      const evidence = resolveEvidence(name, description, explicit);
      const registered = register(
        "write",
        name,
        description,
        shape,
        handler as ToolHandler,
        {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          ...annotations,
        },
        evidence,
      );
      if (registered) shared.writes.push(name);
      // Deliberately no `handlers.set`. See the module note: this is the whole mechanism.
    },

    writeNames() {
      return [...shared.writes].sort();
    },

    names() {
      return [...shared.registered];
    },

    skippedNames() {
      return shared.skipped.map((s) => s.name);
    },

    skipped() {
      return [...shared.skipped];
    },

    records() {
      return [...shared.records];
    },

    async elicit(message, prompt) {
      const inner = (shared.server as unknown as { server?: ElicitCapableServer }).server;
      if (!inner?.getClientCapabilities?.()?.elicitation || !inner.elicitInput) return "unavailable";
      try {
        const result = await inner.elicitInput({
          message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: prompt?.title ?? "Place this order?",
                description: prompt?.description ?? "Yes places it on the exchange. There is no undo.",
              },
            },
            required: ["confirm"],
          },
        });
        // Anything short of an explicit yes is a no. A cancelled dialog is not an agreement, and
        // neither is an accept whose content did not actually carry the box being ticked.
        return result.action === "accept" && result.content?.confirm === true ? "accepted" : "declined";
      } catch {
        // The client claimed the capability and then failed to answer. Treating that as consent
        // would be the worst reading of it.
        return "unavailable";
      }
    },
  };
}

/** The slice of the low-level server this module uses, so the SDK's shape is named in one place. */
interface ElicitCapableServer {
  getClientCapabilities?(): { elicitation?: unknown } | undefined;
  elicitInput?(params: {
    message: string;
    requestedSchema: Record<string, unknown>;
  }): Promise<{ action: string; content?: Record<string, unknown> }>;
}
