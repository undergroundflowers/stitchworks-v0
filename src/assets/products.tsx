/**
 * Product sprites — what flows through the factory. Three families:
 *
 *   raw materials    — fabric roll, thread cone, trim/button card, zipper
 *   work-in-progress — cut-piece bundle, partial garment, hanger garment
 *   finished goods   — folded garment in poly bag, packed carton
 *
 * Plus one sprite per garment template (T-shirt, polo, formal shirt,
 * trouser, sweatshirt) so the order/factory views can show the actual
 * SKU silhouette instead of a generic icon.
 *
 * Solid-fill discipline: every shape uses opaque colour. Layered tones
 * (lighter top, mid body, darker base) build depth without opacity tricks.
 * Hollow stroke-only shapes have been replaced with filled glyphs so each
 * sprite reads as a real, tangible object at every size.
 *
 * All sprites are drawn on a 100x100 viewBox. Garment colours come from a
 * small palette of common factory colourways and can be overridden via prop.
 */

import type { CSSProperties } from 'react';
import { SW_COLORS } from '../design/tokens';

export type ProductKind =
  // raw
  | 'fabric_roll'
  | 'thread_cone'
  | 'trim_card'
  | 'button_card'
  | 'zipper'
  // wip
  | 'bundle'
  | 'cut_piece'
  | 'wip_garment'
  | 'hanger'
  // finished garments (silhouettes)
  | 'tshirt'
  | 'polo'
  | 'shirt'
  | 'trouser'
  | 'sweatshirt'
  // packed
  | 'polybag'
  | 'carton';

interface ProductSpriteProps {
  kind: ProductKind;
  size?: number;
  /** Override the primary fabric colour. */
  color?: string;
  /** Bundle/carton count badge. */
  count?: number;
  cssStyle?: CSSProperties;
}

function shade(color: string, amt: number): string {
  const c = color.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const t = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  return '#' + [t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function ProductSprite({
  kind,
  size = 64,
  color,
  count,
  cssStyle,
}: ProductSpriteProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ display: 'block', overflow: 'visible', ...cssStyle }}
      aria-label={kind.replace('_', ' ')}
    >
      <Body kind={kind} color={color} />
      {typeof count === 'number' && (
        <g>
          <circle cx={84} cy={18} r={13} fill={SW_COLORS.ink} />
          <circle cx={84} cy={18} r={11} fill={SW_COLORS.brand} />
          <text
            x={84}
            y={19}
            fontSize={10}
            fontWeight={900}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#FFFFFF"
            fontFamily="ui-monospace, monospace"
          >
            ×{count}
          </text>
        </g>
      )}
    </svg>
  );
}

function Body({ kind, color }: { kind: ProductKind; color?: string }) {
  switch (kind) {
    case 'fabric_roll':
      return <FabricRoll color={color ?? SW_COLORS.fabric} />;
    case 'thread_cone':
      return <ThreadCone color={color ?? SW_COLORS.thread} />;
    case 'trim_card':
      return <TrimCard color={color ?? SW_COLORS.trim} />;
    case 'button_card':
      return <ButtonCard color={color ?? SW_COLORS.bobbin} />;
    case 'zipper':
      return <Zipper color={color ?? SW_COLORS.steel} />;
    case 'bundle':
      return <Bundle color={color ?? SW_COLORS.fabric} />;
    case 'cut_piece':
      return <CutPiece color={color ?? SW_COLORS.fabric} />;
    case 'wip_garment':
      return <WipGarment color={color ?? SW_COLORS.fabric} />;
    case 'hanger':
      return <HangerGarment color={color ?? SW_COLORS.brand} />;
    case 'tshirt':
      return <Tshirt color={color ?? SW_COLORS.brand} />;
    case 'polo':
      return <Polo color={color ?? SW_COLORS.bobbin} />;
    case 'shirt':
      return <FormalShirt color={color ?? SW_COLORS.paperEdge} />;
    case 'trouser':
      return <Trouser color={color ?? SW_COLORS.steel} />;
    case 'sweatshirt':
      return <Sweatshirt color={color ?? SW_COLORS.trim} />;
    case 'polybag':
      return <Polybag color={color ?? SW_COLORS.brand} />;
    case 'carton':
      return <Carton />;
  }
}

