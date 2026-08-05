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
  ISO_FIXTURE_CATALOG,
  defaultPropsFor,
  type IsoFixtureProps,
} from './iso';
import {
  pmlKindFromFixtureId,
  type PmlBlockOverride,
  type PmlBlockParams,
} from './pml';

// ============================================================================
// SCHEMA
// ============================================================================

export const TWIN_SCHEMA_VERSION = 9 as const;
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
// DRAWABLE LAYER 1 — DEPARTMENT
// ============================================================================

/** Department-typed colour key. Maps to design-token names via the UI; the
 *  twin payload only stores the key so token changes don't break files. */
export type DepartmentColorKey =
  | 'fabric'
  | 'thread'
  | 'brand'
  | 'red'
  | 'blue'
  | 'yellow'
  | 'green'
  | 'cream';

export interface Department {
  id: string;
  name: string;
  /** Department-purpose tag — drives default lens overlays and the catalogue
   *  filter in the palette. Free-string so users can author novel ones. */
  kind: string;
  color: DepartmentColorKey;
  /** Axis-aligned bounds in world cells. v1 is rect-only; polygon is a
   *  future extension that bumps TWIN_SCHEMA_VERSION. */
  bounds: Rect;
  notes?: string;
}

// ============================================================================
// SEWING LINE — logical grouping of workstations inside one department
// ============================================================================

/**
 * Production system that paces a line. Drives bundle size, WIP norms, and
 * the canvas badge colour. Mirrors the legacy `productionSystem` string on
 * the project-store `Line` so the two models stay aligned.
 */
export type ProductionSystemKey =
  | 'PBS'       // Progressive Bundle System
  | 'modular'   // Modular cell
  | 'UPS'       // Unit Production System (overhead rail)
  | 'synchro'   // Synchronised / takt
  | 'straight'; // Straight line (no batching)

/**
 * System-specific behaviour knobs that live on a SewingLine. Seeded with
 * sensible defaults from `defaultPolicyFor(system)` at line-creation time;
 * the user can override any field in the Inspector. The simulation engine,
 * Builder canvas and Line-Balance modes all read this block to choose
 * dispatch policy, render carriers, and pick the balancing algorithm.
 *
 * Every field is optional so older twins (v8 and earlier) round-trip
 * cleanly — a missing policy means "use the system's defaults at runtime."
 */
export interface LinePolicy {
  /** Pieces per bundle when `pieceFlow` is false. PBS/Bundle: typically 20–30.
   *  Ignored for piece-flow systems. */
  bundleSize?: number;
  /** True ⇒ pieces flow one at a time, no bundle batching.
   *  Default by system: modular/UPS/synchro/straight = true, PBS = false. */
  pieceFlow?: boolean;
  /** Takt time in seconds. Only used when the system is `synchro`. */
  taktSec?: number;
  /** Conveyor / overhead-rail speed in cells per minute. Used by UPS, UHS
   *  and synchro to visualise material movement. */
  conveyorSpeed?: number;
  /** Number of stations one rotation group spans. Drives modular/clump
   *  cell sizing; ignored for fixed-station systems. */
  rotationGroupSize?: number;
  /** Maximum WIP units allowed at any one station before its upstream
   *  feeder blocks. Implements CONWIP / kanban for piece-flow lines. */
  maxWipPerStation?: number;
  /** How floater operators are deployed when a station starves.
   *   • 'none' — no helpers; station idles.
   *   • 'adjacent' — pull from the operator one station upstream/downstream.
   *   • 'pool' — pull from the line-level floater pool. */
  helperMode?: 'none' | 'adjacent' | 'pool';
}

/**
 * Best-effort defaults for a production system. Used when a line is created
 * (Build-in-Builder seed, palette drop) and when the Inspector renders the
 * policy panel and needs a placeholder for unset fields.
 */
export function defaultPolicyFor(system: ProductionSystemKey): Required<LinePolicy> {
  switch (system) {
    case 'PBS':
      return {
        bundleSize: 30,
        pieceFlow: false,
        taktSec: 0,
        conveyorSpeed: 0,
        rotationGroupSize: 0,
        maxWipPerStation: 0,
        helperMode: 'adjacent',
      };
    case 'modular':
      return {
        bundleSize: 1,
        pieceFlow: true,
        taktSec: 0,
        conveyorSpeed: 0,
        rotationGroupSize: 6,
        maxWipPerStation: 2,
        helperMode: 'pool',
      };
    case 'UPS':
      return {
        bundleSize: 1,
        pieceFlow: true,
        taktSec: 0,
        conveyorSpeed: 6,
        rotationGroupSize: 0,
        maxWipPerStation: 3,
        helperMode: 'adjacent',
      };
    case 'synchro':
      return {
        bundleSize: 1,
        pieceFlow: true,
        taktSec: 60,
        conveyorSpeed: 4,
        rotationGroupSize: 0,
        maxWipPerStation: 1,
        helperMode: 'none',
      };
    case 'straight':
      return {
        bundleSize: 1,
        pieceFlow: true,
        taktSec: 0,
        conveyorSpeed: 0,
        rotationGroupSize: 0,
        maxWipPerStation: 2,
        helperMode: 'none',
      };
  }
}

