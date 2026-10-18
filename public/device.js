// This browser as a Cardboard device. The device key is a non-extractable
// WebCrypto key kept in IndexedDB: scripts on this page can use it to open
// your account key, but nothing can read the key itself out of the browser.
import { lockedKey } from "/lib/client/crypto.ts";

const DB = "cardboard";
const STORE = "device";
const KEY = "this-browser";

function database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let memory = null;
let persistent = typeof indexedDB !== "undefined";

/** A DeviceStore (see src/client/device.ts) backed by IndexedDB, or memory if this browser won't keep anything. */
export const browserStore = {
  async load() {
    if (!persistent) return memory;
    try {
      return (await run("readonly", (s) => s.get(KEY))) ?? null;
    } catch {
      persistent = false;
      return memory;
    }
  },
  async save(record) {
    memory = record;
    if (!persistent) return;
    try {
      await run("readwrite", (s) => s.put(record, KEY));
      // Ask the browser not to clear this under storage pressure: it's this device's key.
      navigator.storage?.persist?.().catch(() => {});
    } catch {
      persistent = false;
    }
  },
  async clear() {
    memory = null;
    if (!persistent) return;
    try {
      await run("readwrite", (s) => s.delete(KEY));
    } catch {
      persistent = false;
    }
  },
  /** False in private windows and browsers that refuse storage: you'll have to sign in again next time. */
  get remembers() {
    return persistent;
  },
};

export const makeKey = () => lockedKey();

/** A friendly default name for this browser, e.g. "Firefox on Mac". */
export function browserName() {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
