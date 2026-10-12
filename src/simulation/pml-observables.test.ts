import { describe, it, expect } from 'vitest';
import { runPmlSim } from './pml-engine';
import { buildPmlTwinView, pmlSampleToSimState } from './pml-to-sim-state';
import { TWIN_SCHEMA_VERSION, type Twin, type Workstation } from '../domain/twin';
import type { ServiceDist } from './distributions';

/**
 * Targeted regressions for the four specific defects the queueing pivot fixed.
 * `queueing-convergence.test.ts` proves the simulator agrees with the theory;
 * this file pins the individual bugs so they can't quietly return.
 */

const exp = (m: number): ServiceDist => ({ kind: 'exp', mean: m });
let uid = 0;
const id = (p: string) => `${p}-${++uid}`;

/**
 * Source → Service → Sink, plus an oversized ResourcePool.
 *
 * The pool is the point: it is what made per-station utilisation wrong. A pool
 * of 20 units alongside a single 1-server Service is exactly the shape of a
 * real sewing line (one operator pool, many stations), and it is where the old
 * `busyMin / (pool.capacity · duration)` formula produced ~1/20th of the truth.
 */
function poolTwin(opts: { poolUnits: number; serviceMeanMin: number; lambdaPerHr: number }) {
  const deptId = id('dept');
  const lineId = id('line');
  const mk = (name: string, kind: string, params: Record<string, unknown>, x: number): Workstation =>
    ({
      id: id('ws'), deptId, lineId, catalogId: 'a_snls', name,
      position: { x, y: 0 }, rotation: 0, props: {},
      operation: { opId: null }, resources: { workersRequired: 1 }, kpiTargets: {},
      block: { kind, params },
    }) as unknown as Workstation;

  const source = mk('Source', 'Source', {
    arrivalDist: exp(60 / opts.lambdaPerHr),
    sourceRatePerHr: opts.lambdaPerHr,
    piecesPerAgent: 1,
  }, 0);
  const service = mk('Sew', 'Service', {
    cycleDist: exp(opts.serviceMeanMin),
    cycleS: opts.serviceMeanMin * 60,
    servers: 1,
    queueCapacity: 0,
  }, 1);
  const sink = mk('Sink', 'Sink', {}, 2);
  // ResourcePool blocks are referenced, not flowed — no connector.
  const pool = mk('Operators', 'ResourcePool', { capacity: opts.poolUnits }, 1);

  const chain = [source, service, sink];
  const connectors = chain.slice(0, -1).map((f, i) => ({
    id: id('c'), fromWsId: f.id, toWsId: chain[i + 1].id,
  }));

  const twin = {
    schemaVersion: TWIN_SCHEMA_VERSION, id: id('t'), name: 'pool-fixture',
    parentTwinId: null, isCanonical: false,
    createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(),
    gridW: 8, gridH: 4,
    departments: [{ id: deptId, name: 'Sewing Floor', kind: 'Sewing', color: 'blue', bounds: { x: 0, y: 0, w: 8, h: 4 } }],
    lines: [{ id: lineId, deptId, name: 'Line 1', color: 'blue' }],
    workstations: [...chain, pool],
    connectors,
    operators: [], assignments: [],
  } as unknown as Twin;

  return { twin, serviceId: service.id };
}

describe('per-station utilization is not divided by the whole operator pool', () => {
  // λ = 50/hr, μ = 60/hr ⇒ ρ ≈ 0.83, so the station is busy ~400 of 480 min.
  const { twin, serviceId } = poolTwin({ poolUnits: 20, serviceMeanMin: 1, lambdaPerHr: 50 });
  const result = runPmlSim({ twin, durationMin: 480, seed: 42, samplePeriodMin: 5 });
  const obs = result.blocks.get(serviceId)!;

  it('reports ~83 %, not ~4 %', () => {
    // Before the fix this was busyMin / (20 · 480) ≈ 0.042.
    expect(obs.utilization).toBeGreaterThan(0.75);
    expect(obs.utilization).toBeLessThan(0.92);
  });

  it('still exposes the pool-wide figure separately', () => {
    // The dept/line-pool number is genuinely useful — it just isn't this
    // station's utilisation. ~1/20th of the station figure here.
    expect(obs.poolUtilization).toBeGreaterThan(0.02);
    expect(obs.poolUtilization).toBeLessThan(0.08);
  });

  it('agrees with what the adapter reports to the UI', () => {
    // The Builder Inspector reads `BlockObserved.utilization` (persisted onto
    // the workstation as kpiObserved) while LiveSim and Reports read the
    // adapter's `StationView.utilization`. They used to disagree by ~20×,
    // so the same station showed two different numbers on two screens.
    const view = buildPmlTwinView(twin);
    const last = result.samples[result.samples.length - 1];
    const state = pmlSampleToSimState(view, last, result, result.samples);
    const station = state.stations.find((s) => s.wsId === serviceId)!;
    expect(Math.abs(station.utilization - obs.utilization)).toBeLessThan(0.02);
  });
});

