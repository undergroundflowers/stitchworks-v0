import { describe, it, expect } from 'vitest';
import { diagnoseQueues, applyPatch, describePatch, type QueueFinding } from './queue-advisor';
import { buildStarterLine } from './starter-line';
import { getBlockKind, getBlockParams } from './pml';
import type { StationView } from '../simulation/sim-state';
import type { SewingLine } from './twin';

/**
 * The advisor's job is to be RIGHT about which finding applies, and quiet
 * otherwise. A diagnostic that fires on a healthy line is worse than none: it
 * trains the user to ignore the list, and then the one real finding is lost in
 * it. So these tests check both directions for every rule.
 */

/** Minimal StationView with sane defaults — override only what a case needs. */
function station(over: Partial<StationView> & { wsId: string }): StationView {
  return {
    wsId: over.wsId,
    opId: `op-${over.wsId}`,
    opName: over.opName ?? `Station ${over.wsId}`,
    machineCode: 'SNL',
    smv: 0.5,
    serversTotal: 1,
    busy: 0,
    queueLen: 0,
    blocked: 0,
    produced: 100,
    totalBusyTime: 0,
    utilization: 0.5,
    notation: { arrival: 'M', service: 'M', servers: 1, capacity: Infinity, discipline: 'FCFS', label: 'M/M/1 : ∞/FCFS' },
    serviceDist: { kind: 'exp', mean: 0.5 },
    capacity: Infinity,
    arrivals: 200,
    balked: 0,
    lambda: 60,
    analytical: {
      rho: 0.5, P0: 0.5, Pn: () => 0.1, Lq: 0.5, Wq: 0.01, L: 1, W: 0.02,
      D: NaN, isStable: true, pWaitGreaterThan: () => 0, lambdaEff: 60,
    },
    isStable: true,
    lambdaEff: 60,
    LqObserved: 0.5,
    LObserved: 1,
    WqObservedMin: 0.5,
    balkFraction: 0,
    disciplineNotSimulated: false,
    ...over,
  };
}

const LINE: SewingLine = {
  id: 'line-1',
  deptId: 'dept-1',
  name: 'Line 1',
  color: 'blue',
  policy: { bundleSize: 30 },
};

function ids(f: QueueFinding[]): string[] {
  return f.map((x) => x.id);
}

function find(f: QueueFinding[], prefix: string): QueueFinding | undefined {
  return f.find((x) => x.id.startsWith(prefix));
}

describe('diagnoseQueues — a balanced, quiet line', () => {
  // Every station at 50 %, shallow queues, nothing blocked or balking.
  const stations = ['a', 'b', 'c', 'd'].map((k) => station({ wsId: k }));
  const findings = diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 500 });

  it('reports healthy rather than inventing problems', () => {
    expect(ids(findings)).toEqual(['healthy']);
  });

  it('still tells the user what to do next', () => {
    // "Nothing is wrong" is only useful with a next step attached — otherwise
    // the surface is a dead end on a healthy line.
    expect(findings[0].action.length).toBeGreaterThan(10);
  });
});

describe('diagnoseQueues — an unstable station', () => {
  const stations = [
    station({ wsId: 'a' }),
    station({ wsId: 'hot', opName: 'Side seam', utilization: 1, isStable: false, LqObserved: 40 }),
  ];
  const findings = diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 200 });

  it('flags it critical', () => {
    const f = find(findings, 'unstable-hot');
    expect(f?.severity).toBe('critical');
  });

  it('sorts it above everything else', () => {
    expect(findings[0].id).toBe('unstable-hot');
  });

  it('offers an applyable second operator', () => {
    const f = find(findings, 'unstable-hot');
    expect(f?.patch).toEqual({ kind: 'addServer', wsId: 'hot', from: 1, to: 2 });
  });

  it('does not flag instability when a finite buffer bounds the queue', () => {
    // With a cap, ρ ≥ 1 means balking, not unbounded growth — a different
    // problem with a different fix, and the balking rule covers it.
    const capped = [
      station({ wsId: 'a' }),
      station({
        wsId: 'hot', utilization: 1, isStable: false, capacity: 5,
        balked: 300, balkFraction: 0.25,
      }),
    ];
    const f = diagnoseQueues({ stations: capped, line: LINE, shiftMin: 480, produced: 200 });
    expect(find(f, 'unstable-')).toBeUndefined();
    expect(find(f, 'balking-hot')).toBeDefined();
  });
});

describe('diagnoseQueues — the bottleneck', () => {
  it('recommends an operator when the constraint is ISOLATED', () => {
    // 30 points clear of the next station: rebalancing can't close that gap.
    const stations = [
      station({ wsId: 'a', utilization: 0.5 }),
      station({ wsId: 'b', utilization: 0.55 }),
      station({ wsId: 'peak', opName: 'Side seam', utilization: 0.9, LqObserved: 4 }),
    ];
    const f = find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 500 }), 'bottleneck-');
    expect(f?.patch?.kind).toBe('addServer');
    expect(f?.action).toContain('second operator');
  });

  it('recommends a rebalance when the line is nearly level', () => {
    // A few points apart: this is a work-division problem, not a capacity one.
    const stations = [
      station({ wsId: 'a', utilization: 0.82 }),
      station({ wsId: 'b', utilization: 0.84 }),
      station({ wsId: 'peak', utilization: 0.88, LqObserved: 2 }),
    ];
    const f = find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 500 }), 'bottleneck-');
    expect(f?.patch).toEqual({ kind: 'rebalance', lineId: 'line-1' });
  });

  it('says nothing when no station is hot', () => {
    const stations = [station({ wsId: 'a', utilization: 0.4 }), station({ wsId: 'b', utilization: 0.5 })];
    expect(find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 500 }), 'bottleneck-')).toBeUndefined();
  });
});

