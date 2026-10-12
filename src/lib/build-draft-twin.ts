/**
 * Shared "blank draft factory + seeded sewing line" builder.
 *
 * Used by the Orders ("Build in Builder") and Simulation ("Edit in Builder")
 * flows to spin up a fresh, isolated Factory Builder draft in a new browser
 * tab without touching the user's canonical factory.
 *
 * The result is a fully-populated Twin with:
 *   - One SewingLine carrying the garment and the operator target.
 *   - One Workstation per operation in the garment's bulletin, laid out as a
 *     snaking grid that wraps inside a rectangular footprint.
 *   - One primary operator per workstation, 1:1.
 *
 * Layout, carrier and staffing all used to branch on the line's production
 * system — a snake for PBS, a single row for straight/synchro/UPS, a U-cell
 * with rotating operators for modular, and a carrier of bundle / piece /
 * hanger / takt to match. Production systems are out of scope, so the seeder
 * keeps what PBS did: the snake is the only layout that stays on screen for a
 * real 25-op bulletin, and 1:1 staffing is what every system except modular
 * used anyway. The user re-arranges the floor in Builder regardless — this is
 * a starting point, not a claim about how the line is organised.
 *
 * The mapping from machine code (DNL, SNL, 4OL, …) to iso-catalog id reuses
 * `catalogForMachine` from `domain/reference-twin.ts` so a draft line looks
 * visually identical to a reference-paper line.
 */

import {
  DEFAULT_LINE_POLICY,
  emptyTwin,
  makeWorkstation,
  newAssignmentId,
  newConnectorId,
  newLineId,
  newOperatorId,
  type Assignment,
  type Connector,
  type EntityColorKey,
  type MaterialFlow,
  type Operator,
  type SewingLine,
  type Twin,
  type Vec2,
  type Workstation,
} from '../domain/twin';
import type { GarmentTemplate } from '../domain/garments';
import type { Operation } from '../domain/operations';
import { catalogForMachine } from '../domain/reference-twin';

// ── Layout geometry ────────────────────────────────────────────────────────

/** Horizontal spacing between adjacent workstations, in cells. */
const STATION_DX = 3;
/** Vertical spacing between rows of workstations, in cells. */
const ROW_DY = 4;
/** How wide the snaking grid can grow before wrapping to a new row. */
const STATIONS_PER_ROW = 7;
/** Origin of the dept inside the twin's world grid. */
const DEPT_ORIGIN_X = 2;
const DEPT_ORIGIN_Y = 2;
/** Interior gutter inside the dept before the first station. */
const STATION_INSET = 2;

export interface DraftLineSeed {
  /** Display name used for the draft factory and the seeded SewingLine. */
  draftName: string;
  /** Garment template the line should produce. When supplied, the helper
   *  auto-places one workstation per operation in the bulletin. */
  garment?: GarmentTemplate;
  /** Operator target rolled up onto the SewingLine entity. */
  operatorTarget: number;
  /** Accent colour for the line — defaults to `'brand'`. */
  color?: EntityColorKey;
  /** Free-form notes (PO number, deadline) recorded on the line. */
  notes?: string;
}

export interface DraftBuildResult {
  twin: Twin;
  lineId: string;
}

// ── Topology helpers ──────────────────────────────────────────────────────

/** Position one workstation per operation, in op-order, as a snaking grid —
 *  the line wraps inside a rectangular footprint the way a real floor does,
 *  so a 25-op bulletin stays on screen instead of running off to the right. */
function layoutStations(opCount: number): Vec2[] {
  const ox = DEPT_ORIGIN_X + STATION_INSET;
  const oy = DEPT_ORIGIN_Y + STATION_INSET;
  return Array.from({ length: opCount }, (_, i) => {
    const row = Math.floor(i / STATIONS_PER_ROW);
    const col = i % STATIONS_PER_ROW;
    const colInRow = row % 2 === 0 ? col : STATIONS_PER_ROW - 1 - col;
    return { x: ox + colInRow * STATION_DX, y: oy + row * ROW_DY };
  });
}

/** Bounding box that contains the laid-out stations. */
function deptSizeFor(opCount: number): { w: number; h: number } {
  const rows = Math.max(1, Math.ceil(opCount / STATIONS_PER_ROW));
  return {
    w: Math.max(18, STATIONS_PER_ROW * STATION_DX + 4),
    h: Math.max(10, rows * ROW_DY + 4),
  };
}

/** What material moves between two stations. Tied bundles, sized from the
 *  line's policy — `MaterialFlow` still carries 'piece' / 'hanger' / 'takt'
 *  for connectors authored by hand, but the seeder no longer picks between
 *  them off a production system. */
function carrierFor(bundleSize?: number): MaterialFlow {
  return { carrier: 'bundle', bundleSize: bundleSize ?? DEFAULT_LINE_POLICY.bundleSize };
}

/**
 * Seed Operator + Assignment rows. Returns the rows ready to splice into the
 * Twin payload: one primary operator per station, shareFrac 1.
 *
 * There used to be a second path here. A `modular` line got
 * `rotationGroupSize` multi-skilled operators sharing every station via
 * `rotation_member` assignments with a position-coded `rotationOrder`, while
 * every other system got the 1:1 staffing below. Production systems are out
 * of scope, so the seeder no longer chooses — but `rotation_member` and
 * `rotationOrder` remain in the Assignment model, so a rotation cell is still
 * expressible by hand, and re-seeding one is a small change if systems come
 * back.
 *
 * Skills are inferred from each operation's declared `skill` field.
 */
