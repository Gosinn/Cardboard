import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { CardboardError, open, type Change } from "../src/sdk/index.ts";
import { startServer } from "../src/server/index.ts";
import { DAY, HOUR, startTestServer, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

describe("Cardboard server", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.stop());

  it("passes its own shake test on startup", () => {
    assert.ok(t.cb.shake?.ok, JSON.stringify(t.cb.shake?.results.filter((r) => r.status !== "pass")));
    assert.equal(t.cb.shake?.failed, 0);
  });

  it("creates a private master key on first run", () => {
    assert.ok(t.cb.firstRun);
    assert.match(t.owner, /^cbo_/);
    assert.equal(statSync(t.cb.paths.keyFile).mode & 0o077, 0);
  });

  it("stores, reads, lists and deletes", async () => {
    const { box } = await t.newBox("basics");
    assert.equal(await box.get("nothing"), null);
    const w = await box.put("settings/theme", { mode: "dark" });
    assert.equal(w.version, 1);
    assert.deepEqual(await box.get("settings/theme"), { mode: "dark" });
    assert.ok(await box.has("settings/theme"));
    await box.put("settings/lang", "is");
    await box.put("other", 1);
    assert.deepEqual(await box.keys("settings/"), ["settings/lang", "settings/theme"]);
    assert.equal(await box.delete("other"), true);
    assert.equal(await box.delete("other"), false);
    assert.equal(await box.get("other"), null);
    const me = await box.whoami();
    assert.equal(me.box, "basics");
    assert.equal(me.items, 2);
  });

  it("never writes key names or values to disk in plain text", async () => {
    const { box } = await t.newBox("at-rest");
    const canaryKey = "diary/secret-plans-7f3a9";
    const canaryValue = "the treasure is under the oak 8c1e2";
    await box.put(canaryKey, { text: canaryValue });
    await box.get(canaryKey);
    await box.put(canaryKey, { text: `${canaryValue} (edited)` });
    t.cb.api.ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const raw = readFileSync(t.cb.paths.dbFile);
    assert.ok(!raw.includes(Buffer.from("secret-plans-7f3a9")), "key name leaked");
    assert.ok(!raw.includes(Buffer.from("treasure is under the oak")), "value leaked");
  });

  it("keeps every version: history, undo, redo and undelete", async () => {
    const { box } = await t.newBox("history");
    await box.put("doc", { v: 1 });
    await box.put("doc", { v: 2 });
    assert.deepEqual((await box.history("doc")).map((v) => v.version), [2, 1]);
    const undone = await box.undo("doc");
    assert.equal(undone.restored, 1);
    assert.deepEqual(await box.get("doc"), { v: 1 });
    await box.undo("doc");
    assert.deepEqual(await box.get("doc"), { v: 2 }, "undoing an undo is a redo");
    await box.delete("doc");
    await box.undo("doc");
    assert.deepEqual(await box.get("doc"), { v: 2 }, "deletes can be undone");
    await box.undo("doc", { to: 1 });
    assert.deepEqual(await box.get("doc"), { v: 1 });
    await box.delete("doc", { purge: true });
    await rejectsWith(box.undo("doc"), "nothing_to_undo");
  });

  it("collections: add, find, update, count, remove", async () => {
    const { box } = await t.newBox("recipes");
    const recipes = box.collection<{ title: string; stars: number; tags: string[] }>("recipes");
    const lasagna = await recipes.add({ title: "Lasagna", stars: 5, tags: ["dinner"] });
    t.clock.advance(1000);
    await recipes.add({ title: "Pancakes", stars: 4, tags: ["breakfast"] });
    t.clock.advance(1000);
    await recipes.add({ title: "Soup", stars: 3, tags: ["dinner"] });
    assert.match(lasagna.id, /^[0-9a-z]+$/);
    assert.deepEqual((await recipes.find({ where: { tags: "dinner" }, sort: "-stars" })).map((r) => r.title), ["Lasagna", "Soup"]);
    assert.deepEqual((await recipes.all()).map((r) => r.title), ["Lasagna", "Pancakes", "Soup"], "ids sort by creation");
    assert.equal(await recipes.count({ stars: { $gte: 4 } }), 2);
    const updated = await recipes.update(lasagna.id, { stars: 4, tags: null });
    assert.deepEqual(updated, { id: lasagna.id, title: "Lasagna", stars: 4 });
    assert.equal((await recipes.findOne({ title: "Soup" }))?.stars, 3);
    assert.ok(await recipes.remove(lasagna.id));
    assert.equal(await recipes.count(), 2);
    await recipes.add({ id: "fixed", title: "Fixed", stars: 1, tags: [] } as never);
    await rejectsWith(recipes.add({ id: "fixed", title: "Again", stars: 1, tags: [] } as never), "already_exists");
  });

  it("refuses lost updates with ifVersion", async () => {
    const { box } = await t.newBox("concurrency");
    const { version } = await box.put("counter", 1);
    await box.put("counter", 2, { ifVersion: version });
    await rejectsWith(box.put("counter", 3, { ifVersion: version }), "version_conflict");
    await rejectsWith(box.put("counter", 3, { ifVersion: 0 }), "already_exists");
  });

  it("runs batches atomically", async () => {
    const { box } = await t.newBox("batch");
    await box.put("a", 1);
    await rejectsWith(
      box.batch([
        { op: "put", key: "b", value: 2 },
        { op: "put", key: "a", value: 9, ifVersion: 42 },
      ]),
      "version_conflict",
    );
    assert.equal(await box.get("b"), null, "first op was rolled back");
    const results = await box.batch([
      { op: "put", key: "b", value: 2 },
      { op: "add", collection: "log", value: { msg: "hi" } },
      { op: "delete", key: "a" },
    ]);
    assert.equal(results.length, 3);
    assert.equal(await box.get("a"), null);
    assert.equal((await box.keys("log/")).length, 1);
  });

  it("expires items, and expired data can't be undone back", async () => {
    const { box } = await t.newBox("ttl");
    await box.put("otp", { code: 123456 }, { ttl: "1h" });
    await box.put("keep", true);
    assert.deepEqual(await box.get("otp"), { code: 123456 });
    t.clock.advance(2 * HOUR);
    assert.equal(await box.get("otp"), null);
    assert.deepEqual(await box.keys(), ["keep"]);
    t.cb.vault.sweep();
    await rejectsWith(box.undo("otp"), "nothing_to_undo");
    await t.admin("box.settings", { name: "ttl", settings: { defaultTtl: "1d" } });
    await box.put("temp", 1);
    t.clock.advance(2 * DAY);
    assert.equal(await box.get("temp"), null);
  });

  it("rewinds a whole box to an earlier moment", async () => {
    const { box } = await t.newBox("rewind");
    await box.put("a", 1);
    await box.put("c", "kept");
    t.clock.advance(10 * 60_000);
    await box.put("a", 2);
    await box.put("b", "new");
    await box.delete("c");
    const res = await t.admin("box.rewind", { name: "rewind", to: "5m" });
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, 3);
    assert.equal(await box.get("a"), 1);
    assert.equal(await box.get("b"), null);
    assert.equal(await box.get("c"), "kept");
    const tooFar = await t.admin("box.rewind", { name: "rewind", to: "400d" });
    assert.equal(tooFar.body.error.code, "too_far_back");
  });

  it("keeps boxes apart", async () => {
    const a = await t.newBox("iso-a");
    const b = await t.newBox("iso-b");
    await a.box.put("private", "only a");
    assert.equal(await b.box.get("private"), null);
    assert.deepEqual(await b.box.keys(), []);
  });

  it("enforces what each tape may do", async () => {
    const { box, secret } = await t.newBox("scoped");
    await box.put("public/hello", "hi");
    await box.put("private/diary", "secret");

    const ro = await t.admin("tape.create", { box: "scoped", label: "ro", write: false });
    const readOnly = open({ url: t.cb.url, tape: ro.body.secret });
    assert.equal(await readOnly.get("public/hello"), "hi");
    await rejectsWith(readOnly.put("x", 1), "read_only");

    const wo = await t.admin("tape.create", { box: "scoped", label: "wo", read: false });
    const writeOnly = open({ url: t.cb.url, tape: wo.body.secret, onNotice: false });
    await writeOnly.put("inbox/1", "drop");
    await rejectsWith(writeOnly.get("inbox/1"), "write_only");

    const pf = await t.admin("tape.create", { box: "scoped", label: "public", prefix: "public/" });
    assert.match(pf.body.blast.summary, /under “public\/”/);
    const limited = open({ url: t.cb.url, tape: pf.body.secret });
    assert.equal(await limited.get("public/hello"), "hi");
    await rejectsWith(limited.get("private/diary"), "outside_prefix");
    assert.deepEqual(await limited.keys(), ["public/hello"], "listing is narrowed to the prefix");
    await rejectsWith(limited.keys("private/"), "outside_prefix");
    await rejectsWith(limited.collection("private").add({ x: 1 }), "outside_prefix");

    const owner = open({ url: t.cb.url, tape: t.owner });
    await rejectsWith(owner.get("public/hello"), "owner_token_in_app");

    await t.admin("tape.revoke", { id: pf.body.tape.id });
    await rejectsWith(limited.get("public/hello"), "bad_tape");
    assert.ok(secret.startsWith("cbt_"));
  });

  it("switches tapes off after they go unused", async () => {
    const created = await t.admin("box.create", { name: "idle", idle: "7d" });
    const box = open({ url: t.cb.url, tape: created.body.secret });
    await box.put("x", 1);
    t.clock.advance(3 * DAY);
    assert.equal(await box.get("x"), 1, "use resets the clock");
    t.clock.advance(8 * DAY);
    await assert.rejects(box.get("x"), /went unused for 7 days/);
  });

  it("talks about sensitive data, and can refuse secrets", async () => {
    const notices: string[] = [];
    const created = await t.admin("box.create", { name: "sensitive" });
    const box = open({ url: t.cb.url, tape: created.body.secret, onNotice: (n) => notices.push(n) });
    await box.put("settings/ai", { apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123" });
    await box.put("users/1", { email: "anna@example.is", password: "$2b$12$abcdefghijklmnopqrstuuJ5j5j5j5j5j5j5j5j5j5j5j5j5j5j5j" });
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /an OpenAI key/);

    const detail = await t.admin("box.get", { name: "sensitive" });
    assert.match(detail.body.inventory.summary, /1 API key or secret and 1 email address/);
    assert.deepEqual(detail.body.inventory.secretPaths, ["settings/ai → apiKey"]);
    const users = detail.body.inventory.collections.find((c: any) => c.name === "users");
    assert.deepEqual(users.fields.find((f: any) => f.name === "email").sensitive, ["email"]);
    assert.match(detail.body.tapes[0].blast.summary, /including 1 API key or secret and 1 email address/);

    const insights = await t.admin("insights");
    assert.ok(insights.body.insights.some((i: any) => i.title === "sensitive is holding 1 API key or secret"));

    await t.admin("box.settings", { name: "sensitive", settings: { secrets: "block" } });
    await rejectsWith(box.put("more", { token: "ghp_" + "a".repeat(36) }), "secret_blocked");
  });

  it("streams live changes, and drops them when the tape is revoked", async () => {
    const { box, tapeId } = await t.newBox("live");
    const changes: Change[] = [];
    const errors: Error[] = [];
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const watcher = box.watch("notes/", (c) => changes.push(c), { onReady: ready, onError: (e) => errors.push(e) });
    await isReady;
    await box.put("notes/1", { text: "hello" });
    await box.put("elsewhere", 1);
    await box.delete("notes/1");
    await waitFor(() => changes.length >= 2);
    assert.deepEqual(
      changes.map((c) => [c.type, c.key]),
      [
        ["put", "notes/1"],
        ["delete", "notes/1"],
      ],
    );
    assert.deepEqual(changes[0]!.value, { text: "hello" });

    await t.admin("tape.revoke", { id: tapeId });
    await waitFor(() => errors.some((e) => e instanceof CardboardError && e.code === "bad_tape"), 5000);
    watcher.close();
  });

  it("logs who did what, readably, with details encrypted", async () => {
    const { box } = await t.newBox("audited");
    await box.put("journal/today", "secret-entry-91c");
    await box.get("journal/today");
    const log = await t.admin("log", { box: "audited" });
    const texts = log.body.entries.map((e: any) => e.text);
    assert.ok(texts.includes("audited (tape “default”) read “journal/today”"));
    assert.ok(texts.includes("audited (tape “default”) saved “journal/today”"));
    assert.ok(texts.includes("You created the box audited"));
    const raw = t.cb.api.ctx.db.prepare("SELECT detail_enc FROM log WHERE detail_enc IS NOT NULL").all() as Array<{ detail_enc: Uint8Array }>;
    assert.ok(raw.every((r) => !Buffer.from(r.detail_enc).includes(Buffer.from("journal/today"))));
  });

  it("exports and imports (moving day)", async () => {
    const { box } = await t.newBox("moving-out");
    await box.put("a", { n: 1 });
    await box.put("b", [1, 2, 3]);
    const exported = await t.admin("box.export", { name: "moving-out" });
    assert.equal(exported.body.items.length, 2);
    const target = await t.newBox("moving-in");
    const imported = await t.admin("box.import", { name: "moving-in", data: exported.body });
    assert.equal(imported.body.imported, 2);
    assert.deepEqual(await target.box.get("b"), [1, 2, 3]);
  });

  it("shreds a box: data, key, tapes and log, for good", async () => {
    const { box } = await t.newBox("shred-me");
    await box.put("x", "gone soon");
    const refused = await t.admin("box.shred", { name: "shred-me", confirm: "nope" });
    assert.equal(refused.body.error.code, "confirm_shred");
    const done = await t.admin("box.shred", { name: "shred-me", confirm: "shred-me" });
    assert.equal(done.body.shredded, "shred-me");
    await rejectsWith(box.get("x"), "bad_tape");
    const db = t.cb.api.ctx.db;
    const left = db.prepare("SELECT COUNT(*) AS n FROM boxes WHERE name = 'shred-me'").get() as { n: number };
    assert.equal(left.n, 0);
  });

  it("enforces quotas and item size", async () => {
    const created = await t.admin("box.create", { name: "tiny", settings: { quotaBytes: 100, maxItemBytes: 80 } });
    const box = open({ url: t.cb.url, tape: created.body.secret });
    await box.put("a", "x".repeat(40));
    await rejectsWith(box.put("b", "x".repeat(90)), "too_large");
    await rejectsWith(box.put("c", "x".repeat(70)), "quota_exceeded");
  });

  it("finds things across every box", async () => {
    const { box } = await t.newBox("findable");
    await box.put("recipes/x", { title: "Grandma's kjötsúpa" });
    const res = await t.admin("search", { q: "kjötsúpa" });
    assert.deepEqual(res.body.results.map((r: any) => [r.box, r.key]), [["findable", "recipes/x"]]);
  });

  it("makes encrypted backups and stops nagging about them", async () => {
    const tipBefore = (await t.admin("insights")).body.insights.some((i: any) => /backup/i.test(i.title));
    assert.ok(tipBefore);
    const res = await t.admin("backup");
    assert.ok(existsSync(res.body.file));
    const tipAfter = (await t.admin("insights")).body.insights.some((i: any) => /backup/i.test(i.title));
    assert.ok(!tipAfter);
  });
});

