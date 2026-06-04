/**
 * Project store — the single source of truth for everything the user
 * "owns" inside Stitchworks: factory metadata, the live-sim configuration,
 * the Yamazumi assignment overrides, and the skill matrix. Persisted to
 * localStorage automatically via zustand/middleware/persist.
 *
 * The shape is versioned (`schemaVersion`); future migrations bump the
 * version and add a `migrate` step in the persist config.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { GARMENT_TEMPLATES, type GarmentTemplate, type Operation, type ProductionSystem } from '../domain';
import { indexedDbStorage } from './storage/indexedDbStorage';
import type { MachineCode, MachineSpec } from '../domain/machines';
import type { WorkerArchetype } from '../domain/workers';
import type { ProductKind } from '../assets';
import type { ModelTimeUnit } from '../simulation/timeUnit';
import type { Twin } from '../domain/twin';

/**
 * Garment names that should never survive a session — keyboard mashes and
 * "test" placeholders that accumulate while exploring the editor. Anything
 * starting with one of these tokens (case-insensitive) is purged on boot by
 * `purgeTestGarments`.
 */
const TEST_GARMENT_PATTERN = /^(dvss|dsvs|asdf|test|casdcz)/i;

/**
 * Schema version. v2 introduced the `time` slice (model-time-unit, start date,
 * execution mode, real-time scale) — see `TimeSettings`. Migration in the
 * persist config fills defaults for projects saved under v1.
 */
export const PROJECT_SCHEMA_VERSION = 2 as const;

/**
 * A user-authored workstation. Carries the same shape as a built-in
 * `MachineSpec` but with a free-form `code` string instead of the
 * `MachineCode` union, and a `baseSprite` field so the gallery and layout
 * canvas can render it using one of the built-in SVG illustrations until
 * we ship per-asset custom artwork.
 */
export interface CustomMachineSpec extends Omit<MachineSpec, 'code'> {
  code: string;
  isCustom: true;
  /** Which built-in sprite to render this asset with. */
  baseSprite: MachineCode;
}

/**
 * A user-authored worker role. Same shape as the built-in
 * `WorkerArchetype` but with a free-form `role` string and a `baseSprite`
 * pointing at a built-in role for visual rendering.
 */
export interface CustomWorkerArchetype extends Omit<WorkerArchetype, 'role'> {
  role: string;
  isCustom: true;
  baseSprite: import('../domain/workers').WorkerRole;
}

/**
 * A user-authored product kind. Products in Stitchworks are mostly visual
 * sprites with a label — customs piggy-back on a built-in `ProductKind`
 * for their SVG body and override colour + label.
 */
export interface CustomProductSpec {
  kind: string;
  isCustom: true;
  baseSprite: ProductKind;
  label: string;
  category: 'raw' | 'wip' | 'finished' | 'packed';
  /** Hex colour override used by the sprite tinter. */
  color?: string;
  description?: string;
}

/** Per-kind edit overlay for a built-in product. Sparse — only the fields
 *  the user changed are populated. */
export interface ProductEdit {
  label?: string;
  color?: string;
  description?: string;
  /** Override the SVG sprite shape (the rendered "kind"). */
  baseSprite?: ProductKind;
}

export interface ProjectMeta {
  name: string;
  factory: string;
  createdAt: string;
  modifiedAt: string;
}

/** Operator id → (operation id → efficiency 0..1). Sparse — missing entries
 *  fall back to the worker archetype's default efficiency. */
export type SkillMatrix = Record<string, Record<string, number>>;

export interface YamazumiAssignment {
  /** Operator display id, e.g. "OPR-01". */
  operatorId: string;
  /** Operation ids assigned to this operator, in execution order. */
  opIds: string[];
}

/** Display preferences. Persisted with the project so they roam with
 *  an exported `.swproj` file. Render sites must consume these (see
 *  `lib/format.ts`); never hardcode currency or date formatting. */
export interface UnitsPrefs {
  length: 'Meters' | 'Yards';
  currency: 'USD' | 'EUR' | 'INR' | 'BDT';
  samDisplay: 'Minutes' | 'Seconds';
  dateFormat: 'DD/MM' | 'MM/DD' | 'YYYY-MM-DD';
}

const defaultUnits: UnitsPrefs = {
  length: 'Meters',
  currency: 'USD',
  samDisplay: 'Minutes',
  dateFormat: 'YYYY-MM-DD',
};

/**
 * Time semantics for the simulation. Per *Big Book of Simulation Modelling*
 * (AnyLogic, Ch. 16), three time concepts must be modelled independently:
 *
 *   - Model time:    virtual sim clock, advances in event-jumps inside the
 *                    engine. Numeric, measured in `modelTimeUnit`.
 *   - Calendar time: model time projected onto a real `Date` via
 *                    `date(t) = startDate + t × modelTimeUnit`.
 *   - Wall time:     the user's device clock. Bound to model time only
 *                    during playback, via `executionMode` and `realTimeScale`.
 *
 * `UnitsPrefs` above stays a *display-formatting* struct (currency, date
 * format). `TimeSettings` here is *semantics* that affects what the numbers
 * actually mean.
 */
export type ExecutionMode = 'virtual' | 'realtime';

export interface TimeSettings {
  /** What one tick of engine `time` represents. Default `'minute'`. */
  modelTimeUnit: ModelTimeUnit;
  /** ISO datetime that maps to engine `t = 0`. Drives every calendar
   *  projection. Default = project's `createdAt`. */
  startDate: string;
  /** Shift start time-of-day, expressed as minutes-of-day (0..1439).
   *  Used by the calendar overlay; default 480 = 08:00. */
  shiftStartMinuteOfDay: number;
  /** Shift duration in MINUTES. Real-world human concept, so kept in
   *  minutes regardless of `modelTimeUnit`. Default 480 = 8 h. */
  shiftDurationMin: number;
  /** Playback pacing. `virtual` = run as fast as compute allows;
   *  `realtime` = pace at `realTimeScale` model-time-units per real-second. */
  executionMode: ExecutionMode;
  /**
   * Model-time-units per ONE real second when `executionMode = 'realtime'`.
   * Examples (with `modelTimeUnit = 'minute'`):
   *   1   ⇒ 1 model-min per real-sec  (true real time)
   *   60  ⇒ 60 model-min per real-sec (1 model-hour per real-second)
   *   480 ⇒ full 8-hr shift in 1 real second
   * Ignored when `executionMode = 'virtual'`. Default 1.
   */
  realTimeScale: number;
}

function defaultTimeSettings(createdAtISO?: string): TimeSettings {
  return {
    modelTimeUnit: 'minute',
    startDate: createdAtISO ?? new Date().toISOString(),
    shiftStartMinuteOfDay: 8 * 60,
    shiftDurationMin: 480,
    executionMode: 'realtime',
    realTimeScale: 1,
  };
}