describe('diagnoseQueues — starvation', () => {
  it('reports idle stations only when there IS a constraint starving them', () => {
    const stations = [
      station({ wsId: 'peak', utilization: 0.92, LqObserved: 5 }),
      station({ wsId: 'i1', utilization: 0.1, LqObserved: 0 }),
      station({ wsId: 'i2', utilization: 0.12, LqObserved: 0 }),
    ];
    expect(find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 400 }), 'starved-')).toBeDefined();
  });

  it('stays quiet on a merely under-fed line', () => {
    // Everything idle and nothing hot: the line isn't starved by a constraint,
    // it just isn't being fed. Listing every station as "starved" would be noise.
    const stations = [
      station({ wsId: 'i1', utilization: 0.1, LqObserved: 0 }),
      station({ wsId: 'i2', utilization: 0.12, LqObserved: 0 }),
      station({ wsId: 'i3', utilization: 0.09, LqObserved: 0 }),
    ];
    expect(find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 50 }), 'starved-')).toBeUndefined();
  });
});

describe('diagnoseQueues — WIP concentration', () => {
  it('names the few stations holding most of the queue', () => {
    const stations = [
      station({ wsId: 'deep', opName: 'Side seam', LqObserved: 9 }),
      station({ wsId: 'b', LqObserved: 0.2 }),
      station({ wsId: 'c', LqObserved: 0.2 }),
      station({ wsId: 'd', LqObserved: 0.2 }),
      station({ wsId: 'e', LqObserved: 0.2 }),
      station({ wsId: 'f', LqObserved: 0.2 }),
    ];
    const f = find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 500 }), 'wip-concentration');
    expect(f).toBeDefined();
    expect(f?.wsId).toBe('deep');
  });

  it('stays quiet when WIP is spread evenly', () => {
    // If it takes most of the line to account for 60 % of WIP, there is no
    // concentration to point at.
    const stations = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => station({ wsId: k, LqObserved: 1 }));
    expect(find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 500 }), 'wip-concentration')).toBeUndefined();
  });
});

describe('diagnoseQueues — blocking and bundle size', () => {
  it('distinguishes blocked from busy', () => {
    const stations = [station({ wsId: 'a' }), station({ wsId: 'b', blocked: 2 })];
    const f = find(diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 300 }), 'blocked-b');
    expect(f?.title).toContain('blocked, not busy');
  });

  it('suggests smaller bundles only when there is a queue to fix', () => {
    const queued = [station({ wsId: 'a', LqObserved: 3 })];
    expect(find(diagnoseQueues({ stations: queued, line: LINE, shiftMin: 480, produced: 300 }), 'bundle-size')).toBeDefined();

    const quiet = [station({ wsId: 'a', LqObserved: 0.05 })];
    expect(find(diagnoseQueues({ stations: quiet, line: LINE, shiftMin: 480, produced: 300 }), 'bundle-size')).toBeUndefined();
  });
});

describe('diagnoseQueues — a line that produced nothing', () => {
  const stations = [station({ wsId: 'a', utilization: 0, LqObserved: 0 })];
  const findings = diagnoseQueues({ stations, line: LINE, shiftMin: 480, produced: 0 });

  it('says so, and only that', () => {
    // Deriving queueing findings from a run that produced nothing would be
    // reading tea leaves; the graph is broken and that is the only message.
    expect(ids(findings)).toEqual(['no-output']);
  });
});

describe('applyPatch', () => {
  const twin = buildStarterLine();
  const svc = twin.workstations.find((w) => getBlockKind(w) === 'Service')!;

  it('adds a server without disturbing anything else', () => {
    const next = applyPatch(twin, { kind: 'addServer', wsId: svc.id, from: 1, to: 2 });
    expect(getBlockParams(next.workstations.find((w) => w.id === svc.id)!).servers).toBe(2);
    expect(next.workstations.length).toBe(twin.workstations.length);
    // Pure: the original is untouched, so previewing a fix commits nothing.
    expect(getBlockParams(svc).servers).toBe(1);
  });

  it('sets and clears a buffer', () => {
    const capped = applyPatch(twin, { kind: 'setBuffer', wsId: svc.id, n: 8 });
    expect(getBlockParams(capped.workstations.find((w) => w.id === svc.id)!).queueCapacity).toBe(8);
    const cleared = applyPatch(capped, { kind: 'clearBuffer', wsId: svc.id });
    // 0 is how PmlBlockParams spells unbounded.
    expect(getBlockParams(cleared.workstations.find((w) => w.id === svc.id)!).queueCapacity).toBe(0);
  });

  it('changes bundle size on the line AND every bound station', () => {
    // Both, or the engine and the policy would disagree about the bundle.
    const next = applyPatch(twin, { kind: 'setBundleSize', lineId: twin.lines[0].id, from: 30, to: 15 });
    expect(next.lines[0].policy?.bundleSize).toBe(15);
    const bound = next.workstations.filter((w) => w.lineId === twin.lines[0].id && w.operation?.opId);
    expect(bound.length).toBeGreaterThan(0);
    for (const ws of bound) expect(ws.operation.bundleSize).toBe(15);
  });

  it('preserves the block kind so an override cannot reset it', () => {
    const next = applyPatch(twin, { kind: 'addServer', wsId: svc.id, from: 1, to: 2 });
    expect(getBlockKind(next.workstations.find((w) => w.id === svc.id)!)).toBe('Service');
  });
});

describe('describePatch', () => {
  const stations = [station({ wsId: 'w1', opName: 'Side seam' })];
  it('names the station rather than printing an id', () => {
    expect(describePatch({ kind: 'addServer', wsId: 'w1', from: 1, to: 2 }, stations))
      .toBe('Side seam: 1 → 2 operators');
  });
});
