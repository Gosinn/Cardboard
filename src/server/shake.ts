import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import type { Api, ApiRequest, ApiResponse } from "./api.ts";
import { isLoopback } from "./insights.ts";

export interface ShakeResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface ShakeReport {
  at: number;
  ok: boolean;
  passed: number;
  failed: number;
  warned: number;
  summary: string;
  results: ShakeResult[];
}

/** TEST-NET-2 address (RFC 5737): never a real client, so probing can't lock anyone out. */
const PROBE_IP = "198.51.100.77";

/**
 * The shake test: Cardboard attacks itself through the same API your apps use
 * and reports what held. It works on two throwaway boxes that are shredded
 * afterwards, so your real data is never touched.
 */
export function runShake(api: Api): ShakeReport {
  const { vault, tapes, db, info } = api.ctx;
  const results: ShakeResult[] = [];
  const check = (id: string, title: string, run: () => Omit<ShakeResult, "id" | "title">) => {
    try {
      results.push({ id, title, ...run() });
    } catch (err) {
      results.push({ id, title, status: "fail", detail: `The check itself crashed: ${(err as Error).message}` });
    }
  };
  const pass = (detail: string) => ({ status: "pass" as const, detail });
  const failed = (detail: string) => ({ status: "fail" as const, detail });
  const warn = (detail: string) => ({ status: "warn" as const, detail });

  const call = (op: string, secret: string | undefined, body: unknown, extra: Partial<ApiRequest> = {}): ApiResponse =>
    api.call({
      op,
      admin: false,
      authorization: secret ? `Bearer ${secret}` : undefined,
      ip: PROBE_IP,
      body,
      internal: true,
      ...extra,
    });
  const errorCode = (res: ApiResponse) => (res.body as { error?: { code?: string } }).error?.code;

  const tag = randomBytes(4).toString("hex");
  const boxA = vault.createBox(`__shake-${tag}-a`, { system: true });
  const boxB = vault.createBox(`__shake-${tag}-b`, { system: true });
  try {
    const a = tapes.create(boxA.id, { label: "shake" });
    const b = tapes.create(boxB.id, { label: "shake" });
    const canary = `canary-${randomBytes(12).toString("hex")}`;
    const secretKey = `secret/${canary}`;
    const setup = call("put", a.secret, { key: secretKey, value: { note: canary } });
    const setup2 = call("put", a.secret, { key: "public/hello", value: { note: "hello" } });
    if (setup.status !== 200 || setup2.status !== 200) throw new Error("couldn't write test data");

    check("no-tape", "Locked without a tape", () => {
      const res = call("get", undefined, { key: secretKey });
      return res.status === 401 ? pass("Requests without a tape are turned away.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("fake-tape", "Made-up tapes don't open anything", () => {
      const res = call("get", `cbt_${randomBytes(32).toString("base64url")}`, { key: secretKey });
      return res.status === 401 ? pass("Random tapes are rejected.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("isolation", "Boxes can't see into each other", () => {
      const got = call("get", b.secret, { key: secretKey }).body as { item?: unknown };
      const listed = call("list", b.secret, {}).body as { items?: unknown[] };
      const found = call("query", b.secret, { where: { note: canary } }).body as { items?: unknown[] };
      if (got.item === null && listed.items?.length === 0 && found.items?.length === 0) {
        return pass("Another app's tape couldn't read, list or search the test box.");
      }
      return failed("A tape for one box could see data in another box.");
    });

    check("read-only", "Read-only tapes can't write", () => {
      const ro = tapes.create(boxA.id, { write: false });
      const res = call("put", ro.secret, { key: "public/x", value: 1 });
      return res.status === 403 ? pass("Writes with a read-only tape are refused.") : failed(`Got ${res.status} instead of 403.`);
    });

    check("prefix", "Limited tapes stay inside their limits", () => {
      const limited = tapes.create(boxA.id, { prefix: "public/" });
      const outside = call("get", limited.secret, { key: secretKey });
      const listed = call("list", limited.secret, {}).body as { items?: Array<{ key: string }> };
      const leaked = listed.items?.some((i) => !i.key.startsWith("public/")) ?? true;
      if (outside.status === 403 && !leaked) return pass("A tape limited to “public/” couldn't read or list anything else.");
      return failed("A prefix-limited tape reached keys outside its prefix.");
    });

    check("revoked", "Revoked tapes stop working", () => {
      const r = tapes.create(boxA.id);
      tapes.revoke(r.tape.id);
      const res = call("get", r.secret, { key: secretKey });
      return res.status === 401 ? pass("A revoked tape was refused straight away.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("expired", "Expired tapes stop working", () => {
      const e = tapes.create(boxA.id, { expiresAt: vault.now() - 1000 });
      const res = call("get", e.secret, { key: secretKey });
      return res.status === 401 ? pass("An expired tape was refused.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("admin", "App tapes can't use the owner API", () => {
      const res = call("boxes", a.secret, {}, { admin: true });
      return res.status === 401 ? pass("The owner API ignored an app's tape.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("cors", "Unknown websites are turned away", () => {
      const res = call("get", a.secret, { key: secretKey }, { origin: "https://evil.example" });
      const allowed = Object.keys(res.headers).some((h) => h.toLowerCase() === "access-control-allow-origin");
      return res.status === 403 && !allowed
        ? pass("A browser request from a site you didn't allow was refused.")
        : failed("A request from an unknown website was let through.");
    });

    check("at-rest", "Nothing readable at rest", () => {
      const needle = Buffer.from(canary);
      const rows = [
        ...(db.prepare("SELECT key_enc AS a, value_enc AS b FROM items WHERE box_id = ?").all(boxA.id) as Array<{ a: Uint8Array; b: Uint8Array | null }>),
        ...(db.prepare("SELECT key_enc AS a, value_enc AS b FROM history WHERE box_id = ?").all(boxA.id) as Array<{ a: Uint8Array; b: Uint8Array | null }>),
      ];
      const plain = rows.some((r) => Buffer.from(r.a).includes(needle) || (r.b !== null && Buffer.from(r.b).includes(needle)));
      return rows.length > 0 && !plain
        ? pass("Key names and values in the database are encrypted.")
        : failed("Test data was found in plain text in the database.");
    });

    const rows = db.prepare("SELECT key_id, value_enc FROM items WHERE box_id = ?").all(boxA.id) as Array<{
      key_id: Uint8Array;
      value_enc: Uint8Array;
    }>;

    check("swap", "Data can't be moved between keys", () => {
      if (rows.length < 2) return failed("Not enough test rows.");
      const [r1, r2] = rows as [(typeof rows)[0], (typeof rows)[0]];
      const update = db.prepare("UPDATE items SET value_enc = ? WHERE box_id = ? AND key_id = ?");
      update.run(r2.value_enc, boxA.id, r1.key_id);
      update.run(r1.value_enc, boxA.id, r2.key_id);
      const res1 = call("get", a.secret, { key: secretKey });
      const res2 = call("get", a.secret, { key: "public/hello" });
      update.run(r1.value_enc, boxA.id, r1.key_id);
      update.run(r2.value_enc, boxA.id, r2.key_id);
      return errorCode(res1) === "tampered" && errorCode(res2) === "tampered"
        ? pass("Swapping encrypted values between keys was detected.")
        : failed("Encrypted values could be swapped between keys without being noticed.");
    });

    check("tamper", "Tampering is detected", () => {
      const update = db.prepare("UPDATE items SET value_enc = ? WHERE box_id = ? AND key_id = ?");
      for (const row of rows) {
        const bent = Buffer.from(row.value_enc);
        bent.writeUInt8(bent.readUInt8(bent.length - 1) ^ 0xff, bent.length - 1);
        update.run(bent, boxA.id, row.key_id);
      }
      const res = call("get", a.secret, { key: secretKey });
      return errorCode(res) === "tampered"
        ? pass("A single flipped byte in the database was caught.")
        : failed("Modified data was returned as if it were fine.");
    });

    check("rate-limit", "Guessing tapes gets you blocked", () => {
      api.limiter.reset(PROBE_IP);
      let last: ApiResponse | undefined;
      for (let i = 0; i < 31; i++) last = call("get", `cbt_guess${i}`, { key: secretKey });
      return last?.status === 429 ? pass("After 30 bad tapes the address was slowed down.") : failed(`Got ${last?.status} instead of 429.`);
    });
  } catch (err) {
    results.push({ id: "setup", title: "Shake test setup", status: "fail", detail: (err as Error).message });
  } finally {
    vault.shredBox(boxA.id);
    vault.shredBox(boxB.id);
    api.limiter.reset(PROBE_IP);
  }

  check("key-file", "Master key file is private", () => {
    if (process.platform === "win32") return pass("Skipped on Windows.");
    const mode = statSync(info.keyFile).mode & 0o777;
    return (mode & 0o077) === 0
      ? pass("Only your user can read master.key.")
      : warn(`master.key is readable by other users (mode ${mode.toString(8)}). Fix: chmod 600 "${info.keyFile}"`);
  });

  check("data-dir", "Data folder is private", () => {
    if (process.platform === "win32") return pass("Skipped on Windows.");
    const mode = statSync(info.dataDir).mode & 0o777;
    return (mode & 0o077) === 0
      ? pass("Only your user can open the data folder.")
      : warn(`Other users can open the data folder (mode ${mode.toString(8)}). Fix: chmod 700 "${info.dataDir}"`);
  });

  check("transport", "Traffic is protected", () => {
    if (info.tls) return pass("Cardboard is serving HTTPS.");
    if (isLoopback(info.host)) return pass("Cardboard only listens on this machine.");
    return warn("Cardboard is reachable over plain HTTP from the network. Put it behind HTTPS.");
  });

  check("tape-expiry", "Every tape expires on its own", () => {
    const forever = tapes
      .listAll()
      .filter((t) => tapes.state(t) === "active" && t.idleMs === null && t.expiresAt === null);
    return forever.length === 0
      ? pass("All active tapes switch themselves off eventually.")
      : warn(`${forever.length} tape${forever.length === 1 ? " never expires" : "s never expire"}. See insights to revoke ${forever.length === 1 ? "it" : "them"}.`);
  });

  const passed = results.filter((r) => r.status === "pass").length;
  const failedCount = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const parts = [`${passed}/${results.length} passed`];
  if (failedCount) parts.push(`${failedCount} failed`);
  if (warned) parts.push(`${warned} warning${warned === 1 ? "" : "s"}`);
  return {
    at: vault.now(),
    ok: failedCount === 0,
    passed,
    failed: failedCount,
    warned,
    summary: parts.join(", "),
    results,
  };
}
