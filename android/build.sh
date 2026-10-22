#!/usr/bin/env bash
# Builds Cardboard for Android (android/build/cardboard.apk) without Android Studio or Gradle:
# aapt2 for the manifest and icon, javac, d8 for Android's bytecode, apksig to sign.
# The tools are downloaded once into android/.tools and checked against pinned hashes.
#
#   android/build.sh                 (Linux or macOS with a JDK 17+, curl and zip)
#
# It signs with CARDBOARD_ANDROID_KEY (a PKCS#12 file, default ~/.cardboard/android-key.p12),
# made the first time. Keep that file: an update installs over the app only if it's signed with
# the same key. Its password is CARDBOARD_ANDROID_KEY_PASSWORD (default "cardboard"; the file
# itself is the secret, so keep it somewhere private).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
version_name=$(node -p 'require("../package.json").version')
version_code=${CARDBOARD_ANDROID_VERSION_CODE:-1}
maven=${MAVEN_MIRROR:-https://repo1.maven.org/maven2}
tools=$here/.tools
build=$here/build
key=${CARDBOARD_ANDROID_KEY:-$HOME/.cardboard/android-key.p12}
password=${CARDBOARD_ANDROID_KEY_PASSWORD:-cardboard}
mkdir -p "$tools"

fetch() { # fetch <file> <url> <sha256>
  if [ ! -f "$tools/$1" ]; then
    echo "Downloading $1…"
    curl -fsSL --retry 3 -o "$tools/$1.part" "$2"
    mv "$tools/$1.part" "$tools/$1"
  fi
  echo "$3  $tools/$1" | sha256sum -c --quiet - || { echo "$1 isn't the expected file. Delete android/.tools and try again." >&2; exit 1; }
}
# aapt2 and the framework's resources ship inside apktool; the framework's classes (to compile
# against) inside Robolectric's android-all; d8 inside R8.
fetch apktool-lib.jar "$maven/org/apktool/apktool-lib/3.0.3/apktool-lib-3.0.3.jar" 983773879fd89ede2cd938858e3efce2a90ac1123f6a5140e9d949dcf4464e3e
fetch android-all.jar "$maven/org/robolectric/android-all/15-robolectric-13954326/android-all-15-robolectric-13954326.jar" e17105f6c432357e6bb278a527f8e848d01fc56ccee01be77725bea23d871990
fetch apksig.jar "$maven/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar" 9637078c0016244e4be0941836295365a7e2e5b164c59cb7885783c40460bfee
fetch r8lib.jar "https://storage.googleapis.com/r8-releases/raw/8.9.35/r8lib.jar" 204b2fc2b0f4e888dc0ef748b58090def1bf4185068d36abbb94841dbc7107a8
case "$(uname -s)" in
  Darwin) aapt2_path=prebuilt/macosx/aapt2 ;;
  *) aapt2_path=prebuilt/linux/aapt2 ;;
esac
if [ ! -x "$tools/$aapt2_path" ]; then
  (cd "$tools" && unzip -oq apktool-lib.jar "$aapt2_path" prebuilt/android-framework.jar && chmod +x "$aapt2_path")
fi
aapt2=$tools/$aapt2_path

rm -rf "$build"
mkdir -p "$build/classes" "$build/dex"

echo "Resources…"
"$aapt2" compile --dir res -o "$build/res.zip"
"$aapt2" link -o "$build/base.apk" -I "$tools/prebuilt/android-framework.jar" \
  --manifest AndroidManifest.xml --min-sdk-version 29 --target-sdk-version 35 \
  --version-code "$version_code" --version-name "$version_name" "$build/res.zip"

echo "Code…"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -cp "$tools/android-all.jar" -d "$build/classes" $(find src -name '*.java')
java -cp "$tools/r8lib.jar" com.android.tools.r8.D8 --release --min-api 29 --lib "$tools/android-all.jar" \
  --output "$build/dex" $(find "$build/classes" -name '*.class')
cp "$build/base.apk" "$build/unsigned.apk"
(cd "$build/dex" && zip -qj "$build/unsigned.apk" classes.dex)

if [ ! -f "$key" ]; then
  echo "Making a signing key at $key (keep it: updates need it)…"
  mkdir -p "$(dirname "$key")"
  keytool -genkeypair -keystore "$key" -storetype PKCS12 -storepass "$password" -alias cardboard \
    -keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA -validity 36500 -dname "CN=Cardboard for Android" >/dev/null
  chmod 600 "$key"
fi
# apksig 2.3 reaches into the JDK for algorithm names.
java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED -cp "$tools/apksig.jar" tools/Sign.java "$key" "$password" "$build/unsigned.apk" "$build/cardboard.apk"
echo "Built $build/cardboard.apk ($(du -h "$build/cardboard.apk" | cut -f1))"
