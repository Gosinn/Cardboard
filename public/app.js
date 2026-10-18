// Cardboard dashboard. No framework, no build step. Your keys live in this
// browser, so everything is opened right here: the server only ever sends
// sealed bytes. Anything that came from an app (key names, values, labels) is
// inserted with textContent, never as HTML.
import { claimEmergency, cleanInvite, deviceLock, recoverWithFriends, recoverWithKit, requestEmergency, signUp, startPairing, unlock, viewEmergency } from "/lib/client/account.ts";
import { qrEncode, qrPath } from "/lib/shared/qr.ts";
import { describeDuration } from "/lib/shared/duration.ts";
import { createPasskey, hasBuiltInPasskeys, passkeyBlocker, passkeySecret } from "/lib/client/passkey.ts";
import { Rpc } from "/lib/client/rpc.ts";
import { browserName, browserStore, makeKey } from "/device.js";

const app = document.getElementById("app");
// Everything imported fine: tell boot.js the dashboard is running.
app.dataset.started = "1";
const nav = document.getElementById("nav");
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

function fixLine(fix) {
  return fix ? h("div", { class: "fix" }, h("code", {}, fix), copyButton(fix)) : null;
}

function insightCard(i) {
  return h("div", { class: `insight ${i.level}` }, h("div", { class: "title" }, i.title), h("div", { class: "detail" }, i.detail), fixLine(i.fix));
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
  modal.replaceChildren();
  const hook = onModalClose;
  onModalClose = null;
  if (notify && hook) hook();
}

