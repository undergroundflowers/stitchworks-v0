import { describe, it, expect } from 'vitest';
import { buildStarterLine } from './starter-line';
import { GARMENT_TEMPLATES } from './garments';
import { getBlockKind } from './pml';
import { validateTwin } from './twin';
import { runPmlSim, validatePmlGraph } from '../simulation/pml-engine';
import { buildLinesFromTwin } from '../simulation/model-from-twin';

/**
 * The factory a fresh install boots into must actually simulate.
 *
 * The seed it replaced looked complete — five departments, two named lines —
 * but wired only 8 of the T-shirt bulletin's 27 operations and left the second
 * line an empty skeleton that `buildLinesFromTwin` rejected. The app therefore
 * opened onto a factory that could not produce a number, which is precisely
 * what "it feels broken without any sewing line builds" describes. These tests
 * exist so that can't silently happen again.
 */
describe('the starter line', () => {
  const twin = buildStarterLine();
  const garment = GARMENT_TEMPLATES.tshirt;
  const services = twin.workstations.filter((ws) => getBlockKind(ws) === 'Service');

  it('is a valid twin', () => {
    expect(validateTwin(twin)).toEqual([]);
  });

  it('wires EVERY operation in the bulletin, not a subset', () => {
    expect(services.length).toBe(garment.operations.length);
    const wiredOpIds = new Set(services.map((ws) => ws.operation.opId));
    for (const op of garment.operations) {
      expect(wiredOpIds.has(op.id)).toBe(true);
    }
  });

  it('has exactly one sewing line, and every station belongs to it', () => {
    expect(twin.lines.length).toBe(1);
    const lineId = twin.lines[0].id;
    for (const ws of twin.workstations) {
      expect(ws.lineId).toBe(lineId);
    }
  });

  it('staffs every station with a primary operator', () => {
    expect(twin.operators?.length).toBe(services.length);
    for (const ws of services) {
      const rows = (twin.assignments ?? []).filter((a) => a.wsId === ws.id);
      expect(rows.length).toBe(1);
      expect(rows[0].role).toBe('primary');
      expect(rows[0].shareFrac).toBe(1);
    }
  });

  it('passes the engine pre-flight with no errors', () => {
    const issues = validatePmlGraph(twin);
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('is recognised as a simulatable line', () => {
    // This is the check the old seed's Line B failed.
    const built = buildLinesFromTwin({
      twin,
      garmentsById: GARMENT_TEMPLATES,
      defaultGarmentId: garment.id,
    });
    expect(built.length).toBe(1);
    expect(built[0].ok).toBe(true);
  });

  it('produces pieces on a single shift', () => {
    const r = runPmlSim({ twin, durationMin: 480, seed: 42, samplePeriodMin: 5 });
    expect(r.totalProduced).toBeGreaterThan(0);
    expect(r.throughputPerHr).toBeGreaterThan(0);
    expect(r.meanLeadTimeMin).toBeGreaterThan(0);
    expect(r.samples.length).toBeGreaterThan(0);
  });

  it('runs the bottleneck hard but STABLE — queues settle instead of exploding', () => {
    // The arrival rate is sized off the bottleneck operation, so ρ < 1
    // everywhere and every observable converges. The previous sizing offered
    // 289 pcs/hr to a line capped at 86, which meant unbounded WIP growth: the
    // charts never settled and no analytical Lq existed to compare against.
    const r = runPmlSim({
      twin,
      durationMin: 4_000,
      seed: 7,
      samplePeriodMin: 0,
      warmupMin: 1_000,
    });
    const serviceObs = services.map((ws) => r.blocks.get(ws.id)!);

    for (const o of serviceObs) {
      expect(o.utilization).toBeLessThan(1);
    }
    // The busiest station should be meaningfully loaded — a starter line that
    // idles teaches the user nothing about queueing.
    const peak = Math.max(...serviceObs.map((o) => o.utilization));
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(0.98);

    // Stability check: WIP at the busiest station is finite and modest rather
    // than growing with run length.
    const peakLq = Math.max(...serviceObs.map((o) => o.LqObserved));
    expect(Number.isFinite(peakLq)).toBe(true);
    expect(peakLq).toBeLessThan(200);
  });

  it('keeps the line loaded for the whole of a long analysis run', () => {
    // An idle line has no steady state — every observable decays toward zero
    // as dead time fills the observation window. This used to be a real risk:
    // the Source ran a finite order sequence and stopped once it was
    // exhausted. Sources are unbounded now, so the guarantee is structural,
    // and this pins it: emission must scale with run length rather than
    // plateauing partway through.
    const source = twin.workstations.find((ws) => getBlockKind(ws) === 'Source')!;
    const short = runPmlSim({ twin, durationMin: 1_000, seed: 3, samplePeriodMin: 0 });
    const long = runPmlSim({ twin, durationMin: 10_000, seed: 3, samplePeriodMin: 0 });
    const shortEmitted = short.blocks.get(source.id)!.produced;
    const longEmitted = long.blocks.get(source.id)!.produced;
    expect(shortEmitted).toBeGreaterThan(0);
    // 10× the run should emit close to 10× the pieces. Allow slack for
    // back-pressure, but a Source that quit early would fall far short.
    expect(longEmitted).toBeGreaterThan(shortEmitted * 8);
  });

  it('gives the operator pool enough units not to be the constraint', () => {
    // Pools are keyed per line, and the pool is sized to the operator target.
    // If it were undersized, stations would queue on operators rather than on
    // their own service time and every ρ̂ would be wrong.
    const pool = twin.workstations.find((ws) => getBlockKind(ws) === 'ResourcePool');
    expect(pool).toBeDefined();
    expect(pool!.lineId).toBe(twin.lines[0].id);
    expect(pool!.block?.params?.capacity).toBeGreaterThanOrEqual(services.length);
  });
});
