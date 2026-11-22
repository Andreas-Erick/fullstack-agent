// Shapes that cross module boundaries, for type checking only (`npm run typecheck`, jsconfig.json).
// Nothing loads this file at run time. Use from JSDoc: @type {import('./types').Routine}.

/** routines.json schedule (routinecore.normalizeSchedule). Local time. */
export interface RoutineSchedule {
  kind: 'daily' | 'weekdays' | 'weekly' | 'interval';
  /** 'HH:MM', 24-hour (not for interval). */
  time?: string;
  /** 0 = Sunday … 6 = Saturday (weekly). */
  days?: number[];
  /** 1–168 (interval). */
  hours?: number;
}

/** A routine as stored in <userData>/routines.json (routinecore.normalize). */
export interface Routine {
  id: string;
  name: string;
  schedule: RoutineSchedule;
  instructions: string;
  enabled: boolean;
  notify: boolean;
  createdAt: number | string;
  lastRun: number | string;
  lastStatus: string;
  lastSummary: string;
  conversationId: string;
  /** routines.js: when a run waits for a brain or the internet. */
  retryAt?: number;
  retries?: number;
}

/** routinecore.check(): run now, skip a too-late missed run, or wait. */
export interface RoutineCheck {
  action: 'run' | 'skip' | 'wait';
  next: Date | null;
  /** The occurrence being run or skipped. */
  due?: Date;
}

/** settings.agent.personaSummary: the short master prompt for small local models (persona-synced). */
export interface PersonaSummary {
  text: string;
  /** Fingerprint of the master prompt it was written for (personacore.fingerprint). */
  for: string;
  /** 'user' (never replaced) or 'model'. */
  by: 'user' | 'model';
  /** The model that wrote it (by: 'model'). */
  model?: string;
  /** ms when it was written. */
  at?: number;
}

/** A repeat rule of a Schedule.md entry (schedulecore). */
export interface ScheduleRepeat {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  days?: number[];
  /** monthly/yearly: day of the month. */
  monthDay?: number;
  /** yearly: 1–12. */
  month?: number;
}

/** One entry of Schedule.md as schedulecore parses it. Dates are YYYY-MM-DD, times HH:MM. */
export interface ScheduleEntry {
  id: string;
  title: string;
  location?: string;
  notes?: string;
  /** The day of a one-off entry ('' for a repeating one). */
  date: string;
  /** The last day of a one-off entry spanning several days, else ''. */
  endDate: string;
  /** '' = all day. */
  start: string;
  end: string;
  /** null for a one-off entry. */
  repeat: ScheduleRepeat | null;
  /** Repeating entries: where the rule starts and ends ('' = open), and skipped dates. */
  from: string;
  until: string;
  except: string[];
}
