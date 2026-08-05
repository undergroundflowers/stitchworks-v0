/**
 * Worker archetypes — the canonical roles you find on an apparel shop floor.
 * Stitchworks ships with this set so a project starts with sensible defaults;
 * actual operators are instances of an archetype with concrete names and
 * shifts (modelled separately at the project level).
 */

import { SW_COLORS } from '../design/tokens';

export type WorkerRole =
  | 'sew_op'           // Sewing machine operator (the most common role)
  | 'helper'           // Sewing helper / floater (assists, no own machine)
  | 'cutter'           // Cutting room operator (knife / CAD)
  | 'spreader'         // Lays fabric on the spreading table
  | 'bundler'          // Tickets and bundles cut pieces
  | 'fuser'            // Operates the fusing press
  | 'embroidery_op'    // Embroidery machine operator
  | 'qc_inline'        // In-line quality inspector (between operations)
  | 'qc_final'         // Final / end-of-line quality inspector
  | 'presser'          // Iron / press station operator
  | 'packer'           // Folds, polybags, cartons
  | 'material_handler' // Moves bundles, trolleys, racks between zones
  | 'supervisor'       // Line supervisor / floor in-charge
  | 'merchandiser';    // Order coordination (planning role; not on floor)

/** Skill tags. An operator's skill set is a subset of these; an operation
 *  declares the skill it requires. Used for assignment + roster validation. */
export type SkillId =
  | 'stitching'        // Generic SNL/DNL sewing
  | 'overlock'         // 4OL/5OL operation
  | 'flatlock'         // FL / coverstitch
  | 'kansai'           // Multi-needle chain stitch
  | 'feed_of_arm'      // Tubular sewing
  | 'buttonhole'       // BH machine
  | 'button_sew'       // BS machine
  | 'bartack'          // BT machine
  | 'embroidery'
  | 'cutting_manual'
  | 'cutting_cad'
  | 'spreading'
  | 'fusing'
  | 'pressing'
  | 'inspection'
  | 'packing'
  | 'bundling'
  | 'material_handling'
  | 'supervision';

export interface WorkerArchetype {
  role: WorkerRole;
  label: string;
  /** Single-line "what does this person do" copy. */
  description: string;
  icon: string;
  color: string;
  /** Skills the role is hired for from day 1. */
  primarySkills: SkillId[];
  /** Skills they typically pick up after training; bumps assignment options. */
  secondarySkills?: SkillId[];
  /** Fraction of standard performance from a fully-trained operator. 1.0 = on standard. */
  baseEfficiency: number;
  /** Walking speed in m/s when moving between zones. */
  walkSpeedMps: number;
  /** Whether this role typically owns a machine (and thus a workstation). */
  ownsStation: boolean;
}