// Solid grounding shadow — used at the base of upright objects.
function GroundShadow({ cx = 50, cy = 88, rx = 28 }: { cx?: number; cy?: number; rx?: number }) {
  return (
    <>
      <ellipse cx={cx} cy={cy} rx={rx} ry={4.5} fill={SW_COLORS.muted} />
      <ellipse cx={cx} cy={cy - 0.6} rx={rx * 0.78} ry={3} fill={SW_COLORS.ink} />
    </>
  );
}

// ── Raw ─────────────────────────────────────────────────────────────────
function FabricRoll({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.2);
  return (
    <g>
      <GroundShadow cx={50} cy={76} rx={42} />
      {/* Roll core (left end) */}
      <ellipse cx={10} cy={50} rx={5} ry={20} fill={shade(color, -0.4)} />
      <ellipse cx={10} cy={50} rx={3} ry={14} fill={SW_COLORS.ink} />
      {/* Body */}
      <rect x={10} y={30} width={80} height={40} fill={color} />
      <rect x={10} y={30} width={80} height={8} fill={lite} />
      <rect x={10} y={62} width={80} height={8} fill={deep} />
      {/* Right cap */}
      <ellipse cx={90} cy={50} rx={5} ry={20} fill={lite} />
      <ellipse cx={90} cy={50} rx={3} ry={14} fill={shade(color, -0.15)} />
      {/* Outline */}
      <rect x={10} y={30} width={80} height={40} fill="none" stroke={SW_COLORS.ink} strokeWidth={1.5} />
      {/* Solid label sticker */}
      <rect x={14} y={34} width={20} height={8} fill={SW_COLORS.paper} />
      <rect x={14} y={34} width={20} height={2.5} fill={shade(SW_COLORS.paper, -0.1)} />
      <rect x={14} y={34} width={20} height={8} fill="none" stroke={SW_COLORS.ink} strokeWidth={0.8} />
    </g>
  );
}

function ThreadCone({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.25);
  return (
    <g>
      <GroundShadow cx={50} cy={86} rx={26} />
      {/* Base disc */}
      <ellipse cx={50} cy={80} rx={20} ry={5} fill={SW_COLORS.muted} />
      <ellipse cx={50} cy={78} rx={20} ry={3.5} fill={SW_COLORS.steelLite} />
      {/* Cone body */}
      <path d={`M 32 80 L 68 80 L 60 22 L 40 22 Z`} fill={color} />
      <path d={`M 40 22 L 60 22 L 56 50 L 44 50 Z`} fill={lite} />
      <path d={`M 32 80 L 68 80 L 64 60 L 36 60 Z`} fill={deep} />
      <path d={`M 32 80 L 68 80 L 60 22 L 40 22 Z`} fill="none" stroke={SW_COLORS.ink} strokeWidth={1.3} />
      {/* Spindle top */}
      <ellipse cx={50} cy={22} rx={10} ry={3.5} fill={SW_COLORS.muted} />
      <ellipse cx={50} cy={21} rx={10} ry={2.2} fill={SW_COLORS.steelLite} />
      <rect x={49} y={12} width={2} height={10} fill={SW_COLORS.muted} />
      <circle cx={50} cy={10} r={2.5} fill={color} />
      <circle cx={50} cy={10} r={1.2} fill={lite} />
    </g>
  );
}

