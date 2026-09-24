import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { MAX_MCP_BODY_BYTES, resolveMcpTransport, startHttpMcpServer, type HttpMcpOptions } from "../src/mcp/http.ts";
import { createServer } from "../src/server.ts";
import { parseToolProfile } from "../src/tools/_profile.ts";

const TOKEN = "test-token-that-is-only-for-offline-tests-0123456789";
const OPTIONS: HttpMcpOptions = { host: "127.0.0.1", port: 0, token: TOKEN, allowedOrigins: [] };
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
} };

function factory(): McpServer {
  const server = new McpServer({ name: "test-stockbit-http", version: "1" });
  server.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { content: [{ type: "text", text: value }] };
  });
  return server;
}

function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const body = options.body ?? JSON.stringify(INIT);
    const req = request(url, {
      method: options.method ?? "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), accept: "application/json, text/event-stream", ...options.headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTP configuration fails closed and stdio remains the default", () => {
  assert.deepEqual(resolveMcpTransport({}), { transport: "stdio" });
  assert.throws(() => resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "https" }), /must be stdio or http/);
  assert.throws(() => resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "http" }), /TOKEN is required/);
  for (const port of ["0", "-1", "65536", "8787.5", "8787junk"]) {
    assert.throws(() => resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "http", STOCKBIT_MCP_TOKEN: TOKEN, STOCKBIT_MCP_PORT: port }), /PORT/);
  }
  for (const host of ["0.0.0.0", "::", "192.168.0.1", "127.0.0.1.evil.test"]) {
    assert.throws(() => resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "http", STOCKBIT_MCP_TOKEN: TOKEN, STOCKBIT_MCP_HOST: host }), /loopback-only/);
  }
  for (const token of ["short", `${TOKEN}\n`, ` ${TOKEN}`]) {
    assert.throws(() => resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "http", STOCKBIT_MCP_TOKEN: token }), /TOKEN is required/);
  }
  for (const origin of ["*", "https://example.test/path", "https://example.test/", "file://example.test", "https://user:pass@example.test"]) {
    assert.throws(() => resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "http", STOCKBIT_MCP_TOKEN: TOKEN, STOCKBIT_MCP_ALLOWED_ORIGINS: origin }), /exact HTTP\(S\) origins/);
  }
  const config = resolveMcpTransport({ STOCKBIT_MCP_TRANSPORT: "http", STOCKBIT_MCP_TOKEN: TOKEN });
  assert.equal(config.transport, "http");
  if (config.transport === "http") assert.equal(config.http.port, 8787);
});

test("a real MCP client initializes, lists tools, and calls tools over authenticated HTTP", async () => {
  const listener = await startHttpMcpServer(factory, OPTIONS);
  const client = new Client({ name: "compatibility-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { value: "connected" } });
    assert.deepEqual(result.content, [{ type: "text", text: "connected" }]);
  } finally {
    await client.close();
    await listener.close();
  }
});

test("the Stockbit server publishes its actual tools and prompts over HTTP", async () => {
  const listener = await startHttpMcpServer(() => createServer({ profile: parseToolProfile("core") }), OPTIONS);
  const client = new Client({ name: "stockbit-compatibility-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
    assert.equal(client.getServerVersion()?.name, "stockbit");
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "workflow_list"));
    assert.ok(tools.tools.some((tool) => tool.name === "status"));
    const result = await client.callTool({ name: "workflow_list", arguments: {} });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(payload.success, true);
    assert.ok(Array.isArray(payload.data.workflows));
    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.length > 0);
  } finally {
    await client.close();
    await listener.close();
  }
});

test("auth, DNS rebinding, origin, routing, and body guards run before tool creation", async () => {
  let created = 0;
  const listener = await startHttpMcpServer(() => { created++; return factory(); }, OPTIONS);
  try {
    for (const authorization of ["", "Bearer wrong-token", `Basic ${TOKEN}`, `Bearer ${TOKEN}wrong`]) {
      const response = await send(listener.url, { headers: { authorization } });
      assert.equal(response.status, 401);
      assert.match(String(response.headers["www-authenticate"]), /Bearer/);
      assert.ok(!response.text.includes(TOKEN));
    }
    assert.equal((await send(listener.url, { headers: { host: "attacker.example" } })).status, 403);
    assert.equal((await send(listener.url, { headers: { origin: "https://attacker.example" } })).status, 403);
    assert.equal((await send(listener.url, { headers: { origin: "null" } })).status, 403);
    assert.equal((await send(`${listener.url}?token=${TOKEN}`)).status, 404);
    assert.equal((await send(listener.url, { method: "GET" })).status, 405);
    assert.equal((await send(listener.url, { method: "DELETE" })).status, 405);
    assert.equal((await send(listener.url, { headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await send(listener.url, { body: "{" })).status, 400);
    assert.equal((await send(listener.url, { body: JSON.stringify("x".repeat(MAX_MCP_BODY_BYTES)) })).status, 413);
    assert.equal(created, 0);
    const valid = await send(listener.url);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers["cache-control"], "no-store");
    assert.equal(valid.headers["mcp-session-id"], undefined);
    assert.equal(created, 1);
  } finally { await listener.close(); }
});

test("explicit browser origins receive preflight support without weakening bearer authentication", async () => {
  const origin = "http://localhost:6274";
  const listener = await startHttpMcpServer(factory, { ...OPTIONS, allowedOrigins: [origin] });
  try {
    const preflight = await send(listener.url, { method: "OPTIONS", headers: { origin, authorization: "" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], origin);
    const blocked = await send(listener.url, { headers: { origin, authorization: "" } });
    assert.equal(blocked.status, 401);
    const valid = await send(listener.url, { headers: { origin } });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers["access-control-allow-origin"], origin);
  } finally { await listener.close(); }
});

test("simultaneous clients may reuse JSON-RPC IDs without exchanging results", async () => {
  const listener = await startHttpMcpServer(factory, OPTIONS);
  try {
    const values = ["first-client", "second-client"];
    const results = await Promise.all(values.map((value) => send(listener.url, {
      headers: { "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "echo", arguments: { value } } }),
    })));
    results.forEach((result, index) => {
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.text).result.content[0].text, values[index]);
    });
  } finally { await listener.close(); }
});