/**
 * A floor inside the factory. Floors group lines (e.g. one floor for
 * Sewing, one for Cutting, one for Finishing). Used by the Factory Twin
 * to render the tree + zoom levels.
 */
export interface Floor {
  id: string;
  name: string;
  description: string;
  /** Token colour key used by the tree + heat overlay. */
  color: string;
}

/**
 * One production line inside one floor. Each line has its own garment,
 * crew size and production system, so a factory can run multiple
 * heterogeneous lines in parallel. KPIs are cached from the most-recent
 * sim run on this line (computed by the Factory Twin's "Run line" action).
 */
export interface Line {
  id: string;
  name: string;
  floorId: string;
  garmentTemplateId: string;
  operators: number;
  /** PBS / modular / UPS / etc. Drives operator distribution + WIP. */
  productionSystem: string;
  lastKpis?: ScenarioKpis;
  /** Wall-clock when lastKpis was captured. */
  lastRunAt?: string;
}

export interface FactoryStructure {
  floors: Floor[];
  lines: Line[];
}

/**
 * A saved factory configuration + the KPI snapshot from the run that
 * captured it. Compared side-by-side on the Scenarios page.
 */
export interface ScenarioKpis {
  producedPieces: number;
  throughputPerHr: number;
  efficiencyPct: number;
  meanLeadTime: number;
  utilization: number;
  wipBundles: number;
  bottleneckOpName: string;
  bottleneckQueue: number;
  /** Number of replications behind these means. 1 = single-seed run. */
  replicationCount?: number;
  /** OEE three-factor product (Availability × Performance × Quality), 0..1. */
  oee?: number;
  oeeAvailability?: number;
  oeePerformance?: number;
  oeeQuality?: number;
  /** On-standard performance % — alias of BSI in lean vocabulary. */
  onStandardPct?: number;
  /** Off-standard loss % = (clocked - earned) / clocked × 100. */
  offStandardLossPct?: number;
  /** Pieces produced per operator-hour. */
  labourProductivity?: number;
  /** Actual pph - demand pph; signed. */
  demandTaktGap?: number;
  /** Intrinsic balance ratio ÷ dynamic balance ratio. */
  intrinsicVsDynamicRatio?: number;
  /** Minutes lost to changeover; populated in P4. */
  changeoverMinutes?: number;
  /** Total changeover minutes summed across every changeover event. */
  totalChangeoverMinutes?: number;
  /** Per-order completion time keyed by Order.id (sim minutes). */
  perOrderCompletionTime?: Record<string, number>;
  /** Minutes lost to machine downtime; populated in P2. */
  downtimeMinutes?: number;
  /** Per-KPI standard deviation across replications, when available. */
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

export interface Scenario {
  id: string;
  name: string;
  notes?: string;
  createdAt: string;
  /** What was being modelled. */
  config: {
    garmentTemplateId: string;
    operators: number;
    /** Sparse overrides at save time — recreate the run if needed. */
    skillMatrix: SkillMatrix;
    yamazumiOverride?: YamazumiAssignment[];
    /** Snapshot of the active twin at save time. Lets a scenario carry its
     *  own factory layout (lines, workstations, connectors) so loading R1
     *  vs R2 swaps the floor, not just the per-garment config. Optional
     *  for backward compatibility — older scenarios saved without this
     *  field still load (they just don't restore a layout). */
    twin?: Twin;
  };
  /** Results from the run that produced this snapshot. */
  kpis: ScenarioKpis;
}

/**
 * A production order as committed from the Orders wizard. Persisted so the
 * Simulation page can offer it as a swappable source alongside the canonical
 * twin and any loaded reference paper. We keep the input fields (qty, deadline,
 * client) on the draft so the chip can show meaningful labels and the user can
 * re-open the order later for tweaks.
 */
export interface OrderDraft {
  id: string;
  po: string;
  client: string;
  style: string;
  qty: number;
  deadlineDays: number;
  garmentTemplateId: string;
  operators: number;
  productionSystem: ProductionSystem;
  createdAt: string;
}

/** Max recent orders kept in `orders[]`. Older entries are dropped FIFO. */
export const MAX_RECENT_ORDERS = 20 as const;

export interface ProjectState {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  meta: ProjectMeta;

  /** Active garment template id used by LiveSim and Yamazumi by default. */
  selectedGarmentId: string;

  /** Default operator count for new sims and balancing views. */
  defaultOperators: number;

  /**
   * Orders committed from the Orders wizard, most recent first. Surfaced
   * in LiveSim's SOURCE dropdown so the user can switch the simulation
   * between the canonical twin and any of their recent orders.
   */
  orders: OrderDraft[];

  /** The production system the user picked in the Orders wizard. Drives
   *  bundleSize in the sim and is surfaced in the LiveSim HUD so the user
   *  can confirm their layout choice is being honoured. */
  selectedProductionSystem: ProductionSystem;

  /** Operator name overrides (id → name). */
  operatorNames: Record<string, string>;

  /** Per-garment-template, the user's manual Yamazumi assignment, if any.
   *  When absent, the Yamazumi falls back to the LPT auto-assignment. */
  yamazumiOverrides: Record<string, YamazumiAssignment[]>;

  skillMatrix: SkillMatrix;

  scenarios: Scenario[];

  /** Multi-line factory structure consumed by the Factory Twin. */
  factory: FactoryStructure;

  /**
   * User edits to garment templates — per-garment overrides that shadow
   * the built-in `GARMENT_TEMPLATES`. Editing a built-in (e.g. SMV change)
   * clones it into here. Custom garments created from scratch live here
   * too (with ids that don't collide with built-ins).
   */
  garmentEdits: Record<string, GarmentTemplate>;

  /**
   * IDs of built-in garments the user has explicitly removed from the
   * library. They stay resolvable in `byId` (so factory workstations that
   * still reference them don't crash), but disappear from the picker list.
   * Removing a built-in also drops its edit + yamazumi override — restoring
   * later returns the clean catalog defaults.
   */
  hiddenGarmentIds: Record<string, true>;

  /** Per-machine-code edits that shadow the built-in `MACHINE_CATALOG`.
   *  Editing a built-in (e.g. cost change) clones the spec into here. */
  machineEdits: Record<string, MachineSpec>;
  /** User-authored workstations keyed by their custom code. */
  customMachines: Record<string, CustomMachineSpec>;
  /** Built-in machines flagged hidden by the user. They still exist in code
   *  but are filtered out of the asset library and any picker that calls
   *  through `useMachines`. */
  hiddenMachines: Record<string, true>;
  /** User-uploaded image (data URL) per machine code. Overrides the SVG sprite
   *  on asset library cards and any consumer that honours `customImage`. */
  machineImages: Record<string, string>;

  /** Per-role edits that shadow built-in `WORKER_ARCHETYPES`. */
  workerEdits: Record<string, WorkerArchetype>;
  /** User-authored worker archetypes keyed by their custom role id. */
  customWorkers: Record<string, CustomWorkerArchetype>;
  /** Built-in worker roles flagged hidden by the user. */
  hiddenWorkers: Record<string, true>;
  /** User-uploaded image (data URL) per worker role. */
  workerImages: Record<string, string>;

