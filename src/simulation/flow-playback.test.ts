import { describe, it, expect } from 'vitest';
import { buildFlowPlayback } from './flow-playback';
import { runPmlSim, type FlowEvent } from './pml-engine';
import { buildGarmentTwin } from '../domain/reference-twin';
import { GARMENT_TEMPLATES } from '../domain/garments';
import { getBlockKind } from '../domain/pml';
import type { Twin } from '../domain/twin';

/**
 * flow-playback turns the entity-flow stream into per-bundle station-anchored
 * positions at any playback time. These tests pin the state machine precisely
 * with a hand-built stream, then sanity-check it against a real engine run.
 */

function fixtureTwin(): Twin {
  for (const g of Object.values(GARMENT_TEMPLATES)) {
    if (g.operations.length > 0) {
      const twin = buildGarmentTwin(g, Math.max(2, Math.min(12, g.operations.length)));
      if (twin) return twin;
    }
  }
  throw new Error('no garment template with operations');
}

describe('flow-playback · state machine (hand-built stream)', () => {
  // agent 1: services A [0,4] then sinks.
  // agent 2: arrives A@1 (waits), services A [4,9], blocked [9,12], then sinks.
  const flow: FlowEvent[] = [
    { t: 0, kind: 'spawn', agentId: 1, wsId: 'src', pieces: 5 },
    { t: 0, kind: 'move', agentId: 1, wsId: 'A', fromWsId: 'src', pieces: 5 },
    { t: 0, kind: 'startService', agentId: 1, wsId: 'A', pieces: 5 },
    { t: 1, kind: 'move', agentId: 2, wsId: 'A', fromWsId: 'src', pieces: 3 },
    { t: 4, kind: 'endService', agentId: 1, wsId: 'A', pieces: 5 },
    { t: 4, kind: 'move', agentId: 1, wsId: 'SINK', fromWsId: 'A', pieces: 5 },
    { t: 4, kind: 'sink', agentId: 1, wsId: 'SINK', pieces: 5 },
    { t: 4, kind: 'startService', agentId: 2, wsId: 'A', pieces: 3 },
    { t: 9, kind: 'endService', agentId: 2, wsId: 'A', pieces: 3 },
    { t: 9, kind: 'block', agentId: 2, wsId: 'A', pieces: 3 },
    { t: 12, kind: 'unblock', agentId: 2, wsId: 'A', pieces: 3 },
    { t: 12, kind: 'move', agentId: 2, wsId: 'SINK', fromWsId: 'A', pieces: 3 },
    { t: 12, kind: 'sink', agentId: 2, wsId: 'SINK', pieces: 3 },
  ];
  const pb = buildFlowPlayback(flow);

  it('places a serviced bundle and a waiting bundle at the same station', () => {
    const at2 = pb.bundlesAt(2);
    const a1 = at2.find((b) => b.agentId === 1);
    const a2 = at2.find((b) => b.agentId === 2);
    expect(a1).toMatchObject({ wsId: 'A', state: 'service', rank: 0 });
    expect(a2).toMatchObject({ wsId: 'A', state: 'waiting', rank: 0 });
    expect(pb.blockedAt(2).size).toBe(0);
  });

  it('drops a bundle from the system the instant it sinks', () => {
    // agent 1 sinks at t=4.
    expect(pb.bundlesAt(3.9).some((b) => b.agentId === 1)).toBe(true);
    expect(pb.bundlesAt(4).some((b) => b.agentId === 1)).toBe(false);
    // agent 2 is now in service at A.
    expect(pb.bundlesAt(5)).toEqual([
      expect.objectContaining({ agentId: 2, wsId: 'A', state: 'service' }),
    ]);
  });

  it('reports a blocked-after-service bundle and its station', () => {
    const at10 = pb.bundlesAt(10);
    expect(at10).toEqual([
      expect.objectContaining({ agentId: 2, wsId: 'A', state: 'blocked' }),
    ]);
    expect(pb.blockedAt(10)).toEqual(new Set(['A']));
    // Just before the block it was still in service.
    expect(pb.bundlesAt(8)[0].state).toBe('service');
  });

  it('empties the system after the last sink', () => {
    expect(pb.bundlesAt(12)).toEqual([]);
    expect(pb.bundlesAt(100)).toEqual([]);
  });

  it('ranks co-located waiting bundles by arrival order', () => {
    const waiters: FlowEvent[] = [
      { t: 0, kind: 'move', agentId: 10, wsId: 'Q', fromWsId: 's', pieces: 1 },
      { t: 1, kind: 'move', agentId: 11, wsId: 'Q', fromWsId: 's', pieces: 1 },
      { t: 2, kind: 'move', agentId: 12, wsId: 'Q', fromWsId: 's', pieces: 1 },
    ];
    const frames = buildFlowPlayback(waiters).bundlesAt(3);
    expect(frames.map((f) => f.agentId)).toEqual([10, 11, 12]);
    expect(frames.map((f) => f.rank)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.state === 'waiting')).toBe(true);
  });

  it('is empty for an empty stream', () => {
    const pbe = buildFlowPlayback([]);
    expect(pbe.empty).toBe(true);
    expect(pbe.bundlesAt(5)).toEqual([]);
    expect(pbe.blockedAt(5).size).toBe(0);
  });
});

describe('flow-playback · against a real engine run', () => {
  const twin = fixtureTwin();
  const result = runPmlSim({ twin, durationMin: 120, seed: 7, recordFlow: true });
  const wsIds = new Set(twin.workstations.map((w) => w.id));
  const pb = buildFlowPlayback(result.flow);

  it('indexes a non-empty run', () => {
    expect(pb.empty).toBe(false);
    expect(pb.stayCount).toBeGreaterThan(0);
  });

  it('places bundles at real stations mid-run', () => {
    const frames = pb.bundlesAt(60);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(wsIds.has(f.wsId)).toBe(true);
      expect(f.rank).toBeGreaterThanOrEqual(0);
    }
    // ranks per (station,state) are contiguous starting at 0.
    const byKey = new Map<string, number[]>();
    for (const f of frames) {
      const k = `${f.wsId} ${f.state}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(f.rank);
    }
    for (const ranks of byKey.values()) {
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks.map((_, i) => i));
    }
  });

  it('surfaces blocked stations when buffers are tight', () => {
    // Rebuild the same fixture with tiny buffers + a flooded source so the
    // line back-pressures, then confirm the playback reports blocked stations.
    const capped = fixtureTwin();
    for (const ws of capped.workstations) {
      const kind = getBlockKind(ws);
      if (kind === 'Source') {
        ws.block = { ...(ws.block ?? {}), kind, params: { ...ws.block?.params, sourceRatePerHr: 100_000 } };
      } else if (kind === 'Service') {
        ws.block = { ...(ws.block ?? {}), kind, params: { ...ws.block?.params, queueCapacity: 2 } };
      }
    }
    const r = runPmlSim({ twin: capped, durationMin: 120, seed: 7, recordFlow: true });
    const cpb = buildFlowPlayback(r.flow);
    // Some sample time in the run has a blocked station.
    const anyBlocked = r.samples.some((s) => cpb.blockedAt(s.time).size > 0);
    expect(anyBlocked).toBe(true);
  });
});
