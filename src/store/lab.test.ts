/**
 * Store invariants — specifically the one the topology verbs can break.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { useLab, type LabState } from './lab';
import { solveNetwork } from '../simulation/network';
import { SEED_SYSTEMS, SEED_VERSION, isSeedSystem } from '../domain/lab-systems';

function freshSystem(): string {
  const id = useLab.getState().createSystem('test');
  return id;
}

function sys(id: string) {
  return useLab.getState().systems.find((s) => s.id === id)!;
}

function outSum(id: string, from: string): number {
  return sys(id).edges.filter((e) => e.from === from).reduce((a, e) => a + e.probability, 0);
}

describe('outgoing routing shares can never exceed 1', () => {
  let id = '';
  beforeEach(() => {
    id = freshSystem();
  });

  it('adding a rework arc to a saturated stage rescales the forward one', () => {
    // The bug this guards: a mid-chain stage routes 100% forward. Adding 15%
    // back would total 115%, which validateNetwork rejects — blanking EVERY
    // measure in the system, not just that stage's.
    const s = useLab.getState();
    const a = sys(id).nodes[0].id;
    const b = s.addNode(id);
    s.connect(id, a, b, 1);
    expect(outSum(id, a)).toBeCloseTo(1, 9);

    const c = s.addNode(id);
    s.connect(id, a, c, 0.15);
    expect(outSum(id, a)).toBeLessThanOrEqual(1 + 1e-9);
    // The arc just added keeps the share it was asked for.
    expect(sys(id).edges.find((e) => e.from === a && e.to === c)!.probability).toBeCloseTo(0.15, 9);
    // The other one gives way.
    expect(sys(id).edges.find((e) => e.from === a && e.to === b)!.probability).toBeCloseTo(0.85, 6);
  });

  it('a branch on a stage that already routes forward stays valid', () => {
    const s = useLab.getState();
    const a = sys(id).nodes[0].id;
    const next = s.addNode(id);
    s.connect(id, a, next, 1);
    const x = s.addNode(id);
    const y = s.addNode(id);
    s.connect(id, a, x, 0.5);
    s.connect(id, a, y, 0.5);
    expect(outSum(id, a)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('no sequence of verbs can produce a ROUTING error', () => {
    // A network can still turn out unstable — two rework loops really can push
    // a stage past its service rate, and saying so is the right answer. What
    // must never happen is a structural error, which is the one that blanks
    // every measure instead of diagnosing one stage.
    const s = useLab.getState();
    const a = sys(id).nodes[0].id;
    const b = s.addNode(id);
    s.connect(id, a, b, 1);
    const c = s.addNode(id);
    s.connect(id, b, c, 1);
    s.connect(id, c, a, 0.3); // rework to the head
    s.connect(id, b, a, 0.2); // and another
    const sol = solveNetwork(sys(id));
    const routingErrors = sol.issues.filter(
      (i) => i.level === 'error' && /more than it receives|circulates|does not exist/.test(i.message),
    );
    expect(routingErrors).toEqual([]);
    for (const n of sys(id).nodes) {
      expect(outSum(id, n.id)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('re-connecting an existing pair edits it rather than stacking a second arc', () => {
    const s = useLab.getState();
    const a = sys(id).nodes[0].id;
    const b = s.addNode(id);
    s.connect(id, a, b, 0.4);
    s.connect(id, a, b, 0.6);
    expect(sys(id).edges.filter((e) => e.from === a && e.to === b)).toHaveLength(1);
    expect(outSum(id, a)).toBeCloseTo(0.6, 9);
  });
});

describe('a starter stays resettable after you have edited it', () => {
  /**
   * The point of the reset is to undo an experiment, so it has to survive the
   * experiment. An earlier version cleared a `seeded` flag on every edit, which
   * left the action reachable only on a system nobody had touched.
   */
  it('reset is offered for a starter id, edited or not', () => {
    expect(isSeedSystem('seed-mm1-booth')).toBe(true);
    useLab.getState().patchNode('seed-mm1-booth', 'booth', { servers: 4 });
    expect(isSeedSystem('seed-mm1-booth')).toBe(true);
  });

  it('reset puts the textbook numbers back', () => {
    const s = useLab.getState();
    s.patchNode('seed-mm1-booth', 'booth', { servers: 4, externalArrivalPerHr: 99 });
    const edited = useLab.getState().systems.find((x) => x.id === 'seed-mm1-booth')!;
    expect(edited.nodes[0].servers).toBe(4);

    useLab.getState().resetSeeded('seed-mm1-booth');
    const back = useLab.getState().systems.find((x) => x.id === 'seed-mm1-booth')!;
    expect(back.nodes[0].servers).toBe(1);
    expect(back.nodes[0].externalArrivalPerHr).toBe(7.5);
    // And it solves to the published answer again.
    const sol = solveNetwork(back);
    expect(sol.nodes[0].kpis.rho).toBeCloseTo(0.5, 6);
    expect(sol.nodes[0].kpis.Lq).toBeCloseTo(0.5, 6);
  });

  it('a system the user made is not resettable', () => {
    const id = useLab.getState().createSystem('mine');
    expect(isSeedSystem(id)).toBe(false);
  });

  it('a duplicate of a starter is the user’s, not a starter', () => {
    const copyId = useLab.getState().duplicateSystem('seed-mm1-booth');
    expect(isSeedSystem(copyId)).toBe(false);
  });
});

