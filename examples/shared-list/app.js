// A whole app with no database: each person's list lives in their own Cardboard,
// locked on their device. Share the box with family in Cardboard and you all see
// the same list, live. Every change can be undone.
import { finishSignIn, resumeSession, startSignIn, takeInvite } from "/lib/sdk/index.ts";

const settings = await (await fetch("/settings.json")).json();
const config = {
  issuer: settings.cardboard,
  clientId: settings.clientId,
  redirectUri: `${location.origin}/callback`,
  scopes: ["openid", "box"],
  storage: { get: () => localStorage.getItem("cardboard"), set: (v) => localStorage.setItem("cardboard", v) },
};
const app = document.getElementById("app");
const who = document.getElementById("who");

// A friend arriving with an invite (https://this-app/#cardboard_invite=…) makes their Cardboard account on the way in.
const invite = takeInvite();
if (invite) sessionStorage.setItem("cardboard-invite", invite);

async function signIn() {
  const pending = await startSignIn(config, { invite: sessionStorage.getItem("cardboard-invite") });
  sessionStorage.setItem("cardboard-pending", JSON.stringify(pending));
  location.assign(pending.url);
}

async function session() {
  if (location.pathname === "/callback") {
    const pending = JSON.parse(sessionStorage.getItem("cardboard-pending") ?? "null");
    sessionStorage.removeItem("cardboard-pending");
    sessionStorage.removeItem("cardboard-invite");
    const s = await finishSignIn(config, location.href, pending);
    history.replaceState(null, "", "/");
    return s;
  }
  try {
    return await resumeSession(config);
  } catch {
    return null;
  }
}

const s = await session();
if (!s) {
  who.textContent = "Your list stays in your own Cardboard. This app doesn't keep a copy.";
  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = "Sign in with Cardboard";
  button.onclick = signIn;
  app.replaceChildren(button);
} else {
  const box = s.box();
  const items = box.collection("items");
  who.textContent = "Signed in. Share this list from your Cardboard (People → Share with someone) and you'll see each other's changes live.";

  const form = document.createElement("form");
  const input = Object.assign(document.createElement("input"), { type: "text", placeholder: "Add something…", required: true });
  const add = Object.assign(document.createElement("button"), { type: "submit", className: "primary", textContent: "Add" });
  form.append(input, add);
  const list = document.createElement("ul");
  const undo = Object.assign(document.createElement("button"), { type: "button", textContent: "Undo my last change" });
  const status = Object.assign(document.createElement("p"), { className: "muted" });
  app.replaceChildren(form, list, undo, status);
  let last = null;

  async function draw() {
    const all = await items.find({ sort: "$createdAt" });
    list.replaceChildren(
      ...all.map((item) => {
        const li = document.createElement("li");
        li.className = item.done ? "done" : "";
        const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: item.done });
        box.onchange = async () => {
          await items.update(item.id, { done: box.checked });
          last = items.key(item.id);
        };
        // Text from the list goes in with textContent only, never innerHTML.
        const text = Object.assign(document.createElement("span"), { textContent: item.text });
        const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "✕" });
        remove.onclick = async () => {
          await items.remove(item.id);
          last = items.key(item.id);
        };
        li.append(box, text, remove);
        return li;
      }),
    );
    status.textContent = all.length ? "" : "Empty. Add the first thing.";
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const doc = await items.add({ text: input.value.trim(), done: false });
    last = items.key(doc.id);
    input.value = "";
  };
  undo.onclick = async () => {
    if (!last) return (status.textContent = "Nothing to undo yet.");
    await box.undo(last);
  };
  items.watch(() => draw()); // live: your other devices, and anyone you share the list with
  await draw();
}