modal.addEventListener("click", (e) => {
  if (e.target === modal && !modal.dataset.sticky) closeModal();
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
  delete modal.dataset.sticky;
  closeModal(false);
  render();
}
lockButton.addEventListener("click", lockNow);

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

function renderWelcome(info) {
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
    invite: inviteForm(invite),
    pair: pairPane(),
    kit: kitForm(),
    friends: friendsForm(),
  };
  const body = h("div", { class: "stack" });
  const tab = (id, label) => {
    const b = h("button", { type: "button", class: "secondary tiny" }, label);
    b.addEventListener("click", () => {
      for (const other of tabs.children) other.classList.remove("active");
      b.classList.add("active");
      fill(body, panes[id]);
    });
    return b;
  };
  const tabs = h(
    "div",
    { class: "row tabs" },
    tab("invite", invite ? "Make my account" : "I have an invite"),
    tab("pair", "Use a device I have"),
    tab("kit", "Recovery kit"),
    tab("friends", "Friends' pieces"),
  );
  (invite ? tabs.children[0] : tabs.children[1]).click();
  fill(app, 
    h(
      "section",
      { class: "card stack login" },
      h("div", { class: "row" }, logo, h("h1", {}, invite ? "Welcome to Cardboard" : "Open your Cardboard")),
      intro,
      remembers,
      tabs,
      body,
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
    h("label", { class: "field" }, "Invite link or code", code),
    h("label", { class: "field" }, "What to call this browser", name),
    h("button", { type: "submit" }, "Make my account"),
    status,
  );
  onSubmit(form, status, async () => {
    const { account: opened, kit } = await signUp({ ...getInOptions(name.value.trim()), invite: cleanInvite(code.value) });
    account = opened;
    history.replaceState(null, "", pendingConnect ? `#connect=${pendingConnect.id}` : "#/");
    showRecovery({ kit }, render);
  });
  return form;
}

function pairPane() {
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
            h("p", { class: "small" }, "It's under ", h("strong", {}, "You → Devices → Add a device"), ". Or run:"),
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
  const searchInput = h("input", { type: "search", placeholder: "Find anything in any box…", "aria-label": "Search every box" });
  const results = h("div");
  const search = h("form", { class: "search" }, searchInput, h("button", { type: "submit", class: "secondary" }, "Search"));
  onSubmit(search, results, async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) return results.replaceChildren();
    const found = await account.search(q);
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
              h("a", { href: `#/box/${encodeURIComponent(r.box)}/${encodeURIComponent(r.key)}` }, h("strong", {}, r.box), " · ", h("span", { class: "mono" }, r.key)),
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
  const cards = boxes.map((b) => {
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
      h("div", {}, h("h1", {}, me.profile.name ? `${me.profile.name}'s shelf` : "Your shelf"), h("div", { class: "muted" }, `${plural(boxes.length, "box").replace("boxs", "boxes")} · ${bytes(me.quota.used)} of ${bytes(me.quota.limit)}`)),
      shakeChip,
    ),
    emergencyAlerts(me),
    search,
    results,
    pendingCard(docks.pending),
    insightsBox,
    h("div", { class: "grid" }, cards, newBoxCard()),
  );

  const insights = (await account.insights({ boxes, me, docks })).filter((i) => !(i.fix || "").startsWith("cardboard dock approve"));
  fill(
    insightsBox,
    insights.length ? [h("h2", {}, "Worth a look"), insights.map(insightCard)] : [h("h2", {}, "All good"), h("p", { class: "muted" }, "Nothing needs fixing right now.")],
  );
}

function peopleChip(b) {
  if (b.shared) return h("div", { class: "row" }, h("span", { class: "chip" }, `Shared by ${b.shared.from}${b.shared.write ? "" : " · read only"}`));
  if (b.people.members.length) return h("div", { class: "row" }, h("span", { class: "chip" }, `Shared with ${b.people.members.map((m) => m.name).join(", ")}`));
  return null;
}

function newBoxCard() {
  const name = h("input", { placeholder: "recipe-app", pattern: "[a-z0-9][a-z0-9\\-]*", required: true, "aria-label": "Box name" });
  const status = h("div");
  const form = h(
    "form",
    { class: "boxcard new stack" },
    h("h3", {}, "New box"),
    h("div", { class: "muted small" }, "One box per app. Lowercase letters, numbers and dashes."),
    name,
    h("button", { type: "submit" }, "Make box + tape"),
    status,
  );
  onSubmit(form, status, async () => {
    const box = await account.createBox(name.value.trim());
    const { secret } = await account.createTape(box.name, { label: "dashboard" });
    showSecret(`${box.name} is ready`, secret, box.name, null, render);
  });
  return form;
}

// ── One box ─────────────────────────────────────────────────────────────────

async function renderBox(name, openKey) {
  const box = await account.box(name);
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
      all ??= await box.list();
      const items = all.filter((it) => it.key.startsWith(prefix.value));
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
        item ? h("pre", {}, JSON.stringify(item.value, null, 2)) : null,
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

function dangerZone(box) {
  const exportBtn = h("button", { type: "button", class: "secondary" }, "Export as JSON");
  exportBtn.addEventListener("click", () =>
    withBusy(exportBtn, async () => {
      const data = await account.exportBox(box.name);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = h("a", { href: url, download: `${box.name}-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
  );
  if (box.shared) {
    return h(
      "section",
      { class: "card stack danger-zone" },
      h("h2", {}, "Moving day"),
      h("div", { class: "row" }, exportBtn, h("span", { class: "muted small" }, "Everything, opened, in plain JSON. Keep the file somewhere private.")),
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
    h("div", { class: "row" }, exportBtn, h("span", { class: "muted small" }, "Everything, opened, in plain JSON. Keep the file somewhere private.")),
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
      h("div", {}, h("h1", {}, "Docks"), h("div", { class: "muted" }, "Meeting points where your apps swap data. Each app only ever sees a pseudonym, parcels are sealed so only approved apps can open them, and customs runs at both ends.")),
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
  const name = h("input", { placeholder: "shopping-list", pattern: "[a-z0-9][a-z0-9\\-]*", required: true, "aria-label": "Dock name" });
  const picks = boxes.map((b) => ({ box: b.name, send: h("input", { type: "checkbox" }), receive: h("input", { type: "checkbox" }) }));
  const status = h("div");
  const form = h(
    "form",
    { class: "card stack" },
    h("h2", {}, "New dock"),
    h("label", { class: "field" }, "Name", name),
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
    await account.createDock(name.value.trim(), { send: picks.filter((p) => p.send.checked).map((p) => p.box), receive: picks.filter((p) => p.receive.checked).map((p) => p.box) });
    render();
  });
  return form;
}

// ── Apps ────────────────────────────────────────────────────────────────────

const SCOPE_LABEL = { openid: "knows you (private ID)", profile: "your name", email: "your email", box: "keeps data in your Cardboard", offline_access: "stays connected" };

async function renderApps() {
  const data = await account.apps();
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
      h("div", { class: "muted small" }, `Connected ${ago(a.connectedAt)} · last used ${ago(a.lastUsedAt)}`, a.boxName ? [" · data in ", h("a", { href: `#/box/${encodeURIComponent(a.boxName)}` }, a.boxName)] : null),
      h("div", { class: "muted small mono" }, `knows you as ${a.privateId}`),
    );
  });

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
      h("div", {}, assistantCard(), connectCard(data.issuer)),
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
  // An app can keep its data in a box someone shared with you, so you both use the same data.
  const sharedBoxes = req.scopes.includes("box") ? (await account.boxes()).filter((b) => b.shared?.write) : [];
  const where = sharedBoxes.length
    ? h(
        "select",
        { "aria-label": "Where it keeps its data" },
        h("option", { value: "" }, req.boxName ? `its own box (${req.boxName})` : "a new box of its own"),
        sharedBoxes.map((b) => h("option", { value: b.id, selected: b.id === req.box }, `${b.name}, shared with you by ${b.shared.from}`)),
      )
    : null;
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

async function renderActivity() {
  const boxes = await account.boxes();
  const select = h("select", { "aria-label": "Box" }, h("option", { value: "" }, "All boxes"), boxes.map((b) => h("option", { value: b.name }, b.name)));
  const list = h("div");
  const more = h("button", { type: "button", class: "secondary" }, "Load older");
  let before;
  async function load(reset) {
    if (reset) {
      before = undefined;
      list.replaceChildren();
    }
    const entries = await account.log({ box: select.value || undefined, limit: 100, before });
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

async function renderSecurity() {
  const info = await hello();
  const report = info.shake;
  fill(app, 
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Security"), h("div", { class: "muted" }, "What keeps your data yours, and how this server tested itself."))),
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
    h("p", { class: "small" }, "On the new device, open this Cardboard (or run ", h("code", {}, `cardboard pair ${ORIGIN}`), ") and choose “Use a device I have”. Type the code it shows:"),
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
  const recovery = h(
    "form",
    { class: "stack" },
    choice.map((c) =>
      h("label", { class: `plan ${me.recovery === c.id ? "current" : ""}` }, c.input, h("div", {}, h("strong", {}, c.title), c.badge ? h("span", { class: "chip ok" }, c.badge) : null, me.recovery === c.id ? h("span", { class: "chip" }, "your plan") : null, h("div", { class: "muted small" }, c.detail))),
    ),
    h("div", { class: "row small" }, "For trusted friends:", friendsCount, friendsNeed),
    h("button", { type: "submit" }, "Use this plan"),
    h("p", { class: "muted small" }, "Picking a plan again makes fresh codes; the old kit or pieces stop working."),
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

  const confirmDelete = h("input", { placeholder: "delete", "aria-label": 'Type "delete" to confirm' });
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
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "You"), h("div", { class: "muted small mono" }, me.id))),
    emergencyAlerts(me),
    h(
      "div",
      { class: "two" },
      h(
        "div",
        {},
        h("section", { class: "card stack" }, h("h2", {}, "Devices"), h("ul", { class: "list" }, devices), h("details", {}, h("summary", {}, "Add a device"), add)),
        await lockCard(),
        h("section", { class: "card stack" }, h("h2", {}, "Your name and email"), profile),
      ),
      h(
        "div",
        {},
        h("section", { class: "card stack" }, h("h2", {}, "If you lose every device"), h("p", { class: "small" }, "Pick how you'd get back in. Cardboard can't reset anything for you: that's what keeps everyone else out."), recovery),
        await emergencyCard(),
        await inviteCard(me),
        h("section", { class: "card stack danger-zone" }, h("h2", {}, "Delete account"), h("p", { class: "small" }, "Everything goes: boxes, history, tapes, docks, connected apps, devices."), h("div", { class: "row" }, confirmDelete, deleteBtn), deleteStatus),
      ),
    ),
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
    pendingConnect = { id: fromQuery, appKey: hashParam("cardboard_key"), appName: null };
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
  closeModal(false);
  takeConnectFromUrl();
  takeShareFromUrl();
  takeEmergencyAndPairFromUrl();
  // Someone else's emergency link: it's about their Cardboard, whoever is signed in here.
  if (pendingEmergency) return renderEmergency(pendingEmergency);
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
  const [, page, arg, key] = location.hash.split("/");
  for (const a of nav.querySelectorAll("a")) a.classList.toggle("active", a.getAttribute("href") === `#/${page && page !== "box" ? page : ""}`);
  try {
    if (page === "box" && arg) await renderBox(decodeURIComponent(arg), key ? decodeURIComponent(key) : undefined);
    else if (page === "activity") await renderActivity();
    else if (page === "docks") await renderDocks();
    else if (page === "apps") await renderApps();
    else if (page === "security") await renderSecurity();
    else if (page === "you") await renderYou();
    else await renderShelf();
  } catch (err) {
    if (err.code === "bad_device") {
      await browserStore.clear();
      account = null;
      return render();
    }
    fill(app, errorBox(err), h("p", {}, h("a", { href: "#/" }, "Back to the shelf")));
  }
}

window.addEventListener("hashchange", () => {
  if (!hashParam("connect")) pendingConnect = null;
  if (location.hash !== "#/join" && !hashParam("share")) pendingShare = null;
  if (location.hash !== "#/emergency" && !hashParam("emergency")) pendingEmergency = null;
  if (location.hash !== "#/pair" && !hashParam("pair")) pendingPair = null;
  render();
});
render();
