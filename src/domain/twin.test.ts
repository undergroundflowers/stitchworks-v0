import { describe, it, expect } from 'vitest';
import { DEFAULT_LINE_POLICY, emptyTwin, normalizeTwin, staffedOperatorsForLine } from '../domain/twin';

describe('emptyTwin (free-space seed)', () => {
  it('seeds exactly one sewing line so the analysis surfaces have a scope', () => {
    const t = emptyTwin('X');
    expect(t.lines).toHaveLength(1);
    // Seeded with the default policy. The line used to also carry a
    // `productionSystem` of 'PBS'; production systems are out of scope.
    expect(t.lines[0].policy).toEqual(DEFAULT_LINE_POLICY);
  });

  it('gives each new twin a distinct line id', () => {
    expect(emptyTwin('A').lines[0].id).not.toBe(emptyTwin('B').lines[0].id);
  });

  it('starts with no workstations — the floor is empty free space', () => {
    const t = emptyTwin('X');
    expect(t.workstations).toHaveLength(0);
  });
});

describe('normalizeTwin — v10 retires departments', () => {
  it('strips a stored departments array', () => {
    const legacy = {
      ...emptyTwin('Legacy'),
      departments: [{ id: 'dept-1', name: 'Sewing Floor', kind: 'Sewing', color: 'blue', bounds: { x: 0, y: 0, w: 10, h: 10 } }],
    };
    const t = normalizeTwin(legacy) as unknown as Record<string, unknown>;
    expect(t.departments).toBeUndefined();
  });

  it('strips deptId from workstations, lines and operators but keeps their geometry', () => {
    const base = emptyTwin('Legacy');
    const legacy = {
      ...base,
      lines: [{ ...base.lines[0], deptId: 'dept-1' }],
      workstations: [
        {
          id: 'ws-1',
          deptId: 'dept-1',
          catalogId: 'mach_ssm',
          name: 'Station',
          position: { x: 7, y: 3 },
          rotation: 0 as const,
          props: {},
          operation: { opId: null },
          resources: { workersRequired: 1, workerArchetypeId: null, materialsPerCycle: {}, machineId: null },
          kpiTargets: {},
        },
      ],
      operators: [{ id: 'opr-1', deptId: 'dept-1', name: 'OPR-01', skills: [] }],
    };
    const t = normalizeTwin(legacy);
    expect('deptId' in t.workstations[0]).toBe(false);
    expect('deptId' in t.lines[0]).toBe(false);
    expect('deptId' in (t.operators ?? [])[0]).toBe(false);
    // Geometry is untouched: a station that used to sit inside a zone stays
    // exactly where it was, it simply has no owner now.
    expect(t.workstations[0].position).toEqual({ x: 7, y: 3 });
  });
});

describe('staffedOperatorsForLine', () => {
  const base = emptyTwin('Staffed');
  const lineId = base.lines[0].id;

  function ws(
    id: string,
    over: Partial<{ lineId: string; opId: string | null; workersRequired: number }> = {},
  ) {
    return {
      id,
      lineId: 'lineId' in over ? over.lineId : lineId,
      catalogId: 'mach_ssm',
      name: id,
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      props: {},
      operation: { opId: 'opId' in over ? (over.opId ?? null) : 'op-1' },
      resources: {
        workersRequired: over.workersRequired ?? 1,
        workerArchetypeId: null,
        materialsPerCycle: {},
        machineId: null,
      },
      kpiTargets: {},
    };
  }

  it('sums workersRequired across the line when the twin carries no assignments', () => {
    const twin = { ...base, workstations: [ws('a'), ws('b', { workersRequired: 3 })] };
    expect(staffedOperatorsForLine(twin, lineId)).toBe(4);
  });

  it('counts an unstaffed station as one operator, matching the engine floor', () => {
    const twin = { ...base, workstations: [ws('a', { workersRequired: 0 })] };
    expect(staffedOperatorsForLine(twin, lineId)).toBe(1);
  });

  it('skips infrastructure — stations with no operation assigned', () => {
    const twin = { ...base, workstations: [ws('a'), ws('rack', { opId: null, workersRequired: 5 })] };
    expect(staffedOperatorsForLine(twin, lineId)).toBe(1);
  });

  it('ignores stations belonging to another line', () => {
    const twin = { ...base, workstations: [ws('a'), ws('other', { lineId: 'line-zzz' })] };
    expect(staffedOperatorsForLine(twin, lineId)).toBe(1);
  });

  it('prefers distinct non-floater assignments over workersRequired', () => {
    const twin = {
      ...base,
      workstations: [ws('a', { workersRequired: 4 })],
      operators: [
        { id: 'opr-1', name: 'One', skills: [] },
        { id: 'opr-2', name: 'Two', skills: [] },
        { id: 'opr-3', name: 'Three', skills: [] },
      ],
      assignments: [
        { id: 'as-1', wsId: 'a', operatorId: 'opr-1', role: 'primary' as const },
        { id: 'as-2', wsId: 'a', operatorId: 'opr-2', role: 'primary' as const },
        // Same operator twice — distinct ids, so this must not double-count.
        { id: 'as-3', wsId: 'a', operatorId: 'opr-2', role: 'primary' as const },
        // Floaters are pool capacity, not station staffing.
        { id: 'as-4', wsId: 'a', operatorId: 'opr-3', role: 'floater' as const },
      ],
    };
    expect(staffedOperatorsForLine(twin, lineId)).toBe(2);
  });
});
