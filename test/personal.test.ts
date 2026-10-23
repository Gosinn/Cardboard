import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  addFile,
  cleanValue,
  FILE_PART_BYTES,
  filePartKey,
  keepThing,
  keysOf,
  kindOfKey,
  listThings,
  purgeKeys,
  readFile,
  readRange,
  removeThing,
  restoreThing,
  safeUrl,
  saveFileDetails,
  saveThing,
  sendFile,
  sendText,
  strayParts,
  strongPassword,
  type FileValue,
  type Thing,
} from "../src/client/personal.ts";
import { toB64u } from "../src/client/crypto.ts";
import { recoverWithKit } from "../src/client/account.ts";
import { MemoryStore } from "../src/client/device.ts";
import { openDb } from "../src/server/db.ts";
import { CardboardError, open as openBox, type Box } from "../src/sdk/index.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

/** Records every operation the box sends, and how many bytes of sealed values come back. */
function spy(box: Box) {
  const seen: Array<{ op: string; body: Record<string, unknown>; valueBytes: number }> = [];
  const request = box.request.bind(box);
  box.request = (async (op: string, body: Record<string, unknown> = {}) => {
    const result = await request(op, body);
    const items = ((result as { items?: Array<{ value?: string }> }).items ?? []).concat((result as { item?: { value?: string } | null }).item ?? []);
    seen.push({ op, body, valueBytes: items.reduce((n, i) => n + (i?.value?.length ?? 0), 0) });
    return result;
  }) as Box["request"];
  return seen;
}