describe('duplicating a system does not share node identity', () => {
  it('gives the copy its own node and edge ids', () => {
    const id = freshSystem();
    const s = useLab.getState();
    const a = sys(id).nodes[0].id;
    const b = s.addNode(id);
    s.connect(id, a, b, 1);
    const copyId = s.duplicateSystem(id);
    const orig = sys(id);
    const copy = sys(copyId);
    const origIds = new Set(orig.nodes.map((n) => n.id));
    expect(copy.nodes.every((n) => !origIds.has(n.id))).toBe(true);
    // And the copy's edges point at the copy's nodes.
    const copyIds = new Set(copy.nodes.map((n) => n.id));
    expect(copy.edges.every((e) => copyIds.has(e.from) && copyIds.has(e.to))).toBe(true);
  });
});

describe('seed reconciliation on hydration', () => {
  /**
   * `merge` is what decides which starter systems an existing user ends up
   * with. Exercised directly because the persist middleware only calls it on a
   * real rehydration, which a unit test has no way to trigger.
   */
  const persistOpts = (useLab as unknown as {
    persist: { getOptions: () => { merge?: (p: unknown, c: LabState) => LabState } };
  }).persist.getOptions();

  const merge = (persisted: Partial<LabState>): LabState =>
    persistOpts.merge!(persisted, useLab.getState());

  it('gives a brand-new user the whole starter set', () => {
    const out = merge({});
    for (const seed of SEED_SYSTEMS) {
      expect(out.systems.some((s) => s.id === seed.id)).toBe(true);
    }
    expect(out.seedVersion).toBe(SEED_VERSION);
  });

  it('does NOT resurrect a starter the user deleted', () => {
    // Same seed generation, one seed removed on purpose: it must stay removed.
    const kept = SEED_SYSTEMS.filter((s) => s.id !== 'seed-mm1-booth');
    const out = merge({ systems: kept, seedVersion: SEED_VERSION });
    expect(out.systems.some((s) => s.id === 'seed-mm1-booth')).toBe(false);
  });

  it('tops up an older user with starters added since', () => {
    // An earlier generation that only ever had one system.
    const out = merge({ systems: [SEED_SYSTEMS[0]], seedVersion: 0 });
    expect(out.systems.length).toBe(SEED_SYSTEMS.length);
    expect(out.seedVersion).toBe(SEED_VERSION);
  });

  it('never duplicates a starter the user still has', () => {
    const out = merge({ systems: SEED_SYSTEMS, seedVersion: 0 });
    const ids = out.systems.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the user’s own systems untouched', () => {
    const mine = { ...SEED_SYSTEMS[0], id: 'mine', name: 'My system', seeded: false };
    const out = merge({ systems: [mine], seedVersion: 0 });
    expect(out.systems.find((s) => s.id === 'mine')?.name).toBe('My system');
  });
});
