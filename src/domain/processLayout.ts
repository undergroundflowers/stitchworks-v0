/**
 * Auto-layout for the PROCESS canvas — the "untangle" engine.
 *
 * The freeform editor positions every block from its authored
 * `block.processPos`. When a block has none (legacy twin, demo twin, freshly
 * dropped, or after the user hits "Auto-arrange"), it falls back to the seed
 * computed here.
 *
 * A real sewing line is a long tandem chain (hundreds of stations). Laying it
 * out as one horizontal strip is unreadable (50k+ px wide) and any displaced
 * block throws connectors across the whole canvas. So the seed:
 *   1. sequences each department's flow blocks along the CONNECTOR graph
 *      (topological order, tie-broken by physical x), not raw x-position, so
 *      blocks sit in true process order; and
 *   2. serpentine-wraps that sequence into rows, so consecutive blocks stay
 *      adjacent (short wires) and the line reads as a compact grid.
 *
 * Pure + deterministic — no React, no store.
 */
import type { Twin } from './twin';
import { getBlockSpec } from './pml';

/** Symbol-square footprint on the PROCESS canvas, in SVG px. Blocks render
 *  AnyLogic-style — a small category-coloured glyph square with the station
 *  name beneath it — so this is the square the ports attach to, NOT a wide
 *  card. Shared with the editor so a seeded position lines up exactly with the
 *  rendered symbol. */
export const PROCESS_BLOCK_W = 56;
export const PROCESS_BLOCK_H = 56;

// Layout geometry. The symbols are small, so columns/rows are spaced well wider
// than the symbol itself to leave room for the centred name label beneath each
// block (and short, legible wires between them).
export const PROCESS_GAP_X = 104; // horizontal gap between columns → 160px step
export const PROCESS_ROW_GAP = 64; // vertical gap between rows → 120px step (holds the label)
export const PROCESS_LANE_GAP = 28; // gap between department lanes
export const PROCESS_LANE_PAD_TOP = 28; // label strip height inside a lane
export const PROCESS_LANE_PAD_BOTTOM = 24;
export const PROCESS_LANE_LABEL_W = 140;
export const PROCESS_PAD_X = 24 + PROCESS_LANE_LABEL_W;
export const PROCESS_PAD_TOP = 64;

/** Columns per row before the sequence wraps. Keeps a long tandem line as a
 *  readable grid instead of an endless horizontal strip. */
export const PROCESS_ROW_MAX = 16;

const COL_W = PROCESS_BLOCK_W + PROCESS_GAP_X;
const ROW_H = PROCESS_BLOCK_H + PROCESS_ROW_GAP;

export interface ProcessLane {
  /** Real sewing-line id, or the synthetic keys `'__unassigned__'` /
   *  `'__pool__'`. Lanes are per-line: the floor is free space, so a line is
   *  the only real grouping a block can belong to. */
  lineId: string | null;
  synthetic: boolean;
  /** Top Y of the lane band, in SVG px. */
  y: number;
  /** Band height, in SVG px (grows with the number of wrapped rows). */
  height: number;
  /** Workstation ids placed in this lane (flow order). */
  wsIds: string[];
}

export interface ProcessSeedLayout {
  /** Top-left (x,y) in SVG px for every workstation. */
  positions: Map<string, { x: number; y: number }>;
  /** Lane bands, top→bottom — for backdrop rendering + drop-target hit tests. */
  lanes: ProcessLane[];
}

/**
 * Topological order of `ids` over the flow-connector graph, tie-broken by
 * physical x so authored left-to-right lines keep their sequence. Resilient to
 * cycles (rework loops) and disconnected blocks: anything not reachable by the
 * topo pass is appended in x order.
 */
function flowOrder(
  ids: string[],
  posX: Map<string, number>,
  succ: Map<string, string[]>,
  indeg: Map<string, number>,
): string[] {
  const idSet = new Set(ids);
  const byX = (a: string, b: string) => (posX.get(a) ?? 0) - (posX.get(b) ?? 0);
  const rem = new Map<string, number>();
  for (const id of ids) {
    // Count only in-edges from within this lane.
    rem.set(id, indeg.get(id) ?? 0);
  }
  const placed = new Set<string>();
  const order: string[] = [];
  const ready = ids.filter((id) => (rem.get(id) ?? 0) === 0);
  while (ready.length > 0) {
    ready.sort(byX);
    const id = ready.shift()!;
    if (placed.has(id)) continue;
    placed.add(id);
    order.push(id);
    for (const s of succ.get(id) ?? []) {
      if (!idSet.has(s) || placed.has(s)) continue;
      rem.set(s, (rem.get(s) ?? 0) - 1);
      if ((rem.get(s) ?? 0) <= 0) ready.push(s);
    }
  }
  // Cycle / disconnected remainder — append in x order.
  if (order.length < ids.length) {
    for (const id of ids.filter((i) => !placed.has(i)).sort(byX)) order.push(id);
  }
  return order;
}

/**
 * Place an ordered id list into a serpentine grid starting at `top`. Even rows
 * run left→right, odd rows right→left, so the last block of one row is directly
 * above the first block of the next — keeping inter-row wires short. Returns the
 * number of rows used.
 */
