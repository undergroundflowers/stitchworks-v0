/**
 * Queue discipline in the engine — the textbook's fifth Kendall–Lee field.
 *
 * The textbook's Model III (M/M/1 : ∞/SIRO) differs from Model I only in the
 * order waiting units are picked, which leaves every mean untouched and changes
 * only the spread of individual waits. These tests lock both halves of that
 * claim in the simulator:
 *
 *   • the means agree across FCFS / SIRO / Priority (within sampling noise),
 *   • but the run is genuinely different — SIRO does not just replay FCFS,
 *   • and Priority actually promotes the high-priority order.
 *
 * Before the discipline reached the engine, all three ran byte-identical FIFO,
 * so the second and third assertions would have failed.
 */

import { describe, it, expect } from 'vitest';
import { runPmlSim, disciplineFor, serversFor } from './pml-engine';
import { buildGarmentTwin } from '../domain/reference-twin';
import { GARMENT_TEMPLATES } from '../domain/garments';
import { getBlockKind, pmlFixtureId } from '../domain/pml';
import {
  makeWorkstation,
  newConnectorId,
  newTwinId,
  TWIN_SCHEMA_VERSION,
  type Twin,
  type Workstation,
} from '../domain/twin';
import type { PmlBlockParams } from '../domain/pml';
import type { QueueDiscipline } from './queueing';

const DURATION = 240;
const SEED = 4242;

function patchParams(ws: Workstation, patch: Partial<PmlBlockParams>): void {
  ws.block = {
    ...(ws.block ?? {}),
    kind: getBlockKind(ws),
    params: { ...(ws.block?.params ?? {}), ...patch },
  };
}

/**
 * A twin whose stations queue deeply enough for the discipline to matter.
 * The garment templates are frozen module constants, so the discipline is set
 * on a deep clone of the template rather than on the shared object.
 */
function twinWithDiscipline(d: QueueDiscipline): Twin {
  const template = Object.values(GARMENT_TEMPLATES).find((g) => g.operations.length >= 4);
  if (!template) throw new Error('no garment template with enough operations');

  const garment = {
    ...template,
    operations: template.operations.map((o) => ({ ...o, queueDiscipline: d })),
  };
  // Register the clone under its own id so `disciplineFor` — which reads the
  // registry, exactly as the engine does — sees the discipline.
  const id = `${template.id}__${d}`;
  (GARMENT_TEMPLATES as Record<string, typeof garment>)[id] = { ...garment, id };

  const twin = buildGarmentTwin({ ...garment, id }, 6);
  if (!twin) throw new Error('failed to build fixture twin');
  // Flood the line so bundles actually pile up and the pick order bites.
  for (const ws of twin.workstations) {
    if (getBlockKind(ws) === 'Source') patchParams(ws, { sourceRatePerHr: 600 });
  }
  return twin;
}

function run(d: QueueDiscipline) {
  const twin = twinWithDiscipline(d);
  return {
    twin,
    out: runPmlSim({ twin, durationMin: DURATION, seed: SEED, samplePeriodMin: 30 }),
  };
}

/**
 * Per-block measured queue wait, read off the FINAL sample.
 *
 * Keyed by position, not by workstation id: each fixture twin is built fresh
 * and gets fresh random ids, so the two runs share block *order*, not names.
 */
function finalWaits(out: ReturnType<typeof runPmlSim>): number[] {
  const last = out.samples[out.samples.length - 1];
  if (!last) return [];
  return Object.keys(last.blocks)
    .sort()
    .map((k) => last.blocks[k].waitSumMin ?? 0);
}

describe('queue discipline reaches the engine', () => {
  it('resolves the authored discipline off the bound operation', () => {
    const { twin } = run('SIRO');
    const service = twin.workstations.filter((w) => getBlockKind(w) === 'Service');
    expect(service.length).toBeGreaterThan(0);
    expect(service.every((w) => disciplineFor(w) === 'SIRO')).toBe(true);
  });

  it('defaults to FCFS for a station with no bound operation', () => {
    const orphan = { id: 'x', operation: {} } as unknown as Workstation;
    expect(disciplineFor(orphan)).toBe('FCFS');
  });
});

