import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cloudflareUrl, funnelUrl, openTunnel } from "../src/node/tunnel.ts";
import { CardboardError } from "../src/sdk/index.ts";

// Stand-ins for cloudflared and tailscale, printing what the real ones print.
const FAKE_CLOUDFLARED = `#!/bin/sh
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF +--------------------------------------------------------------------------------------------+" >&2
echo "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |" >&2
echo "INF |  https://quiet-river-lamp-fox.trycloudflare.com                                             |" >&2
exec sleep 300
`;
const FAKE_TAILSCALE = `#!/bin/sh
if [ "$1" = "status" ]; then echo '{"BackendState":"Running","Self":{"DNSName":"laptop.tail1234.ts.net."}}'; exit 0; fi
if [ "$1" = "funnel" ]; then printf 'Available on the internet:\\n\\nhttps://laptop.tail1234.ts.net/\\n|-- proxy http://127.0.0.1:%s\\n\\nPress Ctrl+C to exit.\\n' "$2"; exec sleep 300; fi
exit 1
`;

describe("putting Cardboard online from your own computer", () => {
  let bin: string;
  let path: string | undefined;
  before(() => {
    bin = mkdtempSync(join(tmpdir(), "cardboard-tunnel-"));
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
    assert.equal(funnelUrl("To enable, visit: https://login.tailscale.com/f/funnel?node=abc"), null);
    assert.equal(funnelUrl("Available on the internet:\n\nhttps://Laptop.tail1234.ts.net/\n"), "https://laptop.tail1234.ts.net");
  });

  it("opens a Cloudflare quick tunnel", async () => {
    const tunnel = await openTunnel("cloudflare", 8787);
    assert.equal(tunnel.url, "https://quiet-river-lamp-fox.trycloudflare.com");
    assert.match(tunnel.note, /new address every time/);
    tunnel.close();
  });

  it("opens a Tailscale Funnel at the machine's fixed address", async () => {
    const tunnel = await openTunnel("tailscale", 8787);
    assert.equal(tunnel.url, "https://laptop.tail1234.ts.net");
    tunnel.close();
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
