import { describe, it, expect } from 'vitest';
import { runPmlSim, type BlockObserved } from './pml-engine';
import { analyticalKpis, classify, type QueueDiscipline } from './queueing';
import { TWIN_SCHEMA_VERSION, type Twin, type Workstation } from '../domain/twin';
import type { ServiceDist } from './distributions';

/**
 * THE acceptance gate for the queueing pivot.
 *
 * `queueing.test.ts` already checks the closed-form layer against textbook
 * values, and the flow/blocking suites check that the DES conserves pieces and
 * respects buffers. Nothing checked the one property the whole product rests
 * on: that the SIMULATOR agrees with the THEORY. That gap is why a family of
 * defects survived — λ taken from the departure stream, ρ̂ built from an
 * instantaneous slot count, Wq derived by rearranging Little's law rather than
 * measured, N read from the wrong field so M/M/c/N never fired. Every one of
 * those produces plausible-looking numbers and a systematic bias.
 *
 * Each case below builds a station whose exact analytical answer is known,
 * runs it long with the transient truncated, and asserts the measured value
 * lands within a stated tolerance of the closed form.
 */

// Long enough for the tail of Lq to settle; the engine is fast (pure TS, no
// allocation per event beyond the agent) so this is ~milliseconds per seed.
const DURATION = 20_000;
const WARMUP = 2_000;
const SEEDS = [1, 2, 3, 4, 5];

function exp(meanMin: number): ServiceDist {
  return { kind: 'exp', mean: meanMin };
}

interface StationSpec {
  /** Mean service time per server, MINUTES. */
  serviceMeanMin: number;
  /** Parallel servers c. */
  servers: number;
  /** System capacity N = waiting + in service. Omit for unbounded. */
  capacity?: number;
}

let uid = 0;
function id(prefix: string): string {
  return `${prefix}-${++uid}`;
}

/**
 * Build `Source → [Service]ⁿ → Sink` with EXACT M/M/c parameters.
 *
 * This helper exists because `buildGarmentTwin` cannot express a textbook
 * queue: it derives cycles from bulletin SMVs, binds operations, and picks an
 * operator count. Six traps it is specifically written to avoid — each one
 * silently turns the fixture into a DIFFERENT queueing system whose numbers
 * still look reasonable:
 *
 *  1. The operator pool caps concurrency (`tryStartService` refuses when
 *     pool.busy >= pool.capacity), so pool capacity must be >= Σ servers.
 *     Here: no ResourcePool block at all, so no pool constraint exists.
 *  2. Arrivals must be Poisson — `arrivalDist` exponential. Without it the
 *     Source emits on a deterministic lattice and the model is D/M/1.
 *  3. Service must be exponential — `cycleDist` exponential, so
 *     `kendallServiceCode` maps it to 'M'.
 *  4. `piecesPerAgent: 1` explicitly, or the "smart Source default" hunts a
 *     downstream `bundleSize` and inflates pieces per arrival.
 *  5. `ws.operation.opId` / `.garmentId` left EMPTY, or `opCycleMinFor`
 *     overrides cycleS and `resolveOpQueueCapacity` overrides N.
 *  6. No `twin.assignments`, or `buildShareFactorMap` scales the cycles.
 */
