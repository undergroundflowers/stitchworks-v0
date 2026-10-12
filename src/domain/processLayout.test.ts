import { describe, it, expect } from 'vitest';
import { emptyTwin, makeWorkstation, newConnectorId, type Twin } from './twin';
import {
  freezeProcessSeed,
  resolveProcessPositions,
  computeProcessSeedPositions,
  portOffsetY,
  processWirePath,
  PROCESS_BLOCK_H,
  PROCESS_BLOCK_W,
  PROCESS_PORT_GAP,
  PROCESS_PORT_HALO,
  PROCESS_PORT_OUTER_R,
  PROCESS_PORT_OVERHANG,
  PROCESS_PORT_PITCH,
  PROCESS_PORT_R,
  PROCESS_RING_INSET,
  PROCESS_RING_STROKE,
  processContentBounds,
} from './processLayout';

/** A twin with `n` unlined blocks on the floor, left to right. Unlined on
 *  purpose: an unlined station is the normal thing to author on a free floor,
 *  and it is the case the seed re-derives most aggressively. */
function twinWith(catalogIds: string[]): Twin {
  const base = emptyTwin('T');
  return {
    ...base,
    workstations: catalogIds.map((catalogId, i) =>
      makeWorkstation({ catalogId, position: { x: i * 2, y: 0 } }),
    ),
  };
}

const posOf = (t: Twin, id: string) => resolveProcessPositions(t).get(id)!;

describe('freezeProcessSeed — a block only moves when the user moves it', () => {
  it('pins every block that was still riding the seed', () => {
    const t = twinWith(['pml_service', 'pml_service']);
    const frozen = freezeProcessSeed(t);
    for (const w of frozen.workstations) {
      expect(w.block?.processPos).toBeDefined();
    }
  });

  it('pins them exactly where they were already rendering', () => {
    const t = twinWith(['pml_service', 'pml_queue', 'pml_sink']);
    const before = resolveProcessPositions(t);
    const frozen = freezeProcessSeed(t);
    for (const w of t.workstations) {
      expect(posOf(frozen, w.id)).toEqual(before.get(w.id)!);
    }
  });

  it('leaves an authored position alone', () => {
    const t = twinWith(['pml_service']);
    const hand = { x: 500, y: 340 };
    const authored: Twin = {
      ...t,
      workstations: t.workstations.map((w) => ({
        ...w,
        block: { ...(w.block ?? { kind: 'Service' as const }), processPos: hand },
      })),
    };
    expect(posOf(freezeProcessSeed(authored), t.workstations[0].id)).toEqual(hand);
  });

  it('returns the same object when nothing is left to pin', () => {
    const frozen = freezeProcessSeed(twinWith(['pml_service']));
    expect(freezeProcessSeed(frozen)).toBe(frozen);
  });

  // ── The regressions this exists to prevent ────────────────────────────────

  it('adding a block does not move the blocks already on the canvas', () => {
    const t = twinWith(['pml_service', 'pml_service']);
    const before = resolveProcessPositions(t);

    // What the store does: freeze, THEN apply the mutation.
    const frozen = freezeProcessSeed(t);
    const withSource: Twin = {
      ...frozen,
      workstations: [
        // A Source lands leftmost on the floor, which is exactly what
        // re-shuffled the flow order and slid every other block along.
        makeWorkstation({ catalogId: 'pml_source', position: { x: -5, y: 0 } }),
        ...frozen.workstations,
      ],
    };

    for (const w of t.workstations) {
      expect(posOf(withSource, w.id)).toEqual(before.get(w.id)!);
    }
  });

  it('wiring two blocks together does not move anything', () => {
    const t = twinWith(['pml_service', 'pml_service', 'pml_service']);
    const before = resolveProcessPositions(t);
    const [a, b, c] = t.workstations;

    const frozen = freezeProcessSeed(t);
    // A back-edge — the case that most changes the topological order.
    const wired: Twin = {
      ...frozen,
      connectors: [
        { id: newConnectorId(), kind: 'flow', fromWsId: c.id, toWsId: a.id },
        { id: newConnectorId(), kind: 'flow', fromWsId: a.id, toWsId: b.id },
      ],
    };

    // The seed genuinely disagrees now — that is the point of the test.
    expect(computeProcessSeedPositions(wired).get(b.id)).not.toEqual(before.get(b.id));
    for (const w of t.workstations) {
      expect(posOf(wired, w.id)).toEqual(before.get(w.id)!);
    }
  });

  it('moving a station on the FLOOR does not move its block on PROCESS', () => {
    const t = twinWith(['pml_service', 'pml_service']);
    const before = resolveProcessPositions(t);
    const [a, b] = t.workstations;

    const frozen = freezeProcessSeed(t);
    // Drag `b` to the left of `a` on the floor — the seed ties flow order
    // by physical x, so unfrozen this swapped their columns.
    const moved: Twin = {
      ...frozen,
      workstations: frozen.workstations.map((w) =>
        w.id === b.id ? { ...w, position: { x: -10, y: 0 } } : w,
      ),
    };

    expect(posOf(moved, a.id)).toEqual(before.get(a.id)!);
    expect(posOf(moved, b.id)).toEqual(before.get(b.id)!);
  });
});