function TrimCard({ color }: { color: string }) {
  const deep = shade(color, -0.2);
  return (
    <g>
      <GroundShadow cx={50} cy={84} rx={32} />
      <rect x={20} y={20} width={60} height={60} rx={3} fill={SW_COLORS.paper} />
      <rect x={20} y={20} width={60} height={10} rx={3} fill={color} />
      <rect x={20} y={28} width={60} height={2} fill={deep} />
      <rect x={20} y={20} width={60} height={60} rx={3} fill="none" stroke={SW_COLORS.ink} strokeWidth={1.3} />
      <text x={50} y={26} fontSize={6} fontWeight={900} textAnchor="middle" fill="#FFFFFF" dominantBaseline="central">
        TRIM
      </text>
      {[42, 54, 66].map((y) => (
        <g key={y}>
          <circle cx={32} cy={y} r={3} fill={color} />
          <circle cx={32} cy={y} r={1.4} fill={deep} />
          <circle cx={50} cy={y} r={3} fill={color} />
          <circle cx={50} cy={y} r={1.4} fill={deep} />
          <circle cx={68} cy={y} r={3} fill={color} />
          <circle cx={68} cy={y} r={1.4} fill={deep} />
        </g>
      ))}
    </g>
  );
}

function ButtonCard({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.2);
  return (
    <g>
      <GroundShadow cx={50} cy={84} rx={34} />
      <rect x={18} y={20} width={64} height={60} rx={3} fill={SW_COLORS.paper} />
      <rect x={18} y={20} width={64} height={6} rx={3} fill={shade(SW_COLORS.paper, -0.08)} />
      <rect x={18} y={20} width={64} height={60} rx={3} fill="none" stroke={SW_COLORS.ink} strokeWidth={1.3} />
      {Array.from({ length: 4 }).map((_, r) =>
        Array.from({ length: 4 }).map((_, c) => (
          <g key={`${r}-${c}`}>
            <circle cx={28 + c * 14} cy={32 + r * 12} r={4.4} fill={deep} />
            <circle cx={28 + c * 14} cy={32 + r * 12} r={3.4} fill={color} />
            <circle cx={26 + c * 14} cy={30 + r * 12} r={1.2} fill={lite} />
            <circle cx={26.5 + c * 14} cy={30.5 + r * 12} r={0.6} fill={SW_COLORS.ink} />
            <circle cx={29.5 + c * 14} cy={30.5 + r * 12} r={0.6} fill={SW_COLORS.ink} />
            <circle cx={26.5 + c * 14} cy={33.5 + r * 12} r={0.6} fill={SW_COLORS.ink} />
            <circle cx={29.5 + c * 14} cy={33.5 + r * 12} r={0.6} fill={SW_COLORS.ink} />
          </g>
        )),
      )}
    </g>
  );
}

