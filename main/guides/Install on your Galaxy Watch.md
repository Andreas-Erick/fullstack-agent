# Install {{name}} on your Galaxy Watch

{{name}} runs on the Galaxy Watch 4 and newer (Wear OS). On the watch you tap her and ask; the answer is spoken and shown on your wrist, with her face and colors. Today shows your schedule and habits, checked off with a tap. The watch asks **through the Siren app on your phone**, so the phone needs to be set up first.

The watch app isn't in the Play Store yet, so it is installed from your computer over Wi-Fi. It takes about five minutes, once.

## Before you start

- The **Siren phone app** is installed and connected to your computer (Settings → Remote access → Pair a device).
- The phone app and the watch app come from **the same release** (both `Siren-Android-x.y.z.apk` and `Siren-Wear-x.y.z.apk` from the same version on the [releases page](https://github.com/Andreas-Erick/fullstack-agent/releases)). They only talk to each other when signed with the same key.
- The watch and the computer are on **the same Wi-Fi**.
- On the computer: Android's **platform-tools** (the `adb` program). Download "SDK Platform-Tools" for your system from developer.android.com/tools/releases/platform-tools and unzip it anywhere. (If you have Android Studio, you already have it.)

## 1. On the watch: turn on debugging

1. **Settings → About watch → Software information**, tap **Software version** five times until it says developer mode is on.
2. **Settings → Developer options**: turn on **ADB debugging** and **Wireless debugging**.
3. Tap **Wireless debugging → Pair new device**. The watch shows an address (like `192.168.2.49:32929`) and a six-digit **pairing code**. Keep this screen open.

Tip: watches turn Wi-Fi off when the screen sleeps. Keep the screen on (tap it now and then) until the install is done.

## 2. On the computer: pair and install

Open a terminal in the platform-tools folder (and put the downloaded `Siren-Wear-x.y.z.apk` there), then:

```
adb pair 192.168.2.49:32929          (the address from "Pair new device"; it asks for the code)
adb connect 192.168.2.49:38539       (the address on the main Wireless debugging screen: another port)
adb install Siren-Wear-x.y.z.apk
```

On Windows type `.\adb` instead of `adb` if it says the command isn't found.

You can also ask {{name}}: "Install yourself on my watch". If adb is on the computer and she can run commands (each one asks your approval), she runs these steps for you; you only tell her the pairing code from the watch.

## 3. First start

1. Open **Siren** on the watch and keep the screen on for a moment: the first time, it fetches her face from your computer ("Bringing her face from your computer…"). After that it's on the watch and appears at once.
2. For **Allow / Deny on the wrist**, turn on "Notify me about approvals and replies while the app is closed" in the phone app's menu.
3. When you're done, turn **Wireless debugging** off again on the watch (Developer options).

## If something doesn't work

- **"Install the Siren app on your phone…"**: the phone app is missing, or comes from another release (different signature). Install both from the same release.
- **"Can't reach your phone"**: Bluetooth off, or the phone too far away.
- **"Open Siren on your phone and pair it…"**: the phone app isn't connected to the computer yet.
- **Only the glowing ring, no face**: keep Siren open on the watch for half a minute with the computer on; the note under the face says what's happening.
- **`adb connect` fails**: the watch's screen went off (Wi-Fi sleeps). Wake it and try again; the port on the Wireless debugging screen can change after a restart.
