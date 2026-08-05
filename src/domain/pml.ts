import { PML_ICONS, type PmlIconComponent } from '../assets/pml-icons';
import { apparelLabelForKind } from './apparelPresets';

/**
 * Process Modeling Library (PML) — block taxonomy adapted from AnyLogic's
 * Process Modeling Library, with apparel-domain flavouring.
 *
 * Every entity in a Stitchworks twin is — conceptually — a PML block. A
 * block has:
 *   • a `kind`        (Source / Queue / Service / Delay / SelectOutput / …)
 *   • a list of named `inputs`  (where flow comes IN)
 *   • a list of named `outputs` (where flow goes OUT)
 *   • optionally, a list of `resourceRefs` (pools it draws on, when the
 *     kind is Service / Seize / Assembler).
 *
 * This file is *pure data + pure logic*. No React, no DOM, no zustand. It
 * is consumable from the simulation engine, page components, and the
 * project file format.
 *
 * The current `Workstation` type in `domain/twin.ts` is fixture-typed
 * (catalog id → sewing machine, rack, conveyor, …). This module bridges
 * that to PML by giving every catalog id a default block kind + ports —
 * so the existing twin works as a PML model without a data migration.
 *
 * The next schema bump will lift `block: { kind, inputs, outputs }` onto
 * Workstation directly so users can author non-default kinds (e.g. tag a
 * generic table as a Hold or Match block). Until then, `getBlockSpec(ws)`
 * is the single source of truth.
 */

// ============================================================================
// PORT
// ============================================================================

/** A single input or output socket on a PML block.
 *
 *  - `id`   stable identifier within the block (e.g. `'in'`, `'out'`,
 *           `'pass'`, `'fail'`, `'parts[0]'`). Connectors reference these.
 *  - `kind` what flows through it. `'agent'` is the default — bundles,
 *           garments, fabric rolls. `'resource'` is for pool wiring.
 *  - `label` human-readable text shown on the canvas.
 */
export interface PmlPort {
  id: string;
  label: string;
  kind: 'agent' | 'resource';
}

// ============================================================================
// BLOCK KINDS — superset adapted from AnyLogic PML
// ============================================================================
//
// We expose the canonical PML block names so the model is portable to /
// validatable against an AnyLogic build. The set is curated to what
// matters for apparel manufacturing — a few PML blocks (Pickup, Dropoff,
// RestrictedAreaStart/End, TimeMeasureStart/End) are intentionally
// omitted from v1 and can be added later without breaking the schema.

export type PmlBlockKind =
  // ── flow lifecycle ────────────────────────────────────────────────────────
  | 'Source'
  | 'Sink'
  // ── buffering + pacing ────────────────────────────────────────────────────
  | 'Queue'
  | 'Delay'
  | 'Hold'
  | 'Wait'
  // ── service / resource semantics ──────────────────────────────────────────
  | 'Service'
  | 'Seize'
  | 'Release'
  | 'ResourcePool'
  // ── routing ───────────────────────────────────────────────────────────────
  | 'SelectOutput'
  | 'SelectOutput5'
  // ── batching + assembly ───────────────────────────────────────────────────
  | 'Batch'
  | 'Unbatch'
  | 'Combine'
  | 'Match'
  | 'Assembler'
  | 'Split'
  // ── movement ──────────────────────────────────────────────────────────────
  | 'MoveTo'
  | 'Conveyor';

// ============================================================================
// BLOCK SPEC — static definition of a PML block kind
// ============================================================================

/** Library category — drives the palette grouping shown to the user. */
export type PmlCategory =
  | 'lifecycle' // Source, Sink
  | 'buffer'    // Queue, Delay, Hold, Wait
  | 'service'   // Service, Seize, Release, ResourcePool
  | 'routing'   // SelectOutput, SelectOutput5
  | 'batch'     // Batch, Unbatch, Combine, Match, Assembler, Split
  | 'movement'; // MoveTo, Conveyor

export interface PmlBlockSpec {
  kind: PmlBlockKind;
  /** Short human label, e.g. "Service". */
  label: string;
  /** One-line plain-English description of the block's behaviour. */
  blurb: string;
  /** Single Unicode glyph used as a fallback in text-only contexts
   *  (project-file snapshots, console logging). UI surfaces should
   *  prefer the `Icon` React component below — it renders a proper
   *  solid-filled SVG glyph that tints by the caller's colour. */
  glyph: string;
  /** Solid-filled SVG icon component for the block kind. Same component
   *  is consumed by the palette, inspector, process-diagram node header,
   *  live-sim card, and iso-canvas top-face decal — the colour comes
   *  from the host surface via the `color` prop. */
  Icon: PmlIconComponent;
  category: PmlCategory;
  /** Fixed input ports for this kind. Some kinds (Combine, Assembler) have
   *  variable arity — the spec lists the *minimum* ports; the workstation
   *  may declare additional ones. */
  inputs: PmlPort[];
  outputs: PmlPort[];
  /** True if the block draws from a ResourcePool (Seize, Service, Assembler). */
  usesResources: boolean;
}