function mmcChainTwin(opts: {
  stations: StationSpec[];
  lambdaPerHr: number;
  discipline?: QueueDiscipline;
}): { twin: Twin; sourceId: string; stationIds: string[]; sinkId: string } {
  const now = new Date(0).toISOString();
  const deptId = id('dept');
  const lineId = id('line');

  const mkWs = (
    name: string,
    kind: string,
    params: Record<string, unknown>,
    x: number,
  ): Workstation =>
    ({
      id: id('ws'),
      deptId,
      lineId,
      catalogId: 'a_snls',
      name,
      position: { x, y: 0 },
      rotation: 0,
      props: {},
      // Trap 5: no op binding, so nothing overrides cycleS / queueCapacity.
      operation: { opId: null },
      resources: { workersRequired: 1 },
      kpiTargets: {},
      block: { kind, params },
    }) as unknown as Workstation;

  const source = mkWs(
    'Source',
    'Source',
    {
      // Trap 2: Poisson arrivals. Mean gap in minutes = 60 / λ.
      arrivalDist: exp(60 / opts.lambdaPerHr),
      sourceRatePerHr: opts.lambdaPerHr,
      // Trap 4.
      piecesPerAgent: 1,
    },
    0,
  );

  const stations = opts.stations.map((s, i) =>
    mkWs(
      `S${i + 1}`,
      'Service',
      {
        // Trap 3: exponential service.
        cycleDist: exp(s.serviceMeanMin),
        cycleS: s.serviceMeanMin * 60,
        servers: s.servers,
        // 0 means unbounded in PmlBlockParams.
        queueCapacity: s.capacity ?? 0,
      },
      i + 1,
    ),
  );

  const sink = mkWs('Sink', 'Sink', {}, opts.stations.length + 1);

  const chain = [source, ...stations, sink];
  const connectors = chain.slice(0, -1).map((from, i) => ({
    id: id('conn'),
    fromWsId: from.id,
    toWsId: chain[i + 1].id,
  }));

  const twin: Twin = {
    schemaVersion: TWIN_SCHEMA_VERSION,
    id: id('twin'),
    name: 'mmc-fixture',
    parentTwinId: null,
    isCanonical: false,
    createdAt: now,
    modifiedAt: now,
    gridW: chain.length + 2,
    gridH: 4,
    departments: [
      { id: deptId, name: 'Sewing Floor', kind: 'Sewing', color: 'blue', bounds: { x: 0, y: 0, w: chain.length + 2, h: 4 } },
    ],
    lines: [
      { id: lineId, deptId, name: 'Line 1', productionSystem: 'PBS', color: 'blue' },
    ],
    workstations: chain,
    connectors: connectors as Twin['connectors'],
    // Trap 6: no assignments.
    operators: [],
    assignments: [],
  } as unknown as Twin;

  return {
    twin,
    sourceId: source.id,
    stationIds: stations.map((s) => s.id),
    sinkId: sink.id,
  };
}