describe("your personal box", () => {
  let t: TestServer;
  let box: Box;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  it("is made once, and every device you sign in on finds it", async () => {
    assert.equal(await t.me.personalBox(), null);
    const made = await t.me.makePersonalBox();
    assert.equal(made.name, "personal");
    assert.equal((await t.me.makePersonalBox()).id, made.id, "asking again gives the same box");
    assert.equal((await t.me.me()).profile.personal, made.id);
    await t.me.setProfile({ name: "Gosinn" });
    assert.equal((await t.me.personalBox())?.id, made.id, "changing your name keeps it");
    box = await t.me.open(made);
  });

  it("keeps notes, passwords and links, newest change first", async () => {
    const note = await saveThing(box, "note", { title: "", text: "Ideas for the garden\nTomatoes by the wall" });
    assert.equal(note.value.title, "Ideas for the garden", "an empty title comes from the first line");
    const login = await saveThing(box, "password", { username: "me@example.com", password: "hunter2-but-longer", url: "accounts.google.com" });
    assert.equal(login.value.title, "accounts.google.com");
    assert.equal((login.value as { url: string }).url, "https://accounts.google.com/");
    await saveThing(box, "link", { url: "https://example.com/soup", notes: "the good soup" });

    const { things, other } = await listThings(box);
    assert.deepEqual(things.map((x) => x.kind).sort(), ["link", "note", "password"]);
    assert.equal(other, 0);
    assert.equal(things[0]!.kind, "link", "newest first");

    const edited = await saveThing(box, "note", { title: "Garden", text: "Tomatoes" }, { id: note.id, version: note.version });
    assert.equal(edited.version, note.version + 1);
    await rejectsWith(saveThing(box, "note", { text: "from the other phone" }, { id: note.id, version: note.version }), "version_conflict");
    assert.equal((await saveThing(box, "note", { text: "mine anyway" }, { id: note.id })).value.title, "mine anyway");
  });

  it("refuses links that aren't web addresses, and empty things", async () => {
    await rejectsWith(saveThing(box, "link", { url: "javascript:alert(1)" }), "bad_link");
    await rejectsWith(saveThing(box, "password", { title: "x", password: "" }), "empty_password");
    await rejectsWith(saveThing(box, "note", { title: " ", text: "" }), "empty_note");
    assert.equal(safeUrl("data:text/html,hi"), null);
    assert.equal(safeUrl("example.com/a b"), "https://example.com/a%20b");
    assert.deepEqual(cleanValue("link", { url: "http://x.is", junk: "dropped" }), { title: "x.is", url: "http://x.is/", notes: "" });
    assert.equal(kindOfKey("notes/abc"), "note");
    assert.equal(kindOfKey("notes/abc/1"), null);
    assert.equal(kindOfKey("file-data/abc/0"), null);
  });

  it("keeps files of any size in sealed parts, at their real size, never downloaded just to list them", async () => {
    const bytes = new Uint8Array(randomBytes(FILE_PART_BYTES * 2 + 1234));
    const before = (await t.me.box("personal")).bytes;
    let progress = 0;
    const file = await addFile(box, new File([bytes], "passport.jpg", { type: "image/jpeg" }), { onProgress: (f) => (progress = f) });
    assert.equal(progress, 1);
    assert.deepEqual([file.value.parts, file.value.partSize, file.value.hashOf, file.value.type], [3, FILE_PART_BYTES, "parts", "image/jpeg"]);
    assert.equal(file.value.title, "passport.jpg");
    assert.match(file.value.sha256, /^[0-9a-f]{64}$/);
    const grew = (await t.me.box("personal")).bytes - before;
    assert.ok(grew < bytes.length + 4096, `stored at its real size (${grew} bytes for ${bytes.length}), not a third more as text`);

    const seen = spy(box);
    const { things } = await listThings(box);
    assert.ok(things.some((x) => x.id === file.id));
    const fetched = seen.flatMap((s) => (s.op === "get.many" ? (s.body.idxs as string[]) : []));
    assert.equal(fetched.length, things.length, "only the things themselves were fetched, not the file's parts");
    assert.ok(seen.every((s) => s.valueBytes < 64 * 1024), "listing pulled no file bytes");

    assert.deepEqual(await readFile(box, file), bytes);
    const renamed = await saveFileDetails(box, file, { title: "Passport", notes: "expires 2031" });
    assert.equal(renamed.value.title, "Passport");
    assert.equal((renamed.value as FileValue).size, bytes.length);
  });

  it("reads any stretch of a file, fetching only the parts it's in", async () => {
    const bytes = new Uint8Array(randomBytes(FILE_PART_BYTES * 3 + 77));
    const file = await addFile(box, new File([bytes], "clip.webm", { type: "video/webm" }));
    const seen = spy(box);
    const cases: Array<[number, number]> = [[0, 1], [FILE_PART_BYTES - 5, FILE_PART_BYTES + 5], [10, FILE_PART_BYTES * 2 + 3], [bytes.length - 1, bytes.length - 1], [0, bytes.length - 1]];
    for (const [start, end] of cases) assert.deepEqual(await readRange(box, file, start, end), bytes.subarray(start, end + 1), `${start}-${end}`);
    const parts = seen.filter((s) => s.op === "get.many").map((s) => (s.body.idxs as string[]).length);
    assert.deepEqual(parts, [1, 2, 3, 1, 4]);
    await rejectsWith(readRange(box, file, 5, bytes.length), "bad_range");
    await rejectsWith(readRange(box, file, 9, 3), "bad_range");
  });

  it("can be stopped part way, leaving nothing behind", async () => {
    const stop = new AbortController();
    const bytes = new Uint8Array(FILE_PART_BYTES * 20);
    const sending = addFile(box, new File([bytes], "big.mov"), { signal: stop.signal, onProgress: (f) => f > 0.3 && stop.abort() });
    await assert.rejects(sending, (err: Error) => err.name === "AbortError");
    const { things } = await listThings(box);
    assert.ok(!things.some((x) => x.value.title === "big.mov"));
    assert.deepEqual(await strayParts(box, things), [], "the parts it sent were removed straight away");
  });

  it("cleans up after an upload that never finished", async () => {
    await box.batch([0, 1].map((n) => ({ op: "put" as const, key: filePartKey("abandoned", n), value: new Uint8Array([n]) })));
    const { things } = await listThings(box);
    assert.deepEqual(await strayParts(box, things), [], "too recent: it may still be going on another device");
    assert.deepEqual(await strayParts(box, things, Date.now() + 7 * 60 * 60 * 1000), [], "within two days it may still be carried on");
    assert.deepEqual(await strayParts(box, things, Date.now() + 3 * 24 * 60 * 60 * 1000, ["abandoned"]), [], "nor while this device means to carry it on");
    const stray = await strayParts(box, things, Date.now() + 3 * 24 * 60 * 60 * 1000);
    assert.deepEqual(stray.sort(), [filePartKey("abandoned", 0), filePartKey("abandoned", 1)]);
    await purgeKeys(box, stray);
    assert.equal(await box.get(filePartKey("abandoned", 0)), null);
  });

  it("still reads files saved before 0.6 (base64 parts, whole-file hash)", async () => {
    const bytes = new Uint8Array(randomBytes(512 * 1024 + 99));
    const id = "oldfile";
    await box.batch([0, 1].map((n) => ({ op: "put" as const, key: filePartKey(id, n), value: toB64u(bytes.subarray(n * 512 * 1024, (n + 1) * 512 * 1024)) })));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await box.put(`files/${id}`, { title: "old.jpg", name: "old.jpg", type: "image/jpeg", size: bytes.length, parts: 2, sha256, notes: "" });
    const old = (await listThings(box)).things.find((x) => x.id === id) as Thing<FileValue>;
    assert.deepEqual(await readFile(box, old), bytes);
    assert.deepEqual(await readRange(box, old, 512 * 1024 - 2, 512 * 1024 + 2), bytes.subarray(512 * 1024 - 2, 512 * 1024 + 3));
    await purgeKeys(box, keysOf(old));
  });

  it("notices a damaged file instead of handing it back", async () => {
    const file = await addFile(box, new File([new Uint8Array([1, 2, 3, 4])], "a.bin"));
    await box.put(filePartKey(file.id, 0), new Uint8Array([1, 2, 3, 5]));
    await rejectsWith(readFile(box, file), "file_damaged");
    await box.put(filePartKey(file.id, 0), new Uint8Array([1, 2, 3]));
    await rejectsWith(readRange(box, file, 0, 1), "file_damaged");
    await box.delete(filePartKey(file.id, 0));
    await rejectsWith(readFile(box, file), "file_incomplete");
  });

  it("deletes things with their files, brings them back, or frees the space for good", async () => {
    const bytes = new Uint8Array(randomBytes(FILE_PART_BYTES + 10));
    const file = await addFile(box, new File([bytes], "will.pdf", { type: "application/pdf" }));
    await removeThing(box, file);
    assert.ok(!(await listThings(box)).things.some((x) => x.id === file.id));
    assert.equal(await box.get(filePartKey(file.id, 1)), null, "its parts went too");
    await restoreThing(box, file);
    const back = (await listThings(box)).things.find((x) => x.id === file.id) as Thing<FileValue>;
    assert.ok(back);
    assert.deepEqual(await readFile(box, back), bytes);

    await removeThing(box, back);
    await purgeKeys(box, keysOf(back));
    assert.deepEqual(await box.history(filePartKey(file.id, 1)), [], "no copy kept in history");
    await rejectsWith(restoreThing(box, back), "nothing_to_undo");
  });

  it("is searched for what you'd read, never for a password", async () => {
    const results = async (q: string) => (await t.me.search(q)).filter((r) => r.box === "personal");
    assert.equal((await results("hunter2")).length, 0, "the password itself isn't searched");
    const found = await results("me@example");
    assert.equal(found.length, 1);
    assert.ok(!found[0]!.snippet?.includes("hunter2"));
    assert.equal((await results("garden")).length, 0, "an old version isn't found either");
  });

  it("only warns about its passwords when an app can read them", async () => {
    const warned = async () => (await t.me.insights()).some((i) => i.box === "personal" && /password/.test(i.title));
    assert.equal(await warned(), false, "passwords belong in your personal box");
    const inventory = await t.me.inventory("personal");
    assert.ok(!inventory.collections.some((c) => c.name === "file-data"), "file bytes aren't labelled");
    const { tape } = await t.me.createTape("personal", { label: "some script" });
    assert.ok((await t.me.insights()).some((i) => i.box === "personal" && i.title === "An app can read the passwords in personal"));
    await t.me.revokeTape(tape.id);
  });

  it("stays sealed past the server", async () => {
    const canary = `canary-${Date.now()}`;
    await saveThing(box, "password", { title: canary, username: canary, password: canary, notes: canary });
    await addFile(box, new File([canary.repeat(100)], `${canary}.txt`, { type: "text/plain" }));
    t.cb.api.ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.ok(!readFileSync(join(t.cb.paths.dataDir, "cardboard.db")).includes(Buffer.from(canary)));
  });
});

