/**
 * Apparel Palette Library — Stitchworks' answer to the AnyLogic
 * Process Modeling Library, but specialised for the apparel shop floor.
 *
 * Where AnyLogic offers generic blocks (Source / Service / Delay / Seize /
 * Release / ResourcePool), Stitchworks ships pre-configured apparel-domain
 * blocks (FabricArrival / SewingStation / OperatorPool / Trolley / Buffer)
 * that already understand SMVs, machine codes, garment templates and
 * production systems. The user drops them onto the floor; the model is
 * already half-correct.
 *
 * Categories (mirror AnyLogic's taxonomy):
 *   - flow:      sources and sinks of garment bundles (entities entering/leaving)
 *   - station:   operations that consume time and resources
 *   - resource:  pools of operators / machines / handlers
 *   - transport: bundle-moving infrastructure (trolleys, racks, conveyors)
 *   - control:   buffers, decisions, merges, splits
 *   - quality:   inspection & rework loops (apparel-specific extension)
 *   - layout:    fixed structural elements (zones, paths, dock)
 */

import { SW_COLORS } from '../design/tokens';

export type PaletteCategory =
  | 'flow'
  | 'station'
  | 'resource'
  | 'transport'
  | 'control'
  | 'quality'
  | 'layout';

export interface PaletteElement {
  /** Unique within the palette. Stable id used by the model file format. */
  id: string;
  category: PaletteCategory;
  label: string;
  /** Compact name for chips and palette tiles. */
  shortName?: string;
  /** Glyph used as the visual on the palette tile. */
  icon: string;
  color: string;
  /** What this block does, in a sentence. */
  description: string;
  /** Closest AnyLogic Process Modeling Library block, for cross-reference. */
  anyLogicEquivalent?: string;
  /** Default property values when the user drops this onto the floor. */
  defaultProps: Record<string, unknown>;
}

