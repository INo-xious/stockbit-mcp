/**
 * Render the progress report from `status.json` plus facts read out of the repo.
 *
 * The point of generating rather than hand-writing the HTML is that the parts which go stale
 * fastest — the test count, the commit log, the tool list — are read from the repo every build
 * instead of being typed into a page that then quietly disagrees with reality. `status.json` holds
 * only the things a human has to judge: what is done, what is blocked, what was verified.
 *
 * Usage: `npm run progress` (regenerates index.html), or `npm run progress -- --serve`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const status = JSON.parse(readFileSync(join(HERE, "status.json"), "utf8"));

/** Escape for HTML text and attributes. Every value below is interpolated through this. */
const esc = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Run a command, returning "" rather than throwing — a missing git must not break the report. */
function read(command, args) {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/* ------------------------------- facts read from the repo ------------------------------- */

const commits = read("git", ["log", "-25", "--date=short", "--format=%h%ad%s"])
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [hash, date, subject] = line.split("");
    return { hash, date, subject };
  });

const head = commits[0]?.hash ?? "unknown";
const remoteHead = (read("git", ["ls-remote", "--heads", "origin", "main"]).split(/\s+/)[0] ?? "").slice(0, 7);
const pushed = remoteHead && commits[0] && remoteHead.startsWith(commits[0].hash);

/**
 * Tool names, read from the registration sources so the list cannot drift from the server.
 *
 * Every module under `src/tools/` is scanned, not just `register.ts`: the families each register
 * their own tools now, and a builder that read one file would quietly under-report the surface.
 */
