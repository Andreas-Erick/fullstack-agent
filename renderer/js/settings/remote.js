// Remote access: pairing devices, the secure address (Cloudflare, Tailscale), the watch.
import { api, el, escapeHtml, toastError, confirmDialog } from '../util.js';
import { state, saveSettings } from '../state.js';
import { qrCanvas } from '../qr.js';
import { connectPatch } from '../remotecore.js';
import { get, render } from './core.js';
import { text, toggle, select, field, card, showResult, debounceAfter, markAdvanced } from './fields.js';

export let refreshRemote = null;
export let refreshRemoteStatus = null;

// The watch behind a phone: which face it has (recorded when) and when it last asked.
const shortTime = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
};
const watchFaceLine = (d) => `⌚ Watch: ${d.faceAt ? `face from ${shortTime(d.faceAt)}` : 'face not sent yet'}${d.faceSentAt ? ` · last asked ${shortTime(d.faceSentAt)}` : ''}`;

const TUNNEL_STATE = (t) => {
  if (!t || t.mode === 'off') return '';
  if (t.error) return `✕ Secure address: ${t.error}`;
  if (t.connected && t.check === 'fail') return `⚠ Secure address ${t.url}: ${t.warning}`;
  if (t.connected) return `🔒 Secure address: ${t.url || 'connected'}${t.check === 'ok' ? ' · checked, it works' : t.check === 'checking' ? ' · checking…' : ''}`;
  return t.running ? '… Starting the secure address' : '';
};

// Tailscale, step by step (docs/TAILSCALE.md is the long version). Each step on this computer is
// checked live through the tailscale CLI (remote:detectTailscale) and the end-to-end check
// (remote:checkSecure); the step that is missing gets the button that fixes it. The phone's steps
// can't be checked from here, so they are explained.
const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
const TAILSCALE_GUIDE = 'https://github.com/Andreas-Erick/fullstack-agent/blob/main/docs/TAILSCALE.md';

