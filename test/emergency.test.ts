import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claimEmergency, requestEmergency, signUp, viewEmergency } from "../src/client/account.ts";
import { MemoryStore } from "../src/client/device.ts";
import { CardboardError } from "../src/sdk/index.ts";
import { DAY, startTestServer, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

describe("emergency access (if something happens to you)", () => {
  let t: TestServer;
  const heir = () => ({ url: t.cb.url, store: new MemoryStore(), kind: "browser" as const, label: "Anna's phone" });
  before(async () => {
    t = await startTestServer({ shake: false });
    await t.me.setProfile({ name: "Gosinn" });
    await t.me.createBox("documents");
    await (await t.me.open("documents")).put("house", { papers: "in the blue folder" });
  });
  after(() => t.stop());

  it("gives someone you trust a link that only opens after a wait you can stop", async () => {
    const { link } = await t.me.addEmergencyLink({ label: "Anna", message: "The house papers are in the documents box.", wait: "7d" });
    assert.match(link, /\/#emergency=[0-9A-Z-]+$/);

    const preview = await viewEmergency({ url: t.cb.url, link });
    assert.deepEqual([preview.from, preview.message, preview.waitMs, preview.requestedAt], ["Gosinn", "The house papers are in the documents box.", 7 * DAY, null]);

    const asked = await requestEmergency({ url: t.cb.url, link });
    assert.equal(asked.open, false);
    assert.ok(Math.abs(asked.readyAt - (t.clock.now + 7 * DAY)) < 1000);
    const me = await t.me.me();
    assert.deepEqual(me.emergency.map((e) => e.label), ["Anna"], "every device hears about it");
    assert.ok(me.alarms.some((a) => /emergency access link/.test(a.text)));
    await rejectsWith(claimEmergency({ ...heir(), link }), "emergency_waiting");

    await t.me.stopEmergency("Anna");
    assert.equal((await t.me.me()).emergency.length, 0);
    await rejectsWith(claimEmergency({ ...heir(), link }), "not_requested");

    await requestEmergency({ url: t.cb.url, link });
    t.clock.advance(7 * DAY + 1000);
    const store = new MemoryStore();
    const theirs = await claimEmergency({ ...heir(), store, link });
    assert.equal(theirs.id, t.me.id, "they're in your Cardboard now");
    assert.deepEqual(await (await theirs.open("documents")).get("house"), { papers: "in the blue folder" });
    assert.ok((await t.me.me()).devices.some((d) => d.name === "Anna's phone"));
    await rejectsWith(viewEmergency({ url: t.cb.url, link }), "no_such_emergency_link");
    const log = (await t.me.log({ limit: 10 })).map((l) => l.text);
    assert.ok(log.some((l) => /emergency access was used/.test(l)), log.join("\n"));
    t.cb.api.limiter.reset("127.0.0.1");
  });

  it("lets you say yes straight away", async () => {
    const { link } = await t.me.addEmergencyLink({ label: "Siggi", wait: "30d" });
    await requestEmergency({ url: t.cb.url, link });
    await t.me.allowEmergency("Siggi");
    assert.equal((await viewEmergency({ url: t.cb.url, link })).open, true);
    const theirs = await claimEmergency({ ...heir(), link });
    assert.equal(theirs.id, t.me.id);
  });

  it("keeps the message and the key sealed past the server", async () => {
    const canary = `canary-${Date.now()}`;
    const { link } = await t.me.addEmergencyLink({ label: canary, message: canary });
    t.cb.api.ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.ok(!readFileSync(join(t.cb.paths.dataDir, "cardboard.db")).includes(Buffer.from(canary)));
    await t.me.removeEmergency(canary);
    await rejectsWith(viewEmergency({ url: t.cb.url, link }), "no_such_emergency_link");
    await rejectsWith(viewEmergency({ url: t.cb.url, link: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA" }), "bad_code");
    t.cb.api.limiter.reset("127.0.0.1");
  });

  it("refuses waits that are too short", async () => {
    await rejectsWith(t.me.addEmergencyLink({ wait: "5m" }), "bad_request");
  });
});

describe("inviting friends", () => {
  it("lets anyone here invite a friend (up to 5 waiting), unless the host says only they can", async () => {
    const t = await startTestServer({ shake: false });
    try {
      const { link, expiresAt } = await t.me.inviteFriend();
      assert.match(link, /#invite=cbi_/);
      assert.ok(expiresAt > Date.now());
      const { account: friend } = await signUp({ url: t.cb.url, invite: link, store: new MemoryStore(), kind: "cli" });
      assert.ok(friend.id);
      for (let i = 0; i < 5; i++) await t.me.inviteFriend();
      await rejectsWith(t.me.inviteFriend(), "too_many_invites");
      const { invites } = await t.me.invites();
      await t.me.cancelInvite(invites[0]!.id);
      await t.me.inviteFriend();
      assert.ok((await t.me.log({ limit: 3 })).some((l) => l.text.endsWith("made an invite link for a friend")));
    } finally {
      await t.stop();
    }
    const strict = await startTestServer({ shake: false, invites: "host" });
    try {
      await rejectsWith(strict.me.inviteFriend(), "invites_host_only");
      assert.equal((await strict.me.me()).server.invites, "host");
    } finally {
      await strict.stop();
    }
  });
});
