"use strict";
// Cardboard dashboard. No framework, no build step. Everything that came from an
// app (key names, values, labels) is inserted with textContent, never as HTML.

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const modal = document.getElementById("modal");
const TOKEN_KEY = "cardboard.owner";

let token = null;
try {
  token = sessionStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

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

async function api(op, body = {}) {
  const res = await fetch(`/v1/admin/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOut();
    throw new Error(data.error?.message || "Signed out.");
  }
  if (!res.ok) {
    const err = new Error(data.error?.message || `Cardboard answered with HTTP ${res.status}.`);
    err.hint = data.error?.hint;
    throw err;
  }
  return data;
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
  return h("div", { class: "error" }, err.message, err.hint ? h("div", { class: "small" }, err.hint) : null);
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

function fixLine(fix) {
  return fix ? h("div", { class: "fix" }, h("code", {}, fix), copyButton(fix)) : null;
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
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});

function showSecret(title, secret, box, extra, onDone) {
  openModal(
    onDone,
    h("h2", {}, title),
    h("p", {}, "This is the only time Cardboard will show this tape. Put it in your app's ", h("code", {}, ".env"), ":"),
    h("code", { class: "secret" }, `CARDBOARD_TAPE=${secret}`),
    h("div", { class: "row" }, copyButton(`CARDBOARD_TAPE=${secret}`, "Copy line"), copyButton(secret, "Copy tape only")),
    extra ? h("p", { class: "muted small" }, extra) : null,
    h("p", { class: "muted small" }, "Or skip all this: in the app's folder run ", h("code", {}, `cardboard connect ${box}`), "."),
    h("div", { class: "row" }, h("button", { type: "button", onclick: () => closeModal() }, "Done")),
  );
}

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

function signOut() {
  fetch("/oauth/logout", { method: "POST" }).catch(() => {});
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
  render();
}

document.getElementById("signout").addEventListener("click", signOut);

// ── Pages ───────────────────────────────────────────────────────────────────

function renderLogin() {
  nav.hidden = true;
  const input = h("input", { type: "password", placeholder: "cbo_…", autocomplete: "current-password", required: true });
  const status = h("div");
  const form = h(
    "form",
    { class: "card stack login" },
    h("div", { class: "row" }, document.querySelector(".brand svg").cloneNode(true), h("h1", {}, "Open the box")),
    h("p", { class: "muted" }, "Sign in with your owner token. It was printed the first time Cardboard started."),
    h("label", { class: "field" }, "Owner token", input),
    h("button", { type: "submit" }, "Sign in"),
    status,
    h("p", { class: "muted small" }, "Lost it? On the server, run ", h("code", {}, "cardboard reset-owner"), "."),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    token = input.value.trim();
    try {
      await api("boxes");
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        // private mode: stay signed in for this page only
      }
      // Also sign this browser in for "Sign in with Cardboard", so apps don't ask for the token again.
      fetch("/oauth/session", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
      render();
    } catch (err) {
      token = null;
      status.replaceChildren(errorBox(err));
    }
  });
  app.replaceChildren(form);
  input.focus();
}

async function renderShelf() {
  const data = await api("overview");
  const searchInput = h("input", { type: "search", placeholder: "Find anything in any box…", "aria-label": "Search every box" });
  const results = h("div");
  const search = h(
    "form",
    { class: "search" },
    searchInput,
    h("button", { type: "submit", class: "secondary" }, "Search"),
  );
  search.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q.length < 2) return results.replaceChildren();
    try {
      const { results: found } = await api("search", { q });
      results.replaceChildren(
        h(
          "div",
          { class: "card" },
          h("h2", {}, found.length ? `Found in ${found.length} place${found.length === 1 ? "" : "s"}` : "Nothing found"),
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
    } catch (err) {
      results.replaceChildren(errorBox(err));
    }
  });

  const shake = data.shake;
  const shakeChip = shake
    ? h("a", { href: "#/shake", class: `chip ${shake.ok ? "ok" : "danger"}` }, `${shake.ok ? "✓" : "✗"} Shake test: ${shake.summary}`)
    : h("a", { href: "#/shake", class: "chip" }, "Run the shake test");

  const shelfInsights = data.insights.filter((i) => !(i.fix || "").startsWith("cardboard dock approve"));
  const insights = shelfInsights.length
    ? h(
        "section",
        { class: "card" },
        h("h2", {}, "Worth a look"),
        shelfInsights.map((i) =>
          h("div", { class: `insight ${i.level}` }, h("div", { class: "title" }, i.title), h("div", { class: "detail" }, i.detail), fixLine(i.fix)),
        ),
      )
    : h("section", { class: "card" }, h("h2", {}, "All good"), h("p", { class: "muted" }, "Nothing needs fixing right now."));

  const cards = data.boxes.map((b) =>
    h(
      "a",
      { class: "boxcard", href: `#/box/${encodeURIComponent(b.name)}` },
      h("h3", {}, b.name),
      b.profile.description ? h("div", { class: "muted small" }, b.profile.description, b.profile.version ? ` · v${b.profile.version}` : "") : null,
      h("div", {}, b.summary),
      b.docks.length ? h("div", { class: "row" }, b.docks.map((d) => h("span", { class: `chip ${d.waiting ? "warn" : ""}` }, `⚓ ${d.dock}`))) : null,
      h("div", { class: "row" }, sensitiveChips(b.sensitive)),
      h("div", { class: "stats" }, `${plural(b.items, "item")} · ${bytes(b.bytes)} · ${plural(b.tapes, "tape")} · ${b.lastActivity ? `active ${ago(b.lastActivity)}` : "never used"}`),
    ),
  );

  app.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", {}, "Your shelf"), h("div", { class: "muted" }, `${data.boxes.length} box${data.boxes.length === 1 ? "" : "es"} · Cardboard ${data.version}`)),
      shakeChip,
    ),
    search,
    results,
    pendingCard(data.pendingDocks),
    insights,
    h("div", { class: "grid" }, cards, newBoxCard()),
  );
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const result = await api("box.create", { name: name.value.trim(), label: "dashboard" });
      showSecret(`${result.box.name} is ready`, result.secret, result.box.name, null, render);
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });
  return form;
}

