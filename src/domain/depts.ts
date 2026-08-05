/**
 * Department-interior domain — machine catalogue, sub-operations, and the
 * floor-plan registry consumed by the level-2 (DeptInterior) and level-3
 * (WorkstationDetail) drill-down screens.
 *
 * Ported verbatim from .design-import/sw/sw-screens-dept.jsx (top of file:
 * SW_MACHINE_CATALOG, SW_SUBOPS, SW_DEPARTMENTS).
 *
 * Renamed to DEPT_* to coexist with the legacy `machines.ts` catalogue —
 * the apparel-IE catalog there uses different codes (SNL, 4OL, …) and a
 * different shape; these depts catalogue items use the cycleS / costHr /
 * power shape the dept screen expects.
 */
import { SW_COLORS } from '../design/tokens';

// ============================================================================
// Machine catalogue
// ============================================================================
export type DeptMachineCategory = 'spread' | 'cut' | 'sew' | 'qc' | 'press';

export type DeptMachineId =
  | 'spread_table'
  | 'auto_spreader'
  | 'cut_table'
  | 'straight_knife'
  | 'band_knife'
  | 'cnc_cutter'
  | 'ssm'
  | 'overlock'
  | 'flatlock'
  | 'bartack'
  | 'buttonhole'
  | 'buttonsew'
  | 'feed_off_arm'
  | 'qc_table'
  | 'metal_detect'
  | 'press_table'
  | 'steam_iron';

/** Friendly aliases for the brief's requested names. */
export type MachineId = DeptMachineId;

export interface DeptMachineSpec {
  id: DeptMachineId;
  label: string;
  icon: string;
  cat: DeptMachineCategory;
  /** [min, max] cycle time in seconds. */
  cycleS: [number, number];
}

/** Friendly alias for the brief's requested name. */
export type MachineSpec = DeptMachineSpec;

export const DEPT_MACHINE_CATALOG: Record<DeptMachineId, DeptMachineSpec> = {
  // Spreading
  spread_table:   { id:'spread_table',   label:'Spread Table',        icon:'≡', cat:'spread', cycleS:[35,75] },
  auto_spreader:  { id:'auto_spreader',  label:'Auto Spreader',       icon:'⇉', cat:'spread', cycleS:[18,30] },
  // Cutting
  cut_table:      { id:'cut_table',      label:'Cutting Table',       icon:'─', cat:'cut',    cycleS:[40,90] },
  straight_knife: { id:'straight_knife', label:'Straight Knife',      icon:'⫻', cat:'cut',    cycleS:[40,80] },
  band_knife:     { id:'band_knife',     label:'Band Knife',          icon:'⋮', cat:'cut',    cycleS:[30,55] },
  cnc_cutter:     { id:'cnc_cutter',     label:'CNC Auto Cutter',     icon:'◇', cat:'cut',    cycleS:[12,22] },
  // Sewing
  ssm:            { id:'ssm',            label:'Single-Needle Lock',  icon:'⌃', cat:'sew',    cycleS:[20,50] },
  overlock:       { id:'overlock',       label:'4-Thread Overlock',   icon:'⤴', cat:'sew',    cycleS:[18,36] },
  flatlock:       { id:'flatlock',       label:'Flatlock',            icon:'≣', cat:'sew',    cycleS:[22,40] },
  bartack:        { id:'bartack',        label:'Bartack',             icon:'∥', cat:'sew',    cycleS:[8,16] },
  buttonhole:     { id:'buttonhole',     label:'Buttonhole',          icon:'◉', cat:'sew',    cycleS:[10,18] },
  buttonsew:      { id:'buttonsew',      label:'Button Sew',          icon:'•', cat:'sew',    cycleS:[6,12] },
  feed_off_arm:   { id:'feed_off_arm',   label:'Feed-off-the-Arm',    icon:'⌒', cat:'sew',    cycleS:[24,42] },
  // QC
  qc_table:       { id:'qc_table',       label:'QC Inspection Table', icon:'◎', cat:'qc',     cycleS:[22,40] },
  metal_detect:   { id:'metal_detect',   label:'Metal Detector',      icon:'⊜', cat:'qc',     cycleS:[5,10] },
  // Press / finishing
  press_table:    { id:'press_table',    label:'Pressing Table',      icon:'▤', cat:'press',  cycleS:[28,50] },
  steam_iron:     { id:'steam_iron',     label:'Steam Iron',          icon:'◆', cat:'press',  cycleS:[18,32] },
};

// ============================================================================
// Sub-operations per department
// ============================================================================
export type SubopId = string;

export interface Subop {
  id: SubopId;
  label: string;
  /** Required skill level 1-5. */
  skill: number;
  /** Default machine type for this sub-op. */
  mach: DeptMachineId;
}

/**
 * Sub-ops keyed by department id. The "sew_a"/"sew_b" duplication is
 * intentional and preserved verbatim from the prototype.
 */
