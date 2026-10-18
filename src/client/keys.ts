import { derive, fromB64u, hmac, random, toB64u } from "./crypto.ts";

/**
 * Cardboard's key hierarchy, in one place, so every device derives exactly the
 * same keys. Every key here is 32 random bytes or derived from one with HKDF.
 */

export interface AccountKeys {
  /** The account key itself. Only ever stored sealed (per device, recovery kit, friends). */
  root: Uint8Array;
  /** Seals box keys and dock keys. */
  wrap: Uint8Array;
  /** Seals names and labels: box names, dock names, device and tape labels, your profile. */
  meta: Uint8Array;
  /** Keyed hash of box names, so the server can find "notes" without knowing it's called that. */
  index: Uint8Array;
  /** Shared with your apps so they can find docks by name. Unrelated to every other key. */
  names: NamesKeys;
}

export interface NamesKeys {
  root: Uint8Array;
  index: Uint8Array;
}

export interface BoxKeys {
  root: Uint8Array;
  /** Seals item names and values (and what the app says about itself). */
  seal: Uint8Array;
  /** Keyed hash of item names. */
  index: Uint8Array;
  /** Seals dock keys handed to this box. */
  wrap: Uint8Array;
}

export interface DockKeys {
  root: Uint8Array;
  seal: Uint8Array;
}

export const newKey = (): Uint8Array => random(32);

export async function accountKeys(root: Uint8Array): Promise<AccountKeys> {
  const [wrap, meta, index, names] = await Promise.all([
    derive(root, "account-wrap"),
    derive(root, "account-meta"),
    derive(root, "account-index"),
    derive(root, "dock-names"),
  ]);
  return { root, wrap, meta, index, names: await namesKeys(names) };
}

export async function namesKeys(root: Uint8Array): Promise<NamesKeys> {
  return { root, index: await derive(root, "dock-index") };
}

export async function boxKeys(root: Uint8Array): Promise<BoxKeys> {
  const [seal, index, wrap] = await Promise.all([derive(root, "box-seal"), derive(root, "box-index"), derive(root, "box-wrap")]);
  return { root, seal, index, wrap };
}

export async function dockKeys(root: Uint8Array): Promise<DockKeys> {
  return { root, seal: await derive(root, "dock-seal") };
}

export async function itemIndex(box: BoxKeys, name: string): Promise<string> {
  return toB64u(await hmac(box.index, `item:${name}`));
}

export async function boxIndex(account: AccountKeys, name: string): Promise<string> {
  return toB64u(await hmac(account.index, `box:${name}`));
}

export async function dockIndex(names: NamesKeys, name: string): Promise<string> {
  return toB64u(await hmac(names.index, `dock:${name}`));
}

export { ctx } from "../shared/contexts.ts";

/**
 * What an app holds: the box key, plus the key for finding docks by name.
 * A tape carries it sealed; Sign in with Cardboard hands it over sealed to the app's own key.
 */
export interface Bundle {
  v: 1;
  boxId: string;
  box: string;
  names: string;
}

export function bundle(boxId: string, box: Uint8Array, names: Uint8Array): Bundle {
  return { v: 1, boxId, box: toB64u(box), names: toB64u(names) };
}

export function readBundle(value: unknown): { boxId: string; box: Uint8Array; names: Uint8Array } {
  const b = value as Partial<Bundle> | null;
  if (!b || b.v !== 1 || typeof b.boxId !== "string" || typeof b.box !== "string" || typeof b.names !== "string") {
    throw new Error("That key bundle isn't one Cardboard understands.");
  }
  return { boxId: b.boxId, box: fromB64u(b.box), names: fromB64u(b.names) };
}

/** Client-chosen ids, so things can be sealed to their own id before the server has seen them. */
export function newClientId(prefix: "box" | "dock" | "pcl"): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `${prefix}_${[...random(16)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}
