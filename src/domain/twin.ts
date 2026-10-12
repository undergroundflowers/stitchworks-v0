/**
 * Twin model — the canonical entity schema for a Stitchworks digital twin.
 *
 * Architecture (locked 2026-05-07):
 *   • Two surfaces: Factory Builder (authoring) + Simulation (playback).
 *   • Two drawable layers (have geometry on the canvas):
 *       1. Department — zoned regions of the factory floor.
 *       2. Workstation — physical equipment placed inside a department
 *                        (sewing machine, cutting table, rack, …).
 *   • Three lenses (overlays on the same scene; no own geometry):
 *       Operations · Resources · KPIs.
 *     Lenses are attached as attribute groups on each workstation; toggling
 *     a lens decorates the canvas but never changes the underlying data.
 *   • Scenario = full fork of a Twin (deep clone of layout + entities +
 *     parameters). Compare-view is a tree-diff, not a parameter delta.
 *
 * This file is *pure data + pure logic*. No React, no DOM, no zustand.
 * It is consumable from the simulation engine, page components, and the
 * project file format.
 *
 * Schema versioning:
 *   - `TWIN_SCHEMA_VERSION` is the on-disk version of the Twin payload.
 *   - It is independent of `PROJECT_SCHEMA_VERSION` in store/project.ts —
 *     the project store will embed a twin payload and migrate the project
 *     wrapper separately.
 */

import {
  LEGACY_CATALOG_ID,
  defaultPropsFor,
  type IsoFixtureProps,
} from './iso';
import { lookupFixture, resolveBlockKindForDrop, stationTypeFor } from './fixture-registry';
import {
  pmlFixtureId,
  pmlKindFromFixtureId,
  type PmlBlockOverride,
  type PmlBlockParams,
} from './pml';

// ============================================================================
// SCHEMA
// ============================================================================

export const TWIN_SCHEMA_VERSION = 10 as const;
export type TwinSchemaVersion = typeof TWIN_SCHEMA_VERSION;

// ============================================================================
// GEOMETRY
// ============================================================================

/** World coordinates in cells (1 cell = ISO_TILE on the iso canvas). */
export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned rectangle in world cells. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rotation = 0 | 90 | 180 | 270;

// ============================================================================
// PALETTE KEYS
// ============================================================================

/**
 * Entity colour key. Maps to design-token names via the UI; the twin payload
 * only stores the key so token changes don't break saved files.
 *
 * Named `DepartmentColorKey` while departments were the only coloured entity.
 * Departments are gone — the floor is free space — but sewing lines still
 * carry a colour, so the palette itself survives under a neutral name.
 */
export type EntityColorKey =
  | 'fabric'
  | 'thread'
  | 'brand'
  | 'red'
  | 'blue'
  | 'yellow'
  | 'green'
  | 'cream';

// ============================================================================
// SEWING LINE — logical grouping of workstations on the floor
// ============================================================================

/**
 * Behaviour knobs that live on a SewingLine. Seeded from `DEFAULT_LINE_POLICY`
 * at line-creation time; the user overrides any field in the Inspector.
 *
 * Every field is optional so older twins round-trip cleanly — a missing
 * policy means "use the defaults at runtime".
 *
 * ── What used to be here ───────────────────────────────────────────────────
 * A line carried a `productionSystem` (PBS / modular / UPS / synchro /
 * straight) and this block was its per-system knob set: `defaultPolicyFor`
 * returned a different shape per system, and three of the fields — `taktSec`
 * (synchro only), `conveyorSpeed` (UPS + synchro) and `rotationGroupSize`
 * (modular) — existed solely to configure a system. Production systems are
 * out of scope for now, so those three went with them: they are named after
 * concepts the app no longer models, and nothing read them.
 *
 * `helperMode` went too. Who covers a starved station is decided per station,
 * not per line — the station is what starves, and the app already models the
 * answer as `Assignment` rows with `role: 'helper' | 'floater'` against a
 * specific `wsId`. A line-wide enum could only ever restate that coarsely,
 * and nothing read it.
 *
 * What is left is the set that describes any line regardless of how it is
 * organised — how work is batched and how much may pile up.
 */
export interface LinePolicy {
  /** Pieces per bundle when `pieceFlow` is false. Typically 20–30. */
  bundleSize?: number;
  /** True ⇒ pieces flow one at a time, no bundle batching. */
  pieceFlow?: boolean;
  /** Maximum WIP units allowed at any one station before its upstream
   *  feeder blocks. Implements CONWIP / kanban for piece-flow lines. */
  maxWipPerStation?: number;
}

/**
 * The policy a new line starts on, and the placeholder the Inspector shows
 * for any field the user has not overridden.
 *
 * These are the values the old `defaultPolicyFor('PBS')` returned. PBS was
 * the app's default system everywhere a line was created, so keeping its
 * numbers means no existing factory changes behaviour on the way through.
 */
export const DEFAULT_LINE_POLICY: Required<LinePolicy> = {
  bundleSize: 30,
  pieceFlow: false,
  maxWipPerStation: 0,
};

/**
 * A SewingLine is a named group of workstations on the floor — the top-level
 * organising unit of a factory, and the scope the engine bills operator
 * capacity against. Each line manufactures a particular product (garmentId)
 * under a particular production system. Lines do NOT own geometry — their
 * footprint is the convex hull of their member workstations, computed at
 * render time.
 */
export interface SewingLine {
  id: string;
  name: string;
  /** Production system that paces this line. */
  /** Garment template id this line is configured to produce. Optional —
   *  empty during initial set-up. */
  garmentId?: string;
  /** Accent colour for the canvas band + tree pip. */
  color: EntityColorKey;
  /** Target operator headcount across the line. Informational — the engine
   *  reads `workersRequired` per workstation. */
  operatorTarget?: number;
  /** Line behaviour knobs (bundle size, piece flow, WIP cap). Missing ⇒
   *  engine + UI fall back to `DEFAULT_LINE_POLICY`. */
  policy?: LinePolicy;
  notes?: string;
}

// ============================================================================
// LENS ATTRIBUTES — attached to every Workstation
// ============================================================================

