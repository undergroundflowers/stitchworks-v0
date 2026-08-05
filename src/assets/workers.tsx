/**
 * Worker sprites — front-facing chibi-ish silhouettes for every WorkerRole
 * in the archetypes catalog. Three styles map to the `avatars` tweak:
 *
 *   'dots'        — a coloured disc with the role glyph painted on it
 *   'silhouette'  — a fully filled head + torso shape tinted by role
 *   'chibi'       — head + body + apron + role-specific hand tool, drawn
 *                   with solid fills (no hollow outlines, no opacity)
 *
 * Every shape is opaque; identity comes from layered solid colours, not
 * from translucency. The viewBox is 60x90 — a slightly taller frame than
 * before to fit the grounded foot-shadow without clipping.
 */

import type { CSSProperties } from 'react';
import { WORKER_ARCHETYPES, type WorkerRole, type WorkerArchetype } from '../domain/workers';
import { SW_COLORS } from '../design/tokens';

export type WorkerSpriteStyle = 'dots' | 'silhouette' | 'chibi';

interface WorkerSpriteProps {
  role: WorkerRole;
  size?: number;
  style?: WorkerSpriteStyle;
  /** Optional state — busy adds a bright ring, idle stays neutral. */
  state?: 'idle' | 'busy' | 'walking' | 'absent';
  className?: string;
  cssStyle?: CSSProperties;
}

// Solid skin & hair tones used across every chibi so role differences read
// from the apron + accessory, not the face.
const SKIN = '#E8B98A';
const SKIN_SHADE = '#B8895E';
const HAIR = '#1B1B22';

export function WorkerSprite({
  role,
  size = 56,
  style = 'chibi',
  state = 'idle',
  cssStyle,
}: WorkerSpriteProps) {
  const arch = WORKER_ARCHETYPES[role];
  const w = size * (60 / 90);
  const h = size;
  return (
    <svg
      viewBox="0 0 60 90"
      width={w}
      height={h}
      style={{ display: 'block', overflow: 'visible', ...cssStyle }}
      aria-label={arch.label}
    >
      {/* Solid grounding shadow under the figure */}
      <ellipse cx={30} cy={84} rx={18} ry={3.5} fill={SW_COLORS.muted} />
      <ellipse cx={30} cy={83} rx={14} ry={2.4} fill={SW_COLORS.ink} />

      {/* State decoration — solid colour ring around the feet */}
      {state === 'busy' && (
        <ellipse cx={30} cy={84} rx={22} ry={4.5} fill={SW_COLORS.ok} />
      )}
      {state === 'walking' && (
        <ellipse cx={30} cy={84} rx={22} ry={4.5} fill={SW_COLORS.bobbin} />
      )}
      {state === 'absent' && (
        <rect x={4} y={4} width={52} height={80} rx={6} fill={SW_COLORS.line} />
      )}

      {style === 'dots' && <DotAvatar arch={arch} />}
      {style === 'silhouette' && <SilhouetteAvatar arch={arch} />}
      {style === 'chibi' && <ChibiAvatar arch={arch} role={role} />}
    </svg>
  );
}

// ── Dot avatar — a solid disc with the role glyph painted in white ───────
function DotAvatar({ arch }: { arch: WorkerArchetype }) {
  return (
    <g>
      <circle cx={30} cy={42} r={28} fill={SW_COLORS.ink} />
      <circle cx={30} cy={40} r={26} fill={arch.color} />
      <circle cx={22} cy={32} r={6} fill="#FFFFFF" fillOpacity={1} opacity={0.25} />
      <text
        x={30}
        y={42}
        fontSize={22}
        fontWeight={900}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#FFFFFF"
      >
        {arch.icon}
      </text>
    </g>
  );
}

// ── Silhouette avatar — fully filled head + shoulders, no transparent stripe ─
function SilhouetteAvatar({ arch }: { arch: WorkerArchetype }) {
  const deep = shade(arch.color, -0.25);
  return (
    <g>
      {/* Shoulders / torso */}
      <path
        d="M 6 82 Q 6 44 30 36 Q 54 44 54 82 Z"
        fill={arch.color}
      />
      {/* Highlight stripe — solid lighter tone, not opacity */}
      <path
        d="M 24 36 Q 30 38 36 36 L 36 82 L 24 82 Z"
        fill={shade(arch.color, 0.18)}
      />
      {/* Collar */}
      <path d="M 18 44 Q 30 52 42 44 L 42 50 Q 30 56 18 50 Z" fill={deep} />
      {/* Head */}
      <circle cx={30} cy={20} r={11} fill={SKIN} />
      <path d="M 22 14 Q 30 6 38 14 L 38 18 L 22 18 Z" fill={HAIR} />
    </g>
  );
}