// ── Common port templates — shared by simple linear blocks ────────────────
const IN: PmlPort = { id: 'in', label: 'in', kind: 'agent' };
const OUT: PmlPort = { id: 'out', label: 'out', kind: 'agent' };

export const PML_BLOCK_LIBRARY: Record<PmlBlockKind, PmlBlockSpec> = {
  // ── lifecycle ────────────────────────────────────────────────────────────
  Source: {
    kind: 'Source',
    label: 'Source',
    blurb: 'Generates agents (orders, fabric rolls, garments) on a schedule.',
    glyph: '▶',
    Icon: PML_ICONS.Source,
    category: 'lifecycle',
    inputs: [],
    outputs: [OUT],
    usesResources: false,
  },
  Sink: {
    kind: 'Sink',
    label: 'Sink',
    blurb: 'Destroys agents that complete the flow (shipped, scrapped).',
    glyph: '■',
    Icon: PML_ICONS.Sink,
    category: 'lifecycle',
    inputs: [IN],
    outputs: [],
    usesResources: false,
  },

  // ── buffer + pacing ──────────────────────────────────────────────────────
  Queue: {
    kind: 'Queue',
    label: 'Queue',
    blurb: 'Holds agents in arrival order (FIFO bundle buffer, WIP rack).',
    glyph: '⫶',
    Icon: PML_ICONS.Queue,
    category: 'buffer',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },
  Delay: {
    kind: 'Delay',
    label: 'Delay',
    blurb: 'Pure processing time without consuming a resource (cure, set).',
    glyph: '◷',
    Icon: PML_ICONS.Delay,
    category: 'buffer',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },
  Hold: {
    kind: 'Hold',
    label: 'Hold',
    blurb: 'Blocks/unblocks flow on a condition (line stop, shift change).',
    glyph: '✋',
    Icon: PML_ICONS.Hold,
    category: 'buffer',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },
  Wait: {
    kind: 'Wait',
    label: 'Wait',
    blurb: 'Holds an agent indefinitely until released by code.',
    glyph: '⏸',
    Icon: PML_ICONS.Wait,
    category: 'buffer',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },

  // ── service / resources ──────────────────────────────────────────────────
  Service: {
    kind: 'Service',
    label: 'Service',
    blurb: 'Seize → Delay → Release. The bread-and-butter sewing/iron op.',
    glyph: '⚙',
    Icon: PML_ICONS.Service,
    category: 'service',
    inputs: [IN],
    outputs: [OUT],
    usesResources: true,
  },
  Seize: {
    kind: 'Seize',
    label: 'Seize',
    blurb: 'Claims units of a resource pool (operator, mechanic, machine).',
    glyph: '⤓',
    Icon: PML_ICONS.Seize,
    category: 'service',
    inputs: [IN],
    outputs: [OUT],
    usesResources: true,
  },
  Release: {
    kind: 'Release',
    label: 'Release',
    blurb: 'Returns previously-seized resource units to the pool.',
    glyph: '⤒',
    Icon: PML_ICONS.Release,
    category: 'service',
    inputs: [IN],
    outputs: [OUT],
    usesResources: true,
  },
  ResourcePool: {
    kind: 'ResourcePool',
    label: 'ResourcePool',
    blurb: 'A pool of operators / mechanics / machines that Services draw on.',
    glyph: '☻',
    Icon: PML_ICONS.ResourcePool,
    category: 'service',
    inputs: [],
    outputs: [],
    usesResources: false,
  },

  // ── routing ──────────────────────────────────────────────────────────────
  SelectOutput: {
    kind: 'SelectOutput',
    label: 'SelectOutput',
    blurb: '2-way router on a condition. The QC pass/fail block.',
    glyph: '⊻',
    Icon: PML_ICONS.SelectOutput,
    category: 'routing',
    inputs: [IN],
    outputs: [
      { id: 'pass', label: 'pass', kind: 'agent' },
      { id: 'fail', label: 'fail', kind: 'agent' },
    ],
    usesResources: false,
  },
  SelectOutput5: {
    kind: 'SelectOutput5',
    label: 'SelectOutput5',
    blurb: '5-way router (size grading: S / M / L / XL / XXL).',
    glyph: '⋔',
    Icon: PML_ICONS.SelectOutput5,
    category: 'routing',
    inputs: [IN],
    outputs: [
      { id: 'o1', label: 'S',   kind: 'agent' },
      { id: 'o2', label: 'M',   kind: 'agent' },
      { id: 'o3', label: 'L',   kind: 'agent' },
      { id: 'o4', label: 'XL',  kind: 'agent' },
      { id: 'o5', label: 'XXL', kind: 'agent' },
    ],
    usesResources: false,
  },

  // ── batch + assembly ─────────────────────────────────────────────────────
  Batch: {
    kind: 'Batch',
    label: 'Batch',
    blurb: 'Collects N agents into a bundle agent (cut → bundle).',
    glyph: '⊞',
    Icon: PML_ICONS.Batch,
    category: 'batch',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },
  Unbatch: {
    kind: 'Unbatch',
    label: 'Unbatch',
    blurb: 'Releases batched agents one-by-one (bundle → pieces).',
    glyph: '⊟',
    Icon: PML_ICONS.Unbatch,
    category: 'batch',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },
  Combine: {
    kind: 'Combine',
    label: 'Combine',
    blurb: 'Merges two streams into one agent (front + back panels).',
    glyph: '⤧',
    Icon: PML_ICONS.Combine,
    category: 'batch',
    inputs: [
      { id: 'in1', label: 'a', kind: 'agent' },
      { id: 'in2', label: 'b', kind: 'agent' },
    ],
    outputs: [OUT],
    usesResources: false,
  },
  Match: {
    kind: 'Match',
    label: 'Match',
    blurb: 'Pairs agents from two streams by a key (size match, colour match).',
    glyph: '⤭',
    Icon: PML_ICONS.Match,
    category: 'batch',
    inputs: [
      { id: 'in1', label: 'a', kind: 'agent' },
      { id: 'in2', label: 'b', kind: 'agent' },
    ],
    outputs: [
      { id: 'out1', label: 'a', kind: 'agent' },
      { id: 'out2', label: 'b', kind: 'agent' },
    ],
    usesResources: false,
  },
  Assembler: {
    kind: 'Assembler',
    label: 'Assembler',
    blurb: 'Fixed-recipe assembly of N parts into one agent (full garment).',
    glyph: '⊕',
    Icon: PML_ICONS.Assembler,
    category: 'batch',
    inputs: [
      { id: 'parts1', label: 'body',    kind: 'agent' },
      { id: 'parts2', label: 'sleeves', kind: 'agent' },
      { id: 'parts3', label: 'collar',  kind: 'agent' },
    ],
    outputs: [OUT],
    usesResources: true,
  },
  Split: {
    kind: 'Split',
    label: 'Split',
    blurb: 'Duplicates an agent into N copies (panel-cut: 1 ply → N pieces).',
    glyph: '⤬',
    Icon: PML_ICONS.Split,
    category: 'batch',
    inputs: [IN],
    outputs: [
      { id: 'orig',   label: 'orig',  kind: 'agent' },
      { id: 'copy',   label: 'copy',  kind: 'agent' },
    ],
    usesResources: false,
  },

  // ── movement ─────────────────────────────────────────────────────────────
  MoveTo: {
    kind: 'MoveTo',
    label: 'MoveTo',
    blurb: 'Transports the agent to a target node (forklift, AGV, runner).',
    glyph: '➜',
    Icon: PML_ICONS.MoveTo,
    category: 'movement',
    inputs: [IN],
    outputs: [OUT],
    usesResources: true,
  },
  Conveyor: {
    kind: 'Conveyor',
    label: 'Conveyor',
    blurb: 'Continuous belt — fixed speed, fixed length, FIFO order.',
    glyph: '═',
    Icon: PML_ICONS.Conveyor,
    category: 'movement',
    inputs: [IN],
    outputs: [OUT],
    usesResources: false,
  },
};

