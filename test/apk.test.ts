import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cantRun, isAppFileName, partsFor, readAppFile, type Phone } from "../src/client/apk.ts";

const fixture = (name: string) => new Blob([readFileSync(new URL(`./fixtures/apps/${name}`, import.meta.url))]);
const SIGNER = "d6f8ea4142177c19aa582182fdc8e3506d56351ed37d3418ffe9956739c0f5ce";
const pixel: Phone = { abis: ["arm64-v8a", "armeabi-v7a", "armeabi"], dpi: 420, languages: ["is-IS", "en-US"], sdk: 35 };

describe("Android app files", () => {
  it("reads a plain APK: its name (from its resources), version and who signed it", async () => {
    const app = await readAppFile(fixture("trip.apk"));
    assert.equal(app.format, "apk");
    assert.equal(app.package, "is.example.trip");
    assert.equal(app.label, "Trip Planner");
    assert.equal(app.versionName, "2.1.0");
    assert.equal(app.versionCode, 42);
    assert.equal(app.minSdk, 26);
    assert.deepEqual(app.permissions, ["android.permission.INTERNET", "android.permission.CAMERA"]);
    assert.deepEqual({ ...app.signer }, { sha256: SIGNER, name: "Example Trips", scheme: "v2" });
    assert.equal((await readAppFile(fixture("trip.apk"), { languages: ["is"] })).label, "Ferðaplan", "in the phone's language when the app has it");
  });

  it("reads the old (v1, jar) signature too", async () => {
    const app = await readAppFile(fixture("trip-v1.apk"));
    assert.deepEqual({ ...app.signer }, { sha256: SIGNER, name: "Example Trips", scheme: "v1" });
  });

  it("reads an APKMirror bundle and picks the parts this phone needs", async () => {
    const app = await readAppFile(fixture("trip.apkm"));
    assert.equal(app.format, "apkm");
    assert.equal(app.label, "Trip Planner");
    assert.equal(app.signer?.sha256, SIGNER);
    assert.deepEqual(
      app.parts.map((p) => [p.file, p.kind, p.value]),
      [
        ["base.apk", "base", ""],
        ["split_config.arm64_v8a.apk", "abi", "arm64-v8a"],
        ["split_config.armeabi_v7a.apk", "abi", "armeabi-v7a"],
        ["split_config.is.apk", "language", "is"],
        ["split_config.mdpi.apk", "density", "mdpi"],
        ["split_config.xxhdpi.apk", "density", "xxhdpi"],
      ],
    );
    assert.deepEqual(
      partsFor(app, pixel).map((p) => p.file),
      ["base.apk", "split_config.arm64_v8a.apk", "split_config.xxhdpi.apk", "split_config.is.apk"],
    );
    assert.deepEqual(
      partsFor(app, { abis: ["armeabi-v7a"], dpi: 160, languages: ["de"], sdk: 30 }).map((p) => p.file),
      ["base.apk", "split_config.armeabi_v7a.apk", "split_config.mdpi.apk"],
      "an older phone gets its own processor and screen, and no language it doesn't speak",
    );
    assert.equal(cantRun(app, pixel), null);
    assert.match(cantRun(app, { ...pixel, sdk: 24 })!, /Android 8 or newer.*Android 7/);
    assert.match(cantRun(app, { ...pixel, abis: ["x86_64"] })!, /arm64-v8a, armeabi-v7a processors/);
  });

  it("reads an XAPK (packed), and leaves its game data out", async () => {
    const app = await readAppFile(fixture("trip.xapk"));
    assert.equal(app.format, "xapk");
    assert.equal(app.versionCode, 42);
    assert.deepEqual(app.extras, ["Android/obb/is.example.trip/main.42.is.example.trip.obb"]);
    assert.deepEqual(
      partsFor(app, pixel).map((p) => p.file),
      ["is.example.trip.apk", "config.arm64_v8a.apk", "config.xxhdpi.apk"],
    );
  });

  it("reads Cardboard's own app", async () => {
    const app = await readAppFile(new Blob([readFileSync(new URL("../public/cardboard.apk", import.meta.url))]));
    assert.equal(app.package, "io.github.gosinn.cardboard");
    assert.equal(app.label, "Cardboard");
    assert.ok(app.signer?.sha256.length === 64);
  });

  it("says plainly when a file isn't an app", async () => {
    await assert.rejects(readAppFile(new Blob(["just text"])), /isn't an Android app this can read: it isn't a zip/);
    assert.ok(isAppFileName("WhatsApp 2.24.apkm") && !isAppFileName("photo.jpg"));
  });
});
