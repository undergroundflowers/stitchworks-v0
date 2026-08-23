/**
 * Conformance tests for the probability formulas in Naidu's Unit 5.
 *
 * The existing self-check covers the *mean* measures (ρ, Lq, L, Wq, W, P₀, D).
 * These cover the rest of the textbook's questions — formulas 3, 4, 10, 11,
 * 12 and 13 — using the numeric answers the PDF prints for its own worked
 * problems, so a regression in the closed forms fails against the source of
 * truth rather than against our own arithmetic.
 *
 * Problem 1 (p.7–10): telephone booth. λ = 7.5/hr, μ = 15/hr, M/M/1.
 * Problem MS-2 (p.36): telephone exchange, K = 2, λ = 15/hr, μ = 12/hr.
 */

import { describe, expect, it } from 'vitest';
import { analyticalKpis, classify } from './queueing';
import type { ServiceDist } from './distributions';

/** μ per hour → the exponential service distribution in minutes. */
const expDist = (muPerHr: number): ServiceDist => ({ kind: 'exp', mean: 60 / muPerHr });

/** Naidu rounds to 2–3 significant figures; match that, not float equality. */
const near = (actual: number, expected: number, tol = 0.005) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe('Naidu Problem 1 (p.7) — M/M/1, λ=7.5/hr, μ=15/hr', () => {
  const dist = expDist(15);
  const k = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 7.5, dist);

  it('(a) ρ = 0.5 — fraction of the day in use', () => near(k.rho, 0.5));

  it('(g) P(arrival must wait) = 1 − P₀ = 0.5 [formula 10]', () => near(k.pWait, 0.5));

  it('(h) P₀ = 0.5 — exactly zero units in the system [formula 2]', () => near(k.P0, 0.5));

  it('(i) P₃ = 0.0625 — exactly 3 units in the system [formula 3]', () =>
    near(k.Pn(3), 0.0625));

  it('(j) P(need not wait) = P₀ = 0.5 [formula 13]', () => near(k.pNoWait, 0.5));

  it('(k) P(3 or more in system) = 0.5³ = 0.125 [formula 4]', () =>
    near(k.pNOrMore(3), 0.125));

  it('(l) P(wait in queue > 6 min) = 0.236 [formula 11]', () =>
    near(k.pWaitGreaterThan(6 / 60), 0.236));

  it('(m) P(more than 5 in system) = P(≥6) = 0.5⁶ = 0.015 [formula 4, n+1]', () =>
    near(k.pNOrMore(6), 0.015625));

  it('(o) P(time in system > 8 min) = e⁻¹ = 0.368 [formula 12]', () =>
    near(k.pSystemGreaterThan(8 / 60), Math.exp(-1)));

  it('formula 12 is NOT formula 11 — the system tail omits the λ/μ factor', () => {
    // Both evaluated at the same threshold: the queue tail carries ρ, the
    // system tail does not. A regression that aliased them would make these equal.
    expect(k.pWaitGreaterThan(8 / 60)).not.toBeCloseTo(k.pSystemGreaterThan(8 / 60), 3);
    near(k.pWaitGreaterThan(8 / 60), 0.5 * Math.exp(-1));
  });

  it('D = 2 — expected non-empty queue size [formula 9]', () => near(k.D, 2));
});

describe('Naidu Problem MS-2 (p.36) — M/M/2, λ=15/hr, μ=12/hr', () => {
  const dist = expDist(12);
  const k = analyticalKpis(classify(dist, 2, Infinity, 'FCFS'), 15, dist);

  it('P₀ = 0.230', () => near(k.P0, 0.23, 0.002));

  it('P₁ = 0.2875 [multi-server formula 2]', () => near(k.Pn(1), 0.2875, 0.002));

  it('(a) P(subscriber must wait) = 1 − P₀ − P₁ = 0.48 [formula 10, K=2]', () =>
    // The PDF computes this by summing the busy-server states; our Erlang-C
    // closed form must land on the same number.
    near(k.pWait, 0.48, 0.005));

  it('ρ = λ/(Kμ) = 0.625 [multi-server formula 7]', () => near(k.rho, 15 / 24));
});

describe('formula 4 — P(≥n) is consistent with Pₙ across models', () => {
  it('M/M/1: P(≥n) equals the tail sum of Pₙ', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 6, dist);
    let tail = 0;
    for (let n = 4; n < 400; n++) tail += k.Pn(n);
    near(k.pNOrMore(4), tail, 1e-6);
  });

  it('M/M/c: P(≥n) equals 1 minus the head sum of Pₙ', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 3, Infinity, 'FCFS'), 20, dist);
    let head = 0;
    for (let n = 0; n < 5; n++) head += k.Pn(n);
    near(k.pNOrMore(5), 1 - head, 1e-9);
  });

  it('P(≥0) is 1 for every model', () => {
    const dist = expDist(10);
    near(analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 5, dist).pNOrMore(0), 1);
    near(analyticalKpis(classify(dist, 3, Infinity, 'FCFS'), 20, dist).pNOrMore(0), 1);
    near(analyticalKpis(classify(dist, 1, 8, 'FCFS'), 5, dist).pNOrMore(0), 1);
  });
});

