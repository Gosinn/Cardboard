import type { KeyLike } from "./crypto.ts";

/**
 * What a signed-in device remembers about itself. The token proves which
 * device it is; the key opens this device's sealed copy of the account key
 * (which the server keeps, so removing the device from your account makes
 * this record useless even if someone copies it).
 *
 * In a browser the key is a non-extractable WebCrypto key in IndexedDB: page
 * scripts can use it but never read it out. The CLI keeps it in a file only
 * you can read (~/.config/cardboard/device.json).
 */
export interface DeviceRecord {
  url: string;
  accountId: string;
  deviceId: string;
  token: string;
  key: KeyLike;
}

export interface DeviceStore {
  load(): Promise<DeviceRecord | null>;
  save(record: DeviceRecord): Promise<void>;
  clear(): Promise<void>;
}

/** Keeps a device in memory only (tests, the shake test, short scripts). */
export class MemoryStore implements DeviceStore {
  private record: DeviceRecord | null = null;

  async load() {
    return this.record;
  }

  async save(record: DeviceRecord) {
    this.record = record;
  }

  async clear() {
    this.record = null;
  }
}