describe("getMany", () => {
  it("fetches just the items you name, in your order, for apps too", async () => {
    const t = await startTestServer({ shake: false });
    try {
      const { box } = await t.newBox("notes-app");
      await box.batch([
        { op: "put", key: "a/1", value: 1 },
        { op: "put", key: "a/2", value: 2 },
        { op: "put", key: "b/1", value: "big".repeat(1000) },
      ]);
      assert.deepEqual((await box.getMany(["a/2", "missing", "a/1"])).map((i) => [i.key, i.value]), [["a/2", 2], ["a/1", 1]]);
      const seen = spy(box);
      assert.deepEqual((await box.items("a/")).map((i) => i.value), [1, 2]);
      assert.ok(seen.every((s) => s.valueBytes < 1000), "b/1's value was never fetched");
      assert.deepEqual((await box.items("", { skip: (k) => k.startsWith("b/") })).map((i) => i.key), ["a/1", "a/2"]);
      const res = await t.raw(null, "get.many", {});
      assert.equal(res.status, 401);
      const tooMany = await box.request("get.many", { idxs: Array(1001).fill("x".repeat(43)) }).catch((e: CardboardError) => e.code);
      assert.equal(tooMany, "bad_request");
      assert.ok((await t.me.log({ box: "notes-app", limit: 5 })).some((l) => /read 2 items/.test(l.text)));
    } finally {
      await t.stop();
    }
  });
});

