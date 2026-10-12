/**
 * timeUnit — single conversion boundary between the three kinds of time
 * a simulation tool must distinguish (per *Big Book of Simulation Modelling*,
 * AnyLogic, Ch. 16):
 *
 *   1. Model time     — virtual sim clock, advances by event-jumps inside the
 *                       engine, measured in the chosen `ModelTimeUnit`.
 *   2. Calendar time  — model time projected onto a real-world `Date` via
 *                       `date(t) = startDate + t × unit`.
 *   3. Wall (real) time — the user's device clock. Related to model time only
 *                       through the playback hook's execution scale.
 *
 * Pure functions only. The engine doesn't import this module; the UI and the
 * useSim hook do. Keeping the converter outside the engine lets the engine
 * stay unit-agnostic.
 */

export type ModelTimeUnit = 'second' | 'minute' | 'hour' | 'day';

const SECONDS_PER: Record<ModelTimeUnit, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
};

/** Number of real seconds in one tick of the given model-time unit. */
export function unitToSeconds(unit: ModelTimeUnit): number {
  return SECONDS_PER[unit];
}

/** Convert a model time `t` (in `unit`) to a calendar Date anchored at `startISO`. */
export function timeToDate(t: number, unit: ModelTimeUnit, startISO: string): Date {
  const baseMs = Date.parse(startISO);
  if (Number.isNaN(baseMs)) return new Date(NaN);
  return new Date(baseMs + t * SECONDS_PER[unit] * 1000);
}

/** Inverse of timeToDate. Returns model time corresponding to a given Date. */
export function dateToTime(d: Date, unit: ModelTimeUnit, startISO: string): number {
  const baseMs = Date.parse(startISO);
  if (Number.isNaN(baseMs)) return 0;
  return (d.getTime() - baseMs) / 1000 / SECONDS_PER[unit];
}

/** Suffix shown next to numeric model time, e.g. "min". */
function unitShort(unit: ModelTimeUnit): string {
  switch (unit) {
    case 'second': return 's';
    case 'minute': return 'min';
    case 'hour':   return 'h';
    case 'day':    return 'd';
  }
}

/** "t = 83 min" — primary HUD format for model time. */
export function fmtModelTime(t: number, unit: ModelTimeUnit): string {
  if (!Number.isFinite(t)) return `t = — ${unitShort(unit)}`;
  // For minute-unit projects, promote to hours when t >= 60.
  if (unit === 'minute' && Math.abs(t) >= 60) {
    const h = Math.floor(t / 60);
    const m = Math.round(t - h * 60);
    return m === 0 ? `t = ${h} h` : `t = ${h}h ${m}m`;
  }
  if (unit === 'second' && Math.abs(t) >= 60) {
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return s === 0 ? `t = ${m} min` : `t = ${m}m ${s}s`;
  }
  const decimals = Math.abs(t) >= 10 ? 0 : 1;
  return `t = ${t.toFixed(decimals)} ${unitShort(unit)}`;
}

/** "83m" — compact format for axis labels and event-log rows. */
export function fmtModelCompact(t: number, unit: ModelTimeUnit): string {
  if (!Number.isFinite(t)) return `—${unitShort(unit)}`;
  if (unit === 'minute' && Math.abs(t) >= 60) {
    return `${(t / 60).toFixed(t >= 600 ? 0 : 1)}h`;
  }
  return `${Math.round(t)}${unitShort(unit)}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "Mon 18 May 2026 · 09:23" — calendar projection, honouring the user's date-format pref. */
export function fmtCalendar(
  t: number,
  unit: ModelTimeUnit,
  startISO: string,
  dateFormat: 'DD/MM' | 'MM/DD' | 'YYYY-MM-DD' = 'YYYY-MM-DD',
): string {
  const d = timeToDate(t, unit, startISO);
  if (Number.isNaN(d.getTime())) return '—';
  const dow = WEEKDAY_SHORT[d.getDay()];
  const day = pad2(d.getDate());
  const month = MONTH_SHORT[d.getMonth()];
  const year = d.getFullYear();
  const datePart =
    dateFormat === 'DD/MM' ? `${dow} ${day} ${month} ${year}`
    : dateFormat === 'MM/DD' ? `${dow} ${month} ${day} ${year}`
    : `${year}-${pad2(d.getMonth() + 1)}-${day} ${dow}`;
  return `${datePart} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Compact calendar for narrow rows (event log): "09:23 Mon 18 May". */
export function fmtCalendarCompact(
  t: number,
  unit: ModelTimeUnit,
  startISO: string,
): string {
  const d = timeToDate(t, unit, startISO);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${WEEKDAY_SHORT[d.getDay()]} ${pad2(d.getDate())} ${MONTH_SHORT[d.getMonth()]}`;
}

/** "14:42:17" — wall-clock HH:MM:SS for the device clock chip. */
export function fmtWallClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** ISO-style stamp for filenames: "2026-05-16_14-42-17". */
export function fmtWallClockFile(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

/**
 * Day-of-run derived from model time. DAY 1 starts at t = 0; rolls over every
 * `shiftDurationMin`. Anchored to model time (not wall-clock) so paused
 * sessions resume with the same day number — the user wanted this explicitly.
 */
export function simDayNumber(
  t: number,
  unit: ModelTimeUnit,
  shiftDurationMin: number,
): number {
  const tMin = (t * SECONDS_PER[unit]) / 60;
  return Math.max(1, Math.floor(tMin / Math.max(1, shiftDurationMin)) + 1);
}

/**
 * Percentage progress through the current shift, [0..100]. Resets at every
 * shift rollover.
 */
export function shiftProgressPct(
  t: number,
  unit: ModelTimeUnit,
  shiftDurationMin: number,
): number {
  const tMin = (t * SECONDS_PER[unit]) / 60;
  const inShift = tMin % Math.max(1, shiftDurationMin);
  return Math.min(100, (inShift / Math.max(1, shiftDurationMin)) * 100);
}

/**
 * Plain-language elapsed duration — "45 s", "5 min", "1h 20m".
 *
 * `fmtModelTime` writes the same instant as "t = 5.0 min", which is how a
 * modelling text writes it and not how anyone says it. This is the form for
 * surfaces read at a glance while the run is moving.
 */
export function fmtElapsed(t: number, unit: ModelTimeUnit): string {
  if (!Number.isFinite(t)) return '—';
  const secs = t * SECONDS_PER[unit];
  if (secs < 60) return `${Math.round(secs)} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h}h ${m}m`;
}

/** Parse "HH:MM" into total minutes-of-day. Returns 0 on malformed input. */
export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return h * 60 + min;
}

/** Format minutes-of-day as "HH:MM" (24h). */
export function fmtMinutesAsHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