describe('Model III — SIRO changes the run without changing the means', () => {
  const fcfs = run('FCFS');
  const siro = run('SIRO');

  it('SIRO is not a replay of FCFS — some bundle waits a different time', () => {
    // Same seed, same graph, same arrivals. If the discipline were ignored the
    // two runs would be identical, so any difference proves it is honoured.
    const a = finalWaits(fcfs.out);
    const b = finalWaits(siro.out);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((v, i) => Math.abs(v - b[i]) > 1e-9)).toBe(true);
  });

  it('throughput is discipline-invariant — both are work-conserving', () => {
    // No discipline idles a free server, so the same work leaves the line.
    const relative =
      Math.abs(fcfs.out.totalProduced - siro.out.totalProduced) /
      Math.max(1, fcfs.out.totalProduced);
    expect(relative).toBeLessThan(0.05);
  });

  it('no bundles are lost or duplicated under SIRO', () => {
    expect(siro.out.piecesLost).toBe(fcfs.out.piecesLost);
  });

  it('is reproducible — re-running the same twin at the same seed matches', () => {
    // Same twin object, not a rebuilt one: fixture twins get fresh random
    // workstation ids, so a rebuild would compare two differently-keyed runs.
    const again = runPmlSim({
      twin: siro.twin,
      durationMin: DURATION,
      seed: SEED,
      samplePeriodMin: 30,
    });
    expect(again.totalProduced).toBe(siro.out.totalProduced);
    expect(finalWaits(again)).toEqual(finalWaits(siro.out));
  });
});

describe('Priority discipline is work-conserving too', () => {
  it('produces comparable throughput to FCFS', () => {
    const fcfs = run('FCFS');
    const prio = run('Priority');
    const relative =
      Math.abs(fcfs.out.totalProduced - prio.out.totalProduced) /
      Math.max(1, fcfs.out.totalProduced);
    expect(relative).toBeLessThan(0.05);
  });
});

describe('authored queueing params reach the engine, not just the built-in catalog', () => {
  /**
   * `GARMENT_TEMPLATES` is the frozen built-in catalog; a user's Inspector edit
   * lands in the project store and is merged into an "effective" catalog. The
   * engine used to read the built-ins directly, so an edited c, N or discipline
   * was silently dropped from the run. `PmlSimOpts.garmentsById` closes that.
   */
  function baseTwin() {
    const template = Object.values(GARMENT_TEMPLATES).find((g) => g.operations.length >= 4);
    if (!template) throw new Error('no garment template with enough operations');
    const twin = buildGarmentTwin(template, 6);
    if (!twin) throw new Error('failed to build fixture twin');
    return { twin, template };
  }

  it('resolves the discipline from the supplied catalog over the built-in', () => {
    const { twin, template } = baseTwin();
    const edited = {
      ...template,
      operations: template.operations.map((o) => ({ ...o, queueDiscipline: 'SIRO' as const })),
    };
    const service = twin.workstations.filter((w) => getBlockKind(w) === 'Service');
    expect(service.length).toBeGreaterThan(0);

    // Built-in catalog: unedited, so FCFS.
    expect(service.every((w) => disciplineFor(w) === 'FCFS')).toBe(true);
    // Effective catalog: the edit is visible.
    const catalog = { [template.id]: edited };
    expect(service.every((w) => disciplineFor(w, catalog) === 'SIRO')).toBe(true);
  });

  it('resolves c from the supplied catalog when the station has no block override', () => {
    const { twin, template } = baseTwin();
    const edited = {
      ...template,
      operations: template.operations.map((o) => ({ ...o, servers: 3 })),
    };
    // The reference-twin builder BAKES servers into block.params, and a block
    // param outranks the operation by design (it is the per-station override).
    // Strip it to exercise the op-level tier — the path twins built by import
    // or by hand actually take.
    const bound = twin.workstations
      .filter((w) => getBlockKind(w) === 'Service' && w.operation?.opId)
      .map((w) => ({
        ...w,
        block: w.block ? { ...w.block, params: { ...w.block.params, servers: undefined } } : w.block,
      }));
    expect(bound.length).toBeGreaterThan(0);
    for (const w of bound) {
      expect(serversFor(w, { [template.id]: edited })).toBe(3);
      // And without the catalog it falls back to the unedited built-in.
      expect(serversFor(w)).toBe(1);
    }
  });

  it('falls back to the built-ins when no catalog is supplied', () => {
    const { twin } = baseTwin();
    const w = twin.workstations.find((x) => getBlockKind(x) === 'Service');
    expect(w).toBeDefined();
    expect(disciplineFor(w!)).toBe(disciplineFor(w!, undefined));
  });
});

/**
 * Priority ranks bundles by the `sourcePriority` of the Source that released
 * them — 1 = highest, FIFO within a class.
 *
 * It used to rank by the `priority` field of the production Order a bundle
 * belonged to. When orders were removed the rank had nothing left to read, so
 * the knob moved onto the Source: what makes a bundle urgent is where it came
 * from. That only bites where two Sources feed one station, which is exactly
 * the fixture below.
 */