async function renderBox(name, openKey) {
  const data = await api("box.get", { name });
  const { box, inventory } = data;

  const head = h(
    "div",
    { class: "page-head" },
    h(
      "div",
      { class: "stack" },
      h("a", { href: "#/", class: "small" }, "← Shelf"),
      h("h1", { class: "mono" }, box.name),
      h("div", { class: "muted" }, `${plural(box.items, "item")} · ${bytes(box.bytes)} · made ${ago(box.createdAt)}`),
    ),
  );

  const inside = h(
    "section",
    { class: "card" },
    h("h2", {}, "What's inside"),
    h("p", {}, inventory.summary),
    h("div", { class: "row" }, sensitiveChips(inventory.sensitive)),
    inventory.secretPaths.length
      ? h("p", { class: "small muted" }, "Secrets found at: ", inventory.secretPaths.slice(0, 5).map((p, i) => [i ? ", " : "", h("code", {}, p)]))
      : null,
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

  app.replaceChildren(
    head,
    h("div", { class: "two" }, h("div", {}, inside, browser(box.name, openKey)), h("div", {}, tapesSection(data), activitySection(data.log))),
    h("div", { class: "two" }, settingsSection(box), timeMachine(box.name)),
    dangerZone(box.name),
  );
}

function browser(boxName, openKey) {
  const prefix = h("input", { type: "search", placeholder: "Filter by prefix, e.g. notes/", "aria-label": "Prefix" });
  const list = h("div", { class: "keys" });
  const detail = h("div", { class: "stack" });
  let active = null;

  async function load() {
    try {
      const { items, next } = await api("box.items", { name: boxName, prefix: prefix.value, limit: 200 });
      fill(
        list,
        items.length === 0 ? h("p", { class: "muted small" }, "Nothing here.") : null,
        items.map((it) => {
          const btn = h("button", { type: "button", title: it.key }, it.key);
          btn.addEventListener("click", () => show(it.key, btn));
          return btn;
        }),
        next ? h("p", { class: "muted small" }, "Showing the first 200. Narrow it with a prefix.") : null,
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
      const { item, history } = await api("box.item", { name: boxName, key });
      fill(
        detail,
        h("h3", { class: "mono" }, key),
        item
          ? h("div", { class: "muted small" }, `version ${item.version} · ${bytes(item.size)} · changed ${ago(item.updatedAt)}${item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleString()}` : ""}`)
          : h("div", { class: "muted small" }, "Deleted (still in history)."),
        item ? h("pre", {}, JSON.stringify(item.value, null, 2)) : null,
        history.length > 1
          ? h(
              "details",
              {},
              h("summary", { class: "small" }, `${history.length} versions`),
              h(
                "ul",
                { class: "list small" },
                history.map((v) => h("li", {}, `v${v.version} · ${ago(v.at)} · `, v.deleted ? "deleted" : bytes(v.size))),
              ),
            )
          : null,
      );
    } catch (err) {
      detail.replaceChildren(errorBox(err));
    }
  }

  prefix.addEventListener("input", () => {
    clearTimeout(prefix._t);
    prefix._t = setTimeout(load, 250);
  });
  load();
  if (openKey) show(openKey);
  return h("section", { class: "card stack" }, h("h2", {}, "Browse"), prefix, list, detail);
}

function tapesSection(data) {
  const boxName = data.box.name;
  const tapes = data.tapes.map((t) => {
    const perms = [t.read && "read", t.write && "write"].filter(Boolean).join(" + ");
    const active = t.state === "active";
    const revoke = active ? h("button", { class: "secondary tiny", type: "button" }, "Revoke") : null;
    revoke?.addEventListener("click", () =>
      withBusy(revoke, async () => {
        if (!confirm(`Revoke “${t.label}”? Anything using it is locked out immediately.`)) return;
        await api("tape.revoke", { id: t.id });
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
          t.prefix ? h("span", { class: "chip mono" }, t.prefix) : null,
          h("span", { class: `chip ${active ? "ok" : ""}` }, active ? "active" : "off"),
        ),
        revoke,
      ),
      h("div", { class: "small" }, t.blast.summary),
      h("div", { class: "muted small mono" }, `${t.id} · last used ${ago(t.lastUsedAt)}`),
    );
  });

  const label = h("input", { placeholder: "phone, laptop, ci…", "aria-label": "Label" });
  const read = h("input", { type: "checkbox", checked: true });
  const write = h("input", { type: "checkbox", checked: true });
  const prefix = h("input", { placeholder: "optional, e.g. public/", "aria-label": "Prefix" });
  const idle = h("select", {}, h("option", { value: "90d" }, "90 days unused"), h("option", { value: "30d" }, "30 days unused"), h("option", { value: "7d" }, "7 days unused"), h("option", { value: "never" }, "never (not recommended)"));
  const expires = h("select", {}, h("option", { value: "" }, "no fixed end"), h("option", { value: "1d" }, "in 1 day"), h("option", { value: "7d" }, "in 7 days"), h("option", { value: "30d" }, "in 30 days"));
  const status = h("div");
  const form = h(
    "form",
    { class: "stack" },
    h("h3", {}, "New tape"),
    h("div", { class: "two" }, h("label", { class: "field" }, "Label", label), h("label", { class: "field" }, "Only keys starting with", prefix)),
    h("div", { class: "row" }, h("label", { class: "check" }, read, "can read"), h("label", { class: "check" }, write, "can write")),
    h("div", { class: "two" }, h("label", { class: "field" }, "Switches off after", idle), h("label", { class: "field" }, "Expires", expires)),
    h("button", { type: "submit" }, "Make tape"),
    status,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const result = await api("tape.create", {
        box: boxName,
        label: label.value.trim() || "dashboard",
        read: read.checked,
        write: write.checked,
        prefix: prefix.value.trim() || undefined,
        idle: idle.value,
        expires: expires.value || undefined,
      });
      showSecret(`New tape for ${boxName}`, result.secret, boxName, result.blast.summary, render);
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });

  return h("section", { class: "card stack" }, h("h2", {}, "Tapes"), h("ul", { class: "list" }, tapes), h("details", {}, h("summary", {}, "Make a new tape"), form));
}

function logLines(entries) {
  return h(
    "ul",
    { class: "list" },
    entries.map((e) =>
      h(
        "li",
        { class: `log-line ${e.outcome}` },
        h("time", { title: new Date(e.at).toLocaleString() }, ago(e.at)),
        h("div", {}, h("span", { class: "text" }, e.text), e.detail.ip ? h("span", { class: "muted small" }, ` · ${e.detail.ip}`) : null),
      ),
    ),
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
  const history = h("input", { type: "number", min: 0, max: 3650, value: s.historyDays });
  const quota = h("input", { value: bytes(s.quotaBytes).replace(" ", "") });
  const origins = h("input", { value: s.origins.join(", "), placeholder: "https://myapp.example.com" });
  const status = h("div");
  const form = h(
    "form",
    { class: "card stack" },
    h("h2", {}, "Settings"),
    h("label", { class: "field" }, "API keys, passwords and other secrets", secrets),
    h("label", { class: "field" }, "Things expire after (unless an app says otherwise)", ttl),
    h("label", { class: "field" }, "Days of history to keep for undo & rewind", history),
    h("label", { class: "field" }, "Space allowed", quota),
    h("label", { class: "field" }, "Websites allowed to call this box from a browser (comma separated)", origins),
    h("button", { type: "submit" }, "Save"),
    status,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("box.settings", {
        name: box.name,
        settings: {
          secrets: secrets.value,
          defaultTtl: ttl.value.trim() || null,
          historyDays: Number(history.value),
          quotaBytes: quota.value.trim(),
          origins: origins.value.split(",").map((o) => o.trim()).filter(Boolean),
        },
      });
      status.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });
  return form;
}

function timeMachine(boxName) {
  const when = h("select", {}, h("option", { value: "5m" }, "5 minutes ago"), h("option", { value: "1h" }, "1 hour ago"), h("option", { value: "1d" }, "1 day ago"), h("option", { value: "7d" }, "1 week ago"));
  const status = h("div");
  const button = h("button", { type: "button", class: "secondary" }, "Rewind");
  button.addEventListener("click", () =>
    withBusy(button, async () => {
      if (!confirm(`Put every key in ${boxName} back the way it was ${when.selectedOptions[0].textContent}? (You can rewind the rewind.)`)) return;
      try {
        const result = await api("box.rewind", { name: boxName, to: when.value });
        status.replaceChildren(h("span", { class: "chip ok" }, `Done: ${result.changed} key${result.changed === 1 ? "" : "s"} changed`));
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    }),
  );
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Time machine"),
    h("p", { class: "muted small" }, "An app went wrong and wrecked its data? Put the whole box back to an earlier moment. Every key is restored as a new version, so this can be undone too."),
    h("div", { class: "row" }, when, button),
    status,
  );
}

function dangerZone(boxName) {
  const exportBtn = h("button", { type: "button", class: "secondary" }, "Export as JSON");
  exportBtn.addEventListener("click", () =>
    withBusy(exportBtn, async () => {
      const data = await api("box.export", { name: boxName });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = h("a", { href: url, download: `${boxName}-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
  );
  const confirmName = h("input", { placeholder: boxName, "aria-label": "Type the box name to confirm" });
  const shredBtn = h("button", { type: "button", class: "danger" }, "Shred this box");
  const status = h("div");
  shredBtn.addEventListener("click", () =>
    withBusy(shredBtn, async () => {
      try {
        const result = await api("box.shred", { name: boxName, confirm: confirmName.value.trim() });
        if (result.note) alert(result.note);
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
    h("div", { class: "row" }, exportBtn, h("span", { class: "muted small" }, "Everything in plain JSON. Keep the file somewhere private.")),
    h("p", { class: "small" }, "Shredding destroys the box's key, so every item, version, tape and log line becomes unreadable for good. Type the name to confirm."),
    h("div", { class: "row" }, confirmName, shredBtn),
    status,
  );
}

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
        approve.addEventListener("click", () => withBusy(approve, async () => {
          await api("dock.approve", { dock: p.dock, box: p.box });
          render();
        }));
        deny.addEventListener("click", () => withBusy(deny, async () => {
          await api("dock.deny", { dock: p.dock, box: p.box });
          render();
        }));
        return h(
          "li",
          { class: "row spread" },
          h("div", {}, h("strong", { class: "mono" }, p.box), ` wants to ${direction(p)} on `, h("strong", { class: "mono" }, p.dock)),
          h("div", { class: "row" }, approve, deny),
        );
      }),
    ),
  );
}

async function renderDocks() {
  const [{ docks, pending }, { boxes }] = await Promise.all([api("docks"), api("boxes")]);
  app.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("h1", {}, "Docks"),
        h("div", { class: "muted" }, "Meeting points where your apps swap data. Each app only ever sees a pseudonym, and every parcel goes through customs."),
      ),
    ),
    pendingCard(pending) || h("span"),
    h("div", { class: "grid wide" }, docks.map((d) => dockCard(d)), newDockCard(boxes)),
  );
}