/** OPERATIONS lens — what is happening at this workstation.
 *  References, not denormalised copies, so changes to the operation
 *  catalogue propagate. */
export interface OperationAttrs {
  /** Catalogue op id (operations.ts / DEPT_SUBOPS / garment-bulletin op).
   *  null = the workstation exists physically but no op is assigned yet. */
  opId: string | null;
  /** Garment template the op runs against, when relevant (sew/cut/finish). */
  garmentId?: string;
  /** Bundle size used at this station; falls back to the garment's default. */
  bundleSize?: number;
  /** Free-form override for "what's stored / what's cut / what's pressed".
   *  Only meaningful when opId is null (storage racks, generic tables, etc.). */
  freeText?: string;
}

/** RESOURCES lens — what feeds the operation. */
export interface ResourceAttrs {
  /** How many workers this station expects to run. */
  workersRequired: number;
  /** Worker archetype id (catalog ref). null = "any operator". */
  workerArchetypeId: string | null;
  /** Per-cycle material consumption, e.g. { fabric_m: 0.4, thread_m: 1.2 }. */
  materialsPerCycle: Record<string, number>;
  /** Catalogue machine id (DEPT_MACHINE_CATALOG.id), when the workstation IS
   *  a machine. Null for tables / racks / pure storage. */
  machineId: string | null;
}

/** KPI lens — split into authored *targets* and the most-recent *observed*
 *  values from a sim run. Targets persist with the twin; observed values
 *  are recomputed every run and travel with the SimRun, mirrored here for
 *  fast lens rendering. */
export interface KpiTargetAttrs {
  capacityPerHr?: number;
  efficiencyPct?: number;
  utilizationPct?: number;
  /** Authored notes about KPI intent (e.g. "stretch goal post-rebalance"). */
  notes?: string;
}

export interface KpiObservedAttrs {
  /** ISO timestamp of the run that produced these values. */
  capturedAt: string;
  /** Run id (SimRun.id) — lets the inspector deep-link to the run. */
  runId: string;
  capacityPerHr: number;
  efficiencyPct: number;
  utilizationPct: number;
  /** True if this station was the bottleneck in the captured run. */
  bottleneck: boolean;
}

// ============================================================================
// CONNECTORS — directed links between workstations that define flow
// ============================================================================

/** A connector's *meaning*. The geometry is identical for all kinds; only the
 *  rendering tint and the inspector label differ.
 *   • flow      — material/garment progresses from → to.
 *   • operator  — operator role moves from station to station (e.g. floater).
 *   • material  — feeder/raw-material supply path. */
export type ConnectorKind = 'flow' | 'operator' | 'material';

/**
 * How material moves along a flow connector. Decoupled from
 * `ConnectorKind` so an existing `kind: 'flow'` connector can describe
 * either a bundle handoff (PBS), a single piece on a table (straight,
 * modular), a hanger on an overhead rail (UPS, UHS), or one slot on a
 * takt-paced belt (synchro). Renderers tint the wire and the engine
 * picks dispatch logic from this field.
 */
export interface MaterialFlow {
  carrier: 'bundle' | 'piece' | 'hanger' | 'takt';
  /** Pieces per move. Meaningful only for `bundle`; defaults to 1 for the
   *  three piece-shaped carriers. */
  bundleSize?: number;
}

export interface Connector {
  id: string;
  kind: ConnectorKind;
  /** Source workstation id. */
  fromWsId: string;
  /** Target workstation id. */
  toWsId: string;
  /** Optional caption shown on the arrow. */
  label?: string;
  /** Specific OUTPUT port id on the source block this wire leaves from
   *  (e.g. `'out'`, `'pass'`, `'fail'`). When omitted, renderers + the
   *  sim engine fall back to the source block's first output port. */
  fromPort?: string;
  /** Specific INPUT port id on the target block this wire enters
   *  (e.g. `'in'`, `'in1'`). When omitted, falls back to the target
   *  block's first input port. */
  toPort?: string;
  /** How material moves along this edge. Meaningful only when
   *  `kind === 'flow'`; ignored for operator/material kinds. Missing ⇒
   *  fall back to the parent line's policy (`pieceFlow` ⇒ piece, else
   *  bundle). */
  flow?: MaterialFlow;
}

// ============================================================================
// OPERATOR — a person on the floor (not a workstation)
// ============================================================================

/**
 * Per-skill efficiency for one operator. `efficiency` is the fraction of an
 * on-standard cycle this operator achieves on that skill (1.0 = on standard,
 * < 1 = still learning, > 1 = consistently faster than the SAM). The skill
 * key is a `SkillId` from `domain/workers.ts`; we type it as `string` here
 * to keep this module free of cross-domain imports.
 */
export interface OperatorSkill {
  /** SkillId from `domain/workers.ts`. */
  skillId: string;
  efficiency: number;
}

/**
 * An Operator is a *person*, distinct from a Workstation (a machine or
 * fixed station the person works at). Operators are the entity that the
 * Resources tab edits, that the Line-Balance tab assigns to stations, and
 * that the simulation engine moves between stations for TSS rotations,
 * helper pulls and the "one operator shares two adjacent machines" case.
 *
 * Multiple operators per station, multiple stations per operator and
 * unassigned floaters are all expressible via the separate `Assignment`
 * table — `Operator` carries no station references directly. The canvas
 * representation of an operator (a person-shaped tile) lives on a
 * Workstation with `catalogId: 'op_*'`; that visual tile and this Operator
 * record are intentionally decoupled so the same Operator can appear at
 * different positions over time (rotation, walking).
 */