function seedOperatorsAndAssignments(args: {
  ops: Operation[];
  workstations: Workstation[];
  lineId: string;
}): { operators: Operator[]; assignments: Assignment[] } {
  const { ops, workstations, lineId } = args;
  if (workstations.length === 0) {
    return { operators: [], assignments: [] };
  }

  // One primary operator per workstation, named after the op they're tied
  // to. Per-operator skills are just the one skill that op requires —
  // sufficient for the engine; the user cross-trains in Resources.
  const operators: Operator[] = workstations.map((_ws, i) => ({
    id: newOperatorId(),
    lineId,
    name: `OPR-${String(i + 1).padStart(2, '0')}`,
    archetypeId: 'sew_op',
    skills: ops[i] ? [{ skillId: ops[i].skill, efficiency: 1 }] : [],
    multiplicity: 1,
  }));
  const assignments: Assignment[] = operators.map((op, i) => ({
    id: newAssignmentId(),
    operatorId: op.id,
    wsId: workstations[i].id,
    role: 'primary',
    shareFrac: 1,
  }));
  return { operators, assignments };
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Build the blank-but-seeded twin. Returns the twin plus the ids the caller
 * needs to deep-link the Builder into the right selection on mount.
 */
export function buildSeededDraftTwin(seed: DraftLineSeed): DraftBuildResult {
  const ops = seed.garment?.operations ?? [];
  const policy = DEFAULT_LINE_POLICY;
  const { w: deptW, h: deptH } = deptSizeFor(ops.length);

  const blank = emptyTwin(`Draft · ${seed.draftName}`);
  const lineId = newLineId();

  const line: SewingLine = {
    id: lineId,
    name: seed.draftName,
    garmentId: seed.garment?.id,
    color: seed.color ?? 'brand',
    operatorTarget: seed.operatorTarget,
    notes: seed.notes,
  };

  // Place one workstation per operation, wired to the line and pre-authored
  // with the op's catalog machine, cycle time and PML Service block so the
  // Builder canvas renders a recognisable line on first paint.
  const positions = layoutStations(ops.length);
  // Bundle size to stamp on each workstation: the garment's own bundle when
  // it declares one, else the default policy's. A piece-flow line stamps 1
  // because every station then processes exactly one piece per cycle.
  const stationBundleSize = policy.pieceFlow
    ? 1
    : seed.garment?.defaultBundleSize ?? policy.bundleSize;
  const workstations = ops.map((op, i) => {
    const catalogId = catalogForMachine(op.machineCode);
    const ws = makeWorkstation({
      catalogId,
      position: positions[i],
      name: `${i + 1}. ${op.name}`,
    });
    ws.lineId = lineId;
    ws.operation = {
      ...ws.operation,
      opId: op.id,
      garmentId: seed.garment?.id,
      bundleSize: stationBundleSize,
      freeText: `SMV ${op.smv.toFixed(3)} min`,
    };
    ws.block = {
      kind: 'Service',
      params: {
        cycleS: Math.max(1, Math.round(op.smv * 60)),
        // Honour the authored c instead of pinning every station to one
        // server — the analytical layer reads `op.servers`, so hardcoding 1
        // here made the run disagree with its own classification.
        servers: Math.max(1, Math.round(op.servers ?? 1)),
        // Bake the authored system capacity so the DES back-pressures on the
        // same finite buffer the analytical model reads. 0 ⇒ unbounded.
        queueCapacity: op.queueCapacity ?? 0,
        // Bake the authored service-time distribution so the run samples the
        // shape the Kendall label claims. Missing ⇒ the engine falls back to
        // the deterministic `cycleS`, which is a D service process.
        cycleDist: op.serviceDistribution,
      },
    };
    ws.kpiTargets = {
      ...ws.kpiTargets,
      capacityPerHr: op.smv > 0 ? Math.round(60 / op.smv) : undefined,
    };
    ws.props = {
      ...ws.props,
      cycle_s: Math.round(op.smv * 60),
      servers: Math.max(1, Math.round(op.servers ?? 1)),
    };
    return ws;
  });

  // Wire each station to its successor with a bundle-carrying flow connector.
  // The carrier used to be chosen from the production system — bundle, piece,
  // hanger or takt. The geometry of the arrow is identical either way; the
  // annotation is what the renderer and the sim engine read.
  const flow = carrierFor(policy.bundleSize);
  const connectors: Connector[] = [];
  for (let i = 0; i < workstations.length - 1; i++) {
    connectors.push({
      id: newConnectorId(),
      kind: 'flow',
      fromWsId: workstations[i].id,
      toWsId: workstations[i + 1].id,
      flow: { ...flow },
    });
  }

  const { operators, assignments } = seedOperatorsAndAssignments({
    ops,
    workstations,
    lineId,
  });

  return {
    twin: {
      ...blank,
      gridW: Math.max(blank.gridW, DEPT_ORIGIN_X + deptW + 4),
      gridH: Math.max(blank.gridH, DEPT_ORIGIN_Y + deptH + 4),
      lines: [line],
      workstations,
      connectors,
      operators,
      assignments,
    },
    lineId,
  };
}