function dockCard(d) {
  const berths = h(
    "ul",
    { class: "list" },
    d.berths.length === 0 ? h("li", { class: "muted small" }, "No apps yet. Apps that use this dock will ask to join.") : null,
    d.berths.map((b) => {
      const role = b.denied ? h("span", { class: "chip danger" }, "refused")
        : !b.send && !b.receive ? h("span", { class: "chip warn" }, `asking to ${direction(b.waiting)}`)
        : h("span", { class: "chip ok" }, b.send && b.receive ? "sends + receives" : b.send ? "sends" : "receives");
      const remove = h("button", { type: "button", class: "secondary tiny" }, "Remove");
      remove.addEventListener("click", () => withBusy(remove, async () => {
        if (!confirm(`Take ${b.box} off ${d.name}? Its live connection closes immediately.`)) return;
        await api("dock.remove", { dock: d.name, box: b.box });
        render();
      }));
      return h(
        "li",
        { class: "row spread" },
        h("div", { class: "stack" }, h("div", { class: "row" }, h("strong", { class: "mono" }, b.box), role), h("div", { class: "muted small mono" }, `known there as ${b.tag}`)),
        remove,
      );
    }),
  );

  const peek = h("button", { type: "button", class: "secondary tiny" }, "Look inside");
  peek.addEventListener("click", () => withBusy(peek, async () => {
    const { parcels } = await api("dock.peek", { dock: d.name });
    openModal(
      null,
      h("h2", {}, `In flight on ${d.name}`),
      h("p", { class: "muted small" }, "Only you see real names here. Apps only ever see pseudonyms."),
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
  }));

  return h(
    "section",
    { class: "card stack" },
    h("div", { class: "row spread" }, h("h2", { class: "mono" }, `⚓ ${d.name}`), peek),
    h("div", { class: "muted small" }, d.inFlight.count ? `${d.inFlight.count} parcel${d.inFlight.count === 1 ? "" : "s"} in flight (${bytes(d.inFlight.bytes)})` : "Nothing in flight"),
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
  const secrets = h(
    "select",
    {},
    h("option", { value: "block", selected: s.secrets === "block" }, "Refuse the parcel"),
    h("option", { value: "allow", selected: s.secrets === "allow" }, "Let it through (not recommended)"),
  );
  const shape = h("textarea", { rows: 3, placeholder: '{"item": "string", "qty": "number?"}' });
  shape.value = s.shape ? JSON.stringify(s.shape) : "";
  const ttl = h("input", { value: `${Math.round(s.ttlMs / 86400000)}d` });
  const rate = h("input", { type: "number", min: 1, value: s.ratePerMinute });
  const status = h("div");
  const confirmName = h("input", { placeholder: d.name, "aria-label": "Type the dock name to confirm" });
  const shred = h("button", { type: "button", class: "danger tiny" }, "Shred dock");
  shred.addEventListener("click", () => withBusy(shred, async () => {
    try {
      await api("dock.shred", { dock: d.name, confirm: confirmName.value.trim() });
      render();
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  }));
  const form = h(
    "form",
    { class: "stack" },
    h("label", { class: "field" }, "Personal data (emails, phones, kennitölur, cards…)", personal),
    h("label", { class: "field" }, "Secrets (API keys, passwords, private keys)", secrets),
    h("label", { class: "field" }, "Manifest: only these fields may cross (optional)", shape),
    h("div", { class: "two" }, h("label", { class: "field" }, "Parcels expire after", ttl), h("label", { class: "field" }, "Max parcels per app per minute", rate)),
    h("button", { type: "submit" }, "Save"),
    status,
    h("div", { class: "row" }, confirmName, shred),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("dock.settings", {
        dock: d.name,
        settings: { personal: personal.value, secrets: secrets.value, shape: shape.value.trim() || null, ttl: ttl.value.trim(), ratePerMinute: Number(rate.value) },
      });
      status.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("dock.create", {
        name: name.value.trim(),
        send: picks.filter((p) => p.send.checked).map((p) => p.box),
        receive: picks.filter((p) => p.receive.checked).map((p) => p.box),
      });
      render();
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });
  return form;
}

const SCOPE_LABEL = { openid: "knows you (private ID)", profile: "your name", email: "your email", box: "keeps data in your Cardboard", offline_access: "stays connected" };

async function renderApps() {
  const data = await api("apps");
  const connected = data.connected.map((a) => {
    const disconnect = h("button", { type: "button", class: "secondary tiny" }, "Disconnect");
    const shred = a.box ? h("button", { type: "button", class: "danger tiny" }, "Disconnect & shred its data") : null;
    disconnect.addEventListener("click", () => withBusy(disconnect, async () => {
      if (!confirm(`Disconnect ${a.name}? It loses access right away.${a.box ? " Its box stays, in case you reconnect." : ""}`)) return;
      await api("apps.disconnect", { grant: a.grant });
      render();
    }));
    shred?.addEventListener("click", () => withBusy(shred, async () => {
      if (!confirm(`Disconnect ${a.name} and shred everything it stored about you in “${a.box}”? This can't be undone.`)) return;
      await api("apps.disconnect", { grant: a.grant, shred: true });
      render();
    }));
    return h(
      "li",
      { class: "stack" },
      h("div", { class: "row spread" }, h("div", {}, h("strong", {}, a.name), h("span", { class: "muted small" }, ` · ${a.site}`)), h("div", { class: "row" }, disconnect, shred)),
      h("div", { class: "row" }, a.scopes.filter((s) => SCOPE_LABEL[s]).map((s) => h("span", { class: "chip" }, SCOPE_LABEL[s])), a.selfRegistered ? h("span", { class: "chip warn" }, "registered itself") : null),
      h(
        "div",
        { class: "muted small" },
        `Connected ${ago(a.connectedAt)} · last used ${ago(a.lastUsedAt)}`,
        a.box ? [" · data in ", h("a", { href: `#/box/${encodeURIComponent(a.box)}` }, a.box)] : null,
      ),
      h("div", { class: "muted small mono" }, `knows you as ${a.privateId}`),
    );
  });

  const registered = data.registered.map((c) => {
    const forget = h("button", { type: "button", class: "secondary tiny" }, "Forget");
    forget.addEventListener("click", () => withBusy(forget, async () => {
      await api("apps.forget", { client: c.client });
      render();
    }));
    return h("li", { class: "row spread" }, h("div", {}, h("strong", {}, c.name), h("div", { class: "muted small mono" }, c.redirectUris.join(", "))), forget);
  });

  app.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", {}, "Apps"), h("div", { class: "muted" }, "Apps you signed into with Cardboard. Each one knows you only by a private ID made for it, and keeps its data about you here, with you.")),
    ),
    h(
      "div",
      { class: "two" },
      h(
        "div",
        {},
        h("section", { class: "card" }, h("h2", {}, "Connected"), connected.length ? h("ul", { class: "list" }, connected) : h("p", { class: "muted" }, "No apps yet. When an app shows “Sign in with Cardboard”, this is where it lands.")),
        registered.length ? h("section", { class: "card" }, h("h2", {}, "Registered, not connected"), h("ul", { class: "list" }, registered)) : null,
      ),
      h("div", {}, profileCard(data.profile), connectCard(data.issuer)),
    ),
  );
}

