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
  /** null while the device is locked: its token is in `lock`, sealed by the passkey. */
  token: string | null;
  key: KeyLike;
  lock?: DeviceLock | null;
}

/**
 * A device locked with a passkey (Face ID, Touch ID, Windows Hello, a phone's
 * fingerprint…). The passkey makes a secret (WebAuthn's PRF) that this device
 * never stores; the account key and the device token are sealed by a key made
 * from it. Someone holding this device, or a copy of its storage, gets
 * nothing without the face, finger or PIN.
 */
export interface DeviceLock {
  /**
   * "passkey": the key is made from a passkey's secret. "pin": from your PIN and a share the server
   * gives out only for the right PIN (three wrong tries, and it's gone), so a copy of this device's
   * storage can't be tried against PINs on its own.
   */
  kind: "passkey" | "pin";
  /** Which passkey to ask for (its credential id, base64url; "" for a PIN). */
  credential: string;
  /** What the passkey's PRF is asked to sign, or the PIN's salt (base64url). */
  salt: string;
  /** The device token, sealed by the passkey-made key (base64url). */
  token: string;
  /** Lock again after this long without use (ms); null = only when you say so. */
  idleMs: number | null;
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
