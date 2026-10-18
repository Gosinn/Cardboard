import { CardboardError } from "../shared/errors.ts";

/**
 * Talking to a Cardboard server: POST /v1/<op> with JSON. Used by the SDK
 * (with an app's tape), the CLI and the dashboard (with a device token), and
 * for the few calls that need no token at all (sign up, pairing, recovery).
 */

export type ErrorBody = { error?: { code?: string; message?: string; hint?: string } } | null;

export class Rpc {
  readonly url: string;
  token: string | null;
  readonly fetchImpl: typeof fetch;

  constructor(url: string, token: string | null, fetchImpl?: typeof fetch) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async call<T>(op: string, body: unknown = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new CardboardError("unreachable", 0, `Couldn't reach Cardboard at ${this.url}.`, "Is it running? Start it with: cardboard start");
    }
    const data = (await res.json().catch(() => null)) as ErrorBody;
    if (!res.ok) throw toError(res.status, data);
    return data as T;
  }
}

export function toError(status: number, data: ErrorBody): CardboardError {
  const e = data?.error;
  return new CardboardError(e?.code ?? `http_${status}`, status, e?.message ?? `Cardboard answered with HTTP ${status}.`, e?.hint);
}
