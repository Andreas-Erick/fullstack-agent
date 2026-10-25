// The title-bar meter for the Claude plan (main/claudeusage.js): the share left in the tightest window,
// with every window and its reset time in the tooltip. Shown while the Claude account brain is in use
// and `ui.showClaudeUsage` is on; it fills in after the first Claude reply.
import { $, api, on } from './util.js';
import { state } from './state.js';

let usage = null;

export function initUsage() {
  on('settings', render);
  api.on('claude:usage', (s) => ((usage = s), render()));
  api.claude.usage().then((s) => ((usage = s), render())).catch(() => {});
  setInterval(render, 60000); // reset times pass while the app is idle
}

function claudeInUse(s) {
  const p = s?.llm?.provider;
  if (p === 'claude-code') return true;
  return p === 'auto' && (s.routing?.order || []).includes('claude-code') && !(s.routing?.disabled || []).includes('claude-code');
}

const when = (sec) => {
  const d = new Date(sec * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

function render() {
  const pill = $('#pillUsage');
  const s = state.settings;
  const show = Boolean(usage?.windows?.length) && s?.ui?.showClaudeUsage !== false && claudeInUse(s);
  pill.classList.toggle('hidden', !show);
  if (!show) return;
  // The display takes the latest snapshot as is, except that a window whose reset time has passed is full again.
  const now = Date.now();
  const windows = usage.windows.map((w) => (w.resetsAt && w.resetsAt * 1000 <= now ? { ...w, left: 100, resetsAt: null } : w));
  const lowest = Math.min(...windows.map((w) => w.left));
  const tight = windows.find((w) => w.left === lowest);
  pill.querySelector('span').textContent = usage.limited && lowest === 0 ? `Claude: limit until ${when(tight.resetsAt)}` : `Claude ${lowest}%`;
  pill.querySelector('.usage-bar b').style.width = `${lowest}%`;
  pill.classList.toggle('low', lowest <= 20);
  pill.classList.toggle('mid', lowest > 20 && lowest <= 50);
  const lines = windows.map((w) => `${w.label[0].toUpperCase()}${w.label.slice(1)}: ${w.left}% left${w.resetsAt ? `, resets ${when(w.resetsAt)}` : ''}`);
  if (usage.overage) lines.push('Using extra usage (overage).');
  lines.push(`As of the last Claude reply (${new Date(usage.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). Turn this off in Settings → AI brain.`);
  pill.title = `Claude plan\n${lines.join('\n')}`;
}
