# Building on Cardboard: notes for AI coding assistants

You're helping someone build an app whose data lives in Cardboard: each person's
data is sealed (end-to-end encrypted) in their own Cardboard, and the app has no
database of its own. Follow these rules. They're what keeps that promise true.

## The rules

1. **Sign people in from the browser, with the SDK.** `startSignIn` / `finishSignIn` /
   `resumeSession` from the `cardboard` package (see docs/APPS.md). Use
   `scopes: ["openid", "box"]`, plus `"profile"` only if the app shows a name.
2. **Never put a tape (`cbt_…`) or a client secret in a web page.** A tape is for
   scripts on your own computer. Websites use Sign in with Cardboard and are
   registered as public apps (no secret).
3. **Add no third-party scripts** (analytics, chat widgets, CDNs you don't control) to
   pages that use the session: the box key lives in the browser's storage, and any
   script on the page could read it. Keep a strict Content-Security-Policy.
4. **Don't add a database or a server that stores people's data.** If the app needs
   to keep something, it goes in `session.box()`. If a feature seems to need the server
   to read data (search across users, feeds, emails), say so: Cardboard can't do it,
   on purpose.
5. **Insert people's data into the page with `textContent`, never `innerHTML`.**
   Anyone in a shared box can write to it.
6. **Expect `read_only`.** A person may sign in with a box shared with them read-only.
   Catch `CardboardError` with `code === "read_only"` and show the app as view-only.
7. **Don't use `purge`.** Apps can't delete anything for good (the person can undo
   whatever an app does); plain `delete` is right.
8. **Pass invites on.** Call `takeInvite()` when the page loads and pass it to
   `startSignIn(config, { invite })`, so friends without an account can join in one go.

## The handful of calls you need

```ts
const box = session.box();
const items = box.collection<{ text: string; done: boolean }>("items");
await items.add({ text: "Milk", done: false });         // sealed before it leaves the browser
await items.update(id, { done: true });
await items.find({ where: { done: false }, sort: "$createdAt" });
items.watch(() => redraw());                             // live: other devices, and people sharing the box
await box.undo(items.key(id));                           // every change can be undone
await box.put("files/photo", new Uint8Array(bytes));     // bytes are stored as bytes (under 1 MB each)
```

Errors are `CardboardError`s with a `code`, a plain `message` and a `hint`: show the
message, and use the hint to decide what to do.

## A working example

`examples/shared-list/`: a shared family list with sign-in, invites, live updates and
undo, in about 120 lines, with no build step and no database. Start from it.
