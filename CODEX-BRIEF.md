# Brief: TradingView CLI — design considerations

Audience: an AI coding agent (Codex) evaluating or implementing this.
Status: pre-implementation. No code written yet. Nothing here is decided unless marked **DECIDED**.

---

## 1. Prior art (verified 2026-08-01, not from memory)

### `atilaahmettaner/tradingview-mcp` — the reference implementation
- Python 3.10–3.13, MIT, `pip install tradingview-mcp-server`. 124 files.
- 37 MCP tools: prices (Yahoo), technical analysis (TradingView indicators), backtesting
  (9 strategies, walk-forward), screeners, Reddit sentiment, RSS news.
- **Its console script is a server launcher, not a CLI.** Full arg surface:
  `tradingview-mcp [stdio|streamable-http] --host --port`. Nothing else.
- Ships `openclaw/SKILL.md` + `openclaw/trading.py`. Both are **OpenClaw**-targeted
  (frontmatter `metadata: { "openclaw": ... }`, references `sessions_spawn`, "Be concise
  on Telegram"). Not Claude Code. There is no `.claude/` in the tree.
- `openclaw/trading.py` is **98 lines**, `cmd = sys.argv[1]`, no argparse. Imports 3 of
  ~15 service modules → reaches roughly 8 of the 37 tools. No `--format`, no exit-code
  contract, no pipe design.
- **The skill and the wrapper contradict each other.** SKILL.md prose says run
  `python3 ~/.openclaw/tools/trading.py <command>`, but its quick-reference table
  documents Python signatures (`yahoo_price(symbol="AAPL")`). An agent reading the table
  calls MCP tools, not shell commands. Also points at an install path outside the repo,
  so the file must be hand-copied to `~/.openclaw/tools/`.

Read: a port artifact, not a designed CLI. But it proves the author already felt the pull
toward bash-invocable tooling.

### `fiale-plus/tradingview-mcp-server` — the actual competitor
- TypeScript/npm, 46★, 23 forks. Already dual-mode: "Two modes, one package."
- Subcommands: `screen`, `lookup`, `search`, `metainfo`, `ta`, `rank-ta`, `fields`, `presets`.
- Output: JSON (default) / CSV / table. Pitch is "pipe to jq, csvtool, any Unix workflow."
- **This is the design to beat.** A generic TradingView CLI is not novel territory.

### Traction reality
| Repo | ★ | Shape |
|---|---|---|
| TreborNamor/TradingView-Machine-Learning-GUI | 970 | terminal-first strategy lab |
| kzh-dev/pine-bot-client | 201 | Pine trading bot |
| fiale-plus/tradingview-mcp-server | 46 | MCP + CLI |
| LuxAlgo/pinets-cli | 16 | Pine runner |
| Fynnius/TradingView.Screener | 10 | C# lib + CLI |

Thin wrappers over free libs land at ~10★. The 970★ outlier is a *workflow product*, not a
data wrapper. Conclusion: **wrapping the data is not the value.**

---

## 2. Data-source constraints (engineering-critical)

- **Nothing here is realtime for equities.** Yahoo quotes ~15min delayed; TradingView's
  free scanner endpoint is delayed. A tool marketed as "realtime" for stocks is lying.
- **Crypto is the exception** — 24/7, no exchange delay, effectively live. If realtime
  matters to the pitch, crypto is the honest place to claim it.
- Endpoints are **undocumented and unofficial**. No SLA, no versioning, no deprecation
  notice. Assume breakage every few months. See `iiiyu/tradingview-ws-client` (11★) which
  already has an `-old` sibling — that is what building on the WebSocket feed looks like.
- **Do not build on the TradingView WebSocket feed.** ToS-gray, fragile, high maintenance.
  Poll instead.
- Yahoo throttles aggressively. 50 symbols × 5 conditions naively = immediate 429.
  Batching + exponential backoff + a cache are mandatory, not nice-to-have.
- **ToS**: scraping TradingView is a grey area. Do not redistribute bulk data; do not
  imply official affiliation; keep "unofficial" in the description.
- **License**: the reference repo is MIT. Code reuse is legal *with attribution*. If any
  service module is copied, preserve the copyright notice.

---

## 3. CLI design considerations

**DECIDED — Unix contract.** These are non-negotiable for a cron/pipe tool:
- `stdout` = data only. `stderr` = diagnostics, progress, warnings. Never mix — mixing
  breaks every pipeline.
- Exit codes carry meaning: `0` = matched / success, `1` = no match (not an error),
  `2` = usage error, `3` = upstream/network failure. Cron and shell `&&` depend on this.
- Output format auto-detects: table when `isatty(stdout)`, JSON when piped. `--format`
  overrides. This is the idiom users expect.
- `--help` must make **zero network calls**. Startup latency is a CLI's first impression.

**Open considerations:**
- **Symbol resolution is the main UX wart.** TradingView's API needs a
  `(symbol, exchange, screener)` triple — `AAPL/NASDAQ/america`. Users will type `AAPL`.
  Needs an inference layer + cached symbol table, with explicit override for ambiguity.
- **Caching.** A pipeline that touches the same quote five times must fetch once. TTL
  should be shorter than the data's own staleness (a 15min-delayed quote cached 60s is fine).
- Config location: XDG (`~/.config/tv/`), not `~/.tv/`.
- Streaming vs buffered output for long screens — buffered is simpler, streaming is
  better for `| head`.

---

## 4. The watch daemon — the actual differentiator

MCP servers are request/response. **They cannot wake you up.** No amount of tool-count
competition closes that gap, which makes this durable rather than a feature someone
patches in next release. This is the reason to build at all.

Naive polling is broken in five specific ways. Solving these *is* the product; the
scheduler itself is ~10 lines.

1. **Edge- vs level-triggering.** `rsi < 30` is true every tick until it isn't. Polling
   every 5min yields 40 identical alerts. Fire on the *crossing* → requires persisting
   last tick's value.
2. **Hysteresis.** 29.8 / 30.1 / 29.9 re-fires forever even with edge-triggering. Needs a
   deadband, a cooldown, or both. Make it configurable per-watch.
3. **Market hours + holidays, per exchange.** NASDAQ, BIST and EGX all differ. Don't alert
   on a stale quote at 03:00; don't burn API budget polling a closed exchange. Crypto has
   no such gate.
4. **Missed-tick semantics — the subtle one.** If the daemon was down 6h and the condition
   crossed *and reverted* during the gap, do you fire? Both answers are defensible.
   Decide explicitly and document it; silently picking one will confuse users.
5. **Rate limits.** See §2.

**State store**: needs last-value, last-fired-at, and fire-count per watch. SQLite is the
safe default (atomic, concurrent-safe). JSON is fine only for single-process.

**`--exec` safety** (this is what beats TradingView's own alerts — see §6):
- Dry-run by default. Require an explicit flag to actually execute.
- **Never shell-interpolate fetched market data into the command.** Pass via argv or env,
  never string-concatenate into `sh -c`. Symbol names and news headlines are untrusted input.
- Timeout every exec; a hung hook must not stall the tick loop.

---

## 5. LLM boundary — **DECIDED**

LLM at the edges, never in the loop.

```
ONCE (LLM):    "tell me when Apple gets oversold"
                    ↓ compile
               rsi(AAPL,14) crosses below 30   → human reviews → watches.yaml

FOREVER (no LLM):  tick → fetch → evaluate → state check → fire?

ON FIRE (LLM, optional): phrase the notification text
```

Rationale for keeping it out of the polling loop:
- **Cost**: 50 symbols × 5min ticks = ~14k LLM calls/day to do what `<` does free.
- **Nondeterminism**: identical data can yield different verdicts across ticks. Alerting
  must be reproducible and explainable. LLMs are also weak at precise numeric comparison —
  worst possible job for one.
- **Fragility**: provider outage or rate-limit = silently missed alert.

---

## 6. Positioning

**The competitor is TradingView's own alert system**, not the MCP repos. It is hosted,
mature, and needs no babysitting. Exactly three things beat it:

1. **Alerts fire scripts, not popups.** `--exec ./hedge.sh`. TV emails you; a CLI can *act*.
   This is the whole game. **Without `--exec` this is a worse TradingView alert.**
2. **Alerts as code.** `watches.yaml` in git — diffable, reviewable, deployable. TV alerts
   are click-configured and trapped in their UI.
3. **No alert cap.** TV's free tier caps at a handful; this is capped only by rate limits.

**Non-goals** (explicitly out of scope):
- Rebuilding all 37 tools. Ten composable commands beat 37 that don't compose.
- Realtime WebSocket streaming (§2).
- LLM in the evaluation loop (§5).
- Anything that places live trades.

---

## 7. Deployment — a real gotcha

A laptop cron dies when the lid closes, silently, and a watch may need to run for weeks.

- **GitHub Actions cron** — free, cron-native, makes "alerts as code" literal.
  **Caveat: runners are ephemeral.** The §4 state store does not survive between runs.
  State must be committed back to the repo, or held in an artifact/gist/cache. This is the
  single most likely thing to be gotten wrong. Also: Actions cron is unreliable below ~5min
  and gets deprioritized under load.
- **$5 VPS** — needed if sub-5-minute ticks matter. Persistent disk solves state trivially.
- **Cloudflare Workers cron** — free tier; pair with KV/D1 for state.

---

## 8. Open questions — resolve before implementing

1. **Language.** Python reuses `atilaahmettaner`'s service modules directly (MIT, fastest
   path, no reimplementation of indicators/backtests). TypeScript matches npm distribution
   and the incumbent competitor. Trade-off is code reuse vs distribution reach.
2. **Fork vs greenfield.** Forking inherits 37 tools' worth of tested data plumbing but
   also its architecture. Greenfield + `pip install tradingview-mcp-server` as a *dependency*
   may get the reuse without the coupling — verify its service layer is importable
   standalone (`openclaw/trading.py` imports it directly, so this looks viable).
3. **Predicate language.** Expression parser (`rsi(AAPL,14) crosses below 30`) is friendlier
   but needs a real parser. YAML DSL is uglier but trivial to parse and validate. Hybrid:
   YAML structure with expression strings in leaf conditions.
4. **Missed-tick semantics** (§4.4) — pick one, document it.
5. Notification backends. Telegram bot is lowest-friction (free, 20 lines, every device,
   and the reference repo's audience already lives there). `ntfy.sh` is the no-account
   alternative.

---

## 9. Compliance

- Ship a disclaimer on all backtest and signal output. Backtested edge ≠ live edge.
- Do not ship broker integration or order placement.
- Keep "unofficial / not affiliated with TradingView" in README and package metadata.