  /** User-authored product kinds keyed by their custom kind id. */
  customProducts: Record<string, CustomProductSpec>;
  /** Sparse edit overlay for built-in products (label/color/description). */
  productEdits: Record<string, ProductEdit>;
  /** Built-in product kinds flagged hidden by the user. */
  hiddenProducts: Record<string, true>;
  /** User-uploaded image (data URL) per product kind. */
  productImages: Record<string, string>;

  /** Display preferences set from the Settings page. Render sites read
   *  these to format currency, dates, distances and SAM. */
  units: UnitsPrefs;

  /** Time semantics: model-time-unit, calendar anchor, execution mode and
   *  real-time scale. See `TimeSettings`. */
  time: TimeSettings;

  // ── Mutators ─────────────────────────────────────────────────────────────
  rename: (name: string) => void;
  setSelectedGarment: (id: string) => void;
  setDefaultOperators: (n: number) => void;
  setSelectedProductionSystem: (id: ProductionSystem) => void;
  /** Push a new order to the front of `orders[]`, capping at MAX_RECENT_ORDERS.
   *  Returns the persisted draft (with id + createdAt assigned). */
  addOrder: (input: Omit<OrderDraft, 'id' | 'createdAt'>) => OrderDraft;
  /** Drop a saved order by id. No-op if the id isn't found. */
  removeOrder: (id: string) => void;
  /** Patch one unit/format preference. The Settings page calls this from
   *  each toggle's onChange. */
  setUnit: <K extends keyof UnitsPrefs>(key: K, value: UnitsPrefs[K]) => void;
  /** Patch one time-semantics field. */
  setTime: <K extends keyof TimeSettings>(key: K, value: TimeSettings[K]) => void;
  setOperatorName: (id: string, name: string) => void;
  setYamazumiOverride: (garmentId: string, assignments: YamazumiAssignment[]) => void;
  clearYamazumiOverride: (garmentId: string) => void;
  setSkill: (operatorId: string, opId: string, efficiency: number) => void;
  resetSkillMatrix: () => void;

  /** Save a scenario from the current state + a freshly-captured KPI run.
   *  When `twin` is supplied, the scenario stores a deep clone of the
   *  active factory layout so Load can restore it side-by-side with
   *  the per-garment config. */
  saveScenario: (input: {
    name: string;
    notes?: string;
    kpis: ScenarioKpis;
    twin?: Twin;
    /** Override the captured garmentTemplateId — e.g. when seeding
     *  bundle scenarios where the live `selectedGarmentId` isn't what
     *  the scenario card should display. */
    garmentTemplateId?: string;
    /** Override the captured operator count for the same reason. */
    operators?: number;
  }) => Scenario;
  /** Remove a scenario by id. */
  deleteScenario: (id: string) => void;
  /** Rename a scenario in place. */
  renameScenario: (id: string, name: string) => void;
  /**
   * Restore a scenario's config into the live project (garment, operators,
   * skill matrix, yamazumi override). The scenario itself is not deleted —
   * loading is non-destructive to the saved row.
   */
  loadScenario: (id: string) => void;

  // ── Factory CRUD ─────────────────────────────────────────────────────────
  /** Add a floor to the factory. Returns the created floor's id. */
  addFloor: (input: Omit<Floor, 'id'>) => string;
  /** Remove a floor + every line on it. */
  removeFloor: (id: string) => void;
  /** Rename a floor. */
  renameFloor: (id: string, name: string) => void;
  /** Add a new line to a floor. Returns the created line's id. */
  addLine: (input: Omit<Line, 'id' | 'lastKpis' | 'lastRunAt'>) => string;
  /** Remove a line. */
  removeLine: (id: string) => void;
  /** Update fields on a line (partial). */
  updateLine: (id: string, patch: Partial<Omit<Line, 'id' | 'floorId'>>) => void;
  /** Cache a fresh KPI snapshot on a line (called by Twin's Run-line). */
  setLineKpis: (id: string, kpis: ScenarioKpis) => void;

  // ── Garment / operation library ──────────────────────────────────────────
  /** Replace (or seed) an entire garment edit. Used when adding a brand-new
   *  garment from scratch and when the editor wants to commit a wholesale
   *  change. */
  setGarmentEdit: (id: string, garment: GarmentTemplate) => void;
  /** Patch top-level garment fields (name, description, defaultBundleSize,
   *  bestFor, totalSmv, hourlyTarget100). Auto-clones the built-in into
   *  `garmentEdits` if it isn't there yet. */
  patchGarment: (
    id: string,
    builtIn: GarmentTemplate | undefined,
    patch: Partial<Omit<GarmentTemplate, 'operations'>>,
  ) => void;
  /** Update one operation on a garment. */
  updateOperation: (
    garmentId: string,
    builtIn: GarmentTemplate | undefined,
    opId: string,
    patch: Partial<Operation>,
  ) => void;
  /** Append a new operation. */
  addOperation: (
    garmentId: string,
    builtIn: GarmentTemplate | undefined,
    op: Operation,
  ) => void;
  /** Remove an operation by id. */
  removeOperation: (
    garmentId: string,
    builtIn: GarmentTemplate | undefined,
    opId: string,
  ) => void;
  /** Shift an operation up (-1) or down (+1) in the bulletin. */
  moveOperation: (
    garmentId: string,
    builtIn: GarmentTemplate | undefined,
    opId: string,
    dir: -1 | 1,
  ) => void;
  /** Drop the override for a garment id; built-in default returns. */
  resetGarment: (id: string) => void;
  /** Hide a built-in garment from the picker and drop its edit + yamazumi
   *  override. Custom garments should use `resetGarment` instead. */
  hideGarment: (id: string) => void;
  /** Unhide a previously hidden built-in. */
  unhideGarment: (id: string) => void;

  // ── Asset library: workstations ──────────────────────────────────────────
  /** Patch a built-in machine spec (auto-clones into `machineEdits`). */
  patchMachine: (
    code: string,
    builtIn: MachineSpec | undefined,
    patch: Partial<Omit<MachineSpec, 'code'>>,
  ) => void;
  /** Drop the edit override for a built-in machine code. */
  resetMachine: (code: string) => void;
  /** Add a brand-new user-authored workstation. */
  addCustomMachine: (spec: CustomMachineSpec) => void;
  /** Patch one user-authored machine in-place. */
  patchCustomMachine: (code: string, patch: Partial<Omit<CustomMachineSpec, 'code' | 'isCustom'>>) => void;
  /** Remove a user-authored machine. */
  removeCustomMachine: (code: string) => void;
  /** Hide a built-in machine (filters it out of the asset library) or
   *  remove a custom machine outright. Idempotent. */
  deleteMachine: (code: string) => void;
  /** Un-hide a previously deleted built-in machine. No-op for customs. */
  restoreMachine: (code: string) => void;
  /** Set or clear the uploaded image (data URL) for a machine code. Pass
   *  `null` to clear. */
  setMachineImage: (code: string, dataUrl: string | null) => void;