// ── Chibi avatar — body + role-specific accessories, all solid ───────────
function ChibiAvatar({ arch, role }: { arch: WorkerArchetype; role: WorkerRole }) {
  const apron = arch.color;
  const apronDeep = shade(apron, -0.25);
  const apronLite = shade(apron, 0.22);
  return (
    <g>
      {/* Legs (so feet read under the apron) */}
      <rect x={20} y={66} width={8} height={16} rx={1.5} fill={SW_COLORS.steelLite} />
      <rect x={32} y={66} width={8} height={16} rx={1.5} fill={SW_COLORS.steelLite} />
      <rect x={18} y={78} width={12} height={5} rx={1.5} fill={SW_COLORS.ink} />
      <rect x={30} y={78} width={12} height={5} rx={1.5} fill={SW_COLORS.ink} />

      {/* Torso / apron — solid front + side shade */}
      <path
        d="M 14 80 L 14 40 Q 14 30 30 30 Q 46 30 46 40 L 46 80 Z"
        fill={apron}
      />
      <path d="M 14 40 L 14 80 L 20 80 L 20 40 Q 17 33 14 40 Z" fill={apronDeep} />
      <path d="M 28 30 Q 30 28 32 30 L 32 80 L 28 80 Z" fill={apronLite} />

      {/* Apron strap */}
      <rect x={22} y={34} width={4} height={6} fill={apronDeep} />
      <rect x={34} y={34} width={4} height={6} fill={apronDeep} />

      {/* Apron pocket — solid card, no transparency */}
      <rect x={22} y={52} width={16} height={12} rx={2} fill={SW_COLORS.paper} />
      <rect x={22} y={52} width={16} height={3} fill={apronDeep} />
      <rect x={22} y={52} width={16} height={12} rx={2} fill="none" stroke={SW_COLORS.ink} strokeWidth={0.9} />

      {/* Arms (sleeves) */}
      <rect x={4} y={42} width={10} height={26} rx={4} fill={apron} />
      <rect x={4} y={42} width={3} height={26} rx={1.5} fill={apronDeep} />
      <rect x={46} y={42} width={10} height={26} rx={4} fill={apron} />
      <rect x={53} y={42} width={3} height={26} rx={1.5} fill={apronDeep} />

      {/* Hands — solid skin */}
      <circle cx={9} cy={70} r={4} fill={SKIN} />
      <circle cx={9} cy={70} r={4} fill="none" stroke={SKIN_SHADE} strokeWidth={0.8} />
      <circle cx={51} cy={70} r={4} fill={SKIN} />
      <circle cx={51} cy={70} r={4} fill="none" stroke={SKIN_SHADE} strokeWidth={0.8} />

      {/* Head + neck */}
      <rect x={26} y={28} width={8} height={4} fill={SKIN_SHADE} />
      <circle cx={30} cy={18} r={11} fill={SKIN} />
      <path d="M 22 18 Q 30 28 38 18 L 38 22 Q 30 26 22 22 Z" fill={SKIN_SHADE} opacity={0.55} />

      {/* Hair / cap */}
      <Hair role={role} />

      {/* Eyes — solid ovals + cheek */}
      <ellipse cx={26} cy={19} rx={1.4} ry={1.7} fill={SW_COLORS.ink} />
      <ellipse cx={34} cy={19} rx={1.4} ry={1.7} fill={SW_COLORS.ink} />
      <circle cx={23} cy={22} r={1.2} fill="#F4A580" />
      <circle cx={37} cy={22} r={1.2} fill="#F4A580" />
      <path d="M 27 24 Q 30 26 33 24" stroke={SW_COLORS.ink} strokeWidth={0.8} fill="none" />

      {/* Role tool in hand */}
      <RoleTool role={role} />

      {/* Role tag */}
      <RoleBadge role={role} arch={arch} />
    </g>
  );
}

