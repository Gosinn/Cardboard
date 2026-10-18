import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { addFile, cleanValue, FILE_PART_BYTES, filePartKey, kindOfKey, listThings, readFile, removeThing, restoreThing, safeUrl, saveFileDetails, saveThing, strongPassword, type FileValue, type Thing } from "../src/client/personal.ts";
import { CardboardError, type Box } from "../src/sdk/index.ts";
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

  it("keeps files of any size in sealed parts, never downloaded just to list them", async () => {
    const bytes = new Uint8Array(randomBytes(FILE_PART_BYTES * 2 + 1234));
    let progress = 0;
    const file = await addFile(box, { name: "passport.jpg", type: "image/jpeg", bytes }, { onProgress: (f) => (progress = f) });
    assert.equal(progress, 1);
    assert.equal(file.value.parts, 3);
    assert.equal(file.value.title, "passport.jpg");
    assert.match(file.value.sha256, /^[0-9a-f]{64}$/);

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

  it("notices a damaged file instead of handing it back", async () => {
    const file = await addFile(box, { name: "a.bin", type: "", bytes: new Uint8Array([1, 2, 3, 4]) });
    await box.put(filePartKey(file.id, 0), Buffer.from([1, 2, 3, 5]).toString("base64url"));
    await rejectsWith(readFile(box, file), "file_damaged");
    await box.delete(filePartKey(file.id, 0));
    await rejectsWith(readFile(box, file), "file_incomplete");
  });

  it("deletes things with their files, and brings them back", async () => {
    const bytes = new Uint8Array(randomBytes(FILE_PART_BYTES + 10));
    const file = await addFile(box, { name: "will.pdf", type: "application/pdf", bytes });
    await removeThing(box, file);
    assert.ok(!(await listThings(box)).things.some((x) => x.id === file.id));
    assert.equal(await box.get(filePartKey(file.id, 1)), null, "its parts went too");
    await restoreThing(box, file);
    const back = (await listThings(box)).things.find((x) => x.id === file.id) as Thing<FileValue>;
    assert.ok(back);
    assert.deepEqual(await readFile(box, back), bytes);
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
    await addFile(box, { name: `${canary}.txt`, type: "text/plain", bytes: new TextEncoder().encode(canary.repeat(100)) });
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
