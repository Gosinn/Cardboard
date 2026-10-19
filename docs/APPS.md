# Connecting an app (like LORE)

There are two ways in. Pick by who the app is for:

- **Sign in with Cardboard**: for apps other people use too (LORE). Each person signs in with *their own* Cardboard, and the app keeps that person's data in a box in their Cardboard. The app's server (if it has one) never needs to store their data.
- **A tape**: for your own tools and scripts. `cardboard connect` in the app's folder writes `CARDBOARD_URL` and `CARDBOARD_TAPE` to `.env`, and `open()` picks them up. See the README.

This page is the first one, for a website. It works the same later inside a phone app built on web tech (see the end).

## 1. Install the SDK

```bash
npm install github:Gosinn/Cardboard
```

It has no dependencies and runs in the browser (WebCrypto) and in Node. Import from `"cardboard"`.

## 2. Register the app once

In your Cardboard dashboard: **Apps → Add “Sign in with Cardboard” to an app**. Give it a name (people see it when they sign in) and every address it signs people in from, separated by commas:

```
https://lore.example.com/auth/callback, http://localhost:5173/auth/callback
```

Leave “has its own server” unticked for a website: a browser can't keep a client secret. Copy the **client id** (`cbc_…`).

(Or from the command line: `cardboard apps add "LORE" --redirect https://lore.example.com/auth/callback,http://localhost:5173/auth/callback --public`.)

A website that signs people in can call their box from its own pages straight away: Cardboard allows the origins of its registered addresses, and nothing else.

## 3. Sign people in

```ts
import { finishSignIn, resumeSession, startSignIn, type SignInConfig } from "cardboard";

export const cardboard: SignInConfig = {
  issuer: "https://cardboard.yourdomain.com",
  clientId: "cbc_…",
  redirectUri: `${location.origin}/auth/callback`,
  scopes: ["openid", "profile", "box"], // who they are, their name (if they say so), and a box for their data
  // Keeps the session between page loads, rewritten after every refresh and shared by your tabs.
  storage: { get: () => localStorage.getItem("cardboard"), set: (v) => localStorage.setItem("cardboard", v) },
};

// The "Sign in with Cardboard" button:
export async function signIn() {
  const pending = await startSignIn(cardboard);
  sessionStorage.setItem("cardboard-pending", JSON.stringify(pending)); // holds a one-time private key
  location.assign(pending.url);
}

// On /auth/callback:
export async function finish() {
  const pending = JSON.parse(sessionStorage.getItem("cardboard-pending") ?? "null");
  sessionStorage.removeItem("cardboard-pending");
  const session = await finishSignIn(cardboard, location.href, pending);
  history.replaceState(null, "", "/"); // the code in the address bar is used up
  return session;
}

// On every other page load:
export async function current() {
  try {
    return await resumeSession(cardboard);
  } catch {
    return null; // not signed in (or they disconnected the app): show the button
  }
}
```

### Friends who don't have Cardboard yet

In your Cardboard, **Apps → Invite a friend to LORE** makes a link like `https://lore.example/#cardboard_invite=cbi_…` (with a QR code). Send it to a friend. Pass the invite on when you sign them in, and they make their Cardboard account on one screen, allow LORE, and land back in LORE:

```ts
import { takeInvite } from "cardboard";

const invite = takeInvite(); // reads #cardboard_invite=… and takes it out of the address bar
if (invite) sessionStorage.setItem("cardboard-invite", invite);

// In signIn():
const pending = await startSignIn(cardboard, { invite: sessionStorage.getItem("cardboard-invite") });
```

The invite travels in the part after `#`, which browsers never send to servers, so it doesn't end up in your server's logs. It works once.

- `session.user.id` is a private ID for this person, made only for your app. It never changes for your app, and other apps get a different one, so apps can't compare notes.
- `session.user.name` arrives only if they allowed it. It comes sealed to your app; the Cardboard server never sees it.
- **Keep `pending` and the saved session private.** The saved session holds the box key: anyone who reads it can read that person's box. Don't load third-party scripts you don't trust on pages that use it.

## 4. Keep their data in their Cardboard

```ts
const box = session.box();

await box.put("settings", { theme: "dark" });
const characters = box.collection<{ name: string; bio: string }>("characters");
const aria = await characters.add({ name: "Aria", bio: "…" });
await characters.find({ where: { name: { $startsWith: "A" } }, sort: "name" });

box.watch("characters/", (change) => refresh(change.key)); // live, from any device or person in the box
await box.undo("settings"); // every change can be undone
```

Everything is sealed in the browser before it's sent. The full list is in the README's SDK table.

## Sharing between people

Two people working on the same LORE world: the owner opens the box in their dashboard, then *People → Share with someone*, and sends the link. When the friend signs in to LORE, the sign-in screen lets them choose that shared box instead of a new one, so you both read and write the same data, live, through `watch()`.

## Going from website to phone app

- **Capacitor (or any web-view wrapper): almost nothing changes.** It's the same website inside an app, with WebCrypto, so the SDK works as is. Register an app address like `com.example.lore:/callback` as a redirect URI. One small Cardboard change will be needed then: allowing the app's web-view origin (like `capacitor://localhost`) for its sign-ins.
- **React Native / Expo:** the SDK needs WebCrypto (`crypto.subtle`), which React Native doesn't have built in. It needs a polyfill such as `react-native-quick-crypto`. Ask when you get there.
- **Swift or Kotlin:** there's no native SDK yet. That would be a port of the crypto (AES-GCM, HKDF, ECDH P-256, all built into iOS and Android) plus the small HTTP API.
