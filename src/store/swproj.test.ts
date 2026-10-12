import { describe, it, expect, beforeEach } from 'vitest';
import { buildSwproj, parseSwproj, applySwproj, archiveAndImportSwproj } from './swproj';
import { useFactoryLibrary } from './factoryLibrary';
import { useProject } from './project';
import { useTwin, TWIN_STORE_SCHEMA_VERSION } from './twin';
import { buildStarterLine } from '../domain/starter-line';

/**
 * Guards the project file format — the regression that motivated it was an
 * export that silently dropped the twin (factory layout). These lock in:
 * lossless project+twin round-trip, backward-compatible legacy import, and
 * that malformed / newer-version / garbage files are rejected (not applied).
 */
describe('.swproj format', () => {
  function sampleTwinExport() {
    const canonical = buildStarterLine();
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
    expect(parsed.twin?.canonical.lines.length).toBe(twin.canonical.lines.length);
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

  it('carries authored station types through export → load', () => {
    // The library archive and the .swproj file both go through
    // exportProject / loadProject, and `exportProject` names its fields
    // explicitly — so a slice added to the store is dropped on save unless
    // it is named there too. This is the guard for that.
    const type = {
      id: 'cst-roundtrip',
      label: 'Inline iron',
      group: 'Sewing fixtures',
      form: 'bench' as const,
      glyph: 'plate' as const,
      code: 'IRN',
      w: 2,
      d: 1,
      h: 1.1,
      kind: 'Service' as const,
      params: { cycleS: 20 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    useProject.getState().addStationType(type);

    const exported = useProject.getState().exportProject();
    expect(exported.stationTypes).toContainEqual(type);

    useProject.getState().removeStationType(type.id);
    expect(useProject.getState().stationTypes).toHaveLength(0);

    const applied = applySwproj(parseSwproj(JSON.parse(JSON.stringify(
      buildSwproj(exported, sampleTwinExport(), '2026-01-01T00:00:00.000Z'),
    ))));
    expect(applied.ok).toBe(true);
    expect(useProject.getState().stationTypes).toContainEqual(type);
  });

  it('applySwproj restores the twin into the live store', () => {
    const project = useProject.getState().exportProject();
    const demo = buildStarterLine();
    const env = buildSwproj(
      project,
      { schemaVersion: TWIN_STORE_SCHEMA_VERSION, canonical: demo, scenarios: [], activeScenarioId: null },
      '2026-01-01T00:00:00.000Z',
    );
    const result = applySwproj(parseSwproj(JSON.parse(JSON.stringify(env))));
    expect(result.ok).toBe(true);
    expect(useTwin.getState().canonical.workstations.length).toBe(demo.workstations.length);
  });
});

/**
 * The Menu's import is a different gesture from Settings' import: Settings
 * restores OVER the open factory, the Menu opens the file AS a factory and
 * puts the one you were on into the library. These lock in the part that
 * makes that safe — the archive happens first, and a file that parses but
 * won't load leaves the app exactly where it was.
 */
describe('archiveAndImportSwproj (Menu import)', () => {
  function envelopeNamed(name: string) {
    const project = { ...useProject.getState().exportProject(), meta: { ...useProject.getState().meta, name } };
    const env = buildSwproj(
      project,
      {
        schemaVersion: TWIN_STORE_SCHEMA_VERSION,
        canonical: buildStarterLine(name),
        scenarios: [],
        activeScenarioId: null,
      },
      '2026-01-01T00:00:00.000Z',
    );
    return JSON.parse(JSON.stringify(env));
  }

  beforeEach(() => {
    useFactoryLibrary.setState({ savedFactories: [] });
    useProject.getState().rename('Open Factory');
    useTwin.getState().renameActive('Open Factory');
  });

  it('opens the file as the active factory and archives the previous one', () => {
    const result = archiveAndImportSwproj(envelopeNamed('Imported Line'));

    expect(result.ok).toBe(true);
    expect(result.name).toBe('Imported Line');
    expect(result.archivedAs).toBe('Open Factory');
    expect(useProject.getState().meta.name).toBe('Imported Line');
    expect(useTwin.getState().canonical.name).toBe('Imported Line');
    expect(useFactoryLibrary.getState().savedFactories.map((f) => f.name)).toEqual(['Open Factory']);
  });

  it('suffixes a name that collides with a factory already in the library', () => {
    archiveAndImportSwproj(envelopeNamed('Brandix'));
    const second = archiveAndImportSwproj(envelopeNamed('Brandix'));

    expect(second.ok).toBe(true);
    expect(second.name).toBe('Brandix (2)');
    expect(useFactoryLibrary.getState().savedFactories.map((f) => f.name)).toEqual([
      'Brandix',
      'Open Factory',
    ]);
  });

  it('rolls back to the open factory when the payload will not load', () => {
    const env = envelopeNamed('Broken');
    // A workstation pointing at a line that isn't in the twin — parses fine,
    // fails validateTwin.
    env.data.twin.canonical.workstations[0].lineId = 'line-that-does-not-exist';

    const result = archiveAndImportSwproj(env);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Factory layout invalid/);
    expect(useProject.getState().meta.name).toBe('Open Factory');
    expect(useFactoryLibrary.getState().savedFactories).toHaveLength(0);
  });

  it('throws on a file that is not a project at all', () => {
    expect(() => archiveAndImportSwproj({ hello: 'world' })).toThrow(/Unrecognised/);
    expect(useProject.getState().meta.name).toBe('Open Factory');
  });
});
