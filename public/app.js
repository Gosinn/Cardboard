// Cardboard dashboard. No framework, no build step. Your keys live in this
// browser, so everything is opened right here: the server only ever sends
// sealed bytes. Anything that came from an app (key names, values, labels) is
// inserted with textContent, never as HTML.
import { claimEmergency, cleanInvite, deviceLock, joinDevice, recoverWithFriends, recoverWithKit, requestEmergency, signUp, startPairing, unlock, viewEmergency } from "/lib/client/account.ts";
import { qrEncode, qrPath } from "/lib/shared/qr.ts";
import { describeDuration } from "/lib/shared/duration.ts";
import { toName } from "/lib/shared/names.ts";
import { createPasskey, hasBuiltInPasskeys, passkeyBlocker, passkeySecret } from "/lib/client/passkey.ts";
import {
  addFile,
  FILE_DATA,
  fileChunks,
  FRIEND_ABOUT,
  KINDS,
  keysOf,
  listThings,
  MAX_FILE_BYTES,
  OLD_BOX_QUOTA,
  PERSONAL_SETTINGS,
  purgeKeys,
  readFile,
  readRange,
  removeThing,
  restoreThing,
  safeUrl,
  saveFileDetails,
  saveThing,
  searchText,
  sendFile,
  sendText,
  keepThing,
  strayParts,
  strongPassword,
  subtitle,
} from "/lib/client/personal.ts";
import { Rpc } from "/lib/client/rpc.ts";
import { open as openBox } from "/lib/sdk/index.ts";
import { withoutLocation } from "/lib/client/privacy.ts";
import { browserName, browserStore, makeKey } from "/device.js";

const app = document.getElementById("app");
// Everything imported fine: tell boot.js the dashboard is running.
app.dataset.started = "1";
const nav = document.getElementById("nav");

/**
 * Docks, apps, tapes and new boxes are for people who connect their own apps.
 * They're out of the way until you have such a box, or turn them on under You.
 */
let builderAuto = false;
function builderOn() {
  try {
    const chosen = localStorage.getItem("cardboard-builder");
    if (chosen) return chosen === "on";
  } catch {
    // Then it goes by what you have.
  }
  return builderAuto;
}
function showBuilder() {
  for (const a of nav.querySelectorAll(".builder")) a.hidden = !builderOn();
}
const modal = document.getElementById("modal");
const ORIGIN = location.origin;

/** The opened account, while this page is open. */
let account = null;
/** A sign-in request from an app, waiting for this browser to be signed in. */
let pendingConnect = null;
/** A share link someone sent you (its code), waiting for this browser to be signed in. */
let pendingShare = null;
/** An emergency access link someone gave you (its code). */
let pendingEmergency = null;
/** A pairing code scanned from a new device's screen, to approve here. */
let pendingPair = null;
/** A friend box's link (#friend=cbt_…), opened by anyone: no account needed. Kept for this tab so a reload works. */
let pendingFriend = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** replaceChildren, but flattening arrays and skipping null/false like h() does. */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ago(at) {
  if (!at) return "never";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = "B";
  for (const unit of units) {
    if (v < 1024) break;
    v /= 1024;
    u = unit;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u}`;
}

const KIND = {
  "private-key": "private key",
  "api-key": "API key",
  jwt: "login token",
  password: "plain password",
  "card-number": "card number",
  iban: "bank account",
  kennitala: "kennitala",
  ssn: "SSN",
  email: "email",
  phone: "phone",
};
const SECRET = new Set(["private-key", "api-key", "jwt", "password"]);

function sensitiveChips(sensitive) {
  return Object.entries(sensitive || {})
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => h("span", { class: `chip ${SECRET.has(kind) ? "warn" : ""}` }, `${n} × ${KIND[kind] || kind}`));
}

function errorBox(err) {
  return h("div", { class: "error" }, err.reason || err.message, err.hint ? h("div", { class: "small" }, err.hint) : null);
}

function copyButton(text, label = "Copy") {
  const btn = h("button", { class: "secondary tiny", type: "button" }, label);
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select & copy";
    }
    setTimeout(() => (btn.textContent = label), 1500);
  });
  return btn;
}

/** A QR code of `text`, drawn as SVG (dark on white, whatever the theme, so cameras read it). */
function qrCode(text, label = "QR code") {
  const NS = "http://www.w3.org/2000/svg";
  const matrix = qrEncode(text);
  const size = matrix.length + 8;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const dots = document.createElementNS(NS, "path");
  dots.setAttribute("d", qrPath(matrix));
  dots.setAttribute("fill", "#000");
  svg.append(bg, dots);
  return svg;
}

/** Copy, and on phones the share sheet. */
function sendButtons(link, title) {
  const send = navigator.share ? h("button", { type: "button", class: "secondary", onclick: () => navigator.share({ title, url: link }).catch(() => {}) }, "Send…") : null;
  return h("div", { class: "row" }, copyButton(link, "Copy link"), send);
}

/** Something worth a look, with a button to where it's fixed (the command-line fix is for the command line). */
function insightCard(i) {
  return h("div", { class: `insight ${i.level}` }, h("div", { class: "title" }, i.title), h("div", { class: "detail" }, i.detail), i.go ? h("div", { class: "fix" }, h("a", { class: "button secondary tiny", href: i.go.page }, i.go.label)) : null);
}

let onModalClose = null;

function openModal(onClose, ...content) {
  onModalClose = onClose || null;
  modal.replaceChildren(h("div", { class: "card stack" }, ...content));
  modal.hidden = false;
}

/** Closes the modal. `notify: false` skips its close hook (used when re-rendering). */
function closeModal(notify = true) {
  if (modal.hidden) return;
  modal.hidden = true;
  delete modal.dataset.keep;
  for (const el of modal.querySelectorAll("video, audio")) el.pause();
  forgetMedia("play");
  modal.replaceChildren();
  const hook = onModalClose;
  onModalClose = null;
  if (notify && hook) hook();
}

modal.addEventListener("click", (e) => {
  if (e.target === modal && !modal.dataset.sticky && !modal.dataset.keep) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden && !modal.dataset.sticky) closeModal();
});

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

/** A form whose submit runs `fn` with errors shown in `status`. */
function onSubmit(form, status, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    if (button) button.disabled = true;
    try {
      await fn();
    } catch (err) {
      status.replaceChildren(errorBox(err));
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function showSecret(title, secret, box, extra, onDone) {
  openModal(
    onDone,
    h("h2", {}, title),
    h("p", {}, "This is the only time Cardboard will show this tape. Put it in your app's ", h("code", {}, ".env"), ":"),
    h("code", { class: "secret" }, `CARDBOARD_TAPE=${secret}`),
    h("div", { class: "row" }, copyButton(`CARDBOARD_TAPE=${secret}`, "Copy line"), copyButton(secret, "Copy tape only")),
    h("p", { class: "muted small" }, "The tape carries this box's key, so treat it like a password. ", extra || ""),
    h("p", { class: "muted small" }, "Or skip all this: in the app's folder run ", h("code", {}, `cardboard connect ${box}`), "."),
    h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Done")),
  );
}

/** Recovery kit or friends' pieces, shown once. Closing needs a tick that you saved them. */
function showRecovery(result, onDone) {
  const saved = h("input", { type: "checkbox" });
  const done = h("button", { type: "button", disabled: true }, "Done");
  saved.addEventListener("change", () => (done.disabled = !saved.checked));
  done.addEventListener("click", () => {
    delete modal.dataset.sticky;
    closeModal();
  });
  const all = result.kit ? result.kit : result.pieces.map((p, i) => `Piece ${i + 1}: ${p}`).join("\n");
  const download = h("button", { type: "button", class: "secondary" }, "Download as a text file");
  download.addEventListener("click", () => {
    const text = result.kit
      ? `Cardboard recovery kit\n${ORIGIN}\nAccount: ${account?.id ?? ""}\n\n${result.kit}\n\nKeep this somewhere safe. It's the only way back in if you lose every device.\n`
      : `Cardboard: trusted friends' pieces\n${ORIGIN}\n\n${all}\n\nAny ${result.threshold} of these open the account. Give one piece to each friend.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = h("a", { href: url, download: result.kit ? "cardboard-recovery-kit.txt" : "cardboard-friends-pieces.txt" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  modal.dataset.sticky = "1";
  openModal(
    onDone,
    h("h2", {}, result.kit ? "Your recovery kit" : "Your friends' pieces"),
    result.kit
      ? h("p", {}, "If you ever lose every device, this code is the only way back in. Nobody can reset it for you, not even whoever runs Cardboard. That's what keeps your data yours.")
      : h("p", {}, `Give one piece to each friend. Any ${result.threshold} of them, together, get you back in. One piece alone reveals nothing.`),
    result.kit ? h("code", { class: "secret big" }, result.kit) : h("div", { class: "stack" }, result.pieces.map((p, i) => h("div", { class: "row" }, h("strong", {}, `Piece ${i + 1}`), h("code", { class: "secret" }, p), copyButton(p)))),
    h("div", { class: "row" }, copyButton(all, "Copy"), download, h("button", { type: "button", class: "secondary", onclick: () => window.print() }, "Print")),
    h("p", { class: "muted small" }, "Keep it in a password manager, or printed somewhere safe. Making a new one later retires this one."),
    h("label", { class: "check" }, saved, result.kit ? "I've saved my recovery kit" : "I've handed out (or saved) the pieces"),
    h("div", { class: "row" }, done),
  );
}

async function signOutHere() {
  if (!confirm("Sign this browser out? Its copy of your account key is deleted from the server, so you'd pair it again (or use your recovery kit) to come back.")) return;
  try {
    await account.signOut();
  } catch {
    await browserStore.clear();
  }
  account = null;
  forgetMedia();
  location.hash = "#/";
  render();
}

document.getElementById("signout").addEventListener("click", signOutHere);

// ── Locking (Face ID…) ──────────────────────────────────────────────────────

const lockButton = document.getElementById("lock");
let lastActive = Date.now();
for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(event, () => (lastActive = Date.now()), { passive: true });

/** Drops the opened account (and its keys) from this page and shows the lock screen. */
function lockNow() {
  if (!account?.lock) return;
  account = null;
  forgetMedia();
  delete modal.dataset.sticky;
  closeModal(false);
  render();
}
lockButton.addEventListener("click", lockNow);

// ── Playing and downloading big files (with media-sw.js) ─────────────────────
//
// A video plays a piece at a time: the player asks for /media/<token>/…, the
// media helper (a service worker) asks this page for those bytes, and this
// page fetches the sealed parts and opens them. Keys never leave this page,
// and a token works only while this page holds it.

/** token → { info: { name, type, size? }, range?(start, end), chunks(), kind: "play" | "download", streams, used } */
const media = new Map();
let mediaHelper = null;
/** Safari, and every browser on iPhone and iPad: they play through the helper, but downloads go the old way. */
const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

/** Starts the media helper once; resolves true when it's answering for this page. */
function startMediaHelper() {
  if (!("serviceWorker" in navigator) || !isSecureContext) return Promise.resolve(false);
  mediaHelper ??= navigator.serviceWorker
    .register("/media-sw.js")
    .then(async () => {
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
          setTimeout(resolve, 5000);
        });
      }
      return Boolean(navigator.serviceWorker.controller);
    })
    .catch(() => false);
  return mediaHelper;
}

function offerMedia(entry) {
  const token = crypto.randomUUID();
  media.set(token, { ...entry, streams: new Map(), used: Date.now() });
  return `/media/${token}/${encodeURIComponent(entry.info.name)}`;
}

/** Stops answering for players (closing the file), or for everything (locking, signing out). */
function forgetMedia(kind) {
  for (const [token, entry] of media) {
    if (kind && entry.kind !== kind) continue;
    for (const stream of entry.streams.values()) stream.return?.();
    media.delete(token);
  }
}
setInterval(() => {
  for (const [token, entry] of media) if (entry.kind === "download" && Date.now() - entry.used > 30 * 60_000) media.delete(token);
}, 60_000);

navigator.serviceWorker?.addEventListener("message", async (e) => {
  const port = e.ports[0];
  if (!port || e.data?.cardboard !== "media") return;
  const { type, token, stream } = e.data;
  const entry = media.get(token);
  if (!entry) return port.postMessage({ error: "This file isn't open on this page." });
  entry.used = Date.now();
  try {
    if (type === "info") return port.postMessage(entry.info);
    if (type === "read") {
      if (!entry.range) throw new Error("This can't be read in pieces.");
      const bytes = await entry.range(e.data.start, e.data.end);
      return port.postMessage({ bytes: bytes.buffer }, [bytes.buffer]);
    }
    if (type === "open") {
      const id = crypto.randomUUID();
      entry.streams.set(id, entry.chunks()[Symbol.asyncIterator]());
      return port.postMessage({ stream: id });
    }
    const it = entry.streams.get(stream);
    if (type === "close" || !it) {
      it?.return?.();
      entry.streams.delete(stream);
      return port.postMessage({ done: true });
    }
    const next = await it.next();
    if (next.done) {
      entry.streams.delete(stream);
      if (entry.kind === "download") media.delete(token);
      return port.postMessage({ done: true });
    }
    const copy = next.value.slice();
    port.postMessage({ bytes: copy.buffer }, [copy.buffer]);
  } catch (err) {
    port.postMessage({ error: err.reason || err.message });
  }
});

/** Saves a download a piece at a time (nothing big in memory). Returns what to tell you, or false if it can't here. */
async function streamDownload(entry, report) {
  if (IN_ANDROID_APP) return androidSave(entry.info, entry.chunks(), report);
  if (WEBKIT || !(await startMediaHelper())) return false;
  // A hidden frame, not <a download>: Chrome sends <a download> straight to the server, past the helper.
  // If anything goes wrong, the error lands in the frame, never in place of this page.
  const frame = h("iframe", { hidden: true, src: `${offerMedia({ ...entry, kind: "download" })}?download` });
  document.body.append(frame);
  setTimeout(() => frame.remove(), 60 * 60_000);
  return "Downloading. Keep this page open until it's done.";
}

/** Saves bytes held in memory (small files, or browsers without the helper). */
function blobDownload(parts, name) {
  const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Most a phone can hold in memory to hand a file over (share sheet, or a download without the helper). */
const IN_MEMORY_MAX = 300 * 1024 * 1024;

// ── The Cardboard app for Android (android/) ───────────────────────────────────
// It opens this page in its own window and hands it a message port, only ever to this
// Cardboard's address: for what you share to Cardboard from other apps, and to save downloads.

const IN_ANDROID_APP = /CardboardAndroid\/\d/.test(navigator.userAgent);
/** Bytes per message to or from the app (it takes at most 1 MiB). */
const ANDROID_PIECE = 512 * 1024;
let androidPort = null;
const androidWaiting = [];
const androidCalls = new Map();
let androidNextId = 1;
if (IN_ANDROID_APP) {
  addEventListener("message", (e) => {
    // Only the app posts with no source window: no other page can pose as it.
    if (e.source !== null || e.data !== "cardboard-android" || !e.ports[0]) return;
    androidPort = e.ports[0];
    androidPort.onmessage = (m) => {
      let reply;
      try {
        reply = JSON.parse(m.data);
      } catch {
        return;
      }
      const call = androidCalls.get(reply.id);
      if (!call) return;
      androidCalls.delete(reply.id);
      if (reply.error) call.reject(new Error(reply.error));
      else call.resolve(reply);
    };
    for (const wake of androidWaiting.splice(0)) wake();
  });
}

/** Asks the Android app to do something, and resolves with its answer. */
async function androidCall(op, args = {}) {
  if (!androidPort) {
    await new Promise((resolve, reject) => {
      androidWaiting.push(resolve);
      setTimeout(() => reject(new Error("The Cardboard app isn't answering this page. Close the app and open it again.")), 10_000);
    });
  }
  const id = androidNextId++;
  return new Promise((resolve, reject) => {
    androidCalls.set(id, { resolve, reject });
    androidPort.postMessage(JSON.stringify({ id, op, ...args }));
  });
}

function toBase64(data) {
  if (data.toBase64) return data.toBase64();
  let text = "";
  for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const raw = atob(text);
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
  return data;
}

/** Saves a download into the phone's Downloads › Cardboard folder, a piece at a time. */
async function androidSave(info, chunks, report) {
  const { handle } = await androidCall("save-start", { name: info.name, type: info.type || "" });
  let done = 0;
  try {
    for await (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += ANDROID_PIECE) {
        const piece = chunk.subarray(i, i + ANDROID_PIECE);
        await androidCall("save", { handle, data: toBase64(piece) });
        done += piece.length;
        report?.(`Saving… ${bytes(done)}${info.size ? ` of ${bytes(info.size)}` : ""}`);
      }
    }
    const { where } = await androidCall("save-end", { handle, ok: true });
    return `Saved in ${where} on this phone.`;
  } catch (err) {
    androidCall("save-end", { handle, ok: false }).catch(() => {});
    throw err;
  }
}

/** Reads part of a file shared to the app, from `start` up to `end`. */
async function androidRead(file, start, end) {
  const parts = [];
  for (let at = start; at < end; ) {
    const piece = fromBase64((await androidCall("read", { file: file.n, offset: at, length: Math.min(ANDROID_PIECE, end - at) })).data);
    if (!piece.length) throw new Error(`${file.name} got shorter while it was being sent. Share it again.`);
    parts.push(piece);
    at += piece.length;
  }
  return parts;
}

/** What was shared to the app: its text, and its files, each read from the phone only as it's sealed. */
async function takeAndroidShare() {
  const shared = await androidCall("share");
  if (shared.none) return null;
  const files = [];
  for (const f of shared.files) {
    if (f.size >= 0) {
      // Just what sendFile reads: name, type, size and slice(). Nothing is held in memory.
      files.push({ name: f.name, type: f.type, size: f.size, slice: (start, end) => ({ arrayBuffer: async () => new Blob(await androidRead(f, start, Math.min(end, f.size))).arrayBuffer() }) });
      continue;
    }
    // The app that shared it didn't say how big it is: read it to the end.
    const parts = [];
    for (let at = 0; ; ) {
      const piece = fromBase64((await androidCall("read", { file: f.n, offset: at, length: ANDROID_PIECE })).data);
      if (!piece.length) break;
      parts.push(piece);
      at += piece.length;
      if (at > IN_MEMORY_MAX) throw new Error(`${f.name} is too big to send without knowing its size. Open Cardboard and attach it instead.`);
    }
    files.push(new File(parts, f.name, { type: f.type }));
  }
  return { text: shared.text, files, done: () => androidCall("share-done").catch(() => {}) };
}

function lockIfIdle() {
  const idle = account?.lock?.idleMs;
  // A recovery kit on screen waits for you to save it first.
  if (idle && Date.now() - lastActive > idle && !modal.dataset.sticky) lockNow();
}
setInterval(lockIfIdle, 15_000);
document.addEventListener("visibilitychange", lockIfIdle);

const IDLE_CHOICES = [
  [60_000, "1 minute"],
  [5 * 60_000, "5 minutes"],
  [15 * 60_000, "15 minutes"],
  [60 * 60_000, "1 hour"],
  [4 * 60 * 60_000, "4 hours"],
  [null, "only when I press Lock"],
];

function renderLocked() {
  nav.hidden = true;
  const logo = document.querySelector(".brand svg").cloneNode(true);
  const status = h("div");
  const button = h("button", { type: "button" }, "Unlock");
  button.addEventListener("click", () =>
    withBusy(button, async () => {
      status.replaceChildren();
      try {
        account = await unlock(browserStore, { passkey: passkeySecret });
        lastActive = Date.now();
        render();
      } catch (err) {
        if (err.code === "bad_device") {
          await browserStore.clear();
          return render();
        }
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  const other = h("button", { type: "button", class: "link small" }, "Lost the passkey? Sign in another way");
  other.addEventListener("click", async () => {
    if (!confirm("Forget this browser's sign-in and start again? You'd pair it from another device or use your recovery kit. Then remove its old entry from your device list.")) return;
    await browserStore.clear();
    render();
  });
  fill(
    app,
    h(
      "section",
      { class: "card stack login" },
      h("div", { class: "row" }, logo, h("h1", {}, "Cardboard is locked")),
      pendingConnect
        ? h("p", {}, "An app wants you to sign in with Cardboard. Unlock first.")
        : pendingShare
          ? h("p", {}, "Someone shared a box with you. Unlock first, then you can join it.")
        : h("p", { class: "muted" }, "Unlock with Face ID, Touch ID, Windows Hello or your passkey. Without it, this browser can't open anything, even with its storage copied."),
      h("div", { class: "row" }, button),
      status,
      h("div", {}, other),
    ),
  );
  button.focus();
}

/** The "This browser" card on You: lock it with a passkey, or change how it locks. */
async function lockCard() {
  const status = h("div");
  if (!account.lock) {
    const blocker = await passkeyBlocker();
    if (blocker) return h("section", { class: "card stack" }, h("h2", {}, "Lock with Face ID"), h("p", { class: "small muted" }, blocker));
    const builtIn = await hasBuiltInPasskeys();
    const button = h("button", { type: "button" }, "Lock with Face ID");
    button.addEventListener("click", () =>
      withBusy(button, async () => {
        status.replaceChildren();
        try {
          const me = await account.me();
          const passkey = await createPasskey({ name: `Cardboard on ${me.devices.find((d) => d.current)?.name ?? browserName()}`, site: `Cardboard (${location.host})` });
          await account.lockWithPasskey(passkey);
          lastActive = Date.now();
          render();
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );
    return h(
      "section",
      { class: "card stack" },
      h("h2", {}, "Lock with Face ID"),
      h(
        "p",
        { class: "small" },
        "Make a passkey for this browser. After that, opening your Cardboard here takes your face, fingerprint or PIN, and it locks again when you leave it alone. Someone with your unlocked phone or laptop, or a copy of its storage, gets nothing.",
      ),
      builtIn ? null : h("p", { class: "small muted" }, "This device has no built-in Face ID or fingerprint, so your browser will offer a security key or your phone instead."),
      h("div", { class: "row" }, button),
      status,
    );
  }
  const idle = h(
    "select",
    { "aria-label": "Lock again after" },
    IDLE_CHOICES.map(([ms, label]) => h("option", { value: String(ms), selected: ms === account.lock.idleMs }, label)),
  );
  idle.addEventListener("change", async () => {
    try {
      await account.setLockIdle(idle.value === "null" ? null : Number(idle.value));
      status.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });
  const remove = h("button", { type: "button", class: "secondary tiny" }, "Remove the lock");
  remove.addEventListener("click", () =>
    withBusy(remove, async () => {
      if (!confirm("Take the Face ID lock off this browser? Anyone using it could open your Cardboard again.")) return;
      await account.removeLock();
      render();
    }),
  );
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Locked with Face ID ", h("span", { class: "chip ok" }, "on")),
    h("p", { class: "small" }, "Opening your Cardboard in this browser takes your passkey. Your data never leaves sealed form without it."),
    h("label", { class: "row small" }, "Lock again after", idle),
    h("div", { class: "row" }, h("button", { type: "button", class: "secondary tiny", onclick: lockNow }, "Lock now"), remove),
    status,
  );
}

// ── Getting in ──────────────────────────────────────────────────────────────

function hashParam(name) {
  const match = new RegExp(`[#&]${name}=([^&]+)`).exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

function getInOptions(label) {
  return { url: ORIGIN, store: browserStore, kind: "browser", label: label || browserName(), makeKey };
}

async function hello() {
  return new Rpc(ORIGIN, null).call("hello");
}

/**
 * A friend arriving from an app with an invite: one screen, "Make my
 * account", then the app's own "Allow" screen, then straight back to the app.
 */
async function renderAppJoin(info) {
  nav.hidden = true;
  const who = await new Rpc(ORIGIN, null).call("oauth.who", { id: pendingConnect.id }).catch(() => null);
  const appName = who?.app ?? "This app";
  const name = deviceNameField();
  const status = h("div");
  const other = h("button", { type: "button", class: "link small" }, "I already have Cardboard");
  other.addEventListener("click", () => {
    pendingConnect.invite = null;
    renderWelcome(info);
  });
  const form = h(
    "form",
    { class: "card stack login" },
    h("div", { class: "row" }, document.querySelector(".brand svg").cloneNode(true), h("h1", {}, `${appName} keeps your things in Cardboard`)),
    h("p", {}, `They're locked on your device before they're saved, so whoever runs the server they're kept on can't read them. You can see what ${appName} keeps, undo it or wipe it, any time. Make your Cardboard account here, then let ${appName} in.`),
    h("label", { class: "field" }, "What to call this device", name),
    h("button", { type: "submit" }, "Make my account"),
    status,
    h("div", { class: "row" }, other),
    info?.shake ? h("p", { class: "muted small" }, `This server's self-test: ${info.shake.summary}.`) : null,
  );
  onSubmit(form, status, async () => {
    const { account: opened, kit } = await signUp({ ...getInOptions(name.value.trim()), invite: pendingConnect.invite });
    account = opened;
    pendingConnect.invite = null;
    history.replaceState(null, "", `#connect=${pendingConnect.id}`);
    showRecovery({ kit }, render);
  });
  fill(app, form);
}

function renderWelcome(info) {
  if (pendingConnect?.invite) return renderAppJoin(info);
  nav.hidden = true;
  const invite = hashParam("invite");
  const logo = document.querySelector(".brand svg").cloneNode(true);
  const remembers = browserStore.remembers ? null : h("p", { class: "error small" }, "This browser won't remember you (private window?). You'll need to sign in again next time.");
  const intro = pendingConnect
    ? h("p", {}, h("strong", {}, pendingConnect.appName ?? "An app"), " wants you to sign in with Cardboard. First, open your Cardboard in this browser.")
    : pendingShare
      ? h("p", {}, "Someone shared a box with you. First, open your Cardboard in this browser. No account here yet? Ask whoever runs this Cardboard for an invite, then open the link again.")
      : pendingPair
        ? h("p", { class: "error" }, "That pairing code is for approving a new device, so scan it with a phone or computer that's already signed in to your Cardboard.")
      : h("p", { class: "muted" }, "Your private, end-to-end encrypted deposit box. Your keys live on your devices: whoever runs this server can't read anything you keep here.");

  const panes = {
    pair: pairPane(),
    invite: inviteForm(invite),
    kit: kitForm(),
    friends: friendsForm(),
  };
  const ways = [
    ["pair", "Add this device"],
    ["invite", invite ? "Make my account" : "I'm new (I have an invite)"],
    ["kit", "My recovery kit"],
    ["friends", "Friends' pieces"],
  ];
  const body = h("div", { class: "stack" });
  // One way in on screen at a time; the others are a tap away underneath.
  const others = h("p", { class: "muted small row other-ways" });
  const show = (id) => {
    fill(body, panes[id]);
    fill(others, "Other ways in:", ways.filter(([w]) => w !== id).map(([w, label]) => h("button", { type: "button", class: "link small", onclick: () => show(w) }, label)));
  };
  show(invite ? "invite" : "pair");
  fill(app, 
    h(
      "section",
      { class: "card stack login" },
      h("div", { class: "row" }, logo, h("h1", {}, invite ? "Welcome to Cardboard" : "Open your Cardboard")),
      intro,
      remembers,
      body,
      others,
      ON_ANDROID ? h("p", { class: "muted small row" }, "On this phone, Cardboard works best as its app. ", androidAppLink("Get the app")) : null,
      info?.shake ? h("p", { class: "muted small" }, `This server's self-test: ${info.shake.summary}.`) : null,
    ),
  );
}

function deviceNameField() {
  return h("input", { value: browserName(), maxlength: 60, "aria-label": "What to call this browser" });
}

function inviteForm(invite) {
  const code = h("input", { value: invite ? `${ORIGIN}/#invite=${invite}` : "", placeholder: "https://…/#invite=cbi_…", required: true });
  const name = deviceNameField();
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("p", { class: "small" }, "Make an account. This browser gets your keys; you'll get a recovery kit to keep safe."),
    // From an invite link, it's already filled in: nothing to look at.
    invite ? h("details", { class: "small" }, h("summary", { class: "muted" }, "Invite (from your link)"), h("label", { class: "field" }, "Invite link or code", code)) : h("label", { class: "field" }, "Invite link or code", code),
    h("label", { class: "field" }, "What to call this browser", name),
    h("button", { type: "submit" }, "Make my account"),
    status,
  );
  onSubmit(form, status, async () => {
    const { account: opened, kit } = await signUp({ ...getInOptions(name.value.trim()), invite: cleanInvite(code.value) });
    account = opened;
    // Made now, while this is the only device: then the first thing sent from anywhere arrives live everywhere.
    await account.makePersonalBox().catch(() => {});
    history.replaceState(null, "", pendingConnect ? `#connect=${pendingConnect.id}` : "#/");
    showRecovery({ kit }, render);
  });
  return form;
}

/**
 * The new device's side of "Add a device": press the button here, press Add a
 * device on a device you're signed in on, and check both show the same number.
 */
function pairPane() {
  const status = h("div", { class: "stack" });
  const start = h("button", { type: "button" }, "Add this device");
  const pane = h(
    "div",
    { class: "stack" },
    h("p", {}, "Signed in on another device, like your laptop? Press the button, then say yes there. Nothing to type."),
    start,
    status,
    h("details", { class: "small" }, h("summary", {}, "Or use a pairing code"), codePairPane()),
  );
  start.addEventListener("click", () =>
    withBusy(start, async () => {
      fill(
        status,
        h("p", {}, "Now, on your other device: open Cardboard and press ", h("strong", {}, "Add a device"), " (at the top of your shelf)."),
        h("p", { class: "muted small" }, "Waiting for it… (up to 5 minutes)"),
      );
      try {
        const joining = await joinDevice(getInOptions(""));
        start.hidden = true;
        const said = await new Promise((resolve) => {
          const yes = h("button", { type: "button" }, "Yes, it matches");
          const no = h("button", { type: "button", class: "secondary" }, "No");
          yes.addEventListener("click", () => resolve(true));
          no.addEventListener("click", () => resolve(false));
          fill(
            status,
            h("p", {}, "Does your other device show this same number?"),
            h("div", { class: "pair-number" }, joining.number),
            h("p", { class: "small" }, "Only say yes if it's ", h("strong", {}, "your"), " device, in front of you, showing exactly this. If it shows nothing, or another number, press No: someone else answered."),
            h("div", { class: "row" }, yes, no),
          );
        });
        if (!said) {
          start.hidden = false;
          return fill(status, h("p", {}, "Nothing was added. Press Add this device to try again, then Add a device on your other device."));
        }
        await joining.confirm();
        fill(status, h("p", { class: "muted small" }, "Now press Yes on your other device too (if you haven't)…"));
        account = await joining.wait();
        render();
      } catch (err) {
        start.hidden = false;
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  return pane;
}

/** "Add a device", on a device you're signed in on: a number shows here and on the new device. Same number, press Yes. */
function addDevice() {
  const controller = new AbortController();
  let offer = null;
  const status = h(
    "div",
    { class: "stack" },
    h("p", {}, "On the new device (your phone, another computer), open Cardboard and press ", h("strong", {}, "Add this device"), "."),
    h("p", { class: "muted small" }, "Waiting for it… (up to 5 minutes)"),
  );
  const close = h("button", { type: "button", class: "secondary" }, "Cancel");
  close.addEventListener("click", () => closeModal());
  openModal(
    () => {
      controller.abort();
      offer?.cancel();
    },
    h("h2", {}, "Add a device"),
    status,
    h("div", { class: "row" }, close),
  );
  account
    .offerDevice({ signal: controller.signal })
    .then((answered) => {
      offer = answered;
      const yes = h("button", { type: "button" }, "Yes, add it");
      const no = h("button", { type: "button", class: "secondary" }, "No");
      no.addEventListener("click", () => closeModal());
      yes.addEventListener("click", () =>
        withBusy(yes, async () => {
          try {
            const added = await answered.approve();
            offer = null; // Said yes: closing now mustn't cancel it.
            fill(
              status,
              added.id
                ? h("p", {}, h("span", { class: "chip ok" }, "Added"), " It's opening your Cardboard now.")
                : h("p", {}, "Now press ", h("strong", {}, "Yes, it matches"), " on the new device too. It opens your Cardboard as soon as you do."),
            );
            close.textContent = "Done";
            close.hidden = false;
            close.addEventListener("click", () => render());
          } catch (err) {
            status.replaceChildren(errorBox(err));
          }
        }),
      );
      fill(
        status,
        h("p", {}, `A new device (${answered.kind === "browser" ? "a browser or the app" : answered.kind === "cli" ? "a command line" : "a device"}) answered. Does it show this number?`),
        h("div", { class: "pair-number" }, answered.number),
        h("p", { class: "small" }, h("strong", {}, "Only press Yes if it's the device in front of you, showing exactly this number."), " A different number (or none) means someone else answered: press No."),
        h("div", { class: "row" }, yes, no),
      );
      close.hidden = true;
    })
    .catch((err) => {
      if (err?.code === "cancelled") return;
      status.replaceChildren(errorBox(err));
    });
}

/** The older way: this device shows a code to type (or scan) on one you're signed in on. */
function codePairPane() {
  const status = h("div");
  const name = deviceNameField();
  const start = h("button", { type: "button" }, "Show me a pairing code");
  const pane = h(
    "div",
    { class: "stack" },
    h("p", { class: "small" }, "Already signed in somewhere else (your laptop, your phone)? Get a code here, then approve it there."),
    h("label", { class: "field" }, "What to call this browser", name),
    start,
    status,
  );
  start.addEventListener("click", () =>
    withBusy(start, async () => {
      try {
        const pending = await startPairing(getInOptions(name.value.trim()));
        fill(
          status,
          h("div", { class: "stack" },
            h("p", {}, "Scan this with your phone (where you're signed in to Cardboard):"),
            qrCode(`${ORIGIN}/#pair=${pending.code}`, "QR code to approve this browser"),
            h("p", {}, "Or type this code on a device that's already signed in:"),
            h("code", { class: "secret big" }, pending.code),
            h("p", { class: "small" }, "It's under ", h("strong", {}, "You → Devices → Or type a pairing code"), ". Or run:"),
            h("code", { class: "secret" }, `cardboard devices add ${pending.code}`),
            h("p", { class: "muted small" }, "Waiting for you to approve it (the code works for 10 minutes)…"),
          ),
        );
        start.hidden = true;
        account = await pending.wait();
        render();
      } catch (err) {
        status.replaceChildren(errorBox(err));
        start.hidden = false;
      }
    }),
  );
  return pane;
}

function kitForm() {
  const code = h("input", { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", required: true, autocomplete: "off", spellcheck: "false" });
  const name = deviceNameField();
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("p", { class: "small" }, "Lost your devices? Your recovery kit opens your account on this browser."),
    h("label", { class: "field" }, "Recovery kit", code),
    h("label", { class: "field" }, "What to call this browser", name),
    h("button", { type: "submit" }, "Open my Cardboard"),
    status,
  );
  onSubmit(form, status, async () => {
    account = await recoverWithKit({ ...getInOptions(name.value.trim()), code: code.value });
    render();
  });
  return form;
}

function friendsForm() {
  const pieces = [0, 1, 2].map((i) => h("input", { placeholder: `Piece ${i + 1}${i === 2 ? " (if it takes three)" : ""}`, autocomplete: "off", spellcheck: "false", required: i < 2 }));
  const name = deviceNameField();
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("p", { class: "small" }, "Chose trusted friends? Ask enough of them for their pieces and type them in."),
    pieces,
    h("label", { class: "field" }, "What to call this browser", name),
    h("button", { type: "submit" }, "Open my Cardboard"),
    status,
  );
  onSubmit(form, status, async () => {
    account = await recoverWithFriends({ ...getInOptions(name.value.trim()), pieces: pieces.map((p) => p.value.trim()).filter(Boolean) });
    render();
  });
  return form;
}

// ── Shelf ───────────────────────────────────────────────────────────────────

async function renderShelf() {
  const [boxes, me, docks] = await Promise.all([account.boxes(), account.me(), account.docks()]);
  const personal = await account.personalBox(me);
  if (personal) PERSONAL_HOME = personal.name;
  const headLine = h("div", { class: "muted" }, `${bytes(me.quota.used)} of ${bytes(me.quota.limit)} used`);
  const personalShown = h("div", { class: "slot" }, personalCard(personal));
  /** After a send or an arrival: the personal box's card and the room used, as they are now. */
  const refreshCounts = async () => {
    const [fresh, now] = await Promise.all([account.boxes(), account.me()]);
    headLine.textContent = `${bytes(now.quota.used)} of ${bytes(now.quota.limit)} used`;
    const box = fresh.find((b) => b.id === personal?.id);
    if (box) fill(personalShown, personalCard(box));
  };
  const sending = await sendCard(me, personal, () => refreshCounts().catch(() => {}));
  const searchInput = h("input", { type: "search", placeholder: "Find anything in any box…", "aria-label": "Search every box" });
  const results = h("div");
  const search = h("form", { class: "search" }, searchInput, h("button", { type: "submit", class: "secondary" }, "Search"));
  onSubmit(search, results, async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) return results.replaceChildren();
    const [found, title] = await Promise.all([account.search(q), itemTitles()]);
    fill(
      results,
      h(
        "div",
        { class: "card" },
        h("h2", {}, found.length ? `Found in ${found.length} place${found.length === 1 ? "" : "s"}` : "Nothing found"),
        h("p", { class: "muted small" }, "Searched here in your browser. The server can't search what it can't read."),
        h(
          "ul",
          { class: "list" },
          found.map((r) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: `#/box/${encodeURIComponent(r.box)}/${encodeURIComponent(r.key)}` },
                title(r.box, r.key) ? [h("strong", {}, title(r.box, r.key)), h("span", { class: "muted" }, ` · in ${r.box === PERSONAL_HOME ? "your personal box" : r.box}`)] : [h("strong", {}, r.box), " · ", h("span", { class: "mono" }, r.key)],
              ),
              r.snippet ? h("div", { class: "muted small mono" }, `…${r.snippet}…`) : null,
            ),
          ),
        ),
      ),
    );
  });

  const shake = me.server.shake;
  const shakeChip = shake ? h("a", { href: "#/security", class: `chip ${shake.ok ? "ok" : "danger"}` }, `${shake.ok ? "✓" : "✗"} Server self-test: ${shake.summary}`) : null;

  const insightsBox = h("section", { class: "card" }, h("h2", {}, "Worth a look"), h("p", { class: "muted small" }, "Looking through your boxes…"));
  const friends = me.profile.friends ?? {};
  const others = boxes.filter((b) => b.id !== personal?.id && !(b.id in friends && !b.shared));
  // Boxes of your own for apps, or docks: you connect apps, so their pages are worth having.
  builderAuto = others.some((b) => !b.shared) || docks.docks.length > 0;
  showBuilder();
  const cards = others.map((b) => {
    const summary = h("div", { class: "muted" }, "…");
    const chips = h("div", { class: "row" });
    account
      .inventory(b)
      .then((inv) => {
        summary.textContent = inv.summary;
        fill(chips, sensitiveChips(inv.sensitive));
      })
      .catch((err) => (summary.textContent = err.message));
    return h(
      "a",
      { class: "boxcard", href: `#/box/${encodeURIComponent(b.name)}` },
      h("h3", {}, b.name),
      b.profile.description ? h("div", { class: "muted small" }, b.profile.description, b.profile.version ? ` · v${b.profile.version}` : "") : null,
      summary,
      b.docks.length ? h("div", { class: "row" }, b.docks.map((d) => h("span", { class: `chip ${d.waiting ? "warn" : ""}` }, `⚓ ${docks.docks.find((x) => x.id === d.dock)?.name ?? "dock"}`))) : null,
      peopleChip(b),
      chips,
      h("div", { class: "stats" }, `${plural(b.items, "item")} · ${bytes(b.bytes)} · ${plural(b.tapes.filter((t) => t.state === "active").length, "tape")} · ${b.lastActivity ? `active ${ago(b.lastActivity)}` : "never used"}`),
    );
  });

  fill(app, 
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", {}, me.profile.name ? `${me.profile.name}'s shelf` : "Your shelf"), headLine),
      h("div", { class: "row" }, shakeChip, backupChip(me.server.backup), h("button", { type: "button", class: "secondary tiny", onclick: addDevice }, "Add a device")),
    ),
    emergencyAlerts(me),
    search,
    results,
    pendingCard(docks.pending),
    sending,
    personalShown,
    androidAppCard(),
    ON_ANDROID ? null : installCard(),
    friendBoxesCard(boxes, friends),
    insightsBox,
    cards.length || builderOn() ? h("div", { class: "grid" }, cards, builderOn() ? newBoxCard() : null) : null,
  );

  const insights = (await account.insights({ boxes, me, docks })).filter((i) => !(i.fix || "").startsWith("cardboard dock approve"));
  fill(
    insightsBox,
    insights.length ? [h("h2", {}, "Worth a look"), insights.map(insightCard)] : [h("h2", {}, "All good"), h("p", { class: "muted" }, "Nothing needs fixing right now.")],
  );
}

