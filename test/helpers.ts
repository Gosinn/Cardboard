import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signUp, type Account } from "../src/client/account.ts";
import { MemoryStore } from "../src/client/device.ts";
import { open, type Box } from "../src/sdk/index.ts";
import { startServer, type RunningCardboard, type StartOptions } from "../src/server/index.ts";

export interface TestServer {
  cb: RunningCardboard;
  dir: string;
  hostToken: string;
  /** The first account, signed in on an in-memory device. */
  me: Account;
  kit: string;
  clock: { now: number; advance(ms: number): void };
  host<T = any>(op: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  raw<T = any>(token: string | null, op: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  /** A new box with a tape, opened the way an app would (SDK + tape). */
  newBox(name: string, tape?: Parameters<Account["createTape"]>[1]): Promise<{ box: Box; secret: string; tapeId: string; token: string }>;
  /** Another person on the same Cardboard. */
  newAccount(): Promise<{ account: Account; kit: string }>;
  stop(): Promise<void>;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** The token half of a tape: what an app actually sends. */
export function tokenOf(secret: string): string {
  return `cbt_${Buffer.from(secret.slice(4), "base64url").subarray(0, 32).toString("base64url")}`;
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "cardboard-test-"));
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const cb = await startServer({ dataDir: join(dir, "data"), port: 0, now: () => clock.now, sweepEveryMs: 3_600_000, ...options });
  const hostToken = cb.hostToken!;
  const post = async (path: string, token: string | null, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${cb.url}${path}`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
  };
  const invite = async () => (await post("/v1/host.invite", hostToken, {})).body.code as string;
  const newAccount = async () => signUp({ url: cb.url, invite: await invite(), store: new MemoryStore(), kind: "cli", label: "test laptop" });
  const first = cb.firstInvite
    ? await signUp({ url: cb.url, invite: cb.firstInvite, store: new MemoryStore(), kind: "cli", label: "test laptop" })
    : await newAccount();
  const server: TestServer = {
    cb,
    dir,
    hostToken,
    me: first.account,
    kit: first.kit,
    clock,
    host: (op, body, headers) => post(`/v1/${op}`, hostToken, body, headers),
    raw: (token, op, body, headers) => post(`/v1/${op}`, token, body, headers),
    async newBox(name, tape = {}) {
      await server.me.createBox(name);
      const { tape: info, secret } = await server.me.createTape(name, tape);
      return { box: open({ url: cb.url, tape: secret, onNotice: false }), secret, tapeId: info.id, token: tokenOf(secret) };
    },
    newAccount,
    async stop() {
      await cb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}