describe("strong passwords", () => {
  it("are long, mixed, and skip look-alike characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = strongPassword();
      assert.equal(p.length, 20);
      assert.match(p, /[a-z]/);
      assert.match(p, /[A-Z]/);
      assert.match(p, /[2-9]/);
      assert.match(p, /[!#$%*+\-=?@^_]/);
      assert.doesNotMatch(p, /[lIO01]/);
      seen.add(p);
    }
    assert.equal(seen.size, 200);
    assert.equal(strongPassword(4).length, 12, "never shorter than 12");
  });
});

describe("keeping each value once", () => {
  it("stores bytes as bytes, keeps the live version once, and still undoes", async () => {
    const t = await startTestServer({ shake: false });
    try {
      const { box } = await t.newBox("bytes");
      const one = new Uint8Array(randomBytes(300_000));
      const two = new Uint8Array(randomBytes(300_000));
      await box.put("blob", one);
      assert.deepEqual(await box.get("blob"), one, "a Uint8Array comes back as one");
      await box.put("blob", two);
      await box.put("json", { a: 1 });
      const db = t.cb.api.ctx.db;
      const stored = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      assert.ok(stored("SELECT COALESCE(SUM(LENGTH(value)), 0) AS n FROM items") < 600_000 + 1000);
      assert.ok(stored("SELECT COALESCE(SUM(LENGTH(value)), 0) AS n FROM history") < 300_000 + 100, "history holds the old version only, not a second copy of the live one");
      const versions = await box.history("blob");
      assert.deepEqual(versions.map((v) => v.value), [two, one]);
      await box.undo("blob");
      assert.deepEqual(await box.get("blob"), one);
      await box.delete("blob");
      await box.undo("blob");
      assert.deepEqual(await box.get("blob"), one, "a deleted value comes back too");
      assert.equal(stored("SELECT COUNT(*) AS n FROM history h JOIN items i ON i.box_id = h.box_id AND i.idx = h.idx AND i.version = h.version WHERE h.value IS NOT NULL"), 0);

      const exported = await t.me.exportBox("bytes");
      await t.me.createBox("bytes-copy");
      await t.me.importBox("bytes-copy", exported);
      assert.deepEqual(await (await t.me.open("bytes-copy")).get("blob"), one, "exports carry bytes");
    } finally {
      await t.stop();
    }
  });

  it("moves an older database over without losing a version", async () => {
    const t = await startTestServer({ shake: false });
    const file = join(t.cb.paths.dataDir, "cardboard.db");
    try {
      const { box } = await t.newBox("old");
      await box.put("k", { v: 1 });
      await box.put("k", { v: 2 });
    } finally {
      await t.cb.close();
    }
    // As 0.5 left it: the live version stored twice.
    let db = openDb(file);
    db.exec("UPDATE history SET value = (SELECT i.value FROM items i WHERE i.box_id = history.box_id AND i.idx = history.idx AND i.version = history.version) WHERE value IS NULL AND EXISTS (SELECT 1 FROM items i WHERE i.box_id = history.box_id AND i.idx = history.idx AND i.version = history.version)");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    // Back to just before the "each value once" migration (and the ones after it).
    db.exec("DROP TABLE pair_offers");
    db.exec("ALTER TABLE history DROP COLUMN temporary");
    db.exec(`PRAGMA user_version = ${version - 3}`);
    db.close();
    db = openDb(file);
    try {
      const rows = db.prepare("SELECT version, value IS NULL AS empty FROM history ORDER BY version").all() as Array<{ version: number; empty: number }>;
      assert.deepEqual(rows.slice(-2).map((r) => [r.version, r.empty]), [[1, 0], [2, 1]]);
    } finally {
      db.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe("room for files", () => {
  it("gives each person 10 GB and a personal box with no small limit of its own", async () => {
    const t = await startTestServer({ shake: false });
    try {
      assert.equal((await t.me.me()).quota.limit, 10 * 1024 ** 3);
      const box = await t.me.makePersonalBox();
      assert.equal(box.settings.quotaBytes, 1024 ** 4);
    } finally {
      await t.stop();
    }
  });

  it("never fills the disk: writes and backups stop with 1 GB left, and the host is told", async () => {
    let free = 50 * 1024 ** 3;
    const t = await startTestServer({ shake: false, diskFree: () => free });
    try {
      const { box } = await t.newBox("photos");
      await box.put("a", new Uint8Array(1000));
      free = 1024 ** 3 + 500;
      await rejectsWith(box.put("b", new Uint8Array(1000)), "disk_full");
      assert.throws(() => t.cb.api.backup(), (err: CardboardError) => err.code === "disk_full");
      assert.equal(t.cb.api.backupIfDue(1000), false, "a scheduled backup waits for room instead");
      const insights = t.cb.api.computeHostInsights();
      assert.ok(insights.some((i) => i.level === "danger" && /GB of disk left/.test(i.title)), JSON.stringify(insights));
      free = 50 * 1024 ** 3;
      await box.put("b", new Uint8Array(1000));
      assert.equal(t.cb.api.backup().kept, 10);
    } finally {
      await t.stop();
    }
  });

  it("shake-tests the disk guard without touching anyone else's writes", async () => {
    const t = await startTestServer({ diskFree: () => 50 * 1024 ** 3 });
    try {
      const check = t.cb.shake!.results.find((r) => r.id === "disk-guard");
      assert.equal(check?.status, "pass", JSON.stringify(check));
      const { box } = await t.newBox("after-shake");
      await box.put("x", 1);
    } finally {
      await t.stop();
    }
  });
});

describe("sending things to yourself", () => {
  it("lands on your other devices, live, until you keep it or clear it", async () => {
    const t = await startTestServer({ shake: false });
    try {
      const laptop = await t.me.open(await t.me.makePersonalBox());
      const phoneAccount = await recoverWithKit({ url: t.cb.url, code: t.kit, store: new MemoryStore(), kind: "browser", label: "phone" });
      const phone = await phoneAccount.open((await phoneAccount.personalBox())!);
      const heard: Array<{ key: string; value: unknown }> = [];
      let ready!: () => void;
      const listening = new Promise<void>((resolve) => (ready = resolve));
      const watcher = phone.watch((change) => heard.push({ key: change.key, value: change.value }), { onReady: () => ready() });
      await listening;

      const link = await sendText(laptop, "https://example.com/recipe", "laptop");
      const note = await sendText(laptop, "Door code 4512\nfor Saturday", "laptop");
      const file = await sendFile(laptop, new File([new Uint8Array(randomBytes(FILE_PART_BYTES + 5))], "scan.pdf", { type: "application/pdf" }), "laptop");
      assert.deepEqual([link.kind, link.value.inbox, link.value.from, (link.value as { url: string }).url], ["link", true, "laptop", "https://example.com/recipe"]);
      assert.deepEqual([note.kind, note.value.title], ["note", "Door code 4512"]);
      assert.equal(file.value.inbox, true);
      await rejectsWith(sendText(laptop, "   ", "laptop"), "nothing_to_send");

      await new Promise((r) => setTimeout(r, 300));
      watcher.close();
      const keys = heard.map((h) => h.key);
      for (const k of [link.key, note.key, file.key]) assert.ok(keys.includes(k), `the phone heard about ${k}`);
      assert.ok(heard.every((h) => h.value === undefined), "devices hear what changed, not the contents (no file streamed to every device)");

      const arrived = (await listThings(phone)).things.filter((x) => x.value.inbox);
      assert.equal(arrived.length, 3);
      const kept = await keepThing(phone, arrived.find((x) => x.key === note.key)!);
      assert.equal(kept.value.inbox, undefined);
      assert.equal((kept.value as { text: string }).text, "Door code 4512\nfor Saturday");
      assert.equal((await listThings(laptop)).things.filter((x) => x.value.inbox).length, 2);
    } finally {
      await t.stop();
    }
  });

  it("can't be listened to by anyone else, and stops when a device is removed", async () => {
    const t = await startTestServer({ shake: false });
    try {
      const mine = await t.me.makePersonalBox();
      const { account: stranger } = await t.newAccount();
      const res = await fetch(`${t.cb.url}/v1/watch`, {
        method: "POST",
        headers: { authorization: `Bearer ${(stranger as unknown as { rpc: { token: string } }).rpc.token}`, "content-type": "application/json", origin: t.cb.url },
        body: JSON.stringify({ box: mine.id }),
      });
      assert.equal(res.status, 404, "another person's box looks like no box");
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "no_such_box");

      const phoneAccount = await recoverWithKit({ url: t.cb.url, code: t.kit, store: new MemoryStore(), kind: "browser", label: "phone" });
      const phone = await phoneAccount.open((await phoneAccount.personalBox())!);
      let ready!: () => void;
      let errored = false;
      const listening = new Promise<void>((resolve) => (ready = resolve));
      const watcher = phone.watch(() => {}, { onReady: () => ready(), onError: () => (errored = true) });
      await listening;
      const phoneId = (await phoneAccount.me()).devices.find((d) => d.current)!.id;
      await t.me.removeDevice(phoneId);
      await new Promise((r) => setTimeout(r, 1500));
      watcher.close();
      assert.ok(errored, "the removed phone's live connection was closed and couldn't come back");
    } finally {
      await t.stop();
    }
  });
});

describe("friend boxes", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());
  const secretOf = (link: string) => link.split("#friend=")[1]!;

  it("opens with nothing but its link: play, download, and add when you let them", async () => {
    await t.me.setProfile({ name: "Gosinn" });
    const { box, link } = await t.me.makeFriendBox({ title: "Trip videos", write: true, expires: "7d" });
    assert.match(link.link, /^http:\/\/127\.0\.0\.1:\d+\/#friend=cbt_[A-Za-z0-9_-]{86}$/);
    assert.ok(link.write && link.expiresAt! > Date.now());
    const mine = await t.me.open(box);
    const video = new Blob([randomBytes(FILE_PART_BYTES + 5000)], { type: "video/mp4" });
    await addFile(mine, video, { name: "trip.mp4" });

    const friend = openBox({ url: t.cb.url, tape: secretOf(link.link), onNotice: false });
    assert.deepEqual(await friend.get("friend/about"), { title: "Trip videos", from: "Gosinn" });
    const { things } = await listThings(friend);
    assert.equal(things.length, 1);
    const bytes = await readFile(friend, things[0] as Thing<FileValue>);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.from(await video.arrayBuffer())).digest("hex"));
    await addFile(friend, new Blob(["back at you"]), { name: "reply.txt", sentFrom: "a friend" });
    assert.ok((await listThings(mine)).things.some((x) => x.value.title === "reply.txt"), "what the friend added is in your box");
    assert.ok((await t.me.friendBoxes())[box.id]?.link === link.link, "the link is kept (sealed) in your profile");
  });

  it("holds the key to that box only: a view-only link can't add, and nothing reaches your other boxes or keys", async () => {
    const { box: other } = await t.newBox("private-stuff");
    await other.put("secret", { pin: 1234 });
    const { link } = await t.me.makeFriendBox({ title: "Look only" });
    assert.equal(link.write, false);
    const friend = openBox({ url: t.cb.url, tape: secretOf(link.link), onNotice: false });
    await rejectsWith(friend.put("files/x", { title: "x" }), "read_only");
    assert.equal(await friend.get("secret"), null, "another box's items aren't there");
    // The link's bundle carries a names key made for it, not your account's.
    const who = await friend.ready();
    assert.notDeepEqual(Buffer.from(who.names.root), Buffer.from((t.me as unknown as { keys: { names: { root: Uint8Array } } }).keys.names.root));
  });

  it("collects: a link that can only add, and never see what's there", async () => {
    await t.me.setProfile({ name: "Gosinn" });
    const { box, link } = await t.me.makeFriendBox({ title: "Wedding photos", see: false });
    assert.equal(link.see, false);
    assert.equal(link.write, true);
    assert.match(link.link, /&title=Wedding%20photos&from=Gosinn$/, "the title travels in the link, after the #");
    const mine = await t.me.open(box);
    await addFile(mine, new Blob(["the couple's own"]), { name: "ours.jpg" });
    const guest = openBox({ url: t.cb.url, tape: secretOf(link.link.split("&")[0]!), onNotice: false });
    const added = await addFile(guest, new Blob(["a guest's photo"]), { name: "guest.jpg", sentFrom: "Siggi" });
    assert.equal(added.value.name, "guest.jpg");
    await rejectsWith(listThings(guest), "write_only");
    await rejectsWith(guest.get("friend/about"), "write_only");
    const seen = (await listThings(mine)).things.map((x) => `${x.value.title}${x.value.inbox ? ` from ${x.value.from}` : ""}`);
    assert.deepEqual(seen.sort(), ["guest.jpg from Siggi", "ours.jpg"]);
  });

  it("stops working when you stop it, or when it expires", async () => {
    const { box, link } = await t.me.makeFriendBox({ expires: "1d" });
    const friend = () => openBox({ url: t.cb.url, tape: secretOf(link.link), onNotice: false });
    assert.ok(await friend().get("friend/about"));
    const again = await t.me.newFriendLink(box.name, { expires: "1d" });
    await assert.rejects(friend().get("friend/about"), /was revoked/);
    t.clock.advance(2 * 24 * 60 * 60 * 1000);
    await assert.rejects(openBox({ url: t.cb.url, tape: secretOf(again.link), onNotice: false }).get("friend/about"), /expired/);
    const last = await t.me.newFriendLink(box.name);
    await t.me.stopFriendLink(box.name);
    await rejectsWith(openBox({ url: t.cb.url, tape: secretOf(last.link), onNotice: false }).get("friend/about"), "bad_tape");
    assert.equal((await t.me.friendBoxes())[box.id], null, "still a friend box, with no link");
    t.cb.api.limiter.reset("127.0.0.1");
  });
});

describe("big uploads that get cut off", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  /** A connection that drops for the `batch` calls numbered in `dropped` (1-based), and counts them. */
  const flaky = (dropped: Set<number>) => {
    let n = 0;
    const counter = { batches: 0 };
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/batch")) {
        n++;
        counter.batches++;
        if (dropped.has(n)) throw new TypeError("network error");
      }
      return fetch(input, init);
    }) as typeof fetch;
    return { fetchFn, counter };
  };

  it("tries again when the connection drops for a moment", async () => {
    const { link } = await t.me.makeFriendBox({ write: true });
    const { fetchFn } = flaky(new Set([2, 3]));
    const box = openBox({ url: t.cb.url, tape: link.link.split("#friend=")[1]!, fetch: fetchFn, onNotice: false });
    const data = randomBytes(FILE_PART_BYTES * 10);
    const thing = await addFile(box, new Blob([data]), { name: "video.mp4", retryMs: 5 });
    assert.ok(Buffer.from(await readFile(box, thing)).equals(data));
  });

  it("carries on where it stopped, sending only what's missing", async () => {
    const { link } = await t.me.makeFriendBox({ write: true });
    const tape = link.link.split("#friend=")[1]!;
    const data = randomBytes(FILE_PART_BYTES * 20);
    // The second batch (parts 9–16) never gets through, however often it's tried.
    const first = flaky(new Set([2, 3, 4, 5, 6, 7, 8, 9]));
    const box = openBox({ url: t.cb.url, tape, fetch: first.fetchFn, onNotice: false });
    const err = await addFile(box, new Blob([data]), { name: "film.mp4", keepPartsOnError: true, retryMs: 1 }).then(
      () => null,
      (e: { stopped?: { id: string; sentBytes: number } }) => e,
    );
    assert.ok(err?.stopped, "it says where it stopped");
    assert.equal(err.stopped.sentBytes, 8 * FILE_PART_BYTES);
    const again = flaky(new Set());
    const box2 = openBox({ url: t.cb.url, tape, fetch: again.fetchFn, onNotice: false });
    const thing = await addFile(box2, new Blob([data]), { name: "film.mp4", continueId: err.stopped.id, keepPartsOnError: true });
    assert.equal(again.counter.batches, 2, "only the 12 missing parts went (two batches)");
    assert.ok(Buffer.from(await readFile(box2, thing)).equals(data));
    assert.equal(thing.value.sha256, createHash("sha256").update(Buffer.concat(Array.from({ length: 20 }, (_, n) => createHash("sha256").update(data.subarray(n * FILE_PART_BYTES, (n + 1) * FILE_PART_BYTES)).digest()))).digest("hex"));
  });

  it("removes what was sent when you stop it, and when nobody will carry on", async () => {
    const { box: info, link } = await t.me.makeFriendBox({ write: true });
    const tape = link.link.split("#friend=")[1]!;
    const stop = flaky(new Set([2, 3, 4, 5, 6]));
    const box = openBox({ url: t.cb.url, tape, fetch: stop.fetchFn, onNotice: false });
    await assert.rejects(addFile(box, new Blob([randomBytes(FILE_PART_BYTES * 12)]), { name: "x", retryMs: 1 }));
    const mine = await t.me.open(info);
    assert.deepEqual(await mine.keys("file-data/"), [], "without keepPartsOnError, the parts sent are removed");
  });
});
