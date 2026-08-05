import { describe, it, expect } from 'vitest';
import { emptyTwin } from '../domain/twin';

describe('emptyTwin (sewing-centric seed)', () => {
  it('seeds exactly one Sewing department so stations have somewhere to land', () => {
    const t = emptyTwin('X');
    expect(t.departments).toHaveLength(1);
    expect(t.departments[0].kind).toBe('Sewing');
    expect(t.departments[0].bounds.w).toBeLessThanOrEqual(t.gridW);
    expect(t.departments[0].bounds.h).toBeLessThanOrEqual(t.gridH);
  });
  it('gives each new twin a distinct dept id', () => {
    expect(emptyTwin('A').departments[0].id).not.toBe(emptyTwin('B').departments[0].id);
  });
});
