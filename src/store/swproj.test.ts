import { describe, it, expect } from 'vitest';
import { buildSwproj, parseSwproj, applySwproj } from './swproj';
import { useProject } from './project';
import { useTwin, TWIN_STORE_SCHEMA_VERSION } from './twin';
import { buildDemoTwin } from '../domain/twin';

/**
 * Guards the project file format — the regression that motivated it was an
 * export that silently dropped the twin (factory layout). These lock in:
 * lossless project+twin round-trip, backward-compatible legacy import, and
 * that malformed / newer-version / garbage files are rejected (not applied).
 */
describe('.swproj format', () => {
  function sampleTwinExport() {
    const canonical = buildDemoTwin();
    // Track the constant, not a literal. `buildSwproj` always stamps the
    // CURRENT store version into the envelope, so hardcoding a number here
    // asserts nothing except that the constant hasn't moved since the test
    // was written — it broke on the first legitimate schema bump.
    return {
      schemaVersion: TWIN_STORE_SCHEMA_VERSION,
      canonical,
      scenarios: [],
      activeScenarioId: null,
    };
  }

  it('round-trips project + twin through build → parse losslessly', () => {
    const project = useProject.getState().exportProject();
    const twin = sampleTwinExport();
    const env = buildSwproj(project, twin, '2026-01-01T00:00:00.000Z');

    expect(env.format).toBe('stitchworks-project');
    expect(env.formatVersion).toBe(1);
    expect(env.schemas.twin).toBe(twin.schemaVersion);

    const parsed = parseSwproj(JSON.parse(JSON.stringify(env)));
    expect(parsed.legacy).toBe(false);
    expect(parsed.twin?.canonical.workstations.length).toBe(twin.canonical.workstations.length);
    expect(parsed.twin?.canonical.departments.length).toBe(twin.canonical.departments.length);
    expect(parsed.project.meta.name).toBe(project.meta.name);
  });

  it('detects legacy bare-project files (no twin)', () => {
    const parsed = parseSwproj({ schemaVersion: 2, meta: { name: 'Legacy' } });
    expect(parsed.legacy).toBe(true);
    expect(parsed.twin).toBeNull();
    expect(parsed.project.meta.name).toBe('Legacy');
  });

  it('rejects a malformed envelope (missing data.project)', () => {
    expect(() =>
      parseSwproj({ format: 'stitchworks-project', formatVersion: 1, data: {} }),
    ).toThrow(/data\.project/);
  });

  it('rejects a file from a newer format version', () => {
    expect(() =>
      parseSwproj({
        format: 'stitchworks-project',
        formatVersion: 99,
        data: { project: { schemaVersion: 2, meta: { name: 'x' } }, twin: { canonical: {} } },
      }),
    ).toThrow(/newer/i);
  });

  it('rejects unrecognised files', () => {
    expect(() => parseSwproj({ hello: 'world' })).toThrow();
    expect(() => parseSwproj(null)).toThrow();
  });

  it('applySwproj restores the twin into the live store', () => {
    const project = useProject.getState().exportProject();
    const demo = buildDemoTwin();
    const env = buildSwproj(
      project,
      { schemaVersion: 5, canonical: demo, scenarios: [], activeScenarioId: null },
      '2026-01-01T00:00:00.000Z',
    );
    const result = applySwproj(parseSwproj(JSON.parse(JSON.stringify(env))));
    expect(result.ok).toBe(true);
    expect(useTwin.getState().canonical.workstations.length).toBe(demo.workstations.length);
  });
});
