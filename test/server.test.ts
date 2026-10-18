import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardboardError, open, type Change } from "../src/sdk/index.ts";
import { unlock } from "../src/client/account.ts";
import { MemoryStore } from "../src/client/device.ts";
import { startServer } from "../src/server/index.ts";
import { DAY, HOUR, startTestServer, tokenOf, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

/** Every byte the server has on disk: the database and its journal. */
function disk(t: TestServer): Buffer {
  t.cb.api.ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const wal = `${t.cb.paths.dbFile}-wal`;
  return Buffer.concat([readFileSync(t.cb.paths.dbFile), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);
}

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

  it("creates a private server key and a host token on first run", () => {
    assert.ok(t.cb.firstRun);
    assert.match(t.hostToken, /^cbh_/);
    assert.match(t.cb.firstInvite ?? "", /#invite=cbi_/);
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
    assert.equal(me.items, 2);
  });

  it("can't read anything: no names, values, labels or profiles on disk", async () => {
    await t.me.createBox("diary-8d1f2c");
    const { secret } = await t.me.createTape("diary-8d1f2c", { label: "phone-label-5b7e" });
    const box = open({ url: t.cb.url, tape: secret, onNotice: false });
    await box.put("diary/secret-plans-7f3a9", { text: "the treasure is under the oak 8c1e2" });
    await box.get("diary/secret-plans-7f3a9");
    await box.put("diary/secret-plans-7f3a9", { text: "the treasure is under the oak 8c1e2 (edited)" });
    await box.introduce({ title: "Diary app 4a4a" });
    await t.me.setProfile({ name: "Gosinn 6c6c", email: "gosinn-9d9d@example.is" });
    const raw = disk(t);
    for (const needle of ["secret-plans-7f3a9", "treasure is under the oak", "diary-8d1f2c", "phone-label-5b7e", "Diary app 4a4a", "Gosinn 6c6c", "gosinn-9d9d"]) {
      assert.ok(!raw.includes(Buffer.from(needle)), `${needle} leaked to disk`);
    }
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
    await new Promise((r) => setTimeout(r, 5));
    await recipes.add({ title: "Pancakes", stars: 4, tags: ["breakfast"] });
    await new Promise((r) => setTimeout(r, 5));
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

  it("refuses lost updates with ifVersion, and patch merges safely under contention", async () => {
    const { box, secret } = await t.newBox("concurrency");
    const { version } = await box.put("counter", 1);
    await box.put("counter", 2, { ifVersion: version });
    await rejectsWith(box.put("counter", 3, { ifVersion: version }), "version_conflict");
    await rejectsWith(box.put("counter", 3, { ifVersion: 0 }), "already_exists");
    const other = open({ url: t.cb.url, tape: secret, onNotice: false });
    await box.put("doc", { a: 1 });
    await Promise.all([box.patch("doc", { b: 2 }), other.patch("doc", { c: 3 })]);
    assert.deepEqual(await box.get("doc"), { a: 1, b: 2, c: 3 }, "both patches survive");
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
      { op: "patch", key: "obj", value: { x: 1 } },
      { op: "delete", key: "a" },
    ]);
    assert.equal(results.length, 4);
    assert.equal(await box.get("a"), null);
    assert.deepEqual(await box.get("obj"), { x: 1 });
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
    t.cb.api.ctx.vault.sweep();
    await rejectsWith(box.undo("otp"), "nothing_to_undo");
    await t.me.setBoxSettings("ttl", { defaultTtl: "1d" });
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
    const res = await t.me.rewind("rewind", "5m");
    assert.equal(res.changed, 3);
    assert.equal(await box.get("a"), 1);
    assert.equal(await box.get("b"), null);
    assert.equal(await box.get("c"), "kept");
    await rejectsWith(t.me.rewind("rewind", "400d"), "too_far_back");
  });

  it("keeps boxes apart, even when an app asks for another box's item by its exact id", async () => {
    const a = await t.newBox("iso-a");
    const b = await t.newBox("iso-b");
    await a.box.put("private", "only a");
    assert.equal(await b.box.get("private"), null);
    assert.deepEqual(await b.box.keys(), []);
    const listed = await t.raw(a.token, "list", {});
    const stolen = await t.raw(b.token, "get", { idx: listed.body.items[0].idx });
    assert.equal(stolen.body.item, null);
  });

  it("enforces what each tape may do", async () => {
    const { box } = await t.newBox("scoped");
    await box.put("public/hello", "hi");
    const ro = await t.me.createTape("scoped", { label: "ro", write: false });
    const readOnly = open({ url: t.cb.url, tape: ro.secret });
    assert.equal(await readOnly.get("public/hello"), "hi");
    await rejectsWith(readOnly.put("x", 1), "read_only");

    const wo = await t.me.createTape("scoped", { label: "wo", read: false });
    const writeOnly = open({ url: t.cb.url, tape: wo.secret, onNotice: false });
    await writeOnly.put("inbox/1", "drop");
    await rejectsWith(writeOnly.get("inbox/1"), "write_only");

    await t.me.revokeTape(ro.tape.id);
    await rejectsWith(readOnly.get("public/hello"), "bad_tape");
    const bundle = t.cb.api.ctx.db.prepare("SELECT bundle FROM tapes WHERE id = ?").get(ro.tape.id) as { bundle: Uint8Array | null };
    assert.equal(bundle.bundle, null, "revoking deletes the tape's sealed copy of the box key");
  });

  it("never needs (or keeps) the key half of a tape", async () => {
    const { secret } = await t.newBox("halves");
    const whole = await t.raw(secret, "whoami", {});
    assert.equal(whole.status, 401);
    assert.equal(whole.body.error.code, "whole_tape_sent");
    const keyHalf = Buffer.from(secret.slice(4), "base64url").subarray(32);
    assert.ok(!disk(t).includes(keyHalf), "the key half never reached the database");
  });

  it("switches tapes off after they go unused", async () => {
    await t.me.createBox("idle");
    const { secret } = await t.me.createTape("idle", { idle: "7d" });
    const box = open({ url: t.cb.url, tape: secret });
    await box.put("x", 1);
    t.clock.advance(3 * DAY);
    assert.equal(await box.get("x"), 1, "use resets the clock");
    t.clock.advance(8 * DAY);
    await assert.rejects(box.get("x"), /went unused for 7 days/);
  });

  it("spots sensitive data here, on opened data, and can refuse secrets", async () => {
    const notices: string[] = [];
    await t.me.createBox("sensitive");
    const { secret } = await t.me.createTape("sensitive");
    const box = open({ url: t.cb.url, tape: secret, onNotice: (n) => notices.push(n) });
    await box.put("settings/ai", { apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123" });
    await box.put("users/1", { email: "anna@example.is", password: "$2b$12$abcdefghijklmnopqrstuuJ5j5j5j5j5j5j5j5j5j5j5j5j5j5j5j" });
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /an OpenAI key/);

    const inv = await t.me.inventory("sensitive");
    assert.match(inv.summary, /1 API key or secret and 1 email address/);
    assert.deepEqual(inv.secretPaths, ["settings/ai → apiKey"]);
    const users = inv.collections.find((c) => c.name === "users")!;
    assert.deepEqual(users.fields.find((f) => f.name === "email")!.sensitive, ["email"]);
    const info = await t.me.box("sensitive");
    assert.match((await t.me.blast(info.tapes[0]!, info)).summary, /including 1 API key or secret and 1 email address/);
    assert.ok((await t.me.insights()).some((i) => i.title === "sensitive is holding 1 API key or secret"));
    const log = await t.me.log({ box: "sensitive" });
    assert.ok(log.some((l) => /saved “settings\/ai” \(.*OpenAI key/.test(l.text)), "the log says what was spotted (sealed on the server)");

    await t.me.setBoxSettings("sensitive", { secrets: "block" });
    const fresh = open({ url: t.cb.url, tape: secret, onNotice: false });
    await rejectsWith(fresh.put("more", { token: "ghp_" + "a".repeat(36) }), "secret_blocked");
  });

  it("streams live changes (sealed on the wire), and drops them when the tape is revoked", async () => {
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
    await t.me.revokeTape(tapeId);
    await waitFor(() => errors.some((e) => e instanceof CardboardError && e.code === "bad_tape"), 5000);
    watcher.close();
  });

  it("logs who did what, readable only on your devices", async () => {
    const { box } = await t.newBox("audited");
    await box.put("journal/today", "secret-entry-91c");
    await box.get("journal/today");
    const texts = (await t.me.log({ box: "audited" })).map((e) => e.text);
    assert.ok(texts.includes("audited (tape “default”) read “journal/today”"), texts.join("\n"));
    assert.ok(texts.includes("audited (tape “default”) saved “journal/today”"));
    assert.ok(texts.includes("You (this device) created the box audited"));
    const raw = t.cb.api.ctx.db.prepare("SELECT ref, detail FROM log").all() as Array<{ ref: Uint8Array | null; detail: Uint8Array | null }>;
    assert.ok(raw.every((r) => ![r.ref, r.detail].some((b) => b && Buffer.from(b).includes(Buffer.from("journal/today")))));
  });

  it("exports and imports (moving day)", async () => {
    const { box } = await t.newBox("moving-out");
    await box.put("a", { n: 1 });
    await box.put("b", [1, 2, 3]);
    const exported = await t.me.exportBox("moving-out");
    assert.equal(exported.items.length, 2);
    const target = await t.newBox("moving-in");
    const imported = await t.me.importBox("moving-in", exported);
    assert.equal(imported.imported, 2);
    assert.deepEqual(await target.box.get("b"), [1, 2, 3]);
  });

  it("shreds a box: data, key, tapes and log, for good", async () => {
    const { box } = await t.newBox("shred-me");
    await box.put("x", "gone soon");
    const id = (await t.me.box("shred-me")).id;
    const refused = await t.raw(t.me.rpc.token, "box.shred", { box: id, confirm: "nope" });
    assert.equal(refused.body.error.code, "confirm_shred");
    await t.me.shredBox("shred-me");
    await rejectsWith(box.get("x"), "bad_tape");
    for (const table of ["boxes", "items", "history", "tapes"]) {
      const col = table === "boxes" ? "id" : "box_id";
      const left = t.cb.api.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number };
      assert.equal(left.n, 0, `${table} still has rows`);
    }
  });

  it("enforces quotas and item size (on sealed bytes)", async () => {
    await t.me.createBox("tiny", { quotaBytes: 150, maxItemBytes: 110 });
    const { secret } = await t.me.createTape("tiny");
    const box = open({ url: t.cb.url, tape: secret });
    await box.put("a", "x".repeat(40));
    await rejectsWith(box.put("b", "x".repeat(90)), "too_large");
    await rejectsWith(box.put("c", "x".repeat(70)), "quota_exceeded");
  });

  it("finds things across every box, searching on your device", async () => {
    const { box } = await t.newBox("findable");
    await box.put("recipes/x", { title: "Grandma's kjötsúpa" });
    const results = await t.me.search("kjötsúpa");
    assert.deepEqual(results.map((r) => [r.box, r.key]), [["findable", "recipes/x"]]);
  });
});

describe("accounts and the host", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  it("keeps people apart: someone else's box looks like no box", async () => {
    const { box } = await t.newBox("mine");
    await box.put("x", 1);
    const { account: other } = await t.newAccount();
    const mineId = (await t.me.box("mine")).id;
    await rejectsWith(other.rpc.call("list", { box: mineId }), "no_such_box");
    await rejectsWith(other.rpc.call("box.settings", { box: mineId, settings: { secrets: "block" } }), "no_such_box");
    assert.deepEqual(await other.boxes(), []);
    const theirLog = await other.log();
    assert.ok(theirLog.every((l) => !l.text.includes("mine")));
  });

  it("lets the host run things without seeing anything", async () => {
    const accounts = await t.host("host.accounts");
    assert.equal(accounts.status, 200);
    const view = JSON.stringify(accounts.body);
    assert.ok(!/"(name|profile|label|key|envelope)"/.test(view), view);
    assert.ok(accounts.body.accounts.length >= 1);
    const asHost = await t.raw(t.hostToken, "get", { box: "x", idx: "x".repeat(43) });
    assert.equal(asHost.status, 404, "items aren't a host operation at all");
    const asApp = await t.raw(t.hostToken.replace("cbh_", "cbt_"), "boxes", {});
    assert.equal(asApp.status, 401);
  });

  it("sets per-person quotas and deletes accounts with everything in them", async () => {
    const { account } = await t.newAccount();
    await t.host("host.account.quota", { id: account.id, quota: "1KB" });
    await account.createBox("small");
    const { secret } = await account.createTape("small");
    const box = open({ url: t.cb.url, tape: secret });
    await box.put("a", "x".repeat(500));
    await rejectsWith(box.put("b", "x".repeat(600)), "account_full");
    const refused = await t.host("host.account.delete", { id: account.id, confirm: "no" });
    assert.equal(refused.body.error.code, "confirm_delete");
    await t.host("host.account.delete", { id: account.id, confirm: account.id });
    await rejectsWith(box.get("a"), "bad_tape");
    await rejectsWith(account.me(), "bad_device");
    const left = t.cb.api.ctx.db.prepare("SELECT COUNT(*) AS n FROM boxes WHERE account_id = ?").get(account.id) as { n: number };
    assert.equal(left.n, 0);
  });

  it("makes backups and stops nagging about them", async () => {
    const tip = async () => (await t.host("host.overview")).body.insights.some((i: any) => /backup/i.test(i.title));
    assert.ok(await tip());
    const res = await t.host("host.backup");
    assert.ok(existsSync(res.body.file));
    assert.ok(!(await tip()));
  });

  it("backs up on a schedule when asked to", async () => {
    assert.equal(t.cb.api.backupIfDue(DAY), false, "a backup was just made");
    t.clock.advance(DAY + 1000);
    assert.equal(t.cb.api.backupIfDue(DAY), true);
    const lines = (await t.host("host.log")).body.entries.filter((e: any) => e.action === "backup");
    assert.equal(lines[0].actor, "system");
  });
});

describe("HTTP edges", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  it("serves the dashboard with a strict CSP, and its crypto from the same code as the SDK", async () => {
    const res = await fetch(`${t.cb.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(await res.text(), /<title>Cardboard<\/title>/);
    const lib = await fetch(`${t.cb.url}/lib/client/crypto.ts`);
    assert.equal(lib.status, 200);
    assert.match(lib.headers.get("content-type") ?? "", /javascript/);
    const code = await lib.text();
    assert.match(code, /export async function seal/);
    assert.doesNotMatch(code, /: Uint8Array/, "types are stripped");
    assert.equal((await fetch(`${t.cb.url}/lib/server/crypto.ts`)).status, 404, "server code isn't served");
    assert.equal((await fetch(`${t.cb.url}/lib/client/../server/db.ts`)).status, 404);
    assert.equal((await fetch(`${t.cb.url}/boot.js`)).status, 200, "the safety net that says when the dashboard's code didn't load");
  });

  it("only speaks JSON", async () => {
    const res = await fetch(`${t.cb.url}/v1/get`, { method: "POST", body: "key=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(res.status, 415);
  });

  it("explains missing and wrong tokens", async () => {
    const res = await t.raw(null, "get", {});
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "no_token");
    const wrong = await t.raw("cbx_nope", "boxes", {});
    assert.equal(wrong.body.error.code, "bad_token");
    const host = await t.raw("cbh_wrong", "host.overview", {});
    assert.equal(host.body.error.code, "not_host");
  });

  it("only lets allowed websites in", async () => {
    await t.me.createBox("web", { origins: ["https://notes.example.com"] });
    const { secret } = await t.me.createTape("web");
    const token = tokenOf(secret);
    const preflight = (origin: string) => fetch(`${t.cb.url}/v1/get`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    const ok = await preflight("https://notes.example.com");
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://notes.example.com");
    assert.equal((await preflight("https://evil.example")).status, 403);
    const fromEvil = await t.raw(token, "whoami", {}, { origin: "https://evil.example" });
    assert.equal(fromEvil.status, 403);
    const fromApp = await t.raw(token, "whoami", {}, { origin: "https://notes.example.com" });
    assert.equal(fromApp.status, 200);
    assert.equal(fromApp.headers.get("access-control-allow-origin"), "https://notes.example.com");
    const deviceFromWeb = await t.raw(t.me.rpc.token, "boxes", {}, { origin: "https://notes.example.com" });
    assert.equal(deviceFromWeb.status, 403);
  });

  it("slows down guessing", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await t.raw(`cbt_guess${i}`, "whoami", {})).status;
    assert.equal(last, 429);
  });
});

describe("restarts and keys", () => {
  it("keeps data across restarts and refuses the wrong server key", async () => {
    const t = await startTestServer({ shake: false });
    const { secret, box } = await t.newBox("persist");
    await box.put("hello", "world");
    const store = new MemoryStore();
    const record = await (t.me as unknown as { store: MemoryStore }).store.load();
    await store.save(record!);
    const { dataDir, keyFile } = t.cb.paths;
    await t.cb.close();

    const again = await startServer({ dataDir, port: 0, shake: false });
    assert.equal(again.firstRun, false);
    assert.equal(again.hostToken, undefined, "the host token is only shown once");
    assert.equal(await open({ url: again.url, tape: secret }).get("hello"), "world");
    await store.save({ ...record!, url: again.url });
    const reopened = await unlock(store);
    assert.equal((await reopened!.boxes())[0]!.name, "persist", "your device opens your account again");
    await again.close();

    const original = readFileSync(keyFile);
    writeFileSync(keyFile, `cbk2:${Buffer.alloc(32, 7).toString("base64")}\n`);
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

  it("recognises a Cardboard 0.1 data folder instead of half-migrating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cardboard-old-"));
    const old = new DatabaseSync(join(dir, "cardboard.db"));
    old.exec("CREATE TABLE boxes (id TEXT); PRAGMA user_version = 5;");
    old.close();
    writeFileSync(join(dir, "master.key"), "cbk1:x\n");
    await assert.rejects(startServer({ dataDir: dir, port: 0, shake: false }), (err: any) => err.code === "old_data" && /Export your boxes/.test(err.hint));
    rmSync(dir, { recursive: true, force: true });
  });
});

async function waitFor(condition: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
