# Connect Claude and ChatGPT

Use the build from this checkout. An older npm release may still contain real-money tools that have been removed here.

## Build and sign in

From the repository directory, with Node.js 22 or later:

```sh
npm ci
npm run build
node dist/bin/stockbit-auth.js login
node dist/bin/stockbit-auth.js status
```

Sign in in the browser window opened by the login command. Do not put a Stockbit password, PIN, cookie, or JWT in client configuration. Portfolio reads require a securities session: run `node dist/bin/stockbit-auth.js trading-login` and enter the PIN yourself in the terminal. This unlocks read access, without enabling real-money orders. Access also depends on the account and Stockbit permissions. Chart drawing uses the browser on the same machine as the MCP server.

Use absolute paths to this checkout's `dist/bin/stockbit-mcp.js` and to your Node executable (`command -v node`, or `(Get-Command node).Source` in PowerShell). In JSON on Windows, write paths with forward slashes or escaped backslashes. Rebuild after source changes, then restart the client connection.

## Claude Desktop: local stdio

Add this entry to `claude_desktop_config.json` through Claude Desktop's developer configuration, replacing both paths:

```json
{
  "mcpServers": {
    "stockbit": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/stockbit-mcp/dist/bin/stockbit-mcp.js"],
      "env": {
        "STOCKBIT_MCP_TRANSPORT": "stdio",
        "STOCKBIT_TOOLS": "core,chartbit,virtual"
      }
    }
  }
}
```

Restart Claude Desktop and ask it to call `status`, list your portfolio, or open a chart. This configuration adds chart and Stockbit virtual-account tools to the core analysis tools. `STOCKBIT_TOOLS=all` exposes the complete supported tool inventory; use a narrower profile if your client has a tool limit. Local paper simulation is separate from Stockbit's virtual account and belongs to the `trading` family.