function tailscaleGuide() {
  const box = el('div', { class: 'ts-guide' });
  const port = get('remote.port') || 7823;
  const step = (n, state, title, help, ...actions) =>
    el('div', { class: `ts-step ${state}` },
      el('span', { class: 'ts-num' }, state === 'ok' ? '✓' : state === 'fail' ? '✕' : String(n)),
      el('div', { class: 'ts-body' }, el('b', {}, title), el('div', { class: 'hint', html: help }), actions.length ? el('div', { class: 'row' }, ...actions) : ''),
    );
  const btn = (label, onclick, primary = false) => el('button', { class: `btn small ${primary ? 'primary' : ''}`, onclick }, label);
  const link = (label, url) => btn(label, () => api.shell.openExternal(url));
  const note = el('div', { class: 'test-result hidden' });

  async function draw() {
    box.replaceChildren(el('div', { class: 'muted' }, 'Checking Tailscale on this computer…'));
    const t = await api.remote.detectTailscale().catch((err) => ({ installed: false, error: err.message }));
    if (t.host && t.host !== get('remote.publicHost')) await saveSettings({ remote: { publicHost: t.host } });
    const remote = await api.remote.status().catch(() => ({}));
    const reach = remote.tunnel?.check; // 'ok' | 'fail' | 'checking' | ''
    const on = get('remote.enabled');
    const signedIn = t.installed && t.running && !t.error;
    const host = t.host || get('remote.publicHost') || 'your-pc.tailXXXX.ts.net';
    const steps = [
      step(1, on ? 'ok' : 'fail', 'Remote access is on',
        on ? 'Siren listens for paired devices on port ' + port + '.' : 'Turn on <b>Turn on remote access</b> at the top of this card first.'),
      step(2, t.installed ? 'ok' : 'fail', 'Tailscale is installed on this computer',
        t.installed ? 'Found it.' : 'Tailscale is a free app (for personal use) that connects your own devices to each other through an encrypted private network, from anywhere, without opening any port on your router. Install it on this computer, then come back and press <b>Check again</b>.',
        ...(t.installed ? [] : [link('⬇ Download Tailscale', TAILSCALE_DOWNLOAD)])),
      step(3, !t.installed ? '' : signedIn && t.host ? 'ok' : 'fail', 'Signed in, with a name for this computer',
        signedIn && t.host ? `This computer is <code>${t.host}</code> in your tailnet (your private Tailscale network).` : !t.installed ? 'After installing: open Tailscale and sign in (Google, Microsoft, Apple or GitHub account). Use the <b>same account</b> on the phone later.' : t.error || !t.running ? `Tailscale isn’t connected: open it (system tray / menu bar) and sign in, or click Connect. ${t.error ? `(${t.error})` : ''}` : 'Tailscale gave this computer no name: turn on <b>MagicDNS</b> on Tailscale’s DNS page (it gives every device a name like <code>my-pc.tail1234.ts.net</code>).',
        ...(signedIn && !t.host ? [link('🌐 Open the DNS page', TAILSCALE_DNS)] : [])),
      step(4, !signedIn ? '' : t.https ? 'ok' : 'fail', 'HTTPS is enabled for your tailnet (once)',
        t.https ? 'Tailscale can give this computer a real HTTPS certificate, which the phone needs (browsers allow the microphone only on https).' : 'One switch in your Tailscale account: on the DNS page, scroll to <b>HTTPS Certificates</b> and click <b>Enable</b>. It is free and only affects your own devices. (The next step can also open the exact page for you.)',
        ...(signedIn && !t.https ? [link('🌐 Open the DNS page', TAILSCALE_DNS)] : [])),
      step(5, !signedIn ? '' : t.serving ? 'ok' : t.serving === null ? '' : 'fail', 'Tailscale Serve forwards the address to Siren',
        t.serving ? `<code>https://${host}</code> leads to Siren on this computer, for your devices only (never the internet).` : `Serve is Tailscale’s built-in forwarder: it answers <code>https://${host}</code> with the HTTPS certificate and passes the requests to Siren (port ${port}). Click the button; if Tailscale asks you to enable HTTPS first, the page opens: click Enable there, then click the button again. (By hand: <code>tailscale serve --bg ${port}</code>.)`,
        ...(signedIn && !t.serving ? [btn('🔒 Set up Serve for me', async (e) => {
          e.target.disabled = true;
          showResult(note, true, 'Setting up Tailscale Serve…');
          const r = await api.remote.setupTailscale().catch((err) => ({ error: err.message }));
          if (r.enableUrl) {
            showResult(note, false, 'Tailscale wants HTTPS enabled for your tailnet first. The page opened in your browser: click Enable, then click “Set up Serve for me” again.');
            api.shell.openExternal(r.enableUrl);
          } else if (r.error) showResult(note, false, `✕ ${r.error}`);
          else {
            showResult(note, true, '✓ Serve is set up. Checking the address end to end…');
            await api.remote.checkSecure().catch(() => {}); // the status below shows how the check ended
            refreshRemoteStatus?.();
          }
          draw();
        }, true)] : [])),
      step(6, !t.serving ? '' : reach === 'ok' ? 'ok' : reach === 'fail' ? 'fail' : '', 'The secure address answers',
        reach === 'ok' ? `Opened <code>https://${host}</code> from this computer: it works.` : reach === 'fail' ? `${escapeHtml(remote.tunnel?.warning || 'It didn’t answer.')} Check that steps 1–5 are ✓ and that “Reach it from anywhere” above is set to Tailscale.` : 'Siren opens the address from this computer, the way the phone will.',
        ...(t.serving ? [btn('Test it', async () => (await api.remote.checkSecure().catch(toastError), refreshRemoteStatus?.(), draw()))] : [])),
      step(7, '', 'On the phone: Tailscale, same account, switched on',
        'Install <b>Tailscale</b> from the Play Store (or App Store), sign in with the <b>same account</b> as this computer, and switch it on (it shows as a VPN; that is Tailscale’s private network, your other apps keep using the internet normally). The phone then appears next to this computer in the Tailscale app.'),
      step(8, '', 'Connect the Siren app (or the phone’s browser)',
        `<b>New phone:</b> click <b>Connect my phone</b> at the top of this card; in the QR code choose the 🔒 secure address and scan it. In the Android app you can also type <code>https://${host}</code> on the first screen, then enter the six-digit code.<br><b>Already paired over Wi-Fi:</b> open the app at home and tap <b>Switch to the secure address</b> (it keeps the pairing). From then on it works anywhere, on mobile data too, as long as Tailscale is on on both devices.`),
    ];
    box.replaceChildren(
      el('div', { class: 'row' }, el('b', { style: { flex: '1' } }, 'Set up Tailscale, step by step'), btn('⟳ Check again', draw), link('📖 Full guide', TAILSCALE_GUIDE)),
      ...steps,
      note,
    );
  }
  draw();
  return box;
}