// ── Send to yourself ─────────────────────────────────────────────────────────
//
// Type, paste or drop something on one device; it's sealed here, lands in your
// personal box marked "just arrived", and shows up live on your other devices.

/** The live connection to your personal box while the shelf is open. */
let shelfWatch = null;

/**
 * Pages load in the background: one that was left before it finished must not leave its live
 * connections open. Every page's watches are closed when the next page starts.
 */
const pageWatches = new Set();
function keepWatch(watch) {
  pageWatches.add(watch);
  return watch;
}
let renderGen = 0;
let renderedGen = 0;
/** The first send re-draws the shelf (it made your personal box); this keeps its "Sent" on screen. */
let sentJustNow = false;
let arrivedUnseen = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    arrivedUnseen = 0;
    document.title = "Cardboard";
  }
});

/** On an Android phone's browser: the Cardboard app, straight from this Cardboard. */
const ON_ANDROID = /Android/.test(navigator.userAgent) && !IN_ANDROID_APP;

function androidAppLink(label) {
  return h("a", { class: "button", href: "/cardboard.apk", download: "Cardboard.apk" }, label);
}

/** The newest Cardboard app for Android (VERSION in android/…/MainActivity.java). */
const ANDROID_APP_LATEST = 3;
const ANDROID_APP_VERSION = Number(navigator.userAgent.match(/CardboardAndroid\/(\d+)/)?.[1] ?? 0);

/** Inside an older Cardboard app: the new one, saved to the phone's Downloads through the app. */
function androidUpdateCard() {
  const button = h("button", { type: "button" }, "Get the new version");
  const note = h("div", { class: "muted small" }, "Fixes and new things for the app itself. Your Cardboard stays as it is.");
  button.addEventListener("click", () =>
    withBusy(button, async () => {
      try {
        const res = await fetch("/cardboard.apk");
        if (!res.ok) throw new Error("This Cardboard doesn't have the app to give out. Update Cardboard on its computer first.");
        await androidSave({ name: "Cardboard.apk", type: "application/vnd.android.package-archive" }, [new Uint8Array(await res.arrayBuffer())]);
        fill(note, "Saved. Now open your Files app → Downloads → Cardboard, tap ", h("strong", {}, "Cardboard.apk"), " and press Update.");
        button.hidden = true;
      } catch (err) {
        note.replaceChildren(errorBox(err));
      }
    }),
  );
  return h("section", { class: "card row spread install-card" }, h("div", {}, h("strong", {}, "A new version of the Cardboard app is ready"), note), button);
}

function androidAppCard() {
  if (IN_ANDROID_APP && ANDROID_APP_VERSION < ANDROID_APP_LATEST) return androidUpdateCard();
  if (!ON_ANDROID) return null;
  return h(
    "section",
    { class: "card row spread install-card" },
    h(
      "div",
      {},
      h("strong", {}, "Get the Cardboard app"),
      h("div", { class: "muted small" }, "Its own icon, in the Share menu of every app, downloads in Downloads › Cardboard. When it's downloaded, tap it and allow installing from this browser."),
    ),
    androidAppLink("Download the app"),
  );
}

/** "Install Cardboard as an app", shown only where the browser offers it and it isn't installed yet. */
function installCard() {
  const button = h("button", { type: "button" }, "Install Cardboard");
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    card.remove();
  });
  const card = h(
    "section",
    { class: "card row spread install-card", hidden: !installPrompt },
    h("div", {}, h("strong", {}, "Install Cardboard as an app"), h("div", { class: "muted small" }, "Its own icon and window, and on Android it's in the Share menu of your other apps.")),
    button,
  );
  return card;
}

function thisDeviceName(me) {
  return me.devices.find((d) => d.current)?.name ?? "one of your devices";
}

/** The "Send to yourself" card: a box to type or paste into, files to attach, and what just arrived. */
async function sendCard(me, personal, onChange = () => {}) {
  const box = personal ? await account.open(personal) : null;
  const from = thisDeviceName(me);
  let alone = me.devices.length < 2;
  const text = h("textarea", { rows: 2, class: "plain", placeholder: "Paste a link, a note, anything. Or drop a file.", "aria-label": "What to send" });
  const picker = h("input", { type: "file", multiple: true, hidden: true });
  const attached = h("div", { class: "row" });
  const status = h("div", { class: "small" }, sentJustNow ? sentChip(alone) : null);
  sentJustNow = false;
  const arrived = h("ul", { class: "list things arrived" });
  const send = h("button", { type: "submit" }, "Send to my devices");
  let files = [];

  const showFiles = () =>
    fill(
      attached,
      files.map((f, i) => h("span", { class: "chip" }, `📎 ${f.name} · ${bytes(f.size)} `, h("button", { type: "button", class: "link tiny", "aria-label": `Remove ${f.name}`, onclick: () => ((files = files.filter((_, j) => j !== i)), showFiles()) }, "✕"))),
    );
  const addFiles = (list) => {
    files.push(...[...list].filter((f) => f.size > 0));
    showFiles();
  };
  picker.addEventListener("change", () => {
    addFiles(picker.files);
    picker.value = "";
  });
  text.addEventListener("paste", (e) => {
    if (e.clipboardData?.files.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });

  const form = h(
    "form",
    { class: "card stack send-card" },
    h("h2", {}, "Send to yourself"),
    text,
    attached,
    h("div", { class: "row" }, send, h("button", { type: "button", class: "secondary", onclick: () => picker.click() }, "Attach files"), picker, h("span", { class: "muted small" }, "Sealed here, then it's on every device you're signed in on.")),
    status,
    arrived,
  );
  form.addEventListener("dragover", (e) => [...(e.dataTransfer?.types ?? [])].includes("Files") && e.preventDefault());
  form.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  let target = box;
  onSubmit(form, status, async () => {
    if (!text.value.trim() && !files.length) throw new Error("Type or paste something, or attach a file.");
    const first = !target;
    // The first send makes your personal box.
    target ??= await account.open(await account.makePersonalBox());
    // Asked again now: a device may have been added since this page was drawn.
    alone = (await account.me().catch(() => me)).devices.length < 2;
    await sendNow(target, from, text.value, files, status, alone);
    text.value = "";
    files = [];
    showFiles();
    if (first) {
      sentJustNow = true;
      return render(); // so the shelf shows the new box, and listens to it
    }
    await showArrived();
  });

  async function showArrived() {
    if (!target) return fill(arrived);
    const { things } = await listThings(target);
    const fresh = things.filter((t) => t.value.inbox).slice(0, 8);
    fill(
      arrived,
      fresh.length ? h("li", { class: "muted small" }, "Just arrived") : null,
      fresh.map((t) => arrivedRow(target, t, showArrived, status)),
    );
    onChange();
  }

  await showArrived();
  shelfWatch?.close();
  shelfWatch = null;
  listen();
  // No personal box yet: another device may make it with the first thing it sends. Look now and then, so that arrives here too.
  if (!target) {
    const look = setInterval(async () => {
      if (!form.isConnected) return clearInterval(look);
      if (document.visibilityState !== "visible") return;
      const made = await account.personalBox(await account.me()).catch(() => null);
      if (made && form.isConnected) {
        clearInterval(look);
        render();
      }
    }, 5000);
  }
  // Coming back to this tab: catch up, in case the live connection dropped while the phone slept.
  const catchUp = () => {
    if (!form.isConnected) return document.removeEventListener("visibilitychange", catchUp);
    if (document.visibilityState === "visible") showArrived().catch(() => {});
  };
  document.addEventListener("visibilitychange", catchUp);
  return form;

  /** Live: something sent from another device shows up here straight away. */
  function listen() {
    if (!target) return;
    shelfWatch?.close();
    let timer = null;
    shelfWatch = keepWatch(target.watch((change) => {
      if (!/^(notes|links|files)\//.test(change.key)) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const before = arrived.querySelectorAll(".thing").length;
        await showArrived().catch(() => {});
        const after = arrived.querySelectorAll(".thing").length;
        if (after > before && document.visibilityState !== "visible") {
          arrivedUnseen += after - before;
          document.title = `(${arrivedUnseen}) Cardboard`;
        }
      }, 300);
    }, { onError: () => {} }));
  }
}