function placeSerpentine(
  order: string[],
  top: number,
  positions: Map<string, { x: number; y: number }>,
): number {
  if (order.length === 0) return 0;
  const rows = Math.ceil(order.length / PROCESS_ROW_MAX);
  order.forEach((id, i) => {
    const row = Math.floor(i / PROCESS_ROW_MAX);
    const within = i % PROCESS_ROW_MAX;
    const col = row % 2 === 0 ? within : PROCESS_ROW_MAX - 1 - within;
    positions.set(id, { x: PROCESS_PAD_X + col * COL_W, y: top + row * ROW_H });
  });
  return rows;
}

const laneHeight = (rows: number) =>
  PROCESS_LANE_PAD_TOP + Math.max(1, rows) * ROW_H + PROCESS_LANE_PAD_BOTTOM;

/**
 * Compute the full seed layout: one lane per department (reading order), flow
 * blocks sequenced + serpentine-wrapped, then orphan blocks, then a final
 * ResourcePool lane.
 */
export function computeProcessSeedLayout(twin: Twin): ProcessSeedLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const lanes: ProcessLane[] = [];

  const posX = new Map<string, number>();
  const isPool = new Map<string, boolean>();
  for (const ws of twin.workstations) {
    posX.set(ws.id, ws.position.x);
    isPool.set(ws.id, getBlockSpec(ws).kind === 'ResourcePool');
  }

  // Flow-edge adjacency over non-pool blocks. Operator/material edges to pools
  // don't define line order, so they're skipped.
  const succ = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const ws of twin.workstations) {
    succ.set(ws.id, []);
    indeg.set(ws.id, 0);
  }
  for (const c of twin.connectors ?? []) {
    if (isPool.get(c.fromWsId) || isPool.get(c.toWsId)) continue;
    if (!succ.has(c.fromWsId) || !indeg.has(c.toWsId)) continue;
    succ.get(c.fromWsId)!.push(c.toWsId);
    indeg.set(c.toWsId, (indeg.get(c.toWsId) ?? 0) + 1);
  }

  // One lane per sewing line, ordered by where the line actually sits on the
  // floor (top-left-most member station) so the diagram reads in the same
  // order as the plan.
  const lineAnchor = new Map<string, { x: number; y: number }>();
  for (const w of twin.workstations) {
    if (!w.lineId || isPool.get(w.id)) continue;
    const cur = lineAnchor.get(w.lineId);
    if (!cur || w.position.y < cur.y || (w.position.y === cur.y && w.position.x < cur.x)) {
      lineAnchor.set(w.lineId, { x: w.position.x, y: w.position.y });
    }
  }
  const ordered = [...(twin.lines ?? [])].sort((a, b) => {
    const pa = lineAnchor.get(a.id) ?? { x: Infinity, y: Infinity };
    const pb = lineAnchor.get(b.id) ?? { x: Infinity, y: Infinity };
    if (pa.y !== pb.y) return pa.y - pb.y;
    return pa.x - pb.x;
  });

  let cursorY = PROCESS_PAD_TOP;

  ordered.forEach((l) => {
    const ids = twin.workstations
      .filter((w) => w.lineId === l.id && !isPool.get(w.id))
      .map((w) => w.id);
    if (ids.length === 0) return;
    const rows = placeSerpentine(
      flowOrder(ids, posX, succ, indeg),
      cursorY + PROCESS_LANE_PAD_TOP,
      positions,
    );
    const height = laneHeight(rows);
    lanes.push({ lineId: l.id, synthetic: false, y: cursorY, height, wsIds: ids });
    cursorY += height + PROCESS_LANE_GAP;
  });

  // Blocks that belong to no line — expected now, not defensive: the floor is
  // free space, so an unlined station is a normal thing to author.
  const lineIds = new Set((twin.lines ?? []).map((l) => l.id));
  const orphan = twin.workstations
    .filter((w) => !isPool.get(w.id) && !(w.lineId && lineIds.has(w.lineId)))
    .map((w) => w.id);
  if (orphan.length > 0) {
    const rows = placeSerpentine(
      flowOrder(orphan, posX, succ, indeg),
      cursorY + PROCESS_LANE_PAD_TOP,
      positions,
    );
    const height = laneHeight(rows);
    lanes.push({ lineId: '__unassigned__', synthetic: true, y: cursorY, height, wsIds: orphan });
    cursorY += height + PROCESS_LANE_GAP;
  }

  // Resource-pool lane — index order (no flow), serpentine-wrapped.
  const pools = twin.workstations.filter((w) => isPool.get(w.id)).map((w) => w.id);
  if (pools.length > 0) {
    const rows = placeSerpentine(pools, cursorY + PROCESS_LANE_PAD_TOP, positions);
    const height = laneHeight(rows);
    lanes.push({ lineId: '__pool__', synthetic: true, y: cursorY, height, wsIds: pools });
    cursorY += height + PROCESS_LANE_GAP;
  }

  return { positions, lanes };
}

/** Convenience wrapper returning just the position map. */
export function seedProcessLayout(twin: Twin): Map<string, { x: number; y: number }> {
  return computeProcessSeedLayout(twin).positions;
}