function Zipper({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  return (
    <g>
      <GroundShadow cx={50} cy={88} rx={18} />
      <rect x={42} y={14} width={16} height={72} rx={2} fill={SW_COLORS.paper} />
      <rect x={42} y={14} width={16} height={6} rx={2} fill={shade(SW_COLORS.paper, -0.1)} />
      <rect x={42} y={14} width={16} height={72} rx={2} fill="none" stroke={SW_COLORS.ink} strokeWidth={1} />
      {Array.from({ length: 14 }).map((_, i) => (
        <g key={i}>
          <rect x={42} y={16 + i * 5} width={7} height={3} fill={color} />
          <rect x={42} y={16 + i * 5} width={7} height={1} fill={deep} />
          <rect x={51} y={18.5 + i * 5} width={7} height={3} fill={color} />
          <rect x={51} y={18.5 + i * 5} width={7} height={1} fill={deep} />
        </g>
      ))}
      <path d="M 38 50 L 62 50 L 56 60 L 44 60 Z" fill={SW_COLORS.steelLite} />
      <path d="M 38 50 L 62 50 L 60 53 L 40 53 Z" fill="#FFFFFF" />
      <rect x={49} y={60} width={2} height={8} fill={SW_COLORS.ink} />
      <circle cx={50} cy={71} r={4} fill={SW_COLORS.muted} />
      <circle cx={50} cy={70} r={2} fill={SW_COLORS.steelLite} />
    </g>
  );
}

// ── Work in progress ────────────────────────────────────────────────────
function Bundle({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.2);
  return (
    <g>
      <GroundShadow cx={50} cy={86} rx={34} />
      {/* Solid stacked layers — bottom darker, top lighter */}
      <rect x={20} y={62} width={60} height={16} rx={2} fill={deep} />
      <rect x={21} y={50} width={58} height={14} rx={2} fill={color} />
      <rect x={22} y={38} width={56} height={14} rx={2} fill={lite} />
      <rect x={22} y={38} width={56} height={4} rx={2} fill={shade(color, 0.35)} />
      {/* Twine */}
      <rect x={34} y={36} width={2} height={44} fill={SW_COLORS.ink} />
      <rect x={64} y={36} width={2} height={44} fill={SW_COLORS.ink} />
      {/* Ticket */}
      <rect x={36} y={26} width={28} height={14} rx={1.5} fill={SW_COLORS.thread} />
      <rect x={36} y={26} width={28} height={3.5} fill={shade(SW_COLORS.thread, -0.2)} />
      <rect x={36} y={26} width={28} height={14} rx={1.5} fill="none" stroke={SW_COLORS.ink} strokeWidth={0.9} />
      <rect x={40} y={32} width={20} height={1} fill={SW_COLORS.ink} />
      <rect x={40} y={35} width={16} height={1} fill={SW_COLORS.ink} />
      <rect x={40} y={38} width={12} height={1} fill={SW_COLORS.ink} />
    </g>
  );
}

function CutPiece({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.18);
  return (
    <g>
      <GroundShadow cx={50} cy={84} rx={32} />
      {/* Body panel */}
      <path
        d={`M 20 28 L 30 22 L 40 26 L 60 26 L 70 22 L 80 28 L 76 38 L 68 36 L 68 80 L 32 80 L 32 36 L 24 38 Z`}
        fill={color}
      />
      <path
        d={`M 20 28 L 30 22 L 40 26 L 60 26 L 70 22 L 80 28 L 76 38 L 68 36 L 68 40 L 32 40 L 32 36 L 24 38 Z`}
        fill={lite}
      />
      <path d={`M 32 70 L 68 70 L 68 80 L 32 80 Z`} fill={deep} />
      <path
        d={`M 20 28 L 30 22 L 40 26 L 60 26 L 70 22 L 80 28 L 76 38 L 68 36 L 68 80 L 32 80 L 32 36 L 24 38 Z`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.4}
      />
      {/* Solid notch markers */}
      {[
        [30, 22],
        [70, 22],
        [40, 26],
        [60, 26],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.6} fill={SW_COLORS.alarm} />
      ))}
    </g>
  );
}

function WipGarment({ color }: { color: string }) {
  return (
    <g>
      <Tshirt color={color} />
      {/* Solid seam lines */}
      <rect x={31} y={42} width={2} height={38} fill={SW_COLORS.alarm} />
      <rect x={67} y={42} width={2} height={38} fill={SW_COLORS.alarm} />
      {/* Solid WIP badge */}
      <circle cx={20} cy={20} r={9} fill={SW_COLORS.ink} />
      <circle cx={20} cy={20} r={7.5} fill={SW_COLORS.warn} />
      <text
        x={20}
        y={20}
        fontSize={7}
        fontWeight={900}
        textAnchor="middle"
        dominantBaseline="central"
        fill={SW_COLORS.ink}
      >
        WIP
      </text>
    </g>
  );
}

