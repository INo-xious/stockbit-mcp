/**
 * Minimal Chrome DevTools Protocol client over Node's built-in global WebSocket (Node 20.10+/24).
 * No dependencies — CDP is just JSON-RPC over a WebSocket. Enough to drive a browser for the
 * one-time login capture (Target auto-attach + Network domain). Not a general-purpose CDP lib.
 */

// Node exposes a WHATWG `WebSocket` on globalThis; cast to avoid clashing with lib typings.
const WS = (globalThis as { WebSocket?: unknown }).WebSocket as
  | (new (url: string) => WebSocketLike)
  | undefined;

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: unknown) => void, opts?: { once?: boolean }): void;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CDP {
  private ws: WebSocketLike;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, EventHandler[]>();

  private constructor(ws: WebSocketLike) {
    this.ws = ws;
  }

  static async connect(wsUrl: string): Promise<CDP> {
    if (!WS) throw new Error("This Node build has no global WebSocket (need Node >= 20.10).");
    const ws = new WS(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket error")), { once: true });
    });
    const cdp = new CDP(ws);
    ws.addEventListener("message", (ev) => cdp.onMessage(String((ev as { data: unknown }).data)));
    return cdp;
  }

  private onMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {}, msg.sessionId);
    }
  }

  /** Send a CDP command; resolves with its result. `sessionId` targets a flattened child session. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Subscribe to a CDP event (e.g. "Network.responseReceived"). */
  on(method: string, handler: EventHandler): void {
    const arr = this.handlers.get(method) ?? [];
    arr.push(handler);
    this.handlers.set(method, arr);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
