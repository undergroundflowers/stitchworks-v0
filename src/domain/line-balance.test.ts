import { describe, it, expect } from 'vitest';
import { bestAchievableBottleneckMin, buildLineBalance, readTakt } from './line-balance';
import { buildStarterLine } from './starter-line';
import { GARMENT_TEMPLATES } from './garments';
import { getBlockKind } from './pml';
import { runPmlSim, serversFor } from '../simulation/pml-engine';
import type { Twin } from './twin';

/**
 * The balance surface used to describe a line nobody had built: it packed a
 * garment template onto a typed-in operator count and reported the result as
 * a fact about the factory. These tests pin the replacement to the twin.
 */
describe('buildLineBalance', () => {
  const twin = buildStarterLine();
  const lineId = twin.lines[0].id;
  const garments = { tshirt: GARMENT_TEMPLATES.tshirt };
  const bal = buildLineBalance({ twin, lineId, garmentsById: garments });

  it('reads one station per Service workstation the user placed', () => {
    const services = twin.workstations.filter(
      (w) => w.lineId === lineId && getBlockKind(w) === 'Service',
    );
    expect(bal.stations.length).toBe(services.length);
    expect(bal.stations.map((s) => s.wsId).sort()).toEqual(
      services.map((w) => w.id).sort(),
    );
  });

  it('names the garment the stations are bound to, not a picker default', () => {
    expect(bal.garment?.id).toBe('tshirt');
  });

  it('reports Source / Sink / pool as infrastructure instead of dropping them', () => {
    const infra = bal.excluded.filter((e) => e.reason === 'infrastructure');
    expect(infra.length).toBeGreaterThan(0);
    // Every workstation on the line is accounted for exactly once.
    const members = twin.workstations.filter((w) => w.lineId === lineId);
    expect(bal.stations.length + bal.excluded.length).toBe(members.length);
  });

  it('takes station cycles straight from the bulletin SMVs', () => {
    for (const st of bal.stations) {
      expect(st.nominalMin).toBe(st.op.smv);
      // No skill matrix, no sharing, one server ⇒ cycle is the SMV itself.
      expect(st.cycleMin).toBeCloseTo(st.op.smv, 10);
    }
  });

  it('paces the line at its slowest station', () => {
    const slowest = Math.max(...bal.stations.map((s) => s.cycleMin));
    expect(bal.bottleneckMin).toBeCloseTo(slowest, 10);
    expect(bal.bottleneck?.cycleMin).toBeCloseTo(slowest, 10);
    expect(bal.capacityPerHr).toBeCloseTo(60 / slowest, 10);
  });

  it('reports pitch as work content per channel, NOT as takt', () => {
    expect(bal.pitchMin).toBeCloseTo(bal.workContentMin / bal.servers, 10);
    // The old surface called this "TAKT". It is strictly below the bottleneck
    // on any unbalanced line, which is why it can never be a demand signal.
    expect(bal.pitchMin).toBeLessThanOrEqual(bal.bottleneckMin + 1e-9);
  });

  it('keeps balance loss and LBR exact complements', () => {
    expect(bal.balanceLossPct + bal.lbrPct).toBeCloseTo(100, 6);
  });

  it('derives LBR as pitch ÷ bottleneck — the channel-weighted form', () => {
    expect(bal.lbrPct).toBeCloseTo((bal.pitchMin / bal.bottleneckMin) * 100, 6);
  });

  it('says how many channels a perfect repack would need to hold this pace', () => {
    expect(bal.channelsToHoldPace).toBe(
      Math.ceil(bal.workContentMin / bal.bottleneckMin),
    );
    // A real line always needs at least as many channels as the ideal one.
    expect(bal.channelsToHoldPace).toBeLessThanOrEqual(bal.servers);
  });
});