describe('formula 10/13 — P(wait) and P(no wait) are complements everywhere', () => {
  const dist = expDist(10);
  const cases = [
    ['M/M/1', classify(dist, 1, Infinity, 'FCFS'), 6],
    ['M/M/3', classify(dist, 3, Infinity, 'FCFS'), 20],
    ['M/M/1/8', classify(dist, 1, 8, 'FCFS'), 9],
    ['M/M/3/12', classify(dist, 3, 12, 'FCFS'), 28],
    ['M/D/1', classify({ kind: 'det', value: 6 }, 1, Infinity, 'FCFS'), 6],
  ] as const;

  for (const [name, notation, lambda] of cases) {
    it(`${name}`, () => {
      const d = notation.service === 'D' ? ({ kind: 'det', value: 6 } as ServiceDist) : dist;
      const k = analyticalKpis(notation, lambda, d);
      near(k.pWait + k.pNoWait, 1, 1e-9);
      expect(k.pWait).toBeGreaterThanOrEqual(0);
      expect(k.pWait).toBeLessThanOrEqual(1);
    });
  }
});

describe('Model III — SIRO shares Model I means but is flagged', () => {
  const dist = expDist(15);
  const fcfs = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 7.5, dist);
  const siro = analyticalKpis(classify(dist, 1, Infinity, 'SIRO'), 7.5, dist);

  it('L, Lq, W, Wq are identical under SIRO', () => {
    near(siro.L, fcfs.L, 1e-12);
    near(siro.Lq, fcfs.Lq, 1e-12);
    near(siro.W, fcfs.W, 1e-12);
    near(siro.Wq, fcfs.Wq, 1e-12);
  });

  it('carries the discipline and says the wait-time tails are FCFS values', () => {
    expect(siro.discipline).toBe('SIRO');
    expect(siro.note).toMatch(/SIRO/);
    expect(fcfs.discipline).toBe('FCFS');
  });
});

describe('finite capacity — balking probability is exposed', () => {
  it('M/M/1/N reports P_N as pBalk and reduces λ_eff by it', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, 5, 'FCFS'), 9, dist);
    near(k.pBalk, k.Pn(5), 1e-9);
    near(k.lambdaEff, 9 * (1 - k.pBalk), 1e-9);
  });

  it('unbounded models report zero balking', () => {
    const dist = expDist(10);
    expect(analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 5, dist).pBalk).toBe(0);
  });
});

describe('formula 9 — D is only reported where it is actually defined', () => {
  it('M/M/1 matches the textbook closed form μ/(μ−λ)', () => {
    const dist = expDist(15);
    const k = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 7.5, dist);
    near(k.D, 15 / (15 - 7.5));
    // And it agrees with the general definition it is a shortcut for.
    near(k.D, k.Lq / k.pNOrMore(2), 1e-9);
  });

  it('M/D/1 and M/Ek/1 report no D rather than the M/M/1 number', () => {
    // Lq differs per service shape, so a shared D would be inconsistent with
    // the Lq printed beside it. There is no elementary P(n ≥ 2) here.
    const det = analyticalKpis(
      classify({ kind: 'det', value: 6 }, 1, Infinity, 'FCFS'),
      8,
      { kind: 'det', value: 6 },
    );
    const erl = analyticalKpis(
      classify({ kind: 'erlang', k: 4, mean: 6 }, 1, Infinity, 'FCFS'),
      8,
      { kind: 'erlang', k: 4, mean: 6 },
    );
    expect(Number.isNaN(det.D)).toBe(true);
    expect(Number.isNaN(erl.D)).toBe(true);
    // The means they DO have are still distinct, which is why sharing a D was wrong.
    expect(det.Lq).not.toBeCloseTo(erl.Lq, 6);
  });

  it('M/M/1/N stays finite at ρ ≥ 1 — a capped buffer cannot diverge', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, 5, 'FCFS'), 12, dist); // ρ = 1.2
    expect(Number.isFinite(k.D)).toBe(true);
    // The queue is structurally capped at N − c = 4.
    expect(k.D).toBeGreaterThan(0);
    expect(k.D).toBeLessThanOrEqual(4);
  });

  it('M/M/1/N agrees with a brute-force E[Nq | Nq > 0]', () => {
    const dist = expDist(10);
    const N = 5;
    const k = analyticalKpis(classify(dist, 1, N, 'FCFS'), 8, dist);
    let num = 0;
    let den = 0;
    for (let n = 2; n <= N; n++) {
      num += (n - 1) * k.Pn(n);
      den += k.Pn(n);
    }
    near(k.D, num / den, 1e-9);
  });

  it('N = 1 gives D = 0, not a negative number from floating-point dust', () => {
    // A one-slot system can never form a queue. Lq and P(n ≥ 2) both collapse
    // to ~5e-17 of opposite sign, so a naive ratio returns −1.
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, 1, 'FCFS'), 8, dist);
    expect(k.D).toBe(0);
    expect(k.D).toBeGreaterThanOrEqual(0);
  });

  it('M/M/c/N conditions D on all c servers being busy', () => {
    const dist = expDist(10);
    const c = 3;
    const N = 9;
    const k = analyticalKpis(classify(dist, c, N, 'FCFS'), 25, dist);
    let num = 0;
    let den = 0;
    for (let n = c + 1; n <= N; n++) {
      num += (n - c) * k.Pn(n);
      den += k.Pn(n);
    }
    near(k.D, num / den, 1e-9);
  });
});

