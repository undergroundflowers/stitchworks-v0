import { describe, expect, it } from 'vitest';
import { decimalsFor, niceTicks } from './sweep-ticks';

/** What the axis actually prints, which is the thing the bug was about. */
function labels(ticks: number[]): string[] {
  const d = decimalsFor(ticks);
  return ticks.map((v) => v.toFixed(d));
}

describe('niceTicks + decimalsFor — no axis ever prints the same label twice', () => {
  // The exact case from the report: a Capacity sweep whose Lq range was
  // 0–0.02 rendered "0 · 0.01 · 0.01 · 0.02 · 0.02".
  it('separates a 0–0.02 range instead of collapsing it to two decimals', () => {
    const ticks = niceTicks(0, 0.02, 5, false, true);
    expect(labels(ticks)).toEqual(['0.000', '0.005', '0.010', '0.015', '0.020']);
  });

  const RANGES: [number, number, boolean][] = [
    [0, 0.02, false],
    [0, 0.0007, false],
    [0, 1, false],
    [0, 3.7, false],
    [0, 1250, false],
    [0.1, 39, false],
    [1, 8, true],
    [1, 40, true],
    [2, 3, true],
  ];

  it.each(RANGES)('range %f–%f (integral=%s) has all-distinct labels', (lo, hi, integral) => {
    const ticks = niceTicks(lo, hi, 6, integral, false);
    const printed = labels(ticks);
    expect(new Set(printed).size).toBe(printed.length);
  });

  it('uses a whole-number step when the swept variable is integral', () => {
    for (const t of niceTicks(1, 40, 6, true, false)) {
      expect(Number.isInteger(t)).toBe(true);
    }
  });

  it('cover=false keeps every tick inside the domain', () => {
    // 0.1–39 wants a step of 10, whose next tick (40) is past the domain.
    const ticks = niceTicks(0.1, 39, 6, false, false);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(39);
  });

  it('cover=true reaches at or past the top so the axis ends on a round tick', () => {
    const ticks = niceTicks(0, 3.7, 5, false, true);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(3.7);
  });

  it('lands on exact steps rather than float-drifted ones', () => {
    // 0.1 + 0.1 + 0.1 === 0.30000000000000004 if you just accumulate.
    expect(niceTicks(0, 1, 10, false, true)).toContain(0.3);
  });

  it('degrades safely on a zero-width or non-finite range', () => {
    expect(niceTicks(5, 5, 5, false, true)).toEqual([5]);
    expect(niceTicks(0, Number.NaN, 5, false, true)).toEqual([0]);
    expect(niceTicks(0, Number.POSITIVE_INFINITY, 5, false, true)).toEqual([0]);
  });

  it('caps precision so a pathological step cannot produce an unreadable label', () => {
    expect(decimalsFor([0, 1e-12])).toBe(6);
  });
});