/**
 * A SewingLine is a named group of workstations inside one department.
 * One department can hold several lines, each manufacturing a particular
 * product (garmentId) under a particular production system. Lines do NOT
 * own geometry — their footprint is the convex hull of their member
 * workstations, computed at render time.
 */
export interface SewingLine {
  id: string;
  /** Parent department (must exist in the same twin). */
  deptId: string;
  name: string;
  /** Production system that paces this line. */
  productionSystem: ProductionSystemKey;
  /** Garment template id this line is configured to produce. Optional —
   *  empty during initial set-up. Falls back to the first order's garment
   *  when an `orderSequence` is present. */
  garmentId?: string;
  /** Accent colour for the canvas band + tree pip. Defaults to the parent
   *  department's colour when unset at create time. */
  color: DepartmentColorKey;
  /** Target operator headcount across the line. Informational — the engine
   *  reads `workersRequired` per workstation. */
  operatorTarget?: number;
  /** Ordered list of `Order.id`s this line will run in a shift. When set,
   *  the engine emits each order's pieces in sequence, raising a
   *  CHANGEOVER_BEGIN between consecutive orders whose garmentIds differ.
   *  Empty / missing ⇒ legacy infinite Source behaviour using `garmentId`. */
  orderSequence?: string[];
  /** System-specific behaviour knobs (bundle size, takt, conveyor, helper
   *  policy, …). Missing ⇒ engine + UI fall back to `defaultPolicyFor`. */
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
  /** Parent department — operators belong to a department even when they
   *  float between lines inside it. */
  deptId: string;
  /** Parent sewing line, when the operator is line-resident. Operators
   *  without a `lineId` are department-level floaters that can be pulled
   *  to any line whose policy is `helperMode: 'pool'`. */
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
// DRAWABLE LAYER 2 — WORKSTATION
// ============================================================================

export interface Workstation {
  id: string;
  /** Department this workstation belongs to (Department.id). Required —
   *  every workstation lives inside a department. */
  deptId: string;
  /** Sewing line this workstation belongs to, when its parent department
   *  has any. Optional — workstations that don't sit on a line (storage
   *  racks, supervisor desks, generic tables) leave this unset. The
   *  simulation engine groups by `lineId` when present so each line runs
   *  as its own end-to-end tandem network. */
  lineId?: string;
  /** Catalogue id from ISO_FIXTURE_CATALOG. Drives the sprite + footprint. */
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
  departments: Department[];
  /** Named sewing lines that group workstations inside a department.
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
  /** Production orders this twin can run. Each line's `orderSequence`
   *  references entries here by id. Empty / missing ⇒ legacy single-
   *  garment-per-line behaviour. */
  orders?: Order[];
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

export function lineSystemBadge(line: SewingLine, twin: Twin): string {
  const policy = { ...defaultPolicyFor(line.productionSystem), ...(line.policy ?? {}) };
  switch (line.productionSystem) {
    case 'PBS':
      return `PBS · BUNDLE ${policy.bundleSize}`;
    case 'modular': {
      const rotators = (twin.operators ?? []).filter((o) => o.lineId === line.id).length;
      return rotators > 0
        ? `TSS · ${rotators} ROTATOR${rotators === 1 ? '' : 'S'}`
        : `TSS · CELL ${policy.rotationGroupSize || 6}`;
    }
    case 'UPS':
      return 'UPS · HANGER RAIL';
    case 'synchro':
      return `SYNCHRO · TAKT ${policy.taktSec}s`;
    case 'straight':
      return 'STRAIGHT · PIECE FLOW';
  }
}

/**
 * A production order — a quantity of a specific garment to be produced.
 * Lines pick orders up through `SewingLine.orderSequence` (ordered list
 * of order ids); the engine emits each order's pieces in turn and raises
 * a CHANGEOVER_BEGIN whenever consecutive orders have different garments.
 *
 * Schema landed in v8 (P4). Optional on the Twin so v7 saves keep
 * loading cleanly.
 */
export interface Order {
  id: string;
  /** Customer / PO reference. Free-form, e.g. "PO-2026-04-1109". */
  po?: string;
  /** Buyer name. Free-form. */
  client?: string;
  /** Garment template id this order produces. */
  garmentId: string;
  /** Pieces ordered. */
  quantity: number;
  /** Optional ISO deadline. */
  dueDate?: string;
  /** 1 = highest. When two orders compete for the same line a planner
   *  surfaces this; the engine itself is order-agnostic and runs the
   *  declared sequence as-is. */
  priority?: number;
  /** Which line is committed to run this order. When set, it should
   *  appear in that line's `orderSequence`. */
  assignedLineId?: string;
  /** ISO timestamp when the order was created in the planner. */
  createdAt?: string;
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
  /** Minutes lost to changeover during the run; populated in P4. */
  changeoverMinutes?: number;
  /** Total changeover minutes summed across every changeover event in
   *  the run. Identical to changeoverMinutes for single-line shifts;
   *  diverges for multi-line factories where two lines change over in
   *  parallel and the accumulator captures both. Populated in P4. */
  totalChangeoverMinutes?: number;
  /** Per-order completion time (sim minutes from the order's first piece
   *  emitted by the Source until the order's last piece reaches the Sink).
   *  Keyed by Order.id. Populated by P4's order-aware engine. */
  perOrderCompletionTime?: Record<string, number>;
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

export const newDeptId = () => newId('dept');
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
  const deptId = newDeptId();
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
    // Sewing-centric: the sewing floor is the only zoned region the builder
    // authors, so every new factory is seeded with one. Without it a blank
    // twin would have nowhere to drop a station.
    departments: [
      {
        id: deptId,
        name: 'Sewing Floor',
        kind: 'Sewing',
        color: 'blue',
        bounds: { x: 2, y: 2, w: 24, h: 18 },
      },
    ],
    // Seed one empty line for the same reason the department is seeded: a
    // station needs a line to belong to, and every analysis surface scopes by
    // line. A blank twin with no line reads to those surfaces as "this factory
    // has nothing to analyse" rather than "this line has no stations yet",
    // which is a much less useful thing to tell the user.
    lines: [
      {
        id: lineId,
        deptId,
        name: 'Line 1',
        productionSystem: 'PBS',
        color: 'blue',
        policy: defaultPolicyFor('PBS'),
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
 * middleware migration and by importers. Additive only — never strips
 * fields the current code can handle.
 */
export function normalizeTwin(input: unknown): Twin {
  const t = (input ?? {}) as Partial<Twin> & Record<string, unknown>;
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
    departments: t.departments ?? [],
    lines: (t.lines as SewingLine[] | undefined) ?? [],
    workstations: t.workstations ?? [],
    connectors: t.connectors ?? [],
    operators: (t.operators as Operator[] | undefined) ?? [],
    assignments: (t.assignments as Assignment[] | undefined) ?? [],
    orders: t.orders as Order[] | undefined,
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
  deptId: string;
  catalogId: string;
  position: Vec2;
  rotation?: Rotation;
  name?: string;
  blockParams?: Partial<PmlBlockParams>;
}): Workstation {
  const fixture = ISO_FIXTURE_CATALOG.find((f) => f.id === input.catalogId);
  const fallbackName = fixture?.label ?? input.catalogId;
  const seedProps = defaultPropsFor(input.catalogId);

  // Heuristic resource defaults from the catalogue category. The user can
  // override these in the inspector; we just want a plausible starting point.
  const cat = fixture?.cat;
  const isMachine = cat === 'sew' || cat === 'cut';
  const workersRequired =
    typeof seedProps.operators_needed === 'number'
      ? (seedProps.operators_needed as number)
      : isMachine
        ? 1
        : 0;

  // If the fixture is a PML primitive (`pml_*` id), auto-stamp the matching
  // block kind so the new workstation lands as e.g. a real Source / Queue /
  // SelectOutput on first drop — no Inspector round-trip needed.
  const pmlKind = pmlKindFromFixtureId(input.catalogId);

  return {
    id: newWorkstationId(),
    deptId: input.deptId,
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
    block: pmlKind
      ? {
          kind: pmlKind,
          ...(input.blockParams ? { params: { ...input.blockParams } } : {}),
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
  const deptIdMap = new Map<string, string>();
  for (const d of source.departments) deptIdMap.set(d.id, newDeptId());

  const departments: Department[] = source.departments.map((d) => ({
    ...d,
    id: deptIdMap.get(d.id)!,
    bounds: { ...d.bounds },
  }));

  // Re-key lines and remap their parent dept ids so the fork stays internally
  // consistent. Workstation.lineId is remapped a few lines down via lineIdMap.
  const lineIdMap = new Map<string, string>();
  for (const ln of source.lines ?? []) lineIdMap.set(ln.id, newLineId());
  const lines: SewingLine[] = (source.lines ?? []).map((ln) => ({
    ...ln,
    id: lineIdMap.get(ln.id)!,
    deptId: deptIdMap.get(ln.deptId) ?? ln.deptId,
  }));

  // Map old → new workstation ids so connectors can be remapped.
  const wsIdMap = new Map<string, string>();
  const workstations: Workstation[] = source.workstations.map((w) => {
    const newWsId = newWorkstationId();
    wsIdMap.set(w.id, newWsId);
    return {
      ...w,
      id: newWsId,
      deptId: deptIdMap.get(w.deptId) ?? w.deptId,
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

  // Remap operators (id, deptId, lineId) and assignments (id, operatorId,
  // wsId) so the fork is internally consistent. Drop assignments whose
  // operator or workstation didn't survive — same defensive policy as
  // connectors above.
  const operatorIdMap = new Map<string, string>();
  const operators: Operator[] = (source.operators ?? []).map((op) => {
    const newOpId = newOperatorId();
    operatorIdMap.set(op.id, newOpId);
    return {
      ...op,
      id: newOpId,
      deptId: deptIdMap.get(op.deptId) ?? op.deptId,
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
    departments,
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
  const deptIds = new Set(twin.departments.map((d) => d.id));
  const lineIds = new Set((twin.lines ?? []).map((l) => l.id));
  for (const l of twin.lines ?? []) {
    if (!deptIds.has(l.deptId)) {
      errs.push(`Line ${l.id} references missing department ${l.deptId}`);
    }
  }
  for (const w of twin.workstations) {
    if (!deptIds.has(w.deptId)) {
      errs.push(`Workstation ${w.id} references missing department ${w.deptId}`);
    }
    if (w.lineId && !lineIds.has(w.lineId)) {
      errs.push(`Workstation ${w.id} references missing line ${w.lineId}`);
    }
  }
  // Duplicate ids
  const seen = new Set<string>();
  for (const d of twin.departments) {
    if (seen.has(d.id)) errs.push(`Duplicate department id ${d.id}`);
    seen.add(d.id);
  }
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
    if (!deptIds.has(op.deptId)) {
      errs.push(`Operator ${op.id} references missing department ${op.deptId}`);
    }
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
    productionSystem: string;
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
  const stripH = 7; // each floor strip is 7 cells deep
  const gap = 1;
  let cursorY = 1;

  const departments: Department[] = legacy.floors.map((f) => {
    const dept: Department = {
      id: newDeptId(),
      name: f.name,
      kind: f.description ?? f.name,
      color: (f.color as DepartmentColorKey) ?? 'cream',
      bounds: { x: 1, y: cursorY, w: 30, h: stripH },
      notes: f.description,
    };
    cursorY += stripH + gap;
    return dept;
  });

  // Map legacy floorId → new dept id, preserving order so we can place lines.
  const floorIdToDept = new Map<string, Department>();
  legacy.floors.forEach((f, i) => floorIdToDept.set(f.id, departments[i]));

  const workstations: Workstation[] = [];
  // Per-dept cursor for tiling lines left → right.
  const cursorByDept = new Map<string, number>(
    departments.map((d) => [d.id, d.bounds.x + 1]),
  );

  for (const line of legacy.lines) {
    const dept = floorIdToDept.get(line.floorId);
    if (!dept) continue;
    const x = cursorByDept.get(dept.id) ?? dept.bounds.x + 1;
    const y = dept.bounds.y + 1;

    // Pick a sensible fixture per production system.
    const sewFixture =
      line.productionSystem === 'modular' ? 'mach_over' : 'mach_ssm';

    workstations.push(
      makeWorkstation({
        deptId: dept.id,
        catalogId: sewFixture,
        position: { x, y },
        name: `${line.name} · sewing`,
      }),
    );
    workstations.push(
      makeWorkstation({
        deptId: dept.id,
        catalogId: 'op_sewer',
        position: { x, y: y + 2 },
        name: `${line.name} · operator`,
      }),
    );
    workstations.push(
      makeWorkstation({
        deptId: dept.id,
        catalogId: 'buf_in',
        position: { x: x + 1, y: y + 3 },
        name: `${line.name} · buffer`,
      }),
    );

    cursorByDept.set(dept.id, x + 3);
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
    departments,
    lines: [],
    workstations,
    connectors: [],
    operators: [],
    assignments: [],
    notes: 'Auto-migrated from legacy floors+lines structure',
  };
}
