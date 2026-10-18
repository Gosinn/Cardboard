import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceRecord, DeviceStore } from "../client/device.ts";

/** Where the CLI keeps what it remembers: ~/.config/cardboard (or $XDG_CONFIG_HOME/cardboard). */
export function configDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "cardboard");
}

export function writePrivate(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * This computer as a Cardboard device: its token and its key, in a file only
 * you can read. Removing the device from your account (from any other device)
 * makes this file useless, because the server deletes the sealed account key
 * that the key in here opens.
 */
export class FileStore implements DeviceStore {
  readonly file: string;

  constructor(file = join(configDir(), "device.json")) {
    this.file = file;
  }

  async load(): Promise<DeviceRecord | null> {
    let data: { url?: string; accountId?: string; deviceId?: string; token?: string; key?: string };
    try {
      data = JSON.parse(readFileSync(this.file, "utf8")) as typeof data;
    } catch {
      return null;
    }
    if (!data.url || !data.accountId || !data.deviceId || !data.token || !data.key) return null;
    return { url: data.url, accountId: data.accountId, deviceId: data.deviceId, token: data.token, key: new Uint8Array(Buffer.from(data.key, "base64url")) };
  }

  async save(record: DeviceRecord) {
    if (!(record.key instanceof Uint8Array)) throw new Error("The CLI stores raw device keys.");
    const { key, ...rest } = record;
    writePrivate(this.file, `${JSON.stringify({ ...rest, key: Buffer.from(key).toString("base64url") }, null, 2)}\n`);
  }

  async clear() {
    rmSync(this.file, { force: true });
  }
}
