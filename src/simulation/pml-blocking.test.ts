import { describe, it, expect } from 'vitest';
import { runPmlSim } from './pml-engine';
import { buildGarmentTwin } from '../domain/reference-twin';
import { GARMENT_TEMPLATES } from '../domain/garments';
import { getBlockKind } from '../domain/pml';
import type { Twin, Workstation } from '../domain/twin';
import type { PmlBlockParams } from '../domain/pml';

/**
 * P2 finite WIP buffers + blocking-after-service. The engine defaults to
 * unbounded buffers (proven byte-identical by the rest of the suite); these
 * tests exercise the opposite corner — tight, authored capacities — and lock
 * in the properties that make blocking correct:
 *
 *   • No deadlock — a fully back-pressured line still produces.
 *   • Bounded WIP — a capped block never exceeds its system capacity K.
 *   • Real back-pressure — some station spends time BLOCKED.
 *   • No throughput inflation — finite buffers can only slow a line.
 *   • No silent loss on the linear path — the Source back-pressures and
 *     Services block instead of dropping (piecesLost stays 0).
 */

function fixtureTwin(): Twin {
  for (const g of Object.values(GARMENT_TEMPLATES)) {
    if (g.operations.length > 0) {
      const twin = buildGarmentTwin(g, Math.max(2, Math.min(12, g.operations.length)));
      if (twin) return twin;
    }
  }
  throw new Error('no garment template with operations to build a fixture twin');
}

/** Set block params on a workstation while preserving its resolved kind. */
function patchParams(ws: Workstation, patch: Partial<PmlBlockParams>): void {
  ws.block = {
    ...(ws.block ?? {}),
    kind: getBlockKind(ws),
    params: { ...(ws.block?.params ?? {}), ...patch },
  };
}

const DURATION = 120;
const SEED = 99;
const K = 2; // tight system capacity on every buffered block

/** Flood the line so the buffers (not the Source) are the constraint. */
function floodSource(twin: Twin): void {
  for (const ws of twin.workstations) {
    if (getBlockKind(ws) === 'Source') patchParams(ws, { sourceRatePerHr: 100_000 });
  }
}

/** Cap every Service / Queue block at system capacity K. */
function capBuffers(twin: Twin): string[] {
  const capped: string[] = [];
  for (const ws of twin.workstations) {
    const kind = getBlockKind(ws);
    if (kind === 'Service' || kind === 'Queue') {
      patchParams(ws, { queueCapacity: K });
      capped.push(ws.id);
    }
  }
  return capped;
}

describe('PML finite buffers + blocking-after-service', () => {
  const baseTwin = fixtureTwin();
  const capTwin = fixtureTwin();
  floodSource(baseTwin);
  floodSource(capTwin);
  const cappedIds = new Set(capBuffers(capTwin));

  const opts = { durationMin: DURATION, seed: SEED, samplePeriodMin: 1 };
  const uncapped = runPmlSim({ twin: baseTwin, ...opts });
  const capped = runPmlSim({ twin: capTwin, ...opts });

  it('caps at least one buffered block (sanity)', () => {
    expect(cappedIds.size).toBeGreaterThan(0);
  });

  it('does not deadlock — a back-pressured line still produces', () => {
    expect(capped.totalProduced).toBeGreaterThan(0);
  });

  it('keeps every capped block within its system capacity K', () => {
    for (const s of capped.samples) {
      for (const [wsId, b] of Object.entries(s.blocks)) {
        if (!cappedIds.has(wsId)) continue;
        // system = waiting (queueLen) + in-service/blocked (busy). Rework
        // re-entry is exempt from capacity (documented), so allow a small
        // slack for a transient rework re-queue.
        expect(b.queueLen + b.busy).toBeLessThanOrEqual(K + 1);
      }
    }
  });

  it('exerts real back-pressure — some block spends time blocked', () => {
    const totalBlocked = [...capped.blocks.values()].reduce((s, b) => s + b.blockedMin, 0);
    expect(totalBlocked).toBeGreaterThan(0);
  });

  it('constrains WIP below the unbounded run', () => {
    const maxWip = (r: typeof capped) =>
      Math.max(
        0,
        ...r.samples.flatMap((s) => Object.values(s.blocks).map((b) => b.queueLen + b.busy)),
      );
    expect(maxWip(capped)).toBeLessThan(maxWip(uncapped));
  });

  it('never inflates throughput vs unbounded buffers', () => {
    expect(capped.throughputPerHr).toBeLessThanOrEqual(uncapped.throughputPerHr * 1.0001);
  });

  it('drops nothing on the linear Service path (Source back-pressures)', () => {
    expect(capped.piecesLost).toBe(0);
  });

  it('leaves the unbounded run unblocked and loss-free', () => {
    const totalBlocked = [...uncapped.blocks.values()].reduce((s, b) => s + b.blockedMin, 0);
    expect(totalBlocked).toBe(0);
    expect(uncapped.piecesLost).toBe(0);
  });
});

describe('authored op.queueCapacity reaches the DES (bake wiring)', () => {
  // An authored buffer lives on the operation (what ServiceQueueParams edits
  // and the analytical model reads). buildGarmentTwin must bake it into
  // block.params so the DES honours the SAME value with no block-param poke.
  const template = Object.values(GARMENT_TEMPLATES).find((g) => g.operations.length > 0)!;
  const authored = {
    ...template,
    operations: template.operations.map((o) => ({ ...o, queueCapacity: 2 })),
  };
  const operators = Math.max(2, Math.min(12, authored.operations.length));
  const twin = buildGarmentTwin(authored, operators)!;
  for (const ws of twin.workstations) {
    if (getBlockKind(ws) === 'Source') patchParams(ws, { sourceRatePerHr: 100_000 });
  }

  it('bakes op.queueCapacity into every Service block.params', () => {
    const services = twin.workstations.filter((w) => getBlockKind(w) === 'Service');
    expect(services.length).toBeGreaterThan(0);
    for (const ws of services) {
      expect(ws.block?.params?.queueCapacity).toBe(2);
    }
  });

  it('honours the baked capacity in the engine (blocks without a block-param poke)', () => {
    const r = runPmlSim({ twin, durationMin: DURATION, seed: SEED, samplePeriodMin: 1 });
    expect(r.totalProduced).toBeGreaterThan(0);
    const totalBlocked = [...r.blocks.values()].reduce((s, b) => s + b.blockedMin, 0);
    expect(totalBlocked).toBeGreaterThan(0);
    expect(r.piecesLost).toBe(0);
  });
});
