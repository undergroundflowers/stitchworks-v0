import { describe, it, expect } from 'vitest';
import { runPmlSim, type FlowEvent } from './pml-engine';
import { buildGarmentTwin } from '../domain/reference-twin';
import { GARMENT_TEMPLATES } from '../domain/garments';
import type { Twin } from '../domain/twin';

/**
 * P2 flow-event stream. Two contracts the rest of Phase 2 / Phase 3 lean on:
 *
 *  1. Recording is PURELY ADDITIVE — a run with `recordFlow` on must return
 *     byte-identical KPIs to the same run with it off (it never touches sim
 *     state or the RNG). This is what lets LiveSim animate a recorded run
 *     without the animation flag perturbing the numbers the Reports view shows.
 *  2. The stream is INTERNALLY CONSISTENT — non-decreasing in time, every
 *     event references a real block, and pieces are conserved end-to-end
 *     (Σ sink pieces === totalProduced).
 */

/** First garment template that carries an operation bulletin. */
function fixtureTwin(): Twin {
  for (const g of Object.values(GARMENT_TEMPLATES)) {
    if (g.operations.length > 0) {
      const operators = Math.max(2, Math.min(12, g.operations.length));
      const twin = buildGarmentTwin(g, operators);
      if (twin) return twin;
    }
  }
  throw new Error('no garment template with operations to build a fixture twin');
}

const DURATION = 240; // 4h — long enough to sink hundreds of pieces
const SEED = 12345;

describe('PML flow-event stream', () => {
  const twin = fixtureTwin();
  const wsIds = new Set(twin.workstations.map((w) => w.id));

  const baseline = runPmlSim({ twin, durationMin: DURATION, seed: SEED });
  const recorded = runPmlSim({ twin, durationMin: DURATION, seed: SEED, recordFlow: true });

  it('is off by default (empty stream, no cost)', () => {
    expect(baseline.flow).toEqual([]);
  });

  it('does not perturb KPIs (additive recording)', () => {
    expect(recorded.totalProduced).toBe(baseline.totalProduced);
    expect(recorded.piecesProducedFTR).toBe(baseline.piecesProducedFTR);
    expect(recorded.piecesScrapped).toBe(baseline.piecesScrapped);
    expect(recorded.throughputPerHr).toBeCloseTo(baseline.throughputPerHr, 10);
    expect(recorded.meanLeadTimeMin).toBeCloseTo(baseline.meanLeadTimeMin, 10);
  });

  it('records a non-empty stream for a flowing line', () => {
    expect(recorded.flow.length).toBeGreaterThan(0);
    // A live line seizes and releases servers.
    expect(recorded.flow.some((e) => e.kind === 'startService')).toBe(true);
    expect(recorded.flow.some((e) => e.kind === 'endService')).toBe(true);
    expect(recorded.flow.some((e) => e.kind === 'spawn')).toBe(true);
  });

  it('is ordered in time and bounded by the run window', () => {
    let prev = -Infinity;
    for (const e of recorded.flow) {
      expect(e.t).toBeGreaterThanOrEqual(prev);
      expect(e.t).toBeGreaterThanOrEqual(0);
      expect(e.t).toBeLessThanOrEqual(DURATION);
      prev = e.t;
    }
  });

  it('references only real blocks', () => {
    for (const e of recorded.flow) {
      expect(wsIds.has(e.wsId)).toBe(true);
      if (e.fromWsId !== undefined) expect(wsIds.has(e.fromWsId)).toBe(true);
      if (e.kind === 'move') expect(e.fromWsId).toBeDefined();
    }
  });

  it('conserves pieces — Σ sink pieces === totalProduced', () => {
    const sunk = recorded.flow
      .filter((e: FlowEvent) => e.kind === 'sink')
      .reduce((s, e) => s + e.pieces, 0);
    expect(sunk).toBe(recorded.totalProduced);
  });

  it('never releases more servers than it seized', () => {
    const started = recorded.flow.filter((e) => e.kind === 'startService').length;
    const ended = recorded.flow.filter((e) => e.kind === 'endService').length;
    // Some agents can still be in service at the cutoff, so ended ≤ started.
    expect(ended).toBeLessThanOrEqual(started);
    expect(ended).toBeGreaterThan(0);
  });

  it('honours maxFlowEvents and warns on truncation', () => {
    const capped = runPmlSim({
      twin,
      durationMin: DURATION,
      seed: SEED,
      recordFlow: true,
      maxFlowEvents: 5,
    });
    expect(capped.flow.length).toBeLessThanOrEqual(5);
    // KPIs still complete despite the truncated stream.
    expect(capped.totalProduced).toBe(baseline.totalProduced);
    expect(capped.warnings.some((w) => /truncat/i.test(w))).toBe(true);
  });
});