/** PML categories in the order they should appear in the palette. */
export const PML_CATEGORIES: { id: PmlCategory; label: string; blurb: string }[] = [
  { id: 'lifecycle', label: 'Lifecycle', blurb: 'Where flow begins and ends.' },
  { id: 'buffer',    label: 'Buffer',    blurb: 'Queue, hold, delay — non-resource pacing.' },
  { id: 'service',   label: 'Service',   blurb: 'Seize → Delay → Release. Operator + machine operations.' },
  { id: 'routing',   label: 'Routing',   blurb: 'Branch the flow on a condition.' },
  { id: 'batch',     label: 'Batch',     blurb: 'Bundle / unbundle / combine / split / assemble.' },
  { id: 'movement',  label: 'Movement',  blurb: 'Transport — conveyors, AGVs, forklifts.' },
];

/** All blocks in a category, in the order they should be presented. */
export function blocksInCategory(cat: PmlCategory): PmlBlockSpec[] {
  return Object.values(PML_BLOCK_LIBRARY).filter((b) => b.category === cat);
}

// ============================================================================
// CATALOG → BLOCK KIND MAPPING
// ============================================================================
//
// Each ISO_FIXTURE_CATALOG entry is mapped to a default PML block kind so
// the existing demo factory works as a PML model out of the box. Anything
// not listed defaults via `inferBlockKindFromCategory`.