Local Desktop configuration runs on your machine. A remote connector configured in Claude's account settings runs through Anthropic's cloud and is a different connection path. See [Claude's local and remote connector guidance](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### Optional Desktop extension from this checkout

After `npm ci`, run `npm run build:mcpb`. It rebuilds the source and creates
`stockbit-mcp-<version>.mcpb` in the repository directory with the runtime dependencies included.
This is a local build of the unreleased changes, even if its version number matches an older release.

In Claude Desktop, open **Settings → Extensions → Advanced settings → Install Extension…** and
select that file. Set **Tool profile** to `core,chartbit,virtual` to enable chart drawing and website
virtual trading; the extension defaults to `core`. Local extension installation may be restricted
by your workspace policy. See [Claude's local extension instructions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

Use either this extension or the manual stdio entry above to avoid duplicate server connections.
The extension uses the same OS user's locally saved Stockbit credentials. It does not contain a
Stockbit login or browser profile. Rebuild and reinstall it after changing this checkout.

## Claude Code: local stdio

```sh
claude mcp add --transport stdio \
  --env STOCKBIT_MCP_TRANSPORT=stdio \
  --env STOCKBIT_TOOLS=core,chartbit,virtual \
  stockbit -- /absolute/path/to/node /absolute/path/to/stockbit-mcp/dist/bin/stockbit-mcp.js
```

Quote paths containing spaces. Run `/mcp` in Claude Code to inspect the connection. See the [official Claude Code MCP reference](https://code.claude.com/docs/en/mcp).

## Claude Code plugin from this checkout

Run `npm ci` and `npm run build` in this repository, then launch
`claude --plugin-dir /absolute/path/to/stockbit-mcp`. The bundled `.mcp.json` resolves
`${CLAUDE_PLUGIN_ROOT}/dist/bin/stockbit-mcp.js`; it intentionally does not install the older npm
release. A copied plugin checkout must also be built before launching. See the
[official plugin MCP configuration reference](https://code.claude.com/docs/en/plugins-reference).

## ChatGPT: private Secure MCP Tunnel

ChatGPT developer mode can reach a local stdio MCP server through OpenAI's Secure MCP Tunnel. This keeps Stockbit's browser and stored session on your machine. It requires tunnel permissions, a runtime API key, the target workspace association, and developer-mode access. Availability depends on your account/workspace. Follow the [official Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to install `tunnel-client` and create the tunnel.

Supply `CONTROL_PLANE_API_KEY` privately in your shell environment, then configure this checkout:

```sh
export STOCKBIT_MCP_TRANSPORT=stdio
export STOCKBIT_TOOLS=core,chartbit,virtual
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile stockbit \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command '"/absolute/path/to/node" "/absolute/path/to/stockbit-mcp/dist/bin/stockbit-mcp.js"'
tunnel-client doctor --profile stockbit --explain
tunnel-client run --profile stockbit
```

Keep the tunnel running. In ChatGPT, enable Developer mode under **Settings → Security and login**. Open [ChatGPT Plugins](https://chatgpt.com/plugins), add a connection, choose **Tunnel**, and select your tunnel. Review the discovered tools and test `status` first. See [OpenAI's connection and testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

The tunnel commands are documented integration instructions; an end-to-end ChatGPT connection still requires your account's tunnel setup and has not been verified merely by passing local MCP tests. The tunnel is a private development connection, not a public plugin submission.

## Optional local Streamable HTTP

For a local HTTP-capable client or an authenticated local gateway, the same entry point also serves `/mcp`:

```sh
export STOCKBIT_MCP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export STOCKBIT_MCP_TRANSPORT=http
export STOCKBIT_TOOLS=core,chartbit,virtual
node dist/bin/stockbit-mcp.js
```

The URL is `http://127.0.0.1:8787/mcp`. Configure the client to send `Authorization: Bearer <the generated token>` with every request. Keep the token private; it grants access to the same Stockbit account and chart browser as the local process. It is an MCP transport credential, not a Stockbit credential.

| Setting | Default | Behavior |
| --- | --- | --- |
| `STOCKBIT_MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `STOCKBIT_MCP_TOKEN` | None | Required for HTTP; randomly generate 32–256 base64url characters |
| `STOCKBIT_MCP_HOST` | `127.0.0.1` | Only `127.0.0.1`, `localhost`, and `::1` are accepted |
| `STOCKBIT_MCP_PORT` | `8787` | Integer from 1 through 65535 |
| `STOCKBIT_MCP_ALLOWED_ORIGINS` | None | Exact comma-separated browser origins; no wildcards or paths |

HTTP requests have a 1 MiB body limit and 16-request concurrency limit. Host validation rejects arbitrary domains even if they resolve to loopback. Requests with an `Origin` header are rejected unless explicitly allowed. A local proxy must use the listener's loopback Host header; forwarded host headers are not trusted.

This is stateless Streamable HTTP with JSON responses. It supports initialize, tool discovery/calls, and prompts. Standalone GET event streams and DELETE sessions return 405. Browser login and any operation requiring client elicitation should use the local CLI or stdio connection; the stateless HTTP adapter does not retain client capabilities between requests.

Each HTTP request gets its own MCP protocol instance, but account credentials, local files, paper ledger, tickets, and the chart browser remain shared. Run one server under a separate OS account/store per Stockbit user. Do not treat different client connections or bearer tokens as separate Stockbit users. Avoid simultaneous chart editing from multiple clients.

### Verify HTTP locally

Start the server as above, then use [MCP Inspector](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md) from another terminal with the same token available:

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp \
  --transport http --method tools/list \
  --header "Authorization: Bearer $STOCKBIT_MCP_TOKEN"
```

For Inspector's browser UI, allow its exact displayed origin using `STOCKBIT_MCP_ALLOWED_ORIGINS` and configure the authorization header. Restart the server after changing its environment.

### Remote connectors and deployment limits

The loopback HTTP token is not OAuth. ChatGPT's public connector cannot simply use this custom bearer token: private account access through a public endpoint needs a proper OAuth 2.1 resource/authorization service, as described in [OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth). No public listener or OAuth service is included in this project.

Claude's remote custom connectors need a reachable remote service. A production gateway must authenticate the user, bind that user to an isolated Stockbit runtime, and forward to the protected loopback listener. Publishing one shared authenticated Stockbit session would expose that account to every authorized gateway user. Use local Claude stdio or the private ChatGPT tunnel for this single-user build.

## First connection checks

1. Call `status` and inspect its authentication and tool-profile result.
2. Read a quote and your portfolio; report an unavailable session instead of inventing data.
3. Open an existing chart and take a screenshot before creating drawings.
4. Inspect the virtual portfolio before testing simulated orders. Local `paper_*` tools use a separate on-disk simulation.
5. Refresh/reconnect the client after changes to tool schemas or the tool profile.

Local HTTP protocol tests run with `node --test --import tsx --import ./test/_offline.mjs test/mcp-http.test.ts`. These exercise a real SDK client, authentication, origin/host/body protections, and concurrent requests without accessing Stockbit.