  // ── Asset library: workers ───────────────────────────────────────────────
  patchWorker: (
    role: string,
    builtIn: WorkerArchetype | undefined,
    patch: Partial<Omit<WorkerArchetype, 'role'>>,
  ) => void;
  resetWorker: (role: string) => void;
  addCustomWorker: (spec: CustomWorkerArchetype) => void;
  patchCustomWorker: (role: string, patch: Partial<Omit<CustomWorkerArchetype, 'role' | 'isCustom'>>) => void;
  removeCustomWorker: (role: string) => void;
  /** Hide a built-in worker role or remove a custom one. */
  deleteWorker: (role: string) => void;
  /** Un-hide a previously deleted built-in worker role. */
  restoreWorker: (role: string) => void;
  /** Set or clear the uploaded image for a worker role. */
  setWorkerImage: (role: string, dataUrl: string | null) => void;

  // ── Asset library: products ──────────────────────────────────────────────
  addCustomProduct: (spec: CustomProductSpec) => void;
  patchCustomProduct: (kind: string, patch: Partial<Omit<CustomProductSpec, 'kind' | 'isCustom'>>) => void;
  removeCustomProduct: (kind: string) => void;
  /** Patch a built-in product (label/color/description/baseSprite). Clones
   *  the patch into `productEdits` sparsely. */
  patchProduct: (kind: string, patch: ProductEdit) => void;
  /** Drop the edit overlay for a built-in product. */
  resetProduct: (kind: string) => void;
  /** Hide a built-in product or remove a custom one. */
  deleteProduct: (kind: string) => void;
  /** Un-hide a previously deleted built-in product. */
  restoreProduct: (kind: string) => void;
  /** Set or clear the uploaded image for a product kind. */
  setProductImage: (kind: string, dataUrl: string | null) => void;
  /**
   * Sweep custom (non-built-in) garments whose names match the test-name
   * pattern (dvss/dsvs/asdf/test/casdcz). Idempotent — safe to call on every
   * boot. Returns the count removed. Also drops any Yamazumi overrides keyed
   * by a purged garment and snaps `selectedGarmentId` back to the default
   * built-in if it was pointing at one of the purged rows.
   */
  purgeTestGarments: () => number;

  // ── Project actions ──────────────────────────────────────────────────────
  /** Wipe everything back to defaults. Caller should confirm first. */
  resetProject: () => void;
  /** Replace state from an imported snapshot. Validates schema version. */
  loadProject: (snapshot: unknown) => { ok: true } | { ok: false; reason: string };
  /** Serialise current state to a plain JSON-safe object for export. */
  exportProject: () => ProjectState;
}

function defaultMeta(): ProjectMeta {
  const now = new Date().toISOString();
  return {
    name: 'Test Factory',
    factory: 'Brandix Unit-3',
    createdAt: now,
    modifiedAt: now,
  };
}

/**
 * Default factory: 3 floors (Sewing / Cutting / Finishing) with a sensible
 * spread of lines. Matches the layout the Factory Twin originally rendered
 * with mock data, but every value here flows into the real model.
 */
function defaultFactory(): FactoryStructure {
  return {
    floors: [
      { id: 'F1', name: 'Floor 1 · Sewing',    description: 'Knit garment sewing — 4 lines',  color: 'brand'  },
      { id: 'F2', name: 'Floor 2 · Cutting',   description: 'Spreading + cutting — 2 lines',  color: 'fabric' },
      { id: 'F3', name: 'Floor 3 · Finishing', description: 'Press + pack — 2 lines',         color: 'thread' },
    ],
    lines: [
      { id: 'L1', name: 'Line 1', floorId: 'F1', garmentTemplateId: 'tshirt',     operators: 25, productionSystem: 'PBS' },
      { id: 'L2', name: 'Line 2', floorId: 'F1', garmentTemplateId: 'polo',       operators: 28, productionSystem: 'PBS' },
      { id: 'L3', name: 'Line 3', floorId: 'F1', garmentTemplateId: 'shirt',      operators: 22, productionSystem: 'modular' },
      { id: 'L4', name: 'Line 4', floorId: 'F1', garmentTemplateId: 'sweatshirt', operators: 24, productionSystem: 'PBS' },
      { id: 'L5', name: 'Cut A',  floorId: 'F2', garmentTemplateId: 'tshirt',     operators: 6,  productionSystem: 'straight' },
      { id: 'L6', name: 'Cut B',  floorId: 'F2', garmentTemplateId: 'shirt',      operators: 8,  productionSystem: 'straight' },
      { id: 'L7', name: 'Finish A', floorId: 'F3', garmentTemplateId: 'tshirt',   operators: 10, productionSystem: 'straight' },
      { id: 'L8', name: 'Finish B', floorId: 'F3', garmentTemplateId: 'shirt',    operators: 8,  productionSystem: 'straight' },
    ],
  };
}

const defaults: Omit<
  ProjectState,
  | 'rename'
  | 'setSelectedGarment'
  | 'setDefaultOperators'
  | 'setSelectedProductionSystem'
  | 'addOrder'
  | 'removeOrder'
  | 'setOperatorName'
  | 'setYamazumiOverride'
  | 'clearYamazumiOverride'
  | 'setSkill'
  | 'resetSkillMatrix'
  | 'resetProject'
  | 'loadProject'
  | 'exportProject'
  | 'saveScenario'
  | 'deleteScenario'
  | 'renameScenario'
  | 'loadScenario'
  | 'addFloor'
  | 'removeFloor'
  | 'renameFloor'
  | 'addLine'
  | 'removeLine'
  | 'updateLine'
  | 'setLineKpis'
  | 'setGarmentEdit'
  | 'patchGarment'
  | 'updateOperation'
  | 'addOperation'
  | 'removeOperation'
  | 'moveOperation'
  | 'resetGarment'
  | 'hideGarment'
  | 'unhideGarment'
  | 'purgeTestGarments'
  | 'setUnit'
  | 'setTime'
  | 'patchMachine'
  | 'resetMachine'
  | 'addCustomMachine'
  | 'patchCustomMachine'
  | 'removeCustomMachine'
  | 'deleteMachine'
  | 'restoreMachine'
  | 'setMachineImage'
  | 'patchWorker'
  | 'resetWorker'
  | 'addCustomWorker'
  | 'patchCustomWorker'
  | 'removeCustomWorker'
  | 'deleteWorker'
  | 'restoreWorker'
  | 'setWorkerImage'
  | 'addCustomProduct'
  | 'patchCustomProduct'
  | 'removeCustomProduct'
  | 'patchProduct'
  | 'resetProduct'
  | 'deleteProduct'
  | 'restoreProduct'
  | 'setProductImage'
> = (() => {
  const meta = defaultMeta();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta,
    selectedGarmentId: 'tshirt',
    defaultOperators: 25,
    selectedProductionSystem: 'PBS',
    orders: [],
    operatorNames: {},
    yamazumiOverrides: {},
    skillMatrix: {},
    scenarios: [],
    factory: defaultFactory(),
    garmentEdits: {},
    hiddenGarmentIds: {},
    machineEdits: {},
    customMachines: {},
    hiddenMachines: {},
    machineImages: {},
    workerEdits: {},
    customWorkers: {},
    hiddenWorkers: {},
    workerImages: {},
    customProducts: {},
    productEdits: {},
    hiddenProducts: {},
    productImages: {},
    units: defaultUnits,
    time: defaultTimeSettings(meta.createdAt),
  };
})();

