/**
 * Serve the progress report on localhost.
 *
 * Rebuilds on every request rather than serving a snapshot, so the page is never stale: the commit
 * log, tool list and file counts are re-read from the repo each time you refresh. That costs a few
 * `git` calls per load, which is nothing at one viewer, and it removes the failure mode where the
 * report says one thing and the repo says another.
 *
 * Binds to 127.0.0.1 only. This page describes an unreleased project and reads from a local
 * repository; it has no business being reachable from the network.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

function render() {
  // Rebuild in a child process so a syntax error in build.mjs surfaces as a 500 with the message,
  // rather than taking down the server and leaving the tab hanging.
  execFileSync(process.execPath, [join(HERE, "build.mjs")], { cwd: join(HERE, ".."), stdio: "pipe" });
  return readFileSync(join(HERE, "index.html"), "utf8");
}

createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  try {
    const html = render();
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Always revalidate: the whole point is that a refresh shows current state.
      "cache-control": "no-store",
    });
    res.end(html);
  } catch (err) {
    const message = err?.stderr?.toString() || err?.message || String(err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Failed to build the progress report:\n\n${message}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`progress report on http://127.0.0.1:${PORT}/`);
});