/** What "sent" means: on your other devices, or (with none yet) in your personal box, waiting for them. */
function sentChip(alone) {
  if (!alone) return h("span", { class: "chip ok" }, "Sent. It's on your other devices now.");
  return h(
    "span",
    { class: "row" },
    h("span", { class: "chip ok" }, "Saved in your personal box."),
    h("span", { class: "muted" }, "Add your phone (or another computer) and it's there too."),
    h("button", { type: "button", class: "secondary tiny", onclick: addDevice }, "Add a device"),
  );
}

/** Seals and sends text and files, saying how it's going in `status`. */
async function sendNow(box, from, text, files, status, alone = false) {
  if (text.trim()) await sendText(box, text, from);
  for (const file of files) {
    const progress = h("span", {}, `Sealing ${file.name}…`);
    status.replaceChildren(progress);
    await sealFile(box, file, { sentFrom: from, onProgress: (f, done) => (progress.textContent = `Sealing ${file.name}… ${Math.round(f * 100)}% (${bytes(done)} of ${bytes(file.size)})`) });
  }
  status.replaceChildren(sentChip(alone));
  status.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

/** One thing that just arrived: open, copy or play it, say "got it" (it stays in your personal box), or delete it (with Undo). */
function arrivedRow(box, t, refresh, notice) {
  const v = t.value;
  const url = t.kind === "link" ? safeUrl(v.url) : null;
  const keep = h("button", { type: "button", class: "secondary tiny", title: "Takes it off this list. It stays in your personal box." }, "Got it");
  keep.addEventListener("click", () => withBusy(keep, async () => (await keepThing(box, t), refresh())));
  const clear = h("button", { type: "button", class: "secondary tiny", "aria-label": `Delete ${v.title}` }, "Delete");
  clear.addEventListener("click", () =>
    withBusy(clear, async () => {
      await removeThing(box, t);
      const undo = h("button", { type: "button", class: "secondary tiny" }, "Undo");
      undo.addEventListener("click", () => withBusy(undo, async () => (await restoreThing(box, t), notice.replaceChildren(), refresh())));
      notice.replaceChildren(h("span", { class: "row" }, h("span", {}, `Deleted “${v.title}”.`), undo));
      await refresh();
    }),
  );
  return h(
    "li",
    { class: "thing" },
    h(
      "a",
      { class: "thing-open", href: `#/box/${encodeURIComponent(PERSONAL_HOME)}/${encodeURIComponent(t.key)}` },
      h("span", { class: "thing-icon", "aria-hidden": "true" }, iconOf(t)),
      h("span", { class: "thing-text" }, h("strong", {}, v.title), h("span", { class: "muted small" }, [subtitle(t), `from ${v.from || "another device"}`].filter(Boolean).join(" · "))),
      h("span", { class: "muted small thing-when" }, ago(t.updatedAt)),
    ),
    h(
      "span",
      { class: "row thing-actions" },
      t.kind === "note" ? copyButton(v.text || v.title, "Copy") : null,
      url ? h("a", { class: "button secondary tiny", href: url, target: "_blank", rel: "noopener noreferrer" }, "Open") : null,
      url ? copyButton(url, "Copy") : null,
      keep,
      clear,
    ),
  );
}

/** The personal box's name, for links (set when the shelf loads). */
let PERSONAL_HOME = "personal";

/** What another app shared to Cardboard (Android's share sheet), kept on this phone by media-sw.js or by the app. */
async function takePendingShare() {
  if (IN_ANDROID_APP) return takeAndroidShare();
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("cardboard-share", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pending");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const run = (mode, fn) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("pending", mode);
      const req = fn(tx.objectStore("pending"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  // Kept until it's sent (or you say not to): a send that fails can be tried again.
  const share = await run("readonly", (store) => store.get("share")).catch((err) => (db.close(), Promise.reject(err)));
  if (!share) {
    db.close();
    return null;
  }
  return {
    ...share,
    done: async () => {
      await run("readwrite", (store) => store.delete("share")).catch(() => {});
      db.close();
    },
  };
}

/** #/send: you shared something to Cardboard from another app. Seal it and send it to your devices. */
async function renderSend() {
  const status = h("div", { class: "stack" });
  fill(app, h("section", { class: "card stack login" }, h("h1", {}, "Send to yourself"), status));
  if (location.hash.includes("unsealed")) {
    return fill(status, h("p", {}, "Nothing was sent: Cardboard's helper wasn't running on this phone yet, so what you shared went nowhere (and nothing was kept)."), h("p", { class: "muted small" }, "Open Cardboard once, then share again."), h("a", { href: "#/" }, "Go to your shelf"));
  }
  let shared;
  try {
    shared = await takePendingShare();
  } catch (err) {
    if (IN_ANDROID_APP) return fill(status, errorBox(err), h("a", { href: "#/" }, "Go to your shelf"));
  }
  if (!shared || (!shared.text && !shared.files?.length)) {
    return fill(status, h("p", {}, location.hash.includes("failed") ? "Cardboard couldn't read what was shared. Try again?" : "There's nothing waiting to be sent."), h("a", { href: "#/" }, "Go to your shelf"));
  }
  // Shown first, and sent only when you say so: a web page (or another app) can send things here
  // too, and nothing should land in your Cardboard that you didn't mean to keep.
  const files = shared.files ?? [];
  const send = await new Promise((resolve) => {
    const yes = h("button", { type: "button" }, "Send to my devices");
    const no = h("button", { type: "button", class: "secondary" }, "Don't send");
    yes.addEventListener("click", () => resolve(true));
    no.addEventListener("click", () => resolve(false));
    fill(
      status,
      h("p", {}, "This was shared to Cardboard. Send it to your devices?"),
      shared.text ? h("div", { class: "note-text card-inset" }, shared.text.length > 600 ? `${shared.text.slice(0, 600)}…` : shared.text) : null,
      files.length ? h("ul", { class: "list small" }, files.map((f) => h("li", {}, `📎 ${f.name} · ${bytes(f.size ?? 0)}`))) : null,
      h("div", { class: "row" }, yes, no),
    );
  });
  if (!send) {
    await shared.done?.();
    history.replaceState(null, "", "#/send");
    return fill(status, h("p", {}, "Not sent. Nothing was kept."), h("a", { href: "#/" }, "Go to your shelf"));
  }
  const me = await account.me();
  const box = await account.open(await account.makePersonalBox());
  try {
    await sendNow(box, thisDeviceName(me), shared.text ?? "", files, status);
    await shared.done?.();
    // Not #/ itself, or "Go to your shelf" (#/) would go nowhere.
    history.replaceState(null, "", "#/send");
    fill(status, h("p", {}, h("span", { class: "chip ok" }, "Sent"), " It's on your other devices now."), h("a", { href: "#/" }, "Go to your shelf"));
  } catch (err) {
    fill(status, errorBox(err), h("a", { href: "#/" }, "Go to your shelf"));
  }
}

// ── Sealing files: location left behind, and carrying on after a dropped connection ──

const RESUME = "cardboard-resume";

function resumeList() {
  try {
    const list = JSON.parse(localStorage.getItem(RESUME) || "{}");
    // A week on, it's not coming back: the box tidies those parts away by itself.
    for (const [key, v] of Object.entries(list)) if (!v || Date.now() - v.at > 7 * 24 * 60 * 60_000) delete list[key];
    return list;
  } catch {
    return {};
  }
}

function resumeSave(list) {
  try {
    localStorage.setItem(RESUME, JSON.stringify(list));
  } catch {
    // Private windows may not keep it: then a cut-off upload starts over.
  }
}

/** Uploads this device means to carry on in a box: tidying up leaves their parts be. */
function resumingIds(boxId) {
  return Object.entries(resumeList())
    .filter(([key]) => key.startsWith(`${boxId}|`))
    .map(([, v]) => v.id);
}

/**
 * Seals a file into a box: its location taken out first (unless you keep it, in
 * You → Privacy), and if the connection drops for good, what got there is kept
 * so adding the same file again carries on from there. Resolves with a note to add.
 */
async function sealFile(box, file, options = {}) {
  const { boxId } = await box.ready();
  const key = `${boxId}|${file.name}|${file.size}|${file.lastModified ?? 0}`;
  const strip = options.stripLocation ?? !(account ? (await account.me().catch(() => null))?.profile.keepLocation : false);
  let source = file;
  let note = "";
  if (strip) {
    const { blob, removed } = await withoutLocation(file);
    source = blob;
    if (removed) note = " Where it was taken was taken out first.";
  }
  const list = resumeList();
  const carryOn = list[key]?.id;
  const carryParts = list[key]?.parts;
  const { stripLocation: _, ...rest } = options;
  try {
    await addFile(box, source, { name: file.name, type: file.type, ...rest, continueId: carryOn, continueParts: carryParts, keepPartsOnError: true });
  } catch (err) {
    if (err.stopped) {
      resumeSave({ ...resumeList(), [key]: { id: err.stopped.id, parts: err.stopped.parts, at: Date.now() } });
      err.hint = `${bytes(err.stopped.sentBytes)} of ${bytes(file.size)} got there and is kept. Add the same file again (here, on this device) and it carries on from there.`;
    }
    throw err;
  }
  const done = resumeList();
  delete done[key];
  resumeSave(done);
  return { note: carryOn ? `${note} It carried on from where it stopped.` : note };
}

// ── Convert ─────────────────────────────────────────────────────────────────

/** Files handed to the converter from elsewhere (a file in your personal box). */
let convertQueue = [];

/** Saves something made on this device as a download (through the app, in the Android app). */
async function saveBlob(blob, name) {
  if (IN_ANDROID_APP) {
    const chunks = async function* () {
      for (let at = 0; at < blob.size; at += 4 * 1024 * 1024) yield new Uint8Array(await blob.slice(at, at + 4 * 1024 * 1024).arrayBuffer());
    };
    return androidSave({ name, type: blob.type, size: blob.size }, chunks());
  }
  blobDownload([blob], name);
  return "Downloaded.";
}

/** #/convert: turn files into other kinds of files, on this device. */
async function renderConvert() {
  const conv = await import("/convert.js");
  let files = convertQueue;
  convertQueue = [];
  let target = null;
  const picker = h("input", { type: "file", multiple: true, hidden: true });
  const chosen = h("div", { class: "stack" });
  const targets = h("div", { class: "row convert-targets" });
  const optionsBox = h("div", { class: "stack" });
  const go = h("button", { type: "button", disabled: true }, "Convert");
  const status = h("div", { class: "stack" });
  const results = h("ul", { class: "list" });
  const options = {};
  /** After a conversion, new files start a new one (not piled onto the last). */
  let converted = false;
  const startOver = h("button", { type: "button", class: "link small", hidden: true }, "Start over");
  const take = (list) => {
    if (converted) {
      files = [];
      target = null;
      converted = false;
      fill(status);
      fill(results);
    }
    files = [...files, ...list];
    draw();
  };
  startOver.addEventListener("click", () => {
    files = [];
    target = null;
    converted = false;
    fill(status);
    fill(results);
    draw();
  });

  const field = (label, input) => h("label", { class: "field" }, label, input);
  const select = (key, choices, initial) => {
    const el = h("select", {}, choices.map(([value, label]) => h("option", { value: String(value), selected: value === initial }, label)));
    options[key] = initial;
    el.addEventListener("change", () => (options[key] = el.value === "" ? undefined : Number(el.value)));
    return el;
  };
  const number = (key, initial, attrs) => {
    const el = h("input", { type: "number", value: initial, inputmode: "decimal", ...attrs });
    options[key] = initial;
    el.addEventListener("input", () => (options[key] = Number(el.value)));
    return el;
  };

  function drawOptions() {
    for (const key of Object.keys(options)) delete options[key];
    const picture = ["jpeg", "png", "webp", "pdf-images"].includes(target);
    fill(
      optionsBox,
      picture ? field("Size", select("maxSide", [["", "As it is"], [4096, "At most 4096 px"], [2048, "At most 2048 px"], [1080, "At most 1080 px"], [640, "At most 640 px"]], target === "pdf-images" ? 2400 : "")) : null,
      ["jpeg", "webp", "pdf-images"].includes(target) ? field("Quality", select("quality", [[0.92, "High"], [0.8, "Medium"], [0.6, "Small file"]], 0.92)) : null,
      target === "gif-images" ? [field("Each picture shows for (seconds)", number("frameSeconds", 0.7, { min: 0.1, max: 10, step: 0.1 })), field("Width", select("width", [[320, "320 px"], [480, "480 px"], [640, "640 px"]], 480))] : null,
      target === "gif-video"
        ? [field("Start at (seconds)", number("start", 0, { min: 0, step: 0.5 })), field("How long (seconds, up to 20)", number("seconds", 5, { min: 0.5, max: 20, step: 0.5 })), field("Width", select("width", [[320, "320 px"], [480, "480 px"], [640, "640 px"]], 480))]
        : null,
      target === "frame" ? field("At (seconds)", number("at", 1, { min: 0, step: 0.5 })) : null,
      target === "opus" ? field("Quality", select("bitrate", [[64000, "Speech (64 kbps)"], [96000, "Music (96 kbps)"], [160000, "Best (160 kbps)"]], 96000)) : null,
    );
  }

  function draw() {
    const blocked = files.map((f) => [f, conv.cantConvert(f)]).filter(([, why]) => why);
    const usable = files.filter((f) => !conv.cantConvert(f));
    fill(
      chosen,
      files.length
        ? h(
            "ul",
            { class: "list" },
            files.map((f, i) =>
              h(
                "li",
                { class: "row spread" },
                h("span", {}, h("strong", {}, f.name), h("span", { class: "muted small" }, ` · ${bytes(f.size)}`)),
                h("button", { type: "button", class: "link tiny", "aria-label": `Remove ${f.name}`, onclick: () => ((files = files.filter((_, j) => j !== i)), (target = null), draw()) }, "✕"),
              ),
            ),
          )
        : h("p", { class: "muted" }, "Choose or drop files to start: pictures, videos, sound, spreadsheets, documents, zips."),
      blocked.map(([f, why]) => h("p", { class: "insight tip small" }, `${f.name}: ${why}`)),
    );
    const list = conv.targetsFor(usable);
    if (!list.some((t) => t.id === target)) target = null;
    fill(
      targets,
      list.length ? h("div", { class: "muted small" }, "Turn into:") : null,
      list.map((t) => h("button", { type: "button", class: `secondary tiny ${t.id === target ? "active" : ""}`, onclick: () => ((target = t.id), draw(), drawOptions()) }, t.label)),
    );
    go.disabled = !target;
    startOver.hidden = !files.length;
    if (!target) fill(optionsBox);
  }

  picker.addEventListener("change", () => {
    const list = [...picker.files];
    picker.value = "";
    take(list);
  });

  go.addEventListener("click", () =>
    withBusy(go, async () => {
      const usable = files.filter((f) => !conv.cantConvert(f));
      const progress = h("span", { class: "muted small" }, "Starting…");
      fill(status, progress);
      try {
        const made = await conv.convert(target, usable, { ...options, onProgress: (f, words) => (progress.textContent = words ? `${words} ${Math.round(f * 100)}%` : "") });
        fill(status, h("span", { class: "chip ok" }, `Done: ${plural(made.length, "file")}, made on this device.`));
        fill(results, made.map(resultRow));
        converted = true;
      } catch (err) {
        fill(status, errorBox(err));
      }
    }),
  );

  function resultRow(r) {
    const note = h("span", { class: "muted small" });
    const download = h("button", { type: "button" }, "Download");
    download.addEventListener("click", () =>
      withBusy(download, async () => {
        try {
          note.textContent = await saveBlob(r.blob, r.name);
        } catch (err) {
          note.replaceChildren(errorBox(err));
        }
      }),
    );
    const keep = h("button", { type: "button", class: "secondary" }, "Keep in my personal box");
    keep.addEventListener("click", () =>
      withBusy(keep, async () => {
        try {
          const box = await account.open(await account.makePersonalBox());
          await sealFile(box, new File([r.blob], r.name, { type: r.type }));
          note.textContent = "Kept, sealed, in your personal box.";
        } catch (err) {
          note.replaceChildren(errorBox(err));
        }
      }),
    );
    const send = h("button", { type: "button", class: "secondary" }, "Send to my devices");
    send.addEventListener("click", () =>
      withBusy(send, async () => {
        try {
          const me = await account.me();
          const box = await account.open(await account.makePersonalBox());
          await sealFile(box, new File([r.blob], r.name, { type: r.type }), { sentFrom: thisDeviceName(me) });
          note.textContent = "Sent. It's on your other devices now.";
        } catch (err) {
          note.replaceChildren(errorBox(err));
        }
      }),
    );
    return h("li", { class: "stack" }, h("div", {}, h("strong", {}, r.name), h("span", { class: "muted small" }, ` · ${bytes(r.blob.size)}`)), h("div", { class: "row" }, download, keep, send, note));
  }

  const card = h(
    "section",
    { class: "card stack" },
    h("div", { class: "row" }, h("button", { type: "button", onclick: () => picker.click() }, "Choose files"), picker, h("span", { class: "muted small drop-hint" }, "or drop them here"), startOver),
    chosen,
    targets,
    optionsBox,
    h("div", { class: "row" }, go),
    status,
    results,
  );
  card.addEventListener("dragover", (e) => [...(e.dataTransfer?.types ?? [])].includes("Files") && e.preventDefault());
  card.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    take([...e.dataTransfer.files]);
  });
  fill(
    app,
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Convert"), h("div", { class: "muted" }, "Turn files into other kinds of files: pictures, videos, sound, spreadsheets, documents, zips. It all happens on this device: nothing is uploaded to convert it."))),
    card,
    h(
      "details",
      { class: "card" },
      h("summary", {}, "What it can do"),
      h(
        "ul",
        { class: "small" },
        h("li", {}, "Pictures (PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ICO) → JPEG, PNG, WebP, smaller sizes, a PDF, an animated GIF, an icon"),
        h("li", {}, "Videos → an animated GIF of a clip, a still picture, just the sound (Opus or WAV)"),
        h("li", {}, "Sound (MP3, WAV, OGG, M4A, FLAC…) → Opus (small) or WAV (plays anywhere)"),
        h("li", {}, "Spreadsheets (Excel .xlsx, CSV, TSV, JSON) → each other, a web page or a Markdown table"),
        h("li", {}, "Word (.docx), Markdown and text → PDF, a web page, plain text; JSON → YAML"),
        h("li", {}, "Anything → a .zip, or Base64 text (and back); a .zip → the files inside; text → a QR code"),
        h("li", { class: "muted" }, "Not yet: iPhone photos (HEIC), PDF to pictures or text, making videos smaller."),
      ),
    ),
  );
  draw();
}

/** Your personal box on the shelf, or the button that makes it. */
function personalCard(box) {
  if (!box) {
    const make = h("button", { type: "button" }, "Make my personal box");
    const status = h("div");
    make.addEventListener("click", () =>
      withBusy(make, async () => {
        try {
          const made = await account.makePersonalBox();
          location.hash = `#/box/${encodeURIComponent(made.name)}`;
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );
    return h(
      "section",
      { class: "card stack personal-card" },
      h("h2", {}, "Your personal box"),
      h("p", {}, "A place for anything that's just for you: notes, passwords, links and files. It's sealed on this device before it leaves, and it opens on every device you've signed in on."),
      h("div", { class: "row" }, make),
      status,
    );
  }
  const counts = h("div", { class: "muted" }, "…");
  account
    .inventory(box)
    .then((inv) => {
      const parts = Object.entries(KINDS)
        .map(([, k]) => [inv.collections.find((c) => c.name === k.collection)?.items ?? 0, k])
        .filter(([n]) => n > 0)
        .map(([n, k]) => `${n} ${n === 1 ? k.one : k.many}`);
      counts.textContent = parts.length ? parts.join(" · ") : "Empty so far: add your first note, password, link or file.";
    })
    .catch((err) => (counts.textContent = err.message));
  return h(
    "a",
    { class: "boxcard personal-card", href: `#/box/${encodeURIComponent(box.name)}` },
    h("h3", {}, "Your personal box ", h("span", { class: "chip ok" }, box.people.members.length ? "shared" : "only you")),
    counts,
    h("div", { class: "stats" }, `${bytes(box.bytes)} · ${box.lastActivity ? `changed ${ago(box.lastActivity)}` : "never used"}`),
  );
}

// ── Friend boxes ────────────────────────────────────────────────────────────

const LINK_DURATIONS = [
  ["1d", "1 day"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["", "until I stop it"],
];

/** On the shelf: your friend boxes, and the button that makes one. */
function friendBoxesCard(boxes, friends) {
  const mine = boxes.filter((b) => b.id in friends && !b.shared);
  const make = h("button", { type: "button" }, "Make a friend box");
  make.addEventListener("click", () => friendBoxForm());
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Friend boxes"),
    h("p", { class: "small" }, "A box anyone with its link can open: no account, no app, no size limit but your own room. For videos too big for Discord, or to get files back from a friend."),
    mine.length
      ? h(
          "ul",
          { class: "list" },
          mine.map((b) => {
            // Listed by the name people with the link see (sealed in the box), not the box's own name.
            const title = h("strong", {}, `🎁 ${b.name}`);
            account
              .open(b)
              .then((box) => box.get(FRIEND_ABOUT))
              .then((about) => about?.title && (title.textContent = `🎁 ${about.title}`))
              .catch(() => {});
            return h("li", { class: "row spread" }, h("a", { href: `#/box/${encodeURIComponent(b.name)}` }, title), h("span", { class: "muted small" }, `${bytes(b.bytes)} · ${linkState(friends[b.id])}`));
          }),
        )
      : null,
    h("div", { class: "row" }, make),
  );
}

function linkExpired(link) {
  return Boolean(link?.expiresAt && link.expiresAt <= Date.now());
}

/** What people with the link can do, in words. (Links made before collection boxes can always see.) */
function linkCan(link) {
  if (link.see === false) return "they can only add";
  return link.write ? "they can open, download and add" : "they can open and download";
}

function linkState(link) {
  if (!link) return "no link";
  if (linkExpired(link)) return "its link expired";
  return `${linkCan(link)} · ${link.expiresAt ? `until ${new Date(link.expiresAt).toLocaleDateString()}` : "until you stop it"}`;
}

const LINK_KINDS = [
  ["open", "Open and download what you put in"],
  ["both", "That, and add files too (you get what they add)"],
  ["add", "Only add files: they can't see what's in it (a collection box, for a wedding or a trip)"],
];

/** What people with a friend link can do, and for how long. */
function linkChoices(current = null) {
  const now = current ? (current.see === false ? "add" : current.write ? "both" : "open") : "open";
  const name = `can-${Math.random().toString(36).slice(2)}`;
  const kinds = LINK_KINDS.map(([value, label]) => ({ value, input: h("input", { type: "radio", name, value, checked: value === now }), label }));
  const how = h("select", {}, LINK_DURATIONS.map(([value, label]) => h("option", { value, selected: value === "7d" }, label)));
  return {
    fields: [
      h("fieldset", { class: "stack small plain-fieldset" }, h("legend", {}, "People with the link can"), kinds.map((k) => h("label", { class: "choice" }, k.input, h("span", {}, k.label)))),
      h("label", { class: "field" }, "The link works for", how),
    ],
    value: () => {
      const kind = kinds.find((k) => k.input.checked)?.value ?? "open";
      return { see: kind !== "add", write: kind !== "open", expires: how.value || null };
    },
  };
}

function friendBoxForm() {
  const title = h("input", { placeholder: "e.g. Trip videos", maxlength: 200 });
  const choices = linkChoices();
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("h2", {}, "Make a friend box"),
    h("label", { class: "field" }, "What's in it (they see this)", title),
    choices.fields,
    h("div", { class: "row" }, h("button", { type: "submit" }, "Make it"), h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, "Cancel")),
    status,
  );
  onSubmit(form, status, async () => {
    const { box, link } = await account.makeFriendBox({ title: title.value, ...choices.value() });
    showFriendLink(link, box.name);
  });
  openModal(null, form);
  title.focus();
}

/** The link, just made: to copy, send or scan. */
function showFriendLink(link, boxName) {
  const go = h("a", { class: "button", href: `#/box/${encodeURIComponent(boxName)}` }, "Add files to it");
  go.addEventListener("click", () => closeModal(false));
  openModal(
    render,
    h("h2", {}, "The friend box's link"),
    h("p", {}, link.see === false ? "Send this to the people you're collecting from. They can add files, with no account, but can't see what's in the box: only you can. " : `Send this to your friend. Anyone who has it can open the box${link.write ? " and add to it" : ""}, with no account. `, "The key is in the link itself, so send it only to people you mean."),
    h("code", { class: "secret" }, link.link),
    sendButtons(link.link, "Files for you"),
    qrCode(link.link, "QR code of the friend box's link"),
    h("p", { class: "muted small" }, `Works ${link.expiresAt ? `until ${new Date(link.expiresAt).toLocaleString()}` : "until you stop it"}. You can stop it any time on the box's page.`),
    h("div", { class: "row" }, go, h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, "Done")),
  );
}

/** On a friend box's page: its link, and the buttons to stop it or make a new one. */
function friendLinkCard(info, link) {
  const card = h("section", { class: "card stack" });
  const status = h("div");
  const newLink = (current) => {
    const choices = linkChoices(current);
    const formStatus = h("div");
    const form = h(
      "form",
      { class: "stack" },
      h("h2", {}, current ? "A new link" : "Make a link"),
      current && !linkExpired(current) ? h("p", { class: "small" }, "The link you have now stops working.") : null,
      choices.fields,
      h("div", { class: "row" }, h("button", { type: "submit" }, "Make the link"), h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, "Cancel")),
      formStatus,
    );
    onSubmit(form, formStatus, async () => {
      const made = await account.newFriendLink(info.name, choices.value());
      draw(made);
      showFriendLink(made, info.name);
    });
    openModal(null, form);
  };
  const draw = (current) => {
    const live = current && !linkExpired(current);
    const stop = h("button", { type: "button", class: "secondary" }, "Stop the link");
    stop.addEventListener("click", () =>
      withBusy(stop, async () => {
        if (!confirm("Stop this link? Nobody can open the box with it any more. What's in the box stays.")) return;
        try {
          await account.stopFriendLink(info.name);
          draw(null);
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );
    const fresh = h("button", { type: "button", class: live ? "secondary" : "" }, live ? "New link…" : "Make a link…");
    fresh.addEventListener("click", () => newLink(current));
    fill(
      card,
      h("h2", {}, "Its link"),
      live
        ? [h("p", { class: "small" }, `Anyone with this link: ${linkCan(current)}. ${current.expiresAt ? `It works until ${new Date(current.expiresAt).toLocaleString()}.` : "It works until you stop it."}`), h("code", { class: "secret" }, current.link), sendButtons(current.link, "Files for you")]
        : h("p", { class: "small" }, current ? "Its link expired. Make a new one to let people in again." : "No link right now: nobody can open this box but you."),
      h("div", { class: "row" }, live ? stop : null, fresh),
      status,
    );
  };
  draw(link);
  return card;
}

/** The live connection while someone is looking at a friend box through its link. */
let friendWatch = null;

/** What a guest calls themselves when adding to a friend box, remembered on their device. */
function guestName() {
  try {
    return (localStorage.getItem("cardboard-guest-name") || "").trim().slice(0, 60) || "a friend";
  } catch {
    return "a friend";
  }
}

/** A friend box, opened with its link: no account, just this box. */
async function renderFriendView(pending) {
  nav.hidden = true;
  friendWatch?.close();
  friendWatch = null;
  let link;
  try {
    link = JSON.parse(pending);
  } catch {
    link = { secret: pending };
  }
  let box;
  try {
    box = openBox({ url: ORIGIN, tape: String(link.secret ?? ""), onNotice: false });
  } catch {
    // Chat apps sometimes cut long links short, or break them over two lines.
    return fill(
      app,
      h(
        "section",
        { class: "card stack login" },
        h("h1", {}, "This link is incomplete"),
        h("p", {}, "Part of it is missing, so it can't open anything. Ask whoever sent it to send it again, or copy the whole link (it's long) and paste it into your browser."),
      ),
    );
  }
  let who;
  let about;
  const added = [];
  try {
    who = await box.whoami();
    // A collection link can't read the box: its title came in the link.
    about = who.tape?.read ? await box.get(FRIEND_ABOUT) : { title: link.title, from: link.from };
  } catch (err) {
    const gone = err.code === "bad_tape";
    return fill(
      app,
      h(
        "section",
        { class: "card stack login" },
        h("h1", {}, gone ? "This link doesn't open anything any more" : "This link didn't open"),
        gone ? h("p", {}, "Whoever sent it stopped it, or it expired. Ask them for a new one.") : errorBox(err),
      ),
    );
  }
  const canAdd = Boolean(who.tape?.write);
  const canSee = Boolean(who.tape?.read);
  const expiresAt = who.tape?.expiresAt;
  const list = h("ul", { class: "list things" });
  const notice = h("div", { class: "stack" });
  const picker = h("input", { type: "file", multiple: true, hidden: true });

  async function load() {
    if (!canSee) {
      return fill(list, added.length ? added.map((name) => h("li", { class: "thing" }, h("span", { class: "thing-icon", "aria-hidden": "true" }, "✓"), h("span", { class: "thing-text" }, h("strong", {}, name), h("span", { class: "muted small" }, "added")))) : h("li", { class: "muted" }, "Add your files below. Only the box's owner can see what's in it."));
    }
    const { things } = await listThings(box);
    fill(
      list,
      things.length
        ? things.map((t) =>
            h(
              "li",
              { class: "thing" },
              h(
                "button",
                { type: "button", class: "thing-open", onclick: () => friendThing(box, t) },
                h("span", { class: "thing-icon", "aria-hidden": "true" }, iconOf(t)),
                h("span", { class: "thing-text" }, h("strong", {}, t.value.title), h("span", { class: "muted small" }, subtitle(t) || " ")),
                h("span", { class: "muted small thing-when" }, ago(t.updatedAt)),
              ),
            ),
          )
        : h("li", { class: "muted" }, canAdd ? "Empty so far. Add files below." : "Nothing in here yet. Look again later: it shows up here as soon as it's added."),
    );
  }

  async function upload(chosen) {
    const stop = new AbortController();
    const stopButton = h("button", { type: "button", class: "secondary tiny", onclick: () => stop.abort() }, "Stop");
    const warn = (e) => e.preventDefault();
    addEventListener("beforeunload", warn);
    const awake = await navigator.wakeLock?.request("screen").catch(() => null);
    try {
      for (const file of chosen) {
        const progress = h("span", {}, `Sealing ${file.name}…`);
        fill(notice, h("div", { class: "insight tip row spread" }, progress, stopButton));
        try {
          const { note } = await sealFile(box, file, {
            sentFrom: guestName(),
            stripLocation: true,
            signal: stop.signal,
            onProgress: (f, done) => (progress.textContent = `Sealing ${file.name}… ${Math.round(f * 100)}% (${bytes(done)} of ${bytes(file.size)})`),
          });
          added.push(file.name);
          fill(notice, h("div", { class: "insight tip" }, `Added ${file.name}. It was sealed here before it left this device.${note}`));
        } catch (err) {
          fill(notice, err.name === "AbortError" ? h("div", { class: "insight tip" }, `Stopped. Nothing of ${file.name} was kept.`) : errorBox(err));
          break;
        }
      }
    } finally {
      removeEventListener("beforeunload", warn);
      awake?.release().catch(() => {});
      await load();
    }
  }
  picker.addEventListener("change", () => {
    const chosen = [...picker.files];
    picker.value = "";
    upload(chosen);
  });

  const page = h(
    "div",
    { class: "friend-view" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "stack" },
        h("h1", {}, `🎁 ${about?.title || "A friend box"}`),
        canSee
          ? h("div", { class: "muted" }, about?.from ? `From ${about.from}. ` : "Someone sent you this. ", "Sealed end to end: only people with this link can see inside, not even the server it's kept on.")
          : h("div", { class: "muted" }, about?.from ? `${about.from} is collecting files here. ` : "Someone is collecting files here. ", "Add yours: they're sealed on this device first. This link can only add, so you (and the other people adding) can't look in; only they can."),
        expiresAt ? h("div", { class: "muted small" }, `The link works until ${new Date(expiresAt).toLocaleString()}.`) : null,
      ),
    ),
    h(
      "section",
      { class: "card stack" },
      list,
      notice,
      canAdd ? guestNameField() : null,
      canAdd ? h("div", { class: "row" }, h("button", { type: "button", onclick: () => picker.click() }, "+ Add files"), picker, h("span", { class: "muted small drop-hint" }, "or drop them here")) : null,
      canAdd ? h("p", { class: "muted small" }, "Where photos and videos were taken is taken out of them first.") : null,
    ),
    h("p", { class: "muted small" }, "This is Cardboard: a private, end-to-end encrypted place for your things. Want your own? Ask whoever sent you this for an invite."),
  );
  if (canAdd) {
    page.addEventListener("dragover", (e) => [...(e.dataTransfer?.types ?? [])].includes("Files") && e.preventDefault());
    page.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      upload([...e.dataTransfer.files]);
    });
  }
  fill(app, page);
  await load();
  if (!canSee) return;
  // Live: something added (by the sender, or another friend) shows up straight away.
  let timer = null;
  friendWatch = keepWatch(box.watch(
    (change) => {
      if (!/^(notes|links|files)\//.test(change.key)) return;
      clearTimeout(timer);
      timer = setTimeout(() => load().catch(() => {}), 300);
    },
    { onError: () => {}, values: false },
  ));
}

function guestNameField() {
  const input = h("input", { value: guestName() === "a friend" ? "" : guestName(), maxlength: 60, placeholder: "e.g. Siggi", autocomplete: "name" });
  input.addEventListener("change", () => {
    try {
      localStorage.setItem("cardboard-guest-name", input.value.trim());
    } catch {
      // Then it says "a friend".
    }
  });
  return h("label", { class: "field" }, "Your name (so they know who it's from)", input);
}

/** One thing in a friend box, opened: play, look at or download a file; read a note; open a link. */
function friendThing(box, t) {
  const v = t.value;
  const status = h("div");
  const body = [];
  if (t.kind === "file") {
    const preview = h("div", { class: "file-preview" });
    const progress = h("span", { class: "muted small" });
    let loaded = null;
    const fetchBytes = async () => (loaded ??= await readFile(box, t, (f) => (progress.textContent = f < 1 ? `Opening… ${Math.round(f * 100)}%` : "")));
    const entry = { info: { name: v.name || "file", type: v.type, size: v.size }, range: (start, end) => readRange(box, t, start, end), chunks: () => fileChunks(box, t) };
    const save = h("button", { type: "button" }, "Download");
    save.addEventListener("click", () =>
      withBusy(save, async () => {
        try {
          const said = await streamDownload(entry, (words) => (progress.textContent = words));
          if (said) {
            progress.textContent = said;
            return;
          }
          if (v.size > IN_MEMORY_MAX) throw new Error(`${bytes(v.size)} is too big for this browser to hold at once. Open the link on a computer (Chrome, Edge or Firefox) to download it, or play it here.`);
          blobDownload([await fetchBytes()], v.name || "file");
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );
    body.push(h("div", { class: "muted small" }, `${v.name} · ${bytes(v.size)}`), preview, h("div", { class: "row" }, save, progress), v.notes ? h("p", { class: "small" }, v.notes) : null);
    if (/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(v.type) && v.size <= 25 * 1024 * 1024) {
      fetchBytes()
        .then((data) => {
          const url = URL.createObjectURL(new Blob([data], { type: v.type }));
          const img = h("img", { src: url, alt: v.title });
          img.addEventListener("load", () => setTimeout(() => URL.revokeObjectURL(url), 1000));
          fill(preview, img);
        })
        .catch((err) => fill(preview, errorBox(err)));
    } else if (/^(video|audio)\//.test(v.type)) {
      play(preview, entry, fetchBytes);
    }
  } else if (t.kind === "note") {
    body.push(h("div", { class: "note-text" }, v.text || ""), h("div", { class: "row" }, copyButton(v.text || "", "Copy")));
  } else if (t.kind === "link") {
    const url = safeUrl(v.url);
    body.push(url ? h("div", { class: "row" }, h("a", { class: "button secondary tiny", href: url, target: "_blank", rel: "noopener noreferrer" }, "Open"), copyButton(url, "Copy address")) : null, v.notes ? h("p", { class: "small" }, v.notes) : null);
  }
  openModal(
    () => forgetMedia("play"),
    h("h2", {}, h("span", { "aria-hidden": "true" }, `${iconOf(t)} `), v.title),
    body,
    status,
    h("div", { class: "row" }, h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, "Close")),
  );
}

function peopleChip(b) {
  if (b.shared) return h("div", { class: "row" }, h("span", { class: "chip" }, `Shared by ${b.shared.from}${b.shared.write ? "" : " · read only"}`));
  if (b.people.members.length) return h("div", { class: "row" }, h("span", { class: "chip" }, `Shared with ${b.people.members.map((m) => m.name).join(", ")}`));
  return null;
}

/**
 * A name field that takes whatever you type ("LORE", "Shopping list") and shows
 * the name apps will use ("lore", "shopping-list").
 */
function nameField(label, example) {
  const input = h("input", { placeholder: example, required: true, "aria-label": label, autocapitalize: "off", spellcheck: "false" });
  const preview = h("div", { class: "muted small" }, "Type any name.");
  input.addEventListener("input", () => {
    const name = toName(input.value);
    preview.textContent = !input.value.trim() ? "Type any name." : name ? (name === input.value.trim() ? "Apps use this name." : `Apps will call it: ${name}`) : "Use at least one letter or number.";
  });
  return {
    input,
    preview,
    value() {
      const name = toName(input.value);
      if (!name) throw new Error("Give it a name with at least one letter or number.");
      return name;
    },
  };
}

function newBoxCard() {
  const name = nameField("Box name", "e.g. LORE");
  const status = h("div");
  const form = h(
    "form",
    { class: "boxcard new stack" },
    h("h3", {}, "New box"),
    h("div", { class: "muted small" }, "One box per app."),
    name.input,
    name.preview,
    h("button", { type: "submit" }, "Make box + tape"),
    status,
  );
  onSubmit(form, status, async () => {
    const box = await account.createBox(name.value());
    const { secret } = await account.createTape(box.name, { label: "dashboard" });
    showSecret(`${box.name} is ready`, secret, box.name, null, render);
  });
  return form;
}

// ── One box ─────────────────────────────────────────────────────────────────

async function renderBox(name, openKey) {
  const box = await account.box(name);
  const me = await account.me();
  if (box.id === me.profile.personal && !box.shared) return renderPersonal(box, me, openKey);
  const friends = me.profile.friends ?? {};
  if (box.id in friends && !box.shared) return renderPersonal(box, me, openKey, { link: friends[box.id] });
  const [inventory, log] = await Promise.all([account.inventory(box), account.log({ box: name, limit: 30 })]);
  const head = h(
    "div",
    { class: "page-head" },
    h(
      "div",
      { class: "stack" },
      h("a", { href: "#/", class: "small" }, "← Shelf"),
      h("h1", { class: "mono" }, box.name),
      h("div", { class: "muted" }, `${plural(box.items, "item")} · ${bytes(box.bytes)} · made ${ago(box.createdAt)}`),
      peopleChip(box),
    ),
  );

  const inside = h(
    "section",
    { class: "card" },
    h("h2", {}, "What's inside"),
    h("p", {}, inventory.summary),
    h("div", { class: "row" }, sensitiveChips(inventory.sensitive)),
    inventory.secretPaths.length ? h("p", { class: "small muted" }, "Secrets found at: ", inventory.secretPaths.slice(0, 5).map((p, i) => [i ? ", " : "", h("code", {}, p)])) : null,
    inventory.collections.map((c) =>
      h(
        "div",
        { class: "stack collection" },
        h("h3", { class: "mono" }, `${c.name} `, h("span", { class: "muted small" }, `${plural(c.items, "item")} · ${bytes(c.bytes)}`)),
        c.fields.length
          ? h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                {},
                h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Type"), h("th", {}, "In"), h("th", {}, ""))),
                h(
                  "tbody",
                  {},
                  c.fields.map((f) =>
                    h(
                      "tr",
                      {},
                      h("td", { class: "mono" }, f.name),
                      h("td", { class: "muted" }, f.types.join(" | ")),
                      h("td", { class: "muted" }, `${f.count}/${c.items}`),
                      h("td", {}, f.sensitive.map((k) => h("span", { class: `chip ${SECRET.has(k) ? "warn" : ""}` }, KIND[k] || k))),
                    ),
                  ),
                ),
              ),
            )
          : null,
      ),
    ),
  );

  fill(app, 
    head,
    h("div", { class: "two" }, h("div", {}, inside, await browser(box, openKey)), h("div", {}, await peopleSection(box), await tapesSection(box), activitySection(log))),
    box.shared ? null : h("div", { class: "two" }, settingsSection(box), timeMachine(box.name)),
    dangerZone(box),
  );
}

// ── Your personal box ───────────────────────────────────────────────────────

/**
 * A player for a video or song in your personal box. It streams through the
 * media helper (any size, starts at once, jumps anywhere); without it, files
 * up to 200 MB are opened whole first.
 */
async function play(where, entry, fetchBytes) {
  const video = entry.info.type.startsWith("video/");
  const player = h(video ? "video" : "audio", { controls: true, preload: "metadata", playsinline: true, class: "player" });
  // Watching counts as using Cardboard, so the idle lock waits until it's over.
  player.addEventListener("timeupdate", () => (lastActive = Date.now()));
  const fallback = async () => {
    if (entry.info.size > 200 * 1024 * 1024) {
      return fill(where, h("p", { class: "muted small" }, "This browser can't play it from here. Download it, then play it."));
    }
    fill(where, h("p", { class: "muted small" }, "Opening…"));
    try {
      const url = URL.createObjectURL(new Blob([await fetchBytes()], { type: entry.info.type }));
      player.src = url;
      // Up to 200 MB held by the page: let go of it once the player is gone (the window closed, another page).
      const gone = new MutationObserver(() => {
        if (player.isConnected) return;
        URL.revokeObjectURL(url);
        gone.disconnect();
      });
      gone.observe(document.body, { childList: true, subtree: true });
      player.onerror = () => fill(where, h("p", { class: "muted small" }, "This browser can't play this kind of file. Download it, then play it."));
      fill(where, player);
    } catch (err) {
      fill(where, errorBox(err));
    }
  };
  if (!(await startMediaHelper())) return fallback();
  player.addEventListener("error", fallback, { once: true });
  player.src = offerMedia({ ...entry, kind: "play" });
  fill(where, player);
}

const ICON = { note: "📝", password: "🔑", link: "🔗", file: "📎" };
/** A file's type in words ("Word document"), not its MIME type. */
function kindOfFile(type = "") {
  const named = {
    "application/pdf": "PDF",
    "application/zip": "ZIP archive",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
    "application/msword": "Word document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel workbook",
    "application/vnd.ms-excel": "Excel workbook",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "application/json": "JSON",
    "text/plain": "text",
    "text/csv": "spreadsheet (CSV)",
    "text/markdown": "Markdown",
    "application/vnd.android.package-archive": "Android app",
  }[type];
  if (named) return named;
  const [group, sub = ""] = type.split("/");
  const plain = sub.replace(/^x-/, "").split(/[.+;]/)[0].toUpperCase();
  if (group === "image") return `${plain} picture`;
  if (group === "video") return `${plain} video`;
  if (group === "audio") return `${plain} sound`;
  return "";
}

const iconOf = (t) => (t.kind !== "file" ? ICON[t.kind] : /^video\//.test(t.value.type) ? "🎬" : /^audio\//.test(t.value.type) ? "🎵" : /^image\//.test(t.value.type) ? "🖼️" : ICON.file);
const NEW_LABEL = { note: "Note", password: "Password", link: "Link", file: "File" };

/** Your personal box; and, with `friend`, a friend box (the same, with its link, and no passwords). */
async function renderPersonal(info, me, openKey, friend = null) {
  // Personal boxes made before 0.6 had the 512 MB every box got: only the account's limit applies now.
  if (!friend && info.settings.quotaBytes === OLD_BOX_QUOTA) info = await account.setBoxSettings(info.name, PERSONAL_SETTINGS);
  const box = await account.open(info);
  const about = friend ? await box.get(FRIEND_ABOUT).catch(() => null) : null;
  let things = [];
  let other = 0;
  let show = "all";
  const find = h("input", { type: "search", placeholder: friend ? "Find in this box…" : "Find in your personal box…", "aria-label": friend ? "Find in this box" : "Find in your personal box" });
  const tabs = h("div", { class: "row tabs" });
  const list = h("ul", { class: "list things" });
  const notice = h("div", { class: "stack" });
  const files = h("input", { type: "file", multiple: true, hidden: true });

  const usage = h("div", { class: "muted small" }, `Your Cardboard is using ${bytes(me.quota.used)} of ${bytes(me.quota.limit)}.`);
  let tidied = false;
  async function load() {
    ({ things, other } = await listThings(box));
    draw();
    account
      .me()
      .then(({ quota }) => (usage.textContent = `Your Cardboard is using ${bytes(quota.used)} of ${bytes(quota.limit)}.`))
      .catch(() => {});
    if (tidied) return;
    tidied = true;
    // Parts left by an upload that was cut off (the page closed part way): nothing lists them, so they go.
    strayParts(box, things, Date.now(), resumingIds(info.id))
      .then((stray) => stray.length && purgeKeys(box, stray))
      .catch(() => {});
  }

  function draw() {
    const q = find.value.trim().toLowerCase();
    fill(
      tabs,
      ["all", "note", "password", "link", "file"].map((k) => {
        const n = k === "all" ? things.length : things.filter((t) => t.kind === k).length;
        if (k !== "all" && n === 0) return null;
        const label = k === "all" ? "Everything" : KINDS[k].many[0].toUpperCase() + KINDS[k].many.slice(1);
        return h("button", { type: "button", class: `secondary tiny ${show === k ? "active" : ""}`, onclick: () => ((show = k), draw()) }, `${label} ${n}`);
      }),
    );
    const shown = things.filter((t) => (show === "all" || t.kind === show) && (!q || searchText(t.value).toLowerCase().includes(q)));
    fill(
      list,
      shown.length
        ? shown.map(thingRow)
        : h("li", { class: "muted" }, things.length ? "Nothing matches." : friend ? "Empty so far. Add the files you want to give: they're sealed on this device before they leave." : "Empty so far. Add a note, a password, a link or a file: it's sealed on this device before it leaves."),
    );
  }

  function thingRow(t) {
    const url = t.kind === "link" || t.kind === "password" ? safeUrl(t.value.url) : null;
    return h(
      "li",
      { class: "thing" },
      h(
        "button",
        { type: "button", class: "thing-open", onclick: () => editThing(t.kind, t) },
        h("span", { class: "thing-icon", "aria-hidden": "true" }, iconOf(t)),
        h("span", { class: "thing-text" }, h("strong", {}, t.value.title), h("span", { class: "muted small" }, t.value.inbox ? `${friend ? "added" : "just arrived"} from ${t.value.from || "another device"}` : subtitle(t) || " ")),
        h("span", { class: "muted small thing-when" }, ago(t.updatedAt)),
      ),
      h(
        "span",
        { class: "row thing-actions" },
        t.value.inbox ? keepButton(t) : null,
        t.kind === "password" && t.value.username ? copyButton(t.value.username, "Copy name") : null,
        t.kind === "password" ? copyButton(t.value.password, "Copy password") : null,
        t.kind === "link" && url ? h("a", { class: "button secondary tiny", href: url, target: "_blank", rel: "noopener noreferrer" }, "Open") : null,
      ),
    );
  }

  function keepButton(t) {
    const keep = h("button", { type: "button", class: "secondary tiny" }, "Keep");
    keep.addEventListener("click", () => withBusy(keep, async () => (await keepThing(box, t), load())));
    return keep;
  }

  function say(...content) {
    fill(notice, content.length ? h("div", { class: "insight tip row spread" }, ...content) : null);
  }

  async function removed(t) {
    const undo = h("button", { type: "button", class: "secondary tiny" }, "Undo");
    undo.addEventListener("click", () =>
      withBusy(undo, async () => {
        await restoreThing(box, t);
        say();
        await load();
      }),
    );
    const purge = h("button", { type: "button", class: "secondary tiny" }, "Free the space now");
    purge.addEventListener("click", () =>
      withBusy(purge, async () => {
        if (!confirm(`Delete “${t.value.title}” for good? It can't be undone after this.`)) return;
        await purgeKeys(box, keysOf(t));
        say(h("span", {}, `“${t.value.title}” is gone for good.`));
      }),
    );
    say(h("span", {}, t.kind === "file" ? `Deleted “${t.value.title}”. Its ${bytes(t.value.size)} stay in history for ${info.settings.historyDays} days, in case you change your mind.` : `Deleted “${t.value.title}”.`), h("span", { class: "row" }, undo, t.kind === "file" ? purge : null));
    await load();
  }

  async function upload(chosen) {
    const fresh = await account.box(info.name);
    const { quota } = await account.me();
    let room = Math.min(fresh.settings.quotaBytes - fresh.bytes, quota.limit - quota.used);
    const stop = new AbortController();
    const stopButton = h("button", { type: "button", class: "secondary tiny", onclick: () => stop.abort() }, "Stop");
    // Closing the page part way would lose the upload, and a phone that goes to sleep pauses it.
    const warn = (e) => e.preventDefault();
    addEventListener("beforeunload", warn);
    const awake = await navigator.wakeLock?.request("screen").catch(() => null);
    // Several files: one line at the end says how all of them went, so no message is lost on the way.
    const added = [];
    const skipped = [];
    let placesRemoved = 0;
    let stopped = false;
    try {
      for (const file of chosen) {
        if (file.size > MAX_FILE_BYTES) {
          skipped.push(`${file.name} is ${bytes(file.size)}: a file can be at most ${bytes(MAX_FILE_BYTES)}.`);
          say(h("span", {}, skipped.at(-1)));
          continue;
        }
        if (file.size + 1024 * 1024 > room) {
          skipped.push(`There isn't room for ${file.name} (${bytes(file.size)}): ${bytes(Math.max(0, room))} left. Delete things you don't need (and free their space), or ask whoever runs your Cardboard for more room.`);
          say(h("span", {}, skipped.at(-1)));
          continue;
        }
        const progress = h("span", {}, `Sealing ${file.name}…`);
        say(progress, stopButton);
        try {
          const { note } = await sealFile(box, file, {
            signal: stop.signal,
            onProgress: (f, done) => (progress.textContent = `Sealing ${file.name}… ${Math.round(f * 100)}% (${bytes(done)} of ${bytes(file.size)})`),
          });
          room -= file.size;
          added.push(file.name);
          if (/taken out/.test(note)) placesRemoved++;
          say(h("span", {}, `Added ${file.name}. Sealed here before it left this device.${note}`));
        } catch (err) {
          say(err.name === "AbortError" ? h("span", {}, `Stopped. Nothing of ${file.name} was kept.`) : errorBox(err));
          stopped = true;
          break;
        }
      }
      if (chosen.length > 1 && !stopped) {
        const words = [`Added ${plural(added.length, "file")}, sealed here before they left this device.`];
        if (placesRemoved) words.push(`Where ${placesRemoved === 1 ? "1 photo or video was" : `${placesRemoved} photos and videos were`} taken was taken out first.`);
        say(h("div", { class: "stack" }, h("span", {}, words.join(" ")), skipped.map((t) => h("span", { class: "muted small" }, t))));
      }
    } finally {
      removeEventListener("beforeunload", warn);
      awake?.release().catch(() => {});
      await load();
    }
  }

  /** The editor for a note, password or link (new without `thing`), and the viewer for a file. */
  function editThing(kind, thing = null) {
    const v = thing?.value ?? {};
    const status = h("div");
    const title = h("input", { value: v.title ?? "", maxlength: 500, placeholder: { note: "e.g. Ideas", password: "e.g. Gmail", link: "e.g. Recipe I liked", file: "" }[kind] });
    const area = (value, rows, placeholder) => {
      const el = h("textarea", { rows, placeholder, class: "plain" });
      el.value = value ?? "";
      return el;
    };
    const plainInput = (value, attrs = {}) => h("input", { value: value ?? "", autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...attrs });
    const fields = {};
    const body = [h("label", { class: "field" }, "Title", title)];
    let preview = null;
    if (kind === "note") {
      fields.text = area(v.text, 12, "Write anything…");
      body.push(h("label", { class: "field" }, "Note", fields.text));
    } else if (kind === "password") {
      fields.username = plainInput(v.username, { placeholder: "e.g. you@example.com" });
      // A masked text field, not type=password, so the browser doesn't offer to save it as a password for Cardboard itself.
      fields.password = plainInput(v.password, { class: "masked mono", placeholder: "the password" });
      const reveal = h("button", { type: "button", class: "secondary tiny" }, "Show");
      reveal.addEventListener("click", () => {
        const hidden = fields.password.classList.toggle("masked");
        reveal.textContent = hidden ? "Show" : "Hide";
      });
      const make = h("button", { type: "button", class: "secondary tiny" }, "Make a strong one");
      make.addEventListener("click", () => {
        if (fields.password.value && !confirm("Replace the password that's there with a new one?")) return;
        fields.password.value = strongPassword();
        fields.password.classList.remove("masked");
        reveal.textContent = "Hide";
      });
      fields.url = plainInput(v.url, { placeholder: "e.g. gmail.com", inputmode: "url" });
      fields.notes = area(v.notes, 3, "Security questions, PIN, anything else…");
      body.push(
        h("label", { class: "field" }, "Username or email", fields.username),
        h("label", { class: "field" }, "Password", fields.password),
        h("div", { class: "row" }, reveal, make, thing ? copyButton(v.password, "Copy saved password") : null),
        h("label", { class: "field" }, "Website", fields.url),
        h("label", { class: "field" }, "Notes", fields.notes),
      );
    } else if (kind === "link") {
      fields.url = plainInput(v.url, { placeholder: "e.g. https://example.com/page", inputmode: "url", required: true });
      fields.notes = area(v.notes, 4, "Why you kept it…");
      const url = safeUrl(v.url);
      body.push(
        h("label", { class: "field" }, "Address", fields.url),
        url ? h("div", { class: "row" }, h("a", { class: "button secondary tiny", href: url, target: "_blank", rel: "noopener noreferrer" }, "Open"), copyButton(url, "Copy address")) : null,
        h("label", { class: "field" }, "Notes", fields.notes),
      );
    } else {
      fields.notes = area(v.notes, 3, "Notes about it…");
      preview = h("div", { class: "file-preview" });
      const save = h("button", { type: "button" }, "Download");
      const send = navigator.canShare ? h("button", { type: "button", class: "secondary" }, "Send or save…") : null;
      const progress = h("span", { class: "muted small" });
      let loaded = null;
      const fetchBytes = async () => (loaded ??= await readFile(box, thing, (f) => (progress.textContent = f < 1 ? `Opening… ${Math.round(f * 100)}%` : "")));
      const tooBig = () => new Error(`${bytes(v.size)} is too big for this browser to hold at once. Download it on a computer (Chrome, Edge or Firefox), or play it here.`);
      const fileEntry = { info: { name: v.name || "file", type: v.type, size: v.size }, range: (start, end) => readRange(box, thing, start, end), chunks: () => fileChunks(box, thing) };
      save.addEventListener("click", () =>
        withBusy(save, async () => {
          try {
            // Always as a download, never opened as a page here: a file can't run anything in the dashboard.
            const said = await streamDownload(fileEntry, (words) => (progress.textContent = words));
            if (said) {
              progress.textContent = said;
              return;
            }
            if (v.size > IN_MEMORY_MAX) throw tooBig();
            blobDownload([await fetchBytes()], v.name || "file");
          } catch (err) {
            status.replaceChildren(errorBox(err));
          }
        }),
      );
      send?.addEventListener("click", () =>
        withBusy(send, async () => {
          try {
            if (v.size > IN_MEMORY_MAX) throw tooBig();
            const file = new File([await fetchBytes()], v.name || "file", { type: v.type || "application/octet-stream" });
            if (!navigator.canShare({ files: [file] })) throw new Error("This browser can't send this kind of file. Use Download instead.");
            await navigator.share({ files: [file], title: v.title }).catch((err) => {
              if (err.name !== "AbortError") throw err;
            });
          } catch (err) {
            status.replaceChildren(errorBox(err));
          }
        }),
      );
      const convertIt = h("button", { type: "button", class: "secondary" }, "Convert…");
      convertIt.addEventListener("click", () =>
        withBusy(convertIt, async () => {
          try {
            if (v.size > 400 * 1024 * 1024) throw new Error(`${bytes(v.size)} is too big to convert on this device (most is about 400 MB).`);
            convertQueue = [new File([await fetchBytes()], v.name || "file", { type: v.type || "" })];
            closeModal(false);
            location.hash = "#/convert";
          } catch (err) {
            status.replaceChildren(errorBox(err));
          }
        }),
      );
      body.push(
        h("div", { class: "muted small" }, `${v.name} · ${bytes(v.size)}${kindOfFile(v.type) ? ` · ${kindOfFile(v.type)}` : ""}`),
        preview,
        h("div", { class: "row" }, save, send, convertIt, progress),
        h("label", { class: "field" }, "Notes", fields.notes),
      );
      if (/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(v.type) && v.size <= 25 * 1024 * 1024) {
        fetchBytes()
          .then((data) => {
            const url = URL.createObjectURL(new Blob([data], { type: v.type }));
            const img = h("img", { src: url, alt: v.title });
            img.addEventListener("load", () => setTimeout(() => URL.revokeObjectURL(url), 1000));
            fill(preview, img);
          })
          .catch((err) => fill(preview, errorBox(err)));
      } else if (/^(video|audio)\//.test(v.type)) {
        play(preview, fileEntry, fetchBytes);
      }
    }

    const saveButton = h("button", { type: "submit" }, thing ? "Save" : "Keep it");
    const cancel = h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, thing ? "Close" : "Cancel");
    const del = thing ? h("button", { type: "button", class: "secondary" }, "Delete") : null;
    del?.addEventListener("click", () =>
      withBusy(del, async () => {
        if (!confirm(`Delete “${v.title}”? You can undo it straight after.`)) return;
        try {
          await removeThing(box, thing);
          closeModal(false);
          await removed(thing);
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );

    const versions = thing ? h("details", {}, h("summary", { class: "small" }, "Earlier versions")) : null;
    versions?.addEventListener("toggle", async () => {
      if (!versions.open || versions.dataset.loaded) return;
      versions.dataset.loaded = "1";
      try {
        const all = (await box.history(thing.key)).filter((x) => !x.deleted && x.version !== thing.version);
        versions.append(
          all.length
            ? h(
                "ul",
                { class: "list small" },
                all.map((x) => {
                  const back = h("button", { type: "button", class: "secondary tiny" }, "Bring this back");
                  back.addEventListener("click", () =>
                    withBusy(back, async () => {
                      await box.undo(thing.key, { to: x.version });
                      closeModal(false);
                      await load();
                    }),
                  );
                  return h("li", { class: "row spread" }, h("span", {}, `${x.value?.title ?? "Version " + x.version} · ${ago(x.at)}`), back);
                }),
              )
            : h("p", { class: "muted small" }, "No earlier versions."),
        );
      } catch (err) {
        versions.append(errorBox(err));
      }
    });

    const form = h(
      "form",
      { class: "stack" },
      h("h2", {}, h("span", { "aria-hidden": "true" }, `${thing ? iconOf(thing) : ICON[kind]} `), thing ? v.title : `New ${KINDS[kind].one}`),
      body,
      h("div", { class: "row" }, saveButton, cancel, del),
      thing ? h("div", { class: "muted small" }, `Changed ${ago(thing.updatedAt)} · version ${thing.version}`) : null,
      versions,
      status,
    );
    const save = async (version) => {
      const input = { title: title.value, ...Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value])) };
      if (kind === "file") await saveFileDetails(box, thing, input, { version });
      else await saveThing(box, kind, input, thing ? { id: thing.id, version } : {});
      closeModal(false);
      await load();
    };
    onSubmit(form, status, async () => {
      try {
        await save(thing?.version);
      } catch (err) {
        if (err.code !== "version_conflict") throw err;
        const anyway = h("button", { type: "button", class: "secondary tiny" }, "Save mine anyway");
        anyway.addEventListener("click", () => withBusy(anyway, () => save(undefined).catch((e) => status.replaceChildren(errorBox(e)))));
        status.replaceChildren(h("div", { class: "error" }, "This changed on another device while you had it open.", h("div", { class: "row" }, anyway)));
      }
    });
    openModal(null, form);
    // A stray tap outside shouldn't throw away what you typed. (Unlike `sticky`, this doesn't hold off the idle lock.)
    modal.dataset.keep = "1";
    if (!thing) (kind === "note" ? fields.text : kind === "link" ? fields.url : title).focus();
  }

  const add = h(
    "div",
    { class: "row" },
    // No passwords in a friend box: everyone with the link would see them.
    (friend ? ["note", "link"] : ["note", "password", "link"]).map((k) => h("button", { type: "button", onclick: () => editThing(k) }, `+ ${NEW_LABEL[k]}`)),
    h("button", { type: "button", onclick: () => files.click() }, friend ? "+ Files" : "+ File"),
    h("button", { type: "button", class: "secondary", onclick: () => duplicates() }, "Find duplicates"),
    files,
  );

  /** Things that are here more than once: the same file (by its fingerprint), note, link or password. */
  function duplicates() {
    const groups = new Map();
    for (const t of things) {
      const v = t.value;
      const key =
        t.kind === "file"
          ? v.sha256 && `file|${v.size}|${v.hashOf ?? ""}|${v.partSize ?? ""}|${v.sha256}`
          : t.kind === "note"
            ? `note|${v.title}|${v.text}`
            : t.kind === "link"
              ? `link|${v.url}`
              : `password|${v.url}|${v.username}|${v.password}`;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const sets = [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.createdAt - b.createdAt));
    if (!sets.length) {
      openModal(null, h("h2", {}, "No duplicates"), h("p", {}, "Everything here is here once."), h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Good")));
      return;
    }
    // The oldest of each stays; the copies are ticked to go.
    const rows = sets.map((group) =>
      group.map((t, i) => ({ t, input: h("input", { type: "checkbox", checked: i > 0, "aria-label": `Remove ${t.value.title}` }) })),
    );
    const status = h("div");
    const go = h("button", { type: "button" }, "Remove the ticked copies");
    const spare = sets.reduce((n, g) => n + g.slice(1).reduce((m, t) => m + (t.kind === "file" ? t.value.size : 0), 0), 0);
    go.addEventListener("click", () =>
      withBusy(go, async () => {
        const gone = rows.flat().filter((r) => r.input.checked).map((r) => r.t);
        if (rows.some((group) => group.every((r) => r.input.checked)) && !confirm("Every copy of something is ticked, so it would go altogether. Go ahead?")) return;
        try {
          for (const t of gone) await removeThing(box, t);
          closeModal(false);
          const undo = h("button", { type: "button", class: "secondary tiny" }, "Undo");
          undo.addEventListener("click", () =>
            withBusy(undo, async () => {
              for (const t of gone) await restoreThing(box, t);
              say();
              await load();
            }),
          );
          const free = h("button", { type: "button", class: "secondary tiny" }, "Free the space now");
          free.addEventListener("click", () =>
            withBusy(free, async () => {
              if (!confirm("Delete the copies for good? It can't be undone after this.")) return;
              await purgeKeys(box, gone.flatMap(keysOf));
              say(h("span", {}, "The copies are gone for good."));
            }),
          );
          say(h("span", {}, `Removed ${plural(gone.length, "copy").replace("copys", "copies")}. Their space comes back when their history runs out (${info.settings.historyDays} days), or now.`), h("span", { class: "row" }, undo, free));
          await load();
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );
    openModal(
      null,
      h("h2", {}, `${plural(sets.length, "thing")} here more than once`),
      h("p", { class: "small" }, "The same content, by its fingerprint (not just the same name). The oldest of each is kept", spare ? `; removing the copies frees ${bytes(spare)}.` : "."),
      rows.map((group) =>
        h(
          "ul",
          { class: "list dupes" },
          group.map(({ t, input }) => h("li", { class: "row" }, input, h("span", { "aria-hidden": "true" }, iconOf(t)), h("span", {}, h("strong", {}, t.value.title), h("span", { class: "muted small" }, ` · ${t.kind === "file" ? `${bytes(t.value.size)} · ` : ""}added ${ago(t.createdAt)}${t.value.from ? ` from ${t.value.from}` : ""}`)))),
        ),
      ),
      h("div", { class: "row" }, go, h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, "Cancel")),
      status,
    );
  }
  files.addEventListener("change", () => {
    const chosen = [...files.files];
    files.value = "";
    upload(chosen);
  });
  find.addEventListener("input", draw);

  const log = await account.log({ box: info.name, limit: 30, title: await itemTitles() });
  const page = h(
    "div",
    { class: "personal" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "stack" },
        h("a", { href: "#/", class: "small" }, "← Shelf"),
        h("h1", {}, friend ? `🎁 ${about?.title || info.name}` : "Your personal box"),
        h("div", { class: "muted" }, friend ? "A friend box: anyone with its link can open it, with no account. Sealed like everything else: the server can't see inside." : "Just for you. Everything is sealed on this device before it leaves, and opens on every device you've signed in on."),
        usage,
        peopleChip(info),
      ),
    ),
    friend ? friendLinkCard(info, friend.link) : me.device.lock ? null : h("p", { class: "insight tip small" }, "Tip: ", h("a", { href: "#/you" }, "lock this browser with Face ID"), " so nobody who picks up this device can open your personal box."),
    h("section", { class: "card stack" }, add, find, tabs, notice, list, h("p", { class: "muted small drop-hint" }, "You can also drop files here.")),
    h(
      "details",
      { class: "card" },
      h("summary", {}, "Sharing, apps, history and settings"),
      h("div", { class: "stack" }, h("p", { class: "muted small" }, other ? `${plural(other, "other item")} here came from apps or the CLI. They're in Browse.` : "Everything a regular box has, for when you need it."), h("div", { class: "two" }, h("div", {}, await browser(info)), h("div", {}, await peopleSection(info), await tapesSection(info), activitySection(log))), h("div", { class: "two" }, settingsSection(info), timeMachine(info.name)), dangerZone(info)),
    ),
  );
  page.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
  });
  page.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    upload([...e.dataTransfer.files]);
  });
  // Back on this tab after using another device: show what changed there.
  const refresh = () => {
    if (!app.contains(list)) return document.removeEventListener("visibilitychange", refresh);
    if (document.visibilityState === "visible" && modal.hidden) load().catch(() => {});
  };
  document.addEventListener("visibilitychange", refresh);
  // Live: what another device (or, in a friend box, a friend) adds shows up straight away.
  let changed = null;
  shelfWatch = keepWatch(box.watch(
    (change) => {
      if (!/^(notes|passwords|links|files)\//.test(change.key)) return;
      clearTimeout(changed);
      changed = setTimeout(() => modal.hidden && load().catch(() => {}), 300);
    },
    { onError: () => {} },
  ));

  fill(app, page);
  await load();
  if (openKey) {
    const wanted = things.find((t) => t.key === openKey);
    if (wanted) editThing(wanted.kind, wanted);
  }
}

