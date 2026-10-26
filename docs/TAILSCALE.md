# Using Siren from anywhere with Tailscale

This guide connects your phone to Siren on your computer from anywhere (home Wi-Fi, work, mobile data), encrypted, without opening a port on your router. It takes about ten minutes once. The app does most of it for you: **Settings → Remote access → Reach it from anywhere → Tailscale** shows a checklist that checks each step on your computer and has a button for the step that is missing.

## What Tailscale is, in one minute

- **Tailscale** is an app you install on each of your devices. Devices signed in to the **same Tailscale account** form a private network called your **tailnet**. They can reach each other wherever they are, through end-to-end encrypted connections (WireGuard). Nothing else on the internet can reach them through it. It is free for personal use.
- **MagicDNS** gives every device in your tailnet a name, like `my-pc.tail1234.ts.net`. On by default in new tailnets.
- **HTTPS certificates** let a device in your tailnet use a real `https://` address. Siren's phone app needs https: browsers and Android only allow the microphone (push-to-talk) on secure addresses. This is a one-time switch in your Tailscale account.
- **Tailscale Serve** is Tailscale's built-in forwarder on your computer: it answers `https://my-pc.tail1234.ts.net` with that certificate and passes the requests on to Siren (port 7823 by default). It is for **your tailnet only**. (Its sibling, *Funnel*, would publish to the whole internet; Siren never uses it.)

So the path is: **phone** → Tailscale → **your computer's Tailscale** → Serve → **Siren**.

## On your computer

1. **Siren:** Settings → Remote access → **Turn on remote access**. Under **Reach it from anywhere**, choose **Tailscale**. The checklist appears.
2. **Install Tailscale:** [tailscale.com/download](https://tailscale.com/download) (Windows, macOS). Open it and **sign in** (Google, Microsoft, Apple or GitHub account; this creates your tailnet). On Windows it sits in the system tray, on macOS in the menu bar; it should say *Connected*.
3. In Siren, click **Check again**. Step 3 now shows this computer's name, e.g. `my-pc.tail1234.ts.net`. If it says there is no name, turn on **MagicDNS** on [Tailscale's DNS page](https://login.tailscale.com/admin/dns).
4. **Enable HTTPS (once):** on [Tailscale's DNS page](https://login.tailscale.com/admin/dns), scroll to **HTTPS Certificates** and click **Enable**. (Step 4 has a button that opens the page. If you skip this, step 5 opens the page for you.)
5. **Set up Serve:** click **Set up Serve for me** (step 5). Siren runs `tailscale serve --bg --yes 7823` for you. If Tailscale answers that HTTPS isn't enabled yet, the page to enable it opens: click **Enable** there, then click the button again.
6. **Test:** step 6 opens the secure address from your computer, the way the phone will. ✓ means the computer side is done.

Serve stays set up across restarts; you do this once per computer.

## On your phone

7. Install **Tailscale** from the Play Store (or App Store) and sign in with the **same account** as the computer. Switch it on. Android shows a key icon / "VPN": that is Tailscale's private network. Your other apps keep using the internet normally; only connections to your own devices go through Tailscale.
8. Connect Siren:
   - **New phone:** on the computer, click **Pair a device**. In the QR code, choose the **🔒 secure address** and scan it with the phone's camera (or the Siren app's setup screen: paste the link). Or open the Siren app, type `https://my-pc.tail1234.ts.net` (your computer's name from step 3) and enter the six-digit code shown on the computer.
   - **Already paired over Wi-Fi:** open the Siren app at home and tap **Switch to the secure address** (in the banner or the ☰ menu). It moves there and keeps its pairing.

From then on the app works anywhere, as long as Tailscale is on on both devices and Siren is running on the computer.

## When it doesn't connect

| What you see | Why | What to do |
| --- | --- | --- |
| The phone says it can't reach `…ts.net` | Tailscale is off on the phone, or signed in to another account | Open the Tailscale app on the phone: it must say *Connected* and list your computer |
| Siren's step 6: "Couldn't open https://…ts.net (ECONNREFUSED)" | Serve isn't forwarding to Siren | Click **Set up Serve for me**. `tailscale serve status` in a terminal shows what Serve forwards |
| "Serve is not enabled on your tailnet" / a login.tailscale.com link opens | HTTPS certificates are off for the tailnet | Click **Enable** on that page, then **Set up Serve for me** again |
| Step 3 has no name | MagicDNS is off | Turn it on on [the DNS page](https://login.tailscale.com/admin/dns) |
| It worked, then stopped | The computer slept, Siren was closed, or Tailscale signed out | Wake the computer, start Siren, check Tailscale says *Connected* on both devices |
| "Access denied" when setting up Serve | On macOS/Linux, Tailscale needs permission for your user once | Run `sudo tailscale set --operator=$USER` in a terminal, then try again |
| Push-to-talk on the phone says it needs the secure address | The phone is on the plain Wi-Fi address | Tap **Switch to the secure address** |
| You changed Siren's port in Settings | Serve still forwards to the old port | Click **Set up Serve for me** again |

## Privacy

Traffic between your phone and computer is end-to-end encrypted by Tailscale; Tailscale's coordination servers see which of your devices are online, not what you send. Only devices in your tailnet can reach the address, and Siren still requires the device to be paired (a token checked on every request). Turn remote access off in Siren (the **Remote** badge in the title bar, one click) and nothing answers. To undo Serve: `tailscale serve reset`.
