/**
 * Optional, single-user Streamable HTTP adapter. The default CLI transport remains stdio.
 *
 * This listener intentionally accepts loopback connections only. Authentication here protects a
 * local MCP client/proxy; it is not an OAuth implementation or a multi-user account boundary.
 * Every connection uses the same local Stockbit credentials and chart browser.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const MAX_MCP_BODY_BYTES = 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 16;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface HttpMcpOptions {
  host: string;
  port: number;
  token: string;
  allowedOrigins: readonly string[];
}

export type McpTransportConfig = { transport: "stdio" } | { transport: "http"; http: HttpMcpOptions };

function validateOptions(options: HttpMcpOptions): void {
  if (!LOOPBACK_HOSTS.has(options.host)) {
    throw new Error("STOCKBIT_MCP_HOST must be 127.0.0.1, localhost, or ::1. HTTP is loopback-only.");
  }
  // Port 0 is useful to callers testing the listener; the CLI parser requires a fixed port.
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("STOCKBIT_MCP_PORT must be an integer between 1 and 65535.");
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) {
    throw new Error("STOCKBIT_MCP_TOKEN is required for HTTP: use 32–256 base64url characters generated randomly.");
  }
  for (const origin of options.allowedOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error("STOCKBIT_MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("STOCKBIT_MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or wildcards.");
    }
  }
}

/** Strict configuration: a typo must not expose a different transport or silently disable auth. */
export function resolveMcpTransport(env: NodeJS.ProcessEnv = process.env): McpTransportConfig {
  const transport = env.STOCKBIT_MCP_TRANSPORT ?? "stdio";
  if (transport === "stdio") return { transport };
  if (transport !== "http") throw new Error("STOCKBIT_MCP_TRANSPORT must be stdio or http.");
  const portText = env.STOCKBIT_MCP_PORT ?? "8787";
  if (!/^\d+$/.test(portText) || Number(portText) < 1) {
    throw new Error("STOCKBIT_MCP_PORT must be an integer between 1 and 65535.");
  }
  const http: HttpMcpOptions = {
    host: env.STOCKBIT_MCP_HOST ?? "127.0.0.1",
    port: Number(portText),
    token: env.STOCKBIT_MCP_TOKEN ?? "",
    allowedOrigins: (env.STOCKBIT_MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  validateOptions(http);
  return { transport, http };
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_MCP_BODY_BYTES) {
        chunks.length = 0;
        rejected = true;
        reject(new BodyError(413, "Request body too large."));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new BodyError(400, "Invalid JSON.")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new BodyError(400, "Request aborted.")));
  });
}

export interface HttpMcpListener {
  url: string;
  close(): Promise<void>;
}

/** Fresh protocol instances avoid request-ID collisions between clients; account state is shared. */
export async function startHttpMcpServer(
  factory: () => McpServer,
  options: HttpMcpOptions,
): Promise<HttpMcpListener> {
  validateOptions(options);
  const tokenHash = createHash("sha256").update(options.token).digest();
  const origins = new Set(options.allowedOrigins);
  const active = new Set<McpServer>();
  let inFlight = 0;
  let listeningPort = options.port;

  const listener = createHttpServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    // Do not trust Forwarded or X-Forwarded-Host. A local proxy must preserve/rewrite Host to this
    // listener's own address; arbitrary domains resolving to loopback are DNS-rebinding attempts.
    const host = req.headers.host;
    const validHosts = new Set([`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`, `[::1]:${listeningPort}`]);
    if (!host || !validHosts.has(host.toLowerCase())) return fail(res, 403, "Invalid Host header.");
    if (req.url !== "/mcp") return fail(res, 404, "Not found.");
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return fail(res, 403, "Origin is not allowed.");
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!origin) return fail(res, 403, "Origin is required for preflight.");
      res.writeHead(204, {
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Accept",
      });
      return res.end();
    }
    const auth = req.headers.authorization ?? "";
    const candidate = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(auth)?.[1] ?? "";
    if (!timingSafeEqual(tokenHash, createHash("sha256").update(candidate).digest())) {
      res.setHeader("www-authenticate", 'Bearer realm="stockbit-mcp"');
      return fail(res, 401, "A valid MCP bearer token is required.");
    }
    // Stateless MCP permits 405 for standalone SSE and session deletion.
    if (req.method !== "POST") {
      res.setHeader("allow", "POST, OPTIONS");
      return fail(res, 405, "This stateless MCP endpoint accepts POST requests.");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
      return fail(res, 415, "Content-Type must be application/json.");
    }
    if (inFlight >= MAX_ACTIVE_REQUESTS) return fail(res, 503, "Too many active MCP requests.");
    inFlight++;
    let server: McpServer | undefined;
    const release = () => {
      inFlight--;
      if (server) {
        active.delete(server);
        void server.close().catch(() => {});
      }
    };
    res.once("close", release);
    try {
      const body = await readJson(req);
      if (res.destroyed) return;
      server = factory();
      active.add(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        fail(res, err instanceof BodyError ? err.status : 500,
          err instanceof BodyError ? err.message : "MCP request failed.");
      } else if (!res.destroyed) res.end();
    }
  });
  listener.requestTimeout = 30_000;
  listener.headersTimeout = 10_000;
  listener.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(options.port, options.host, () => {
      listener.removeListener("error", reject);
      listeningPort = (listener.address() as AddressInfo).port;
      resolve();
    });
  });
  const urlHost = options.host === "::1" ? "[::1]" : options.host;
  return {
    url: `http://${urlHost}:${listeningPort}/mcp`,
    async close() {
      const stopped = new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      listener.closeAllConnections();
      await Promise.allSettled([...active].map((server) => server.close()));
      await stopped;
    },
  };
}
