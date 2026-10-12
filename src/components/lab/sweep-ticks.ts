/**
 * Axis ticks for the Lab's sweep chart.
 *
 * Split out of `LabSweep.tsx` so it can be tested as what it is — pure
 * arithmetic — and because the bug it exists to prevent is invisible in a
 * screenshot until you read the labels. The chart used to place five ticks at
 * evenly-spaced fractions of the data maximum and print each through a fixed
 * two-decimal formatter. On a y-range of 0–0.02 that produced
 *
 *     0 · 0.01 · 0.01 · 0.02 · 0.02
 *
 * — two pairs of identical labels sitting on four different gridlines. An axis
 * that reports the same number at two heights is worse than no axis, because a
 * reader will believe it.
 *
 * The fix is two rules working together: ticks land on a rounded step off the
 * 1 / 2 / 5 ladder, and the printed precision is derived from that step rather
 * than fixed. Together they make a duplicate label unrepresentable.
 */

/**
 * Tick positions on a rounded step off the 1 / 2 / 5 ladder.
 *
 * `integral` forces a whole-number step, for the sweeps whose variable only
 * takes integers (servers, capacity) — a tick at 2.5 servers labels a value
 * the model cannot evaluate.
 *
 * `cover` decides what happens at the top of the range. The y-axis passes
 * `true`: it wants one tick at or past `hi` so the caller can extend the axis
 * to it and end on a labelled round ceiling. The x-axis passes `false`: its
 * domain is fixed by the sweep range the user typed, so a tick past `hi` would
 * be drawn outside the plot.
 */
export function niceTicks(
  lo: number,
  hi: number,
  target: number,
  integral: boolean,
  cover: boolean,
): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  if (integral) step = Math.max(1, Math.round(step));

  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-9) * step;
  const limit = cover ? hi + step / 2 : hi + step * 1e-9;
  // The 200 cap guards against a degenerate step; it is not a display choice.
  for (let v = first; v <= limit && out.length < 200; v += step) {
    // Re-snap through the step before rounding to 12 significant figures —
    // accumulating `v += step` drifts, and 0.30000000000000004 formats fine
    // but breaks the React key and any equality check downstream.
    out.push(Number((Math.round(v / step) * step).toPrecision(12)));
  }
  if (out.length === 0) out.push(lo);
  return out;
}

/**
 * Decimal places the gap between ticks actually needs.
 *
 * This is the half of the fix that makes duplicates impossible: precision is a
 * function of the step, so two ticks one step apart can never round to the
 * same string. Capped at 6 so a pathological step cannot produce an unreadable
 * label.
 */
export function decimalsFor(ticks: number[]): number {
  if (ticks.length < 2) return Number.isInteger(ticks[0] ?? 0) ? 0 : 2;
  const step = Math.abs(ticks[1] - ticks[0]);
  if (!(step > 0)) return 0;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));
}