describe('buildLineBalance · staffing and sharing', () => {
  const base = buildStarterLine();
  const lineId = base.lines[0].id;
  const garments = { tshirt: GARMENT_TEMPLATES.tshirt };

  /** Halve one station's operator attendance, the way SHARE WITH NEXT does. */
  function withShare(wsId: string, frac: number): Twin {
    return {
      ...base,
      assignments: (base.assignments ?? []).map((a) =>
        a.wsId === wsId ? { ...a, shareFrac: frac } : a,
      ),
    };
  }

  it('doubles a station cycle when its operator is only there half the shift', () => {
    const target = buildLineBalance({ twin: base, lineId, garmentsById: garments })
      .stations[0];
    const shared = buildLineBalance({
      twin: withShare(target.wsId, 0.5),
      lineId,
      garmentsById: garments,
    }).stations.find((s) => s.wsId === target.wsId)!;
    expect(shared.shareFrac).toBe(0.5);
    expect(shared.cycleMin).toBeCloseTo(target.cycleMin * 2, 10);
  });

  it('speeds a station up in proportion to its skill multiplier', () => {
    const plain = buildLineBalance({ twin: base, lineId, garmentsById: garments });
    const opId = plain.stations[0].opId;
    const fast = buildLineBalance({
      twin: base,
      lineId,
      garmentsById: garments,
      opEfficiency: { [opId]: 1.25 },
    }).stations[0];
    expect(fast.skillEff).toBe(1.25);
    expect(fast.cycleMin).toBeCloseTo(plain.stations[0].cycleMin / 1.25, 10);
  });

  it('clamps a runaway skill entry to the engine range', () => {
    const plain = buildLineBalance({ twin: base, lineId, garmentsById: garments });
    const opId = plain.stations[0].opId;
    const wild = buildLineBalance({
      twin: base,
      lineId,
      garmentsById: garments,
      opEfficiency: { [opId]: 9 },
    }).stations[0];
    expect(wild.skillEff).toBe(1.5);
  });
});

describe('buildLineBalance · degenerate input', () => {
  const garments = { tshirt: GARMENT_TEMPLATES.tshirt };

  it('returns an empty, zeroed reading for a line that does not exist', () => {
    const twin = buildStarterLine();
    const bal = buildLineBalance({ twin, lineId: 'nope', garmentsById: garments });
    expect(bal.stations).toEqual([]);
    expect(bal.bottleneckMin).toBe(0);
    expect(bal.capacityPerHr).toBe(0);
    expect(bal.balanceLossPct).toBe(0);
    expect(bal.channelsToHoldPace).toBe(0);
  });

  it('reports an unresolvable op id rather than silently skipping the station', () => {
    const base = buildStarterLine();
    const lineId = base.lines[0].id;
    const victim = base.workstations.find(
      (w) => w.lineId === lineId && w.operation.opId,
    )!;
    const twin: Twin = {
      ...base,
      workstations: base.workstations.map((w) =>
        w.id === victim.id
          ? { ...w, operation: { ...w.operation, opId: 'ts-does-not-exist' } }
          : w,
      ),
    };
    const bal = buildLineBalance({ twin, lineId, garmentsById: garments });
    const row = bal.excluded.find((e) => e.wsId === victim.id);
    expect(row).toBeDefined();
    expect(row!.reason).toBe('unknown-operation');
    expect(row!.detail).toBe('ts-does-not-exist');
  });

  it('resolves a garment the project edited, not just the frozen built-in', () => {
    const base = buildStarterLine();
    const lineId = base.lines[0].id;
    // A user who doubles every SMV must see the line halve its output.
    const edited = {
      ...GARMENT_TEMPLATES.tshirt,
      operations: GARMENT_TEMPLATES.tshirt.operations.map((o) => ({
        ...o,
        smv: o.smv * 2,
      })),
    };
    const bal = buildLineBalance({
      twin: base,
      lineId,
      garmentsById: { tshirt: edited },
    });
    const plain = buildLineBalance({
      twin: base,
      lineId,
      garmentsById: { tshirt: GARMENT_TEMPLATES.tshirt },
    });
    expect(bal.bottleneckMin).toBeCloseTo(plain.bottleneckMin * 2, 10);
  });
});

describe('readTakt', () => {
  const twin = buildStarterLine();
  const lineId = twin.lines[0].id;
  const bal = buildLineBalance({
    twin,
    lineId,
    garmentsById: { tshirt: GARMENT_TEMPLATES.tshirt },
  });

  it('has nothing to say until the user states a target', () => {
    expect(readTakt(bal, { targetPieces: 0, shiftMin: 480 })).toBeNull();
  });

  it('is NOT a restatement of LBR — the flaw that made the old LBE tile dead', () => {
    // Takt pinned to the bottleneck is what the old page did; that made
    // LBE ≡ LBR to the decimal. A real demand target must move it.
    const atBottleneck = readTakt(bal, {
      targetPieces: 480 / bal.bottleneckMin,
      shiftMin: 480,
    })!;
    expect(atBottleneck.lbePct).toBeCloseTo(bal.lbrPct, 6);

    const demanding = readTakt(bal, {
      targetPieces: (480 / bal.bottleneckMin) * 2,
      shiftMin: 480,
    })!;
    expect(demanding.lbePct).toBeGreaterThan(bal.lbrPct + 1);
  });

  it('calls a line infeasible when the bottleneck alone is slower than takt', () => {
    const impossible = readTakt(bal, { targetPieces: 100_000, shiftMin: 480 })!;
    expect(impossible.feasible).toBe(false);
    expect(impossible.lbePct).toBeGreaterThan(100);
    expect(impossible.requiredChannels).toBeGreaterThan(bal.servers);
  });

  it('reports what the line will actually ship, not what was asked for', () => {
    const modest = readTakt(bal, { targetPieces: 10, shiftMin: 480 })!;
    expect(modest.feasible).toBe(true);
    expect(modest.achievablePieces).toBe(Math.floor(480 / bal.bottleneckMin));
  });
});