export const APPAREL_PALETTE: PaletteElement[] = [
  // ── flow ────────────────────────────────────────────────────────────────
  {
    id: 'fabric_arrival', category: 'flow', label: 'Fabric Arrival', shortName: 'Fabric In',
    icon: '📥', color: SW_COLORS.fabric, anyLogicEquivalent: 'Source',
    description: 'Roll-in of raw fabric. Generates fabric-roll entities at a configurable rate.',
    defaultProps: { ratePerHour: 50, unit: 'kg', deliverySchedule: 'daily' },
  },
  {
    id: 'order_input', category: 'flow', label: 'Order Input', shortName: 'Order',
    icon: '📋', color: SW_COLORS.brand, anyLogicEquivalent: 'Source',
    description: 'Dispatches garment bundles into the factory based on an order quantity & deadline.',
    defaultProps: { qty: 1000, deadlineDays: 5, garmentTemplate: 'tshirt', bundleSize: 30 },
  },
  {
    id: 'dispatch', category: 'flow', label: 'Dispatch', shortName: 'Out',
    icon: '🚚', color: SW_COLORS.ship, anyLogicEquivalent: 'Sink',
    description: 'Finished, packed cartons leaving the factory. Records lead time & throughput.',
    defaultProps: { dockCount: 2 },
  },

  // ── station ─────────────────────────────────────────────────────────────
  {
    id: 'spreading_table', category: 'station', label: 'Spreading Table', shortName: 'Spread',
    icon: '≡', color: SW_COLORS.fabric, anyLogicEquivalent: 'Service',
    description: 'Lays fabric layers prior to cutting. Capacity in layers; SMV per layer.',
    defaultProps: { machine: 'SPR', smv: 0.6, layersPerSpread: 60, capacity: 1 },
  },
  {
    id: 'cutting_station', category: 'station', label: 'Cutting Station', shortName: 'Cut',
    icon: '✂', color: SW_COLORS.press, anyLogicEquivalent: 'Service',
    description: 'Cuts pattern pieces from a spread. Manual knife or CAD auto.',
    defaultProps: { machine: 'CUT', smv: 0.8, capacity: 1 },
  },
  {
    id: 'fusing_press', category: 'station', label: 'Fusing Press', shortName: 'Fuse',
    icon: '▦', color: SW_COLORS.press, anyLogicEquivalent: 'Service',
    description: 'Heat-fuses interlining onto cut pieces. Continuous-feed.',
    defaultProps: { machine: 'FUSE', smv: 0.4, capacity: 1, batchSize: 20 },
  },
  {
    id: 'sewing_station', category: 'station', label: 'Sewing Station', shortName: 'Sew',
    icon: '⌃', color: SW_COLORS.brand, anyLogicEquivalent: 'Service',
    description: 'A single sewing operation seat: machine + operator + WIP tray. Pick the operation it runs.',
    defaultProps: { operationId: null, machine: 'SNL', capacity: 1 },
  },
  {
    id: 'embroidery_station', category: 'station', label: 'Embroidery Station', shortName: 'EMB',
    icon: '✿', color: SW_COLORS.trim, anyLogicEquivalent: 'Service',
    description: 'Embroidery machine. Long SMV per piece; runs while operator monitors.',
    defaultProps: { machine: 'EMB', smv: 2.0, headsPerMachine: 6 },
  },
  {
    id: 'pressing_station', category: 'station', label: 'Pressing Station', shortName: 'Press',
    icon: '▭', color: SW_COLORS.thread, anyLogicEquivalent: 'Service',
    description: 'Iron / press station. Inter-process and final pressing.',
    defaultProps: { machine: 'PRESS', smv: 0.6, capacity: 1 },
  },
  {
    id: 'wash_station', category: 'station', label: 'Wash / Dye', shortName: 'Wash',
    icon: '◐', color: SW_COLORS.bobbin, anyLogicEquivalent: 'Service',
    description: 'Wet-processing batch station. Long cycle, large batch — radically reshapes WIP.',
    defaultProps: { smv: 8.0, batchSize: 40, capacity: 1 },
  },
  {
    id: 'packing_station', category: 'station', label: 'Packing Station', shortName: 'Pack',
    icon: '□', color: SW_COLORS.ship, anyLogicEquivalent: 'Service',
    description: 'Final fold + poly-bag + carton.',
    defaultProps: { machine: 'MNL', smv: 0.7, capacity: 1 },
  },

  // ── resource ────────────────────────────────────────────────────────────
  {
    id: 'sewing_operator_pool', category: 'resource', label: 'Sewing Operators', shortName: 'Sew Operators',
    icon: '⌃', color: SW_COLORS.brand, anyLogicEquivalent: 'ResourcePool (Moving)',
    description: 'Pool of skilled sewing operators. Picks one when a sewing station has WIP.',
    defaultProps: { count: 25, walkSpeedMps: 1.0, primarySkill: 'stitching' },
  },
  {
    id: 'helper_pool', category: 'resource', label: 'Helpers', shortName: 'Helpers',
    icon: '✋', color: SW_COLORS.muted, anyLogicEquivalent: 'ResourcePool (Moving)',
    description: 'Floaters who trim, mark, transfer, and substitute for absent operators.',
    defaultProps: { count: 4, walkSpeedMps: 1.1 },
  },
  {
    id: 'cutter_pool', category: 'resource', label: 'Cutters', shortName: 'Cutters',
    icon: '✂', color: SW_COLORS.press, anyLogicEquivalent: 'ResourcePool',
    description: 'Cutting room operators (knife or CAD).',
    defaultProps: { count: 4 },
  },
  {
    id: 'spreader_pool', category: 'resource', label: 'Spreaders', shortName: 'Spreaders',
    icon: '≡', color: SW_COLORS.fabric, anyLogicEquivalent: 'ResourcePool',
    description: 'Lay fabric on spreading tables. Often pair-work.',
    defaultProps: { count: 3 },
  },
  {
    id: 'bundler_pool', category: 'resource', label: 'Bundlers', shortName: 'Bundlers',
    icon: '◫', color: SW_COLORS.trim, anyLogicEquivalent: 'ResourcePool',
    description: 'Tickets cut pieces, ties bundles, hand-off to sewing input.',
    defaultProps: { count: 3 },
  },
  {
    id: 'qc_pool', category: 'resource', label: 'QC Inspectors', shortName: 'QC',
    icon: '◎', color: SW_COLORS.alarm, anyLogicEquivalent: 'ResourcePool',
    description: 'In-line + final inspectors. Audit bundles, route to rework.',
    defaultProps: { count: 3, aql: 2.5 },
  },
  {
    id: 'presser_pool', category: 'resource', label: 'Pressers', shortName: 'Pressers',
    icon: '▤', color: SW_COLORS.thread, anyLogicEquivalent: 'ResourcePool',
    description: 'Pressing operators. Inter-process and final.',
    defaultProps: { count: 2 },
  },
  {
    id: 'packer_pool', category: 'resource', label: 'Packers', shortName: 'Packers',
    icon: '▣', color: SW_COLORS.ship, anyLogicEquivalent: 'ResourcePool',
    description: 'Folding and packing operators.',
    defaultProps: { count: 3 },
  },
  {
    id: 'material_handler_pool', category: 'resource', label: 'Material Handlers', shortName: 'Handlers',
    icon: '⏍', color: SW_COLORS.brand, anyLogicEquivalent: 'ResourcePool (Moving)',
    description: 'Move trolleys / bundles / racks between zones. Connective tissue.',
    defaultProps: { count: 4, walkSpeedMps: 1.4 },
  },
  {
    id: 'supervisor_pool', category: 'resource', label: 'Supervisors', shortName: 'Sup',
    icon: '⚐', color: SW_COLORS.ink, anyLogicEquivalent: 'ResourcePool',
    description: 'Line supervisors. Affect line efficiency, escalation routing.',
    defaultProps: { count: 1 },
  },

  // ── transport ───────────────────────────────────────────────────────────
  {
    id: 'trolley', category: 'transport', label: 'Trolley', shortName: 'Trolley',
    icon: '🛒', color: SW_COLORS.muted, anyLogicEquivalent: 'TransporterFleet',
    description: 'Wheeled cart carrying bundles between zones.',
    defaultProps: { count: 6, capacityBundles: 50 },
  },
  {
    id: 'wip_rack', category: 'transport', label: 'WIP Rack', shortName: 'Rack',
    icon: '▥', color: SW_COLORS.fabric, anyLogicEquivalent: 'Storage',
    description: 'Static buffer rack between zones; capacity-bounded WIP.',
    defaultProps: { capacityBundles: 200 },
  },
  {
    id: 'overhead_conveyor', category: 'transport', label: 'Overhead Conveyor', shortName: 'UPS Belt',
    icon: '═', color: SW_COLORS.bobbin, anyLogicEquivalent: 'Conveyor',
    description: 'UPS overhead conveyor. Pieces ride on hangers; system routes to next free op.',
    defaultProps: { speedMps: 0.3, hangerCount: 200 },
  },

  // ── control ─────────────────────────────────────────────────────────────
  {
    id: 'buffer', category: 'control', label: 'Buffer', shortName: 'Buffer',
    icon: '∥', color: SW_COLORS.muted, anyLogicEquivalent: 'Queue / Hold',
    description: 'WIP buffer with a queue policy (FIFO / LIFO / oldest-style first).',
    defaultProps: { capacity: 100, policy: 'FIFO' },
  },
  {
    id: 'routing_decision', category: 'control', label: 'Routing Decision', shortName: 'Route',
    icon: '◇', color: SW_COLORS.thread, anyLogicEquivalent: 'SelectOutput',
    description: 'Routes bundles by garment type, size, quality, or current load.',
    defaultProps: { rule: 'roundRobin', branches: 2 },
  },
  {
    id: 'merge', category: 'control', label: 'Merge / Combine', shortName: 'Merge',
    icon: '⩊', color: SW_COLORS.muted, anyLogicEquivalent: 'Match / Combine',
    description: 'Joins sub-assemblies (e.g. front + back panels) into a single bundle.',
    defaultProps: {},
  },
  {
    id: 'split', category: 'control', label: 'Split', shortName: 'Split',
    icon: '⩏', color: SW_COLORS.muted, anyLogicEquivalent: 'Split',
    description: 'Splits a bundle into smaller batches for parallel processing.',
    defaultProps: { partsCount: 2 },
  },

  // ── quality (apparel-specific extension) ────────────────────────────────
  {
    id: 'inline_inspection', category: 'quality', label: 'In-line Inspection', shortName: 'Inline QC',
    icon: '◎', color: SW_COLORS.alarm, anyLogicEquivalent: 'Service + SelectOutput',
    description: 'Mid-line check; routes accept ↦ next op, reject ↦ rework loop.',
    defaultProps: { smv: 0.5, reworkBranchEnabled: true },
  },
  {
    id: 'final_inspection', category: 'quality', label: 'Final Inspection (AQL)', shortName: 'Final QC',
    icon: '◉', color: SW_COLORS.alarm, anyLogicEquivalent: 'Service + Statistics',
    description: 'AQL sampling at end of finishing; pass / fail / re-inspect.',
    defaultProps: { aql: 2.5, sampleSize: 'AQL II', passActions: ['accept'] },
  },
  {
    id: 'rework_cell', category: 'quality', label: 'Rework Cell', shortName: 'Rework',
    icon: '↩', color: SW_COLORS.warn, anyLogicEquivalent: 'Service',
    description: 'Specialised station for fixing flagged pieces. Higher-skill operator.',
    defaultProps: { smv: 1.8, capacity: 2 },
  },

  // ── layout ──────────────────────────────────────────────────────────────
  {
    id: 'zone', category: 'layout', label: 'Zone', shortName: 'Zone',
    icon: '▢', color: SW_COLORS.muted, anyLogicEquivalent: 'RectangularNode',
    description: 'Logical area on the floor (Cutting / Sewing Line A / Finishing). Stations live inside zones.',
    defaultProps: { wCells: 6, hCells: 4 },
  },
  {
    id: 'path', category: 'layout', label: 'Aisle / Path', shortName: 'Path',
    icon: '╍', color: SW_COLORS.muted, anyLogicEquivalent: 'Path',
    description: 'Walkable aisle. Material handlers and operators move along paths; AnyLogic computes walking distance.',
    defaultProps: {},
  },
  {
    id: 'dock', category: 'layout', label: 'Loading Dock', shortName: 'Dock',
    icon: '🏭', color: SW_COLORS.muted, anyLogicEquivalent: 'RectangularNode',
    description: 'Inbound or outbound dock. Pairs with FabricArrival / Dispatch.',
    defaultProps: { dockType: 'in' },
  },
];

/** Look up a palette element by id. */
export const PALETTE_BY_ID: Record<string, PaletteElement> = Object.fromEntries(
  APPAREL_PALETTE.map((e) => [e.id, e]),
);

/** Filter the palette by category — convenience for the UI. */
export function paletteByCategory(category: PaletteCategory): PaletteElement[] {
  return APPAREL_PALETTE.filter((e) => e.category === category);
}

/** Ordered category list for the palette panel layout. */
export const PALETTE_CATEGORIES: { id: PaletteCategory; label: string }[] = [
  { id: 'flow',      label: 'Flow' },
  { id: 'station',   label: 'Stations' },
  { id: 'resource',  label: 'Resources' },
  { id: 'transport', label: 'Transport' },
  { id: 'control',   label: 'Control' },
  { id: 'quality',   label: 'Quality' },
  { id: 'layout',    label: 'Layout' },
];
