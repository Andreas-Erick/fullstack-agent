// Voice commands, handled locally (never sent to the model). They only trigger when spoken on their
// own, so the same words inside a normal sentence still go to the agent.
import { toast, api } from './util.js';
import { state, saveSettings } from './state.js';
import { speaker, setMicMode } from './voice.js';

const norm = (t) => t.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const COMMANDS = [
  { re: /^(go )?hands free( mode)?$/, run: async () => (await saveSettings({ stt: { micMode: 'open' } }), setMicMode('open'), 'Hands-free mode on. I’m listening.') },
  { re: /^(go back to |switch to )?push to talk( mode)?$/, run: async () => (await saveSettings({ stt: { micMode: 'ptt' } }), setMicMode('ptt'), `Push to talk. Hold ${state.settings.stt.pttKey} to speak.`) },
  { re: /^(switch to |use )?(the )?(deep|smart|big|thinking) model$/, run: async () => (await saveSettings({ llm: { modelMode: 'deep' } }), 'Switched to the deep model.') },
  { re: /^(switch to |use )?(the )?(fast|quick|small) model$/, run: async () => (await saveSettings({ llm: { modelMode: 'fast' } }), 'Switched to the fast model.') },
  { re: /^(switch to |use )?(the )?default model$/, run: async () => (await saveSettings({ llm: { modelMode: 'default' } }), 'Back to the default model.') },
  { re: /^stop asking( for permission)?$/, run: async () => (await saveSettings({ safety: { permissionMode: 'auto' } }), 'Okay — I’ll stop asking, except before changing my code after reading web pages or documents, and before running commands.') },
  { re: /^start asking( again)?( for permission)?$/, run: async () => (await saveSettings({ safety: { permissionMode: 'ask' } }), 'I’ll ask before changing my code, settings or deleting things.') },
  { re: /^(clear|new|reset) (the )?(session|conversation|chat)$/, run: async (ctx) => (ctx.newChat(), 'Fresh session.') },
  { re: /^(please )?close (the |this )?(document|pdf|image|picture|file|window)( please)?$/, run: async () => ((await api.docs.closePopup().catch(() => null)) ? 'Closed.' : 'No document is open.') },
  // Instant window controls for the latest document window ("make it full screen", "minimize the PDF").
  ...[
    [/^(make (it|the (document|pdf|image|file)) |go |show (it )?)?full ?screen( please)?$/, 'fullscreen', 'Full screen.'],
    [/^(exit|leave|close|end) full ?screen( please)?$|^(make it )?(smaller|normal size)$/, 'exit_fullscreen', 'Done.'],
    [/^minimi[sz]e (it|the (document|pdf|image|file|window))( please)?$/, 'minimize', 'Minimized.'],
    [/^(maximi[sz]e (it|the (document|pdf|image|file|window))|make (it|the (document|pdf|image)) bigger)( please)?$/, 'maximize', 'Maximized.'],
    [/^(restore|bring back|show) (it|the (document|pdf|image|file|window))( again)?( please)?$/, 'restore', 'Here it is.'],
  ].map(([re, state, reply]) => ({ re, run: async () => ((await api.docs.windowState(state).then(() => true, () => false)) ? reply : 'No document is open.') })),
  { re: /^stop (screen )?sharing( (my|the) screen)?( please)?$/, run: async () => ((await api.screen.state()).active ? (await api.screen.stop(), 'Stopped sharing your screen.') : 'Your screen is not being shared.') },
  { re: /^(show )?(the )?chat only( view)?$|^hide (the|your) face$/, run: async () => (await saveSettings({ ui: { chatLayout: 'chat' } }), '') },
  { re: /^(show )?(the )?(split|side by side)( view)?$/, run: async () => (await saveSettings({ ui: { chatLayout: 'split', showVisualizerInChat: true } }), '') },
  { re: /^(show )?(the |your )?face (view|only|big)$|^show (me )?your face$/, run: async () => (await saveSettings({ ui: { chatLayout: 'face' } }), '') },
  { re: /^zoom in$/, run: async () => (await saveSettings({ ui: { zoom: Math.min(2, (state.settings.ui.zoom || 1) + 0.1) } }), '') },
  { re: /^zoom out$/, run: async () => (await saveSettings({ ui: { zoom: Math.max(0.5, (state.settings.ui.zoom || 1) - 0.1) } }), '') },
  { re: /^(reset (the )?zoom|normal zoom)$/, run: async () => (await saveSettings({ ui: { zoom: 1 } }), '') },
  { re: /^(stop|quiet|be quiet|shut up|stop talking|cancel)$/, run: async (ctx) => (ctx.stop(), '') },
  { re: /^(mute|voice off)$/, run: async () => (await saveSettings({ voice: { autoSpeak: false } }), '') },
  { re: /^(unmute|voice on)$/, run: async () => (await saveSettings({ voice: { autoSpeak: true } }), 'Voice is back on.') },
];

/** Returns true if the transcript was a command (and handled). */
export async function tryCommand(text, ctx) {
  const t = norm(text);
  if (t.split(' ').length > 7) return false;
  const cmd = COMMANDS.find((c) => c.re.test(t));
  if (!cmd) return false;
  const reply = await cmd.run(ctx);
  if (reply) {
    toast(`🎙 ${reply}`);
    if (state.settings.voice.ttsEnabled) speaker.say(reply);
  }
  return true;
}