describe('λ = 0 is a state, not an error', () => {
  it('an idle station reports zero waits instead of NaN', () => {
    const dist = expDist(10);
    for (const notation of [
      classify(dist, 1, Infinity, 'FCFS'),
      classify(dist, 3, Infinity, 'FCFS'),
      classify({ kind: 'det', value: 6 }, 1, Infinity, 'FCFS'),
    ]) {
      const d = notation.service === 'D' ? ({ kind: 'det', value: 6 } as ServiceDist) : dist;
      const k = analyticalKpis(notation, 0, d);
      expect(Number.isFinite(k.Wq)).toBe(true);
      expect(Number.isFinite(k.W)).toBe(true);
      expect(k.Wq).toBe(0);
    }
  });
});

describe('finite capacity — P(wait) is conditioned on being admitted', () => {
  it('P(wait) + P(no wait) = 1 over admitted arrivals, excluding balks', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, 4, 'FCFS'), 14, dist); // heavy balking
    expect(k.pBalk).toBeGreaterThan(0.1);
    near(k.pWait + k.pNoWait, 1, 1e-9);
    // A balked arrival never waits, so P(wait) must be below the raw 1 − P₀.
    expect(k.pWait).toBeLessThan(1 - k.P0);
  });
});

describe('M/G/c reports only what Allen–Cunneen actually approximates', () => {
  it('blanks the distributional members but keeps the Erlang-C ones', () => {
    const d: ServiceDist = { kind: 'det', value: 6 };
    const k = analyticalKpis(classify(d, 3, Infinity, 'FCFS'), 20, d);
    // Means are approximated.
    expect(Number.isFinite(k.Lq)).toBe(true);
    expect(Number.isFinite(k.L)).toBe(true);
    // P0 / P(wait) come from the Erlang-C base the approximation is built on.
    expect(Number.isFinite(k.P0)).toBe(true);
    expect(Number.isFinite(k.pWait)).toBe(true);
    // State probabilities and waiting-time tails are NOT approximated —
    // reporting the M/M/c values for them would be inventing numbers.
    expect(Number.isNaN(k.Pn(2))).toBe(true);
    expect(Number.isNaN(k.pNOrMore(2))).toBe(true);
    expect(Number.isNaN(k.pWaitGreaterThan(0.1))).toBe(true);
    expect(Number.isNaN(k.pSystemGreaterThan(0.1))).toBe(true);
  });
});

describe('a finite-capacity model says when it is not the class it was asked for', () => {
  it('M/D/1 with a capped buffer admits it solved the exponential model', () => {
    const d: ServiceDist = { kind: 'det', value: 6 };
    const k = analyticalKpis(classify(d, 1, 6, 'FCFS'), 8, d);
    expect(k.note).toMatch(/no finite-capacity formula/i);
    expect(k.note).toMatch(/M\/M\/1\/6/);
  });

  it('M/M/1 with a capped buffer carries no such caveat', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, 6, 'FCFS'), 8, dist);
    expect(k.note ?? '').not.toMatch(/no finite-capacity formula/i);
  });
});

describe('λ offered vs λ admitted are distinct fields', () => {
  it('they differ exactly by the balking probability', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, 4, 'FCFS'), 14, dist);
    near(k.lambdaOffered, 14, 1e-9);
    near(k.lambdaEff, 14 * (1 - k.pBalk), 1e-9);
    expect(k.lambdaEff).toBeLessThan(k.lambdaOffered);
  });

  it('they are equal when nothing balks', () => {
    const dist = expDist(10);
    const k = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 6, dist);
    near(k.lambdaOffered, k.lambdaEff, 1e-12);
  });
});
