import { describe, it, expect } from 'vitest';
import { buildStarterLine } from '../domain/starter-line';
import { GARMENT_TEMPLATES } from '../domain/garments';
import {
  makeWorkstation,
  newConnectorId,
  newTwinId,
  wsBaseFootprint,
  TWIN_SCHEMA_VERSION,
  type Twin,
} from '../domain/twin';
import { pmlFixtureId } from '../domain/pml';
import { buildPmlTwinView } from './pml-to-sim-state';
import { buildSimConfigFromTwin } from './model-from-twin';

/**
 * The Run floor is the Build floor.
 *
 * `BuildFromTwinMeta.workstations` is the ONLY channel by which the
 * simulation's ISO / TOP / HEAT views learn where anything is. Everything
 * downstream of it now draws each cell at `projection.project(gx, gy)` with no
 * rebase, no normalisation and no re-centring, so if this carries the authored
 * numbers through unchanged then a machine is at the same coordinates, and
 * covers the same cells, in BUILD and in RUN.
 *
 * That was not true before. The renderer rebased every cell to
 * `2 + (gx - minX)`, and hard-coded a 0.9 x 1.4 footprint for every station
 * whatever machine it actually was. This file exists so neither can come
 * back silently: both are invisible in a screenshot of a factory you have not
 * memorised the coordinates of, which is why they survived so long.
 */
describe('the Run floor carries the Build floor coordinates', () => {
  const twin = buildStarterLine();
  const wsById = new Map(twin.workstations.map((w) => [w.id, w]));

  const views = [
    ['buildPmlTwinView', buildPmlTwinView(twin, GARMENT_TEMPLATES.tshirt).meta],
    [
      'buildSimConfigFromTwin',
      buildSimConfigFromTwin({
        twin,
        garmentsById: GARMENT_TEMPLATES,
        defaultGarmentId: 'tshirt',
      }).meta,
    ],
  ] as const;

  it('has workstations to check', () => {
    expect(twin.workstations.length).toBeGreaterThan(0);
    for (const [, meta] of views) {
      expect(meta.workstations.length).toBeGreaterThan(0);
    }
  });

  for (const [label, meta] of views) {
    it(`${label}: every cell sits at its workstation's authored position`, () => {
      for (const cell of meta.workstations) {
        const ws = wsById.get(cell.wsId);
        expect(ws, `${cell.wsId} is not in the twin`).toBeDefined();
        expect({ gx: cell.gx, gy: cell.gy }).toEqual({
          gx: ws!.position.x,
          gy: ws!.position.y,
        });
      }
    });

    it(`${label}: every cell carries its workstation's real footprint`, () => {
      for (const cell of meta.workstations) {
        const ws = wsById.get(cell.wsId)!;
        expect({ w: cell.w, d: cell.d, h: cell.h }).toEqual(wsBaseFootprint(ws));
        expect(cell.catalogId).toBe(ws.catalogId);
        expect(cell.rotation).toBe(ws.rotation ?? 0);
      }
    });
  }

  it('a per-workstation size override reaches the Run floor', () => {
    // Has to be a workstation the builder actually keeps — the twin also
    // holds Source / Sink / ResourcePool blocks, which are infrastructure and
    // never become cells.
    const targetId = views[0][1].workstations[0].wsId;
    const target = wsById.get(targetId)!;
    const resized = {
      ...twin,
      workstations: twin.workstations.map((w) =>
        w.id === target.id ? { ...w, size: { w: 3, d: 4, h: 2.5 } } : w,
      ),
    };
    const cell = buildPmlTwinView(resized, GARMENT_TEMPLATES.tshirt).meta.workstations.find(
      (c) => c.wsId === target.id,
    );
    expect(cell).toBeDefined();
    expect({ w: cell!.w, d: cell!.d, h: cell!.h }).toEqual({ w: 3, d: 4, h: 2.5 });
  });

  it('the two builders agree with each other, cell for cell', () => {
    const [, a] = views[0];
    const [, b] = views[1];
    const byId = (m: typeof a) =>
      new Map(m.workstations.map((c) => [c.wsId, { gx: c.gx, gy: c.gy, w: c.w, d: c.d }]));
    const A = byId(a);
    const B = byId(b);
    for (const [wsId, pos] of A) {
      if (!B.has(wsId)) continue; // the two builders can admit different sets
      expect(B.get(wsId)).toEqual(pos);
    }
  });
});