export interface Operator {
  id: string;
  /** Parent sewing line, when the operator is line-resident. Operators
   *  without a `lineId` are factory-level floaters that can be pulled to
   *  any station on any line. */
  lineId?: string;
  /** Display name (e.g. "OPR-01 · Lakshmi"). */
  name: string;
  /** Worker archetype id (catalog ref) — drives the canvas sprite and the
   *  default skill set. Mirrors `ResourceAttrs.workerArchetypeId` on a
   *  Workstation but lives here so an Operator entity is meaningful even
   *  before the user places the person tile on the canvas. */
  archetypeId?: string;
  /** Per-skill efficiencies. An operator who isn't listed against a skill
   *  is assumed to lack it. */
  skills: OperatorSkill[];
  /** `true` ⇒ this operator is a floater / helper, eligible for the
   *  helper-pool when stations starve. Floaters don't need a primary
   *  Assignment row to be useful. */
  floats?: boolean;
  /** Headcount this Operator record represents. Defaults to 1; values > 1
   *  let a single record stand for a group of identical-skill operators
   *  (e.g. "5 trainee overlockers"). Useful when modelling a TSS cell
   *  without naming every person. */
  multiplicity?: number;
  notes?: string;
}

// ============================================================================
// ASSIGNMENT — many-to-many operator ↔ workstation
// ============================================================================

/**
 * Role an operator plays at a station.
 *   • primary          — owns the station; runs it for the whole shift.
 *   • helper           — secondary; assists when the primary is loaded.
 *   • floater          — un-pinned; pulled in dynamically by the engine.
 *   • rotation_member  — part of a modular/clump rotation across N stations.
 */
export type AssignmentRole =
  | 'primary'
  | 'helper'
  | 'floater'
  | 'rotation_member';

/**
 * One row in the operator-station incidence table. The same operator can
 * have multiple rows (one per station, e.g. shared between two adjacent
 * machines) and the same station can have multiple rows (one per
 * operator, e.g. a primary + a helper). `shareFrac` is the fraction of
 * shift time this operator spends at this station; summing `shareFrac`
 * across all rows for one operator should be ≤ 1.0 (the validator warns
 * when it is not).
 */
export interface Assignment {
  id: string;
  operatorId: string;
  wsId: string;
  role: AssignmentRole;
  /** Fraction of the operator's shift spent at this station, 0..1. For a
   *  fixed primary `shareFrac` is typically 1; for a shared operator on
   *  two machines, 0.5 each. Optional — missing ⇒ infer from role
   *  (primary=1, helper=0.3, rotation=1/group_size). */
  shareFrac?: number;
  /** Position in a rotation. Only used when `role === 'rotation_member'`;
   *  the engine cycles the operator through stations in increasing
   *  `rotationOrder`. */
  rotationOrder?: number;
  notes?: string;
}

// ============================================================================
// DRAWABLE LAYER — WORKSTATION
// ============================================================================

export interface Workstation {
  id: string;
  /** Sewing line this workstation belongs to. Optional — the floor is free
   *  space, so a station can sit anywhere with no owner (storage racks,
   *  supervisor desks, generic tables, or anything not yet organised into a
   *  line). The simulation engine groups by `lineId` when present so each
   *  line runs as its own end-to-end tandem network; unlined stations draw
   *  from the factory-level operator pool. */
  lineId?: string;
  /** Catalogue id — a built-in `ISO_FIXTURE_CATALOG` entry or a user-authored
   *  station type id. Resolve it with `lookupFixture`, never by scanning the
   *  built-in catalog, or authored types render as holes. Drives the sprite
   *  + footprint. */
  catalogId: string;
  /** Display name. Defaults to the catalogue label at create time. */
  name: string;
  /** Top-left position of the catalogue footprint, in world cells. */
  position: Vec2;
  rotation: Rotation;
  /** Optional per-workstation footprint override. When present, supersedes
   *  the catalogue fixture's `w` / `d` / `h`. Values are decimal — `w` and
   *  `d` are in world cells, `h` is in altitude units. Authored from the
   *  Inspector's transform fields. */
  size?: { w: number; d: number; h: number };
  /** Free-form physical / cost / reliability props seeded from
   *  `defaultPropsFor(catalogId)`. Engineer-grade fields the user can edit. */
  props: IsoFixtureProps;

  // ── Lens attributes ────────────────────────────────────────────────────────
  operation: OperationAttrs;
  resources: ResourceAttrs;
  kpiTargets: KpiTargetAttrs;
  /** Populated by the simulation engine after each run; absent until the
   *  first run or after the twin is forked into a fresh scenario. */
  kpiObserved?: KpiObservedAttrs;

  /** Optional Process Modeling Library block override. When present, the
   *  block kind + ports replace the catalog-default that would otherwise
   *  be inferred from `catalogId`. Authored from the Inspector's PROCESS
   *  BLOCK section. Resolve via `getBlockSpec(ws)` from `domain/pml.ts`
   *  rather than reading this field directly — that helper handles the
   *  fallback to the catalog default in one place. */
  block?: PmlBlockOverride;
}

// ============================================================================
// THE TWIN
// ============================================================================

export interface Twin {
  schemaVersion: TwinSchemaVersion;
  id: string;
  name: string;
  /** Parent twin id, if this twin was forked from another. null = canonical. */
  parentTwinId: string | null;
  /** True for the project's master twin authored in Factory Builder; false
   *  for scenario forks derived from it. Exactly one twin in a project
   *  should have isCanonical = true. */
  isCanonical: boolean;
  createdAt: string;
  modifiedAt: string;
  /** World grid extent — the canvas size. */
  gridW: number;
  gridH: number;
  /** Named sewing lines that group workstations. Top-level: the floor is
   *  free space, so a line is the organising unit, not a child of a zone.
   *  Optional in the payload for backwards compatibility — older twins
   *  read it as `[]` after normalisation. */
  lines: SewingLine[];
  workstations: Workstation[];
  /** Directed flow/operator/material links between workstations. Edge geometry
   *  is computed from the source + target workstation footprints; this list
   *  stores only the topology. */
  connectors: Connector[];
  /** People on the floor. Independent of the `op_*` Workstation tiles that
   *  represent them visually — see `Operator` for the rationale. Optional
   *  on the wire format so v8 saves keep loading; absent ⇒ treated as
   *  `[]` and the existing op_* workstation tiles continue to be the
   *  authoritative "operator" representation. */
  operators?: Operator[];
  /** Operator ↔ Workstation incidence rows. Empty / missing ⇒ each
   *  workstation is assumed to be tended by whatever `op_*` tile is
   *  nearest to it (legacy implicit-assignment behaviour). */
  assignments?: Assignment[];
  notes?: string;
}

