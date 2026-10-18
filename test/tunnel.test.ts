import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { checkAddress, cloudflareUrl, openTunnel, pickFunnelPort } from "../src/node/tunnel.ts";
import { startTestServer } from "./helpers.ts";
import { CardboardError } from "../src/sdk/index.ts";

// Stand-ins for cloudflared and tailscale, printing what the real ones print.
const FAKE_CLOUDFLARED = `#!/bin/sh
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF +--------------------------------------------------------------------------------------------+" >&2
echo "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |" >&2
echo "INF |  https://quiet-river-lamp-fox.trycloudflare.com                                             |" >&2
exec sleep 300
`;
// Records every command; FAKE_TS_SERVE is what `tailscale serve status --json` answers.
const FAKE_TAILSCALE = `#!/bin/sh
echo "$*" >> "$FAKE_TS_LOG"
case "$1" in
  status) echo '{"BackendState":"Running","Self":{"DNSName":"Laptop.tail1234.ts.net."}}' ;;
  serve) cat "$FAKE_TS_SERVE" 2>/dev/null || echo '{}' ;;
  funnel) [ "$2" = "--bg" ] && [ -n "$FAKE_TS_FUNNEL_SAY" ] && printf '%b\\n' "$FAKE_TS_FUNNEL_SAY"; exit "\${FAKE_TS_FUNNEL_EXIT:-0}" ;;
esac
`;
const HOST = "laptop.tail1234.ts.net";