/**
 * …including a floor where nothing is bound to an operation yet.
 *
 * This is the hand-built case: you drop three sewing machines, wire a Source
 * and a Sink, and press play before touching the bulletin. The two builders
 * disagree about that factory — `buildSimConfigFromTwin` keeps only blocks
 * whose `operation.opId` resolves in a garment and THROWS when none do, while
 * the PML engine makes a station of every Service block and runs them off
 * their own cycle times.
 *
 * LiveSim used to take its floor plan from the builder that throws. The meta
 * came back null, `layoutStations` fell through to its synthetic row, and the
 * three running stations were drawn as evenly-spaced placeholder slabs at the
 * grid origin — labelled OP-1 / OP-2 / OP-3 GENERIC — while the user's real
 * blocks were drawn a second time as ambient scenery where they actually
 * stood. Everything below is what makes that impossible: the PML view is a
 * complete floor plan on its own.
 */
describe('a floor with no operations bound to it', () => {
  function unboundTwin(): Twin {
    const source = makeWorkstation({ catalogId: pmlFixtureId('Source'), position: { x: 1, y: 4 } });
    const sink = makeWorkstation({ catalogId: pmlFixtureId('Sink'), position: { x: 14, y: 4 } });
    const machines = [
      makeWorkstation({ catalogId: 'a_snls', position: { x: 4, y: 2 }, name: 'Front placket' }),
      makeWorkstation({ catalogId: 'a_4ol', position: { x: 7, y: 6 }, name: 'Side seam' }),
      makeWorkstation({ catalogId: 'a_flatlock', position: { x: 10, y: 3 }, name: 'Body hem' }),
    ];
    const chain = [source, ...machines, sink];
    return {
      schemaVersion: TWIN_SCHEMA_VERSION,
      id: newTwinId(),
      name: 'Hand-built',
      parentTwinId: null,
      isCanonical: true,
      createdAt: new Date(0).toISOString(),
      modifiedAt: new Date(0).toISOString(),
      gridW: 20,
      gridH: 12,
      lines: [],
      workstations: chain,
      connectors: chain.slice(0, -1).map((ws, i) => ({
        id: newConnectorId(),
        kind: 'flow' as const,
        fromWsId: ws.id,
        toWsId: chain[i + 1].id,
      })),
    };
  }

  const twin = unboundTwin();
  const meta = buildPmlTwinView(twin).meta;
  const stations = buildPmlTwinView(twin).stations;

  it('is exactly the factory the legacy builder refuses to build', () => {
    // Guards the premise. If this ever stops throwing, the ghost row it used
    // to trigger is gone for a different reason and this file should say so.
    expect(() =>
      buildSimConfigFromTwin({
        twin,
        garmentsById: GARMENT_TEMPLATES,
        defaultGarmentId: 'tshirt',
      }),
    ).toThrow(/no simulatable workstations/);
  });

  it('still makes a station of every Service block', () => {
    expect(stations).toHaveLength(3);
    expect(meta.simulatedWsIds).toHaveLength(3);
    // Source and Sink are wiring, not stations.
    expect(meta.infrastructure.map((i) => i.role).sort()).toEqual(['Sink', 'Source']);
  });

  it('places every station where the user put it', () => {
    const wsById = new Map(twin.workstations.map((w) => [w.id, w]));
    expect(meta.workstations).toHaveLength(3);
    for (const cell of meta.workstations) {
      const ws = wsById.get(cell.wsId)!;
      expect({ gx: cell.gx, gy: cell.gy }).toEqual({ gx: ws.position.x, gy: ws.position.y });
      expect(cell.catalogId).toBe(ws.catalogId);
      expect({ w: cell.w, d: cell.d, h: cell.h }).toEqual(wsBaseFootprint(ws));
    }
  });

  it('leaves no station for the floor to invent a position for', () => {
    // `layoutStations` only reaches its synthetic row when it can match none
    // of the engine's stations to a cell. Every station opId resolving here
    // is what keeps it on the authored-coordinate path.
    const cellOpIds = new Set(meta.workstations.map((c) => c.opId));
    for (const st of stations) expect(cellOpIds.has(st.opId)).toBe(true);
  });

  it('calls each station by its own name, never by its index', () => {
    expect(stations.map((s) => s.opName)).toEqual([
      'Front placket',
      'Side seam',
      'Body hem',
    ]);
    for (const st of stations) expect(st.opCode).toBeUndefined();
  });

  it('reads the machine type off the fixture instead of calling it GENERIC', () => {
    expect(stations.map((s) => s.machineCode)).toEqual(['SNL', '4OL', 'FL']);
  });
});
