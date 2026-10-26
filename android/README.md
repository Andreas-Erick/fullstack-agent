# Siren for Android

The Android app for Siren Assistant (formerly Nexus Agent; the package id stays `com.nexusagent.android` so updates install over it) (see `docs/ROADMAP-mobile.md`, step 4). It is a thin native shell
around the phone app your desktop already serves (`renderer/remote/`), so it always matches the
desktop version: the chat with the face and voice, and tabs for **Today** (schedule, habits, priorities, cards due, where you left off), **Habits** (check them off), **Learn** (topics and decks), and under **More** the schedule, memory and the memory stream, your notes, the skill tree, the Inner World (the same village, drag and pinch, tap a building), and skills and routines. Plus what a web page can't do on Android:

- **Notifications while the app is closed** (switch in the app's menu): approvals with **Allow / Deny**
  buttons right in the notification, and replies to messages you sent from the phone. A small
  "Connected" notification stays while this is on; **Turn off** in it stops it. The connection goes
  straight to your desktop. No push service or server of ours is involved.
- **Talk tile** in Quick Settings and a **Talk** shortcut (long-press the icon): open the app and start
  listening; tap the mic to send. Needs the secure (https) address.
- **Share → Siren** from any app puts the text in the message box.

What it never does: the app only loads your desktop's address (and the Cloudflare Access sign-in, if
you use Access); every other link opens in your browser. The device token is encrypted with a key in
the Android Keystore and app backups are off. The only library is Google's Wear Data Layer (for the watch app); nothing else from third parties.

## Galaxy tablets and Samsung DeX

The same app, laid out for big screens: on a tablet (upright or sideways), in DeX and in large split-screen or pop-up windows, the chat and Siren's face sit on the left and the screen you pick (Today, Habits, Learn, the Inner World…) on the right, both at once. It follows rotation, split screen and window resizing. With a keyboard (Book Cover, DeX): Enter sends, Shift+Enter makes a new line, Ctrl+1–4 switch the tabs, Ctrl+K starts a new chat. Phones turned sideways keep the one-column layout.

## Galaxy Watch (Wear OS)

`android/wear` is a small watch app for the Galaxy Watch 4 and newer (Wear OS 3+; the older Tizen watches can't run it). Tap Siren to ask by voice: the question goes **through the Siren app on your phone** (Bluetooth, Google's Wear Data Layer) to your computer, and the answer is spoken by the watch and shown on it. **Today** shows what's still coming on your schedule and your habits; tap one to check it off. **New chat** starts a fresh conversation (the watch keeps its own, apart from the phone's).

- **Nothing to pair on the watch:** it uses the phone's pairing. The phone app must be installed and connected to your computer. It works wherever the phone works, including over the phone's Tailscale.
- **App lock (phone):** in the app's menu, "Lock Siren with fingerprint, face or screen lock" asks for the phone's own unlock when the app opens and after 30 seconds away; the app is then also hidden from screenshots and the recent-apps preview. It needs a screen lock on the phone. Shares and push-to-talk wait until you unlock.
- **Approvals on the wrist:** turn on "Notify me about approvals and replies while the app is closed" in the phone app's menu. The phone's Allow / Deny notifications then appear on the watch by themselves.
- **Install:** the watch app isn't in the Play Store yet, so it is installed from a computer with adb. On the watch: Settings → About watch → Software → tap *Software version* five times (developer options), then Settings → Developer options → **ADB debugging** and **Wireless debugging** on → *Pair new device*. On the computer (Android SDK platform-tools): `adb pair <ip>:<port>` with the code shown, `adb connect <ip>:<port>`, then `adb install Siren-Wear-x.y.z.apk`.
- **Install both from the same release:** the phone and watch apps must be signed with the same key to talk to each other (both `-debug` or both signed).
- **The persona on the wrist:** the watch shows the active persona's name and colors, her face (built-in or your custom one: the computer records it as short loops per state, sent once and again only when the face, theme or name changes) and speaks in her voice when the computer has one; otherwise the watch's own voice.
- What the watch shows says what to do when something is missing: the phone out of reach, the Siren phone app not installed or not paired, or the computer not answering.
- **Security:** the watch app has no internet permission; it only talks to the Siren phone app, which accepts only the watch app signed with the same key, checks each message's size and allows 30 requests a minute.

### Trying the watch app in the emulator

Android Studio's SDK Manager (or `sdkmanager "system-images;android-36;android-wear-signed;x86_64"`) installs a Wear OS 6 image; `avdmanager create avd -n SirenWatch -k "system-images;android-36;android-wear-signed;x86_64" -d wearos_large_round` creates a round watch. Start it, finish or skip the watch's own setup, then `adb install wear/build/outputs/apk/debug/wear-debug.apk`. Without a paired phone emulator it shows how to set up the phone; to try the whole path, pair a phone emulator with the Wear OS app as described in Google's "Connect a watch to a phone" guide.

## Tailscale (the secure address from anywhere)

If the app can't reach `https://<your-pc>.<tailnet>.ts.net`, the usual causes are on the computer, not the phone: Tailscale Serve isn't forwarding the address to Siren, or HTTPS isn't enabled for your tailnet yet. On the desktop, **Settings → Remote access → Tailscale** shows a checklist that checks each step and fixes what is missing (**Set up Serve for me**; enabling HTTPS once). Step by step, with troubleshooting: [docs/TAILSCALE.md](../docs/TAILSCALE.md). On the phone, the Tailscale app must be connected with the same account.

## Install

1. On the desktop: Settings → Remote access → turn it on, and set up a secure address (Cloudflare
   Tunnel or Tailscale) for use away from home and for push-to-talk.
2. Install the APK on the phone (allow "install unknown apps" for your browser or file manager once).
3. Open **Siren**, enter the address shown on the desktop (with Tailscale: turn Tailscale on on the phone and use `https://<your-pc>.<tailnet>.ts.net`), then pair with the code from
   **Pair a device**. Or scan the QR code shown there with the camera, copy the link and paste it
   (or share it to Siren) on the setup screen: the app connects and pairs in one step. A shared link
   is only filled in; you confirm the address with **Connect**.
4. Paired over Wi-Fi first? When the computer has a secure address, the app shows **Switch**: one tap
   moves it there and keeps the pairing (`moveTo` in the bridge).

The app also has a **Schedule** screen (calendar button in the header): the week, the chosen day as a
timeline and what's next, read from the computer; new entries go through the assistant.

## Build

`./gradlew assembleDebug` builds both apps: `app/build/outputs/apk/debug/app-debug.apk` (phones and tablets) and `wear/build/outputs/apk/debug/wear-debug.apk` (the watch). Both use only the Android framework plus Google's Wear Data Layer (`play-services-wearable`), the one library, for the phone–watch link.


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
  `setBackground`, `backgroundEnabled`, `changeServer`, `moveTo`). Each method only answers while your own
  page is loaded.
- `ConnectionService.java`: the optional background connection (`/api/events`) and notifications.
- `ApprovalReceiver.java`: Allow / Deny from a notification (`POST /api/approvals/:id`).
- `TalkTileService.java`: the Quick Settings tile.
- `Prefs.java`: settings and the Keystore-encrypted token.