function profileCard(profile) {
  const name = h("input", { value: profile.name || "", placeholder: "How apps may greet you" });
  const email = h("input", { type: "email", value: profile.email || "", placeholder: "you@example.com" });
  const status = h("div");
  const form = h(
    "form",
    { class: "card stack" },
    h("h2", {}, "You"),
    h("p", { class: "muted small" }, "Apps only see these if they ask and you say yes. By default they get nothing but their private ID for you."),
    h("label", { class: "field" }, "Name", name),
    h("label", { class: "field" }, "Email", email),
    h("button", { type: "submit" }, "Save"),
    status,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("profile.set", { name: name.value.trim() || null, email: email.value.trim() || null });
      status.replaceChildren(h("span", { class: "chip ok" }, "Saved"));
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });
  return form;
}

function connectCard(issuer) {
  const name = h("input", { placeholder: "My App", required: true });
  const redirect = h("input", { placeholder: "https://myapp.example.com/callback", required: true });
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("apps.register", { name: name.value.trim(), redirectUris: [redirect.value.trim()], public: !server.checked });
      status.replaceChildren(
        h("div", { class: "stack" },
          h("div", { class: "small" }, "client_id"), h("code", { class: "secret" }, r.client_id),
          r.client_secret ? [h("div", { class: "small" }, "client_secret (shown once)"), h("code", { class: "secret" }, r.client_secret), copyButton(r.client_secret, "Copy secret")] : null,
        ),
      );
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  });
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Add “Sign in with Cardboard” to an app"),
    h("p", { class: "small" }, "Cardboard speaks OpenID Connect, so any app or library with a “generic OpenID Connect” option can use it. Give it this issuer:"),
    h("div", { class: "row" }, h("code", { class: "secret" }, issuer), copyButton(issuer)),
    h("p", { class: "muted small" }, "Apps can register themselves automatically, or you can register one here:"),
    form,
  );
}