/**
 * Compact "system · key knob" badge for a sewing line. Picks the single
 * most-characteristic policy field per system (bundle size for PBS,
 * rotator count for modular, takt for synchro, etc.) so callers can
 * surface the production system in dense UI surfaces — the canvas line
 * band, the Reports header, the Resources line strip — without having to
 * spell out the full policy object.
 *
 * Counts real `Operator` rows whose `lineId` matches when computing the
 * modular rotator count, so an over-seeded cell reads `8 ROTATORS` instead
 * of the policy-default `CELL 6`.
 */
/**
 * Roll up the share debt for one line: count distinct workstations on the
 * line whose non-rotation assignments carry shareFrac < 1, and sum
 * (1 - shareFrac) for an operator-equivalents-saved estimate. Same rule the
 * PML engine's `buildShareFactorMap` uses to inflate cycleMin, so the chip
 * the user sees matches the engine slowdown they'll observe in LiveSim.
 *
 * `stations`     — distinct workstation count with a shared assignment.
 * `savings`      — sum of (1 - shareFrac), i.e. operator-equivalents saved.
 *
 * `lineId === null` means "whole twin" — used by Reports BY SYSTEM cards.
 */
/**
 * The cells a workstation occupies on the floor — the one answer every
 * canvas has to agree on.
 *
 * `position` is the top-left corner in world cells; this is the extent that
 * hangs off it. Per-workstation `size` wins over the catalogue fixture's
 * defaults, so two SNLS machines can be different sizes. Values are decimal;
 * nothing rounds to integers.
 *
 * `wsBaseFootprint` is the *unrotated* catalogue extent — what a fixture's
 * `draw()` wants, because it rotates its own geometry on the build plane via
 * `isoProjR` rather than spinning in screen space. `wsFootprint` is the
 * *effective* one: at 90° / 270° a 1 × 2 machine lying along Y becomes 2 × 1
 * along X, and that is the box a selection ring, a hit-test, a centroid or a
 * plan-view sprite has to use.
 *
 * These live here rather than in a page because the Build floor and the Run
 * floor both draw the same machines, and a machine that covers two cells in
 * BUILD and 1.4 cells in RUN is not the same machine. Builder used to own
 * them privately and LiveSim used a hard-coded 0.9 x 1.4 for every station,
 * which is why the two floors never lined up.
 */
export function wsBaseFootprint(ws: {
  catalogId: string;
  size?: { w: number; d: number; h: number };
}): { w: number; d: number; h: number } {
  const fix = lookupFixture(ws.catalogId);
  return {
    w: ws.size?.w ?? fix?.w ?? 1,
    d: ws.size?.d ?? fix?.d ?? 1,
    h: ws.size?.h ?? fix?.h ?? 1,
  };
}

export function wsFootprint(ws: {
  catalogId: string;
  rotation?: number;
  size?: { w: number; d: number; h: number };
}): { w: number; d: number; h: number } {
  const base = wsBaseFootprint(ws);
  const turned = ws.rotation === 90 || ws.rotation === 270;
  return turned ? { w: base.d, d: base.w, h: base.h } : base;
}

/**
 * How many operators a line actually runs, counted the way the simulation
 * counts them.
 *
 * `SewingLine.operatorTarget` is an authored *target* and is documented above
 * as informational — the engine bills capacity from per-workstation staffing.
 * Anything that reports on a run therefore has to count staffing, not the
 * target, or the headline "N operators" disagrees with the N the replication
 * was billed for.
 *
 * The rule mirrors `operatorsAtWs` in `simulation/model-from-twin.ts`:
 * distinct non-floater `Assignment` rows for the workstation when the twin
 * carries any, else `max(1, resources.workersRequired)`. Only workstations
 * with an assigned `operation.opId` count — infrastructure (racks, tables,
 * trolleys) is skipped by the builder too.
 */
export function staffedOperatorsForLine(twin: Twin, lineId: string): number {
  const assignedByWs = new Map<string, Set<string>>();
  for (const a of twin.assignments ?? []) {
    if (a.role === 'floater') continue;
    const set = assignedByWs.get(a.wsId) ?? new Set<string>();
    set.add(a.operatorId);
    assignedByWs.set(a.wsId, set);
  }
  let total = 0;
  for (const w of twin.workstations) {
    if (w.lineId !== lineId) continue;
    if (!w.operation.opId) continue;
    const assigned = assignedByWs.get(w.id)?.size ?? 0;
    total += assigned > 0 ? assigned : Math.max(1, w.resources.workersRequired ?? 1);
  }
  return total;
}

export function shareDebtForLine(
  twin: Twin,
  lineId: string | null,
): { stations: number; savings: number } {
  let stations = 0;
  let savings = 0;
  const memberWsIds = new Set<string>();
  for (const w of twin.workstations) {
    if (lineId == null || w.lineId === lineId) memberWsIds.add(w.id);
  }
  const seen = new Set<string>();
  for (const a of twin.assignments ?? []) {
    if (a.role === 'rotation_member') continue;
    if (!memberWsIds.has(a.wsId)) continue;
    const sf = a.shareFrac ?? 1;
    if (sf >= 1) continue;
    if (!seen.has(a.wsId)) {
      stations += 1;
      seen.add(a.wsId);
    }
    savings += 1 - sf;
  }
  return { stations, savings };
}

/**
 * One-line description of how a line moves work, for the canvas band and the
 * Reports table.
 *
 * This used to name the production system — "PBS · BUNDLE 30", "TSS · 6
 * ROTATORS", "UPS · HANGER RAIL". With systems out of scope the badge reads
 * the line's own policy instead, which is the part the user actually set and
 * the only part that was ever specific to *this* line rather than to a label
 * chosen once at creation.
 */
export function lineSystemBadge(line: SewingLine, twin: Twin): string {
  const policy = { ...DEFAULT_LINE_POLICY, ...(line.policy ?? {}) };
  if (policy.pieceFlow) {
    const cap = policy.maxWipPerStation;
    return cap > 0 ? `PIECE FLOW · MAX WIP ${cap}` : 'PIECE FLOW';
  }
  void twin;
  return `BUNDLE ${policy.bundleSize}`;
}

