import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { moveData, storageTarget } from "../src/node/movedata.ts";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../src/server/index.ts";
import { startTestServer } from "./helpers.ts";

describe("moving Cardboard's storage to another drive", () => {
  const root = mkdtempSync(join(tmpdir(), "cardboard-move-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("copies everything, checks it, and leaves the old copy for you to delete", async () => {
    const t = await startTestServer({ shake: false });
    const box = await t.me.createBox("photos");
    await (await t.me.open(box)).put("notes/1", { title: "kept" });
    const from = t.cb.paths.dataDir;
    await t.cb.close();
    after(() => rmSync(t.dir, { recursive: true, force: true }));
    mkdirSync(join(root, "X"));
    writeFileSync(join(root, "X", "something else.txt"), "a drive with things on it");
    const { target, bytes } = moveData(from, join(root, "X"));
    assert.equal(target, join(root, "X", "Cardboard data"), "a drive with things on it gets a folder of its own");
    assert.ok(bytes > 0);
    assert.ok(existsSync(join(target, "cardboard.db")) && existsSync(join(target, "server.key")));
    assert.ok(existsSync(join(from, "cardboard.db")), "the old copy stays until you delete it");
    assert.ok(!existsSync(`${target}.moving`));
    // Cardboard opens from the new place with everything in it.
    const again = await startServer({ dataDir: target, port: 0, shake: false, sweepEveryMs: 3_600_000 });
    try {
      const box = new DatabaseSync(join(target, "cardboard.db"), { readOnly: true });
      const n = (box.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
      box.close();
      assert.ok(n >= 1, "the note came along");
      assert.equal(again.firstInvite, undefined, "it knows it already has people, so it doesn't start over");
    } finally {
      await again.close();
    }
    assert.throws(() => moveData(from, target), /already Cardboard data at/);
    assert.equal(storageTarget(join(root, "empty-new")), join(root, "empty-new"));
    assert.ok(readFileSync(join(root, "X", "something else.txt"), "utf8").includes("things"), "what was on the drive is left alone");
  });
});
