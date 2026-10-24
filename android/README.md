# Cardboard for Android

A small app (about 30 KB) that opens your own Cardboard in its own window:

- **You type your Cardboard's address once** (like `https://laptop.tail1234.ts.net:8443`). After that it's just an icon.
- **It's in the Share menu** of every app. Share a photo, a video, a page or some text to Cardboard and it's sealed on the phone and sent to your other devices. Big videos are read from the phone a piece at a time, only as they're sealed.
- **Downloads land in *Downloads › Cardboard*.**
- If the computer Cardboard runs on is off, it says so, with *Try again*, instead of a browser error page.

## Getting it

Open your Cardboard in your phone's browser: on Android it shows **Get the Cardboard app**. Tap *Download the app*, then tap the download and allow installing from your browser. (It's also at `/cardboard.apk` on your Cardboard.)

## How it keeps your things safe

- It's a window on the dashboard, nothing more: sealing and opening happen in the dashboard page exactly as in a browser, and the app never holds a key.
- The app talks to the page through a message port that Android hands only to your Cardboard's address. Other sites open in your browser, never inside the app.
- **No backups and no phone-to-phone copies** of its storage, which holds this phone's device key. A new phone is paired, never copied.
- Only `https://` addresses. It only reads files you share to it (never `file://` paths), and only writes to *Downloads › Cardboard*.

The phone counts as a new device: pair it from a device you're signed in on (or use your recovery kit). In your device list it's “Cardboard app on Android”.

Face ID / fingerprint locks (passkeys) don't work inside apps like this yet; the phone's own screen lock guards it. If you want the fingerprint lock, use Cardboard in Chrome on that phone instead.

## Building it

```
android/build.sh
```

Needs a JDK (17 or newer), `curl`, `zip` and Node, on Linux or macOS. No Android Studio and no Gradle: it downloads aapt2, the Android framework, d8 and apksig once into `android/.tools` (checked against pinned hashes), and writes `android/build/cardboard.apk`.

It signs with `~/.cardboard/android-key.p12` (or `CARDBOARD_ANDROID_KEY`), made the first time. **Keep that file private and keep it**: Android installs an update over the app only if it's signed with the same key. With a new key, uninstall the old app first and pair the phone again.

Most changes don't need a new app at all: the app shows whatever your Cardboard serves, so updating Cardboard updates what you see. The app is kept as small as it can be so it rarely has to change, and anything that can be done in the page is done there. Cardboard asks people to update the app only when an older one stops working (`ANDROID_APP_NEEDED` in `public/app.js`); a newer one is there for new installs.
