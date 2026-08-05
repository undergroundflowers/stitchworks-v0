/**
 * Display formatters that read the user's selected date format from the
 * project store's `units` prefs. Components should call these instead of
 * hardcoding `toLocaleString()`, so the Settings page toggles actually
 * change what the user sees.
 *
 * Pure functions — pass the prefs in. React sites typically grab them via
 *   const { dateFormat } = useProject((s) => s.units);
 */

import type { UnitsPrefs } from '../store/project';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Format an ISO date / Date / parseable string in the project's selected
 *  date format. Time of day is appended in HH:MM (24-hour) when the input
 *  has non-zero time components. Falls back to ISO date if the input
 *  doesn't parse. */
export function formatDate(input: string | number | Date, format: UnitsPrefs['dateFormat']): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
  const datePart =
    format === 'DD/MM' ? `${day}/${m}/${y}` :
    format === 'MM/DD' ? `${m}/${day}/${y}` :
    `${y}-${m}-${day}`;
  return hasTime ? `${datePart} ${hh}:${mm}` : datePart;
}