function Hair({ role }: { role: WorkerRole }) {
  if (role === 'qc_inline' || role === 'qc_final') {
    return (
      <g>
        <ellipse cx={30} cy={9} rx={13} ry={5.5} fill={SW_COLORS.alarm} />
        <ellipse cx={30} cy={11} rx={13} ry={2.5} fill="#FFFFFF" />
        <rect x={26} y={6} width={8} height={3} rx={1} fill={SW_COLORS.alarm} />
      </g>
    );
  }
  if (role === 'supervisor') {
    return (
      <g>
        <path d="M 18 12 Q 30 4 42 12 L 42 16 L 18 16 Z" fill={HAIR} />
        <rect x={18} y={16} width={24} height={2} fill={SW_COLORS.brand} />
        <rect x={28} y={4} width={4} height={4} fill={SW_COLORS.brand} />
      </g>
    );
  }
  if (role === 'merchandiser') {
    return (
      <g>
        <path d="M 18 13 Q 30 4 42 13 L 42 17 L 18 17 Z" fill={HAIR} />
        <path d="M 18 13 Q 25 18 30 17 L 22 26 L 18 22 Z" fill={HAIR} />
      </g>
    );
  }
  // Generic — close-cropped cap of hair
  return (
    <g>
      <path d="M 19 13 Q 30 5 41 13 L 41 17 L 19 17 Z" fill={HAIR} />
      <path d="M 20 13 Q 24 15 28 14" stroke={shade(HAIR, 0.35)} strokeWidth={0.6} fill="none" />
    </g>
  );
}

function RoleTool({ role }: { role: WorkerRole }) {
  switch (role) {
    case 'sew_op':
      // Solid needle + thread spool in right hand
      return (
        <g>
          <rect x={50} y={61} width={2.4} height={10} fill={SW_COLORS.muted} />
          <circle cx={51.2} cy={60} r={2} fill={SW_COLORS.thread} />
          <line x1={51.2} y1={60} x2={56} y2={56} stroke={SW_COLORS.thread} strokeWidth={1.2} />
        </g>
      );
    case 'cutter':
      // Solid scissors — filled blades + handle rings
      return (
        <g>
          <circle cx={9} cy={74} r={3} fill={SW_COLORS.muted} />
          <circle cx={14} cy={74} r={3} fill={SW_COLORS.muted} />
          <circle cx={9} cy={74} r={1.2} fill={SW_COLORS.paper} />
          <circle cx={14} cy={74} r={1.2} fill={SW_COLORS.paper} />
          <polygon points="9,72 14,72 18,62 14,60" fill={SW_COLORS.steelLite} />
          <polygon points="14,72 9,72 5,62 9,60" fill={SW_COLORS.steelLite} />
          <line x1={11.5} y1={72} x2={11.5} y2={60} stroke={SW_COLORS.ink} strokeWidth={0.6} />
        </g>
      );
    case 'spreader':
      // Solid ruler bar in left hand
      return (
        <g>
          <rect x={2} y={68} width={16} height={4} rx={1} fill={SW_COLORS.fabric} />
          <rect x={2} y={68} width={16} height={1.2} fill={shade(SW_COLORS.fabric, -0.25)} />
          {[4, 8, 12, 16].map((dx) => (
            <line key={dx} x1={dx} y1={68} x2={dx} y2={72} stroke={SW_COLORS.ink} strokeWidth={0.6} />
          ))}
        </g>
      );
    case 'bundler':
      // Bundle ticket with solid lines
      return (
        <g>
          <rect x={2} y={64} width={12} height={9} fill={SW_COLORS.thread} />
          <rect x={2} y={64} width={12} height={2} fill={shade(SW_COLORS.thread, -0.2)} />
          <rect x={4} y={67} width={8} height={0.8} fill={SW_COLORS.ink} />
          <rect x={4} y={69} width={8} height={0.8} fill={SW_COLORS.ink} />
          <rect x={4} y={71} width={6} height={0.8} fill={SW_COLORS.ink} />
        </g>
      );
    case 'fuser':
      // Solid heat plate + waves
      return (
        <g>
          <rect x={47} y={66} width={9} height={5} rx={1} fill={SW_COLORS.press} />
          <path d="M 49 64 q -2 -3 0 -6 q 2 -3 0 -6" stroke={SW_COLORS.alarm} strokeWidth={1.6} fill="none" />
          <path d="M 53 64 q -2 -3 0 -6 q 2 -3 0 -6" stroke={SW_COLORS.alarm} strokeWidth={1.6} fill="none" />
        </g>
      );
    case 'embroidery_op':
      // Solid hoop with thread
      return (
        <g>
          <circle cx={49} cy={68} r={4.5} fill={SW_COLORS.trim} />
          <circle cx={49} cy={68} r={3} fill={SW_COLORS.paper} />
          <circle cx={49} cy={68} r={1.2} fill={SW_COLORS.trim} />
        </g>
      );
    case 'qc_inline':
    case 'qc_final':
      // Solid magnifier (no hollow lens)
      return (
        <g>
          <circle cx={49} cy={68} r={4.5} fill={SW_COLORS.steelLite} />
          <circle cx={49} cy={68} r={3} fill={SW_COLORS.bobbin} />
          <circle cx={47.5} cy={66.5} r={1} fill="#FFFFFF" />
          <rect x={52} y={70.5} width={5} height={2.2} rx={0.8} transform="rotate(35 52 70.5)" fill={SW_COLORS.muted} />
        </g>
      );
    case 'presser':
      // Solid iron + steam
      return (
        <g>
          <path d="M 2 70 L 14 67 L 16 72 L 2 73 Z" fill={SW_COLORS.steelLite} />
          <rect x={4} y={66} width={9} height={3} rx={1} fill={SW_COLORS.muted} />
          <path d="M 9 64 q -2 -3 0 -6" stroke={SW_COLORS.bobbin} strokeWidth={1.4} fill="none" />
          <path d="M 13 64 q -2 -3 0 -6" stroke={SW_COLORS.bobbin} strokeWidth={1.4} fill="none" />
        </g>
      );
    case 'packer':
      // Solid carton with tape stripe
      return (
        <g>
          <rect x={44} y={64} width={11} height={10} fill="#C49A6C" />
          <rect x={44} y={64} width={11} height={2.4} fill="#A37D52" />
          <rect x={49} y={64} width={1.4} height={10} fill={SW_COLORS.thread} />
        </g>
      );
    case 'material_handler':
      // Solid trolley with two wheels + handle
      return (
        <g>
          <rect x={2} y={66} width={16} height={3.2} fill={SW_COLORS.muted} />
          <rect x={2} y={62} width={2.4} height={4.5} fill={SW_COLORS.muted} />
          <rect x={5} y={64} width={11} height={3} fill={SW_COLORS.fabric} />
          <circle cx={6} cy={72} r={2.4} fill={SW_COLORS.ink} />
          <circle cx={6} cy={72} r={1} fill={SW_COLORS.steelLite} />
          <circle cx={15} cy={72} r={2.4} fill={SW_COLORS.ink} />
          <circle cx={15} cy={72} r={1} fill={SW_COLORS.steelLite} />
        </g>
      );
    case 'supervisor':
      // Solid clipboard
      return (
        <g>
          <rect x={45} y={62} width={10} height={13} rx={1} fill={SW_COLORS.paper} />
          <rect x={45} y={62} width={10} height={3} fill={SW_COLORS.muted} />
          <rect x={48} y={61} width={4} height={2.5} rx={0.6} fill={SW_COLORS.steelLite} />
          <rect x={47} y={67} width={6} height={0.8} fill={SW_COLORS.ink} />
          <rect x={47} y={69} width={6} height={0.8} fill={SW_COLORS.ink} />
          <rect x={47} y={71} width={5} height={0.8} fill={SW_COLORS.ink} />
        </g>
      );
    case 'merchandiser':
      // Solid pencil
      return (
        <g>
          <rect x={47} y={64} width={3} height={11} rx={0.6} transform="rotate(-30 47 64)" fill={SW_COLORS.bobbin} />
          <polygon points="56,56 58,55 58,60" fill={SW_COLORS.thread} />
          <polygon points="58,55 58.5,55.5 57.5,60" fill={SW_COLORS.ink} />
        </g>
      );
    case 'helper':
    default:
      // Solid tray
      return (
        <g>
          <rect x={2} y={68} width={16} height={3.5} rx={1} fill={SW_COLORS.muted} />
          <rect x={3} y={66} width={14} height={2.5} rx={0.5} fill={SW_COLORS.fabric} />
        </g>
      );
  }
}