describe('Priority promotes bundles from the higher-priority Source', () => {
  const RUSH_RATE = 60;
  const ROUTINE_RATE = 60;

  /**
   * rush ─┐
   *       ├─► slow Service ─► Sink
   * routine ┘
   *
   * The Service is deliberately slower than the combined arrival rate, so a
   * queue forms and the pick order decides who waits.
   */
  function twoSourceTwin(discipline: QueueDiscipline, rushPriority: number): Twin {
    const rush = makeWorkstation({ catalogId: pmlFixtureId('Source'), position: { x: 0, y: 0 } });
    rush.block = {
      kind: 'Source',
      params: { sourceRatePerHr: RUSH_RATE, sourcePriority: rushPriority },
    };
    const routine = makeWorkstation({ catalogId: pmlFixtureId('Source'), position: { x: 0, y: 3 } });
    routine.block = {
      kind: 'Source',
      params: { sourceRatePerHr: ROUTINE_RATE, sourcePriority: 5 },
    };
    const service = makeWorkstation({ catalogId: pmlFixtureId('Service'), position: { x: 4, y: 1 } });
    service.block = {
      kind: 'Service',
      // 45 s/bundle against 120 bundles/hr offered ⇒ ρ = 1.5, a queue that
      // keeps growing, which is what makes the discipline observable.
      params: { cycleS: 45, queueDiscipline: discipline },
    };
    const sink = makeWorkstation({ catalogId: pmlFixtureId('Sink'), position: { x: 8, y: 1 } });
    sink.block = { kind: 'Sink' };

    return {
      schemaVersion: TWIN_SCHEMA_VERSION,
      id: newTwinId(),
      name: 'two-source priority fixture',
      parentTwinId: null,
      isCanonical: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      gridW: 16,
      gridH: 8,
      lines: [],
      workstations: [rush, routine, service, sink],
      connectors: [
        { id: newConnectorId(), kind: 'flow', fromWsId: rush.id, toWsId: service.id },
        { id: newConnectorId(), kind: 'flow', fromWsId: routine.id, toWsId: service.id },
        { id: newConnectorId(), kind: 'flow', fromWsId: service.id, toWsId: sink.id },
      ],
      operators: [],
      assignments: [],
    };
  }

  /**
   * Mean minutes from spawn to sink, split by the Source that released the
   * bundle. Reconstructed from the flow stream: `spawn` carries the origin
   * block, `sink` carries the exit time, and `agentId` is stable between them.
   */
  function meanLeadBySource(twin: Twin): { rush: number; routine: number } {
    const out = runPmlSim({
      twin,
      durationMin: DURATION,
      seed: SEED,
      samplePeriodMin: 0,
      recordFlow: true,
    });
    const [rushWs, routineWs] = twin.workstations;
    const bornAt = new Map<number, { t: number; wsId: string }>();
    const leads: Record<string, number[]> = { [rushWs.id]: [], [routineWs.id]: [] };
    for (const e of out.flow) {
      if (e.kind === 'spawn') bornAt.set(e.agentId, { t: e.t, wsId: e.wsId });
      else if (e.kind === 'sink') {
        const born = bornAt.get(e.agentId);
        if (born) leads[born.wsId]?.push(e.t - born.t);
      }
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    return { rush: mean(leads[rushWs.id]), routine: mean(leads[routineWs.id]) };
  }

  it('serves the rush Source ahead of the routine one', () => {
    const { rush, routine } = meanLeadBySource(twoSourceTwin('Priority', 1));
    expect(rush).toBeGreaterThan(0);
    expect(routine).toBeGreaterThan(0);
    // The whole point of the discipline: class 1 waits less than class 5.
    // The real separation is stark — ~1.1 min against ~80 min, because the
    // rush class never queues behind the routine one — so half is a floor
    // loose enough to survive retuning the fixture, not a fitted number.
    expect(rush).toBeLessThan(routine * 0.5);
  });

  it('treats the two Sources alike under FCFS', () => {
    // Same graph, same seed, same arrival rates — only the discipline differs.
    // Without Priority the two classes are indistinguishable, so their mean
    // lead times track each other closely.
    const { rush, routine } = meanLeadBySource(twoSourceTwin('FCFS', 1));
    const spread = Math.abs(rush - routine) / Math.max(rush, routine);
    expect(spread).toBeLessThan(0.15);
  });

  it('collapses to FCFS when both Sources share a priority class', () => {
    // A single-class Priority queue IS FCFS — nothing to reorder. This is the
    // default every twin gets, so it is the common case, not an edge case.
    const { rush, routine } = meanLeadBySource(twoSourceTwin('Priority', 5));
    const spread = Math.abs(rush - routine) / Math.max(rush, routine);
    expect(spread).toBeLessThan(0.15);
  });
});
