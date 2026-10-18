import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { LocalMcp, MCP_VERSIONS, serveStdio, TOOLS } from "../src/mcp.ts";
import { open } from "../src/sdk/index.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

describe("AI assistants (local MCP)", () => {
  let t: TestServer;
  let mcp: LocalMcp;
  let id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => (await mcp.handle({ jsonrpc: "2.0", id: ++id, method, params })) as { result?: any; error?: any };
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await call("tools/call", { name, arguments: args })).result as { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };

  before(async () => {
    t = await startTestServer({ shake: false });
    const notes = await t.newBox("notes");
    await notes.box.put("notes/groceries", { items: ["milk", "eggs"], done: false });
    await notes.box.put("notes/ideas", { items: ["boat"], done: true });
    await t.newBox("diary");
    await (await t.newBox("diary-unused")).box.put("x", 1);
    await t.me.createBox("assistant-claude");
    const own = await t.me.createTape("assistant-claude", { label: "claude", kind: "assistant" });
    const seeNotes = await t.me.createTape("notes", { label: "claude", kind: "assistant", write: false });
    mcp = new LocalMcp({
      name: "claude",
      boxes: [
        { name: "assistant-claude", box: open({ url: t.cb.url, tape: own.secret, onNotice: false }), write: true, own: true },
        { name: "notes", box: open({ url: t.cb.url, tape: seeNotes.secret, onNotice: false }), write: false, own: false },
      ],
    });
  });
  after(() => t.stop());

  it("speaks MCP: initialize, tools/list, ping", async () => {
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.match(init.result.instructions, /never sees it/);
    assert.match(init.result.instructions, /"notes" \(read-only\)/);
    assert.equal((await call("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, MCP_VERSIONS[0]);
    assert.deepEqual((await call("tools/list")).result.tools.map((t: { name: string }) => t.name), TOOLS.map((t) => t.name));
    assert.deepEqual((await call("ping")).result, {});
    assert.equal((await call("nope")).error.code, -32601);
    assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  });

  it("sees only its own box and what you shared, opened right here", async () => {
    const boxes = (await tool("list_boxes")).structuredContent.boxes;
    assert.deepEqual(boxes.map((b: { name: string; yours: boolean; canChange: boolean }) => [b.name, b.yours, b.canChange]), [
      ["assistant-claude", true, true],
      ["notes", false, false],
    ]);
    assert.match(boxes[1].summary, /2 items/);
    const read = await tool("read_item", { box: "notes", key: "notes/groceries" });
    assert.deepEqual(read.structuredContent.value, { items: ["milk", "eggs"], done: false });
    const refused = await tool("read_item", { box: "diary", key: "x" });
    assert.ok(refused.isError);
    assert.match(refused.content[0]!.text, /hasn't shared a box called "diary"/);
  });

  it("finds and searches", async () => {
    const found = await tool("find_items", { box: "notes", where: { done: false } });
    assert.equal(found.structuredContent.total, 1);
    assert.equal(found.structuredContent.items[0].key, "notes/groceries");
    const hits = (await tool("search", { text: "boat" })).structuredContent.results;
    assert.deepEqual(hits.map((h: { key: string }) => h.key), ["notes/ideas"]);
  });

  it("remembers things in its own box, can undo, and can't change what's read-only", async () => {
    const saved = await tool("save_item", { box: "assistant-claude", key: "memory/likes", value: "tea" });
    assert.equal(saved.structuredContent.version, 1);
    await tool("save_item", { box: "assistant-claude", key: "memory/likes", value: "coffee" });
    await tool("undo_change", { box: "assistant-claude", key: "memory/likes" });
    assert.equal((await tool("read_item", { box: "assistant-claude", key: "memory/likes" })).structuredContent.value, "tea");
    assert.equal((await tool("item_history", { box: "assistant-claude", key: "memory/likes" })).structuredContent.versions.length, 3);
    const blocked = await tool("save_item", { box: "notes", key: "notes/groceries", value: "overwritten" });
    assert.ok(blocked.isError);
    assert.match(blocked.content[0]!.text, /can see "notes" but not change it/);
    const log = (await t.me.log()).map((e) => e.text);
    assert.ok(log.some((l) => l === "claude (AI assistant) saved “memory/likes”"), log.join("\n"));
    assert.ok(log.some((l) => l === "claude (AI assistant) read “notes/groceries”"));
  });

  it("serves the stdio transport, one message per line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
    const done = serveStdio(mcp, input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    input.write("not json\n");
    input.write(`${JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }])}\n`);
    input.end();
    await done;
    const replies = lines.map((l) => JSON.parse(l));
    assert.deepEqual(replies[0], { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(replies[1].error.code, -32700);
    assert.equal(replies[2].length, 1);
    assert.equal(replies[2][0].id, 2);
  });
});