function HangerGarment({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  return (
    <g>
      <GroundShadow cx={50} cy={92} rx={32} />
      {/* Hanger — solid */}
      <path
        d={`M 50 14 q -4 -4 -8 0 q 0 4 4 6 L 50 22 L 50 14 Z`}
        fill={SW_COLORS.steelLite}
      />
      <polygon points="18,32 50,22 82,32 50,28" fill={SW_COLORS.muted} />
      <polygon points="18,32 50,22 50,28" fill={SW_COLORS.steelLite} />
      {/* Garment body */}
      <path
        d={`M 22 32 L 30 28 L 40 34 L 60 34 L 70 28 L 78 32 L 74 44 L 66 42 L 66 88 L 34 88 L 34 42 L 26 44 Z`}
        fill={color}
      />
      <path
        d={`M 22 32 L 30 28 L 40 34 L 60 34 L 70 28 L 78 32 L 74 38 L 66 38 L 66 42 L 34 42 L 34 38 L 26 38 Z`}
        fill={shade(color, 0.18)}
      />
      <rect x={34} y={80} width={32} height={8} fill={deep} />
      <path
        d={`M 22 32 L 30 28 L 40 34 L 60 34 L 70 28 L 78 32 L 74 44 L 66 42 L 66 88 L 34 88 L 34 42 L 26 44 Z`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.4}
      />
    </g>
  );
}

// ── Garment templates ───────────────────────────────────────────────────
function Tshirt({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.18);
  return (
    <g>
      <GroundShadow cx={50} cy={90} rx={34} />
      <path
        d={`M 18 32 L 30 22 L 40 28 Q 50 32 60 28 L 70 22 L 82 32 L 76 44 L 68 42 L 68 86 L 32 86 L 32 42 L 24 44 Z`}
        fill={color}
        strokeLinejoin="round"
      />
      {/* Solid shoulder highlight */}
      <path
        d={`M 18 32 L 30 22 L 40 28 L 30 32 L 24 36 Z`}
        fill={lite}
      />
      <path
        d={`M 82 32 L 70 22 L 60 28 L 70 32 L 76 36 Z`}
        fill={lite}
      />
      {/* Solid hem */}
      <rect x={32} y={80} width={36} height={6} fill={deep} />
      <path
        d={`M 18 32 L 30 22 L 40 28 Q 50 32 60 28 L 70 22 L 82 32 L 76 44 L 68 42 L 68 86 L 32 86 L 32 42 L 24 44 Z`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* Solid neck rib */}
      <path d={`M 38 26 Q 50 34 62 26 L 60 28 Q 50 32 40 28 Z`} fill={deep} />
    </g>
  );
}

function Polo({ color }: { color: string }) {
  return (
    <g>
      <Tshirt color={color} />
      {/* Solid collar */}
      <polygon points="40,28 44,26 50,32 56,26 60,28 56,36 50,38 44,36" fill={SW_COLORS.paper} />
      <polygon points="40,28 44,26 50,32 56,26 60,28 56,30 50,33 44,30" fill={shade(SW_COLORS.paper, -0.1)} />
      <polygon points="40,28 44,26 50,32 56,26 60,28 56,36 50,38 44,36" fill="none" stroke={SW_COLORS.ink} strokeWidth={1} />
      {/* Placket */}
      <rect x={48.5} y={32} width={3} height={16} fill={shade(color, -0.3)} />
      <circle cx={50} cy={38} r={1.2} fill={SW_COLORS.ink} />
      <circle cx={50} cy={44} r={1.2} fill={SW_COLORS.ink} />
    </g>
  );
}

function FormalShirt({ color }: { color: string }) {
  const deep = shade(color, -0.2);
  const lite = shade(color, 0.15);
  return (
    <g>
      <GroundShadow cx={50} cy={92} rx={38} />
      {/* Body — long sleeves */}
      <path
        d={`M 14 36 L 26 22 L 36 28 Q 50 32 64 28 L 74 22 L 86 36 L 80 78 L 70 76 L 70 88 L 30 88 L 30 76 L 20 78 Z`}
        fill={color}
        strokeLinejoin="round"
      />
      <path
        d={`M 14 36 L 26 22 L 36 28 L 26 30 L 20 34 Z`}
        fill={lite}
      />
      <path
        d={`M 86 36 L 74 22 L 64 28 L 74 30 L 80 34 Z`}
        fill={lite}
      />
      <rect x={30} y={80} width={40} height={8} fill={deep} />
      <path
        d={`M 14 36 L 26 22 L 36 28 Q 50 32 64 28 L 74 22 L 86 36 L 80 78 L 70 76 L 70 88 L 30 88 L 30 76 L 20 78 Z`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* Solid collar */}
      <polygon points="36,28 42,24 50,34 58,24 64,28 58,38 50,40 42,38" fill={SW_COLORS.paper} />
      <polygon points="36,28 42,24 50,34 58,24 64,28 58,32 50,35 42,32" fill={shade(SW_COLORS.paper, -0.08)} />
      <polygon points="36,28 42,24 50,34 58,24 64,28 58,38 50,40 42,38" fill="none" stroke={SW_COLORS.ink} strokeWidth={1} />
      {/* Button placket */}
      <rect x={48.5} y={34} width={3} height={50} fill={shade(color, -0.25)} />
      {[42, 50, 58, 66, 74].map((y) => (
        <g key={y}>
          <circle cx={50} cy={y} r={1.4} fill={SW_COLORS.paper} />
          <circle cx={50} cy={y} r={1} fill={SW_COLORS.ink} />
        </g>
      ))}
      {/* Solid chest pocket */}
      <rect x={34} y={48} width={12} height={14} fill={lite} />
      <rect x={34} y={48} width={12} height={3} fill={shade(color, -0.1)} />
      <rect x={34} y={48} width={12} height={14} fill="none" stroke={SW_COLORS.ink} strokeWidth={0.9} />
    </g>
  );
}

function Trouser({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.18);
  return (
    <g>
      <GroundShadow cx={50} cy={92} rx={32} />
      {/* Solid waistband */}
      <rect x={22} y={14} width={56} height={8} fill={SW_COLORS.muted} />
      <rect x={22} y={14} width={56} height={2.5} fill={SW_COLORS.steelLite} />
      <rect x={22} y={14} width={56} height={8} fill="none" stroke={SW_COLORS.ink} strokeWidth={1} />
      {/* Solid legs */}
      <path
        d={`M 22 22 L 78 22 L 74 88 L 56 88 L 50 36 L 44 88 L 26 88 Z`}
        fill={color}
        strokeLinejoin="round"
      />
      <path
        d={`M 22 22 L 78 22 L 74 30 L 26 30 Z`}
        fill={lite}
      />
      <rect x={26} y={82} width={18} height={6} fill={deep} />
      <rect x={56} y={82} width={18} height={6} fill={deep} />
      <path
        d={`M 22 22 L 78 22 L 74 88 L 56 88 L 50 36 L 44 88 L 26 88 Z`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* Solid fly */}
      <rect x={48.5} y={22} width={3} height={14} fill={shade(color, -0.35)} />
      {/* Solid pockets */}
      <path d={`M 28 22 q 4 8 12 8 L 38 26 L 30 22 Z`} fill={lite} />
      <path d={`M 72 22 q -4 8 -12 8 L 62 26 L 70 22 Z`} fill={lite} />
      {/* Belt loops */}
      {[30, 42, 58, 70].map((x) => (
        <rect key={x} x={x - 1.6} y={12} width={3.2} height={5} fill={deep} />
      ))}
    </g>
  );
}

function Sweatshirt({ color }: { color: string }) {
  const deep = shade(color, -0.25);
  const lite = shade(color, 0.2);
  return (
    <g>
      <GroundShadow cx={50} cy={90} rx={36} />
      {/* Hood */}
      <path
        d={`M 38 26 Q 50 12 62 26 L 62 32 L 38 32 Z`}
        fill={color}
      />
      <path d={`M 40 22 Q 50 14 60 22 L 60 26 L 40 26 Z`} fill={lite} />
      {/* Body */}
      <path
        d={`M 18 36 L 30 26 L 40 30 L 60 30 L 70 26 L 82 36 L 78 50 L 70 48 L 70 86 L 30 86 L 30 48 L 22 50 Z`}
        fill={color}
      />
      <path
        d={`M 18 36 L 30 26 L 40 30 L 30 34 L 22 38 Z`}
        fill={lite}
      />
      <path
        d={`M 82 36 L 70 26 L 60 30 L 70 34 L 78 38 Z`}
        fill={lite}
      />
      <rect x={30} y={80} width={40} height={6} fill={deep} />
      <path
        d={`M 18 36 L 30 26 L 40 30 L 60 30 L 70 26 L 82 36 L 78 50 L 70 48 L 70 86 L 30 86 L 30 48 L 22 50 Z`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* Solid kangaroo pocket */}
      <path
        d={`M 32 60 L 68 60 L 64 76 L 36 76 Z`}
        fill={deep}
      />
      {/* Drawstrings */}
      <rect x={45} y={28} width={1.8} height={14} fill={SW_COLORS.paper} />
      <rect x={53} y={28} width={1.8} height={14} fill={SW_COLORS.paper} />
      {/* Cuffs + hem ribbing */}
      <rect x={18} y={42} width={6} height={8} fill={SW_COLORS.muted} />
      <rect x={76} y={42} width={6} height={8} fill={SW_COLORS.muted} />
      <rect x={30} y={82} width={40} height={6} fill={SW_COLORS.muted} />
    </g>
  );
}

// ── Packed ──────────────────────────────────────────────────────────────
function Polybag({ color }: { color: string }) {
  const deep = shade(color, -0.2);
  return (
    <g>
      <GroundShadow cx={50} cy={90} rx={36} />
      {/* Bag — solid translucent-looking layered fills */}
      <rect x={20} y={24} width={60} height={62} rx={2} fill={SW_COLORS.paperEdge} />
      <rect x={20} y={24} width={60} height={12} rx={2} fill="#FFFFFF" />
      <rect x={20} y={80} width={60} height={6} rx={2} fill={shade(SW_COLORS.paperEdge, -0.15)} />
      <rect x={20} y={24} width={60} height={62} rx={2} fill="none" stroke={SW_COLORS.ink} strokeWidth={1.4} />
      {/* Hang hole — solid disc */}
      <ellipse cx={50} cy={20} rx={6} ry={2.4} fill={SW_COLORS.ink} />
      <ellipse cx={50} cy={20} rx={4.5} ry={1.4} fill={SW_COLORS.paperEdge} />
      {/* Folded garment inside — solid layered rectangles */}
      <rect x={28} y={36} width={44} height={12} rx={1.5} fill={color} />
      <rect x={28} y={36} width={44} height={3} rx={1.5} fill={shade(color, 0.2)} />
      <rect x={28} y={50} width={44} height={12} rx={1.5} fill={shade(color, -0.1)} />
      <rect x={28} y={50} width={44} height={3} rx={1.5} fill={color} />
      <rect x={28} y={64} width={44} height={12} rx={1.5} fill={deep} />
      <rect x={28} y={64} width={44} height={3} rx={1.5} fill={shade(color, -0.15)} />
      {/* Sticker */}
      <rect x={56} y={68} width={18} height={12} rx={1.5} fill={SW_COLORS.paper} />
      <rect x={56} y={68} width={18} height={3} rx={1.5} fill={shade(SW_COLORS.paper, -0.1)} />
      <rect x={56} y={68} width={18} height={12} rx={1.5} fill="none" stroke={SW_COLORS.ink} strokeWidth={0.8} />
      <rect x={59} y={73} width={14} height={1} fill={SW_COLORS.ink} />
      <rect x={59} y={75.5} width={10} height={1} fill={SW_COLORS.ink} />
      {/* Solid plastic shine */}
      <rect x={26} y={28} width={2.5} height={56} fill="#FFFFFF" />
      <rect x={32} y={28} width={1.2} height={56} fill={shade(SW_COLORS.paper, -0.1)} />
    </g>
  );
}

function Carton() {
  const cardboard = '#C49A6C';
  const cardLight = '#D8B488';
  const cardShade = '#A37D52';
  return (
    <g>
      <GroundShadow cx={50} cy={92} rx={38} />
      {/* Top face */}
      <polygon points="14,30 50,16 86,30 50,44" fill={cardLight} />
      <polygon points="14,30 50,16 50,30" fill="#E8C9A2" />
      {/* Right face */}
      <polygon points="86,30 86,76 50,90 50,44" fill={cardShade} />
      {/* Left face */}
      <polygon points="14,30 14,76 50,90 50,44" fill={cardboard} />
      {/* Edges */}
      <polygon points="14,30 50,16 86,30 50,44" fill="none" stroke={SW_COLORS.ink} strokeWidth={1.4} strokeLinejoin="round" />
      <polygon points="86,30 86,76 50,90 50,44" fill="none" stroke={SW_COLORS.ink} strokeWidth={1.4} strokeLinejoin="round" />
      <polygon points="14,30 14,76 50,90 50,44" fill="none" stroke={SW_COLORS.ink} strokeWidth={1.4} strokeLinejoin="round" />
      {/* Solid tape stripe */}
      <polygon points="48,17 52,17 52,44 48,44" fill={SW_COLORS.thread} />
      <polygon points="48,17 52,17 50,21" fill={shade(SW_COLORS.thread, -0.2)} />
      {/* Label */}
      <rect x={56} y={56} width={22} height={14} fill={SW_COLORS.paper} />
      <rect x={56} y={56} width={22} height={3.5} fill={shade(SW_COLORS.paper, -0.1)} />
      <rect x={56} y={56} width={22} height={14} fill="none" stroke={SW_COLORS.ink} strokeWidth={0.8} />
      <rect x={59} y={61} width={16} height={1} fill={SW_COLORS.ink} />
      <rect x={59} y={64} width={14} height={1} fill={SW_COLORS.ink} />
      <rect x={59} y={67} width={11} height={1} fill={SW_COLORS.ink} />
    </g>
  );
}

export const PRODUCT_KINDS: ProductKind[] = [
  'fabric_roll',
  'thread_cone',
  'trim_card',
  'button_card',
  'zipper',
  'bundle',
  'cut_piece',
  'wip_garment',
  'hanger',
  'tshirt',
  'polo',
  'shirt',
  'trouser',
  'sweatshirt',
  'polybag',
  'carton',
];

export const PRODUCT_LABELS: Record<ProductKind, string> = {
  fabric_roll: 'Fabric roll',
  thread_cone: 'Thread cone',
  trim_card: 'Trim card',
  button_card: 'Button card',
  zipper: 'Zipper',
  bundle: 'Cut-piece bundle',
  cut_piece: 'Cut panel',
  wip_garment: 'WIP garment',
  hanger: 'Hanger garment',
  tshirt: 'T-shirt',
  polo: 'Polo',
  shirt: 'Formal shirt',
  trouser: 'Trouser',
  sweatshirt: 'Sweatshirt',
  polybag: 'Polybag',
  carton: 'Export carton',
};

export const PRODUCT_GROUPS: { label: string; kinds: ProductKind[] }[] = [
  { label: 'Raw materials', kinds: ['fabric_roll', 'thread_cone', 'trim_card', 'button_card', 'zipper'] },
  { label: 'Work in progress', kinds: ['bundle', 'cut_piece', 'wip_garment', 'hanger'] },
  { label: 'Garments', kinds: ['tshirt', 'polo', 'shirt', 'trouser', 'sweatshirt'] },
  { label: 'Packed', kinds: ['polybag', 'carton'] },
];
