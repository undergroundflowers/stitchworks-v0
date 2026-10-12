import { describe, it, expect } from 'vitest';
import { buildSimSpec, simSpecKey, type SimSpec } from './sim-spec';
import { buildStarterLine } from '../domain/starter-line';
import { GARMENT_TEMPLATES } from '../domain/garments';
import { getBlockKind } from '../domain/pml';
import type { Twin, Workstation } from '../domain/twin';

/**
 * `simSpecKey` decides when the engine re-runs and when playback is preserved,
 * so it has exactly two ways to be wrong, and they are not symmetric:
 *
 *   • Too SENSITIVE — a cosmetic change (dragging a station, renaming a line,
 *     the run's own `kpiObserved` write-back) changes the key, the engine
 *     re-runs, and the playhead jumps. Annoying, and the reason the clock used
 *     to be pinned at zero.
 *
 *   • Too COARSE — a real parameter change does NOT change the key, so the UI
 *     keeps showing numbers from a model the user has since edited. That is
 *     strictly worse: it is silently wrong rather than visibly annoying.
 *
 * So this file is table-driven over both directions, and the hash deliberately
 * over-includes when in doubt.
 */

const GARMENTS = GARMENT_TEMPLATES;

function baseSpec(twin: Twin): SimSpec {
  return buildSimSpec({
    twin,
    scope: { kind: 'factory' },
    garmentsById: GARMENTS,
    defaultGarmentId: 'tshirt',
    durationMin: 480,
    seed: 42,
    warmupMin: 60,
  });
}

/** Deep-clone a twin so a mutation can't leak between cases. */
function clone(twin: Twin): Twin {
  return JSON.parse(JSON.stringify(twin)) as Twin;
}

/** First Service-kind workstation — the one carrying the interesting params. */
function firstService(twin: Twin): Workstation {
  const ws = twin.workstations.find((w) => getBlockKind(w) === 'Service');
  if (!ws) throw new Error('fixture has no Service block');
  return ws;
}

function keyOf(twin: Twin): string {
  return simSpecKey(baseSpec(twin));
}

describe('simSpecKey — stability', () => {
  const twin = buildStarterLine();

  it('is deterministic for the same twin', () => {
    expect(keyOf(twin)).toBe(keyOf(twin));
  });

  it('is stable across a structural round-trip', () => {
    // A fresh object graph with identical contents must key the same, or every
    // store rehydration would look like a parameter change.
    expect(keyOf(clone(twin))).toBe(keyOf(twin));
  });

  it('is stable across a whole rebuild of the same seed', () => {
    // buildStarterLine mints new ids each call, so this is NOT expected to
    // match — asserting that keeps the id-sensitivity honest and documented.
    expect(keyOf(buildStarterLine())).not.toBe(keyOf(twin));
  });
});

describe('simSpecKey — ignores changes the engine never reads', () => {
  const twin = buildStarterLine();
  const base = keyOf(twin);

  const cosmetic: [string, (t: Twin) => void][] = [
    ['workstation position', (t) => { firstService(t).position = { x: 99, y: 99 }; }],
    ['workstation rotation', (t) => { firstService(t).rotation = 180; }],
    ['workstation name', (t) => { firstService(t).name = 'renamed station'; }],
    ['kpi targets', (t) => { firstService(t).kpiTargets = { capacityPerHr: 12345 }; }],
    // The critical one: a run WRITES kpiObserved back onto the twin. If the key
    // included it, every run would invalidate itself and re-run forever.
    ['kpi observed (written BY a run)', (t) => {
      firstService(t).kpiObserved = { utilizationPct: 83.4 };
    }],
    ['line name', (t) => { t.lines[0].name = 'Renamed line'; }],
    ['line colour', (t) => { t.lines[0].color = 'red'; }],
    ['twin name', (t) => { t.name = 'Different factory name'; }],
    ['grid size', (t) => { t.gridW = 200; t.gridH = 200; }],
  ];

  for (const [label, mutate] of cosmetic) {
    it(`ignores ${label}`, () => {
      const t = clone(twin);
      mutate(t);
      expect(keyOf(t)).toBe(base);
    });
  }
});