export const WORKER_ARCHETYPES: Record<WorkerRole, WorkerArchetype> = {
  sew_op: {
    role: 'sew_op', label: 'Sewing Operator',
    description: 'Owns and operates one machine; performs one or more sewing operations.',
    icon: '⌃', color: SW_COLORS.brand,
    primarySkills: ['stitching'],
    secondarySkills: ['overlock', 'flatlock'],
    baseEfficiency: 0.85, walkSpeedMps: 1.0, ownsStation: true,
  },
  helper: {
    role: 'helper', label: 'Helper',
    description: 'Floater. Trims threads, marks, transfers bundles, fills in for absences.',
    icon: '✋', color: SW_COLORS.muted,
    primarySkills: ['bundling'], secondarySkills: ['stitching', 'pressing'],
    baseEfficiency: 0.7, walkSpeedMps: 1.1, ownsStation: false,
  },
  cutter: {
    role: 'cutter', label: 'Cutter',
    description: 'Cutting room operator. Hand knife or CAD cutter.',
    icon: '✂', color: SW_COLORS.press,
    primarySkills: ['cutting_manual'], secondarySkills: ['cutting_cad', 'spreading'],
    baseEfficiency: 0.9, walkSpeedMps: 1.0, ownsStation: true,
  },
  spreader: {
    role: 'spreader', label: 'Spreader',
    description: 'Lays fabric layers on the spreading table for cutting.',
    icon: '≡', color: SW_COLORS.fabric,
    primarySkills: ['spreading'],
    baseEfficiency: 0.85, walkSpeedMps: 1.0, ownsStation: true,
  },
  bundler: {
    role: 'bundler', label: 'Bundler',
    description: 'Tickets cut pieces, ties bundles, hand-off to sewing input.',
    icon: '◫', color: SW_COLORS.trim,
    primarySkills: ['bundling'],
    baseEfficiency: 0.9, walkSpeedMps: 1.1, ownsStation: false,
  },
  fuser: {
    role: 'fuser', label: 'Fusing Operator',
    description: 'Runs the fusing press. Sub-assembly of collars / cuffs / plackets.',
    icon: '▦', color: SW_COLORS.press,
    primarySkills: ['fusing'],
    baseEfficiency: 0.85, walkSpeedMps: 1.0, ownsStation: true,
  },
  embroidery_op: {
    role: 'embroidery_op', label: 'Embroidery Operator',
    description: 'Loads and runs embroidery machines. Watches for thread breaks.',
    icon: '✿', color: SW_COLORS.trim,
    primarySkills: ['embroidery'],
    baseEfficiency: 0.9, walkSpeedMps: 1.0, ownsStation: true,
  },
  qc_inline: {
    role: 'qc_inline', label: 'In-line QC Inspector',
    description: 'Checks bundles between operations, flags issues mid-line.',
    icon: '◎', color: SW_COLORS.alarm,
    primarySkills: ['inspection'],
    baseEfficiency: 0.9, walkSpeedMps: 1.2, ownsStation: false,
  },
  qc_final: {
    role: 'qc_final', label: 'Final QC Inspector',
    description: 'Final inspection station. AQL sampling, decides accept / reject / rework.',
    icon: '◉', color: SW_COLORS.alarm,
    primarySkills: ['inspection'],
    baseEfficiency: 0.9, walkSpeedMps: 1.0, ownsStation: true,
  },
  presser: {
    role: 'presser', label: 'Presser',
    description: 'Iron station operator. Inter-process press and final pressing.',
    icon: '▤', color: SW_COLORS.thread,
    primarySkills: ['pressing'],
    baseEfficiency: 0.85, walkSpeedMps: 1.0, ownsStation: true,
  },
  packer: {
    role: 'packer', label: 'Packer',
    description: 'Folds, poly-bags, cartons. End of finishing room.',
    icon: '▣', color: SW_COLORS.ship,
    primarySkills: ['packing'],
    baseEfficiency: 0.85, walkSpeedMps: 1.0, ownsStation: true,
  },
  material_handler: {
    role: 'material_handler', label: 'Material Handler',
    description: 'Moves trolleys / bundles / racks between zones; the connective tissue.',
    icon: '⏍', color: SW_COLORS.brand,
    primarySkills: ['material_handling'],
    baseEfficiency: 0.9, walkSpeedMps: 1.4, ownsStation: false,
  },
  supervisor: {
    role: 'supervisor', label: 'Line Supervisor',
    description: 'Owns one or more lines: pace, balance, escalations.',
    icon: '⚐', color: SW_COLORS.ink,
    primarySkills: ['supervision'],
    baseEfficiency: 1.0, walkSpeedMps: 1.3, ownsStation: false,
  },
  merchandiser: {
    role: 'merchandiser', label: 'Merchandiser',
    description: 'Order coordination, buyer comms — planning role, not on floor.',
    icon: '✎', color: SW_COLORS.bobbin,
    primarySkills: [],
    baseEfficiency: 1.0, walkSpeedMps: 1.0, ownsStation: false,
  },
};

export const ALL_WORKER_ARCHETYPES: WorkerArchetype[] = Object.values(WORKER_ARCHETYPES);

/** Map an industry machine code to the worker role that typically owns it. */
import type { MachineCode } from './machines';
export const MACHINE_TO_ROLE: Record<MachineCode, WorkerRole> = {
  SNL: 'sew_op', DNL: 'sew_op', '4OL': 'sew_op', '5OL': 'sew_op',
  FL: 'sew_op', FB: 'sew_op', KS: 'sew_op',
  BH: 'sew_op', BS: 'sew_op', BT: 'sew_op',
  EMB: 'embroidery_op',
  CUT: 'cutter', CAD: 'cutter', SPR: 'spreader',
  FUSE: 'fuser',
  PRESS: 'presser', STEAM: 'presser',
  INSP: 'qc_final',
  MNL: 'helper',
};
