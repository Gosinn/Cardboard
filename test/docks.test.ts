import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ctx } from "../src/shared/contexts.ts";
import { fromB64u, open as openSealed, sealJson, toB64u } from "../src/client/crypto.ts";
import { dockIndex, dockKeys, newClientId } from "../src/client/keys.ts";
import { CardboardError, open, type Parcel } from "../src/sdk/index.ts";
import { DAY, startTestServer, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

async function waitFor(condition: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Docks", () => {
  let t: TestServer;
  const dockOf = async (name: string) => (await t.me.docks()).docks.find((d) => d.name === name)!;
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  it("docks two apps with one approval, and neither learns the other's name", async () => {
    const recipes = await t.newBox("recipe-app");
    const groceries = await t.newBox("grocery-app");
    const shopping = recipes.box.dock("shopping");

    await rejectsWith(shopping.send({ item: "milk" }), "dock_pending");
    await rejectsWith(groceries.box.dock("shopping").receive(), "dock_pending");
    const { pending } = await t.me.docks();
    assert.deepEqual(pending.map((p) => [p.dock, p.box, p.send, p.receive]).sort(), [
      ["shopping", "grocery-app", false, true],
      ["shopping", "recipe-app", true, false],
    ], "the apps sealed the dock's name for you, so you can read their requests");
    assert.ok((await t.me.insights()).some((i) => i.title === "recipe-app wants to send on dock “shopping”"));

    await t.me.dockApprove("shopping", "recipe-app");
    await t.me.dockApprove("shopping", "grocery-app");

    const sent = await shopping.send({ item: "milk", qty: 2 });
    assert.equal(sent.recipients, 1);
    assert.match(sent.from, /^berth-[0-9a-f]{12}$/);

    const [parcel] = await groceries.box.dock("shopping").receive<{ item: string; qty: number }>();
    assert.deepEqual(parcel!.body, { item: "milk", qty: 2 });
    assert.equal(parcel!.from, sent.from);
    const seen = JSON.stringify(parcel);
    assert.ok(!seen.includes("recipe-app") && !seen.includes(recipes.tapeId), "no names or tape ids");

    const outsider = await t.newBox("outsider");
    assert.equal((await outsider.box.dock("shopping").status()).senders, null, "undocked apps get no counts");
    const status = await groceries.box.dock("shopping").status();
    assert.equal(status.senders, 1);
    assert.equal(status.receive, true);
    assert.equal(status.send, false);
  });

  it("seals parcels so the server carries them without reading them", async () => {
    const a = await t.newBox("sealer-a");
    const b = await t.newBox("sealer-b");
    await t.me.createDock("sealed", { send: ["sealer-a"], receive: ["sealer-b"] });
    await a.box.dock("sealed").send({ secretPlan: "meet at the oak 3f9a" });
    t.cb.api.ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const rows = t.cb.api.ctx.db.prepare("SELECT body FROM parcels").all() as Array<{ body: Uint8Array }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !Buffer.from(r.body).includes(Buffer.from("meet at the oak"))));
    assert.deepEqual((await b.box.dock("sealed").receive())[0]!.body, { secretPlan: "meet at the oak 3f9a" });
  });

  it("gives an app a different pseudonym at every dock, and counts parcels per dock", async () => {
    const a = await t.newBox("pseudo-a");
    await t.newBox("pseudo-b");
    await t.me.createDock("dock-one", { send: ["pseudo-a"], receive: ["pseudo-b"] });
    await t.me.createDock("dock-two", { send: ["pseudo-a"], receive: ["pseudo-b"] });
    const one = await a.box.dock("dock-one").send({ n: 1 });
    await a.box.dock("dock-two").send({ n: 2 });
    const two = await a.box.dock("dock-two").send({ n: 3 });
    assert.notEqual(one.from, two.from);
    assert.equal(one.seq, 1);
    assert.equal(two.seq, 2, "seq doesn't reveal traffic on other docks");
  });

  it("runs customs in the sending app", async () => {
    const a = await t.newBox("customs-a");
    const b = await t.newBox("customs-b");
    await t.me.createDock("customs", { send: ["customs-a"], receive: ["customs-b"] });
    const dock = a.box.dock("customs");

    await rejectsWith(dock.send({ token: "ghp_" + "a".repeat(36) }), "secret_at_customs");
    await rejectsWith(dock.send({ user: { password: "hunter22" } }), "secret_at_customs");
    await rejectsWith(dock.send(JSON.parse('{"__proto__": {"isAdmin": true}}')), "unsafe_parcel");
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { deep };
    await rejectsWith(dock.send(deep), "unsafe_parcel");

    const sent = await dock.send({ name: "Anna", contact: { email: "anna@example.is", phone: "+354 555 1234" }, note: "hi" });
    assert.deepEqual(sent.redacted, ["contact.email", "contact.phone"]);
    const [parcel] = await b.box.dock("customs").receive({ ack: true });
    assert.deepEqual(parcel!.body, { name: "Anna", contact: { email: "[redacted email address]", phone: "[redacted phone number]" }, note: "hi" });

    await t.me.dockSettings("customs", { personal: "block" });
    await rejectsWith(a.box.dock("customs").send({ email: "anna@example.is" }), "personal_at_customs");
  });

  it("runs customs again in the receiving app, so a hostile sender can't infect it", async () => {
    const hostile = await t.newBox("hostile");
    const victim = await t.newBox("victim");
    await t.me.createDock("guarded", { send: ["hostile"], receive: ["victim"] });
    // The hostile app skips its own customs: it opens the dock key from its berth and seals a trap itself.
    const opened = await hostile.box.ready();
    const idx = await dockIndex(opened.names, "guarded");
    const status = (await t.raw(hostile.token, "dock.status", { dock: idx })).body;
    const keys = await dockKeys(await openSealed(opened.keys.wrap, fromB64u(status.key), ctx.berthKey(status.id, opened.boxId)));
    const smuggle = async (body: unknown) => {
      const id = newClientId("pcl");
      const sealed = await sealJson(keys.seal, { body, redacted: [] }, ctx.parcel(status.id, id));
      assert.equal((await t.raw(hostile.token, "dock.send", { dock: idx, parcel: { id, body: toB64u(sealed) } })).status, 200);
    };
    await smuggle(JSON.parse('{"a":{"__proto__":{"admin":true}}}'));
    await smuggle({ key: `sk-ant-api03-${"q".repeat(40)}` });
    await smuggle({ email: "victim@example.is", ok: true });
    const refused: string[] = [];
    const got: Parcel[] = [];
    const watcher = victim.box.dock("guarded").on((p) => void got.push(p), { onRefused: (reason) => refused.push(reason) });
    try {
      await waitFor(() => got.length + refused.length >= 3);
    } finally {
      watcher.close();
    }
    assert.deepEqual(refused, ["unsafe", "secret"]);
    assert.deepEqual(got.map((p) => p.body), [{ email: "[redacted email address]", ok: true }], "personal data is redacted on arrival too");
    const log = await t.me.log({ box: "victim" });
    assert.ok(log.some((e) => /^Customs stopped a parcel for victim .* on dock “guarded”: it was booby-trapped/.test(e.text)), log.map((e) => e.text).join("\n"));
    assert.ok((await t.me.insights()).some((i) => /^Customs stopped 2 parcels for victim/.test(i.title)));
  });

  it("only lets what's on the manifest cross", async () => {
    const a = await t.newBox("manifest-a");
    const b = await t.newBox("manifest-b");
    await t.me.createDock("orders", { send: ["manifest-a"], receive: ["manifest-b"], settings: { shape: { item: "string", qty: "number?" } } });
    const sent = await a.box.dock("orders").send({ item: "milk", qty: 2, internalUserId: "u_123", debug: { trace: 1 } });
    assert.deepEqual(sent.stripped, ["internalUserId", "debug"]);
    const [parcel] = await b.box.dock("orders").receive();
    assert.deepEqual(parcel!.body, { item: "milk", qty: 2 });
    assert.equal("stripped" in parcel!, false, "receivers never learn the names of stripped fields");
    await rejectsWith(a.box.dock("orders").send({ qty: 1 }), "shape_mismatch");
    await rejectsWith(a.box.dock("orders").send({ item: 5 }), "shape_mismatch");
  });

  it("supports anonymous replies that only the sender sees", async () => {
    const asker = await t.newBox("asker");
    const helper = await t.newBox("helper");
    const bystander = await t.newBox("bystander");
    await t.me.createDock("questions", { send: ["asker", "helper"], receive: ["asker", "helper", "bystander"] });

    await asker.box.dock("questions").send({ q: "what's for dinner?" });
    const [question] = await helper.box.dock("questions").receive();
    await helper.box.dock("questions").reply(question!, { a: "kjötsúpa" });

    assert.deepEqual((await asker.box.dock("questions").receive()).map((p) => p.body), [{ a: "kjötsúpa" }], "the asker never gets its own question back");
    assert.deepEqual((await bystander.box.dock("questions").receive()).map((p) => p.body), [{ q: "what's for dinner?" }], "the reply was private");
  });

  it("deletes parcels once everyone they're for has picked them up, and keeps deposits for latecomers", async () => {
    const a = await t.newBox("depositor");
    const b = await t.newBox("pickup-1");
    const c = await t.newBox("pickup-2");
    await t.me.createDock("drop-box", { send: ["depositor"] });
    await a.box.dock("drop-box").send({ n: 1 });
    assert.equal((await dockOf("drop-box")).inFlight.unclaimed, 1, "nobody can receive yet, so it waits");

    await t.me.dockGrant("drop-box", "pickup-1", { receive: true });
    await t.me.dockGrant("drop-box", "pickup-2", { receive: true });
    assert.equal((await b.box.dock("drop-box").receive({ ack: true })).length, 1, "latecomers still get deposits");
    assert.equal((await dockOf("drop-box")).inFlight.count, 1, "still waiting for pickup-2");
    await c.box.dock("drop-box").receive({ ack: true });
    assert.equal((await dockOf("drop-box")).inFlight.count, 0, "delivered everywhere, so it's gone");

    await a.box.dock("drop-box").send({ n: 2 });
    t.clock.advance(8 * DAY);
    t.cb.api.ctx.docks.sweep();
    assert.equal((await b.box.dock("drop-box").receive()).length, 0, "expired parcels are swept");
  });

  it("lets you see inside (opened on your device) and who really sent what", async () => {
    const a = await t.newBox("visible-sender");
    await t.me.createDock("peekable", { send: ["visible-sender"], settings: { shape: { hello: "boolean" } } });
    await a.box.dock("peekable").send({ hello: true });
    const [parcel] = await t.me.dockPeek("peekable");
    assert.equal(parcel!.sender, "visible-sender");
    assert.deepEqual(parcel!.body, { hello: true });
  });

  it("delivers live, catches up, waits for approval, and cuts off on refusal", async () => {
    const sender = await t.newBox("live-sender");
    const listener = await t.newBox("live-listener");
    const got: Parcel[] = [];
    const errors: Error[] = [];
    let waiting = "";
    let ready = 0;
    const watcher = listener.box.dock("live").on((p) => void got.push(p), { onWaiting: (m) => (waiting = m), onReady: () => ready++, onError: (e) => errors.push(e) });
    try {
      await waitFor(() => waiting !== "");
      assert.match(waiting, /Waiting for you to approve/);
      await t.me.dockApprove("live", "live-listener");
      await t.me.dockGrant("live", "live-sender", { send: true });
      await sender.box.dock("live").send({ n: 1 });
      await waitFor(() => ready > 0, 15_000);
      await waitFor(() => got.length === 1);
      await sender.box.dock("live").send({ n: 2 });
      await waitFor(() => got.length === 2);
      assert.deepEqual(got.map((p) => p.body), [{ n: 1 }, { n: 2 }]);
      for (let i = 0; i < 100 && (await dockOf("live")).inFlight.count > 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await dockOf("live")).inFlight.count, 0, "handled parcels are acked and deleted");
      await t.me.dockDeny("live", "live-listener");
      await waitFor(() => errors.some((e) => e instanceof CardboardError && e.code === "dock_denied"), 15_000);
    } finally {
      watcher.close();
    }
  });

  it("remembers apps: profiles, and docks that survive new tapes", async () => {
    const app = await t.newBox("remembered");
    await app.box.introduce({ title: "Remembered App", description: "Tests memory", version: "1.2.0" });
    await t.me.createDock("memory", { send: ["remembered"] });
    const { secret } = await t.me.createTape("remembered", { label: "redeploy" });
    const sent = await open({ url: t.cb.url, tape: secret }).dock("memory").send({ still: "docked" });
    assert.equal(sent.recipients, 0);
    const me = await t.me.box("remembered");
    assert.equal(me.profile.title, "Remembered App");
    assert.deepEqual(me.docks.map((d) => [d.send, d.receive, d.waiting]), [[true, false, false]]);
  });

  it("shredding a box takes its berths and parcels with it", async () => {
    const app = await t.newBox("leaving-app");
    await t.me.createDock("leaving", { send: ["leaving-app"] });
    await app.box.dock("leaving").send({ bye: true });
    await t.me.shredBox("leaving-app");
    const dock = await dockOf("leaving");
    assert.equal(dock.inFlight.count, 0);
    assert.equal(dock.berths.length, 0);
  });
});
