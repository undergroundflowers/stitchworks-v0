import { describe, it, expect } from 'vitest';
import { emptyTwin, normalizeTwin } from '../domain/twin';

describe('emptyTwin (free-space seed)', () => {
  it('seeds exactly one sewing line so the analysis surfaces have a scope', () => {
    const t = emptyTwin('X');
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0].productionSystem).toBe('PBS');
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
