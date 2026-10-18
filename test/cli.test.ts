import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { startTestServer, type TestServer } from "./helpers.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const SDK = join(import.meta.dirname, "..", "src", "sdk", "index.ts");

describe("cardboard CLI", () => {
  let t: TestServer;
  let home: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    t = await startTestServer({ shake: false });
    home = mkdtempSync(join(tmpdir(), "cardboard-cli-"));
    mkdirSync(join(home, "cardboard"), { recursive: true });
    writeFileSync(join(home, "cardboard", "host.json"), JSON.stringify({ url: t.cb.url, hostToken: t.hostToken }));
    env = { ...process.env, XDG_CONFIG_HOME: home };
    delete env["CARDBOARD_URL"];
    delete env["CARDBOARD_HOST_TOKEN"];
  });
  after(async () => {
    await t.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const cli = (args: string[], cwd?: string, extraEnv: NodeJS.ProcessEnv = {}) => run(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, cwd });

  it("signs this computer up (the host invites itself) and prints the recovery kit once", async () => {
    await assert.rejects(cli(["boxes"]), /isn't signed in to Cardboard yet/);
    const { stdout } = await cli(["signup", "--name", "Test laptop"]);
    assert.match(stdout, /Made your Cardboard account/);
    assert.match(stdout, /Your recovery kit[\s\S]*[0-9A-Z]{4}-[0-9A-Z]{4}/);
    const device = join(home, "cardboard", "device.json");
    assert.equal(statSync(device).mode & 0o077, 0, "the device file is private");
    assert.doesNotMatch(readFileSync(device, "utf8"), /Test laptop/, "the device's name is sealed, not stored here");
    await assert.rejects(cli(["signup"]), /already signed in/);
    const who = await cli(["whoami"]);
    assert.match(who.stdout, /Device:\s+Test laptop/);
    assert.match(who.stdout, /Recovery: a recovery kit/);
  });

  it("connects an app in one command and keeps the tape out of git", async () => {
    const appDir = join(home, "my-notes");
    mkdirSync(appDir);
    writeFileSync(join(appDir, ".gitignore"), "node_modules\n");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@gosinn/my-notes", description: "Notes for me", version: "0.3.0" }));
    const { stdout } = await cli(["connect", "--dir", appDir]);
    assert.match(stdout, /Made a box called .*my-notes/, "the box name comes from package.json");

    const dotenv = readFileSync(join(appDir, ".env"), "utf8");
    assert.match(dotenv, /^CARDBOARD_URL=http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(dotenv, /^CARDBOARD_TAPE=cbt_[\w-]{86}$/m, "a tape is a token half and a key half");
    assert.match(readFileSync(join(appDir, ".gitignore"), "utf8"), /^\.env$/m);

    await assert.rejects(cli(["connect", "my-notes", "--dir", appDir]), /already has a CARDBOARD_TAPE/);
    const again = await cli(["connect", "my-notes", "--dir", appDir, "--force"]);
    assert.match(again.stdout, /Connected to the existing box/);
    assert.equal(readFileSync(join(appDir, ".gitignore"), "utf8").match(/^\.env$/gm)?.length, 1);

    // The SDK finds .env by itself: open() with no arguments.
    const script = `import { open } from ${JSON.stringify(SDK)}; const box = open(); await box.put("hello", "from .env"); console.log(await box.get("hello"));`;
    const { stdout: out } = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: appDir, env });
    assert.equal(out.trim(), "from .env");
  });

  it("answers the everyday questions", async () => {
    const boxes = await cli(["boxes"]);
    assert.match(boxes.stdout, /my-notes/);
    assert.match(boxes.stdout, /Notes for me · v0\.3\.0/, "the app's profile is sealed on the server and opened here");
    const box = await cli(["box", "my-notes"]);
    assert.match(box.stdout, /If this tape leaks/);
    const log = await cli(["log", "my-notes"]);
    assert.match(log.stdout, /saved “hello”/);
    await cli(["set", "my-notes", "secrets", "block"]);
    assert.equal((await t.me.boxes()).length, 0, "another account sees none of it");
    await assert.rejects(cli(["box", "nope"]), /There's no box called nope/);
    const insights = await cli(["insights"]);
    assert.match(insights.stdout, /Nothing to fix|·|!/);
  });

  it("docks apps from the command line", async () => {
    const acct = async () => {
      const { unlock } = await import("../src/client/account.ts");
      const { FileStore } = await import("../src/node/store.ts");
      return (await unlock(new FileStore(join(home, "cardboard", "device.json"))))!;
    };
    const me = await acct();
    for (const name of ["cli-sender", "cli-receiver", "cli-asker"]) await me.createBox(name);
    const created = await cli(["dock", "create", "cli-dock", "--send", "cli-sender", "--receive", "cli-receiver"]);
    assert.match(created.stdout, /Opened .*cli-dock/);
    assert.match(created.stdout, /cli-sender can send, known there as berth-[0-9a-f]{12}/);

    const { open } = await import("../src/sdk/index.ts");
    const asker = open({ url: t.cb.url, tape: (await me.createTape("cli-asker")).secret });
    await assert.rejects(asker.dock("cli-dock").send({ hi: 1 }), /Waiting for you to approve/);
    const listed = await cli(["docks"]);
    assert.match(listed.stdout, /cli-asker wants to send on .*cli-dock/);
    await cli(["dock", "approve", "cli-dock", "cli-asker"]);
    const fresh = open({ url: t.cb.url, tape: (await me.createTape("cli-asker")).secret });
    assert.equal((await fresh.dock("cli-dock").send({ hi: 2 })).recipients, 1);

    const peek = await cli(["dock", "peek", "cli-dock"]);
    assert.match(peek.stdout, /from .*cli-asker/);
    assert.match(peek.stdout, /\{"hi":2\}/, "opened on this computer");
    await cli(["dock", "set", "cli-dock", "personal", "block"]);
    await cli(["dock", "remove", "cli-dock", "cli-asker"]);
    await assert.rejects(open({ url: t.cb.url, tape: (await me.createTape("cli-asker")).secret }).dock("cli-dock").send({ hi: 3 }), /Waiting for you to approve/);
  });

  it("manages devices, recovery and Sign in with Cardboard", async () => {
    const devices = await cli(["devices"]);
    assert.match(devices.stdout, /→ Test laptop/);
    const friends = await cli(["recovery", "friends", "--friends", "3", "--need", "2"]);
    assert.equal(friends.stdout.match(/Piece \d:/g)?.length, 3);
    const kit = await cli(["recovery", "kit"]);
    assert.match(kit.stdout, /New recovery kit/);
    const code = /^\s+([0-9A-Z]{4}(?:-[0-9A-Z]{1,4}){6})\s*$/m.exec(kit.stdout)![1]!;
    const other = mkdtempSync(join(tmpdir(), "cardboard-cli2-"));
    const recovered = await run(process.execPath, [CLI, "recover", t.cb.url, "--kit", code, "--name", "Spare"], { env: { ...env, XDG_CONFIG_HOME: other } });
    assert.match(recovered.stdout, /You're back in/);
    assert.match((await cli(["devices"])).stdout, /Spare/);
    rmSync(other, { recursive: true, force: true });

    const added = await cli(["apps", "add", "Notes Web", "--redirect", "https://notes.example.com/callback"]);
    assert.match(added.stdout, /client_id\s+cbc_/);
    assert.match(added.stdout, /client_secret\s+cbs_/);
    const profile = await cli(["profile", "--name", "Gosinn", "--email", "gosinn@example.is"]);
    assert.match(profile.stdout, /Name:\s+Gosinn/);
    const apps = await cli(["apps"]);
    assert.match(apps.stdout, /Registered, not connected/);
    assert.match(apps.stdout, /Notes Web/);
  });

  it("sets up an AI assistant that runs here, with keys only for what you share", async () => {
    const added = await cli(["assistant", "add", "claude", "--see", "my-notes"]);
    assert.match(added.stdout, /claude can use: assistant-claude \(its own\), my-notes \(read-only\)/);
    assert.match(added.stdout, /claude mcp add cardboard -- node .*cli\.ts mcp claude/);
    const config = join(home, "cardboard", "assistants", "claude.json");
    assert.equal(statSync(config).mode & 0o077, 0);

    const child = spawn(process.execPath, [CLI, "mcp", "claude"], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_item", arguments: { box: "my-notes", key: "hello" } } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "save_item", arguments: { box: "my-notes", key: "x", value: 1 } } });
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
    const replies = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(replies[0].result.serverInfo.name, "cardboard");
    assert.equal(replies[1].result.structuredContent.value, "from .env");
    assert.ok(replies[2].result.isError, "read-only stays read-only");

    const removed = await cli(["assistant", "remove", "claude"]);
    assert.match(removed.stdout, /claude is cut off/);
    assert.ok(!existsSync(config));
  });

  it("runs the server side: invites, accounts, backups", async () => {
    const invite = await cli(["host", "invite", "--note", "for Siggi"]);
    assert.match(invite.stdout, /#invite=cbi_/);
    const accounts = await cli(["host", "accounts"]);
    assert.match(accounts.stdout, /acct_/);
    assert.match(accounts.stdout, /sealed by keys only their devices hold/);
    const backup = await cli(["host", "backup"]);
    assert.match(backup.stdout, /Only sealed data inside/);
    const overview = await cli(["host"]);
    assert.match(overview.stdout, /can't see inside anyone's account/);
  });

  it("starts a fresh Cardboard and prints the host token and a first invite, once", async () => {
    const dataDir = join(home, "fresh-data");
    const fresh = mkdtempSync(join(tmpdir(), "cardboard-fresh-"));
    const child = spawn(process.execPath, [CLI, "start", "--port", "0", "--data", dataDir], { env: { ...env, XDG_CONFIG_HOME: fresh } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 20_000;
    while (!/Shake test/.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    assert.match(output, /Cardboard is open/);
    assert.match(output, /cbh_[\w-]{43}/);
    assert.match(output, /Make your account:.*#invite=cbi_/);
    assert.match(output, /Shake test: \d+\/\d+ passed/);
    assert.doesNotMatch(output, /ExperimentalWarning/);
    const creds = JSON.parse(readFileSync(join(fresh, "cardboard", "host.json"), "utf8"));
    assert.match(creds.hostToken, /^cbh_/);
    rmSync(fresh, { recursive: true, force: true });
  });
});
