import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// A temporary fleet view, until the console has one. Not part of the console: a
// page and a proxy, run beside agent-serve on an operator's machine.
//
//   AGENT_INTERNAL_TOKEN=... npx tsx scripts/fleet-view/server.ts
//   open http://127.0.0.1:6995
//
// The page asks this process for /api/fleet; this process asks agent-serve's
// /fleet with the internal token, so the token never reaches the browser.
// AGENT_URL (default http://127.0.0.1:6989) names agent-serve; FLEET_VIEW_PORT
// (default 6995) is where this listens, on loopback only.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const AGENT = (process.env["AGENT_URL"] ?? "http://127.0.0.1:6989").replace(/\/+$/, "");
const TOKEN = process.env["AGENT_INTERNAL_TOKEN"] ?? process.env["VIGIL_TOOLS_TOKEN"] ?? "";
const PORT = Number(process.env["FLEET_VIEW_PORT"] ?? 6995);

// The console's own design tokens, read from the design package so the page looks
// like the console without copying them.
const TOKENS = here("../../../../docs/design/console/tokens/tokens.css");

async function proxied(path: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(`${AGENT}${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 502, body: JSON.stringify({ error: `agent-serve at ${AGENT} did not answer: ${(error as Error).message}` }) };
  }
}

createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(readFileSync(here("./index.html"), "utf8"));
    }
    if (url === "/tokens.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      return void res.end(readFileSync(TOKENS, "utf8"));
    }
    if (url === "/api/fleet") {
      const { status, body } = await proxied("/fleet");
      res.writeHead(status, { "content-type": "application/json" });
      return void res.end(body);
    }
    res.writeHead(404).end();
  })();
}).listen(PORT, "127.0.0.1", () => {
  console.log(`fleet view on http://127.0.0.1:${PORT}, reading ${AGENT}/fleet${TOKEN === "" ? " (no AGENT_INTERNAL_TOKEN set: agent-serve will refuse)" : ""}`);
});