const CATALOG_TO_BLOCK: Record<string, PmlBlockKind> = {
  // Line heads / tails — `buf_in` always sits at the start of a flow and
  // `buf_out` always at the end (intermediate buffers use `buf_wip` or
  // `a_wip_rack`). Mapping them to Queue would leave the PML engine with
  // no Source → no arrivals → all-zero KPIs in Reports/LiveSim. Treat the
  // catalog ids as the lifecycle blocks they actually represent. Users can
  // still override per-workstation via `block.kind` from the inspector.
  buf_in:           'Source',
  buf_out:          'Sink',
  buf_wip:          'Queue',
  a_wip_rack:       'Queue',
  a_fabric_rack:    'Queue',
  st_rack:          'Queue',
  st_pallet:        'Queue',
  st_roll:          'Queue',
  st_bin:           'Queue',
  a_bundle_trolley: 'Queue',

  // Sewing machines + cutting machines = Service (op + machine)
  a_snls:        'Service', a_dnls:        'Service',
  a_3ol:         'Service', a_4ol:         'Service', a_5ol: 'Service',
  a_flatlock:    'Service',
  a_bartack:     'Service',
  a_buttonhole:  'Service', a_buttonsew:   'Service',
  a_foa:         'Service',
  a_kansai:      'Service',
  a_embroidery:  'Service',
  mach_ssm:      'Service', mach_over:     'Service', mach_flat: 'Service',
  mach_bart:     'Service', mach_btnh:     'Service',
  a_spread_manual: 'Service', a_spread_auto: 'Service',
  a_knife_straight: 'Service', a_knife_band: 'Service',
  a_cnc_cutter: 'Service', a_marker_plotter: 'Service',
  cut_spread: 'Service', cut_knife: 'Service', cut_band: 'Service', cut_cnc: 'Service',

  // Iron + press tables = Service (operator + station)
  a_iron_inline: 'Service',
  fx_press:      'Service',
  fx_pack:       'Service',
  fx_table:      'Delay',
  a_op_desk:     'Delay',

  // QC inspection — pass/fail router
  a_inspect_table: 'SelectOutput',
  fx_qctab:        'SelectOutput',

  // Cutting outputs = Batch (cut → bundle)
  a_cut_table: 'Batch',

  // Conveyors
  conv_str:   'Conveyor',
  conv_curve: 'Conveyor',
  conv_inc:   'Conveyor',

  // Material handlers = MoveTo (transport agent role)
  mh_forklift: 'MoveTo',
  mh_pallet:   'MoveTo',
  mh_trolley:  'MoveTo',
  mh_agv:      'MoveTo',

  // Operators = ResourcePool unit
  op_sewer:  'ResourcePool',
  op_cutter: 'ResourcePool',
  op_helper: 'ResourcePool',
  op_super:  'ResourcePool',
  op_qc:     'ResourcePool',
};

/**
 * Resolve the PML block kind for a given catalogId. Falls back to a
 * sensible default by-category prefix when the id is unknown.
 */
export function inferBlockKindFromCatalog(catalogId: string): PmlBlockKind {
  const explicit = CATALOG_TO_BLOCK[catalogId];
  if (explicit) return explicit;

  // Heuristic prefix fallback for catalog ids we haven't enumerated.
  if (catalogId.startsWith('op_'))   return 'ResourcePool';
  if (catalogId.startsWith('mach_')) return 'Service';
  if (catalogId.startsWith('a_'))    return 'Service';
  if (catalogId.startsWith('cut_'))  return 'Service';
  if (catalogId.startsWith('mh_'))   return 'MoveTo';
  if (catalogId.startsWith('buf_'))  return 'Queue';
  if (catalogId.startsWith('st_'))   return 'Queue';
  if (catalogId.startsWith('conv_')) return 'Conveyor';
  if (catalogId.startsWith('fx_'))   return 'Delay';
  if (catalogId.startsWith('zone_')) return 'Queue';
  return 'Service';
}

