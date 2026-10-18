import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { registerApp } from "../src/sdk/index.ts";
import { Browser, hiddenFields, startTestServer, type TestServer } from "./helpers.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

describe("MCP: AI assistants", () => {
  let t: TestServer;
  let token = "";
  let grant = "";

  const rpc = async (method: string, params: Record<string, unknown> = {}, bearer: string | null = token, headers: Record<string, string> = {}) => {
    const res = await fetch(`${t.cb.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as any) : null };
  };
  const call = async (name: string, args: Record<string, unknown> = {}, bearer: string | null = token) => (await rpc("tools/call", { name, arguments: args }, bearer)).body.result;

  before(async () => {
    t = await startTestServer({ shake: false });
    await t.admin("profile.set", { name: "Gosinn" });
    const notes = await t.newBox("notes");
    await notes.box.put("notes/groceries", { items: ["milk", "lamb"] });
    const diary = await t.newBox("diary");
    await diary.box.put("2026-10-01", { text: "bought milk, felt great" });
  });
  after(() => t.stop());

  it("announces itself the way MCP clients expect", async () => {
    const prm = (await (await fetch(`${t.cb.url}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    assert.equal(prm.resource, `${t.cb.url}/mcp`);
    assert.deepEqual(prm.authorization_servers, [t.cb.url]);
    const res = await rpc("initialize", {}, null);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it("connects an assistant with consent, sharing only the boxes you tick", async () => {
    const { clientId } = await registerApp(t.cb.url, { name: "Claude", redirectUris: [REDIRECT] });
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(`${t.cb.url}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "s1",
      resource: `${t.cb.url}/mcp`,
    }).toString();

    const browser = new Browser(t.cb.url);
    let page = await browser.get(authorize.toString());
    const login = await browser.post(`${t.cb.url}/oauth/login`, { token: t.owner, return_to: hiddenFields(page.html)["return_to"]! });
    page = await browser.get(`${t.cb.url}${login.location}`);
    assert.match(page.html, /Work with your Cardboard as an AI assistant/);
    assert.match(page.html, /name="read" value="notes"/);
    assert.match(page.html, /name="read" value="diary"/);
    const fields = hiddenFields(page.html);
    const answer = await fetch(`${t.cb.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: t.cb.url, cookie: browser.cookieHeader() },
      body: new URLSearchParams([...Object.entries(fields), ["read", "notes"], ["decision", "allow"]]).toString(),
    });
    const callback = new URL(answer.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, REDIRECT);

    const tokenRes = await fetch(`${t.cb.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${t.cb.url}/mcp`,
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as { access_token: string; scope: string };
    assert.match(tokens.scope, /\bmcp\b/);
    token = tokens.access_token;
    grant = (await t.admin("apps")).body.connected.find((a: any) => a.name === "Claude").grant;
  });

  it("speaks MCP: initialize, tools/list, ping", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.body.result.serverInfo.name, "cardboard");
    assert.match(init.body.result.instructions, /"notes" \(read-only\)/);
    const notified = await fetch(`${t.cb.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notified.status, 202);
    const tools = (await rpc("tools/list")).body.result.tools.map((x: any) => x.name);
    assert.deepEqual(tools, ["list_boxes", "list_keys", "read_item", "find_items", "search", "save_item", "delete_item", "undo_change", "item_history"]);
    assert.deepEqual((await rpc("ping")).body.result, {});
    assert.equal((await rpc("resources/list")).body.error.code, -32601);
  });

  it("sees only its own box and what you shared, read-only unless allowed", async () => {
    const boxes = (await call("list_boxes")).structuredContent.boxes;
    assert.deepEqual(
      boxes.map((b: any) => [b.name, b.yours, b.canChange]),
      [
        ["claude", true, true],
        ["notes", false, false],
      ],
    );
    const read = await call("read_item", { box: "notes", key: "notes/groceries" });
    assert.deepEqual(read.structuredContent.value, { items: ["milk", "lamb"] });

    const diary = await call("read_item", { box: "diary", key: "2026-10-01" });
    assert.equal(diary.isError, true);
    assert.match(diary.content[0].text, /hasn't shared a box called "diary"/);

    const search = await call("search", { text: "milk" });
    assert.deepEqual(search.structuredContent.results.map((r: any) => r.box), ["notes"], "the diary's milk stays private");

    const write = await call("save_item", { box: "notes", key: "notes/new", value: 1 });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /can see "notes" but not change it/);

    const memory = await call("save_item", { box: "claude", key: "memory/prefers", value: "metric units" });
    assert.equal(memory.isError, undefined);
    assert.equal((await call("read_item", { box: "claude", key: "memory/prefers" })).structuredContent.value, "metric units");
  });

  it("logs what the assistant did, and lets you widen access later", async () => {
    const log = (await t.admin("log", { box: "notes" })).body.entries.map((e: any) => e.text);
    assert.ok(log.includes("Claude (AI assistant) read “notes/groceries”"));

    await t.admin("apps.share", { grant, shared: [{ box: "notes", write: true }] });
    const write = await call("save_item", { box: "notes", key: "notes/groceries", value: { items: ["milk"] } });
    assert.equal(write.isError, undefined);
    const undo = await call("undo_change", { box: "notes", key: "notes/groceries" });
    assert.equal(undo.isError, undefined);
    assert.deepEqual((await call("read_item", { box: "notes", key: "notes/groceries" })).structuredContent.value, { items: ["milk", "lamb"] });
  });

  it("also takes a plain tape, limited to that tape's box", async () => {
    const tape = (await t.admin("tape.create", { box: "diary", write: false })).body.secret;
    const boxes = (await call("list_boxes", {}, tape)).structuredContent.boxes.map((b: any) => b.name);
    assert.deepEqual(boxes, ["diary"]);
    assert.equal((await call("save_item", { box: "diary", key: "x", value: 1 }, tape)).isError, true);
  });

  it("refuses foreign websites and disconnected assistants", async () => {
    const evil = await rpc("ping", {}, token, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    const local = await rpc("ping", {}, token, { origin: "http://localhost:6274" });
    assert.equal(local.status, 200, "MCP Inspector on localhost may connect");
    await t.admin("apps.disconnect", { grant });
    const after = await rpc("ping");
    assert.equal(after.status, 401);
  });
});
