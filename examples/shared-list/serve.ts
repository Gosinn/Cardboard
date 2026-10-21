// Runs the shared-list example on http://localhost:5173 with no build step:
//
//   node examples/shared-list/serve.ts https://your-cardboard.example cbc_yourClientId
//
// It serves the page, and the Cardboard SDK straight from this repository (types
// stripped, the same way the dashboard gets it). Nothing is stored here: the
// list lives in each person's own Cardboard.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join, posix } from "node:path";

const [cardboard = process.env["CARDBOARD_URL"], clientId = process.env["CARDBOARD_CLIENT_ID"]] = process.argv.slice(2);
if (!cardboard || !clientId) {
  console.error("Usage: node examples/shared-list/serve.ts <your Cardboard address> <client id>");
  console.error("Get a client id in your Cardboard: Apps → Add “Sign in with Cardboard” to an app, with http://localhost:5173/callback.");
  process.exit(1);
}
const port = Number(process.env["PORT"] ?? 5173);
const src = join(import.meta.dirname, "..", "..", "src");
const page = readFileSync(join(import.meta.dirname, "index.html"));
const script = readFileSync(join(import.meta.dirname, "app.js"));

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/settings.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ cardboard: cardboard.replace(/\/+$/, ""), clientId }));
  }
  if (path === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(script);
  }
  if (path.startsWith("/lib/")) {
    const file = posix.normalize(path.slice(5));
    if (!/^(client|shared|sdk)\/[a-z0-9-]+\.ts$/.test(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(stripTypeScriptTypes(readFileSync(join(src, file), "utf8")));
  }
  // The page itself, for / and for /callback (where Cardboard sends people back).
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ${new URL(cardboard).origin}` });
  res.end(page);
}).listen(port, "127.0.0.1", () => console.log(`Shared list: http://localhost:${port}  (Cardboard: ${cardboard})`));