describe('λ is the offered arrival rate, not the departure rate', () => {
  // Deliberately overload: λ = 90/hr against μ = 60/hr. A departure-rate λ
  // saturates at μ, so it could never exceed 60 — and ρ would read ≈ 1 by
  // construction while the real offered load is 1.5×.
  const { twin, serviceId } = poolTwin({ poolUnits: 20, serviceMeanMin: 1, lambdaPerHr: 90 });
  const result = runPmlSim({ twin, durationMin: 2_000, seed: 11, samplePeriodMin: 0 });
  const obs = result.blocks.get(serviceId)!;

  it('offered λ exceeds μ on an overloaded station', () => {
    expect(obs.lambdaOfferedPerHr).toBeGreaterThan(75);
  });

  it('throughput stays at or below μ — the two are different quantities', () => {
    expect(obs.throughputPerHr).toBeLessThanOrEqual(62);
    expect(obs.lambdaOfferedPerHr).toBeGreaterThan(obs.throughputPerHr * 1.2);
  });
});

describe('samples are JSON-serialisable', () => {
  const { twin } = poolTwin({ poolUnits: 4, serviceMeanMin: 1, lambdaPerHr: 40 });
  const result = runPmlSim({ twin, durationMin: 60, seed: 3, samplePeriodMin: 5 });

  it('round-trips through JSON without losing per-block data', () => {
    // `blocks` was a Map, which JSON.stringify silently flattens to {} — so a
    // completed run could not be persisted into a scenario or posted out of a
    // Web Worker. This is the property that makes both possible.
    const round = JSON.parse(JSON.stringify(result.samples)) as typeof result.samples;
    expect(round.length).toBe(result.samples.length);
    const before = result.samples[result.samples.length - 1];
    const after = round[round.length - 1];
    expect(Object.keys(after.blocks).length).toBe(Object.keys(before.blocks).length);
    expect(Object.keys(after.blocks).length).toBeGreaterThan(0);
    for (const [wsId, b] of Object.entries(before.blocks)) {
      expect(after.blocks[wsId].areaLq).toBeCloseTo(b.areaLq, 9);
      expect(after.blocks[wsId].arrivals).toBe(b.arrivals);
    }
  });
});

describe('warm-up truncation discards the transient', () => {
  const { twin, serviceId } = poolTwin({ poolUnits: 20, serviceMeanMin: 1, lambdaPerHr: 50 });
  const whole = runPmlSim({ twin, durationMin: 5_000, seed: 5, samplePeriodMin: 0 });
  const post = runPmlSim({ twin, durationMin: 5_000, seed: 5, samplePeriodMin: 0, warmupMin: 1_000 });

  it('narrows the observation window without restarting the run', () => {
    expect(whole.blocks.get(serviceId)!.observedMin).toBe(5_000);
    expect(post.blocks.get(serviceId)!.observedMin).toBe(4_000);
  });

  it('leaves the truncated run with fewer counted arrivals but the same rate', () => {
    const a = whole.blocks.get(serviceId)!;
    const b = post.blocks.get(serviceId)!;
    expect(b.arrivals).toBeLessThan(a.arrivals);
    // Same steady-state λ either way — truncation removes the transient, not
    // the workload. (If the queues had been reset too, the post-warm-up run
    // would have to re-approach steady state and these would diverge.)
    expect(Math.abs(b.lambdaOfferedPerHr - a.lambdaOfferedPerHr)).toBeLessThan(2);
  });
});
