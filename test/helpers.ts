import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Box } from "../src/sdk/index.ts";
import { startServer, type RunningCardboard, type StartOptions } from "../src/server/index.ts";

export interface TestServer {
  cb: RunningCardboard;
  dir: string;
  owner: string;
  clock: { now: number; advance(ms: number): void };
  admin<T = any>(op: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  app<T = any>(secret: string, op: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  newBox(name: string, tape?: Record<string, unknown>): Promise<{ box: Box; secret: string; tapeId: string }>;
  stop(): Promise<void>;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "cardboard-test-"));
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const cb = await startServer({ dataDir: join(dir, "data"), port: 0, now: () => clock.now, sweepEveryMs: 3_600_000, ...options });
  const owner = cb.ownerToken!;
  const post = async (path: string, secret: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${cb.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
  };
  const server: TestServer = {
    cb,
    dir,
    owner,
    clock,
    admin: (op, body, headers) => post(`/v1/admin/${op}`, owner, body, headers),
    app: (secret, op, body, headers) => post(`/v1/${op}`, secret, body, headers),
    async newBox(name, tape = {}) {
      const res = await server.admin("box.create", { name, ...tape });
      if (res.status !== 200) throw new Error(`box.create failed: ${JSON.stringify(res.body)}`);
      return {
        box: open({ url: cb.url, tape: res.body.secret, onNotice: false }),
        secret: res.body.secret,
        tapeId: res.body.tape.id,
      };
    },
    async stop() {
      await cb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}

/** Just enough of a browser: keeps cookies, doesn't follow redirects, sends Origin on posts. */
export class Browser {
  private readonly cookies = new Map<string, string>();
  private readonly origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }

  private remember(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, ...value] = pair!.split("=");
      this.cookies.set(name!, value.join("="));
    }
  }

  cookieHeader() {
    return [...this.cookies].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(url: string) {
    const res = await fetch(url, { redirect: "manual", headers: { cookie: this.cookieHeader() } });
    this.remember(res);
    return { status: res.status, location: res.headers.get("location"), html: await res.text() };
  }

  async post(url: string, form: Record<string, string>, origin = this.origin) {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: this.cookieHeader(), origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    this.remember(res);
    return { status: res.status, location: res.headers.get("location"), html: await res.text() };
  }
}

export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)) {
    fields[m[1]!] = m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return fields;
}