// ── Sharing a box with people ───────────────────────────────────────────────

const SHARE_FOR = [
  ["1d", "1 day"],
  ["3d", "3 days"],
  ["7d", "a week"],
  ["30d", "30 days"],
];

async function peopleSection(box) {
  const status = h("div");
  const member = (m) => {
    const remove = box.shared ? null : h("button", { type: "button", class: "secondary tiny" }, "Take off");
    remove?.addEventListener("click", () =>
      withBusy(remove, async () => {
        if (!confirm(`Take ${m.name} off ${box.name}? They can't reach it any more and their apps are cut off. (Anything they already saw, they keep.)`)) return;
        await account.removeMember(box.name, m.id);
        render();
      }),
    );
    return h(
      "li",
      { class: "row spread" },
      h("div", {}, h("strong", {}, m.name), m.you ? h("span", { class: "chip ok" }, "you") : null, h("div", { class: "muted small" }, `${m.write ? "can change it" : "read only"} · ${plural(m.apps, "app")} · joined ${ago(m.joinedAt)}`)),
      remove,
    );
  };

  if (box.shared) {
    const leave = h("button", { type: "button", class: "secondary" }, "Leave this box");
    leave.addEventListener("click", () =>
      withBusy(leave, async () => {
        if (!confirm(`Leave ${box.name}? You'd need a new link from ${box.shared.from} to come back.`)) return;
        await account.leaveBox(box.name);
        location.hash = "#/";
      }),
    );
    return h(
      "section",
      { class: "card stack" },
      h("h2", {}, "People"),
      h("ul", { class: "list" }, h("li", {}, h("strong", {}, box.shared.from), h("div", { class: "muted small" }, "owner: shared it with you")), box.people.members.map(member)),
      h("p", { class: "muted small" }, box.shared.write ? "You can read and change everything here, and so can your apps." : "You can read everything here, but not change it."),
      h("div", { class: "row" }, leave),
    );
  }

  const links = box.people.links.map((l) => {
    const cancel = h("button", { type: "button", class: "secondary tiny" }, "Cancel");
    cancel.addEventListener("click", () =>
      withBusy(cancel, async () => {
        await account.cancelShare(l.id);
        render();
      }),
    );
    return h("li", { class: "row spread" }, h("div", { class: "muted small" }, `Link${l.label ? ` for ${l.label}` : ""}, not opened yet · ${l.write ? "can change it" : "read only"} · works until ${new Date(l.expiresAt).toLocaleDateString()}`), cancel);
  });

  const { profile } = await account.me();
  const forWhom = h("input", { placeholder: "e.g. Anna", maxlength: 60 });
  const as = h("input", { value: profile.name || "", placeholder: "e.g. Gosinn", maxlength: 60, required: true });
  const write = h("input", { type: "checkbox", checked: true });
  const ttl = h("select", {}, SHARE_FOR.map(([v, label]) => h("option", { value: v, selected: v === "3d" }, label)));
  const form = h(
    "form",
    { class: "stack" },
    h("div", { class: "two" }, h("label", { class: "field" }, "Who's it for (just for you)", forWhom), h("label", { class: "field" }, "Your name, as they'll see it", as)),
    h("label", { class: "check small" }, write, "They can change things too (not just look)"),
    h("label", { class: "row small" }, "The link works for", ttl),
    h("button", { type: "submit" }, "Make a share link"),
    status,
  );
  onSubmit(form, status, async () => {
    const result = await account.shareBox(box.name, { label: forWhom.value.trim() || undefined, as: as.value.trim(), write: write.checked, expires: ttl.value });
    showShareLink(box.name, forWhom.value.trim(), result, render);
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "People"),
    box.people.members.length || links.length ? h("ul", { class: "list" }, box.people.members.map(member), links) : h("p", { class: "muted small" }, "Only you. Share this box with family or a friend who has a Cardboard account here: you'll both see (and your apps will both use) the same data."),
    h("details", {}, h("summary", {}, "Share with someone"), form),
  );
}