describe('processContentBounds', () => {
  it('frames the port dots, not just the block faces', () => {
    const t = twinWith(['pml_service']);
    const p = posOf(t, t.workstations[0].id);
    const bounds = processContentBounds(t)!;
    expect(bounds.minX).toBe(p.x - PROCESS_PORT_OVERHANG);
    expect(bounds.maxX).toBe(p.x + PROCESS_BLOCK_W + PROCESS_PORT_OVERHANG);
    expect(bounds.maxY).toBeGreaterThan(p.y + PROCESS_BLOCK_H);
  });

  it('is null for an empty twin', () => {
    expect(processContentBounds(emptyTwin('T'))).toBeNull();
  });
});


describe('port geometry — a port dot is never under another graphic', () => {
  it('clears the selection ring on both edges', () => {
    // The ring's outer edge, measured from the block face.
    const ringOuter = PROCESS_RING_INSET + PROCESS_RING_STROKE / 2;
    // The nearest a port ever gets to the face, in its widest state.
    const dotInner = PROCESS_PORT_GAP - PROCESS_PORT_OUTER_R;
    // Not merely "does not intersect" — there has to be visible daylight, or
    // the two read as one graphic at any zoom below 1.
    expect(dotInner - ringOuter).toBeGreaterThanOrEqual(2);
  });

  it('trims a wire short enough to leave the dot itself uncovered', () => {
    // The halo is where the wire stops. If it were smaller than the dot, the
    // arrowhead would sit on the dot again — the thing this all fixes.
    expect(PROCESS_PORT_HALO).toBeGreaterThan(PROCESS_PORT_R);
  });

  it('keeps neighbouring dots in a column apart, even on SelectOutput5', () => {
    for (const count of [1, 2, 3, 5]) {
      const ys = Array.from({ length: count }, (_, i) =>
        portOffsetY(i, count, PROCESS_BLOCK_H),
      );
      for (let i = 1; i < ys.length; i++) {
        // Two touching dots at rest span 2 · R; the pitch has to beat that,
        // and never falls below the floor even when the face runs out of room.
        expect(ys[i] - ys[i - 1]).toBeGreaterThan(PROCESS_PORT_R * 2);
        expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(PROCESS_PORT_PITCH - 1e-9);
      }
    }
  });

  it('centres a port column on the block face', () => {
    for (const count of [1, 2, 3, 5]) {
      const ys = Array.from({ length: count }, (_, i) =>
        portOffsetY(i, count, PROCESS_BLOCK_H),
      );
      expect((ys[0] + ys[ys.length - 1]) / 2).toBeCloseTo(PROCESS_BLOCK_H / 2, 5);
    }
  });

  it('leaves the single-port case exactly where it always was', () => {
    expect(portOffsetY(0, 1, PROCESS_BLOCK_H)).toBe(PROCESS_BLOCK_H / 2);
    expect(portOffsetY(0, 2, PROCESS_BLOCK_H)).toBeCloseTo(PROCESS_BLOCK_H / 3, 5);
  });
});

describe('processWirePath — the wire meets the ports it connects', () => {
  const a = { x: 100, y: 50 };
  const b = { x: 300, y: 50 };
  const nums = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);

  it('starts at the source dot\u2019s rim and stops at the target dot\u2019s rim', () => {
    const [x0, y0, , , , , x3, y3] = nums(processWirePath(a, b));
    // Trimmed OUT of the source and SHORT of the target — centre-to-centre is
    // what put the arrowhead on top of the input dot.
    expect(x0).toBe(a.x + PROCESS_PORT_HALO);
    expect(y0).toBe(a.y);
    expect(x3).toBe(b.x - PROCESS_PORT_HALO);
    expect(y3).toBe(b.y);
  });

  it('draws a straight line between two ports on the same row', () => {
    const [, y0, , y1, , y2, , y3] = nums(processWirePath(a, b));
    expect([y1, y2, y3]).toEqual([y0, y0, y0]);
  });

  it('keeps both control points between the endpoints on a forward run', () => {
    const [x0, , cx1, , cx2, , x3] = nums(processWirePath(a, b));
    expect(cx1).toBeGreaterThanOrEqual(x0);
    expect(cx1).toBeLessThanOrEqual(x3);
    expect(cx2).toBeGreaterThanOrEqual(x0);
    expect(cx2).toBeLessThanOrEqual(x3);
  });

  it('bows outward rather than folding back when the target is behind', () => {
    // `max(28, dx / 2)` used to put the SECOND control point to the LEFT of
    // the first here, which is what made a rework loop cross itself.
    const [x0, , cx1, , cx2, , x3] = nums(processWirePath(b, a));
    expect(cx1).toBeGreaterThan(x0);
    expect(cx2).toBeLessThan(x3);
  });

  it('never lets the control offset run away on a long haul', () => {
    const [x0, , cx1] = nums(processWirePath({ x: 0, y: 0 }, { x: 6000, y: 0 }));
    expect(cx1 - x0).toBeLessThanOrEqual(140);
  });
});
