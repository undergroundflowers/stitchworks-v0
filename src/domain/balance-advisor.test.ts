import { describe, it, expect } from 'vitest';
import { buildLineBalance, readTakt, type LineBalance } from './line-balance';
import { suggestBalanceActions } from './balance-advisor';
import { buildStarterLine } from './starter-line';
import { GARMENT_TEMPLATES } from './garments';
import type { Twin } from './twin';

const GARMENTS = { tshirt: GARMENT_TEMPLATES.tshirt };

function balanceOf(twin: Twin): LineBalance {
  return buildLineBalance({
    twin,
    lineId: twin.lines[0].id,
    garmentsById: GARMENTS,
  });
}

const ids = (twin: Twin, takt?: ReturnType<typeof readTakt>) =>
  suggestBalanceActions({ balance: balanceOf(twin), takt }).map((s) => s.id);

describe('suggestBalanceActions · rules that used to be unreachable', () => {
  const twin = buildStarterLine();
  const bal = balanceOf(twin);

  it('says nothing about takt until a target exists', () => {
    const withoutTarget = ids(twin);
    expect(withoutTarget).not.toContain('takt-understaffed');
    expect(withoutTarget).not.toContain('takt-bottleneck-blocks');
  });

  it('fires the understaffed rule on a target the crew cannot reach', () => {
    // Ask for ten times what the line can ship.
    const takt = readTakt(bal, {
      targetPieces: Math.ceil((480 / bal.bottleneckMin) * 10),
      shiftMin: 480,
    });
    expect(ids(twin, takt)).toContain('takt-understaffed');
  });

  it('distinguishes "rebalance will fix it" from "you need more people"', () => {
    // A target just past what the current bottleneck holds, but comfortably
    // inside what the crew's total work content allows.
    const target = Math.ceil(480 / bal.bottleneckMin) + 1;
    const takt = readTakt(bal, { targetPieces: target, shiftMin: 480 })!;
    expect(takt.requiredChannels).toBeLessThanOrEqual(bal.servers);
    const fired = ids(twin, takt);
    expect(fired).toContain('takt-bottleneck-blocks');
    expect(fired).not.toContain('takt-understaffed');
  });

  it('never fires both takt rules at once — they have the same root cause', () => {
    for (const mult of [0.5, 1, 1.5, 3, 10]) {
      const takt = readTakt(bal, {
        targetPieces: Math.max(1, Math.ceil((480 / bal.bottleneckMin) * mult)),
        shiftMin: 480,
      });
      const fired = ids(twin, takt);
      const both =
        fired.includes('takt-understaffed') && fired.includes('takt-bottleneck-blocks');
      expect(both).toBe(false);
    }
  });
});

describe('suggestBalanceActions · advice that names real controls', () => {
  const twin = buildStarterLine();

  it('does not send the user to a balancer picker that has never existed', () => {
    const all = suggestBalanceActions({ balance: balanceOf(twin) });
    for (const s of all) {
      expect(s.action.toLowerCase()).not.toContain('balancer picker');
      expect(s.action).not.toMatch(/COMSOAL|\bGA\b/);
    }
  });

  it('never tells the user to redeploy operators off an unbalanced line', () => {
    const all = suggestBalanceActions({ balance: balanceOf(twin) });
    const surplus = all.find((s) => s.id === 'imbalance-channel-cost');
    if (surplus) {
      // The old copy led with "redeploy N operators to another line", which
      // would raise the bottleneck. Rebalancing has to come first.
      expect(surplus.action).toMatch(/[Rr]ebalance first/);
    }
  });

  it('points at the offending workstation so the chart can highlight it', () => {
    const all = suggestBalanceActions({ balance: balanceOf(twin) });
    const wsIds = new Set(twin.workstations.map((w) => w.id));
    for (const s of all) {
      if (s.wsId) expect(wsIds.has(s.wsId)).toBe(true);
    }
  });
});

describe('suggestBalanceActions · findings the old advisor could not see', () => {
  const base = buildStarterLine();
  const lineId = base.lines[0].id;

  it('calls out a shared operator on the pacing station', () => {
    const bal = balanceOf(base);
    const pacer = bal.bottleneck!;
    const twin: Twin = {
      ...base,
      assignments: (base.assignments ?? []).map((a) =>
        a.wsId === pacer.wsId ? { ...a, shareFrac: 0.5 } : a,
      ),
    };
    const row = suggestBalanceActions({ balance: balanceOf(twin) }).find(
      (s) => s.id === 'bottleneck-shared-operator',
    );
    expect(row).toBeDefined();
    expect(row!.severity).toBe('critical');
    expect(row!.wsId).toBe(pacer.wsId);
  });

  it('calls out stations on the line that carry no operation', () => {
    const victim = base.workstations.find((w) => w.lineId === lineId && w.operation.opId)!;
    const twin: Twin = {
      ...base,
      workstations: base.workstations.map((w) =>
        w.id === victim.id ? { ...w, operation: { ...w.operation, opId: null } } : w,
      ),
    };
    const row = suggestBalanceActions({ balance: balanceOf(twin) }).find(
      (s) => s.id === 'stations-excluded',
    );
    expect(row).toBeDefined();
    expect(row!.detail).toContain(victim.name);
  });

  it('calls out a roster that disagrees with the channels the engine runs', () => {
    const victim = base.workstations.find((w) => w.lineId === lineId && w.operation.opId)!;
    const twin: Twin = {
      ...base,
      workstations: base.workstations.map((w) =>
        w.id === victim.id
          ? { ...w, block: { ...(w.block ?? { kind: 'Service' as const }), params: { ...(w.block?.params ?? {}), servers: 3 } } }
          : w,
      ),
    };
    const row = suggestBalanceActions({ balance: balanceOf(twin) }).find(
      (s) => s.id === 'staffing-vs-channels',
    );
    expect(row).toBeDefined();
    expect(row!.wsId).toBe(victim.id);
  });

  it('has one thing to say about a line with no stations on it', () => {
    const empty = buildLineBalance({ twin: base, lineId: 'nope', garmentsById: GARMENTS });
    const out = suggestBalanceActions({ balance: empty });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('no-stations');
  });
});

describe('suggestBalanceActions · ordering', () => {
  it('puts critical rows first and info last', () => {
    const base = buildStarterLine();
    const bal = balanceOf(base);
    const takt = readTakt(bal, { targetPieces: 100_000, shiftMin: 480 });
    const out = suggestBalanceActions({ balance: bal, takt });
    const rank = { critical: 0, warn: 1, opportunity: 2, info: 3 } as const;
    for (let i = 1; i < out.length; i++) {
      expect(rank[out[i].severity]).toBeGreaterThanOrEqual(rank[out[i - 1].severity]);
    }
    expect(out[0].severity).toBe('critical');
  });
});
