import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CardboardError, type Parcel } from "../src/sdk/index.ts";
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
    const pending = await t.admin("docks");
    assert.deepEqual(pending.body.pending.map((p: any) => [p.dock, p.box, p.send, p.receive]).sort(), [
      ["shopping", "grocery-app", false, true],
      ["shopping", "recipe-app", true, false],
    ]);
    const insights = await t.admin("insights");
    assert.ok(insights.body.insights.some((i: any) => i.title === "recipe-app wants to send on dock “shopping”"));

    await t.admin("dock.approve", { dock: "shopping", box: "recipe-app" });
    await t.admin("dock.approve", { dock: "shopping", box: "grocery-app" });

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

  it("gives an app a different pseudonym at every dock, and counts parcels per dock", async () => {
    const a = await t.newBox("pseudo-a");
    await t.newBox("pseudo-b");
    await t.admin("dock.create", { name: "dock-one", send: ["pseudo-a"], receive: ["pseudo-b"] });
    await t.admin("dock.create", { name: "dock-two", send: ["pseudo-a"], receive: ["pseudo-b"] });
    const one = await a.box.dock("dock-one").send({ n: 1 });
    await a.box.dock("dock-two").send({ n: 2 });
    const two = await a.box.dock("dock-two").send({ n: 3 });
    assert.notEqual(one.from, two.from);
    assert.equal(one.seq, 1);
    assert.equal(two.seq, 2, "seq doesn't reveal traffic on other docks");
  });

  it("runs every parcel through customs", async () => {
    const a = await t.newBox("customs-a");
    const b = await t.newBox("customs-b");
    await t.admin("dock.create", { name: "customs", send: ["customs-a"], receive: ["customs-b"] });
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
    assert.deepEqual(parcel!.body, {
      name: "Anna",
      contact: { email: "[redacted email address]", phone: "[redacted phone number]" },
      note: "hi",
    });

    await t.admin("dock.settings", { dock: "customs", settings: { personal: "block" } });
    await rejectsWith(dock.send({ email: "anna@example.is" }), "personal_at_customs");

    const log = await t.admin("log", { box: "customs-a" });
    assert.ok(log.body.entries.some((e: any) => /^Customs stopped a parcel from customs-a/.test(e.text)));
    const insights = await t.admin("insights");
    assert.ok(insights.body.insights.some((i: any) => /^Customs stopped \d+ parcels from customs-a/.test(i.title)));
  });

  it("only lets what's on the manifest cross", async () => {
    const a = await t.newBox("manifest-a");
    const b = await t.newBox("manifest-b");
    await t.admin("dock.create", {
      name: "orders",
      send: ["manifest-a"],
      receive: ["manifest-b"],
      settings: { shape: { item: "string", qty: "number?" } },
    });
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
    await t.admin("dock.create", { name: "questions", send: ["asker", "helper"], receive: ["asker", "helper", "bystander"] });

    await asker.box.dock("questions").send({ q: "what's for dinner?" });
    const [question] = await helper.box.dock("questions").receive();
    await helper.box.dock("questions").reply(question!, { a: "kjötsúpa" });

    const answers = await asker.box.dock("questions").receive();
    assert.deepEqual(
      answers.map((p) => p.body),
      [{ a: "kjötsúpa" }],
      "the asker never gets its own question back",
    );
    const seenByBystander = await bystander.box.dock("questions").receive();
    assert.deepEqual(
      seenByBystander.map((p) => p.body),
      [{ q: "what's for dinner?" }],
      "the reply was private",
    );
  });

  it("deletes parcels once everyone they're for has picked them up, and keeps deposits for latecomers", async () => {
    const a = await t.newBox("depositor");
    const b = await t.newBox("pickup-1");
    const c = await t.newBox("pickup-2");
    await t.admin("dock.create", { name: "drop-box", send: ["depositor"] });
    await a.box.dock("drop-box").send({ n: 1 });
    let dock = (await t.admin("docks")).body.docks.find((d: any) => d.name === "drop-box");
    assert.equal(dock.inFlight.unclaimed, 1, "nobody can receive yet, so it waits");

    await t.admin("dock.grant", { dock: "drop-box", box: "pickup-1", receive: true });
    await t.admin("dock.grant", { dock: "drop-box", box: "pickup-2", receive: true });
    assert.equal((await b.box.dock("drop-box").receive({ ack: true })).length, 1, "latecomers still get deposits");
    dock = (await t.admin("docks")).body.docks.find((d: any) => d.name === "drop-box");
    assert.equal(dock.inFlight.count, 1, "still waiting for pickup-2");
    await c.box.dock("drop-box").receive({ ack: true });
    dock = (await t.admin("docks")).body.docks.find((d: any) => d.name === "drop-box");
    assert.equal(dock.inFlight.count, 0, "delivered everywhere, so it's gone");

    await a.box.dock("drop-box").send({ n: 2 });
    t.clock.advance(8 * DAY);
    t.cb.api.ctx.docks.sweep();
    assert.equal((await b.box.dock("drop-box").receive()).length, 0, "expired parcels are swept");
  });

  it("lets the owner see who really sent what", async () => {
    const a = await t.newBox("visible-sender");
    await t.admin("dock.create", { name: "peekable", send: ["visible-sender"] });
    await a.box.dock("peekable").send({ hello: true });
    const peek = await t.admin("dock.peek", { dock: "peekable" });
    assert.equal(peek.body.parcels[0].sender, "visible-sender");
  });

  it("delivers live, catches up, waits for approval, and cuts off on removal", async () => {
    const sender = await t.newBox("live-sender");
    const listener = await t.newBox("live-listener");
    const got: Parcel[] = [];
    const errors: Error[] = [];
    let waiting = "";
    let ready = 0;
    const watcher = listener.box.dock("live").on((p) => void got.push(p), {
      onWaiting: (m) => (waiting = m),
      onReady: () => ready++,
      onError: (e) => errors.push(e),
    });
    try {
      await waitFor(() => waiting !== "");
      assert.match(waiting, /Waiting for the owner to approve/);

      await t.admin("dock.grant", { dock: "live", box: "live-sender", send: true });
      await sender.box.dock("live").send({ n: 1 }); // deposited before the listener is approved
      await t.admin("dock.approve", { dock: "live", box: "live-listener" });
      await waitFor(() => ready > 0, 15_000);
      await waitFor(() => got.length === 1);
      await sender.box.dock("live").send({ n: 2 });
      await waitFor(() => got.length === 2);
      assert.deepEqual(
        got.map((p) => p.body),
        [{ n: 1 }, { n: 2 }],
      );
      await waitFor(() => t.cb.api.ctx.docks.inFlight(t.cb.api.ctx.docks.require("live").id).count === 0);

      await t.admin("dock.deny", { dock: "live", box: "live-listener" });
      await waitFor(() => errors.some((e) => e instanceof CardboardError && e.code === "dock_denied"), 15_000);
    } finally {
      watcher.close();
    }
  });

  it("remembers apps: profiles, and docks that survive new tapes", async () => {
    const app = await t.newBox("remembered");
    await app.box.introduce({ title: "Remembered App", description: "Tests memory", version: "1.2.0" });
    await t.admin("dock.create", { name: "memory", send: ["remembered"] });
    const newTape = await t.admin("tape.create", { box: "remembered", label: "redeploy" });
    const { open } = await import("../src/sdk/index.ts");
    const redeployed = open({ url: t.cb.url, tape: newTape.body.secret });
    const sent = await redeployed.dock("memory").send({ still: "docked" });
    assert.equal(sent.recipients, 0);
    const boxes = await t.admin("boxes");
    const me = boxes.body.boxes.find((b: any) => b.name === "remembered");
    assert.equal(me.profile.title, "Remembered App");
    assert.deepEqual(me.docks, [{ dock: "memory", send: true, receive: false, waiting: false }]);
  });

  it("keeps prefix-limited tapes off docks, and shredding a box removes its parcels", async () => {
    const app = await t.newBox("limited-app");
    const limited = await t.admin("tape.create", { box: "limited-app", prefix: "public/" });
    const { open } = await import("../src/sdk/index.ts");
    await rejectsWith(open({ url: t.cb.url, tape: limited.body.secret }).dock("x").send({}), "prefix_tape_no_docks");

    await t.admin("dock.create", { name: "leaving", send: ["limited-app"] });
    await app.box.dock("leaving").send({ bye: true });
    await t.admin("box.shred", { name: "limited-app", confirm: "limited-app" });
    const dock = (await t.admin("docks")).body.docks.find((d: any) => d.name === "leaving");
    assert.equal(dock.inFlight.count, 0);
    assert.equal(dock.berths.length, 0);
  });
});