// ============================================================================
// WORKSTATION → BLOCK SPEC
// ============================================================================

/**
 * Authored parameters that drive simulation behaviour per block. Only
 * the fields relevant to the block's `kind` matter — others are ignored.
 *
 * Why a flat record (instead of a discriminated union per kind):
 *   • the Inspector edits them one field at a time
 *   • the engine reads only the fields it cares about
 *   • round-tripping through JSON is trivial
 *   • adding a future field doesn't bump the on-disk schema
 *
 * The engine falls back to fixture catalog props (cycle_s,
 * capacity_per_hr) when a param is omitted, and finally to a hard-coded
 * default when neither is set. See `getBlockParams()` for the exact
 * resolution order.
 */
export interface PmlBlockParams {
  /** Source — agents per hour generated. */
  sourceRatePerHr?: number;
  /** Service / Delay / Hold / Conveyor / MoveTo — cycle in SECONDS per agent. */
  cycleS?: number;
  /** SelectOutput — probability 0..1 that an agent leaves on the `pass` port. */
  passProb?: number;
  /** ResourcePool — capacity in units (operators / mechanics). */
  capacity?: number;
  /** Queue — max length, 0 = unbounded. (Wired in turn 3 with back-pressure.) */
  queueCapacity?: number;
  /** Batch — collect N agents into one batched agent on the output port.
   *  Pieces are summed onto the batched agent. Default 10. */
  batchSize?: number;
  /** Source — pieces carried by each generated agent. Models the apparel
   *  case where one cut stroke produces N panels in a single emission.
   *  Default 1. */
  piecesPerAgent?: number;
  /** Service — number of parallel servers (machines) at this station.
   *  An apparel sewing station typically has one machine and therefore
   *  one server; doubling-up at a bottleneck means servers = 2. Caps
   *  parallelism even when the dept's ResourcePool has spare units.
   *  Default 1. */
  servers?: number;
  /**
   * Service / Delay / Hold / Conveyor / MoveTo — per-agent cycle time
   * distribution in **MINUTES**. When set, the engine draws a fresh sample
   * for each agent instead of using the deterministic `cycleS`.
   *
   * Adopted from AnyLogic Process Modeling Library Service block, which
   * defaults to `triangular(0.5, 1, 1.5)`. Set in the reference-twin
   * builder from the paper's fitted distribution (StatFit notes on each
   * operation — see `parseStatfitDist`).
   *
   * The schema lives at the `params` level so it round-trips through the
   * project JSON without a separate migration.
   */
  cycleDist?: import('../simulation/distributions').ServiceDist;
  /**
   * Source — inter-arrival time distribution in **MINUTES**. When set the
   * engine draws each gap from this distribution; otherwise it falls back
   * to a constant interval of `60 / sourceRatePerHr` minutes.
   *
   * AnyLogic's Source defaults to exponential (Poisson arrivals); the
   * reference-twin builder picks `exp(60 / rate)` automatically when the
   * paper does not specify otherwise.
   */
  arrivalDist?: import('../simulation/distributions').ServiceDist;
}

/**
 * Per-workstation override of the catalog-default PML block. When present,
 * its `kind` short-circuits inference, any provided `inputs` / `outputs`
 * replace the library defaults for that block, and `params` carry the
 * authored simulation parameters.
 *
 * Stored on Workstation under `block` — see `domain/twin.ts`.
 */
export interface PmlBlockOverride {
  kind: PmlBlockKind;
  inputs?: PmlPort[];
  outputs?: PmlPort[];
  params?: PmlBlockParams;
  /** Free-form position on the PROCESS canvas, in SVG pixels. Independent
   *  of `workstation.position` (which is iso-world cells). Absent → the
   *  process canvas auto-lays out by department swim-lane. Authored by
   *  free-form drag in the process view. Phase 2. */
  processPos?: { x: number; y: number };
}

/** Minimal structural shape `getBlockSpec` reads. Workstation satisfies it
 *  by virtue of having `catalogId` + the optional `block` field. Defining
 *  it here keeps `pml.ts` free of any twin-module imports — twin.ts can
 *  import from pml.ts without creating a cycle. */
export interface BlockSubject {
  catalogId: string;
  block?: PmlBlockOverride;
}

/** The runtime shape of the PML block attached to a workstation. */
export interface PmlBlock {
  kind: PmlBlockKind;
  spec: PmlBlockSpec;
  inputs: PmlPort[];
  outputs: PmlPort[];
  /** True when the user has set an explicit `block` override on this
   *  workstation; false when the kind was inferred from the catalog. */
  overridden: boolean;
}

