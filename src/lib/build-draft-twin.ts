/**
 * Shared "blank draft factory + seeded sewing line" builder.
 *
 * Used by the Orders ("Build in Builder") and Simulation ("Edit in Builder")
 * flows to spin up a fresh, isolated Factory Builder draft in a new browser
 * tab without touching the user's canonical factory.
 *
 * The result is a fully-populated Twin with:
 *   - One Sewing department sized for the chosen production system's footprint.
 *   - One SewingLine carrying the order's garment / production system /
 *     operator target.
 *   - One Workstation per operation in the garment's bulletin, laid out in
 *     the topology that matches the production system:
 *       • PBS      — snaking grid, bundle flow between stations.
 *       • straight — single horizontal row, piece flow.
 *       • UPS      — single row, overhead-rail hanger flow.
 *       • synchro  — single row, takt-paced flow.
 *       • modular  — U-shaped cell, piece flow, rotating operators.
 *   - Operator + Assignment rows that reflect each system's staffing model
 *     (1:1 primary for fixed-station systems, rotation members for modular).
 *
 * The mapping from machine code (DNL, SNL, 4OL, …) to iso-catalog id reuses
 * `catalogForMachine` from `domain/reference-twin.ts` so a draft line looks
 * visually identical to a reference-paper line.
 */

import {
  defaultPolicyFor,
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
  type ProductionSystemKey,
  type SewingLine,
  type Twin,
  type Vec2,
  type Workstation,
} from '../domain/twin';
import type { GarmentTemplate } from '../domain/garments';
import type { Operation } from '../domain/operations';
import type { ProductionSystem } from '../domain/routings';
import { catalogForMachine } from '../domain/reference-twin';
import { pmlFixtureId } from '../domain/pml';

/**
 * Map the wider `ProductionSystem` set used by the Orders wizard onto the
 * narrower `ProductionSystemKey` the twin model accepts. Anything outside
 * the canonical five falls back to its closest cousin so the line still
 * receives a sensible default. Single source of truth — both Orders
 * (Build-in-Builder) and LiveSim (Run-simulation) route through here so
 * the two flows can never disagree on what "modular" really means.
 */
export function mapToLineSystem(sys: ProductionSystem): ProductionSystemKey {
  switch (sys) {
    case 'PBS':
    case 'modular':
    case 'UPS':
    case 'synchro':
    case 'straight':
      return sys;
    case 'make_through':
      return 'straight';
    case 'clump':
      return 'modular';
    case 'bundle':
      return 'PBS';
    case 'unit_handle':
      return 'UPS';
    default:
      return 'PBS';
  }
}

// ── Layout geometry ────────────────────────────────────────────────────────

/** Horizontal spacing between adjacent workstations, in cells. */
const STATION_DX = 3;
/** Vertical spacing between rows of workstations, in cells. */
const ROW_DY = 4;
/** How wide a PBS snaking grid can grow before wrapping to a new row. */
const PBS_STATIONS_PER_ROW = 7;
/** Origin of the dept inside the twin's world grid. */
const DEPT_ORIGIN_X = 2;
const DEPT_ORIGIN_Y = 2;
/** Interior gutter inside the dept before the first station. */
const STATION_INSET = 2;