/** Re-derive totalSmv after operations change. */
function recomputeSmv(g: GarmentTemplate): GarmentTemplate {
  return { ...g, totalSmv: g.operations.reduce((s, o) => s + o.smv, 0) };
}

/** Clone the built-in into garmentEdits if no edit exists yet. */
function ensureEdit(
  edits: Record<string, GarmentTemplate>,
  id: string,
  builtIn: GarmentTemplate | undefined,
): { edits: Record<string, GarmentTemplate>; current: GarmentTemplate | undefined } {
  if (edits[id]) return { edits, current: edits[id] };
  if (!builtIn) return { edits, current: undefined };
  const clone = JSON.parse(JSON.stringify(builtIn)) as GarmentTemplate;
  return { edits: { ...edits, [id]: clone }, current: clone };
}

function touch<T extends ProjectState>(s: T): T {
  return { ...s, meta: { ...s.meta, modifiedAt: new Date().toISOString() } };
}

export const useProject = create<ProjectState>()(
  persist(
    (set, get) => ({
      ...defaults,

      rename: (name) =>
        set((s) => touch({ ...s, meta: { ...s.meta, name } })),

      setSelectedGarment: (id) =>
        set((s) => touch({ ...s, selectedGarmentId: id })),

      setDefaultOperators: (n) =>
        set((s) => touch({ ...s, defaultOperators: Math.max(1, Math.min(120, Math.round(n))) })),

      setSelectedProductionSystem: (id) =>
        set((s) => touch({ ...s, selectedProductionSystem: id })),

      addOrder: (input) => {
        const id = `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
        const draft: OrderDraft = { id, createdAt: new Date().toISOString(), ...input };
        set((s) =>
          touch({
            ...s,
            orders: [draft, ...s.orders].slice(0, MAX_RECENT_ORDERS),
          }),
        );
        return draft;
      },

      removeOrder: (id) =>
        set((s) => touch({ ...s, orders: s.orders.filter((o) => o.id !== id) })),

      setUnit: (key, value) =>
        set((s) => touch({ ...s, units: { ...s.units, [key]: value } })),

      setTime: (key, value) =>
        set((s) => touch({ ...s, time: { ...s.time, [key]: value } })),

      setOperatorName: (id, name) =>
        set((s) => touch({ ...s, operatorNames: { ...s.operatorNames, [id]: name } })),

      setYamazumiOverride: (garmentId, assignments) =>
        set((s) =>
          touch({
            ...s,
            yamazumiOverrides: { ...s.yamazumiOverrides, [garmentId]: assignments },
          }),
        ),

      clearYamazumiOverride: (garmentId) =>
        set((s) => {
          const next = { ...s.yamazumiOverrides };
          delete next[garmentId];
          return touch({ ...s, yamazumiOverrides: next });
        }),

      setSkill: (operatorId, opId, efficiency) =>
        set((s) => {
          const opRow = { ...(s.skillMatrix[operatorId] ?? {}) };
          if (efficiency <= 0) delete opRow[opId];
          else opRow[opId] = Math.max(0, Math.min(1.5, efficiency));
          return touch({
            ...s,
            skillMatrix: { ...s.skillMatrix, [operatorId]: opRow },
          });
        }),

      resetSkillMatrix: () => set((s) => touch({ ...s, skillMatrix: {} })),

      saveScenario: (input) => {
        const cur = get();
        const id = `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const garmentTemplateId = input.garmentTemplateId ?? cur.selectedGarmentId;
        const operators = input.operators ?? cur.defaultOperators;
        // When the caller overrides garmentTemplateId, look up yamazumi
        // against that key — falling back to none when there's no override
        // saved for the new garment.
        const yamSource = cur.yamazumiOverrides[garmentTemplateId];
        const scenario: Scenario = {
          id,
          name: input.name || `Scenario ${cur.scenarios.length + 1}`,
          notes: input.notes,
          createdAt: new Date().toISOString(),
          config: {
            garmentTemplateId,
            operators,
            skillMatrix: JSON.parse(JSON.stringify(cur.skillMatrix)) as SkillMatrix,
            yamazumiOverride: yamSource
              ? JSON.parse(JSON.stringify(yamSource)) as YamazumiAssignment[]
              : undefined,
            twin: input.twin ? (JSON.parse(JSON.stringify(input.twin)) as Twin) : undefined,
          },
          kpis: input.kpis,
        };
        set((s) => touch({ ...s, scenarios: [scenario, ...s.scenarios] }));
        return scenario;
      },

      deleteScenario: (id) =>
        set((s) => touch({ ...s, scenarios: s.scenarios.filter((x) => x.id !== id) })),

      renameScenario: (id, name) =>
        set((s) =>
          touch({
            ...s,
            scenarios: s.scenarios.map((x) => (x.id === id ? { ...x, name } : x)),
          }),
        ),

      loadScenario: (id) =>
        set((s) => {
          const scenario = s.scenarios.find((x) => x.id === id);
          if (!scenario) return s;
          const yamOverrides = { ...s.yamazumiOverrides };
          if (scenario.config.yamazumiOverride) {
            yamOverrides[scenario.config.garmentTemplateId] = scenario.config.yamazumiOverride;
          } else {
            delete yamOverrides[scenario.config.garmentTemplateId];
          }
          return touch({
            ...s,
            selectedGarmentId: scenario.config.garmentTemplateId,
            defaultOperators: scenario.config.operators,
            skillMatrix: JSON.parse(JSON.stringify(scenario.config.skillMatrix)) as SkillMatrix,
            yamazumiOverrides: yamOverrides,
          });
        }),

      addFloor: (input) => {
        const id = `F${Date.now().toString(36)}`;
        set((s) =>
          touch({ ...s, factory: { ...s.factory, floors: [...s.factory.floors, { id, ...input }] } }),
        );
        return id;
      },

      removeFloor: (id) =>
        set((s) =>
          touch({
            ...s,
            factory: {
              floors: s.factory.floors.filter((f) => f.id !== id),
              lines: s.factory.lines.filter((l) => l.floorId !== id),
            },
          }),
        ),

      renameFloor: (id, name) =>
        set((s) =>
          touch({
            ...s,
            factory: {
              ...s.factory,
              floors: s.factory.floors.map((f) => (f.id === id ? { ...f, name } : f)),
            },
          }),
        ),

      addLine: (input) => {
        const id = `L${Date.now().toString(36)}`;
        set((s) =>
          touch({
            ...s,
            factory: { ...s.factory, lines: [...s.factory.lines, { id, ...input }] },
          }),
        );
        return id;
      },

      removeLine: (id) =>
        set((s) =>
          touch({
            ...s,
            factory: { ...s.factory, lines: s.factory.lines.filter((l) => l.id !== id) },
          }),
        ),

      updateLine: (id, patch) =>
        set((s) =>
          touch({
            ...s,
            factory: {
              ...s.factory,
              lines: s.factory.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
            },
          }),
        ),

      setLineKpis: (id, kpis) =>
        set((s) =>
          touch({
            ...s,
            factory: {
              ...s.factory,
              lines: s.factory.lines.map((l) =>
                l.id === id ? { ...l, lastKpis: kpis, lastRunAt: new Date().toISOString() } : l,
              ),
            },
          }),
        ),

      setGarmentEdit: (id, garment) =>
        set((s) => touch({ ...s, garmentEdits: { ...s.garmentEdits, [id]: recomputeSmv(garment) } })),

      patchGarment: (id, builtIn, patch) =>
        set((s) => {
          const { edits, current } = ensureEdit(s.garmentEdits, id, builtIn);
          if (!current) return s;
          return touch({
            ...s,
            garmentEdits: { ...edits, [id]: recomputeSmv({ ...current, ...patch }) },
          });
        }),

      updateOperation: (garmentId, builtIn, opId, patch) =>
        set((s) => {
          const { edits, current } = ensureEdit(s.garmentEdits, garmentId, builtIn);
          if (!current) return s;
          const next = recomputeSmv({
            ...current,
            operations: current.operations.map((o) => (o.id === opId ? { ...o, ...patch } : o)),
          });
          return touch({ ...s, garmentEdits: { ...edits, [garmentId]: next } });
        }),

      addOperation: (garmentId, builtIn, op) =>
        set((s) => {
          const { edits, current } = ensureEdit(s.garmentEdits, garmentId, builtIn);
          if (!current) return s;
          const next = recomputeSmv({
            ...current,
            operations: [...current.operations, op],
          });
          return touch({ ...s, garmentEdits: { ...edits, [garmentId]: next } });
        }),

      removeOperation: (garmentId, builtIn, opId) =>
        set((s) => {
          const { edits, current } = ensureEdit(s.garmentEdits, garmentId, builtIn);
          if (!current) return s;
          const next = recomputeSmv({
            ...current,
            operations: current.operations.filter((o) => o.id !== opId),
          });
          return touch({ ...s, garmentEdits: { ...edits, [garmentId]: next } });
        }),

      moveOperation: (garmentId, builtIn, opId, dir) =>
        set((s) => {
          const { edits, current } = ensureEdit(s.garmentEdits, garmentId, builtIn);
          if (!current) return s;
          const idx = current.operations.findIndex((o) => o.id === opId);
          if (idx < 0) return s;
          const j = idx + dir;
          if (j < 0 || j >= current.operations.length) return s;
          const ops = current.operations.slice();
          [ops[idx], ops[j]] = [ops[j], ops[idx]];
          const next = recomputeSmv({ ...current, operations: ops });
          return touch({ ...s, garmentEdits: { ...edits, [garmentId]: next } });
        }),

      resetGarment: (id) =>
        set((s) => {
          const next = { ...s.garmentEdits };
          delete next[id];
          return touch({ ...s, garmentEdits: next });
        }),

      hideGarment: (id) =>
        set((s) => {
          // Drop the override and any yamazumi override so a future restore
          // returns the clean catalog defaults rather than stale edits.
          const nextEdits = { ...s.garmentEdits };
          delete nextEdits[id];
          const nextYama = { ...s.yamazumiOverrides };
          delete nextYama[id];
          const nextSelected =
            s.selectedGarmentId === id ? defaults.selectedGarmentId : s.selectedGarmentId;
          return touch({
            ...s,
            garmentEdits: nextEdits,
            yamazumiOverrides: nextYama,
            hiddenGarmentIds: { ...s.hiddenGarmentIds, [id]: true },
            selectedGarmentId: nextSelected,
          });
        }),

      unhideGarment: (id) =>
        set((s) => {
          if (!s.hiddenGarmentIds[id]) return s;
          const next = { ...s.hiddenGarmentIds };
          delete next[id];
          return touch({ ...s, hiddenGarmentIds: next });
        }),

      // ── Asset library: workstations ──────────────────────────────────────
      patchMachine: (code, builtIn, patch) =>
        set((s) => {
          const current = s.machineEdits[code] ?? builtIn;
          if (!current) return s;
          const next = { ...current, ...patch } as MachineSpec;
          return touch({ ...s, machineEdits: { ...s.machineEdits, [code]: next } });
        }),

      resetMachine: (code) =>
        set((s) => {
          if (!s.machineEdits[code]) return s;
          const next = { ...s.machineEdits };
          delete next[code];
          return touch({ ...s, machineEdits: next });
        }),

      addCustomMachine: (spec) =>
        set((s) => touch({ ...s, customMachines: { ...s.customMachines, [spec.code]: spec } })),

      patchCustomMachine: (code, patch) =>
        set((s) => {
          const current = s.customMachines[code];
          if (!current) return s;
          return touch({
            ...s,
            customMachines: { ...s.customMachines, [code]: { ...current, ...patch } },
          });
        }),

      removeCustomMachine: (code) =>
        set((s) => {
          if (!s.customMachines[code]) return s;
          const next = { ...s.customMachines };
          delete next[code];
          return touch({ ...s, customMachines: next });
        }),

      deleteMachine: (code) =>
        set((s) => {
          if (s.customMachines[code]) {
            const next = { ...s.customMachines };
            delete next[code];
            const nextImages = { ...s.machineImages };
            delete nextImages[code];
            return touch({ ...s, customMachines: next, machineImages: nextImages });
          }
          if (s.hiddenMachines[code]) return s;
          return touch({
            ...s,
            hiddenMachines: { ...s.hiddenMachines, [code]: true },
          });
        }),

      restoreMachine: (code) =>
        set((s) => {
          if (!s.hiddenMachines[code]) return s;
          const next = { ...s.hiddenMachines };
          delete next[code];
          return touch({ ...s, hiddenMachines: next });
        }),

      setMachineImage: (code, dataUrl) =>
        set((s) => {
          const next = { ...s.machineImages };
          if (dataUrl) next[code] = dataUrl;
          else delete next[code];
          return touch({ ...s, machineImages: next });
        }),

      // ── Asset library: workers ───────────────────────────────────────────
      patchWorker: (role, builtIn, patch) =>
        set((s) => {
          const current = s.workerEdits[role] ?? builtIn;
          if (!current) return s;
          const next = { ...current, ...patch } as WorkerArchetype;
          return touch({ ...s, workerEdits: { ...s.workerEdits, [role]: next } });
        }),

      resetWorker: (role) =>
        set((s) => {
          if (!s.workerEdits[role]) return s;
          const next = { ...s.workerEdits };
          delete next[role];
          return touch({ ...s, workerEdits: next });
        }),

      addCustomWorker: (spec) =>
        set((s) => touch({ ...s, customWorkers: { ...s.customWorkers, [spec.role]: spec } })),

      patchCustomWorker: (role, patch) =>
        set((s) => {
          const current = s.customWorkers[role];
          if (!current) return s;
          return touch({
            ...s,
            customWorkers: { ...s.customWorkers, [role]: { ...current, ...patch } },
          });
        }),

      removeCustomWorker: (role) =>
        set((s) => {
          if (!s.customWorkers[role]) return s;
          const next = { ...s.customWorkers };
          delete next[role];
          return touch({ ...s, customWorkers: next });
        }),

      deleteWorker: (role) =>
        set((s) => {
          if (s.customWorkers[role]) {
            const next = { ...s.customWorkers };
            delete next[role];
            const nextImages = { ...s.workerImages };
            delete nextImages[role];
            return touch({ ...s, customWorkers: next, workerImages: nextImages });
          }
          if (s.hiddenWorkers[role]) return s;
          return touch({
            ...s,
            hiddenWorkers: { ...s.hiddenWorkers, [role]: true },
          });
        }),

      restoreWorker: (role) =>
        set((s) => {
          if (!s.hiddenWorkers[role]) return s;
          const next = { ...s.hiddenWorkers };
          delete next[role];
          return touch({ ...s, hiddenWorkers: next });
        }),

      setWorkerImage: (role, dataUrl) =>
        set((s) => {
          const next = { ...s.workerImages };
          if (dataUrl) next[role] = dataUrl;
          else delete next[role];
          return touch({ ...s, workerImages: next });
        }),

      // ── Asset library: products ──────────────────────────────────────────
      addCustomProduct: (spec) =>
        set((s) => touch({ ...s, customProducts: { ...s.customProducts, [spec.kind]: spec } })),

      patchCustomProduct: (kind, patch) =>
        set((s) => {
          const current = s.customProducts[kind];
          if (!current) return s;
          return touch({
            ...s,
            customProducts: { ...s.customProducts, [kind]: { ...current, ...patch } },
          });
        }),

      removeCustomProduct: (kind) =>
        set((s) => {
          if (!s.customProducts[kind]) return s;
          const next = { ...s.customProducts };
          delete next[kind];
          return touch({ ...s, customProducts: next });
        }),

      patchProduct: (kind, patch) =>
        set((s) => {
          const current = s.productEdits[kind] ?? {};
          const merged: ProductEdit = { ...current, ...patch };
          // Strip undefined keys so the overlay stays sparse.
          (Object.keys(merged) as (keyof ProductEdit)[]).forEach((k) => {
            if (merged[k] === undefined) delete merged[k];
          });
          return touch({
            ...s,
            productEdits: { ...s.productEdits, [kind]: merged },
          });
        }),

      resetProduct: (kind) =>
        set((s) => {
          if (!s.productEdits[kind]) return s;
          const next = { ...s.productEdits };
          delete next[kind];
          return touch({ ...s, productEdits: next });
        }),

      deleteProduct: (kind) =>
        set((s) => {
          if (s.customProducts[kind]) {
            const next = { ...s.customProducts };
            delete next[kind];
            const nextImages = { ...s.productImages };
            delete nextImages[kind];
            return touch({ ...s, customProducts: next, productImages: nextImages });
          }
          if (s.hiddenProducts[kind]) return s;
          return touch({
            ...s,
            hiddenProducts: { ...s.hiddenProducts, [kind]: true },
          });
        }),

      restoreProduct: (kind) =>
        set((s) => {
          if (!s.hiddenProducts[kind]) return s;
          const next = { ...s.hiddenProducts };
          delete next[kind];
          return touch({ ...s, hiddenProducts: next });
        }),

      setProductImage: (kind, dataUrl) =>
        set((s) => {
          const next = { ...s.productImages };
          if (dataUrl) next[kind] = dataUrl;
          else delete next[kind];
          return touch({ ...s, productImages: next });
        }),

      purgeTestGarments: () => {
        let removed = 0;
        set((s) => {
          const next: Record<string, GarmentTemplate> = {};
          const purgedIds: string[] = [];
          for (const [id, g] of Object.entries(s.garmentEdits)) {
            // Only sweep custom rows. A user who renamed a built-in to
            // "test something" still owns that edit — leave it alone.
            const isBuiltIn = !!GARMENT_TEMPLATES[id];
            if (!isBuiltIn && TEST_GARMENT_PATTERN.test((g.name ?? '').trim())) {
              purgedIds.push(id);
              continue;
            }
            next[id] = g;
          }
          if (purgedIds.length === 0) return s;
          removed = purgedIds.length;
          const nextOverrides = { ...s.yamazumiOverrides };
          for (const id of purgedIds) delete nextOverrides[id];
          const selected = purgedIds.includes(s.selectedGarmentId)
            ? defaults.selectedGarmentId
            : s.selectedGarmentId;
          return touch({
            ...s,
            garmentEdits: next,
            yamazumiOverrides: nextOverrides,
            selectedGarmentId: selected,
          });
        });
        return removed;
      },

      resetProject: () =>
        set(() => ({
          ...defaults,
          meta: defaultMeta(),
          rename: get().rename,
          setSelectedGarment: get().setSelectedGarment,
          setDefaultOperators: get().setDefaultOperators,
          setSelectedProductionSystem: get().setSelectedProductionSystem,
          addOrder: get().addOrder,
          removeOrder: get().removeOrder,
          setUnit: get().setUnit,
          setTime: get().setTime,
          setOperatorName: get().setOperatorName,
          setYamazumiOverride: get().setYamazumiOverride,
          clearYamazumiOverride: get().clearYamazumiOverride,
          setSkill: get().setSkill,
          resetSkillMatrix: get().resetSkillMatrix,
          saveScenario: get().saveScenario,
          deleteScenario: get().deleteScenario,
          renameScenario: get().renameScenario,
          loadScenario: get().loadScenario,
          addFloor: get().addFloor,
          removeFloor: get().removeFloor,
          renameFloor: get().renameFloor,
          addLine: get().addLine,
          removeLine: get().removeLine,
          updateLine: get().updateLine,
          setLineKpis: get().setLineKpis,
          setGarmentEdit: get().setGarmentEdit,
          patchGarment: get().patchGarment,
          updateOperation: get().updateOperation,
          addOperation: get().addOperation,
          removeOperation: get().removeOperation,
          moveOperation: get().moveOperation,
          resetGarment: get().resetGarment,
          hideGarment: get().hideGarment,
          unhideGarment: get().unhideGarment,
          purgeTestGarments: get().purgeTestGarments,
          patchMachine: get().patchMachine,
          resetMachine: get().resetMachine,
          addCustomMachine: get().addCustomMachine,
          patchCustomMachine: get().patchCustomMachine,
          removeCustomMachine: get().removeCustomMachine,
          patchWorker: get().patchWorker,
          resetWorker: get().resetWorker,
          addCustomWorker: get().addCustomWorker,
          patchCustomWorker: get().patchCustomWorker,
          removeCustomWorker: get().removeCustomWorker,
          addCustomProduct: get().addCustomProduct,
          patchCustomProduct: get().patchCustomProduct,
          removeCustomProduct: get().removeCustomProduct,
          resetProject: get().resetProject,
          loadProject: get().loadProject,
          exportProject: get().exportProject,
        })),

      loadProject: (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'Not an object' };
        const s = snapshot as Partial<ProjectState>;
        // Accept v1 and v2; v1 imports get default TimeSettings filled in.
        const sv = s.schemaVersion as number | undefined;
        if (sv !== 1 && sv !== 2) {
          return {
            ok: false,
            reason: `Schema version mismatch: file is v${sv}, app supports v1 or v2`,
          };
        }
        set((cur) => ({
          ...cur,
          schemaVersion: PROJECT_SCHEMA_VERSION,
          meta: { ...defaults.meta, ...s.meta, modifiedAt: new Date().toISOString() },
          selectedGarmentId: s.selectedGarmentId ?? defaults.selectedGarmentId,
          defaultOperators: s.defaultOperators ?? defaults.defaultOperators,
          selectedProductionSystem: s.selectedProductionSystem ?? defaults.selectedProductionSystem,
          orders: s.orders ?? [],
          operatorNames: s.operatorNames ?? {},
          yamazumiOverrides: s.yamazumiOverrides ?? {},
          skillMatrix: s.skillMatrix ?? {},
          scenarios: s.scenarios ?? [],
          factory: s.factory ?? defaultFactory(),
          garmentEdits: s.garmentEdits ?? {},
          hiddenGarmentIds: s.hiddenGarmentIds ?? {},
          machineEdits: s.machineEdits ?? {},
          customMachines: s.customMachines ?? {},
          workerEdits: s.workerEdits ?? {},
          customWorkers: s.customWorkers ?? {},
          customProducts: s.customProducts ?? {},
          units: { ...defaultUnits, ...s.units },
          // v1 files have no `time` field — fill from defaults anchored on
          // the project's creation date so calendar projections are sensible.
          time: {
            ...defaultTimeSettings(s.meta?.createdAt ?? defaults.meta.createdAt),
            ...(s.time ?? {}),
          },
        }));
        return { ok: true };
      },

      exportProject: () => {
        const s = get();
        return {
          schemaVersion: s.schemaVersion,
          meta: s.meta,
          selectedGarmentId: s.selectedGarmentId,
          defaultOperators: s.defaultOperators,
          selectedProductionSystem: s.selectedProductionSystem,
          orders: s.orders,
          operatorNames: s.operatorNames,
          yamazumiOverrides: s.yamazumiOverrides,
          skillMatrix: s.skillMatrix,
          scenarios: s.scenarios,
          factory: s.factory,
          garmentEdits: s.garmentEdits,
          hiddenGarmentIds: s.hiddenGarmentIds,
          machineEdits: s.machineEdits,
          customMachines: s.customMachines,
          workerEdits: s.workerEdits,
          customWorkers: s.customWorkers,
          customProducts: s.customProducts,
          units: s.units,
          time: s.time,
        } as ProjectState;
      },
    }),
    {
      name: 'stitchworks.project.v1',
      version: PROJECT_SCHEMA_VERSION,
      // Quota-aware storage — when the library + twin writes have eaten
      // the budget and project.scenarios can't fit, we want a loud
      // console.error instead of a silently dropped scenarios array.
      storage: createJSONStorage(() => indexedDbStorage()),
      // Persist data only — don't try to serialise functions.
      partialize: (state) => ({
        schemaVersion: state.schemaVersion,
        meta: state.meta,
        selectedGarmentId: state.selectedGarmentId,
        defaultOperators: state.defaultOperators,
        selectedProductionSystem: state.selectedProductionSystem,
        orders: state.orders,
        operatorNames: state.operatorNames,
        yamazumiOverrides: state.yamazumiOverrides,
        skillMatrix: state.skillMatrix,
        scenarios: state.scenarios,
        factory: state.factory,
        garmentEdits: state.garmentEdits,
        hiddenGarmentIds: state.hiddenGarmentIds,
        machineEdits: state.machineEdits,
        customMachines: state.customMachines,
        workerEdits: state.workerEdits,
        customWorkers: state.customWorkers,
        customProducts: state.customProducts,
        units: state.units,
        time: state.time,
      }),
      // v1 → v2: add the `time` slice with sensible defaults anchored on
      // the existing project's creation date.
      migrate: (persisted, fromVersion) => {
        const p = (persisted as Partial<ProjectState>) ?? {};
        if (fromVersion < 2) {
          const createdAt = p.meta?.createdAt ?? new Date().toISOString();
          return {
            ...p,
            schemaVersion: PROJECT_SCHEMA_VERSION,
            time: defaultTimeSettings(createdAt),
          } as Partial<ProjectState>;
        }
        return p as Partial<ProjectState>;
      },
      // Existing localStorage payloads predate `units` and the asset-library
      // edit maps. Without this, the first boot after upgrade hydrates them
      // as undefined and any consumer that iterates over them crashes.
      merge: (persisted, current) => {
        const p = (persisted as Partial<ProjectState>) ?? {};
        return {
          ...current,
          ...p,
          units: { ...defaultUnits, ...(p.units ?? {}) },
          hiddenGarmentIds: p.hiddenGarmentIds ?? {},
          machineEdits: p.machineEdits ?? {},
          customMachines: p.customMachines ?? {},
          workerEdits: p.workerEdits ?? {},
          customWorkers: p.customWorkers ?? {},
          customProducts: p.customProducts ?? {},
          orders: p.orders ?? [],
          time: { ...defaultTimeSettings(p.meta?.createdAt ?? current.meta.createdAt), ...(p.time ?? {}) },
        };
      },
    },
  ),
);

/**
 * Trigger a `.swproj` JSON download for the current project. Used by the
 * Settings page Export button.
 */
export function downloadProjectJson(state: ProjectState): void {
  const data = state.exportProject();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const filename = `${(data.meta.name || 'stitchworks').replace(/[^a-z0-9-_]/gi, '-')}.swproj`;
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Pop a file picker, parse the chosen `.swproj` (or `.json`), and feed it to
 * `loadProject`. Resolves to a result describing success or the failure
 * reason for the caller to show to the user.
 */
export function pickProjectFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.swproj,.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file chosen'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = reader.result as string;
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