describe("putting Cardboard online from your own computer", () => {
  let bin: string;
  let path: string | undefined;
  const log = () => readFileSync(process.env["FAKE_TS_LOG"]!, "utf8");
  const serving = (config: unknown) => writeFileSync(process.env["FAKE_TS_SERVE"]!, JSON.stringify(config));
  before(() => {
    bin = mkdtempSync(join(tmpdir(), "cardboard-tunnel-"));
    process.env["FAKE_TS_LOG"] = join(bin, "log");
    process.env["FAKE_TS_SERVE"] = join(bin, "serve.json");
    writeFileSync(process.env["FAKE_TS_LOG"], "");
    for (const [name, body] of [
      ["cloudflared", FAKE_CLOUDFLARED],
      ["tailscale", FAKE_TAILSCALE],
    ] as const) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
  });
  after(() => {
    process.env["PATH"] = path;
    rmSync(bin, { recursive: true, force: true });
  });

  it("finds the tunnel's address, and never the API address cloudflared mentions in errors", () => {
    assert.equal(cloudflareUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp'), null);
    assert.equal(cloudflareUrl("INF |  https://quiet-river-lamp-fox.trycloudflare.com   |"), "https://quiet-river-lamp-fox.trycloudflare.com");
  });

  it("never takes a Funnel port you already use for something else", () => {
    const yours = { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
    assert.deepEqual(pickFunnelPort({}, HOST, 8787), { port: 443, reuse: false });
    assert.deepEqual(pickFunnelPort(yours, HOST, 8787), { port: 8443, reuse: false });
    const leftover = { ...yours, Web: { ...yours.Web, [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } }, TCP: { ...yours.TCP, "8443": { HTTPS: true } } };
    assert.deepEqual(pickFunnelPort(leftover, HOST, 8787), { port: 8443, reuse: true }, "Cardboard's own setting from an earlier run");
    const full = { TCP: { "443": {}, "8443": {}, "10000": {} } };
    assert.equal(pickFunnelPort(full, HOST, 8787), null);
    const foreground = { Foreground: { session: { TCP: { "443": { HTTPS: true } } } } };
    assert.deepEqual(pickFunnelPort(foreground, HOST, 8787), { port: 8443, reuse: false });
  });

  it("opens a Cloudflare quick tunnel", async () => {
    const tunnel = await openTunnel("cloudflare", 8787);
    assert.equal(tunnel.url, "https://quiet-river-lamp-fox.trycloudflare.com");
    assert.match(tunnel.note, /new address every time/);
    tunnel.close();
  });

  it("opens a Tailscale Funnel at the machine's fixed address, and switches it off when Cardboard stops", async () => {
    serving({});
    const tunnel = await openTunnel("tailscale", 8787);
    assert.equal(tunnel.url, `https://${HOST}`);
    assert.match(log(), /^funnel --bg --https=443 8787$/m);
    await tunnel.close();
    assert.match(log(), /^funnel --https=443 off$/m);
  });

  it("moves to port 8443 when your Tailscale already shares something on 443 (and leaves it alone)", async () => {
    writeFileSync(process.env["FAKE_TS_LOG"]!, "");
    serving({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } }, AllowFunnel: { [`${HOST}:443`]: true } });
    const tunnel = await openTunnel("tailscale", 8787);
    assert.equal(tunnel.url, `https://${HOST}:8443`);
    assert.match(tunnel.note, /already uses 443/);
    assert.match(log(), /^funnel --bg --https=8443 8787$/m);
    await tunnel.close();
    assert.doesNotMatch(log(), /--https=443/, "443 was never touched");
  });

  it("shows the link when Tailscale wants Funnel switched on, and what it said when it refuses", async () => {
    serving({});
    process.env["FAKE_TS_FUNNEL_SAY"] = "Funnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/funnel?node=abc123\\n";
    const said: string[] = [];
    try {
      const tunnel = await openTunnel("tailscale", 8787, { say: (line) => said.push(line) });
      assert.equal(tunnel.url, `https://${HOST}`);
      assert.match(said.join("\n"), /switch Funnel on[\s\S]*https:\/\/login\.tailscale\.com\/f\/funnel\?node=abc123/);
      process.env["FAKE_TS_FUNNEL_SAY"] = "error: some problem with the tailnet";
      process.env["FAKE_TS_FUNNEL_EXIT"] = "1";
      await assert.rejects(openTunnel("tailscale", 8787), (err: unknown) => err instanceof CardboardError && err.code === "tunnel_failed" && /some problem with the tailnet/.test(err.hint ?? ""));
    } finally {
      delete process.env["FAKE_TS_FUNNEL_SAY"];
      delete process.env["FAKE_TS_FUNNEL_EXIT"];
    }
  });

  it("picks up where it left off if Cardboard was stopped without switching Funnel off", async () => {
    writeFileSync(process.env["FAKE_TS_LOG"]!, "");
    serving({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } }, AllowFunnel: { [`${HOST}:443`]: true } });
    const tunnel = await openTunnel("tailscale", 8787);
    assert.equal(tunnel.url, `https://${HOST}`);
    assert.doesNotMatch(log(), /--bg/, "nothing to change");
  });

  it("says how to install a missing tunnel", async () => {
    process.env["PATH"] = "/nonexistent";
    try {
      await assert.rejects(openTunnel("cloudflare", 8787), (err: unknown) => err instanceof CardboardError && err.code === "no_cloudflared" && /brew install cloudflared/.test(err.hint ?? ""));
      await assert.rejects(openTunnel("tailscale", 8787), (err: unknown) => err instanceof CardboardError && err.code === "no_tailscale");
    } finally {
      process.env["PATH"] = `${bin}:${path}`;
    }
  });

  it("checks an address really works: listed in public DNS, and Cardboard answering", async () => {
    const ok = await checkAddress(`https://${HOST}:8443`, {
      resolve: async () => ["1.2.3.4"],
      fetch: (async () => new Response(JSON.stringify({ ok: true }))) as typeof fetch,
    });
    assert.deepEqual(ok, { listed: true, answers: true, problem: null });
    const unlisted = await checkAddress(`https://${HOST}`, {
      resolve: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      },
      fetch: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as typeof fetch,
    });
    assert.deepEqual(unlisted, { listed: false, answers: false, problem: "nothing is answering there [ECONNREFUSED]" });
    const wrong = await checkAddress(`https://${HOST}`, { resolve: async () => ["1.2.3.4"], fetch: (async () => new Response("Bad gateway", { status: 502 })) as typeof fetch });
    assert.match(wrong.problem ?? "", /status 502/);
  });

  it("cardboard doctor: says what's running and what Tailscale shares, with nothing secret in it", async () => {
    const t = await startTestServer({ shake: false });
    try {
      const port = new URL(t.cb.url).port;
      const run = (await import("node:util")).promisify((await import("node:child_process")).execFile);
      const { stdout } = await run(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "doctor", "--port", port], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
      assert.match(stdout, /Cardboard on this computer: running/);
      assert.match(stdout, /Tailscale: Running, this computer is laptop\.tail1234\.ts\.net/);
      assert.match(stdout, /Nothing above is secret/);
      assert.doesNotMatch(stdout, /cbh_|cbi_|cbd_|cbt_/);
    } finally {
      await t.stop();
    }
  });

  it("cardboard start --tunnel: online at the tunnel's address, with the dashboard working through it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cardboard-online-"));
    const port = 18000 + Math.floor(Math.random() * 1000);
    const cli = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "start", "--tunnel", "cloudflare", "--port", String(port), "--data", join(dir, "data")], {
      env: { ...process.env, XDG_CONFIG_HOME: dir, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let out = "";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no start:\n${out}`)), 30_000);
        cli.stdout.on("data", (b: Buffer) => {
          out += b.toString();
          if (/Shake test/.test(out)) {
            clearTimeout(timer);
            resolve();
          }
        });
        cli.stderr.on("data", (b: Buffer) => (out += b.toString()));
      });
      assert.match(out, /Cardboard is online.* at .*https:\/\/quiet-river-lamp-fox\.trycloudflare\.com/);
      assert.match(out, /#invite=cbi_/);
      assert.match(out, /Shake test: \d+\/\d+ passed/);
      // The tunnel rewrote Host to the local address: the dashboard's calls still count as its own.
      const hello = await fetch(`http://127.0.0.1:${port}/v1/hello`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://quiet-river-lamp-fox.trycloudflare.com" },
        body: "{}",
      });
      assert.equal(hello.status, 200);
      assert.equal(((await hello.json()) as { issuer: string }).issuer, "https://quiet-river-lamp-fox.trycloudflare.com");
      const stranger = await fetch(`http://127.0.0.1:${port}/v1/hello`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
      assert.equal(stranger.status, 403);
    } finally {
      cli.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