async function renderActivity() {
  const { boxes } = await api("boxes");
  const select = h("select", { "aria-label": "Box" }, h("option", { value: "" }, "All boxes"), boxes.map((b) => h("option", { value: b.name }, b.name)));
  const list = h("div");
  const more = h("button", { type: "button", class: "secondary" }, "Load older");
  let before;
  async function load(reset) {
    if (reset) {
      before = undefined;
      list.replaceChildren();
    }
    const { entries } = await api("log", { box: select.value || undefined, limit: 100, before });
    list.append(logLines(entries));
    before = entries.length ? entries[entries.length - 1].id : before;
    more.hidden = entries.length < 100;
  }
  select.addEventListener("change", () => load(true));
  more.addEventListener("click", () => withBusy(more, () => load(false)));
  app.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Activity"), select),
    h("section", { class: "card" }, h("p", { class: "muted small" }, "Who touched what, newest first. Key names and addresses are stored encrypted with each box's key."), list, more),
  );
  await load(true);
}

async function renderShake() {
  const run = h("button", { type: "button" }, "Shake it again");
  const body = h("div");
  async function show(report) {
    body.replaceChildren(
      h("p", {}, h("span", { class: `chip ${report.ok ? "ok" : "danger"}` }, `${report.ok ? "✓" : "✗"} ${report.summary}`), h("span", { class: "muted small" }, ` · ${ago(report.at)}`)),
      h(
        "ul",
        { class: "list" },
        report.results.map((r) =>
          h("li", { class: "shake-result" }, h("span", { class: `mark ${r.status}` }, r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!"), h("div", {}, h("strong", {}, r.title), h("div", { class: "muted small" }, r.detail))),
        ),
      ),
    );
  }
  run.addEventListener("click", () => withBusy(run, async () => show(await api("shake"))));
  app.replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Shake test"), h("div", { class: "muted" }, "Cardboard attacks itself through the same API your apps use, on two throwaway boxes, and reports what held.")), run),
    h("section", { class: "card" }, body),
  );
  const { shake } = await api("overview");
  if (shake) show(shake);
  else show(await api("shake"));
}

// ── Router ──────────────────────────────────────────────────────────────────

async function render() {
  closeModal(false);
  if (!token) return renderLogin();
  nav.hidden = false;
  const [, page, arg, key] = location.hash.split("/");
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.getAttribute("href") === `#/${page && page !== "box" ? page : ""}`);
  }
  try {
    if (page === "box" && arg) await renderBox(decodeURIComponent(arg), key ? decodeURIComponent(key) : undefined);
    else if (page === "activity") await renderActivity();
    else if (page === "docks") await renderDocks();
    else if (page === "apps") await renderApps();
    else if (page === "shake") await renderShake();
    else await renderShelf();
  } catch (err) {
    if (token) app.replaceChildren(errorBox(err), h("p", {}, h("a", { href: "#/" }, "Back to the shelf")));
  }
}

window.addEventListener("hashchange", render);
render();