/** Run every seed and return the per-seed `BlockObserved` for one station. */
function observeAcrossSeeds(twin: Twin, wsId: string): BlockObserved[] {
  return SEEDS.map((seed) => {
    const r = runPmlSim({
      twin,
      durationMin: DURATION,
      seed,
      // Sampling is irrelevant here: engine-level warm-up truncation means the
      // end-of-run rollup is already the post-transient figure. Off = faster.
      samplePeriodMin: 0,
      warmupMin: WARMUP,
    });
    const obs = r.blocks.get(wsId);
    if (!obs) throw new Error(`no observed block for ${wsId}`);
    return obs;
  });
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Assert the MEAN of `pick` across seeds is within `relTol` of `expected`.
 *
 * Asserting on the multi-seed mean rather than a single run is deliberate: at
 * these tolerances one seed is a lottery, but every defect this file guards
 * against produces a SYSTEMATIC bias, which a mean catches hard while random
 * sampling error averages out.
 */
function expectConverges(
  observed: BlockObserved[],
  pick: (o: BlockObserved) => number,
  expected: number,
  relTol: number,
  label: string,
): void {
  const got = mean(observed.map(pick));
  const tol = Math.abs(expected) * relTol;
  expect(
    Math.abs(got - expected),
    `${label}: expected ≈ ${expected.toFixed(4)} ± ${relTol * 100}% , got ${got.toFixed(4)}`,
  ).toBeLessThanOrEqual(tol);
}

// ════════════════════════════════════════════════════════════════════════════
// Case 1 — M/M/1
// ════════════════════════════════════════════════════════════════════════════
describe('convergence: M/M/1', () => {
  const LAMBDA = 40; // per hour
  const SERVICE_MIN = 1; // ⇒ μ = 60/hr
  const dist = exp(SERVICE_MIN);
  const { twin, stationIds } = mmcChainTwin({
    stations: [{ serviceMeanMin: SERVICE_MIN, servers: 1 }],
    lambdaPerHr: LAMBDA,
  });
  const observed = observeAcrossSeeds(twin, stationIds[0]);
  const notation = classify(dist, 1, Infinity, 'FCFS');
  const theory = analyticalKpis(notation, LAMBDA, dist);

  // Meta-test FIRST. If the fixture drifted into M/D/1 or picked up an op
  // binding, every number below would still look plausible — this is what
  // makes the rest of the assertions meaningful rather than self-confirming.
  it('is really an M/M/1 : ∞/FCFS station', () => {
    expect(notation.label).toBe('M/M/1 : ∞/FCFS');
    expect(observed[0].serversTotal).toBe(1);
    expect(observed[0].systemCapacity).toBe(Infinity);
    expect(theory.rho).toBeCloseTo(2 / 3, 6);
    expect(theory.Lq).toBeCloseTo(4 / 3, 6); // ρ²/(1−ρ)
  });

  it('offered λ matches the configured arrival rate', () => {
    expectConverges(observed, (o) => o.lambdaOfferedPerHr, LAMBDA, 0.03, 'λ');
  });

  it('ρ̂ converges to ρ', () => {
    expectConverges(observed, (o) => o.utilization, theory.rho, 0.03, 'ρ̂');
  });

  it('L̄q converges to Lq', () => {
    expectConverges(observed, (o) => o.LqObserved, theory.Lq, 0.08, 'L̄q');
  });

  it('L̄ converges to L', () => {
    expectConverges(observed, (o) => o.LObserved, theory.L, 0.06, 'L̄');
  });

  it('Ŵq converges to Wq (queueing.ts returns HOURS)', () => {
    expectConverges(observed, (o) => o.WqObservedMin, theory.Wq * 60, 0.08, 'Ŵq');
  });

  it("satisfies Little's law internally — L̄q ≈ λ_eff · Ŵq", () => {
    const lq = mean(observed.map((o) => o.LqObserved));
    const little = mean(observed.map((o) => (o.lambdaEffPerHr / 60) * o.WqObservedMin));
    expect(Math.abs(lq - little)).toBeLessThanOrEqual(lq * 0.03);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 2 — M/M/c
// ════════════════════════════════════════════════════════════════════════════
describe('convergence: M/M/c (c = 3)', () => {
  const LAMBDA = 120; // per hour
  const SERVICE_MIN = 1; // per-server μ = 60/hr ⇒ a = λ/μ = 2, ρ = a/c = 2/3
  const C = 3;
  const dist = exp(SERVICE_MIN);
  const { twin, stationIds } = mmcChainTwin({
    stations: [{ serviceMeanMin: SERVICE_MIN, servers: C }],
    lambdaPerHr: LAMBDA,
  });
  const observed = observeAcrossSeeds(twin, stationIds[0]);
  const notation = classify(dist, C, Infinity, 'FCFS');
  const theory = analyticalKpis(notation, LAMBDA, dist);

  it('is really an M/M/3 station with c honoured', () => {
    expect(notation.label).toBe('M/M/3 : ∞/FCFS');
    expect(observed[0].serversTotal).toBe(C);
    expect(theory.rho).toBeCloseTo(2 / 3, 6);
  });

  it('ρ̂ converges to ρ', () => {
    expectConverges(observed, (o) => o.utilization, theory.rho, 0.03, 'ρ̂');
  });

  it('L̄q converges to the Erlang-C Lq', () => {
    expectConverges(observed, (o) => o.LqObserved, theory.Lq, 0.12, 'L̄q');
  });

  it('Ŵq converges to Wq', () => {
    expectConverges(observed, (o) => o.WqObservedMin, theory.Wq * 60, 0.12, 'Ŵq');
  });

  it('never runs more than c servers at once', () => {
    // Guards the operator pool leaking parallelism: if a pool were capping or
    // over-permitting concurrency, ρ̂ could still look right while the station
    // was really an M/M/1 or an M/M/∞.
    const r = runPmlSim({
      twin,
      durationMin: 2_000,
      seed: 7,
      samplePeriodMin: 1,
    });
    const maxInService = Math.max(
      ...r.samples.map((s) => s.blocks[stationIds[0]]?.inService ?? 0),
    );
    expect(maxInService).toBeLessThanOrEqual(C);
    expect(maxInService).toBeGreaterThan(1); // it really did run in parallel
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 3 — M/M/1/N with balking
// ════════════════════════════════════════════════════════════════════════════
describe('convergence: M/M/1/N (N = 5, overloaded)', () => {
  const LAMBDA = 72; // per hour
  const SERVICE_MIN = 1; // μ = 60/hr ⇒ ρ = 1.2, so balking dominates
  const N = 5;
  const dist = exp(SERVICE_MIN);
  const { twin, stationIds } = mmcChainTwin({
    stations: [{ serviceMeanMin: SERVICE_MIN, servers: 1, capacity: N }],
    lambdaPerHr: LAMBDA,
  });
  const observed = observeAcrossSeeds(twin, stationIds[0]);
  const notation = classify(dist, 1, N, 'FCFS');
  const theory = analyticalKpis(notation, LAMBDA, dist);

  // THE regression test for the wrong-capacity-field defect. The adapter read
  // `block.params.capacity` (ResourcePool units) instead of `queueCapacity`, so
  // this resolved to Infinity, the M/M/c/N branch never ran, and Lq/Wq were
  // reported for an unbounded queue that the DES was not simulating.
  it('classifies as M/M/1/5 — N reaches the analytical layer', () => {
    expect(notation.capacity).toBe(N);
    expect(notation.label).toBe('M/M/1 : 5/FCFS');
    expect(observed[0].systemCapacity).toBe(N);
  });

  it('never exceeds N in system', () => {
    const r = runPmlSim({ twin, durationMin: 2_000, seed: 7, samplePeriodMin: 1 });
    const maxInSystem = Math.max(
      ...r.samples.map((s) => {
        const b = s.blocks[stationIds[0]];
        return b ? b.queueLen + b.busy : 0;
      }),
    );
    expect(maxInSystem).toBeLessThanOrEqual(N);
  });

  it('balks at the analytical rate P_N', () => {
    const pN = theory.Pn(N);
    expectConverges(
      observed,
      (o) => (o.arrivals + o.balked > 0 ? o.balked / (o.arrivals + o.balked) : 0),
      pN,
      0.1,
      'balk fraction',
    );
  });

  it('admitted λ_eff converges', () => {
    expectConverges(observed, (o) => o.lambdaEffPerHr, theory.lambdaEff, 0.05, 'λ_eff');
  });

  it('L̄ and L̄q converge', () => {
    expectConverges(observed, (o) => o.LObserved, theory.L, 0.08, 'L̄');
    expectConverges(observed, (o) => o.LqObserved, theory.Lq, 0.1, 'L̄q');
  });

  it('Ŵq converges to Wq', () => {
    expectConverges(observed, (o) => o.WqObservedMin, theory.Wq * 60, 0.1, 'Ŵq');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Case 4 — three-station tandem / Burke's theorem
// ════════════════════════════════════════════════════════════════════════════
describe("convergence: 3-station tandem (Burke's theorem)", () => {
  const LAMBDA = 40; // per hour
  // μ = 60 / 50 / 80 per hour ⇒ ρ = 0.667 / 0.800 / 0.500
  const MEANS = [1, 60 / 50, 60 / 80];
  const { twin, stationIds } = mmcChainTwin({
    stations: MEANS.map((m) => ({ serviceMeanMin: m, servers: 1 })),
    lambdaPerHr: LAMBDA,
  });

  const perStation = stationIds.map((wsId) => observeAcrossSeeds(twin, wsId));
  const theories = MEANS.map((m) =>
    analyticalKpis(classify(exp(m), 1, Infinity, 'FCFS'), LAMBDA, exp(m)),
  );

  // Burke: the departure process of an M/M/1 in steady state is Poisson at the
  // SAME rate λ. So every downstream station sees λ = 40 too, and the tandem
  // decomposes into independent M/M/1 analyses. This assertion IS the theorem.
  it('every station sees the same offered λ', () => {
    perStation.forEach((obs, i) => {
      expectConverges(obs, (o) => o.lambdaOfferedPerHr, LAMBDA, 0.03, `λ at S${i + 1}`);
    });
  });

  it('each station converges to its own independent M/M/1 ρ', () => {
    perStation.forEach((obs, i) => {
      expectConverges(obs, (o) => o.utilization, theories[i].rho, 0.04, `ρ̂ at S${i + 1}`);
    });
  });

  it('each station converges to its own independent M/M/1 Lq', () => {
    perStation.forEach((obs, i) => {
      expectConverges(obs, (o) => o.LqObserved, theories[i].Lq, 0.12, `L̄q at S${i + 1}`);
    });
  });

  // One headline number that fails loudly if the decomposition is wrong: a
  // piece's total time through the line should be the sum of the per-station
  // sojourn times the independent analyses predict.
  it('line lead time equals the sum of per-station W', () => {
    const expectedMin = theories.reduce((s, t) => s + t.W * 60, 0);
    const got = mean(
      SEEDS.map(
        (seed) =>
          runPmlSim({
            twin,
            durationMin: DURATION,
            seed,
            samplePeriodMin: 0,
            warmupMin: WARMUP,
          }).meanLeadTimeMin,
      ),
    );
    expect(
      Math.abs(got - expectedMin),
      `lead time: expected ≈ ${expectedMin.toFixed(2)} min, got ${got.toFixed(2)}`,
    ).toBeLessThanOrEqual(expectedMin * 0.08);
  });
});
