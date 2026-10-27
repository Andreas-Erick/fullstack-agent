// Agent tools: Self-repair: health checks, helper apps, the log, bug reports.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const selfchange = require('../selfchange');
const store = require('../store');
const log = require('../logger');
const { obj, str, int } = require('./common');

module.exports = [
  {
    name: 'diagnose',
    group: 'mechanic',
    description: 'Run health checks on every part of yourself (brain, voice, speech input, vault, calendar, internet, self-modification, recent errors) with fixes. Run this first when something does not work.',
    parameters: obj({}),
    run: async () => require('../diagnostics').run(),
  },
  {
    name: 'read_app_log',
    group: 'mechanic',
    description:
      'Read your diagnostic log: what was heard and said, tool calls (with ms), approvals, session events, timings (sttMs, firstTextMs, sinceSpeechEndMs), errors with stack traces. Lines inside a request carry [turn=… conv=…]: find the failing line with level "error", then pass its turn id to see everything that request did. Each launch starts with "app start" and an "environment" line.',
    parameters: obj({
      lines: int('How many recent lines (default 120, up to 2000)'),
      filter: str('Only lines containing this text, e.g. "claude session", "speech-to-text" (optional)'),
      level: { type: 'string', enum: ['error', 'warn'], description: 'Only errors, or warnings and errors (optional)' },
      turn: str('Only lines of this turn id, e.g. "a1b2c3" (optional)'),
      since_minutes: int('Only the last N minutes (optional)'),
    }),
    run: async (a) => log.tail(a.lines || 120, a.filter || '', { level: a.level, turn: a.turn, sinceMin: a.since_minutes }),
  },
  {
    name: 'helper_app_start',
    group: 'mechanic',
    description:
      'Start one of your helper apps on this computer when it is not running: "voicestudio" (your natural voice) or "freellmapi" (a local brain). Only the app installed at its usual place or at the location the user set in Settings → Helper apps; nothing else can be started. Use it when the voice is unavailable or the user asks. Returns its status (running, starting, not_installed, remote, failed).',
    parameters: obj({ app: { type: 'string', enum: ['voicestudio', 'freellmapi'], description: 'Which app' } }, ['app']),
    run: async (a) => require('../helperapps').start(a.app, await store.getSettings(), { reason: 'agent' }),
  },
  {
    name: 'analyze_errors',
    group: 'mechanic',
    description:
      'Your log\'s warnings and errors grouped into distinct problems: how often each happened, first and last time, example turn ids, and the code locations (file:line in your source) from the stack traces. Start debugging here, then read_app_log with a turn id for the full story and code_read_file at the location. Also shows whether your last self-change started cleanly.',
    parameters: obj({ hours: int('How far back (default 24)') }),
    run: async (a) => {
      const groups = require('../errorinsight').fromLog({ sinceMs: (Number(a.hours) || 24) * 3600000, limit: 20 });
      const lastChange = await selfchange.lastVerification().catch(() => null);
      return { problems: groups.length ? groups : 'No warnings or errors in that period.', lastSelfChange: lastChange ? { change: lastChange.short, subject: lastChange.subject, state: lastChange.state, problems: lastChange.problems?.length } : 'none recorded' };
    },
  },
  {
    name: 'create_bug_report',
    group: 'mechanic',
    description:
      'Write a bug report file (environment, health checks, all errors of the last 24 h, the recent log, settings without secrets) when the user reports a problem you cannot fix right away, or asks for one. Include what happened in their words. Returns the file path; tell the user where it is.',
    parameters: obj({ what_happened: str('The problem, in the user\'s words') }),
    run: async (a) => require('../envinfo').bugReport(a.what_happened || ''),
  },
];
