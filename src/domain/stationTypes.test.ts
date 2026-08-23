import { describe, it, expect, beforeEach } from 'vitest';
import { runPmlSim } from '../simulation/pml-engine';
import { setStationTypes, lookupFixture, stationMark, stationTypeFor } from './fixture-registry';
import { normalizeStationType, type StationType } from './stationTypes';
import {
  makeWorkstation,
  normalizeTwin,
  newConnectorId,
  newTwinId,
  TWIN_SCHEMA_VERSION,
  type Twin,
} from './twin';
import { getBlockKind, pmlFixtureId } from './pml';

/**
 * User-authored station types.
 *
 * The point of a station type is that it behaves like a built-in fixture at
 * every layer it touches — it resolves to a drawable fixture, it carries a
 * PML kind and parameters onto the stations dropped from it, and the engine
 * runs it as that kind. These lock that in, plus the legacy-id rewrite that
 * keeps factories saved before the palette purge loadable.
 */

const IRON: StationType = normalizeStationType({
  id: 'cst-test-iron',
  label: 'Inline iron',
  group: 'Sewing fixtures',
  form: 'bench',
  glyph: 'plate',
  code: 'IRN',
  w: 2,
  d: 1,
  h: 1.1,
  kind: 'Service',
  params: { cycleS: 20 },
  createdAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => setStationTypes([IRON]));

describe('station type registry', () => {
  it('resolves an authored type to a fixture with its authored footprint', () => {
    const fx = lookupFixture(IRON.id);
    expect(fx).toBeDefined();
    expect(fx!.label).toBe('Inline iron');
    expect([fx!.w, fx!.d, fx!.h]).toEqual([2, 1, 1.1]);
  });

  it('still resolves built-in fixtures', () => {
    expect(lookupFixture('a_snls')?.label).toContain('Single-needle');
  });

  it('gives the 2D plan the authored mark rather than a machine code', () => {
    expect(stationMark(IRON.id)).toEqual({ family: 'plate', markCode: 'IRN' });
    expect(stationMark('a_snls')).toEqual({ code: 'SNL' });
  });

  it('leaves a block-form type unmarked — its identity is the PML icon', () => {
    setStationTypes([{ ...IRON, id: 'cst-block', form: 'block' }]);
    expect(stationMark('cst-block')).toEqual({});
  });

  it('does not resolve a type that is not registered', () => {
    expect(stationTypeFor('cst-nope')).toBeUndefined();
    expect(lookupFixture('cst-nope')).toBeUndefined();
  });
});

describe('dropping a station of an authored type', () => {
  it('stamps the type’s block kind and authored params', () => {
    const ws = makeWorkstation({ catalogId: IRON.id, position: { x: 0, y: 0 } });
    expect(ws.block?.kind).toBe('Service');
    expect(ws.block?.params?.cycleS).toBe(20);
    expect(ws.name).toBe('Inline iron');
  });

  it('lets an explicit caller param win over the type default', () => {
    const ws = makeWorkstation({
      catalogId: IRON.id,
      position: { x: 0, y: 0 },
      blockParams: { cycleS: 45 },
    });
    expect(ws.block?.params?.cycleS).toBe(45);
  });
});

describe('an authored station in a run', () => {
  /** Source → authored Service → Sink, wired end to end. */
  function twinWithAuthoredStation(): Twin {
    const source = makeWorkstation({ catalogId: pmlFixtureId('Source'), position: { x: 0, y: 0 } });
    source.block = { kind: 'Source', params: { sourceRatePerHr: 120 } };
    const iron = makeWorkstation({ catalogId: IRON.id, position: { x: 3, y: 0 } });
    const sink = makeWorkstation({ catalogId: pmlFixtureId('Sink'), position: { x: 6, y: 0 } });
    sink.block = { kind: 'Sink' };
    return {
      schemaVersion: TWIN_SCHEMA_VERSION,
      id: newTwinId(),
      name: 'authored-station fixture',
      parentTwinId: null,
      isCanonical: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      gridW: 12,
      gridH: 12,
      lines: [],
      workstations: [source, iron, sink],
      connectors: [
        { id: newConnectorId(), kind: 'flow', fromWsId: source.id, toWsId: iron.id },
        { id: newConnectorId(), kind: 'flow', fromWsId: iron.id, toWsId: sink.id },
      ],
      operators: [],
      assignments: [],
    };
  }

  it('runs as the Service block the type declares', () => {
    const twin = twinWithAuthoredStation();
    const iron = twin.workstations[1];
    expect(getBlockKind(iron)).toBe('Service');

    const r = runPmlSim({ twin, durationMin: 120, seed: 7, samplePeriodMin: 1 });
    expect(r.totalProduced).toBeGreaterThan(0);

    // It serviced agents itself rather than being scenery: a 20s cycle over
    // two hours is bounded by the station, so it must have been busy.
    const stats = r.blocks.get(iron.id);
    expect(stats).toBeDefined();
    expect(stats!.busyMin).toBeGreaterThan(0);
  });
});

describe('legacy catalog ids', () => {
  it('rewrites fixtures deleted with the old palette sections on load', () => {
    const t = normalizeTwin({
      schemaVersion: TWIN_SCHEMA_VERSION,
      workstations: [
        { id: 'w1', catalogId: 'op_sewer', name: 'Operators', position: { x: 0, y: 0 }, rotation: 0, props: {} },
        { id: 'w2', catalogId: 'a_iron_inline', name: 'Iron', position: { x: 1, y: 0 }, rotation: 0, props: {} },
        { id: 'w3', catalogId: 'a_bundle_trolley', name: 'Cart', position: { x: 2, y: 0 }, rotation: 0, props: {} },
        { id: 'w4', catalogId: 'a_snls', name: 'Untouched', position: { x: 3, y: 0 }, rotation: 0, props: {} },
      ],
    });
    expect(t.workstations.map((w) => w.catalogId)).toEqual([
      pmlFixtureId('ResourcePool'),
      'fx_press',
      'mh_trolley',
      'a_snls',
    ]);
    // Every rewritten id resolves — that is the whole point of the rewrite.
    for (const w of t.workstations) expect(lookupFixture(w.catalogId)).toBeDefined();
  });
});
