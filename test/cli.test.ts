import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    writeFileSync(join(home, "cardboard", "credentials.json"), JSON.stringify({ url: t.cb.url, ownerToken: t.owner }));
    env = { ...process.env, XDG_CONFIG_HOME: home, CARDBOARD_URL: "", CARDBOARD_OWNER: "" };
    delete env["CARDBOARD_URL"];
    delete env["CARDBOARD_OWNER"];
  });
  after(async () => {
    await t.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const cli = (args: string[], cwd?: string) => run(process.execPath, [CLI, ...args], { env, cwd });

  it("connects an app in one command and keeps the tape out of git", async () => {
    const appDir = join(home, "my-notes");
    mkdirSync(appDir);
    writeFileSync(join(appDir, ".gitignore"), "node_modules\n");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@gosinn/my-notes", description: "Notes for me", version: "0.3.0" }));
    const { stdout } = await cli(["connect", "--dir", appDir]);
    assert.match(stdout, /Made a box called .*my-notes/, "the box name comes from package.json");
    const boxes = await t.admin("boxes");
    const profile = boxes.body.boxes.find((b: any) => b.name === "my-notes").profile;
    assert.deepEqual(profile, { title: "@gosinn/my-notes", description: "Notes for me", version: "0.3.0" });

    const dotenv = readFileSync(join(appDir, ".env"), "utf8");
    assert.match(dotenv, /^CARDBOARD_URL=http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(dotenv, /^CARDBOARD_TAPE=cbt_[\w-]{43}$/m);
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
    const box = await cli(["box", "my-notes"]);
    assert.match(box.stdout, /If this tape leaks/);
    const log = await cli(["log", "my-notes"]);
    assert.match(log.stdout, /saved “hello”/);
    const insights = await cli(["insights"]);
    assert.match(insights.stdout, /backup/i);
    await cli(["set", "my-notes", "secrets", "block"]);
    const detail = await t.admin("box.get", { name: "my-notes" });
    assert.equal(detail.body.box.settings.secrets, "block");
    await assert.rejects(cli(["box", "nope"]), /There's no box called nope/);
  });

  it("docks apps from the command line", async () => {
    await t.admin("box.create", { name: "cli-sender" });
    await t.admin("box.create", { name: "cli-receiver" });
    const created = await cli(["dock", "create", "cli-dock", "--send", "cli-sender", "--receive", "cli-receiver"]);
    assert.match(created.stdout, /Opened .*cli-dock/);
    assert.match(created.stdout, /cli-sender can send, known there as berth-[0-9a-f]{12}/);

    await t.admin("box.create", { name: "cli-asker" });
    const asker = await t.admin("tape.create", { box: "cli-asker" });
    await t.app(asker.body.secret, "dock.send", { dock: "cli-dock", body: { hi: 1 } });
    const listed = await cli(["docks"]);
    assert.match(listed.stdout, /cli-asker wants to send on .*cli-dock/);
    await cli(["dock", "approve", "cli-dock", "cli-asker"]);
    const sent = await t.app(asker.body.secret, "dock.send", { dock: "cli-dock", body: { hi: 2 } });
    assert.equal(sent.status, 200);

    const peek = await cli(["dock", "peek", "cli-dock"]);
    assert.match(peek.stdout, /from .*cli-asker/);
    await cli(["dock", "set", "cli-dock", "personal", "block"]);
    await cli(["dock", "remove", "cli-dock", "cli-asker"]);
    const after = await t.app(asker.body.secret, "dock.send", { dock: "cli-dock", body: { hi: 3 } });
    assert.equal(after.body.error.code, "dock_pending");
  });

  it("manages Sign in with Cardboard from the command line", async () => {
    const added = await cli(["apps", "add", "Notes Web", "--redirect", "https://notes.example.com/callback"]);
    assert.match(added.stdout, /client_id\s+cbc_/);
    assert.match(added.stdout, /client_secret\s+cbs_/);
    const profile = await cli(["profile", "--name", "Gosinn", "--email", "gosinn@example.is"]);
    assert.match(profile.stdout, /Name:\s+Gosinn/);
    const apps = await cli(["apps"]);
    assert.match(apps.stdout, /Registered, not connected/);
    assert.match(apps.stdout, /Notes Web/);
  });

  it("starts a fresh Cardboard and prints the owner token once", async () => {
    const dataDir = join(home, "fresh-data");
    const child = spawn(process.execPath, [CLI, "start", "--port", "0", "--data", dataDir], { env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 15_000;
    while (!/Shake test/.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    assert.match(output, /Cardboard is open/);
    assert.match(output, /cbo_[\w-]{43}/);
    assert.match(output, /Shake test: \d+\/\d+ passed/);
    assert.doesNotMatch(output, /ExperimentalWarning/);
    const creds = JSON.parse(readFileSync(join(home, "cardboard", "credentials.json"), "utf8"));
    assert.match(creds.ownerToken, /^cbo_/);
  });
});