describe("HTTP edges", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  it("serves the dashboard with a strict CSP", async () => {
    const res = await fetch(`${t.cb.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(await res.text(), /<title>Cardboard<\/title>/);
  });

  it("only speaks JSON", async () => {
    const res = await fetch(`${t.cb.url}/v1/get`, { method: "POST", body: "key=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(res.status, 415);
  });

  it("explains missing tapes and wrong owner tokens", async () => {
    const res = await fetch(`${t.cb.url}/v1/get`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await res.json()) as any;
    assert.equal(res.status, 401);
    assert.equal(body.error.code, "no_tape");
    assert.match(body.error.hint, /cardboard connect/);
    const admin = await fetch(`${t.cb.url}/v1/admin/boxes`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cbo_wrong" }, body: "{}" });
    assert.equal(admin.status, 401);
  });

  it("only lets allowed websites in", async () => {
    const created = await t.admin("box.create", { name: "web", settings: { origins: ["https://notes.example.com"] } });
    const preflight = (origin: string) =>
      fetch(`${t.cb.url}/v1/get`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    const ok = await preflight("https://notes.example.com");
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://notes.example.com");
    assert.equal((await preflight("https://evil.example")).status, 403);
    const fromEvil = await t.app(created.body.secret, "get", { key: "x" }, { origin: "https://evil.example" });
    assert.equal(fromEvil.status, 403);
    const fromApp = await t.app(created.body.secret, "get", { key: "x" }, { origin: "https://notes.example.com" });
    assert.equal(fromApp.status, 200);
    assert.equal(fromApp.headers.get("access-control-allow-origin"), "https://notes.example.com");
    const adminFromWeb = await t.admin("boxes", {}, { origin: "https://notes.example.com" });
    assert.equal(adminFromWeb.status, 403);
  });

  it("slows down tape guessing", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await t.app(`cbt_guess${i}`, "get", { key: "x" })).status;
    assert.equal(last, 429);
  });
});

describe("restarts and keys", () => {
  it("keeps data across restarts and refuses the wrong key", async () => {
    const t = await startTestServer({ shake: false });
    const { box } = await t.newBox("persist");
    await box.put("hello", "world");
    const { dataDir, keyFile } = t.cb.paths;
    await t.cb.close();

    const again = await startServer({ dataDir, port: 0, shake: false });
    assert.equal(again.firstRun, false);
    assert.equal(again.ownerToken, undefined, "the owner token is only shown once");
    const res = await fetch(`${again.url}/v1/admin/tape.create`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.owner}`, "content-type": "application/json" },
      body: JSON.stringify({ box: "persist" }),
    });
    const { secret } = (await res.json()) as { secret: string };
    assert.equal(await open({ url: again.url, tape: secret }).get("hello"), "world");
    await again.close();

    const original = readFileSync(keyFile);
    writeFileSync(keyFile, `cbk1:${Buffer.alloc(32, 7).toString("base64")}\n`);
    await assert.rejects(startServer({ dataDir, port: 0, shake: false }), (err: any) => err.code === "wrong_key");
    writeFileSync(keyFile, "");
    await assert.rejects(startServer({ dataDir, port: 0, shake: false }), (err: any) => err.code === "bad_key_file");
    rmSync(keyFile);
    await assert.rejects(startServer({ dataDir, port: 0, shake: false }), (err: any) => err.code === "missing_key");
    writeFileSync(keyFile, original);
    const fine = await startServer({ dataDir, port: 0, shake: false });
    await fine.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
});

async function waitFor(condition: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
