import { describe, expect, it } from 'vitest';
import { SEED_SYSTEMS } from '../domain/lab-systems';
import { solveNetwork } from './network';

describe('seeded systems reproduce their stated numbers', () => {
  const by = (id: string) => SEED_SYSTEMS.find((s) => s.id === id)!;

  it('booth: ρ 0.5, Lq 0.5, W 0.133 hr', () => {
    const s = solveNetwork(by('seed-mm1-booth'));
    expect(s.nodes[0].kpis.rho).toBeCloseTo(0.5, 6);
    expect(s.nodes[0].kpis.Lq).toBeCloseTo(0.5, 6);
    expect(s.nodes[0].kpis.W).toBeCloseTo(0.1333, 3);
  });

  it('bank M/M/3: P0 0.145, Lq 0.532, L 2.334', () => {
    const s = solveNetwork(by('seed-mmk-bank'));
    expect(s.nodes[0].kpis.P0).toBeCloseTo(0.145, 2);
    expect(s.nodes[0].kpis.Lq).toBeCloseTo(0.532, 2);
    expect(s.nodes[0].kpis.L).toBeCloseTo(2.334, 2);
  });

  it('capped: stable despite rho > 1, and loses work', () => {
    const s = solveNetwork(by('seed-mm1n-capped'));
    expect(s.nodes[0].kpis.rho).toBeGreaterThan(1);
    expect(s.isStable).toBe(true);
    expect(s.admittedPerHr).toBeLessThan(s.externalArrivalPerHr);
  });

  it('M/D/1 has exactly half the Lq of M/M/1 at the same rho', () => {
    const s = solveNetwork(by('seed-md1-press'));
    const rho = s.nodes[0].kpis.rho;
    expect(s.nodes[0].kpis.Lq).toBeCloseTo((rho * rho) / (2 * (1 - rho)), 9);
  });

  it('rework: 15% back raises the sew load by 1/(1-0.15) = 17.6%', () => {
    const s = solveNetwork(by('seed-rework-loop'));
    expect(s.byNodeId.sew.lambda).toBeCloseTo(50 / 0.85, 6);
    expect(s.byNodeId.sew.visitRatio).toBeCloseTo(1 / 0.85, 6);
  });

  it('every seeded system solves without error', () => {
    for (const sys of SEED_SYSTEMS) {
      const s = solveNetwork(sys);
      expect(s.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(Number.isFinite(s.totalL)).toBe(true);
    }
  });
});