describe('bestAchievableBottleneckMin', () => {
  const twin = buildStarterLine();
  const lineId = twin.lines[0].id;
  const bal = buildLineBalance({
    twin,
    lineId,
    garmentsById: { tshirt: GARMENT_TEMPLATES.tshirt },
  });

  it('never claims a repack could beat the pitch line', () => {
    const best = bestAchievableBottleneckMin(bal)!;
    expect(best).toBeGreaterThanOrEqual(bal.pitchMin - 1e-9);
  });

  it('is at least as good as the layout the user actually built', () => {
    const best = bestAchievableBottleneckMin(bal)!;
    expect(best).toBeLessThanOrEqual(bal.bottleneckMin + 1e-9);
  });

  it('has nothing to pack on an empty line', () => {
    const empty = buildLineBalance({
      twin,
      lineId: 'nope',
      garmentsById: { tshirt: GARMENT_TEMPLATES.tshirt },
    });
    expect(bestAchievableBottleneckMin(empty)).toBeNull();
  });
});

/**
 * The claim this whole surface rests on is "what you see here is what the
 * engine runs". These tests hold the two layers against each other rather
 * than against a hand-written expectation, so a change to one that the other
 * does not follow shows up as a failure.
 */
describe('agreement with the engine', () => {
  const base = buildStarterLine();
  const lineId = base.lines[0].id;
  const garments = { tshirt: GARMENT_TEMPLATES.tshirt };

  it('resolves every station\'s channel count through the engine\'s own serversFor', () => {
    const twin: Twin = {
      ...base,
      workstations: base.workstations.map((w, i) =>
        i % 5 === 0 && w.operation.opId
          ? { ...w, block: { ...(w.block ?? { kind: 'Service' as const }), params: { ...(w.block?.params ?? {}), servers: 3 } } }
          : w,
      ),
    };
    const bal = buildLineBalance({ twin, lineId, garmentsById: garments });
    for (const st of bal.stations) {
      const ws = twin.workstations.find((w) => w.id === st.wsId)!;
      expect(st.servers).toBe(serversFor(ws, garments));
    }
    expect(bal.stations.some((s) => s.servers === 3)).toBe(true);
  });

  it('slows the chart and the run together when the pacer\'s operator is shared', () => {
    const before = buildLineBalance({ twin: base, lineId, garmentsById: garments });
    const pacer = before.bottleneck!;
    const twin: Twin = {
      ...base,
      assignments: (base.assignments ?? []).map((a) =>
        a.wsId === pacer.wsId ? { ...a, shareFrac: 0.5 } : a,
      ),
    };
    const after = buildLineBalance({ twin, lineId, garmentsById: garments });

    // The chart says the line got slower...
    expect(after.bottleneckMin).toBeGreaterThan(before.bottleneckMin);
    expect(after.capacityPerHr).toBeLessThan(before.capacityPerHr);

    // ...and so does a run of the same twin.
    const runBefore = runPmlSim({ twin: base, durationMin: 480, seed: 7, garmentsById: garments });
    const runAfter = runPmlSim({ twin, durationMin: 480, seed: 7, garmentsById: garments });
    expect(runAfter.totalProduced).toBeLessThan(runBefore.totalProduced);
  });
});

/**
 * `domain/index.ts` re-exports this module, which imports the engine, which
 * imports garment data. If the engine ever reaches back through the domain
 * BARREL instead of the leaf, the cycle resolves `GARMENT_TEMPLATES` to
 * undefined at module-eval time and every station silently loses its SMV.
 */
describe('module graph', () => {
  it('loads the domain barrel without a cycle swallowing the garment catalog', async () => {
    const domain = await import('./index');
    expect(Object.keys(domain.GARMENT_TEMPLATES ?? {}).length).toBeGreaterThan(0);
    expect(typeof domain.buildLineBalance).toBe('function');
    expect(typeof domain.suggestBalanceActions).toBe('function');
  });
});