/**
 * Resolve a workstation-shaped subject to its PML block spec.
 *
 *   1. If `subject.block.kind` is set — use it (authored override).
 *   2. Otherwise infer from `subject.catalogId`.
 *
 * Port lists honour the override too: an authored `block.inputs` /
 * `block.outputs` array fully replaces the library defaults for that
 * block. Omit them to fall back to the library spec.
 */
export function getBlockSpec(subject: BlockSubject): PmlBlock {
  const overridden = subject.block?.kind != null;
  const kind = subject.block?.kind ?? inferBlockKindFromCatalog(subject.catalogId);
  const spec = PML_BLOCK_LIBRARY[kind];
  return {
    kind,
    spec,
    inputs: subject.block?.inputs ?? spec.inputs,
    outputs: subject.block?.outputs ?? spec.outputs,
    overridden,
  };
}

/** Convenience: resolve just the kind, honouring the override. */
export function getBlockKind(subject: BlockSubject): PmlBlockKind {
  return subject.block?.kind ?? inferBlockKindFromCatalog(subject.catalogId);
}

/**
 * Apparel-flavoured display label for a block on a workstation. Catalog-id
 * driven so the apparel context (e.g. "Iron op" vs "Sewing op") survives
 * even after the user overrides the block kind. Falls back to the apparel
 * preset label for the block's PML kind so a BLOCKS-palette drop reads
 * "Bundle source" / "Operation station" / etc. — matching the palette
 * vocabulary — even when no catalog-specific override matches.
 */
export function apparelRoleFor(subject: BlockSubject): string {
  switch (subject.catalogId) {
    case 'a_inspect_table': return '4-point inspect';
    case 'fx_qctab':        return 'QC audit';
    case 'a_iron_inline':   return 'Iron op';
    case 'fx_press':        return 'Press op';
    case 'fx_pack':         return 'Pack op';
    case 'a_cut_table':     return 'Cut → bundle';
    case 'a_wip_rack':      return 'WIP rack';
    case 'a_fabric_rack':   return 'Fabric rack';
    case 'a_bundle_trolley':return 'Bundle trolley';
    case 'buf_in':          return 'Inbound buffer';
    case 'buf_out':         return 'Outbound buffer';
    case 'mh_forklift':     return 'Forklift';
    case 'mh_agv':          return 'AGV';
    case 'op_sewer':        return 'Sewer pool';
    case 'op_cutter':       return 'Cutter pool';
    case 'op_qc':           return 'QC pool';
    case 'op_helper':       return 'Helper pool';
    case 'op_super':        return 'Supervisor';
  }
  return apparelLabelForKind(getBlockKind(subject));
}

// ============================================================================
// PALETTE FIXTURE BRIDGE
// ============================================================================
//
// Pure PML primitives are exposed as a *category* in the iso fixture catalog
// (`cat: 'pml'`, ids of the form `pml_<kind>`). Dropping one onto the canvas
// creates a workstation whose `block.kind` is auto-stamped from the fixture
// id — so the user never has to round-trip through the Inspector dropdown
// to author a Source / Queue / SelectOutput / etc.

/** Stable iso-fixture id for a PML block kind. e.g. Source → `pml_source`. */
export function pmlFixtureId(kind: PmlBlockKind): string {
  return 'pml_' + kind.toLowerCase();
}

/** Reverse lookup — `pml_source` → `'Source'`. Returns null for non-PML
 *  catalog ids so callers can early-out. */
export function pmlKindFromFixtureId(catalogId: string): PmlBlockKind | null {
  if (!catalogId.startsWith('pml_')) return null;
  const tail = catalogId.slice(4);
  // Match against the library's keys case-insensitively.
  for (const k of Object.keys(PML_BLOCK_LIBRARY) as PmlBlockKind[]) {
    if (k.toLowerCase() === tail) return k;
  }
  return null;
}

// ============================================================================
// PARAMETER RESOLUTION
// ============================================================================
//
// Each Tier-1 block type has 0–2 authored parameters. Resolution order is:
//   1. `subject.block.params.<field>`         — explicitly authored
//   2. one or more fixture-prop fallbacks      — backwards-compat heuristic
//   3. a hard-coded default                    — gets the sim running
// `getBlockParams()` returns a fully-resolved record so the engine and
// Inspector both read from a single source of truth.