export const DEPT_SUBOPS: Record<string, Subop[]> = {
  spread: [
    { id:'lay_fabric',   label:'Lay fabric',         skill:2, mach:'spread_table' },
    { id:'align_edges',  label:'Align edges',        skill:3, mach:'spread_table' },
    { id:'mark_plies',   label:'Mark plies',         skill:3, mach:'spread_table' },
    { id:'auto_spread',  label:'Auto spread run',    skill:2, mach:'auto_spreader' },
  ],
  cut: [
    { id:'place_marker', label:'Place marker',       skill:2, mach:'cut_table' },
    { id:'rough_cut',    label:'Rough cut',          skill:3, mach:'straight_knife' },
    { id:'finish_cut',   label:'Finish cut',         skill:4, mach:'band_knife' },
    { id:'cnc_run',      label:'CNC cut run',        skill:3, mach:'cnc_cutter' },
    { id:'bundle',       label:'Bundle pieces',      skill:1, mach:'cut_table' },
  ],
  sew_a: [
    { id:'serge_panels', label:'Serge front/back',   skill:3, mach:'overlock' },
    { id:'shoulder',     label:'Join shoulder',      skill:3, mach:'ssm' },
    { id:'attach_collar',label:'Attach collar',      skill:4, mach:'ssm' },
    { id:'set_sleeve',   label:'Set sleeve',         skill:5, mach:'ssm' },
    { id:'side_seam',    label:'Side seam',          skill:3, mach:'overlock' },
    { id:'hem_bottom',   label:'Hem bottom',         skill:3, mach:'flatlock' },
    { id:'attach_pocket',label:'Attach pocket',      skill:4, mach:'ssm' },
    { id:'buttonhole_op',label:'Buttonhole',         skill:4, mach:'buttonhole' },
    { id:'attach_button',label:'Attach button',      skill:2, mach:'buttonsew' },
    { id:'bartack_op',   label:'Bartack stress pts', skill:3, mach:'bartack' },
  ],
  sew_b: [
    { id:'serge_panels', label:'Serge front/back',   skill:3, mach:'overlock' },
    { id:'shoulder',     label:'Join shoulder',      skill:3, mach:'ssm' },
    { id:'attach_collar',label:'Attach collar',      skill:4, mach:'ssm' },
    { id:'set_sleeve',   label:'Set sleeve',         skill:5, mach:'ssm' },
    { id:'side_seam',    label:'Side seam',          skill:3, mach:'overlock' },
    { id:'hem_bottom',   label:'Hem bottom',         skill:3, mach:'flatlock' },
    { id:'attach_pocket',label:'Attach pocket',      skill:4, mach:'ssm' },
    { id:'buttonhole_op',label:'Buttonhole',         skill:4, mach:'buttonhole' },
    { id:'attach_button',label:'Attach button',      skill:2, mach:'buttonsew' },
  ],
  qc: [
    { id:'visual_inspect',label:'Visual inspect',    skill:3, mach:'qc_table' },
    { id:'measure_check', label:'Measure check',     skill:4, mach:'qc_table' },
    { id:'metal_scan',    label:'Metal scan',        skill:1, mach:'metal_detect' },
    { id:'tag_pack',      label:'Tag & flag',        skill:2, mach:'qc_table' },
  ],
};

// ============================================================================
// Department registry
// ============================================================================
export type DeptId =
  | 'spread'
  | 'cut'
  | 'sew_a'
  | 'sew_b'
  | 'qc'
  | 'fabric'
  | 'bundle'
  | 'press'
  | 'pack'
  | 'dispatch';

export interface Dept {
  id: DeptId;
  label: string;
  /** Background tint for plan view (hero depts only). */
  color?: string;
  /** Outline / accent stroke. */
  stroke: string;
  /** Floor-plan grid size for the interior layout. */
  grid?: { w: number; h: number };
  /** Hero depts have a fully built interior; others render a stub. */
  hero: boolean;
}

/**
 * Department plates and strokes.
 *
 * Strokes are the six cool data hues from SW_COLORS (thread / fabric / bobbin /
 * press / trim / ship), written as literals rather than token reads because this
 * is a plain module-level data table — reading SW_COLORS here would capture the
 * values at import time, which is the stale-capture bug the vibe system creates.
 *
 * Two rules drive the mapping. Departments never borrow from the status ramp
 * (green/amber/red), because on the floor those mean utilisation — the old table
 * used an amber SPREADING and a red PRESSING, which is exactly that collision.
 * And no two departments adjacent in the flow share a hue, so the floor stays
 * readable; SEWING LINE A and B deliberately match, as they did before.
 *
 * `color` is the plate fill: its own hue at 14% over the dark ground, so the
 * plate tints rather than paints.
 */
export const DEPT_LAYOUT: Record<DeptId, Dept> = {
  spread: {
    id:'spread', label:'SPREADING',     color:'#12B4DC24', stroke:'#12B4DC', // fabric
    grid:{ w:18, h:10 }, hero: true,
  },
  cut: {
    id:'cut', label:'CUTTING',          color:'#20C3AC24', stroke:'#20C3AC', // thread
    grid:{ w:18, h:10 }, hero: true,
  },
  sew_a: {
    id:'sew_a', label:'SEWING LINE A',  color:'#5AA2F024', stroke:'#5AA2F0', // bobbin
    grid:{ w:24, h:12 }, hero: true,
  },
  sew_b: {
    id:'sew_b', label:'SEWING LINE B',  color:'#5AA2F024', stroke:'#5AA2F0', // bobbin
    grid:{ w:24, h:12 }, hero: true,
  },
  qc: {
    id:'qc', label:'INLINE QC',         color:'#8E93F224', stroke:'#8E93F2', // press
    grid:{ w:14, h:8 }, hero: true,
  },
  // Non-hero — stubs
  fabric:   { id:'fabric',   label:'FABRIC RECEIVING', stroke:'#C685E4', hero:false }, // trim
  bundle:   { id:'bundle',   label:'BUNDLING',         stroke:'#C685E4', hero:false }, // trim
  press:    { id:'press',    label:'PRESSING',         stroke:'#F27FA8', hero:false }, // ship
  pack:     { id:'pack',     label:'PACKING',          stroke:'#C685E4', hero:false }, // trim
  dispatch: { id:'dispatch', label:'DISPATCH',         stroke:'#12B4DC', hero:false }, // fabric
};

// Mark SW_COLORS as a dependency to keep the import alive when the
// catalogue grows palette-driven members later. (No-op for tree-shaking.)
void SW_COLORS;
