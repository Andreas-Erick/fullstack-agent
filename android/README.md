# Nexus for Android

The Android app for Nexus Agent (see `docs/ROADMAP-mobile.md`, step 4). It is a thin native shell
around the phone app your desktop already serves (`renderer/remote/`), so it always matches the
desktop version, plus what a web page can't do on Android:

- **Notifications while the app is closed** (switch in the app's menu): approvals with **Allow / Deny**
  buttons right in the notification, and replies to messages you sent from the phone. A small
  "Connected" notification stays while this is on; **Turn off** in it stops it. The connection goes
  straight to your desktop. No push service or server of ours is involved.
- **Talk tile** in Quick Settings and a **Talk** shortcut (long-press the icon): open the app and start
  listening; tap the mic to send. Needs the secure (https) address.
- **Share → Nexus** from any app puts the text in the message box.

What it never does: the app only loads your desktop's address (and the Cloudflare Access sign-in, if
you use Access); every other link opens in your browser. The device token is encrypted with a key in
the Android Keystore and app backups are off. No third-party libraries.

## Install

1. On the desktop: Settings → Remote access → turn it on, and set up a secure address (Cloudflare
   Tunnel or Tailscale) for use away from home and for push-to-talk.
2. Install the APK on the phone (allow "install unknown apps" for your browser or file manager once).
3. Open **Nexus**, enter the address shown on the desktop, then pair with the code from
   **Pair a device**. Or scan the QR code shown there with the camera, copy the link and paste it
   (or share it to Nexus) on the setup screen: the app connects and pairs in one step. A shared link
   is only filled in; you confirm the address with **Connect**.

## Build

Requires Android Studio (or its bundled JDK) and the Android SDK (compileSdk 37).

```sh
cd android
# Windows (Git Bash): export JAVA_HOME="$LOCALAPPDATA/Programs/Android Studio/jbr"
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` (not committed) points at the SDK: `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk`.

### Release build

A release APK must be signed with your own key (never commit it):

```sh
keytool -genkeypair -v -keystore nexus-release.jks -alias nexus -keyalg RSA -keysize 4096 -validity 10000
./gradlew assembleRelease
apksigner sign --ks nexus-release.jks --out nexus.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

Or let CI sign it: `.github/workflows/release.yml` builds the APK on every `v*` tag and attaches it to
the GitHub Release. Add the repository secrets `ANDROID_KEYSTORE_BASE64` (`base64 -w0 nexus-release.jks`),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` for a signed build (the
same variables as `NEXUS_KEYSTORE*` locally, see `app/build.gradle.kts`); without them it publishes a
debug-signed APK.

Debug builds allow inspecting the page from `chrome://inspect` (handy for development); release builds don't.

## Layout

- `MainActivity.java`: the WebView (locked to your address), first-run address screen, mic permission,
  share and Talk intents, and the `window.NexusAndroid` bridge (`setToken`, `clearToken`,
  `setBackground`, `backgroundEnabled`, `changeServer`). Each method only answers while your own
  page is loaded.
- `ConnectionService.java`: the optional background connection (`/api/events`) and notifications.
- `ApprovalReceiver.java`: Allow / Deny from a notification (`POST /api/approvals/:id`).
- `TalkTileService.java`: the Quick Settings tile.
- `Prefs.java`: settings and the Keystore-encrypted token.