export interface ResolvedBlockParams {
  /** Source: agents per hour. */
  sourceRatePerHr: number;
  /** Service / Delay / Conveyor / Hold / MoveTo: cycle in SECONDS per agent. */
  cycleS: number;
  /** SelectOutput pass probability 0..1. */
  passProb: number;
  /** ResourcePool capacity in units. */
  capacity: number;
  /** Queue max length, 0 = unbounded. */
  queueCapacity: number;
  /** Batch — agents to collect before emitting one bundled agent. */
  batchSize: number;
  /** Source — pieces per generated agent. */
  piecesPerAgent: number;
  /** Service — parallel-server cap at the station. Default 1. */
  servers: number;
  /** Service / Delay / Hold / Conveyor / MoveTo — per-agent cycle distribution
   *  in MINUTES. Undefined ⇒ engine uses the deterministic `cycleS`. */
  cycleDist: import('../simulation/distributions').ServiceDist | undefined;
  /** Source — inter-arrival distribution in MINUTES. Undefined ⇒ engine
   *  uses a constant interval of `60 / sourceRatePerHr` minutes. */
  arrivalDist: import('../simulation/distributions').ServiceDist | undefined;
}

function numProp(props: Record<string, unknown> | undefined, key: string): number | null {
  const v = props?.[key];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * Resolve all sim-relevant parameters for a block subject. Honours the
 * authored override first, then the fixture's catalog props, then a
 * sensible hard-coded default. Always returns a fully-populated record;
 * callers only read the fields their block kind cares about.
 */
export function getBlockParams(
  subject: BlockSubject & { props?: Record<string, unknown> },
): ResolvedBlockParams {
  const p = subject.block?.params ?? {};
  const fx = subject.props ?? {};

  // Source rate — explicit > catalog capacity_per_hr > 60/hr default.
  const sourceRatePerHr =
    p.sourceRatePerHr ??
    numProp(fx, 'capacity_per_hr') ??
    60;

  // Cycle — explicit cycleS > catalog cycle_s > derive from capacity_per_hr
  // > hard default 30s.
  let cycleS = p.cycleS ?? numProp(fx, 'cycle_s');
  if (cycleS === null) {
    const capPerHr = numProp(fx, 'capacity_per_hr');
    cycleS = capPerHr && capPerHr > 0 ? 3600 / capPerHr : null;
  }
  if (cycleS === null || cycleS <= 0) cycleS = 30;

  // Pass probability — explicit > 0.95 default.
  let passProb = p.passProb ?? 0.95;
  passProb = Math.max(0, Math.min(1, passProb));

  // Resource capacity — explicit > catalog capacity > 1.
  const capacity = Math.max(1, Math.round(p.capacity ?? numProp(fx, 'capacity') ?? 1));

  const queueCapacity = Math.max(0, Math.round(p.queueCapacity ?? 0));

  // Batch size — explicit > default 10. Always at least 1 (1 = pass-through).
  const batchSize = Math.max(1, Math.round(p.batchSize ?? 10));

  // Pieces per Source-generated agent — explicit > default 1.
  const piecesPerAgent = Math.max(1, Math.round(p.piecesPerAgent ?? 1));

  // Parallel-server cap for Service blocks. Stations are single-server by
  // default (one machine per workstation); reinforced stations bump this.
  const servers = Math.max(1, Math.round(p.servers ?? numProp(fx, 'servers') ?? 1));

  // Pass-through optional distribution overrides. The engine reads these
  // when sampling per-agent cycle / inter-arrival times. Falls back to
  // the deterministic value when absent.
  const cycleDist = p.cycleDist;
  const arrivalDist = p.arrivalDist;

  return {
    sourceRatePerHr,
    cycleS,
    passProb,
    capacity,
    queueCapacity,
    batchSize,
    piecesPerAgent,
    servers,
    cycleDist,
    arrivalDist,
  };
}

/**
 * Which authored param fields are meaningful for a given block kind.
 * Drives the Inspector's per-kind authoring section — the UI iterates
 * this array to render only the relevant inputs.
 */
export type ParamFieldId = keyof PmlBlockParams;

export interface ParamFieldSpec {
  id: ParamFieldId;
  label: string;
  /** Suffix shown after the input (e.g. "/hr", "s", "%"). */
  unit: string;
  /** Step for the number input. */
  step: number;
  /** One-line hint shown under the input. */
  hint: string;
  /** Resolves the live default value to seed the input when no override is set. */
  resolveDefault: (resolved: ResolvedBlockParams) => number;
}

const FIELD_SOURCE_RATE: ParamFieldSpec = {
  id: 'sourceRatePerHr',
  label: 'Rate',
  unit: '/hr',
  step: 1,
  hint: 'Agents generated per hour. e.g. 60 = one bundle every minute.',
  resolveDefault: (r) => r.sourceRatePerHr,
};

const FIELD_CYCLE_S: ParamFieldSpec = {
  id: 'cycleS',
  label: 'Cycle',
  unit: 's',
  step: 1,
  hint: 'Seconds per agent. Sets the per-server processing time.',
  resolveDefault: (r) => r.cycleS,
};

const FIELD_PASS_PROB: ParamFieldSpec = {
  id: 'passProb',
  label: 'Pass',
  unit: '%',
  step: 0.5,
  hint: 'Percentage of agents routed to the pass port. The rest go to fail.',
  resolveDefault: (r) => Math.round(r.passProb * 1000) / 10,
};

const FIELD_CAPACITY: ParamFieldSpec = {
  id: 'capacity',
  label: 'Capacity',
  unit: ' units',
  step: 1,
  hint: 'How many concurrent units this pool provides (e.g. operators).',
  resolveDefault: (r) => r.capacity,
};

const FIELD_BATCH_SIZE: ParamFieldSpec = {
  id: 'batchSize',
  label: 'Batch size',
  unit: ' agents',
  step: 1,
  hint: 'Collect this many agents before emitting one bundled agent.',
  resolveDefault: (r) => r.batchSize,
};

const FIELD_PIECES_PER_AGENT: ParamFieldSpec = {
  id: 'piecesPerAgent',
  label: 'Pieces / agent',
  unit: '',
  step: 1,
  hint: 'Pieces carried by each emission. e.g. 50 = one cut → fifty panels.',
  resolveDefault: (r) => r.piecesPerAgent,
};

/**
 * Parallel servers c at a station.
 *
 * The engine and the analytical layer have always read this (via `serversFor`),
 * but it was absent from the Inspector, so the only way to change c was to edit
 * the shared garment operation — which retuned every station running that
 * operation. On a balanced line that is most of the floor.
 */
const FIELD_SERVERS: ParamFieldSpec = {
  id: 'servers',
  label: 'Servers (c)',
  unit: '',
  step: 1,
  hint:
    'Operators or machines working this station in parallel. c = 2 means two '
    + 'people doing the same operation side by side, which halves the queue but '
    + 'costs an operator. Overrides the garment operation for THIS station only.',
  resolveDefault: (r) => r.servers,
};

/**
 * System capacity N — the M/M/c/N knob.
 *
 * Physically this is how much WIP can sit at a station: the cart, the rack, the
 * hanger rail. Capping it is how a real floor stops a bottleneck from
 * accumulating a mountain of bundles, and the engine models the consequence
 * honestly — arrivals that find it full are turned away and counted.
 */
const FIELD_QUEUE_CAPACITY: ParamFieldSpec = {
  id: 'queueCapacity',
  label: 'Buffer (N)',
  unit: ' max at station',
  step: 1,
  hint:
    'Most bundles allowed at this station at once, waiting plus in service — '
    + 'the cart or rack size. 0 = unbounded (M/M/c). Any positive value makes '
    + 'it M/M/c/N: arrivals that find it full are turned away and counted as '
    + 'balks, and the upstream station blocks rather than piling up. Note that '
    + 'rework re-entry bypasses this cap.',
  resolveDefault: (r) => r.queueCapacity,
};

/** Per-kind list of authored fields, in the order the Inspector renders. */
export const PARAM_FIELDS_BY_KIND: Partial<Record<PmlBlockKind, ParamFieldSpec[]>> = {
  Source: [FIELD_SOURCE_RATE, FIELD_PIECES_PER_AGENT],
  Service: [FIELD_CYCLE_S, FIELD_SERVERS, FIELD_QUEUE_CAPACITY],
  // A Queue has no servers, but it does have a capacity, and the engine
  // enforces it (`canAcceptAt`). It previously had no fields at all.
  Queue: [FIELD_QUEUE_CAPACITY],
  Delay: [FIELD_CYCLE_S],
  Hold: [FIELD_CYCLE_S],
  Conveyor: [FIELD_CYCLE_S],
  MoveTo: [FIELD_CYCLE_S],
  SelectOutput: [FIELD_PASS_PROB],
  ResourcePool: [FIELD_CAPACITY],
  Batch: [FIELD_BATCH_SIZE],
};

/** Allowed kinds to expose in the Inspector dropdown — order matters; this
 *  is the same order the user will scan through. */
export const SELECTABLE_BLOCK_KINDS: PmlBlockKind[] = [
  'Source',
  'Queue',
  'Delay',
  'Hold',
  'Wait',
  'Service',
  'Seize',
  'Release',
  'ResourcePool',
  'SelectOutput',
  'SelectOutput5',
  'Batch',
  'Unbatch',
  'Combine',
  'Match',
  'Assembler',
  'Split',
  'MoveTo',
  'Conveyor',
  'Sink',
];