function tunnelFields() {
  const mode = get('remote.tunnel') || 'off';
  const fields = [
    select('remote.tunnel', 'Reach it from anywhere (HTTPS)', [
      ['off', 'Off'],
      ['quick', 'Temporary Cloudflare address — for testing'],
      ['cloudflare', 'My Cloudflare Tunnel (my own domain)'],
      ['tailscale', 'Tailscale (my devices only, end-to-end encrypted)'],
    ], { onChange: () => render() }),
  ];
  if (mode === 'quick') {
    fields.push(el('div', { class: 'hint warn' }, 'A random https://….trycloudflare.com address that changes every start. Anyone who finds it can reach the pairing screen, so pair right away and switch to your own tunnel for everyday use. Needs cloudflared installed (winget install Cloudflare.cloudflared).'));
  }
  if (mode === 'cloudflare') {
    fields.push(
      el('div', { class: 'hint', html: 'In the Cloudflare dashboard (Zero Trust → Networks → Tunnels): create a tunnel, add a public hostname pointing to <code>http://localhost:' + (get('remote.port') || 7823) + '</code>, and copy the token from the install command. Then protect the hostname with an Access application (Access → Applications) so you sign in before anything reaches this computer.' }),
      text('remote.tunnelToken', 'Tunnel token', { type: 'password', onChange: debounceAfter(refreshRemoteStatus) }),
      text('remote.publicHost', 'Public hostname', { placeholder: 'nexus.example.com', onChange: debounceAfter(refreshRemoteStatus) }),
      text('remote.accessTeam', 'Cloudflare Access team', { placeholder: 'myteam (from myteam.cloudflareaccess.com)' }),
      text('remote.accessAud', 'Access application AUD tag', { hint: 'With both set, the app also checks Cloudflare’s signed login on every request, so the Access sign-in can’t be skipped.' }),
    );
    if (!get('remote.accessTeam') || !get('remote.accessAud')) fields.push(el('div', { class: 'hint warn' }, 'Without Cloudflare Access, only the device token protects the address. Set up Access before relying on it.'));
  }
  if (mode === 'tailscale') {
    fields.push(
      el('div', { class: 'hint' }, 'Tailscale links your own devices (this computer and your phone) through a private, end-to-end encrypted network, from anywhere and without touching your router. Only devices signed in to your Tailscale account can reach Siren, and the phone gets a real https:// address, which push-to-talk needs.'),
      tailscaleGuide(),
      text('remote.publicHost', 'Tailscale address of this computer (filled in automatically)', { placeholder: 'my-pc.tail1234.ts.net', onChange: debounceAfter(refreshRemoteStatus) }),
    );
  }
  if (mode === 'quick' || mode === 'cloudflare') fields.push(text('remote.cloudflaredPath', 'cloudflared location (optional)', { placeholder: 'Found automatically' }));
  return fields;
}

// Everything for reaching Siren from outside the home network (tunnels, Cloudflare Access, cloudflared,
// Tailscale) and the port, folded away. An advanced block (Simple mode hides it; the search finds it and
// opens it), except while a secure address is in use: then it shows, open, in either mode.
function awayFromHome() {
  const inUse = (get('remote.tunnel') || 'off') !== 'off';
  const box = el('details', { class: 'ts-guide remote-away', open: inUse },
    el('summary', {}, 'Use it away from home (advanced)'),
    el('div', { class: 'hint' }, 'At home, “Connect my phone” is all you need. To use Siren on mobile data or another network, give it a secure https:// address through Tailscale or Cloudflare.'),
    ...tunnelFields(),
    text('remote.port', 'Port', { type: 'number', onChange: debounceAfter(() => refreshRemoteStatus?.()) }),
  );
  return markAdvanced(box, !inUse);
}

// VoiceStudio and FreeLLMAPI: Nexus starts the ones its settings use (main/helperapps.js).