describe('simSpecKey — reacts to every engine-visible parameter', () => {
  const twin = buildStarterLine();
  const base = keyOf(twin);

  const material: [string, (t: Twin) => void][] = [
    ['cycle time', (t) => { firstService(t).block!.params!.cycleS = 999; }],
    ['servers (c)', (t) => { firstService(t).block!.params!.servers = 3; }],
    ['queue capacity (N)', (t) => { firstService(t).block!.params!.queueCapacity = 8; }],
    ['cycle distribution', (t) => {
      firstService(t).block!.params!.cycleDist = { kind: 'exp', mean: 2 };
    }],
    ['source rate', (t) => {
      const src = t.workstations.find((w) => getBlockKind(w) === 'Source')!;
      src.block!.params!.sourceRatePerHr = 500;
    }],
    ['arrival distribution', (t) => {
      const src = t.workstations.find((w) => getBlockKind(w) === 'Source')!;
      src.block!.params!.arrivalDist = { kind: 'det', value: 1 };
    }],
    ['pieces per agent', (t) => {
      const src = t.workstations.find((w) => getBlockKind(w) === 'Source')!;
      src.block!.params!.piecesPerAgent = 25;
    }],
    ['pool capacity', (t) => {
      const pool = t.workstations.find((w) => getBlockKind(w) === 'ResourcePool')!;
      pool.block!.params!.capacity = 3;
    }],
    ['op binding', (t) => { firstService(t).operation.opId = 'ts-99'; }],
    ['bundle size', (t) => { firstService(t).operation.bundleSize = 7; }],
    ['line membership', (t) => { firstService(t).lineId = 'some-other-line'; }],
    ['workers required', (t) => { firstService(t).resources.workersRequired = 4; }],
    ['a removed workstation', (t) => { t.workstations.splice(1, 1); }],
    ['a removed connector', (t) => { t.connectors.splice(1, 1); }],
    ['a rewired connector', (t) => { t.connectors[1].toWsId = t.workstations[0].id; }],
    ['an assignment shareFrac', (t) => { t.assignments![0].shareFrac = 0.5; }],
    ['a removed assignment', (t) => { t.assignments!.splice(0, 1); }],
    ['line policy', (t) => {
      t.lines[0].policy = { ...t.lines[0].policy, bundleSize: 3 };
    }],
  ];

  for (const [label, mutate] of material) {
    it(`reacts to ${label}`, () => {
      const t = clone(twin);
      mutate(t);
      expect(keyOf(t)).not.toBe(base);
    });
  }
});

describe('simSpecKey — reacts to run parameters', () => {
  const twin = buildStarterLine();
  const spec = baseSpec(twin);
  const base = simSpecKey(spec);

  it('reacts to duration', () => {
    expect(simSpecKey({ ...spec, durationMin: 960 })).not.toBe(base);
  });
  it('reacts to seed', () => {
    expect(simSpecKey({ ...spec, seed: 43 })).not.toBe(base);
  });
  it('reacts to sample period', () => {
    expect(simSpecKey({ ...spec, samplePeriodMin: 5 })).not.toBe(base);
  });
  it('reacts to warm-up', () => {
    expect(simSpecKey({ ...spec, warmupMin: 120 })).not.toBe(base);
  });
  it('reacts to flow recording', () => {
    expect(simSpecKey({ ...spec, recordFlow: !spec.recordFlow })).not.toBe(base);
  });
  it('reacts to op efficiency', () => {
    expect(simSpecKey({ ...spec, opEfficiency: { 'ts-01': 0.8 } })).not.toBe(base);
  });
  it('ignores op-efficiency key ORDER', () => {
    const a = simSpecKey({ ...spec, opEfficiency: { 'ts-01': 0.8, 'ts-02': 0.9 } });
    const b = simSpecKey({ ...spec, opEfficiency: { 'ts-02': 0.9, 'ts-01': 0.8 } });
    expect(a).toBe(b);
  });
});

describe('buildSimSpec — scoping', () => {
  const twin = buildStarterLine();

  it('includes the line at factory scope', () => {
    const spec = baseSpec(twin);
    expect(spec.lines.length).toBe(1);
    expect(spec.lines[0].lineId).toBe(twin.lines[0].id);
  });

  it('narrows to one line at line scope', () => {
    const spec = buildSimSpec({
      twin,
      scope: { kind: 'line', id: twin.lines[0].id },
      garmentsById: GARMENTS,
      defaultGarmentId: 'tshirt',
      durationMin: 480,
      seed: 42,
      warmupMin: 60,
    });
    expect(spec.lines.length).toBe(1);
    // Line scope drives the animated floor, so the entity stream is recorded.
    expect(spec.recordFlow).toBe(true);
  });

  it('drops lines that have no workstations', () => {
    const t = clone(twin);
    t.lines.push({
      id: 'line-empty',
      name: 'Empty line',
      color: 'red',
    });
    const spec = baseSpec(t);
    // An empty line would contribute an always-zero slot to every merged
    // result, so it is excluded rather than simulated.
    expect(spec.lines.map((l) => l.lineId)).not.toContain('line-empty');
  });

  it('never lets warm-up swallow the whole run', () => {
    const spec = buildSimSpec({
      twin,
      scope: { kind: 'factory' },
      garmentsById: GARMENTS,
      defaultGarmentId: 'tshirt',
      durationMin: 100,
      seed: 42,
      warmupMin: 5_000,
    });
    expect(spec.warmupMin).toBeLessThan(spec.durationMin);
  });
});