function showShareLink(boxName, forWhom, result, onDone) {
  openModal(
    onDone,
    h("h2", {}, `Share ${boxName}${forWhom ? ` with ${forWhom}` : ""}`),
    h("p", {}, "Send this link privately (Signal, iMessage), or let them scan the code. Whoever opens it first, with their own Cardboard here, joins the box. Then it stops working."),
    qrCode(result.link, "QR code of the share link"),
    h("code", { class: "secret" }, result.link),
    sendButtons(result.link, `Join ${boxName} on Cardboard`),
    h("p", { class: "muted small" }, `The secret is the part after #, which browsers never send to a server, so Cardboard can't open it either. It works until ${new Date(result.expiresAt).toLocaleString()}.`),
    h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Done")),
  );
}

/** Someone sent you a share link. */
async function renderJoin(code) {
  nav.hidden = false;
  const done = (hash) => {
    pendingShare = null;
    location.hash = hash;
  };
  let preview;
  try {
    preview = await account.viewShare(code);
  } catch (err) {
    pendingShare = null;
    fill(app, h("section", { class: "card stack login" }, h("h1", {}, "That link doesn't work"), errorBox(err), h("a", { href: "#/" }, "Go to your shelf")));
    return;
  }
  if (preview.own || preview.member) {
    pendingShare = null;
    const box = (await account.boxes()).find((b) => b.id === preview.boxId);
    fill(
      app,
      h(
        "section",
        { class: "card stack login" },
        h("h1", {}, preview.own ? "That's your own box" : "You're already in this box"),
        h("p", { class: "muted" }, preview.own ? "Send the link to the person you want to share it with." : "It's on your shelf."),
        box ? h("a", { href: `#/box/${encodeURIComponent(box.name)}` }, `Open ${box.name}`) : h("a", { href: "#/" }, "Go to your shelf"),
      ),
    );
    return;
  }
  const { profile } = await account.me();
  const as = h("input", { value: profile.name || "", placeholder: "e.g. Anna", maxlength: 60, required: true });
  const status = h("div");
  const join = h("button", { type: "submit" }, "Join");
  const no = h("button", { type: "button", class: "secondary", onclick: () => done("#/") }, "No thanks");
  const form = h(
    "form",
    { class: "card stack login" },
    h("h1", {}, h("span", {}, preview.from), " wants to share ", h("span", { class: "mono" }, preview.name), " with you"),
    h(
      "ul",
      { class: "list perms" },
      h("li", {}, h("strong", {}, preview.write ? "You can read and change it" : "You can read it"), h("div", { class: "muted small" }, preview.write ? "So can your apps, if you connect them to it." : "Changes stay theirs to make.")),
      h("li", {}, h("strong", {}, "Everyone in it sees what changes, and who changed it"), h("div", { class: "muted small" }, "By the name you give below. Your devices and other boxes stay private.")),
      h("li", {}, h("strong", {}, "Still end-to-end encrypted"), h("div", { class: "muted small" }, "The box key comes to you sealed; whoever runs this server can't open it.")),
    ),
    h("label", { class: "field" }, "Your name, as they'll see it", as),
    h("div", { class: "row" }, join, no),
    status,
  );
  onSubmit(form, status, async () => {
    const box = await account.joinShare(code, { as: as.value.trim() });
    done(`#/box/${encodeURIComponent(box.name)}`);
  });
  fill(app, form);
}