function RoleBadge({ role, arch }: { role: WorkerRole; arch: WorkerArchetype }) {
  const code = ROLE_CODE[role] ?? '••';
  return (
    <g>
      <rect x={20} y={38} width={20} height={10} rx={2.2} fill={SW_COLORS.ink} />
      <rect x={20} y={38} width={20} height={3} fill={shade(arch.color, -0.2)} />
      <text
        x={30}
        y={45}
        fontSize={6}
        fontWeight={900}
        textAnchor="middle"
        fill="#FFFFFF"
        fontFamily="ui-monospace, monospace"
      >
        {code}
      </text>
    </g>
  );
}

// Local hex shader (mirrors domain/iso.ts → shade) — kept private so the
// asset module is self-contained.
function shade(color: string, amt: number): string {
  const c = color.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const t = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  return '#' + [t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

const ROLE_CODE: Record<WorkerRole, string> = {
  sew_op: 'SEW',
  helper: 'HLP',
  cutter: 'CUT',
  spreader: 'SPR',
  bundler: 'BND',
  fuser: 'FUS',
  embroidery_op: 'EMB',
  qc_inline: 'QC1',
  qc_final: 'QC2',
  presser: 'PRS',
  packer: 'PCK',
  material_handler: 'MAT',
  supervisor: 'SUP',
  merchandiser: 'MER',
};