// ============================================================================
// SCENARIO + RUN
// ============================================================================

/** Aggregate sim output for the whole twin. Per-station observed values
 *  live on Workstation.kpiObserved. */
export interface ScenarioKpis {
  producedPieces: number;
  throughputPerHr: number;
  efficiencyPct: number;
  meanLeadTime: number;
  utilization: number;
  wipBundles: number;
  bottleneckOpName: string;
  bottleneckQueue: number;
  /** Number of replications behind these means. 1 = single-seed. */
  replicationCount?: number;
  /** OEE two-factor product (Performance × Quality), 0..1. Machine
   *  availability is out of scope for this simulator, so the classic
   *  Availability factor is omitted. Quality defaults to 1.0 until rework /
   *  scrap lands; only Performance carries information today. */
  oee?: number;
  oeePerformance?: number;
  oeeQuality?: number;
  /** On-standard performance % — alias of BSI for the lean-vocabulary reader. */
  onStandardPct?: number;
  /** Off-standard loss % = (clocked - earned) / clocked × 100. */
  offStandardLossPct?: number;
  /** Pieces produced per operator-hour. */
  labourProductivity?: number;
  /** Actual pph - demand pph; signed. */
  demandTaktGap?: number;
  /** Intrinsic balance ratio ÷ dynamic balance ratio. Near 1 = bulletin is
   *  inherently balanced; < 1 = balance depends on skill flex. */
  intrinsicVsDynamicRatio?: number;
  std?: {
    producedPieces: number;
    throughputPerHr: number;
    efficiencyPct: number;
    meanLeadTime: number;
    utilization: number;
    wipBundles: number;
    oee?: number;
    onStandardPct?: number;
    labourProductivity?: number;
    demandTaktGap?: number;
  };
}

export interface SimRun {
  id: string;
  /** Scenario whose twin was simulated. */
  scenarioId: string;
  startedAt: string;
  /** Simulated duration in seconds (NOT wall-clock). */
  simDurationS: number;
  seed: number;
  kpis: ScenarioKpis;
}

/** A scenario IS a forked twin plus authored intent (name, notes) and a
 *  history of sim runs against that twin. The twin payload is a full deep
 *  clone of the canonical twin at fork time — by design, a scenario is an
 *  independent factory once forked. */
export interface Scenario {
  id: string;
  name: string;
  notes?: string;
  createdAt: string;
  modifiedAt: string;
  twin: Twin;
  runs: SimRun[];
}

// ============================================================================
// ID GENERATION
// ============================================================================

/** Compact, mostly-monotonic id with a type prefix. Deterministic enough
 *  for debug logs, random enough to avoid collision in fast-fork loops. */