const tools = [
  ...new Set(
    readdirSync(join(ROOT, "src/tools"))
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .flatMap((f) => [
        ...readFileSync(join(ROOT, "src/tools", f), "utf8").matchAll(
          /(?:server\.tool|define\.(?:read|write))\(\s*"([a-z_]+)"/g,
        ),
      ])
      .map((m) => m[1]),
  ),
].sort();

/** Test count, read from the suite's own output if it has been run into progress/tests.txt. */
let testLine = "";
try {
  const raw = readFileSync(join(HERE, "tests.txt"), "utf8");
  const pass = /^# pass (\d+)$/m.exec(raw) ?? /pass (\d+)/.exec(raw);
  const fail = /^# fail (\d+)$/m.exec(raw) ?? /fail (\d+)/.exec(raw);
  if (pass) testLine = `${pass[1]} passing${fail && fail[1] !== "0" ? `, ${fail[1]} FAILING` : ""}`;
} catch {
  testLine = "";
}

const sourceFiles = read("git", ["ls-files", "src"]).split("\n").filter(Boolean).length;
const testFiles = read("git", ["ls-files", "test"]).split("\n").filter((f) => f.endsWith(".test.ts")).length;

/* ------------------------------------- rendering ------------------------------------- */

const STATE_LABEL = {
  done: "Done",
  partial: "Partial",
  "not-started": "Not started",
  declined: "Declined",
};

const counts = status.features.reduce((acc, f) => ({ ...acc, [f.state]: (acc[f.state] ?? 0) + 1 }), {});
const doneish = (counts.done ?? 0) + (counts.declined ?? 0);
const pct = Math.round((doneish / status.features.length) * 100);

const featureCards = status.features
  .map(
    (f) => `
      <article class="feature ${esc(f.state)}">
        <header>
          <h3>${esc(f.name)}</h3>
          <span class="pill ${esc(f.state)}">${esc(STATE_LABEL[f.state] ?? f.state)}</span>
        </header>
        <p>${esc(f.detail)}</p>
        ${f.tools?.length ? `<p class="tools">${f.tools.map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>` : ""}
        ${f.verified ? `<p class="verified"><strong>Verified:</strong> ${esc(f.verified)}</p>` : ""}
        ${f.blocker ? `<p class="blocker"><strong>Blocked:</strong> ${esc(f.blocker)}</p>` : ""}
      </article>`,
  )
  .join("");

const verificationRows = status.verification
  .map(
    (v) => `
      <tr>
        <td>${esc(v.check)}</td>
        <td><span class="result ${esc(v.result)}">${esc(v.result)}</span></td>
        <td>${esc(v.evidence)}</td>
      </tr>`,
  )
  .join("");

const commitRows = commits
  .map(
    (c) => `
      <tr>
        <td><code>${esc(c.hash)}</code></td>
        <td class="date">${esc(c.date)}</td>
        <td>${esc(c.subject)}</td>
      </tr>`,
  )
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stockbit-mcp — progress</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3; --muted: #8b949e;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149; --info: #58a6ff; --dim: #6e7681;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --panel:#f6f8fa; --line:#d0d7de; --text:#1f2328; --muted:#59636e; --dim:#8c959f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing:-0.01em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 40px 0 14px; font-weight:600; }
  h3 { font-size: 16px; margin: 0; }
  code { font-family: ui-monospace,"Cascadia Code",Consolas,monospace; font-size: .88em; background: var(--panel); border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
  a { color: var(--info); }
  .goal { color: var(--muted); max-width: 72ch; margin: 0 0 22px; }

  .bar { height:8px; background:var(--panel); border:1px solid var(--line); border-radius:99px; overflow:hidden; margin:10px 0 6px; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--ok),var(--info)); }

  .meta { display:flex; flex-wrap:wrap; gap:10px; margin-bottom: 6px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:9px 13px; }
  .stat b { display:block; font-size:19px; }
  .stat span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }

  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); }
  .feature { background:var(--panel); border:1px solid var(--line); border-left-width:3px; border-radius:10px; padding:16px 18px; }
  .feature.done { border-left-color: var(--ok); }
  .feature.partial { border-left-color: var(--warn); }
  .feature\\.not-started, .feature.not-started { border-left-color: var(--dim); }
  .feature.declined { border-left-color: var(--dim); }
  .feature header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
  .feature p { margin:8px 0 0; font-size:14px; }
  .tools code { margin-right:2px; }
  .verified { color: var(--ok); font-size:13px !important; }
  .blocker { color: var(--warn); font-size:13px !important; }

  .pill { font-size:11px; text-transform:uppercase; letter-spacing:.07em; padding:3px 9px; border-radius:99px; border:1px solid var(--line); white-space:nowrap; }
  .pill.done { color:var(--ok); border-color:var(--ok); }
  .pill.partial { color:var(--warn); border-color:var(--warn); }
  .pill.not-started, .pill.declined { color:var(--dim); }

  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.06em; padding:0 12px 8px 0; }
  td { padding:9px 12px 9px 0; border-top:1px solid var(--line); vertical-align:top; }
  td.date { color:var(--muted); white-space:nowrap; }
  .result { text-transform:uppercase; font-size:11px; letter-spacing:.06em; padding:2px 8px; border-radius:99px; border:1px solid; white-space:nowrap; }
  .result.pass { color:var(--ok); border-color:var(--ok); }
  .result.pending { color:var(--warn); border-color:var(--warn); }
  .result.fail { color:var(--bad); border-color:var(--bad); }

  ul.plain { padding-left: 20px; margin: 0; }
  ul.plain li { margin-bottom: 8px; max-width: 78ch; }
  .foot { margin-top:44px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(status.project)} — progress</h1>
  <p class="goal">${esc(status.goal)}</p>

  <div class="bar"><i style="width:${pct}%"></i></div>
  <div class="meta">
    <div class="stat"><b>${doneish}/${status.features.length}</b><span>features settled</span></div>
    <div class="stat"><b>${tools.length}</b><span>MCP tools</span></div>
    ${testLine ? `<div class="stat"><b>${esc(testLine)}</b><span>tests</span></div>` : ""}
    <div class="stat"><b>${sourceFiles}</b><span>source files</span></div>
    <div class="stat"><b>${testFiles}</b><span>test files</span></div>
    <div class="stat"><b><code>${esc(head)}</code></b><span>${pushed ? "pushed to main" : "NOT pushed"}</span></div>
  </div>

  <h2>Features</h2>
  <div class="grid">${featureCards}</div>

  <h2>Verified against live Stockbit</h2>
  <div class="scroll"><table>
    <thead><tr><th>Check</th><th>Result</th><th>Evidence</th></tr></thead>
    <tbody>${verificationRows}</tbody>
  </table></div>

  <h2>Blocked on a decision</h2>
  <ul class="plain">${status.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>

  <h2>Worth knowing</h2>
  <ul class="plain">${status.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>

  <h2>Tools registered</h2>
  <p>${tools.map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>

  <h2>Recent commits</h2>
  <div class="scroll"><table>
    <thead><tr><th>Commit</th><th>Date</th><th>Subject</th></tr></thead>
    <tbody>${commitRows}</tbody>
  </table></div>

  <p class="foot">
    Generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 16))} UTC from
    <code>progress/status.json</code> and the repo itself.
    Repository: <a href="${esc(status.repo)}">${esc(status.repo)}</a>.
    Regenerate with <code>npm run progress</code>.
  </p>
</div>
</body>
</html>
`;

writeFileSync(join(HERE, "index.html"), html, "utf8");
console.log(`progress/index.html written — ${doneish}/${status.features.length} settled, ${tools.length} tools, HEAD ${head}`);