async function browser(info, openKey) {
  const box = await account.open(info);
  const prefix = h("input", { type: "search", placeholder: "Filter by prefix, e.g. notes/", "aria-label": "Prefix" });
  const list = h("div", { class: "keys" });
  const detail = h("div", { class: "stack" });
  let active = null;
  let all = null;

  async function load() {
    try {
      all ??= await box.list("", { limit: Infinity });
      // A file's parts (file-data/…) are thousands of keys: shown only when asked for by name.
      const items = all.filter((it) => it.key.startsWith(prefix.value) && (prefix.value.startsWith(FILE_DATA) || !it.key.startsWith(FILE_DATA)));
      fill(
        list,
        items.length === 0 ? h("p", { class: "muted small" }, "Nothing here.") : null,
        items.slice(0, 300).map((it) => {
          const btn = h("button", { type: "button", title: it.key }, it.key);
          btn.addEventListener("click", () => show(it.key, btn));
          return btn;
        }),
        items.length > 300 ? h("p", { class: "muted small" }, "Showing the first 300. Narrow it with a prefix.") : null,
      );
    } catch (err) {
      list.replaceChildren(errorBox(err));
    }
  }

  async function show(key, btn) {
    active?.classList.remove("active");
    active = btn || null;
    active?.classList.add("active");
    try {
      const [item, versions] = await Promise.all([box.getItem(key), box.history(key)]);
      const undo = h("button", { type: "button", class: "secondary tiny" }, "Undo last change");
      undo.addEventListener("click", () =>
        withBusy(undo, async () => {
          await box.undo(key);
          all = null;
          await load();
          await show(key);
        }),
      );
      fill(
        detail,
        h("div", { class: "row spread" }, h("h3", { class: "mono" }, key), versions.length > 1 ? undo : null),
        item
          ? h("div", { class: "muted small" }, `version ${item.version} · ${bytes(item.size)} sealed · changed ${ago(item.updatedAt)}${item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleString()}` : ""}`)
          : h("div", { class: "muted small" }, "Deleted (still in history)."),
        item ? h("pre", {}, item.value instanceof Uint8Array ? `${bytes(item.value.length)} of file data` : JSON.stringify(item.value, null, 2)) : null,
        versions.length > 1
          ? h(
              "details",
              {},
              h("summary", { class: "small" }, `${versions.length} versions`),
              h("ul", { class: "list small" }, versions.map((v) => h("li", {}, `v${v.version} · ${ago(v.at)} · `, v.deleted ? "deleted" : bytes(v.size)))),
            )
          : null,
      );
    } catch (err) {
      detail.replaceChildren(errorBox(err));
    }
  }

  prefix.addEventListener("input", () => {
    clearTimeout(prefix._t);
    prefix._t = setTimeout(load, 150);
  });
  load();
  if (openKey) show(openKey);
  return h("section", { class: "card stack" }, h("h2", {}, "Browse"), prefix, list, detail);
}

async function tapesSection(box) {
  const tapes = await Promise.all(
    box.tapes.map(async (t) => {
      const perms = [t.read && "read", t.write && "write"].filter(Boolean).join(" + ");
      const active = t.state === "active";
      const revoke = active ? h("button", { class: "secondary tiny", type: "button" }, "Revoke") : null;
      revoke?.addEventListener("click", () =>
        withBusy(revoke, async () => {
          if (!confirm(`Revoke “${t.label}”? Anything using it is locked out immediately.`)) return;
          await account.revokeTape(t.id);
          render();
        }),
      );
      return h(
        "li",
        { class: "stack" },
        h(
          "div",
          { class: "row spread" },
          h(
            "div",
            { class: "row" },
            h("strong", {}, `“${t.label}”`),
            h("span", { class: "chip" }, perms),
            t.kind === "assistant" ? h("span", { class: "chip" }, "AI assistant") : null,
            h("span", { class: `chip ${active ? "ok" : ""}` }, active ? "active" : "off"),
          ),
          revoke,
        ),
        h("div", { class: "small" }, (await account.blast(t, box)).summary),
        h("div", { class: "muted small mono" }, `${t.id} · last used ${ago(t.lastUsedAt)}`),
      );
    }),
  );

  const label = h("input", { placeholder: "phone, laptop, ci…", "aria-label": "Label" });
  const read = h("input", { type: "checkbox", checked: true });
  const write = h("input", { type: "checkbox", checked: true });
  const idle = h("select", {}, h("option", { value: "90d" }, "90 days unused"), h("option", { value: "30d" }, "30 days unused"), h("option", { value: "7d" }, "7 days unused"), h("option", { value: "never" }, "never (not recommended)"));
  const expires = h("select", {}, h("option", { value: "" }, "no fixed end"), h("option", { value: "1d" }, "in 1 day"), h("option", { value: "7d" }, "in 7 days"), h("option", { value: "30d" }, "in 30 days"));
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("h3", {}, "New tape"),
    h("label", { class: "field" }, "Label", label),
    h("div", { class: "row" }, h("label", { class: "check" }, read, "can read"), h("label", { class: "check" }, write, "can write")),
    h("div", { class: "two" }, h("label", { class: "field" }, "Switches off after", idle), h("label", { class: "field" }, "Expires", expires)),
    h("button", { type: "submit" }, "Make tape"),
    status,
  );
  onSubmit(form, status, async () => {
    const { tape, secret } = await account.createTape(box.name, {
      label: label.value.trim() || "dashboard",
      read: read.checked,
      write: write.checked,
      idle: idle.value,
      expires: expires.value || undefined,
    });
    showSecret(`New tape for ${box.name}`, secret, box.name, (await account.blast(tape, await account.box(box.name))).summary, render);
  });

  return h("section", { class: "card stack" }, h("h2", {}, "Tapes"), h("ul", { class: "list" }, tapes), h("details", {}, h("summary", {}, "Make a new tape"), form));
}

function logLines(entries) {
  return h(
    "ul",
    { class: "list" },
    entries.map((e) => h("li", { class: `log-line ${e.outcome}` }, h("time", { title: new Date(e.at).toLocaleString() }, ago(e.at)), h("div", {}, h("span", { class: "text" }, e.text)))),
  );
}

function activitySection(entries) {
  return h(
    "section",
    { class: "card" },
    h("div", { class: "row spread" }, h("h2", {}, "Recent activity"), h("a", { href: "#/activity", class: "small" }, "Everything →")),
    entries.length ? logLines(entries) : h("p", { class: "muted" }, "Nothing yet."),
  );
}

function settingsSection(box) {
  const s = box.settings;
  const secrets = h("select", {}, h("option", { value: "warn", selected: s.secrets === "warn" }, "Store them, but warn me"), h("option", { value: "block", selected: s.secrets === "block" }, "Refuse to store them"));
  const ttlText = !s.defaultTtlMs ? "" : s.defaultTtlMs % 86400000 === 0 ? `${s.defaultTtlMs / 86400000}d` : `${Math.round(s.defaultTtlMs / 3600000)}h`;
  const ttl = h("input", { value: ttlText, placeholder: "keep forever, or e.g. 30d" });
  const historyDays = h("input", { type: "number", min: 0, max: 3650, value: s.historyDays });
  const quota = h("input", { value: bytes(s.quotaBytes).replace(" ", "") });
  const origins = h("input", { value: s.origins.join(", "), placeholder: "https://myapp.example.com" });
  const status = h("div");
  const form = h(
    "form",
    { class: "card stack" },
    h("h2", {}, "Settings"),
    h("label", { class: "field" }, "API keys, passwords and other secrets", secrets),
    h("label", { class: "field" }, "Things expire after (unless an app says otherwise)", ttl),
    h("label", { class: "field" }, "Days of history to keep for undo & rewind", historyDays),
    h("label", { class: "field" }, "Space allowed", quota),
    h("label", { class: "field" }, "Websites allowed to call this box from a browser (comma separated)", origins),
    h("button", { type: "submit" }, "Save"),
    status,
  );
  onSubmit(form, status, async () => {
    await account.setBoxSettings(box.name, {
      secrets: secrets.value,
      defaultTtl: ttl.value.trim() || null,
      historyDays: Number(historyDays.value),
      quotaBytes: quota.value.trim(),
      origins: origins.value.split(",").map((o) => o.trim()).filter(Boolean),
    });
    status.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
  });
  return form;
}

function timeMachine(boxName) {
  const when = h("select", {}, h("option", { value: "5m" }, "5 minutes ago"), h("option", { value: "1h" }, "1 hour ago"), h("option", { value: "1d" }, "1 day ago"), h("option", { value: "7d" }, "1 week ago"));
  const status = h("div");
  const button = h("button", { type: "button", class: "secondary" }, "Rewind");
  button.addEventListener("click", () =>
    withBusy(button, async () => {
      if (!confirm(`Put every item in ${boxName} back the way it was ${when.selectedOptions[0].textContent}? (You can rewind the rewind.)`)) return;
      try {
        const result = await account.rewind(boxName, when.value);
        status.replaceChildren(h("span", { class: "chip ok" }, `Done: ${plural(result.changed, "item")} changed`));
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Time machine"),
    h("p", { class: "muted small" }, "An app went wrong and wrecked its data? Put the whole box back to an earlier moment. Every item is restored as a new version, so this can be undone too."),
    h("div", { class: "row" }, when, button),
    status,
  );
}

/**
 * A button that downloads everything in a box, opened, as JSON Lines. Streamed
 * through the media helper a megabyte at a time, so a box full of videos never
 * has to fit in memory; held in memory only where the helper can't run.
 */
function exportButton(box, status, label, size = "") {
  const button = h("button", { type: "button", class: `secondary ${size}` }, label);
  button.addEventListener("click", () =>
    withBusy(button, async () => {
      try {
        const name = `${box.name}-${new Date().toISOString().slice(0, 10)}.jsonl`;
        const encoder = new TextEncoder();
        const chunks = async function* () {
          let batch = "";
          for await (const line of account.exportLines(box.name)) {
            batch += line;
            if (batch.length > 1024 * 1024) {
              yield encoder.encode(batch);
              batch = "";
            }
          }
          if (batch) yield encoder.encode(batch);
        };
        const said = await streamDownload({ info: { name, type: "application/x-ndjson" }, chunks }, (words) => (status.textContent = words));
        if (said) {
          status.textContent = said;
          return;
        }
        if (box.bytes > IN_MEMORY_MAX) throw new Error(`${box.name} is too big to download in this browser. On the computer Cardboard runs on: node src/cli.ts export ${box.name} --out ${name}`);
        const lines = [];
        for await (const line of account.exportLines(box.name)) lines.push(line);
        blobDownload(lines, name);
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  return button;
}

function dangerZone(box) {
  const exportStatus = h("span", { class: "muted small" }, "Everything, opened, as plain data (one item per line). Keep the file somewhere private.");
  const exportBtn = exportButton(box, exportStatus, "Export");
  if (box.shared) {
    return h(
      "section",
      { class: "card stack danger-zone" },
      h("h2", {}, "Moving day"),
      h("div", { class: "row" }, exportBtn, exportStatus),
    );
  }
  const confirmName = h("input", { placeholder: box.name, "aria-label": "Type the box name to confirm" });
  const shredBtn = h("button", { type: "button", class: "danger" }, "Shred this box");
  const status = h("div");
  shredBtn.addEventListener("click", () =>
    withBusy(shredBtn, async () => {
      if (confirmName.value.trim() !== box.name) return status.replaceChildren(errorBox(new Error("Type the box's name to confirm.")));
      try {
        await account.shredBox(box.name);
        location.hash = "#/";
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  return h(
    "section",
    { class: "card stack danger-zone" },
    h("h2", {}, "Moving day & shredding"),
    h("div", { class: "row" }, exportBtn, exportStatus),
    h("p", { class: "small" }, `Shredding deletes the box's key with everything else, so every item, version, tape and log line is gone for good, backups included${box.people.members.length ? ", for everyone you share it with too" : ""}. Type the name to confirm.`),
    h("div", { class: "row" }, confirmName, shredBtn),
    status,
  );
}

// ── If something happens to you ─────────────────────────────────────────────

const WAITS = [
  ["1d", "1 day"],
  ["3d", "3 days"],
  ["7d", "7 days"],
  ["14d", "14 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
];

/** Someone is using one of your emergency links right now: stop it, or let them in. Shown on the shelf and on You. */
function emergencyAlerts(me) {
  return me.emergency.map((l) => {
    const stop = h("button", { type: "button", class: "danger" }, "Stop it");
    const allow = h("button", { type: "button", class: "secondary" }, "Let them in now");
    stop.addEventListener("click", () =>
      withBusy(stop, async () => {
        await account.stopEmergency(l.id);
        render();
      }),
    );
    allow.addEventListener("click", () =>
      withBusy(allow, async () => {
        if (!confirm(`Let ${l.label || "them"} into your whole Cardboard now?`)) return;
        await account.allowEmergency(l.id);
        render();
      }),
    );
    return h(
      "section",
      { class: "card stack alert" },
      h("h2", {}, `Someone is using your emergency access link${l.label ? ` (the one for ${l.label})` : ""}`),
      h("p", {}, `Unless you stop it, they can open your whole Cardboard ${l.approvedAt ? "now" : `on ${new Date(l.readyAt).toLocaleString()}`}. If that's not what you want, stop it now.`),
      h("div", { class: "row" }, stop, allow),
    );
  });
}

async function emergencyCard() {
  const links = await account.emergencyLinks();
  const { profile } = await account.me();
  const list = links.map((l) => {
    const remove = h("button", { type: "button", class: "secondary tiny" }, "Remove");
    remove.addEventListener("click", () =>
      withBusy(remove, async () => {
        if (!confirm(`Remove ${l.label ? `${l.label}'s` : "this"} emergency link? It stops working at once.`)) return;
        await account.removeEmergency(l.id);
        render();
      }),
    );
    const state = l.readyAt ? h("span", { class: "chip danger" }, "being used now") : h("span", { class: "chip" }, `waits ${describeDuration(l.waitMs)}`);
    return h("li", { class: "row spread" }, h("div", {}, h("strong", {}, l.label || "Someone you trust"), " ", state, h("div", { class: "muted small" }, `made ${ago(l.createdAt)}`)), remove);
  });
  const forWhom = h("input", { placeholder: "e.g. Anna", maxlength: 60 });
  const as = h("input", { value: profile.name || "", placeholder: "e.g. Gosinn", maxlength: 60, required: true });
  const message = h("textarea", { rows: 3, maxlength: 1000, placeholder: "Optional, e.g. “The house papers are in the documents box.”" });
  const wait = h("select", {}, WAITS.map(([v, label]) => h("option", { value: v, selected: v === "7d" }, label)));
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("div", { class: "two" }, h("label", { class: "field" }, "Who's it for (just for you)", forWhom), h("label", { class: "field" }, "Your name, as they'll see it", as)),
    h("label", { class: "field" }, "A message for them (sealed: only they'll read it)", message),
    h("label", { class: "row small" }, "If they use it, wait", wait, "before letting them in"),
    h("button", { type: "submit" }, "Make the link"),
    status,
  );
  onSubmit(form, status, async () => {
    const result = await account.addEmergencyLink({ label: forWhom.value.trim() || undefined, as: as.value.trim(), message: message.value, wait: wait.value });
    showEmergencyLink(forWhom.value.trim(), as.value.trim(), wait.selectedOptions[0].textContent, result.link, render);
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "If something happens to you"),
    h(
      "p",
      { class: "small" },
      "Give someone you trust a link, or a printed QR code. If they ever use it, every one of your devices is told, and you can stop it. If you don't (because you can't), they get into your Cardboard after the wait you choose.",
    ),
    links.length ? h("ul", { class: "list" }, list) : null,
    h("details", {}, h("summary", {}, links.length ? "Add someone else" : "Add someone you trust"), form),
  );
}

function showEmergencyLink(forWhom, from, wait, link, onDone) {
  const print = h("button", { type: "button", class: "secondary", onclick: () => window.print() }, "Print");
  openModal(
    onDone,
    h("h2", {}, `Emergency access to ${from || "my"}${from ? "'s" : ""} Cardboard`),
    h("p", {}, forWhom ? `For ${forWhom}. ` : "", "Keep this somewhere safe. If something happens to ", from || "me", ", scan the code (or open the link) and choose “Ask for access”."),
    qrCode(link, "QR code of the emergency access link"),
    h("code", { class: "secret" }, link),
    h("div", { class: "row" }, sendButtons(link, "Emergency access to my Cardboard"), print),
    h("p", { class: "muted small" }, `When it's used, ${from || "the owner"} is told on every device and has ${wait} to stop it. Treat it like a house key: whoever holds it can ask. The secret is after the #, so the server can't use it.`),
    h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Done")),
  );
}

/** You were given an emergency access link. Works with or without a Cardboard account of your own. */
async function renderEmergency(code) {
  nav.hidden = true;
  const logo = document.querySelector(".brand svg").cloneNode(true);
  const card = (...children) => fill(app, h("section", { class: "card stack login" }, h("div", { class: "row" }, logo, h("h1", {}, "Emergency access")), ...children));
  let preview;
  try {
    preview = await viewEmergency({ url: ORIGIN, link: code });
  } catch (err) {
    pendingEmergency = null;
    return card(errorBox(err), h("a", { href: "#/" }, "Go to Cardboard"));
  }
  const status = h("div");
  const message = preview.message ? [h("p", { class: "small muted" }, `${preview.from}'s message for you:`), h("p", { class: "message" }, preview.message)] : null;

  if (!preview.requestedAt) {
    const ask = h("button", { type: "button", class: "danger" }, "Ask for access");
    ask.addEventListener("click", () =>
      withBusy(ask, async () => {
        if (!confirm(`${preview.from} will be told on every one of their devices. Continue?`)) return;
        try {
          await requestEmergency({ url: ORIGIN, link: code });
          renderEmergency(code);
        } catch (err) {
          status.replaceChildren(errorBox(err));
        }
      }),
    );
    return card(
      h("p", {}, h("strong", {}, preview.from), " gave you this in case something happens to them."),
      message,
      h("p", {}, `If you ask for access, ${preview.from} is told on all their devices and has ${describeDuration(preview.waitMs)} to stop it. If they don't, you can open their Cardboard with this same link (keep it).`),
      h("div", { class: "row" }, ask),
      status,
    );
  }

  if (!preview.open) {
    return card(
      h("p", {}, `You asked for access to ${preview.from}'s Cardboard ${ago(preview.requestedAt)}.`),
      message,
      h("p", {}, h("strong", {}, `You can open it from ${new Date(preview.readyAt).toLocaleString()}`), `, unless ${preview.from} stops it. Come back to this same link then.`),
    );
  }

  if (await browserStore.load()) {
    return card(
      h("p", {}, `You can open ${preview.from}'s Cardboard now.`),
      message,
      h("p", { class: "error" }, "This browser is already signed in to a Cardboard. Open the link in another browser, or a new browser profile, to open theirs."),
    );
  }
  const name = deviceNameField();
  const go = h("button", { type: "button" }, `Open ${preview.from}'s Cardboard`);
  go.addEventListener("click", () =>
    withBusy(go, async () => {
      try {
        account = await claimEmergency({ ...getInOptions(name.value.trim()), link: code });
        pendingEmergency = null;
        history.replaceState(null, "", "#/");
        await render();
        const later = h("button", { type: "button", class: "secondary", onclick: () => closeModal() }, "Later");
        const kit = h("button", { type: "button" }, "Make my recovery kit");
        kit.addEventListener("click", () => withBusy(kit, async () => showRecovery(await account.setRecovery("kit"), render)));
        openModal(
          null,
          h("h2", {}, `You're in ${preview.from}'s Cardboard`),
          h("p", {}, "This browser is one of its devices now. Make a recovery kit, so you don't depend on this one browser to get back in."),
          h("div", { class: "row" }, kit, later),
        );
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  return card(
    h("p", {}, h("strong", {}, `You can open ${preview.from}'s Cardboard now.`), " This browser becomes one of its devices, and the link stops working."),
    message,
    h("label", { class: "field" }, "What to call this browser", name),
    h("div", { class: "row" }, go),
    status,
  );
}

/** You scanned the QR code a new device is showing: approve it here. */
function renderApprovePair(code) {
  nav.hidden = false;
  const name = h("input", { placeholder: "e.g. Laptop", maxlength: 60 });
  const status = h("div");
  const no = h("button", { type: "button", class: "secondary" }, "Cancel");
  no.addEventListener("click", () => {
    pendingPair = null;
    location.hash = "#/";
  });
  const form = h(
    "form",
    { class: "card stack login" },
    h("h1", {}, "Add a new device?"),
    h("p", {}, "This lets the device that showed you this code open your whole Cardboard. ", h("strong", {}, "Only continue if it's yours, it's in front of you, and you just asked it to pair.")),
    h("p", { class: "muted small" }, "Did someone send you this code, or ask you to scan it? Then cancel: that's how people get tricked into letting strangers in."),
    h("label", { class: "field" }, "What to call it", name),
    h("div", { class: "row" }, h("button", { type: "submit" }, "Approve"), no),
    status,
  );
  onSubmit(form, status, async () => {
    await account.approveDevice(code, name.value.trim() || undefined);
    pendingPair = null;
    fill(app, h("section", { class: "card stack login" }, h("h1", {}, "Approved"), h("p", {}, "It's signing in now."), h("a", { href: "#/you" }, "See your devices")));
  });
  fill(app, form);
}

/** Invite a friend to make their own account here (when the host allows it). */
async function inviteCard(me) {
  if (me.server.invites !== "everyone") return null;
  const { invites } = await account.invites();
  const make = h("button", { type: "button" }, "Make an invite link");
  make.addEventListener("click", () =>
    withBusy(make, async () => {
      try {
        const { link, expiresAt } = await account.inviteFriend();
        openModal(
          render,
          h("h2", {}, "Invite a friend"),
          h("p", {}, "Send this, or let them scan it. It makes them their own account here, and works once."),
          qrCode(link, "QR code of the invite link"),
          h("code", { class: "secret" }, link),
          sendButtons(link, "Join me on Cardboard"),
          h("p", { class: "muted small" }, `Works until ${new Date(expiresAt).toLocaleString()}. Their account is theirs: you can't see into it, and they can't see into yours. Share a box with them afterwards.`),
          h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Done")),
        );
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  const status = h("div");
  const waiting = invites.map((i) => {
    const cancel = h("button", { type: "button", class: "secondary tiny" }, "Cancel");
    cancel.addEventListener("click", () =>
      withBusy(cancel, async () => {
        await account.cancelInvite(i.id);
        render();
      }),
    );
    return h("li", { class: "row spread" }, h("div", { class: "muted small" }, `Invite made ${ago(i.createdAt)}, not used yet · works until ${new Date(i.expiresAt).toLocaleDateString()}`), cancel);
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Invite a friend"),
    h("p", { class: "small" }, "Friends get their own Cardboard here, with their own keys. Then you can share boxes with each other."),
    waiting.length ? h("ul", { class: "list" }, waiting) : null,
    h("div", { class: "row" }, make),
    status,
  );
}

// ── Docks ───────────────────────────────────────────────────────────────────

function direction(p) {
  return p.send && p.receive ? "send and receive" : p.send ? "send" : "receive";
}

/** Docking requests with one-tap answers. Returns null when nothing is waiting. */
function pendingCard(pending) {
  if (!pending || pending.length === 0) return null;
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, `Docking request${pending.length === 1 ? "" : "s"}`),
    h("p", { class: "muted small" }, "Apps asking to swap data. Approve and they connect straight away; they still won't learn each other's names."),
    h(
      "ul",
      { class: "list" },
      pending.map((p) => {
        const approve = h("button", { type: "button", class: "tiny" }, "Approve");
        const deny = h("button", { type: "button", class: "secondary tiny" }, "Deny");
        approve.addEventListener("click", () =>
          withBusy(approve, async () => {
            await account.dockApprove(p.dock, p.box);
            render();
          }),
        );
        deny.addEventListener("click", () =>
          withBusy(deny, async () => {
            await account.dockDeny(p.dock, p.box);
            render();
          }),
        );
        return h("li", { class: "row spread" }, h("div", {}, h("strong", { class: "mono" }, p.box), ` wants to ${direction(p)} on `, h("strong", { class: "mono" }, p.dock)), h("div", { class: "row" }, approve, deny));
      }),
    ),
  );
}

async function renderDocks() {
  const [{ docks, pending }, boxes] = await Promise.all([account.docks(), account.boxes()]);
  fill(app, 
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("h1", {}, "Docks"),
        h("div", { class: "muted" }, "Meeting points where your apps swap data. Each app only ever sees a pseudonym, parcels are sealed so only approved apps can open them, and customs runs at both ends."),
        h("div", { class: "small" }, "Most apps don't need one: an app gets its own box on your shelf when it connects or signs in. A dock is for two or more of your apps that should pass things to each other."),
      ),
    ),
    pendingCard(pending) || h("span"),
    h("div", { class: "grid wide" }, docks.filter((d) => d.name).map((d) => dockCard(d)), newDockCard(boxes)),
  );
}

function dockCard(d) {
  const berths = h(
    "ul",
    { class: "list" },
    d.berths.length === 0 ? h("li", { class: "muted small" }, "No apps yet. Apps that use this dock will ask to join.") : null,
    d.berths.map((b) => {
      const role = b.denied
        ? h("span", { class: "chip danger" }, "refused")
        : !b.send && !b.receive
          ? h("span", { class: "chip warn" }, `asking to ${direction(b.waiting)}`)
          : h("span", { class: "chip ok" }, b.send && b.receive ? "sends + receives" : b.send ? "sends" : "receives");
      const remove = h("button", { type: "button", class: "secondary tiny" }, "Remove");
      remove.addEventListener("click", () =>
        withBusy(remove, async () => {
          if (!confirm(`Take ${b.box} off ${d.name}? Its live connection closes immediately.`)) return;
          await account.dockRemove(d.name, b.box);
          render();
        }),
      );
      return h("li", { class: "row spread" }, h("div", { class: "stack" }, h("div", { class: "row" }, h("strong", { class: "mono" }, b.box), role), h("div", { class: "muted small mono" }, `known there as ${b.tag}`)), remove);
    }),
  );

  const peek = h("button", { type: "button", class: "secondary tiny" }, "Look inside");
  peek.addEventListener("click", () =>
    withBusy(peek, async () => {
      const parcels = await account.dockPeek(d.name);
      openModal(
        null,
        h("h2", {}, `In flight on ${d.name}`),
        h("p", { class: "muted small" }, "Opened here, with the dock key. Only you see real names; apps only ever see pseudonyms."),
        parcels.length === 0 ? h("p", {}, "Nothing in flight.") : null,
        parcels.map((p) =>
          h(
            "div",
            { class: "stack" },
            h("div", { class: "small" }, h("strong", {}, p.sender), p.to ? ` → ${p.to}` : " → everyone", h("span", { class: "muted" }, ` · ${ago(p.sentAt)}`)),
            h("pre", {}, JSON.stringify(p.body, null, 2)),
            p.redacted.length ? h("div", { class: "muted small" }, `Redacted: ${p.redacted.join(", ")}`) : null,
          ),
        ),
        h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Close")),
      );
    }),
  );

  return h(
    "section",
    { class: "card stack" },
    h("div", { class: "row spread" }, h("h2", { class: "mono" }, `⚓ ${d.name}`), peek),
    h("div", { class: "muted small" }, d.inFlight.count ? `${plural(d.inFlight.count, "parcel")} in flight (${bytes(d.inFlight.bytes)})` : "Nothing in flight"),
    berths,
    h("details", {}, h("summary", { class: "small" }, "Customs & settings"), dockSettings(d)),
  );
}

function dockSettings(d) {
  const s = d.settings;
  const personal = h(
    "select",
    {},
    h("option", { value: "redact", selected: s.personal === "redact" }, "Redact it (replace with a label)"),
    h("option", { value: "block", selected: s.personal === "block" }, "Refuse the parcel"),
    h("option", { value: "allow", selected: s.personal === "allow" }, "Let it through"),
  );
  const secrets = h("select", {}, h("option", { value: "block", selected: s.secrets === "block" }, "Refuse the parcel"), h("option", { value: "allow", selected: s.secrets === "allow" }, "Let it through (not recommended)"));
  const shape = h("textarea", { rows: 3, placeholder: '{"item": "string", "qty": "number?"}' });
  shape.value = s.shape ? JSON.stringify(s.shape) : "";
  const ttl = h("input", { value: `${Math.round(s.ttlMs / 86400000)}d` });
  const rate = h("input", { type: "number", min: 1, value: s.ratePerMinute });
  const status = h("div");
  const confirmName = h("input", { placeholder: d.name, "aria-label": "Type the dock name to confirm" });
  const shred = h("button", { type: "button", class: "danger tiny" }, "Shred dock");
  shred.addEventListener("click", () =>
    withBusy(shred, async () => {
      if (confirmName.value.trim() !== d.name) return status.replaceChildren(errorBox(new Error("Type the dock's name to confirm.")));
      await account.shredDock(d.name);
      render();
    }),
  );
  const form = h(
    "form",
    { class: "stack" },
    h("label", { class: "field" }, "Personal data (emails, phones, kennitölur, cards…)", personal),
    h("label", { class: "field" }, "Secrets (API keys, passwords, private keys)", secrets),
    h("label", { class: "field" }, "Manifest: only these fields may cross (optional)", shape),
    h("div", { class: "two" }, h("label", { class: "field" }, "Parcels expire after", ttl), h("label", { class: "field" }, "Max parcels per app per minute", rate)),
    h("p", { class: "muted small" }, "Customs runs inside each app (the server can't see into parcels): the sender's checks what leaves, the receiver's checks what arrives."),
    h("button", { type: "submit" }, "Save"),
    status,
    h("div", { class: "row" }, confirmName, shred),
  );
  onSubmit(form, status, async () => {
    await account.dockSettings(d.name, { personal: personal.value, secrets: secrets.value, shape: shape.value.trim() || null, ttl: ttl.value.trim(), ratePerMinute: Number(rate.value) });
    status.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
  });
  return form;
}

function newDockCard(boxes) {
  const name = nameField("Dock name", "e.g. Shopping list");
  const picks = boxes.map((b) => ({ box: b.name, send: h("input", { type: "checkbox" }), receive: h("input", { type: "checkbox" }) }));
  const status = h("div");
  const form = h(
    "form",
    { class: "card stack" },
    h("h2", {}, "New dock"),
    h("label", { class: "field" }, "Name", name.input),
    name.preview,
    picks.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "App"), h("th", {}, "Sends"), h("th", {}, "Receives"))),
            h("tbody", {}, picks.map((p) => h("tr", {}, h("td", { class: "mono" }, p.box), h("td", {}, p.send), h("td", {}, p.receive)))),
          ),
        )
      : h("p", { class: "muted small" }, "No apps yet."),
    h("p", { class: "muted small" }, "You can also skip this: apps that use a dock ask to join, and you approve them here."),
    h("button", { type: "submit" }, "Open dock"),
    status,
  );
  onSubmit(form, status, async () => {
    await account.createDock(name.value(), { send: picks.filter((p) => p.send.checked).map((p) => p.box), receive: picks.filter((p) => p.receive.checked).map((p) => p.box) });
    render();
  });
  return form;
}

// ── Apps ────────────────────────────────────────────────────────────────────

const SCOPE_LABEL = { openid: "knows you (private ID)", profile: "your name", email: "your email", box: "keeps data in your Cardboard", offline_access: "stays connected" };

async function renderApps() {
  const data = await account.apps();
  const boxesByName = new Map((await account.boxes()).map((b) => [b.name, b]));
  const connected = data.connected.map((a) => {
    const disconnect = h("button", { type: "button", class: "secondary tiny" }, "Disconnect");
    const shred = a.boxName ? h("button", { type: "button", class: "danger tiny" }, "Disconnect & shred its data") : null;
    disconnect.addEventListener("click", () =>
      withBusy(disconnect, async () => {
        if (!confirm(`Disconnect ${a.name}? It loses access right away.${a.boxName ? " Its box stays, in case you reconnect." : ""}`)) return;
        await account.disconnectApp(a.grant);
        render();
      }),
    );
    shred?.addEventListener("click", () =>
      withBusy(shred, async () => {
        if (!confirm(`Disconnect ${a.name} and shred everything it stored about you in “${a.boxName}”? This can't be undone.`)) return;
        await account.disconnectApp(a.grant, { shred: true });
        render();
      }),
    );
    return h(
      "li",
      { class: "stack" },
      h("div", { class: "row spread" }, h("div", {}, h("strong", {}, a.name), h("span", { class: "muted small" }, ` · ${a.site}`)), h("div", { class: "row" }, disconnect, shred)),
      h("div", { class: "row" }, a.scopes.filter((s) => SCOPE_LABEL[s]).map((s) => h("span", { class: "chip" }, SCOPE_LABEL[s])), a.selfRegistered ? h("span", { class: "chip warn" }, "registered itself") : null),
      h("div", { class: "muted small" }, `Connected ${ago(a.connectedAt)} · last used ${ago(a.lastUsedAt)}`),
      a.boxName ? keptBy(a) : null,
      h("div", { class: "muted small mono" }, `knows you as ${a.privateId}`),
    );
  });

  // What the app keeps about you: look at it, or take a copy.
  function keptBy(a) {
    const status = h("span", { class: "muted small" });
    const box = boxesByName.get(a.boxName);
    return h(
      "div",
      { class: "row" },
      h("a", { class: "button secondary tiny", href: `#/box/${encodeURIComponent(a.boxName)}` }, `See what ${a.name} keeps about you`),
      box ? exportButton(box, status, "Download it", "tiny") : null,
      status,
    );
  }

  const registered = data.registered.map((c) => {
    const forget = h("button", { type: "button", class: "secondary tiny" }, "Forget");
    forget.addEventListener("click", () =>
      withBusy(forget, async () => {
        await account.forgetApp(c.client);
        render();
      }),
    );
    return h("li", { class: "row spread" }, h("div", {}, h("strong", {}, c.name), h("div", { class: "muted small mono" }, c.redirectUris.join(", "))), forget);
  });

  fill(app, 
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Apps"), h("div", { class: "muted" }, "Apps you signed into with Cardboard. Each one knows you only by a private ID made for it, and keeps its data about you here, sealed, with you."))),
    h(
      "div",
      { class: "two" },
      h(
        "div",
        {},
        h("section", { class: "card" }, h("h2", {}, "Connected"), connected.length ? h("ul", { class: "list" }, connected) : h("p", { class: "muted" }, "No apps yet. When an app shows “Sign in with Cardboard”, this is where it lands.")),
        registered.length ? h("section", { class: "card" }, h("h2", {}, "Registered, not connected"), h("ul", { class: "list" }, registered)) : null,
      ),
      h("div", {}, inviteToAppsCard(data.mine), assistantCard(), connectCard(data.issuer)),
    ),
  );
}

/** For apps you made: an invite link that lands a friend in the app, making their account on the way. */
function inviteToAppsCard(mine) {
  if (!mine.length) return null;
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Invite a friend to your app"),
    h("p", { class: "muted small" }, "They open the link, tap sign in, make their Cardboard account on one screen, allow the app, and they're in."),
    h(
      "ul",
      { class: "list" },
      mine.map((m) => {
        const button = h("button", { type: "button", class: "secondary tiny" }, `Invite a friend to ${m.name}`);
        button.addEventListener("click", () =>
          withBusy(button, async () => {
            const result = await account.inviteToApp(m.home);
            openModal(
              null,
              h("h2", {}, `Invite a friend to ${m.name}`),
              h("p", {}, "Send this link privately, or let them scan the code. It works once, for one new account."),
              qrCode(result.link, `QR code of the invite to ${m.name}`),
              h("code", { class: "secret" }, result.link),
              sendButtons(result.link, `Join me on ${m.name}`),
              h("p", { class: "muted small" }, `The invite is the part after #, which browsers never send to a server. It works until ${new Date(result.expiresAt).toLocaleString()}. Your app needs to pass it on when it signs them in: see docs/APPS.md.`),
              h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Done")),
            );
          }),
        );
        return h("li", { class: "row spread" }, h("div", {}, h("strong", {}, m.name), h("div", { class: "muted small" }, m.home)), button);
      }),
    ),
  );
}

function assistantCard() {
  const cmd = "cardboard assistant add claude --see notes";
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Connect an AI assistant"),
    h(
      "p",
      { class: "small" },
      "Assistants (Claude Code, Claude Desktop, anything that speaks MCP) connect through Cardboard running on your own computer: it holds keys only for the boxes you share, so the assistant can open those and nothing else, and the server still sees nothing. On your computer, run:",
    ),
    h("div", { class: "row" }, h("code", { class: "secret" }, cmd), copyButton(cmd)),
    h("p", { class: "muted small" }, "It prints the line to paste into your assistant. It gets its own box to remember things for you, and every change it makes is logged and can be undone."),
  );
}

function connectCard(issuer) {
  const name = h("input", { placeholder: "My App", required: true });
  const redirect = h("input", { placeholder: "https://myapp.example.com/callback, http://localhost:5173/callback", required: true });
  const server = h("input", { type: "checkbox", checked: true });
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("label", { class: "field" }, "App name", name),
    h("label", { class: "field" }, "Callback URL", redirect),
    h("label", { class: "check" }, server, "It has a server (gets a client secret)"),
    h("div", {}, h("button", { type: "submit", class: "secondary" }, "Register app")),
    status,
  );
  onSubmit(form, status, async () => {
    const r = await account.registerApp({ name: name.value.trim(), redirectUris: redirect.value.split(/[\s,]+/).filter(Boolean), public: !server.checked });
    fill(
      status,
      h(
        "div",
        { class: "stack" },
        h("div", { class: "small" }, "client_id"),
        h("code", { class: "secret" }, r.client_id),
        r.client_secret ? [h("div", { class: "small" }, "client_secret (shown once)"), h("code", { class: "secret" }, r.client_secret), copyButton(r.client_secret, "Copy secret")] : null,
      ),
    );
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Add “Sign in with Cardboard” to an app"),
    h("p", { class: "small" }, "Cardboard speaks OpenID Connect, so any app with a “generic OpenID Connect” option can use it. Apps that use the Cardboard SDK can also get a box and your name, sealed so only they can open them. Issuer:"),
    h("div", { class: "row" }, h("code", { class: "secret" }, issuer), copyButton(issuer)),
    h("p", { class: "muted small" }, "Apps can register themselves automatically, or you can register one here:"),
    form,
  );
}

// ── Saying yes to an app (Sign in with Cardboard) ───────────────────────────

const PERMISSIONS = {
  openid: () => ["Recognise you when you come back", "With a private ID made only for this app, so it can't compare notes with other apps about you."],
  profile: (ctx) => ["See your name", ctx.sealed ? (ctx.profile.name ? `“${ctx.profile.name}”, sealed so only the app can read it` : "You haven't set one, so it gets nothing.") : "This app can't take sealed data. Tick below if you want to pass your name anyway."],
  email: (ctx) => ["See your email address", ctx.sealed ? (ctx.profile.email ? `${ctx.profile.email}, sealed so only the app can read it` : "You haven't set one, so it gets nothing.") : "This app can't take sealed data. Tick below if you want to pass your email anyway."],
  box: (ctx) => [
    "Keep its data about you in your Cardboard",
    `${ctx.boxName ? `In the box “${ctx.boxName}”.` : "In a box of its own."} Not in its own database. The box key goes to the app sealed, past the server. You can look inside, take it with you, or shred it whenever you like.`,
  ],
  offline_access: () => null,
};

async function renderConnect(id) {
  nav.hidden = false;
  let req;
  try {
    req = await account.signInRequest(id);
  } catch (err) {
    fill(app, h("section", { class: "card stack login" }, h("h1", {}, "Can't continue"), errorBox(err), h("a", { href: "#/" }, "Go to your shelf")));
    return;
  }
  const { profile } = await account.me();
  const appKey = pendingConnect?.appKey ?? null;
  const go = (url) => {
    pendingConnect = null;
    location.assign(url);
  };
  const returning = req.returning && req.scopes.every((s) => req.returning.scopes.includes(s));
  if (returning && req.prompt !== "consent") {
    // Already said yes to all of this: straight back to the app. It remembers you.
    fill(app, h("section", { class: "card stack login" }, h("h1", {}, `Signing you in to ${req.client.name}…`), h("p", { class: "muted" }, "You said yes to this app before.")));
    go(await account.approveSignIn(id, { appKey }));
    return;
  }
  if (req.prompt === "none") return go(await account.denySignIn(id));
  const sealed = Boolean(req.appKey);
  const ctx = { profile, boxName: req.boxName, sealed };
  const perms = req.scopes
    .map((s) => PERMISSIONS[s]?.(ctx))
    .filter(Boolean)
    .map(([title, detail]) => h("li", {}, h("strong", {}, title), h("div", { class: "muted small" }, detail)));
  const passName = h("input", { type: "checkbox" });
  const plainShare =
    !sealed && (req.scopes.includes("profile") || req.scopes.includes("email"))
      ? h(
          "label",
          { class: "check small" },
          passName,
          "Pass my name/email to this app in the clear. It goes through Cardboard's server, which could see it on the way.",
        )
      : null;
  const destination = (() => {
    try {
      return new URL(req.site).host || req.site;
    } catch {
      return req.site;
    }
  })();
  // An app can keep its data in a box of yours, or one someone shared with you, so you both use the same
  // data (read-only if it was shared with you that way). Never offered: your personal box.
  const personalId = (await account.personalBox())?.id;
  const choices = req.scopes.includes("box") ? (await account.boxes()).filter((b) => b.id !== personalId && b.id !== req.box) : [];
  const current = req.box ? (await account.boxById(req.box)) : null;
  const label = (b) => (b.shared ? `${b.name}, shared with you by ${b.shared.from}${b.shared.write ? "" : " (it can read, not change)"}` : `${b.name} (yours)`);
  const where = choices.length
    ? h(
        "select",
        { "aria-label": "Where it keeps its data" },
        h("option", { value: current?.id ?? "" }, current ? `${label(current)}, as last time` : "a new box of its own"),
        choices.some((b) => !b.shared) ? h("optgroup", { label: "Your boxes" }, choices.filter((b) => !b.shared).map((b) => h("option", { value: b.id }, label(b)))) : null,
        choices.some((b) => b.shared) ? h("optgroup", { label: "Shared with you" }, choices.filter((b) => b.shared).map((b) => h("option", { value: b.id }, label(b)))) : null,
      )
    : null;
  const readOnlyNote = h("p", { class: "small muted", hidden: true }, "It can read what's in that box, but not change it, because it was shared with you read-only.");
  where?.addEventListener("change", () => (readOnlyNote.hidden = !choices.find((b) => b.id === where.value)?.shared || choices.find((b) => b.id === where.value).shared.write));
  const status = h("div");
  const allow = h("button", { type: "button" }, "Let it in");
  const deny = h("button", { type: "button", class: "secondary" }, "No thanks");
  allow.addEventListener("click", () =>
    withBusy(allow, async () => {
      try {
        const claims = passName.checked ? { ...(req.scopes.includes("profile") && profile.name ? { name: profile.name } : {}), ...(req.scopes.includes("email") && profile.email ? { email: profile.email } : {}) } : undefined;
        go(await account.approveSignIn(id, { claims, appKey, box: where?.value || undefined }));
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  deny.addEventListener("click", () => withBusy(deny, async () => go(await account.denySignIn(id))));
  fill(app, 
    h(
      "section",
      { class: "card stack login" },
      h("h1", {}, "Let ", h("span", { class: "mono" }, req.client.name), " in?"),
      h("p", { class: "muted" }, "It's asking to:"),
      h("ul", { class: "list perms" }, perms),
      where ? h("label", { class: "field" }, "Keep its data in", where) : null,
      readOnlyNote,
      plainShare,
      h("p", { class: "small" }, "It stays connected until you disconnect it on your Apps page, or until it goes unused for 30 days."),
      req.client.selfRegistered
        ? h("div", { class: "insight warn" }, h("div", { class: "title" }, "This app registered itself"), h("div", { class: "detail" }, `Only continue if you just clicked “Sign in with Cardboard” on ${destination}.`))
        : null,
      h("p", { class: "small muted" }, "After you choose, you'll go back to ", h("strong", {}, destination), "."),
      h("div", { class: "row" }, allow, deny),
      status,
    ),
  );
}

// ── Activity, Security, You ─────────────────────────────────────────────────

/** Names for the personal box's (and friend boxes') things, for the log and search: "Gate code", not notes/0mv…. */
async function itemTitles() {
  const me = await account.me();
  const ids = new Set([me.profile.personal, ...Object.keys(me.profile.friends ?? {})].filter(Boolean));
  const titles = new Map();
  await Promise.all(
    (await account.boxes())
      .filter((b) => ids.has(b.id) && !b.shared)
      .map(async (b) => {
        const { things } = await listThings(await account.open(b));
        for (const t of things) titles.set(`${b.name}\n${t.key}`, t.value.title);
      }),
  ).catch(() => {});
  return (box, key) => {
    const part = /^file-data\/([^/]+)\//.exec(key);
    return titles.get(`${box}\n${part ? `files/${part[1]}` : key}`) ?? null;
  };
}

async function renderActivity() {
  const [boxes, title] = await Promise.all([account.boxes(), itemTitles()]);
  const select = h("select", { "aria-label": "Box" }, h("option", { value: "" }, "All boxes"), boxes.map((b) => h("option", { value: b.name }, b.name)));
  const list = h("div");
  const more = h("button", { type: "button", class: "secondary" }, "Load older");
  let before;
  async function load(reset) {
    if (reset) {
      before = undefined;
      list.replaceChildren();
    }
    const entries = await account.log({ box: select.value || undefined, limit: 100, before, title });
    list.append(logLines(entries));
    before = entries.length ? entries[entries.length - 1].id : before;
    more.hidden = entries.length < 100;
  }
  select.addEventListener("change", () => load(true));
  more.addEventListener("click", () => withBusy(more, () => load(false)));
  fill(app, 
    h("div", { class: "page-head" }, h("h1", {}, "Activity"), select),
    h("section", { class: "card" }, h("p", { class: "muted small" }, "Who touched what, newest first. On the server, every name in here is sealed: it's opened here, in your browser."), list, more),
  );
  await load(true);
}

/** How backups are doing, in words, and whether it's fine. */
function backupWords(backup) {
  if (!backup) return { ok: false, words: "Not backed up: everything is on one disk of one computer" };
  if (!backup.at) return { ok: false, words: "Backups are on, but none has been made yet" };
  if (Date.now() - backup.at > backup.every * 2 + 60 * 60_000) return { ok: false, words: `The last backup was ${ago(backup.at)}` };
  if (backup.failing) return { ok: false, words: `Backed up ${ago(backup.at)}, but ${plural(backup.failing, "place")} missed it` };
  return { ok: true, words: `Backed up ${ago(backup.at)}${backup.places > 1 ? `, in ${backup.places} places` : " (on this computer only)"}` };
}

function backupChip(backup) {
  const { ok, words } = backupWords(backup);
  return h("a", { href: "#/security", class: `chip ${ok && backup.places > 1 ? "ok" : "warn"}` }, `${ok ? "✓" : "!"} ${words}`);
}

async function renderSecurity() {
  const info = await hello();
  const report = info.shake;
  const backup = (await account.me()).server.backup;
  const said = backupWords(backup);
  const backupCard = h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Backups"),
    h("p", {}, h("span", { class: `chip ${said.ok && backup.places > 1 ? "ok" : "warn"}` }, said.words)),
    h("p", { class: "small" }, "Everything here lives on the computer Cardboard runs on. If that computer breaks or is lost, a backup somewhere else is what brings it back: your recovery kit only brings back your keys, not what you kept."),
    backup && backup.places > 1
      ? h("p", { class: "muted small" }, `A copy is made every ${describeDuration(backup.every)} and also kept somewhere else. It's sealed like everything here, so that place doesn't need to be trusted.`)
      : h(
          "div",
          { class: "stack small" },
          h("strong", {}, "To keep a copy somewhere else"),
          h("p", {}, "On the computer Cardboard runs on, plug in another drive (a USB stick or SSD), then double-click ", h("strong", {}, "Cardboard"), " on the desktop: it asks where to keep the copies. Everything is sealed, so any drive will do."),
          h("p", { class: "muted" }, "Running it another way: start it with ", h("code", {}, "--backup-to <folder>"), "."),
        ),
  );
  fill(app, 
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Security"), h("div", { class: "muted" }, "What keeps your data yours, and how this server tested itself."))),
    backupCard,
    h(
      "div",
      { class: "two" },
      h(
        "section",
        { class: "card stack" },
        h("h2", {}, "End to end"),
        h(
          "ul",
          { class: "list small" },
          h("li", {}, h("strong", {}, "Your keys live on your devices. "), "Everything you and your apps store is sealed (AES-256-GCM) before it leaves the device. The server keeps only sealed bytes."),
          h("li", {}, h("strong", {}, "Names too. "), "Box names, item keys, dock names, tape labels, your profile: all sealed. Lookups use keyed fingerprints the server can't reverse."),
          h("li", {}, h("strong", {}, "The host is locked out. "), "Whoever runs this server can see that accounts exist, how much they store and when they're used. Not what's inside."),
          h("li", {}, h("strong", {}, "Apps get only their box. "), "A tape carries one box's key; Sign in with Cardboard seals the key to the app itself, past the server."),
          h("li", {}, h("strong", {}, "The honest catch: "), "this page's code comes from the server. A server that turned bad could serve a page that steals keys next time you open it. The CLI doesn't have that problem, because its code is installed on your computer."),
        ),
      ),
      h(
        "section",
        { class: "card stack" },
        h("h2", {}, "The server's self-test"),
        report
          ? [
              h("p", {}, h("span", { class: `chip ${report.ok ? "ok" : "danger"}` }, `${report.ok ? "✓" : "✗"} ${report.summary}`), h("span", { class: "muted small" }, ` · ${ago(report.at)}`)),
              h(
                "ul",
                { class: "list" },
                report.results.map((r) =>
                  h("li", { class: "shake-result" }, h("span", { class: `mark ${r.status}` }, r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!"), h("div", {}, h("strong", {}, r.title), h("div", { class: "muted small" }, r.detail))),
                ),
              ),
            ]
          : h("p", { class: "muted" }, "This server hasn't run its shake test yet."),
      ),
    ),
  );
}

const PLANS = [
  { id: "kit", title: "Recovery kit", badge: "standard", detail: "A code you print or keep in a password manager. Lose every device, type the code, you're back." },
  { id: "device", title: "Another device", detail: "No code: you get back in by approving a new device from one you still have. Keep at least two signed in." },
  { id: "friends", title: "Trusted friends", detail: "Your key is split into pieces for friends. Any 2 of 3 (you choose) get you back in. One piece alone reveals nothing." },
  { id: "none", title: "No recovery", detail: "Only your signed-in devices can open your Cardboard. Lose them all and the data is gone, for everyone. Maximum privacy, no safety net." },
];

async function renderYou() {
  const me = await account.me();
  const devices = me.devices.map((d) => {
    const remove = h("button", { type: "button", class: "secondary tiny" }, d.current ? "Sign out here" : "Remove");
    remove.addEventListener("click", () =>
      withBusy(remove, async () => {
        if (d.current) return signOutHere();
        if (!confirm(`Remove “${d.name}”? It's signed out for good and its copy of your account key is deleted.`)) return;
        await account.removeDevice(d.id);
        render();
      }),
    );
    const rename = h("button", { type: "button", class: "secondary tiny" }, "Rename");
    rename.addEventListener("click", () =>
      withBusy(rename, async () => {
        const name = prompt("What should this device be called?", d.name);
        if (!name) return;
        await account.renameDevice(d.id, name.trim().slice(0, 60));
        render();
      }),
    );
    return h(
      "li",
      { class: "row spread" },
      h("div", {}, h("strong", {}, d.name), d.current ? h("span", { class: "chip ok" }, "this browser") : null, d.lock ? h("span", { class: "chip" }, "Face ID") : null, h("div", { class: "muted small" }, `${d.kind} · last seen ${ago(d.lastSeenAt)} · added ${ago(d.createdAt)}`)),
      h("div", { class: "row" }, rename, remove),
    );
  });

  const code = h("input", { placeholder: "XXXXX-XXXXX-XXXXX", required: true, autocomplete: "off", spellcheck: "false" });
  const deviceName = h("input", { placeholder: "e.g. Phone" });
  const addStatus = h("div");
  const add = h(
    "form",
    { class: "stack" },
    h("p", { class: "small" }, "On the new device, open this Cardboard and choose “Or use a pairing code” (or run ", h("code", {}, `cardboard pair ${ORIGIN}`), "). Type the code it shows:"),
    h("div", { class: "two" }, h("label", { class: "field" }, "Pairing code", code), h("label", { class: "field" }, "Call it", deviceName)),
    h("button", { type: "submit" }, "Approve this device"),
    addStatus,
  );
  onSubmit(add, addStatus, async () => {
    await account.approveDevice(code.value, deviceName.value.trim() || undefined);
    addStatus.replaceChildren(h("span", { class: "chip ok" }, "Approved. It's signing in now."));
    setTimeout(render, 2500);
  });

  const choice = PLANS.map((p) => ({ ...p, input: h("input", { type: "radio", name: "plan", value: p.id, checked: me.recovery === p.id }) }));
  const friendsCount = h("select", {}, [2, 3, 4, 5].map((n) => h("option", { value: n, selected: n === 3 }, `${n} friends`)));
  const friendsNeed = h("select", {}, [2, 3, 4].map((n) => h("option", { value: n, selected: n === 2 }, `any ${n} of them`)));
  const recStatus = h("div");
  // Your plan picked again means new codes (a lost kit), which retires the old ones: say so on the button.
  const usePlan = h("button", { type: "submit" }, "Use this plan");
  const planButton = () => {
    const same = choice.find((c) => c.input.checked)?.id === me.recovery && me.recoveryReady;
    usePlan.textContent = same ? "Make new codes (the old ones stop working)" : "Use this plan";
    usePlan.className = same ? "secondary" : "";
  };
  for (const c of choice) c.input.addEventListener("change", planButton);
  planButton();
  const recovery = h(
    "form",
    { class: "stack" },
    choice.map((c) =>
      h("label", { class: `plan ${me.recovery === c.id ? "current" : ""}` }, c.input, h("div", {}, h("strong", {}, c.title), c.badge ? h("span", { class: "chip ok" }, c.badge) : null, me.recovery === c.id ? h("span", { class: "chip" }, "your plan") : null, h("div", { class: "muted small" }, c.detail))),
    ),
    h("div", { class: "row small" }, "For trusted friends:", friendsCount, friendsNeed),
    usePlan,
    recStatus,
  );
  onSubmit(recovery, recStatus, async () => {
    const plan = choice.find((c) => c.input.checked)?.id;
    if (!plan) return;
    if (plan === "none" && !confirm("With no recovery, losing your devices means losing your data. Nobody can help, not even whoever runs Cardboard. Continue?")) return;
    const result = await account.setRecovery(plan, { count: Number(friendsCount.value), threshold: Number(friendsNeed.value) });
    if (result.kit || result.pieces) showRecovery(result, render);
    else render();
  });

  const name = h("input", { value: me.profile.name || "", placeholder: "How apps may greet you" });
  const email = h("input", { type: "email", value: me.profile.email || "", placeholder: "you@example.com" });
  const profileStatus = h("div");
  const profile = h(
    "form",
    { class: "stack" },
    h("p", { class: "muted small" }, "Sealed on your devices. Apps only get these if they ask and you say yes, sealed to the app."),
    h("label", { class: "field" }, "Name", name),
    h("label", { class: "field" }, "Email", email),
    h("button", { type: "submit" }, "Save"),
    profileStatus,
  );
  onSubmit(profile, profileStatus, async () => {
    await account.setProfile({ name: name.value.trim() || null, email: email.value.trim() || null });
    profileStatus.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
  });

  const confirmDelete = h("input", { placeholder: "delete" });
  const deleteBtn = h("button", { type: "button", class: "danger" }, "Delete my account");
  const deleteStatus = h("div");
  deleteBtn.addEventListener("click", () =>
    withBusy(deleteBtn, async () => {
      if (confirmDelete.value.trim() !== "delete") return deleteStatus.replaceChildren(errorBox(new Error('Type "delete" to confirm.')));
      await account.deleteAccount();
      account = null;
      location.hash = "#/";
      render();
    }),
  );

  fill(app, 
    h("div", { class: "page-head" }, h("h1", {}, "You")),
    emergencyAlerts(me),
    h(
      "div",
      { class: "two" },
      h(
        "div",
        {},
        h(
          "section",
          { class: "card stack" },
          h("h2", {}, "Devices"),
          h("ul", { class: "list" }, devices),
          h("div", { class: "row" }, h("button", { type: "button", onclick: addDevice }, "Add a device")),
          h("details", {}, h("summary", {}, "Or type a pairing code from the new device"), add),
        ),
        await lockCard(),
        h("section", { class: "card stack" }, h("h2", {}, "Your name and email"), profile),
      ),
      h(
        "div",
        {},
        h("section", { class: "card stack" }, h("h2", {}, "If you lose every device"), h("p", { class: "small" }, "Pick how you'd get back in. Cardboard can't reset anything for you: that's what keeps everyone else out."), recovery),
        privacyCard(me),
        builderCard(),
        await emergencyCard(),
        await inviteCard(me),
        h("section", { class: "card stack danger-zone" }, h("h2", {}, "Delete account"), h("p", { class: "small" }, "Everything goes: boxes, history, tapes, docks, connected apps, devices."), h("label", { class: "field" }, "Type delete to confirm", confirmDelete), h("div", { class: "row" }, deleteBtn), deleteStatus),
      ),
    ),
  );
}

/** You → For app builders: docks, apps and boxes for your own apps, shown or not (on this device). */
function builderCard() {
  const on = h("input", { type: "checkbox", checked: builderOn() });
  on.addEventListener("change", () => {
    try {
      localStorage.setItem("cardboard-builder", on.checked ? "on" : "off");
    } catch {
      // Private browsing: it lasts until the page reloads.
      builderAuto = on.checked;
    }
    showBuilder();
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "For app builders"),
    h("label", { class: "choice small" }, on, h("span", {}, "Show Docks, Apps and “New box” (for connecting apps you make or run yourself)")),
  );
}

/** You → Privacy: whether photos and videos keep where they were taken. */
function privacyCard(me) {
  const strip = h("input", { type: "checkbox", checked: !me.profile.keepLocation });
  const status = h("span", { class: "muted small" });
  strip.addEventListener("change", async () => {
    strip.disabled = true;
    try {
      await account.setKeepLocation(!strip.checked);
      status.textContent = strip.checked ? "On." : "Off: photos and videos keep where they were taken.";
    } catch (err) {
      status.replaceChildren(errorBox(err));
      strip.checked = !strip.checked;
    } finally {
      strip.disabled = false;
    }
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Privacy"),
    h("label", { class: "choice small" }, strip, h("span", {}, "Take where photos and videos were taken out of them, on this device, before they're sealed")),
    h("p", { class: "muted small" }, "Phones write the place (GPS) into every photo and video. This takes only that out: the picture, the date and which way up it is stay. Files that friends add to your friend boxes always lose it."),
    status,
  );
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * An app sent you here to sign in: /?connect=<request>#cardboard_key=<the app's key>. The key in
 * the fragment never reached the server, so it's what the request's key gets checked against.
 */
function takeConnectFromUrl() {
  const fromQuery = new URLSearchParams(location.search).get("connect");
  if (fromQuery) {
    // An app can bring an invite along (a friend who has no account yet): it stays in memory only.
    pendingConnect = { id: fromQuery, appKey: hashParam("cardboard_key"), appName: null, invite: hashParam("invite") };
    history.replaceState(null, "", `/#connect=${encodeURIComponent(fromQuery)}`);
    return;
  }
  const fromHash = hashParam("connect");
  if (fromHash && pendingConnect?.id !== fromHash) pendingConnect = { id: fromHash, appKey: null, appName: null };
}

/** A share link: #share=<code>. The code is taken out of the address bar (and this history entry) straight away. */
function takeShareFromUrl() {
  const code = hashParam("share");
  if (!code) return;
  pendingShare = code;
  history.replaceState(null, "", "#/join");
}

/** Emergency access (#emergency=<code>) and pairing (#pair=<code>) links, the same way. */
function takeFriendFromUrl() {
  const secret = hashParam("friend");
  if (secret) {
    // A collection box's link also carries its title and who it's for (it can't read them from the box).
    pendingFriend = JSON.stringify({ secret, title: hashParam("title"), from: hashParam("from") });
    try {
      sessionStorage.setItem("cardboard-friend", pendingFriend);
    } catch {
      // A private window may not keep it: then a reload needs the link again.
    }
    // Out of the address bar (and history), like invite and pairing codes.
    history.replaceState(null, "", "#/friend");
  } else if (location.hash.startsWith("#/friend")) {
    try {
      pendingFriend ??= sessionStorage.getItem("cardboard-friend");
    } catch {
      pendingFriend = null;
    }
  } else pendingFriend = null;
}

function takeEmergencyAndPairFromUrl() {
  const emergency = hashParam("emergency");
  if (emergency) {
    pendingEmergency = emergency;
    history.replaceState(null, "", "#/emergency");
  }
  const pair = hashParam("pair");
  if (pair) {
    pendingPair = pair;
    history.replaceState(null, "", "#/pair");
  }
}

async function render() {
  const gen = ++renderGen;
  for (const watch of pageWatches) watch.close();
  pageWatches.clear();
  closeModal(false);
  takeConnectFromUrl();
  takeShareFromUrl();
  takeEmergencyAndPairFromUrl();
  takeFriendFromUrl();
  // Someone else's emergency link: it's about their Cardboard, whoever is signed in here.
  if (pendingEmergency) return renderEmergency(pendingEmergency);
  // A friend box's link: just that box, for anyone holding it, signed in here or not.
  if (pendingFriend) return renderFriendView(pendingFriend);
  if (!account) {
    if (await deviceLock(browserStore)) return renderLocked();
    try {
      account = await unlock(browserStore);
    } catch (err) {
      if (err.code === "bad_device") await browserStore.clear();
      else {
        fill(app, errorBox(err));
        return;
      }
    }
  }
  lockButton.hidden = !account?.lock;
  if (!account) return renderWelcome(await hello().catch(() => null));
  if (pendingConnect) {
    const id = pendingConnect.id;
    if (!location.hash.startsWith("#connect=")) history.replaceState(null, "", `#connect=${id}`);
    return renderConnect(id);
  }
  if (pendingShare) return renderJoin(pendingShare);
  if (pendingPair) return renderApprovePair(pendingPair);
  nav.hidden = false;
  showBuilder();
  shelfWatch?.close();
  shelfWatch = null;
  const [, rawPage, arg, key] = location.hash.split("/");
  const page = rawPage?.split("?")[0];
  for (const a of nav.querySelectorAll("a")) a.classList.toggle("active", a.getAttribute("href") === `#/${page && page !== "box" ? page : ""}`);
  try {
    if (page === "box" && arg) await renderBox(decodeURIComponent(arg), key ? decodeURIComponent(key) : undefined);
    else if (page === "activity") await renderActivity();
    else if (page === "docks") await renderDocks();
    else if (page === "apps") await renderApps();
    else if (page === "security") await renderSecurity();
    else if (page === "you") await renderYou();
    else if (page === "send") await renderSend();
    else if (page === "convert") await renderConvert();
    else await renderShelf();
    if (gen === renderGen) renderedGen = gen;
    // Left before it finished, and it finished after the page you went to: draw that one again (this one drew over it).
    else if (renderedGen === renderGen) return render();
  } catch (err) {
    if (err.code === "bad_device") {
      await browserStore.clear();
      account = null;
      return render();
    }
    fill(app, errorBox(err), h("p", {}, h("a", { href: "#/" }, "Back to the shelf")));
  }
}

// The helper also receives what other apps share to Cardboard, so it starts with the dashboard.
startMediaHelper();

// Chrome (Android, Windows, Mac) offers to install Cardboard as an app; on Android that's a real app in
// the app drawer and the Share menu. Offer it on the shelf until it's installed.
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelector(".install-card")?.removeAttribute("hidden");
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  document.querySelector(".install-card")?.remove();
});

window.addEventListener("hashchange", () => {
  if (!hashParam("connect")) pendingConnect = null;
  if (location.hash !== "#/join" && !hashParam("share")) pendingShare = null;
  if (location.hash !== "#/emergency" && !hashParam("emergency")) pendingEmergency = null;
  if (location.hash !== "#/pair" && !hashParam("pair")) pendingPair = null;
  render();
});
render();
