import { describe, it, expect } from 'vitest';
import { runNaiduSelfCheck } from './queueing.selfcheck';

/**
 * Promotes the existing browser-console self-check into the automated suite:
 * every analytical KPI (ρ, Lq, Wq, L, W, P0) is checked against the published
 * answers in Naidu's Operations Research textbook, within the 2% relative
 * tolerance the self-check already uses (Naidu rounds aggressively).
 */
describe('analytical queueing KPIs · Naidu textbook cases', () => {
  const summary = runNaiduSelfCheck();

  it('runs a non-trivial number of textbook checks', () => {
    expect(summary.total).toBeGreaterThanOrEqual(20);
  });

  it('every metric matches the textbook within tolerance', () => {
    const failures = summary.results.filter((r) => !r.pass);
    expect(
      failures,
      failures
        .map((r) => `${r.id}·${r.metric}: expected ${r.expected}, got ${r.actual.toFixed(4)}`)
        .join('\n'),
    ).toHaveLength(0);
  });

  // Per-case visibility so a regression points at the exact metric.
  for (const r of summary.results) {
    it(`${r.id} (p${r.page}) · ${r.metric}`, () => {
      expect(
        r.pass,
        `expected ${r.expected}, got ${r.actual.toFixed(4)} (Δ ${r.delta.toFixed(4)}) — ${r.description}`,
      ).toBe(true);
    });
  }
});
