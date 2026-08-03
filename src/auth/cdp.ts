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
  /** Count of frames received — a quick liveness signal for diagnostics. */
  messageCount = 0;

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
    ws.addEventListener("message", (ev) => cdp.onMessage((ev as { data: unknown }).data));
    return cdp;
  }

  /** Normalize a WS frame (string | Buffer | ArrayBuffer) to text. */
  private static toText(data: unknown): string {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data as ArrayBufferView)) {
      const v = data as ArrayBufferView;
      return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
    }
    return String(data);
  }

  private onMessage(raw: unknown): void {
    this.messageCount++;
    let msg: any;
    try {
      msg = JSON.parse(CDP.toText(raw));
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

  /**
   * Send a CDP command; resolves with its result. `sessionId` targets a flattened child session.
   *
   * `timeoutMs` bounds the wait. Without it a command whose reply never arrives leaves its promise
   * pending forever — there is no rejection on session detach, and a target frozen by
   * `waitForDebuggerOnStart` will not answer commands dispatched to its own thread. An awaited
   * send in that state deadlocks its caller permanently, so callers on a critical path must bound
   * it rather than trust the peer to reply.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any> {
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        this.pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        return;
      }
      this.pending.set(id, { resolve, reject });
    });
  }

  /** Subscribe to a CDP event (e.g. "Network.responseReceived"). */
  on(method: string, handler: EventHandler): void {
    const arr = this.handlers.get(method) ?? [];
    arr.push(handler);
    this.handlers.set(method, arr);
  }

  /**
   * Subscribe to the transport dropping. Closing the browser ends the DevTools socket, which
   * otherwise removes the last thing holding the event loop open — the capture promise then never
   * settles and the process exits 0 as if it had succeeded. Callers turn this into a real error.
   */
  onClose(handler: () => void): void {
    this.ws.addEventListener("close", () => handler(), { once: true });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