export function remoteCard() {
  const statusBox = el('div', { class: 'hint' }, 'Checking…');
  const pairBox = el('div', { class: 'field hidden' });
  const devices = el('div', { class: 'health-list' });
  let pairTimer;
  const refresh = async () => {
    let st;
    try {
      st = await api.remote.status();
    } catch (err) {
      statusBox.textContent = err.message;
      return;
    }
    statusBox.textContent = st.error ? `✕ ${st.error}` : !st.enabled ? 'Off. Nothing is reachable from other devices.' : st.listening ? `Listening at ${st.urls.join(', ') || '(no network address found)'}` : 'Starting…';
    const t = st.enabled && TUNNEL_STATE(st.tunnel);
    if (t) statusBox.append(el('br'), t);
    devices.innerHTML = '';
    if (!st.devices.length) devices.append(el('div', { class: 'muted' }, 'No paired devices.'));
    for (const d of st.devices) {
      const seen = d.connected ? 'connected now' : d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : 'never used';
      const from = d.lastVia ? ` · via ${d.lastVia}${d.lastIp && d.lastVia !== 'this computer' ? ` (${d.lastIp})` : ''}` : '';
      const watch = d.watch ? watchFaceLine(d) : '';
      // The item is a three-column grid (light, text, actions): both buttons share the third column.
      devices.append(el('div', { class: `health-item ${d.connected ? 'ok' : 'off'}` },
        el('span', { class: 'ic' }, d.connected ? '●' : '○'),
        el('div', { style: { flex: 1 } }, el('b', {}, d.name, d.readOnly ? ' · view only' : ''), el('div', { class: 'd' }, `Paired ${new Date(d.createdAt).toLocaleDateString()} · ${seen}${from}`), watch ? el('div', { class: 'd' }, watch) : null),
        el('div', { class: 'row device-actions' },
          el('button', {
            class: 'btn small',
            title: d.readOnly ? 'Let this device chat and answer approvals again' : 'This device can only read: no chatting, approvals or push-to-talk (a shared tablet, a display)',
            onclick: async () => {
              await api.remote.setReadOnly(d.id, !d.readOnly).catch(toastError);
              refresh();
            },
          }, d.readOnly ? 'Allow full access' : 'Make view only'),
          el('button', {
            class: 'btn small danger',
            onclick: async () => {
              if (!(await confirmDialog('Remove device', `“${d.name}” will no longer be able to reach the assistant.`, 'Remove'))) return;
              await api.remote.revoke(d.id).catch(toastError);
              refresh();
            },
          }, 'Remove'),
        ),
      ));
    }
    if (st.devices.length > 1) {
      devices.append(el('div', { class: 'row' }, el('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!(await confirmDialog('Remove all devices', 'Every paired phone and computer loses access at once (for example if one was lost). Pair them again to use them.', 'Remove all'))) return;
          await api.remote.revokeAll().catch(toastError);
          refresh();
        },
      }, 'Remove all devices')));
    }
  };
  refreshRemote = () => {
    pairBox.classList.add('hidden');
    clearInterval(pairTimer);
    refresh();
  };
  const startPair = async () => {
    try {
      const p = await api.remote.pair();
      clearInterval(pairTimer);
      const left = el('span', { class: 'muted num' });
      const qrBox = el('div', { class: 'qr-box' });
      const tick = () => {
        const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
        left.textContent = s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'expired — start again';
        if (!s) {
          clearInterval(pairTimer);
          qrBox.replaceChildren(); // an expired code shouldn't stay on screen
        }
      };
      // The QR code opens the phone app and pairs it in one step. Prefer the secure address.
      const links = [...p.links].sort((a, b) => b.secure - a.secure);
      const showQr = (link) => {
        qrBox.replaceChildren(el('div', { class: 'qr' }, qrCanvas(link.link, { scale: 5 })), el('div', { class: 'hint' }, link.secure ? `Opens ${link.url} (encrypted).` : `Opens ${link.url}. Not encrypted: scan it on your home network only.`));
      };
      pairBox.innerHTML = '';
      if (links.length) {
        pairBox.append(el('label', {}, 'Scan with the phone’s camera'));
        if (links.length > 1) {
          const pick = el('select', { class: 'input', 'aria-label': 'Address the QR code opens', onchange: (e) => showQr(links[e.target.selectedIndex]) }, links.map((l) => el('option', {}, `${l.url}${l.secure ? ' (secure)' : ''}`)));
          pairBox.append(pick);
        }
        pairBox.append(qrBox);
        showQr(links[0]);
      } else {
        pairBox.append(el('div', { class: 'hint warn' }, 'No address another device can reach yet, so there is no QR code. Turn on “Reachable from other devices on my network”, or set up a secure address under “Use it away from home”.'));
      }
      pairBox.append(
        el('label', {}, links.length ? 'Or type this code' : 'Pairing code'),
        el('div', { class: 'row' }, el('b', { class: 'display', style: { fontSize: '28px', letterSpacing: '0.3em' } }, p.code), left),
        el('div', { class: 'hint' }, `On the device, open ${p.urls.join(' or ')} and enter this code. The code and the QR code work once, for one device.`),
        el('div', { class: 'row' }, el('button', {
          class: 'btn small',
          onclick: async () => {
            await api.remote.cancelPair().catch(() => {}); // the pairing code expires by itself
            refreshRemote();
          },
        }, 'Cancel')),
      );
      tick();
      pairTimer = setInterval(tick, 1000);
      pairBox.classList.remove('hidden');
    } catch (err) {
      toastError(err);
    }
  };
  // One click for a phone at home: turns on remote access (on the home network, unless a secure address is
  // set up) with today's defaults, then shows the pairing QR code. The save waits for the server to start
  // (settings:set settles its effects), so the code is made by a running server.
  const switches = el('div', { class: 'remote-switches' },
    toggle('remote.enabled', 'Turn on remote access', refresh),
    toggle('remote.lan', 'Reachable from other devices on my network (otherwise only from this computer)', refresh),
  );
  const connectBtn = el('button', { class: 'btn primary', onclick: () => connectPhone() }, '📱 Connect my phone');
  async function connectPhone() {
    connectBtn.disabled = true;
    try {
      const patch = connectPatch(get('remote'));
      if (patch) {
        await saveSettings(patch);
        for (const input of switches.querySelectorAll('input[data-setting]')) input.checked = Boolean(get(input.dataset.setting));
      }
      const st = await api.remote.status();
      if (st.error) {
        statusBox.textContent = `✕ ${st.error}`;
        return;
      }
      await startPair();
      refresh();
    } catch (err) {
      toastError(err);
    } finally {
      connectBtn.disabled = false;
    }
  }
  refreshRemoteStatus = refresh;
  refresh();
  return card(
    'remote',
    'Remote access',
    'Talk to the assistant from your phone (the Android app or any browser) or another computer. The brain, memory and keys stay on this computer; paired devices can chat, read conversations and answer approvals, never change settings. Remote messages never include a screenshot of this desktop. While it is on, a “Remote” badge shows at the top; click it to turn everything off.',
    el('div', { class: 'row' }, connectBtn),
    el('div', { class: 'hint' }, 'Shows a code to scan with the phone’s camera. Works at home, on the same Wi-Fi as this computer.'),
    pairBox,
    switches,
    toggle('remote.shareData', 'Show my notes, memories, learning and Inner World on paired devices (read-only)'),
    statusBox,
    el('div', { class: 'hint' }, 'On the home network the connection is not encrypted. Use it only at home or on another network you trust; a secure address (Use it away from home, below) is encrypted and also makes push-to-talk work on the phone.'),
    awayFromHome(),
    field('Paired devices', devices),
    watchGuide(),
  );
}

