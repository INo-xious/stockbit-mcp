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
 * ## Annotations
 *
 * MCP's `ToolAnnotations` are hints to the client, not a security boundary — the SDK says so and
 * this project agrees; the boundary is the transport's route table and the confirmation gates. They
 * are still worth getting right, because a client that surfaces "this tool modifies your account"
 * before the call is one more place the user can say no.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

/** What a registered handler looks like once the schema has been applied. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface Definer {
  /**
   * A tool that only reads. Registered, and reachable from `workflow_run`.
   */
  read(name: string, description: string, shape: ZodRawShape, handler: ToolHandler): void;
  /**
   * A tool that changes something. Registered, and deliberately NOT reachable from `workflow_run`.
   *
   * `annotations` overrides the defaults below per tool: an order is destructive and
   * non-idempotent, a watchlist add is neither, and a Chartbit drawing is reversible in the user's
   * own UI. Saying so accurately is the point — marking everything destructive teaches a client to
   * ignore the flag.
   */
  write(
    name: string,
    description: string,
    shape: ZodRawShape,
    handler: ToolHandler,
    annotations?: ToolAnnotations,
  ): void;
  /** The names registered as writes, for the guard test and for `server.ts`'s instructions. */
  writeNames(): string[];
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
  elicit?(message: string): Promise<"accepted" | "declined" | "unavailable">;
}

/**
 * Build the read/write registration pair for one server.
 *
 * `handlers` is the same map `workflow_run` looks names up in; passing it in rather than owning it
 * keeps the workflow engine's view and this module's decision about what belongs in it in one
 * place — the `read`/`write` call itself.
 */
export function makeDefiner(server: McpServer, handlers: Map<string, ToolHandler>): Definer {
  const writes: string[] = [];

  const register = (
    name: string,
    description: string,
    shape: ZodRawShape,
    handler: ToolHandler,
    annotations: ToolAnnotations,
  ): void => {
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations },
      handler as never,
    );
  };

  return {
    read(name, description, shape, handler) {
      register(name, description, shape, handler, {
        readOnlyHint: true,
        destructiveHint: false,
        // Every read here goes to Stockbit's API, whose responses are not enumerable in advance.
        openWorldHint: true,
      });
      handlers.set(name, handler);
    },

    write(name, description, shape, handler, annotations) {
      register(name, description, shape, handler, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        ...annotations,
      });
      writes.push(name);
      // Deliberately no `handlers.set`. See the module note: this is the whole mechanism.
    },

    writeNames() {
      return [...writes].sort();
    },

    async elicit(message: string) {
      const inner = (server as unknown as { server?: ElicitCapableServer }).server;
      if (!inner?.getClientCapabilities?.()?.elicitation || !inner.elicitInput) return "unavailable";
      try {
        const result = await inner.elicitInput({
          message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Place this order?",
                description: "Yes places it on the exchange. There is no undo.",
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