export interface DraftLineSeed {
  /** Display name used for the draft factory and the seeded SewingLine. */
  draftName: string;
  /** Production system the line is paced by — mapped from the order's
   *  wider `ProductionSystem` set onto the Builder's narrower key set
   *  by the caller. */
  productionSystem: ProductionSystemKey;
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

// ── Per-system topology helpers ───────────────────────────────────────────

/** Position one workstation per operation, in op-order, inside the dept's
 *  interior. Different systems use different shapes — PBS snakes, modular
 *  forms a U-cell, the takt/piece-flow systems use a single row. */
function layoutStations(
  system: ProductionSystemKey,
  opCount: number,
): Vec2[] {
  const ox = DEPT_ORIGIN_X + STATION_INSET;
  const oy = DEPT_ORIGIN_Y + STATION_INSET;
  switch (system) {
    case 'PBS': {
      // Snaking grid, mirroring real bundle-line floor layouts where the
      // line wraps inside a rectangular footprint to fit on the shop floor.
      return Array.from({ length: opCount }, (_, i) => {
        const row = Math.floor(i / PBS_STATIONS_PER_ROW);
        const col = i % PBS_STATIONS_PER_ROW;
        const colInRow = row % 2 === 0 ? col : PBS_STATIONS_PER_ROW - 1 - col;
        return { x: ox + colInRow * STATION_DX, y: oy + row * ROW_DY };
      });
    }
    case 'straight':
    case 'synchro':
    case 'UPS': {
      // Single horizontal row — straight/synchro pace by takt or piece-flow,
      // UPS by an overhead rail. None of them benefit from wrapping; a long
      // row reads as "linear flow" at a glance.
      return Array.from({ length: opCount }, (_, i) => ({
        x: ox + i * STATION_DX,
        y: oy,
      }));
    }
    case 'modular': {
      // U-shaped cell: top row left→right, then wrap down to a bottom row
      // running right→left. Captures the "operators face each other across
      // the cell" shape that's characteristic of modular (TSS) production.
      const half = Math.ceil(opCount / 2);
      return Array.from({ length: opCount }, (_, i) => {
        if (i < half) {
          return { x: ox + i * STATION_DX, y: oy };
        }
        const j = i - half;
        return { x: ox + (half - 1 - j) * STATION_DX, y: oy + ROW_DY };
      });
    }
  }
}

/** Bounding box for the dept that contains the laid-out stations. */
function deptSizeFor(
  system: ProductionSystemKey,
  opCount: number,
): { w: number; h: number } {
  switch (system) {
    case 'PBS': {
      const rows = Math.max(1, Math.ceil(opCount / PBS_STATIONS_PER_ROW));
      return {
        w: Math.max(18, PBS_STATIONS_PER_ROW * STATION_DX + 4),
        h: Math.max(10, rows * ROW_DY + 4),
      };
    }
    case 'straight':
    case 'synchro':
    case 'UPS':
      return {
        w: Math.max(12, opCount * STATION_DX + 4),
        h: 8,
      };
    case 'modular': {
      const half = Math.ceil(opCount / 2);
      return {
        w: Math.max(12, half * STATION_DX + 4),
        h: 10,
      };
    }
  }
}

/** What material moves between two stations on this system. PBS hands off
 *  tied bundles; straight/modular push a single piece; UPS uses overhead
 *  hangers; synchro slots pieces onto a takt-paced belt. */
function carrierFor(
  system: ProductionSystemKey,
  bundleSize?: number,
): MaterialFlow {
  switch (system) {
    case 'PBS':
      return { carrier: 'bundle', bundleSize: bundleSize ?? 30 };
    case 'modular':
    case 'straight':
      return { carrier: 'piece' };
    case 'UPS':
      return { carrier: 'hanger' };
    case 'synchro':
      return { carrier: 'takt' };
  }
}

/**
 * Seed Operator + Assignment rows for a system. Returns the rows ready to
 * splice into the Twin payload.
 *
 *   • PBS / straight / synchro / UPS — one primary operator per station,
 *     shareFrac 1. Matches the "fixed station, fixed operator" model used
 *     by every batched and takt-paced apparel line.
 *
 *   • modular — `rotationGroupSize` multi-skilled operators rotating across
 *     every station in the cell. Each operator gets one rotation_member
 *     assignment per station with a position-coded `rotationOrder`. The
 *     engine cycles them through the rotation when bundles dry up.
 *
 * Skills are inferred from each operation's declared `skill` field so a
 * rotation operator on a Polo cell ends up with overlock + flatlock + SNL
 * skills exactly when those ops are present in the bulletin.
 */
function seedOperatorsAndAssignments(args: {
  system: ProductionSystemKey;
  ops: Operation[];
  workstations: Workstation[];
  lineId: string;
  operatorTarget: number;
}): { operators: Operator[]; assignments: Assignment[] } {
  const { system, ops, workstations, lineId, operatorTarget } = args;
  if (workstations.length === 0) {
    return { operators: [], assignments: [] };
  }

  if (system === 'modular') {
    // Rotation cell. Group size capped by both the policy default and the
    // user's operator target — whichever is smaller. A 5-station bulletin
    // shouldn't get 8 operators.
    const policyDefault = defaultPolicyFor('modular').rotationGroupSize;
    const groupSize = Math.max(
      1,
      Math.min(workstations.length, operatorTarget, policyDefault || workstations.length),
    );
    // Skills the cell needs = union of all ops' skill tags.
    const cellSkills = Array.from(new Set(ops.map((o) => o.skill)));
    const operators: Operator[] = Array.from({ length: groupSize }, (_, i) => ({
      id: newOperatorId(),
      lineId,
      name: `Rotator ${i + 1}`,
      archetypeId: 'sew_op',
      skills: cellSkills.map((s) => ({ skillId: s, efficiency: 1 })),
      multiplicity: 1,
    }));
    const assignments: Assignment[] = [];
    for (const op of operators) {
      workstations.forEach((station, idx) => {
        assignments.push({
          id: newAssignmentId(),
          operatorId: op.id,
          wsId: station.id,
          role: 'rotation_member',
          shareFrac: 1 / workstations.length,
          rotationOrder: idx,
        });
      });
    }
    return { operators, assignments };
  }

  // Fixed-station systems: one primary operator per workstation, named
  // after the op they're tied to. Per-operator skills are just the one
  // skill that op requires — sufficient for the engine, the user can
  // cross-train in the (forthcoming) Resources tab.
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
  const policy = defaultPolicyFor(seed.productionSystem);
  const { w: deptW, h: deptH } = deptSizeFor(seed.productionSystem, ops.length);

  const blank = emptyTwin(`Draft · ${seed.draftName}`);
  const lineId = newLineId();

  const line: SewingLine = {
    id: lineId,
    name: seed.draftName,
    productionSystem: seed.productionSystem,
    garmentId: seed.garment?.id,
    color: seed.color ?? 'brand',
    operatorTarget: seed.operatorTarget,
    notes: seed.notes,
  };

  // Place one workstation per operation in the system-appropriate topology,
  // wired to the line and pre-authored with the op's catalog machine,
  // cycle time and PML Service block so the Builder canvas renders a
  // recognisable line on first paint.
  const positions = layoutStations(seed.productionSystem, ops.length);
  // Bundle size to stamp on each workstation. PBS uses the policy default
  // (or the garment's own bundle), piece-flow systems use 1 because every
  // station processes exactly one piece per cycle.
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

  // Wire each station to its successor with a flow connector whose carrier
  // matches the production system. PBS hands bundles, modular/straight push
  // single pieces, UPS uses an overhead rail, synchro pulses on a takt belt.
  // The geometry of the arrow is identical; the carrier annotation lets the
  // renderer + sim engine pick distinct dispatch logic.
  const flow = carrierFor(seed.productionSystem, policy.bundleSize);
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
    system: seed.productionSystem,
    ops,
    workstations,
    lineId,
    operatorTarget: seed.operatorTarget,
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

// ── Sim-ready variant ─────────────────────────────────────────────────────

/**
 * Add the Source / ResourcePool / Sink scaffolding the PML simulation
 * engine needs onto a seeded draft twin. Mutates a returned copy; the
 * original twin is untouched. The first and last workstations on the line
 * are wired to Source and Sink respectively so the engine can route
 * pieces end-to-end; the ResourcePool exposes the line's operator headcount
 * as a shared capacity pool. Builder authoring never calls this — the
 * canvas should stay editable without forced source/sink plumbing — but
 * the sim wrapper needs a closed graph.
 */
function addSimPlumbing(
  twin: Twin,
  args: { operators: number; lineId: string },
): Twin {
  const lineStations = twin.workstations.filter((w) => w.lineId === args.lineId);
  if (lineStations.length === 0) return twin;
  const first = lineStations[0];
  const last = lineStations[lineStations.length - 1];

  // Match the rate heuristic buildGarmentTwin used so the legacy engine
  // expectations don't change: 1.5× the bottleneck-pitch rate so the source
  // can keep the line saturated.
  const totalSmvMin = lineStations.reduce(
    (s, w) => s + (typeof w.props?.cycle_s === 'number' ? Number(w.props.cycle_s) / 60 : 0),
    0,
  );
  const takt = lineStations.length > 0 ? totalSmvMin / lineStations.length : 1;
  const sourceRatePerHr = takt > 0 ? Math.max(60, Math.round((60 / takt) * 1.5)) : 120;

  // Place plumbing tiles just outside the line's footprint so they don't
  // overlap the station grid. Source upstream-left, sink downstream-right,
  // pool beneath the line's first station.
  const wsSource = makeWorkstation({
    catalogId: 'buf_in',
    position: { x: Math.max(0, first.position.x - 3), y: first.position.y },
    name: 'Source — orders in',
  });
  wsSource.block = {
    kind: 'Source',
    params: {
      sourceRatePerHr,
      piecesPerAgent: 1,
      // Poisson arrivals — the `a` field of Kendall–Lee. Without this the
      // engine falls back to a constant 60/rate interval, which is a D
      // arrival process, so every station downstream was classified M/… while
      // actually being fed a deterministic stream. Exponential inter-arrival
      // times ARE the Poisson process the textbook assumes throughout.
      arrivalDist: { kind: 'exp', mean: 60 / Math.max(1e-6, sourceRatePerHr) },
    },
  };
  wsSource.operation = {
    ...wsSource.operation,
    freeText: `${sourceRatePerHr} pcs/hr · seeds the line`,
  };
  // Stamp the line id onto the plumbing. The per-line sim/report views scope a
  // twin via `scopedTwinForLine` (workstations.filter(w => w.lineId === lineId));
  // without this the Source/Pool/Sink are filtered out and the scoped run
  // generates + counts nothing (every KPI reads 0). Mirrors buildModelamaTwin.
  wsSource.lineId = args.lineId;

  const wsPool = makeWorkstation({
    catalogId: pmlFixtureId('ResourcePool'),
    position: { x: first.position.x, y: first.position.y + 6 },
    name: `Operators · ${args.operators} units`,
  });
  wsPool.block = {
    kind: 'ResourcePool',
    params: { capacity: args.operators },
  };
  wsPool.lineId = args.lineId;

  const wsSink = makeWorkstation({
    catalogId: 'buf_out',
    position: { x: last.position.x + 3, y: last.position.y },
    name: 'Sink — finished pcs',
  });
  wsSink.block = { kind: 'Sink' };
  wsSink.lineId = args.lineId;

  const newConnectors: Connector[] = [
    {
      id: newConnectorId(),
      kind: 'flow',
      fromWsId: wsSource.id,
      toWsId: first.id,
    },
    {
      id: newConnectorId(),
      kind: 'flow',
      fromWsId: last.id,
      toWsId: wsSink.id,
    },
  ];

  return {
    ...twin,
    workstations: [...twin.workstations, wsSource, wsPool, wsSink],
    connectors: [...twin.connectors, ...newConnectors],
  };
}

/**
 * Sim-ready variant of {@link buildSeededDraftTwin}. Same per-system
 * topology + operators + assignments + carrier annotations as the Builder
 * seed, but with Source / ResourcePool / Sink prepended so the PML
 * simulation engine has a closed graph to run. Called by LiveSim when the
 * source is an order — keeps the "Build in Builder" and "Run simulation"
 * paths in lockstep so picking modular gives the user a U-cell in both
 * places, not a U-cell in one and a snake in the other.
 */
export function buildSimReadyOrderTwin(args: {
  draftName: string;
  productionSystem: ProductionSystemKey;
  garment: GarmentTemplate;
  operators: number;
  notes?: string;
}): Twin {
  const seed = buildSeededDraftTwin({
    draftName: args.draftName,
    productionSystem: args.productionSystem,
    garment: args.garment,
    operatorTarget: args.operators,
    notes: args.notes,
  });
  return addSimPlumbing(seed.twin, {
    operators: args.operators,
    lineId: seed.lineId,
  });
}