// Installing the Galaxy Watch app (also the vault note "Install on your Galaxy Watch", main/guides/).
function watchGuide() {
  const steps = [
    ['Before you start', 'The Siren phone app is paired with this computer, and the phone and watch apps come from the <b>same release</b> (they only talk to each other when signed with the same key). The watch and this computer are on the same Wi-Fi. On this computer you need Android’s <b>platform-tools</b> (the <code>adb</code> program; Android Studio includes it).'],
    ['On the watch', '<b>Settings → About watch → Software information</b>: tap <b>Software version</b> five times. Then <b>Settings → Developer options</b>: turn on <b>ADB debugging</b> and <b>Wireless debugging</b>, and tap <b>Pair new device</b>: it shows an address and a six-digit code. Keep the watch screen on (its Wi-Fi sleeps with the screen).'],
    ['On this computer', 'In a terminal: <code>adb pair &lt;address from Pair new device&gt;</code> (enter the code), <code>adb connect &lt;address on the Wireless debugging screen&gt;</code>, then <code>adb install Siren-Wear-x.y.z.apk</code> (from the same release as the phone app). Or ask Siren “install yourself on my watch”: with adb on this computer she runs these steps, each command with your approval.'],
    ['First start', 'Open Siren on the watch and keep the screen on for a moment: the first time it brings her face from this computer. For Allow / Deny on the wrist, turn on notifications in the phone app’s menu. Afterwards, turn Wireless debugging off on the watch.'],
  ];
  return el('details', { class: 'ts-guide' },
    el('summary', {}, '⌚ Install Siren on a Galaxy Watch (4 or newer)'),
    ...steps.map(([title, html], i) => el('div', { class: 'ts-step' }, el('b', {}, `${i + 1}. ${title}`), el('div', { class: 'hint', html }))),
    el('div', { class: 'hint' }, 'The full walkthrough, with what to do when something doesn’t work, is the note “Install on your Galaxy Watch” in your vault (Notes).'),
  );
}