function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${t}-${r}`;
}

export const newLineId = () => newId('line');
export const newWorkstationId = () => newId('ws');
export const newTwinId = () => newId('twin');
export const newScenarioId = () => newId('scn');
export const newRunId = () => newId('run');
export const newConnectorId = () => newId('cn');
export const newOperatorId = () => newId('opr');
export const newAssignmentId = () => newId('asgn');

// ============================================================================
// FACTORIES
// ============================================================================

/** Create a fresh empty twin — the starting point for a brand-new factory.
 *  The canvas renders an empty grid until the user drops the first station. */
export function emptyTwin(name: string = 'Untitled factory'): Twin {
  const now = new Date().toISOString();
  const lineId = newLineId();
  return {
    schemaVersion: TWIN_SCHEMA_VERSION,
    id: newTwinId(),
    name,
    parentTwinId: null,
    isCanonical: true,
    createdAt: now,
    modifiedAt: now,
    gridW: 36,
    gridH: 28,
    // Seed one empty line. A station does not *need* a line — the floor is
    // free space — but every analysis surface scopes by line, and a blank
    // twin with no line reads to those surfaces as "this factory has nothing
    // to analyse" rather than "this line has no stations yet", which is a
    // much less useful thing to tell the user.
    lines: [
      {
        id: lineId,
        name: 'Line 1',
        color: 'blue',
        policy: { ...DEFAULT_LINE_POLICY },
      },
    ],
    workstations: [],
    connectors: [],
    operators: [],
    assignments: [],
  };
}

/**
 * Bring a Twin payload up to the current schema. Used by the persist
 * middleware migration and by importers.
 *
 * v10 retires departments. Stored twins keep whatever `departments` array and
 * `deptId` fields they were saved with; this strips them so nothing
 * downstream can reintroduce the concept by reading a stale field. Station
 * geometry is untouched — a station that used to sit inside a zone stays
 * exactly where it was, it simply has no owner now.
 */
export function normalizeTwin(input: unknown): Twin {
  const t = (input ?? {}) as Partial<Twin> & Record<string, unknown>;
  // Fixtures deleted with the sewing-fixture / handling / operator palette
  // sections are rewritten to their surviving equivalent on load, so a
  // factory saved before that keeps every station it had. One pass at load
  // is enough — the rewritten id is what gets persisted from here on.
  const relabel = <T extends { catalogId?: string }>(rec: T): T => {
    const next = rec?.catalogId ? LEGACY_CATALOG_ID[rec.catalogId] : undefined;
    return next ? { ...rec, catalogId: next } : rec;
  };
  const dropDept = <T extends object>(rec: T): T => {
    if (!rec || typeof rec !== 'object' || !('deptId' in rec)) return rec;
    const rest = { ...(rec as T & { deptId?: string }) };
    delete rest.deptId;
    return rest as T;
  };
  /** Keys removed from `SewingLine`: `demandPerDay` (the daily output target)
   *  and `productionSystem` (PBS / modular / UPS / …). Both are invisible to
   *  the types but still sit in every twin saved before the removal, and would
   *  be reloaded on every boot; strip them the way `deptId` is.
   *
   *  `policy` is left alone. The four fields dropped from `LinePolicy`
   *  (`taktSec`, `conveyorSpeed`, `rotationGroupSize`, `helperMode`) are
   *  harmless on disk, and a line whose policy object is otherwise empty must
   *  not be rewritten to `undefined` behind the user's back. */
  const dropRetiredLineKeys = <T extends object>(rec: T): T => {
    if (!rec || typeof rec !== 'object') return rec;
    if (!('demandPerDay' in rec) && !('productionSystem' in rec)) return rec;
    const rest = { ...(rec as T & { demandPerDay?: number; productionSystem?: string }) };
    delete rest.demandPerDay;
    delete rest.productionSystem;
    return rest as T;
  };
  return {
    schemaVersion: TWIN_SCHEMA_VERSION,
    id: t.id ?? newTwinId(),
    name: t.name ?? 'Untitled factory',
    parentTwinId: (t.parentTwinId ?? null) as string | null,
    isCanonical: t.isCanonical ?? true,
    createdAt: t.createdAt ?? new Date().toISOString(),
    modifiedAt: t.modifiedAt ?? new Date().toISOString(),
    gridW: t.gridW ?? 36,
    gridH: t.gridH ?? 28,
    lines: (((t.lines as SewingLine[] | undefined) ?? []).map(dropDept).map(dropRetiredLineKeys)),
    workstations: (t.workstations ?? []).map(dropDept).map(relabel),
    connectors: t.connectors ?? [],
    operators: (((t.operators as Operator[] | undefined) ?? []).map(dropDept)),
    assignments: (t.assignments as Assignment[] | undefined) ?? [],
    notes: t.notes,
  };
}


/** Build a workstation with sane lens defaults. The catalogue id must
 *  resolve — call sites are expected to pass a known fixture id.
 *
 *  `blockParams` lets the caller seed the PML block's authored parameters
 *  at create time — used by the BLOCKS palette to apply apparel-preset
 *  defaults (e.g. Bundle source → `ratePerHr: 30`). Ignored when the
 *  catalogId doesn't resolve to a PML primitive. */
export function makeWorkstation(input: {
  /** Optional line membership. The floor is free space — a station with no
   *  line draws from the factory-level operator pool. */
  lineId?: string;
  catalogId: string;
  position: Vec2;
  rotation?: Rotation;
  name?: string;
  blockParams?: Partial<PmlBlockParams>;
  /** Freeform position on the PROCESS canvas. Set at creation when the block
   *  was dropped there, so placing a block costs ONE undo step rather than an
   *  add followed by a separate position write. */
  processPos?: Vec2;
}): Workstation {
  const fixture = lookupFixture(input.catalogId);
  const fallbackName = fixture?.label ?? input.catalogId;
  const seedProps = defaultPropsFor(input.catalogId);

  // Heuristic resource defaults from the catalogue category. The user can
  // override these in the inspector; we just want a plausible starting point.
  const cat = fixture?.cat;
  const isMachine = cat === 'sew' || cat === 'cut' || stationTypeFor(input.catalogId)?.form === 'machine';
  const workersRequired =
    typeof seedProps.operators_needed === 'number'
      ? (seedProps.operators_needed as number)
      : isMachine
        ? 1
        : 0;

  // If the fixture is a PML primitive (`pml_*` id), auto-stamp the matching
  // block kind so the new workstation lands as e.g. a real Source / Queue /
  // SelectOutput on first drop — no Inspector round-trip needed. A
  // user-authored station type carries its own kind for the same reason: the
  // whole point of choosing one while authoring is that the station arrives
  // already being that thing.
  const stationType = stationTypeFor(input.catalogId);

  // A processPos needs a block override to live on, so a block authored on the
  // PROCESS canvas resolves its kind all the way down — falling back to the
  // catalog-inferred one, the same thing `setProcessPositions` does when it
  // materialises an override. Off that canvas an ordinary fixture is left
  // with no override at all and resolves its kind lazily at read time.
  //
  // `resolveBlockKindForDrop` is shared with the PROCESS drop ghost so the
  // preview under the cursor and the station this function returns cannot
  // disagree about what is being created.
  const blockKind = input.processPos
    ? resolveBlockKindForDrop(input.catalogId)
    : (stationType?.kind ?? pmlKindFromFixtureId(input.catalogId));

  // Authored defaults from the station type, overlaid by anything the caller
  // passed explicitly.
  const blockParams: Partial<PmlBlockParams> | undefined =
    stationType || input.blockParams
      ? { ...(stationType?.params ?? {}), ...(input.blockParams ?? {}) }
      : undefined;

  return {
    id: newWorkstationId(),
    ...(input.lineId ? { lineId: input.lineId } : {}),
    catalogId: input.catalogId,
    name: input.name ?? fallbackName,
    position: { x: input.position.x, y: input.position.y },
    rotation: input.rotation ?? 0,
    props: { ...seedProps },
    operation: { opId: null },
    resources: {
      workersRequired,
      workerArchetypeId: null,
      materialsPerCycle: {},
      machineId: isMachine ? input.catalogId : null,
    },
    kpiTargets: {},
    block: blockKind
      ? {
          kind: blockKind,
          ...(blockParams && Object.keys(blockParams).length > 0
            ? { params: { ...blockParams } }
            : {}),
          ...(input.processPos ? { processPos: { ...input.processPos } } : {}),
        }
      : undefined,
  };
}

// ============================================================================
// FORK
// ============================================================================

/**
 * Deep-clone a twin, assigning fresh ids for the twin, every department, and
 * every workstation. Inter-entity references (workstation.deptId) are
 * remapped to point at the new dept ids so the clone is internally consistent.
 *
 * Observed KPIs are intentionally dropped — a fresh fork has not been
 * simulated yet. KPI *targets* are preserved (authored intent travels with
 * the fork).
 */
export function forkTwin(
  source: Twin,
  options: { name: string; notes?: string },
): Twin {
  const now = new Date().toISOString();

  // Re-key lines so the fork stays internally consistent. Workstation.lineId
  // is remapped a few lines down via lineIdMap.
  const lineIdMap = new Map<string, string>();
  for (const ln of source.lines ?? []) lineIdMap.set(ln.id, newLineId());
  const lines: SewingLine[] = (source.lines ?? []).map((ln) => ({
    ...ln,
    id: lineIdMap.get(ln.id)!,
  }));

  // Map old → new workstation ids so connectors can be remapped.
  const wsIdMap = new Map<string, string>();
  const workstations: Workstation[] = source.workstations.map((w) => {
    const newWsId = newWorkstationId();
    wsIdMap.set(w.id, newWsId);
    return {
      ...w,
      id: newWsId,
      lineId: w.lineId ? lineIdMap.get(w.lineId) ?? undefined : undefined,
      position: { ...w.position },
      props: { ...w.props },
      operation: { ...w.operation },
      resources: {
        ...w.resources,
        materialsPerCycle: { ...w.resources.materialsPerCycle },
      },
      kpiTargets: { ...w.kpiTargets },
      // Observed values do not survive a fork.
      kpiObserved: undefined,
      // Block overrides DO travel — a forked scenario should keep the
      // user's authored block kind / port topology / sim params.
      block: w.block
        ? {
            kind: w.block.kind,
            inputs: w.block.inputs ? w.block.inputs.map((p) => ({ ...p })) : undefined,
            outputs: w.block.outputs ? w.block.outputs.map((p) => ({ ...p })) : undefined,
            params: w.block.params ? { ...w.block.params } : undefined,
            // Freeform PROCESS-canvas position travels with the fork so a
            // forked scenario opens with the same logic-graph layout.
            processPos: w.block.processPos ? { ...w.block.processPos } : undefined,
          }
        : undefined,
    };
  });

  const connectors: Connector[] = (source.connectors ?? [])
    // Drop connectors whose endpoints didn't survive (shouldn't happen for a
    // consistent twin, but be defensive against stale state).
    .filter((c) => wsIdMap.has(c.fromWsId) && wsIdMap.has(c.toWsId))
    .map((c) => ({
      ...c,
      id: newConnectorId(),
      fromWsId: wsIdMap.get(c.fromWsId)!,
      toWsId: wsIdMap.get(c.toWsId)!,
      flow: c.flow ? { ...c.flow } : undefined,
    }));

  // Remap operators (id, lineId) and assignments (id, operatorId, wsId) so
  // the fork is internally consistent. Drop assignments whose operator or
  // workstation didn't survive — same defensive policy as connectors above.
  const operatorIdMap = new Map<string, string>();
  const operators: Operator[] = (source.operators ?? []).map((op) => {
    const newOpId = newOperatorId();
    operatorIdMap.set(op.id, newOpId);
    return {
      ...op,
      id: newOpId,
      lineId: op.lineId ? lineIdMap.get(op.lineId) ?? undefined : undefined,
      skills: op.skills.map((s) => ({ ...s })),
    };
  });

  const assignments: Assignment[] = (source.assignments ?? [])
    .filter((a) => operatorIdMap.has(a.operatorId) && wsIdMap.has(a.wsId))
    .map((a) => ({
      ...a,
      id: newAssignmentId(),
      operatorId: operatorIdMap.get(a.operatorId)!,
      wsId: wsIdMap.get(a.wsId)!,
    }));

  return {
    schemaVersion: TWIN_SCHEMA_VERSION,
    id: newTwinId(),
    name: options.name,
    parentTwinId: source.id,
    isCanonical: false,
    createdAt: now,
    modifiedAt: now,
    gridW: source.gridW,
    gridH: source.gridH,
    lines,
    workstations,
    connectors,
    operators,
    assignments,
    notes: options.notes,
  };
}

/** Create a scenario by forking the canonical twin. */
export function createScenario(input: {
  source: Twin;
  name: string;
  notes?: string;
}): Scenario {
  const now = new Date().toISOString();
  return {
    id: newScenarioId(),
    name: input.name,
    notes: input.notes,
    createdAt: now,
    modifiedAt: now,
    twin: forkTwin(input.source, { name: input.name, notes: input.notes }),
    runs: [],
  };
}

// ============================================================================
// VALIDATION — cheap structural checks, not exhaustive
// ============================================================================

/** Returns the list of structural errors, empty if the twin is internally
 *  consistent. Callers (importers, tests) should treat a non-empty return
 *  as "do not load this twin." */
export function validateTwin(twin: Twin): string[] {
  const errs: string[] = [];
  // All shipped versions are readable — older saves get normalized at load
  // time. Cast to number so the union-narrowed literal type doesn't make
  // the equality check tautological at compile time.
  const ver = twin.schemaVersion as number;
  if (ver !== 1 && ver !== 2 && ver !== 3 && ver !== 4 && ver !== 5 && ver !== 6 && ver !== 7 && ver !== 8 && ver !== (TWIN_SCHEMA_VERSION as number)) {
    errs.push(
      `Unknown twin schemaVersion ${twin.schemaVersion}; expected 1, 2, 3, 4, 5, 6, 7, 8, or ${TWIN_SCHEMA_VERSION}`,
    );
  }
  const lineIds = new Set((twin.lines ?? []).map((l) => l.id));
  for (const w of twin.workstations) {
    if (w.lineId && !lineIds.has(w.lineId)) {
      errs.push(`Workstation ${w.id} references missing line ${w.lineId}`);
    }
  }
  // Duplicate ids
  const seen = new Set<string>();
  for (const w of twin.workstations) {
    if (seen.has(w.id)) errs.push(`Duplicate id ${w.id} (workstation)`);
    seen.add(w.id);
  }
  const wsIds = new Set(twin.workstations.map((w) => w.id));
  for (const c of twin.connectors ?? []) {
    if (!wsIds.has(c.fromWsId)) {
      errs.push(`Connector ${c.id} references missing source workstation ${c.fromWsId}`);
    }
    if (!wsIds.has(c.toWsId)) {
      errs.push(`Connector ${c.id} references missing target workstation ${c.toWsId}`);
    }
  }
  const operatorIds = new Set((twin.operators ?? []).map((o) => o.id));
  for (const op of twin.operators ?? []) {
    if (op.lineId && !lineIds.has(op.lineId)) {
      errs.push(`Operator ${op.id} references missing line ${op.lineId}`);
    }
  }
  for (const a of twin.assignments ?? []) {
    if (!operatorIds.has(a.operatorId)) {
      errs.push(`Assignment ${a.id} references missing operator ${a.operatorId}`);
    }
    if (!wsIds.has(a.wsId)) {
      errs.push(`Assignment ${a.id} references missing workstation ${a.wsId}`);
    }
  }
  return errs;
}

/**
 * Soft validation: returns non-fatal warnings that hint at staffing or
 * configuration issues without blocking load. Today: operator-allocation
 * sums (one operator shouldn't sum to > 1.0 shareFrac across stations,
 * because then the engine can't deliver the work). Separate return so
 * callers can show warnings in UI while still treating structural errors
 * from `validateTwin` as hard failures.
 */
export function validateTwinWarnings(twin: Twin): string[] {
  const warnings: string[] = [];
  const operatorsById = new Map((twin.operators ?? []).map((o) => [o.id, o]));
  // Per-operator non-rotation shareFrac sum. Defaults match the Inspector
  // rendering: primary=1, helper=0.3, floater=0. Rotation members are
  // expected to time-share by design and don't count toward over-allocation.
  const sums = new Map<string, number>();
  for (const a of twin.assignments ?? []) {
    if (a.role === 'rotation_member') continue;
    const sf =
      a.shareFrac ??
      (a.role === 'primary' ? 1 : a.role === 'helper' ? 0.3 : 0);
    sums.set(a.operatorId, (sums.get(a.operatorId) ?? 0) + sf);
  }
  for (const [opId, sum] of sums) {
    const op = operatorsById.get(opId);
    const name = op?.name ?? opId;
    if (sum > 1.001) {
      warnings.push(
        `Operator ${name} is over-allocated (Σ shareFrac = ${sum.toFixed(2)} > 1.0) — engine will treat the most absent station as the bottleneck.`,
      );
    } else if (sum < 0.5 && op && !op.floats) {
      warnings.push(
        `Operator ${name} is under-allocated (Σ shareFrac = ${sum.toFixed(2)} < 0.5) — they may sit idle most of the shift.`,
      );
    }
  }
  return warnings;
}

// ============================================================================
// LEGACY MIGRATION — floors+lines (project schema v1) → Twin
// ============================================================================

/** Minimal subset of the legacy FactoryStructure we know how to read. */
export interface LegacyFactoryShape {
  floors: Array<{ id: string; name: string; description?: string; color: string }>;
  lines: Array<{
    id: string;
    name: string;
    floorId: string;
    garmentTemplateId: string;
    operators: number;
  }>;
}

/**
 * Convert the v1 floors+lines structure into a Twin. Each floor becomes a
 * Department laid out as a horizontal strip; each line becomes a small
 * cluster of workstations (a sewing machine, an operator stand, a buffer)
 * placed inside its parent department.
 *
 * This is a one-way bridge so existing local-storage data isn't lost when
 * we wire the twin model into the project store. The result is intentionally
 * coarse — the user is expected to flesh out the layout in Factory Builder
 * after migration.
 */
export function migrateLegacyFactoryToTwin(
  legacy: LegacyFactoryShape,
  projectName: string = 'Migrated factory',
): Twin {
  const now = new Date().toISOString();
  const stripH = 7; // each legacy floor is laid out as a 7-cell-deep strip
  const gap = 1;
  let cursorY = 1;

  // Legacy "floors" were containers, and containers are gone — the floor is
  // free space now. They survive only as geometry: each one reserves a
  // horizontal strip so a migrated factory still reads as separate bands.
  const stripByFloorId = new Map<string, { x: number; y: number }>();
  for (const f of legacy.floors) {
    stripByFloorId.set(f.id, { x: 1, y: cursorY });
    cursorY += stripH + gap;
  }

  // Legacy lines map onto real SewingLines — the top-level organising unit.
  const lines: SewingLine[] = [];
  const workstations: Workstation[] = [];
  // Per-strip cursor for tiling lines left → right.
  const cursorByFloor = new Map<string, number>(
    legacy.floors.map((f) => [f.id, (stripByFloorId.get(f.id)?.x ?? 1) + 1]),
  );

  for (const line of legacy.lines) {
    const strip = stripByFloorId.get(line.floorId);
    if (!strip) continue;
    const x = cursorByFloor.get(line.floorId) ?? strip.x + 1;
    const y = strip.y + 1;

    const sewingLine: SewingLine = {
      id: newLineId(),
      name: line.name,
      color: 'blue',
      policy: { ...DEFAULT_LINE_POLICY },
    };
    lines.push(sewingLine);

    // Every migrated line gets a single-needle lockstitch. The fixture used to
    // be chosen from the legacy `productionSystem` string (overlock for
    // modular, lockstitch otherwise); there is no system to read it off now,
    // and the user re-picks machines in Builder after migration anyway.
    const sewFixture = 'mach_ssm';

    workstations.push(
      makeWorkstation({
        lineId: sewingLine.id,
        catalogId: sewFixture,
        position: { x, y },
        name: `${line.name} · sewing`,
      }),
    );
    workstations.push(
      makeWorkstation({
        lineId: sewingLine.id,
        catalogId: pmlFixtureId('ResourcePool'),
        position: { x, y: y + 2 },
        name: `${line.name} · operator`,
      }),
    );
    workstations.push(
      makeWorkstation({
        lineId: sewingLine.id,
        catalogId: 'buf_in',
        position: { x: x + 1, y: y + 3 },
        name: `${line.name} · buffer`,
      }),
    );

    cursorByFloor.set(line.floorId, x + 3);
  }

  return {
    schemaVersion: TWIN_SCHEMA_VERSION,
    id: newTwinId(),
    name: projectName,
    parentTwinId: null,
    isCanonical: true,
    createdAt: now,
    modifiedAt: now,
    gridW: 36,
    gridH: Math.max(28, cursorY),
    lines,
    workstations,
    connectors: [],
    operators: [],
    assignments: [],
    notes: 'Auto-migrated from legacy floors+lines structure',
  };
}
