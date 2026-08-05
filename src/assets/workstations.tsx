/**
 * Workstation sprites — top-down SVG illustrations for every MachineCode in
 * the catalog. Each sprite is drawn on a 100x100 viewBox; multi-cell
 * footprints (CAD cutter, spreader, steam tunnel, embroidery) override to
 * 400x100 / 200x200 to keep proportions honest.
 *
 * Solid-fill discipline: every shape carries an opaque colour. Layered
 * shades (lighter top, mid body, darker base) create depth without
 * resorting to opacity tricks. Outline-only ("hollow") shapes were rewritten
 * as filled glyphs so the sprite reads as a real object at every size.
 *
 * The primary call site is the layout canvas — Builder palette tiles, Live
 * Floor stations, the assets gallery. Pure SVG, no images, so they re-colour
 * cleanly when the vibe changes.
 */

import type { CSSProperties } from 'react';
import { MACHINE_CATALOG, type MachineCode, type MachineSpec } from '../domain/machines';
import { SW_COLORS } from '../design/tokens';

interface WorkstationSpriteProps {
  code: MachineCode;
  size?: number;
  /** Show the table footprint behind the machine head (default true). */
  withTable?: boolean;
  /** Optional state tint — running stations glow brand, idle ones go grey. */
  state?: 'idle' | 'running' | 'broken';
  style?: CSSProperties;
  /** When BOTH width and height are given, render at exactly that pixel box
   *  (glyph letterboxed via preserveAspectRatio) instead of deriving the box
   *  from `size`. Used by the Builder's 2D plan view to fit a sprite into a
   *  station's cell footprint inside a parent SVG. */
  width?: number;
  height?: number;
}

/** Aspect ratio of the sprite's natural footprint, in cells. */
const FOOTPRINT_VIEWBOX: Partial<Record<MachineCode, [number, number]>> = {
  CAD: [400, 200],
  SPR: [400, 100],
  STEAM: [400, 200],
  EMB: [200, 200],
  FUSE: [200, 100],
};

const stateTint = (state: WorkstationSpriteProps['state']): string => {
  if (state === 'running') return SW_COLORS.ok;
  if (state === 'broken') return SW_COLORS.alarm;
  return SW_COLORS.muted;
};

// Local hex shader so sprites build their own lighter/darker tones from
// the spec colour without depending on the design tokens module.
function shade(color: string, amt: number): string {
  const c = color.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const t = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  return '#' + [t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function WorkstationSprite({
  code,
  size = 64,
  withTable = true,
  state,
  style,
  width,
  height,
}: WorkstationSpriteProps) {
  const spec = MACHINE_CATALOG[code];
  const [vw, vh] = FOOTPRINT_VIEWBOX[code] ?? [100, 100];
  const ratio = vw / vh;
  const w = size * ratio;
  const h = size;
  // Explicit box mode: the caller pins the exact pixel box; the responsive
  // maxWidth/height:auto CSS (meant for HTML layout) is suppressed because it
  // fights attribute sizing inside a nested-SVG context.
  const fixedBox = width != null && height != null;

  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      width={fixedBox ? width : w}
      height={fixedBox ? height : h}
      preserveAspectRatio="xMidYMid meet"
      style={
        fixedBox
          ? { display: 'block', overflow: 'visible', ...style }
          : { display: 'block', overflow: 'visible', maxWidth: '100%', height: 'auto', ...style }
      }
      aria-label={spec.label}
    >
      {withTable && <StationTable spec={spec} vw={vw} vh={vh} />}
      <StationHead code={code} vw={vw} vh={vh} />
      {state && (
        <g>
          <circle cx={vw - 12} cy={12} r={7} fill={SW_COLORS.ink} />
          <circle cx={vw - 12} cy={12} r={5.5} fill={stateTint(state)} />
          <circle cx={vw - 13.5} cy={10.5} r={1.6} fill="#FFFFFF" />
        </g>
      )}
    </svg>
  );
}

// ── Table base ───────────────────────────────────────────────────────────
function StationTable({ spec, vw, vh }: { spec: MachineSpec; vw: number; vh: number }) {
  const pad = 6;
  return (
    <>
      {/* Drop shadow under the table */}
      <rect
        x={pad + 2}
        y={pad + 3}
        width={vw - pad * 2}
        height={vh - pad * 2}
        rx={6}
        fill={SW_COLORS.ink}
        opacity={0.18}
      />
      {/* Table top — solid */}
      <rect
        x={pad}
        y={pad}
        width={vw - pad * 2}
        height={vh - pad * 2}
        rx={6}
        fill={SW_COLORS.paperEdge}
      />
      {/* Highlight bevel along the top edge */}
      <rect
        x={pad}
        y={pad}
        width={vw - pad * 2}
        height={5}
        rx={6}
        fill="#FFFFFF"
      />
      {/* Outline */}
      <rect
        x={pad}
        y={pad}
        width={vw - pad * 2}
        height={vh - pad * 2}
        rx={6}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.6}
      />
      {/* Category strip — left edge */}
      <rect x={pad} y={pad} width={8} height={vh - pad * 2} rx={3} fill={spec.color} />
      <rect x={pad} y={pad} width={8} height={4} fill={shade(spec.color, 0.3)} />
    </>
  );
}

// ── Station heads ────────────────────────────────────────────────────────
function StationHead({ code, vw, vh }: { code: MachineCode; vw: number; vh: number }) {
  const cx = vw / 2;
  const cy = vh / 2;
  switch (code) {
    case 'SNL':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.brand} needles={1} />;
    case 'DNL':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.brand} needles={2} />;
    case '4OL':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.bobbin} needles={4} arm="curved" />;
    case '5OL':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.bobbin} needles={5} arm="curved" />;
    case 'FL':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.bobbin} needles={3} arm="flat" />;
    case 'FB':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.bobbin} needles={1} arm="cylinder" />;
    case 'KS':
      return <SewingMachineHead cx={cx} cy={cy} accent={SW_COLORS.trim} needles={6} />;
    case 'BH':
      return <ButtonholeHead cx={cx} cy={cy} />;
    case 'BS':
      return <ButtonSewHead cx={cx} cy={cy} />;
    case 'BT':
      return <BartackHead cx={cx} cy={cy} />;
    case 'EMB':
      return <EmbroideryHead vw={vw} vh={vh} />;
    case 'CUT':
      return <StraightKnifeHead cx={cx} cy={cy} />;
    case 'CAD':
      return <CadCutterHead vw={vw} vh={vh} />;
    case 'SPR':
      return <SpreaderHead vw={vw} vh={vh} />;
    case 'FUSE':
      return <FusingPressHead vw={vw} vh={vh} />;
    case 'PRESS':
      return <IronHead cx={cx} cy={cy} />;
    case 'STEAM':
      return <SteamTunnelHead vw={vw} vh={vh} />;
    case 'INSP':
      return <InspectionHead cx={cx} cy={cy} />;
    case 'MNL':
      return <ManualHead cx={cx} cy={cy} />;
  }
}

// ── Generic sewing machine — used for SNL/DNL/OL/FL/FB/KS variants ──────
function SewingMachineHead({
  cx,
  cy,
  accent,
  needles,
  arm = 'standard',
}: {
  cx: number;
  cy: number;
  accent: string;
  needles: number;
  arm?: 'standard' | 'curved' | 'flat' | 'cylinder';
}) {
  const accentDeep = shade(accent, -0.25);
  const accentLite = shade(accent, 0.2);
  return (
    <g>
      {/* Shadow under the machine head */}
      <ellipse cx={cx + 4} cy={cy + 22} rx={24} ry={5} fill={SW_COLORS.ink} opacity={0.22} />

      {/* Motor block (rear) — solid steel cuboid with bevel */}
      <rect x={cx - 26} y={cy - 18} width={18} height={36} rx={3} fill={SW_COLORS.muted} />
      <rect x={cx - 26} y={cy - 18} width={18} height={5} rx={3} fill={SW_COLORS.steelLite} />
      <rect x={cx - 24} y={cy - 13} width={4} height={4} fill={accent} />
      <rect x={cx - 24} y={cy - 5} width={4} height={4} fill={accent} />
      <rect x={cx - 24} y={cy + 3} width={4} height={4} fill={accentLite} />
      <rect x={cx - 17} y={cy - 13} width={5} height={28} rx={1} fill={SW_COLORS.ink} />

      {/* Arm */}
      {arm === 'cylinder' ? (
        <>
          <ellipse cx={cx + 8} cy={cy} rx={20} ry={6} fill={SW_COLORS.muted} />
          <ellipse cx={cx + 8} cy={cy - 2} rx={20} ry={3} fill={SW_COLORS.steelLite} />
          <circle cx={cx + 24} cy={cy} r={5} fill={accent} />
          <circle cx={cx + 24} cy={cy} r={2.5} fill={accentDeep} />
        </>
      ) : arm === 'curved' ? (
        <>
          <path
            d={`M ${cx - 8} ${cy - 8} Q ${cx + 12} ${cy - 14} ${cx + 22} ${cy} Q ${cx + 12} ${cy + 14} ${cx - 8} ${cy + 8} Z`}
            fill={SW_COLORS.muted}
          />
          <path
            d={`M ${cx - 8} ${cy - 8} Q ${cx + 12} ${cy - 14} ${cx + 22} ${cy} Q ${cx + 8} ${cy - 8} ${cx - 8} ${cy - 6} Z`}
            fill={SW_COLORS.steelLite}
          />
        </>
      ) : (
        <>
          <rect x={cx - 8} y={cy - 7} width={32} height={14} rx={3} fill={SW_COLORS.muted} />
          <rect x={cx - 8} y={cy - 7} width={32} height={4} rx={3} fill={SW_COLORS.steelLite} />
        </>
      )}

      {/* Head + needle plate */}
      <rect x={cx + 14} y={cy - 9} width={10} height={18} rx={2} fill={accent} />
      <rect x={cx + 14} y={cy - 9} width={10} height={4} rx={2} fill={accentLite} />
      <rect x={cx + 14} y={cy + 7} width={10} height={2} fill={accentDeep} />
      {arm !== 'cylinder' && (
        <>
          <rect x={cx + 15} y={cy + 8} width={8} height={3} rx={0.6} fill={SW_COLORS.ink} />
          {Array.from({ length: needles }).map((_, i) => {
            const offset = (i - (needles - 1) / 2) * 2.2;
            return (
              <rect
                key={i}
                x={cx + 19 + offset - 0.5}
                y={cy + 9}
                width={1}
                height={5}
                fill={SW_COLORS.steelLite}
              />
            );
          })}
        </>
      )}

      {/* Thread spool on top — solid cone */}
      <ellipse cx={cx - 17} cy={cy - 24} rx={5} ry={2} fill={shade(SW_COLORS.thread, -0.25)} />
      <rect x={cx - 22} y={cy - 24} width={10} height={4} fill={SW_COLORS.thread} />
      <ellipse cx={cx - 17} cy={cy - 20} rx={5} ry={2} fill={shade(SW_COLORS.thread, 0.25)} />
      <line x1={cx - 17} y1={cy - 22} x2={cx + 14} y2={cy - 7} stroke={SW_COLORS.thread} strokeWidth={1} />

      {/* Hand wheel — solid disc + spokes */}
      <circle cx={cx - 8} cy={cy + 16} r={5.5} fill={SW_COLORS.muted} />
      <circle cx={cx - 8} cy={cy + 16} r={4} fill={SW_COLORS.steelLite} />
      <circle cx={cx - 8} cy={cy + 16} r={1.6} fill={accent} />
    </g>
  );
}

function ButtonholeHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <rect x={cx - 22} y={cy - 14} width={44} height={28} rx={4} fill={SW_COLORS.muted} />
      <rect x={cx - 22} y={cy - 14} width={44} height={7} rx={4} fill={SW_COLORS.steelLite} />
      <rect x={cx - 14} y={cy - 2} width={28} height={5} rx={2.5} fill={SW_COLORS.paper} />
      <rect x={cx - 12} y={cy - 1} width={24} height={3} rx={1.5} fill={SW_COLORS.ink} />
      <rect x={cx - 11} y={cy} width={22} height={1} fill={SW_COLORS.trim} />
      <circle cx={cx + 17} cy={cy - 9} r={3} fill={SW_COLORS.trim} />
      <circle cx={cx + 17} cy={cy - 9} r={1.4} fill={SW_COLORS.paper} />
      <rect x={cx - 18} y={cy + 6} width={6} height={4} fill={shade(SW_COLORS.steel, 0.25)} />
      <rect x={cx + 12} y={cy + 6} width={6} height={4} fill={shade(SW_COLORS.steel, 0.25)} />
      <rect x={cx - 1} y={cy - 22} width={2} height={8} fill={SW_COLORS.steelLite} />
      <ellipse cx={cx} cy={cy - 22} rx={4} ry={2.5} fill={SW_COLORS.thread} />
    </g>
  );
}

function ButtonSewHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <rect x={cx - 20} y={cy - 14} width={40} height={28} rx={4} fill={SW_COLORS.muted} />
      <rect x={cx - 20} y={cy - 14} width={40} height={7} rx={4} fill={SW_COLORS.steelLite} />
      <circle cx={cx} cy={cy} r={7} fill={SW_COLORS.paper} />
      <circle cx={cx} cy={cy} r={5.5} fill={SW_COLORS.bobbin} />
      <circle cx={cx - 2} cy={cy - 2} r={0.9} fill={SW_COLORS.paper} />
      <circle cx={cx + 2} cy={cy - 2} r={0.9} fill={SW_COLORS.paper} />
      <circle cx={cx - 2} cy={cy + 2} r={0.9} fill={SW_COLORS.paper} />
      <circle cx={cx + 2} cy={cy + 2} r={0.9} fill={SW_COLORS.paper} />
      <rect x={cx + 12} y={cy - 8} width={6} height={4} fill={SW_COLORS.trim} />
      <rect x={cx + 12} y={cy - 8} width={6} height={1.2} fill={shade(SW_COLORS.trim, 0.25)} />
    </g>
  );
}

function BartackHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <rect x={cx - 22} y={cy - 12} width={44} height={24} rx={4} fill={SW_COLORS.muted} />
      <rect x={cx - 22} y={cy - 12} width={44} height={6} rx={4} fill={SW_COLORS.steelLite} />
      <rect x={cx - 7} y={cy - 6} width={14} height={12} rx={1.5} fill={SW_COLORS.paper} />
      <g fill={SW_COLORS.trim}>
        <rect x={cx - 5} y={cy - 4} width={10} height={1.6} />
        <rect x={cx - 5} y={cy - 1} width={10} height={1.6} />
        <rect x={cx - 5} y={cy + 2} width={10} height={1.6} />
      </g>
      <rect x={cx - 18} y={cy - 8} width={5} height={3} fill={SW_COLORS.brand} />
      <rect x={cx - 18} y={cy + 5} width={5} height={3} fill={SW_COLORS.thread} />
    </g>
  );
}

function EmbroideryHead({ vw, vh }: { vw: number; vh: number }) {
  // Multi-head — 4 hoops in a row, all solid
  const cx = vw / 2;
  const cy = vh / 2;
  return (
    <g>
      <ellipse cx={cx + 4} cy={cy + 35} rx={75} ry={6} fill={SW_COLORS.ink} opacity={0.22} />
      <rect x={cx - 70} y={cy - 30} width={140} height={60} rx={5} fill={SW_COLORS.muted} />
      <rect x={cx - 70} y={cy - 30} width={140} height={12} rx={5} fill={SW_COLORS.steelLite} />
      <rect x={cx - 64} y={cy - 24} width={128} height={20} rx={3} fill={shade(SW_COLORS.steel, 0.2)} />
      {[-48, -16, 16, 48].map((dx, i) => (
        <g key={i}>
          {/* Thread cone */}
          <rect x={cx + dx - 3} y={cy - 20} width={6} height={6} fill={SW_COLORS.thread} />
          <ellipse cx={cx + dx} cy={cy - 14} rx={3.5} ry={1.2} fill={shade(SW_COLORS.thread, 0.2)} />
          {/* Needle bar */}
          <rect x={cx + dx - 1} y={cy - 12} width={2} height={6} fill={SW_COLORS.steelLite} />
          {/* Hoop */}
          <circle cx={cx + dx} cy={cy + 8} r={12} fill={SW_COLORS.trim} />
          <circle cx={cx + dx} cy={cy + 8} r={9.5} fill={SW_COLORS.paper} />
          <circle cx={cx + dx} cy={cy + 8} r={2.4} fill={SW_COLORS.trim} />
        </g>
      ))}
    </g>
  );
}

function StraightKnifeHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <ellipse cx={cx + 2} cy={cy + 20} rx={28} ry={4} fill={SW_COLORS.ink} opacity={0.22} />
      <rect x={cx - 26} y={cy - 4} width={52} height={8} rx={2} fill={SW_COLORS.muted} />
      <rect x={cx - 26} y={cy - 4} width={52} height={2.5} rx={2} fill={SW_COLORS.steelLite} />
      <rect x={cx - 7} y={cy - 24} width={14} height={28} rx={2} fill={SW_COLORS.steelLite} />
      <rect x={cx - 7} y={cy - 24} width={14} height={4} rx={2} fill={SW_COLORS.muted} />
      <rect x={cx - 2} y={cy - 14} width={4} height={26} fill={SW_COLORS.press} />
      <rect x={cx - 1} y={cy + 6} width={2} height={14} fill={SW_COLORS.ink} />
      <circle cx={cx} cy={cy - 22} r={3.5} fill={SW_COLORS.brand} />
      <circle cx={cx} cy={cy - 22} r={1.4} fill={SW_COLORS.paper} />
    </g>
  );
}

function CadCutterHead({ vw, vh }: { vw: number; vh: number }) {
  const cx = vw / 2;
  const cy = vh / 2;
  return (
    <g>
      {/* Solid bed with paper-marker top */}
      <ellipse cx={cx + 4} cy={cy + 80} rx={180} ry={8} fill={SW_COLORS.ink} opacity={0.22} />
      <rect x={cx - 170} y={cy - 70} width={340} height={140} rx={5} fill={SW_COLORS.steelLite} />
      <rect x={cx - 170} y={cy - 70} width={340} height={14} rx={5} fill={SW_COLORS.paper} />
      <rect x={cx - 164} y={cy - 60} width={328} height={124} rx={3} fill={SW_COLORS.paper} />
      {/* Vacuum perforation pattern (solid dots, no opacity) */}
      {Array.from({ length: 7 }).map((_, ry) =>
        Array.from({ length: 17 }).map((_, rx2) => (
          <circle
            key={`${ry}-${rx2}`}
            cx={cx - 160 + rx2 * 20}
            cy={cy - 50 + ry * 20}
            r={1.4}
            fill={SW_COLORS.muted}
          />
        )),
      )}
      {/* Gantry rail */}
      <rect x={cx - 170} y={cy - 6} width={340} height={14} fill={SW_COLORS.muted} />
      <rect x={cx - 170} y={cy - 6} width={340} height={4} fill={SW_COLORS.steelLite} />
      {/* Cutting head */}
      <rect x={cx + 40} y={cy - 24} width={40} height={32} rx={3} fill={SW_COLORS.brand} />
      <rect x={cx + 40} y={cy - 24} width={40} height={8} rx={3} fill={shade(SW_COLORS.brand, 0.25)} />
      <rect x={cx + 50} y={cy + 8} width={16} height={14} fill={SW_COLORS.press} />
      <rect x={cx + 56} y={cy + 22} width={4} height={6} fill={SW_COLORS.ink} />
      {/* Pattern outline being cut — filled panels */}
      <path
        d={`M ${cx - 110} ${cy + 30} Q ${cx - 100} ${cy + 50} ${cx - 80} ${cy + 50} L ${cx - 40} ${cy + 50} Q ${cx - 20} ${cy + 30} ${cx - 30} ${cy + 20} L ${cx - 70} ${cy + 20} Q ${cx - 90} ${cy + 20} ${cx - 110} ${cy + 30} Z`}
        fill={SW_COLORS.fabric}
      />
      <path
        d={`M ${cx - 110} ${cy + 30} Q ${cx - 100} ${cy + 50} ${cx - 80} ${cy + 50} L ${cx - 40} ${cy + 50}`}
        fill="none"
        stroke={SW_COLORS.ink}
        strokeWidth={1.4}
      />
    </g>
  );
}

function SpreaderHead({ vw, vh }: { vw: number; vh: number }) {
  const cx = vw / 2;
  const cy = vh / 2;
  return (
    <g>
      <ellipse cx={cx + 4} cy={cy + 38} rx={180} ry={6} fill={SW_COLORS.ink} opacity={0.22} />
      {/* Solid spreading table */}
      <rect x={cx - 170} y={cy - 32} width={340} height={64} rx={3} fill={SW_COLORS.paperEdge} />
      <rect x={cx - 170} y={cy - 32} width={340} height={10} rx={3} fill="#FFFFFF" />
      {/* Fabric layers — fully opaque, stacked tones */}
      <rect x={cx - 160} y={cy - 22} width={320} height={6} fill={shade(SW_COLORS.fabric, -0.15)} />
      <rect x={cx - 160} y={cy - 12} width={320} height={6} fill={SW_COLORS.fabric} />
      <rect x={cx - 160} y={cy - 2} width={320} height={6} fill={shade(SW_COLORS.fabric, 0.18)} />
      {/* Carriage */}
      <rect x={cx + 110} y={cy - 32} width={50} height={64} rx={3} fill={SW_COLORS.muted} />
      <rect x={cx + 110} y={cy - 32} width={50} height={10} rx={3} fill={SW_COLORS.steelLite} />
      <rect x={cx + 116} y={cy - 26} width={28} height={12} fill={SW_COLORS.brand} />
      <rect x={cx + 116} y={cy - 26} width={28} height={3} fill={shade(SW_COLORS.brand, 0.25)} />
      <circle cx={cx + 120} cy={cy + 24} r={6} fill={SW_COLORS.ink} />
      <circle cx={cx + 120} cy={cy + 24} r={2.2} fill={SW_COLORS.steelLite} />
      <circle cx={cx + 150} cy={cy + 24} r={6} fill={SW_COLORS.ink} />
      <circle cx={cx + 150} cy={cy + 24} r={2.2} fill={SW_COLORS.steelLite} />
      {/* Fabric roll */}
      <circle cx={cx + 135} cy={cy} r={13} fill={SW_COLORS.bobbin} />
      <circle cx={cx + 135} cy={cy} r={9} fill={shade(SW_COLORS.bobbin, 0.2)} />
      <circle cx={cx + 135} cy={cy} r={4} fill={SW_COLORS.steelLite} />
    </g>
  );
}

function FusingPressHead({ vw, vh }: { vw: number; vh: number }) {
  const cx = vw / 2;
  const cy = vh / 2;
  return (
    <g>
      <ellipse cx={cx + 4} cy={cy + 22} rx={90} ry={5} fill={SW_COLORS.ink} opacity={0.22} />
      {/* Conveyor */}
      <rect x={cx - 80} y={cy - 14} width={160} height={30} rx={3} fill={SW_COLORS.muted} />
      <rect x={cx - 80} y={cy - 14} width={160} height={6} rx={3} fill={SW_COLORS.steelLite} />
      <rect x={cx - 76} y={cy - 4} width={152} height={16} fill={SW_COLORS.ink} />
      {/* Belt notches */}
      {Array.from({ length: 16 }).map((_, i) => (
        <rect key={i} x={cx - 75 + i * 9.5} y={cy - 2} width={3} height={12} fill={SW_COLORS.steelLite} />
      ))}
      {/* Heated drum */}
      <rect x={cx - 26} y={cy - 30} width={52} height={60} rx={6} fill={SW_COLORS.press} />
      <rect x={cx - 26} y={cy - 30} width={52} height={14} rx={6} fill={shade(SW_COLORS.press, 0.2)} />
      <rect x={cx - 20} y={cy - 24} width={40} height={6} fill={SW_COLORS.thread} />
      {/* Heat lines — solid glyph waves */}
      <g stroke={SW_COLORS.alarm} strokeWidth={2.4} fill="none" strokeLinecap="round">
        <path d={`M ${cx - 6} ${cy - 36} q -3 -4 0 -8 q 3 -4 0 -8`} />
        <path d={`M ${cx} ${cy - 36} q -3 -4 0 -8 q 3 -4 0 -8`} />
        <path d={`M ${cx + 6} ${cy - 36} q -3 -4 0 -8 q 3 -4 0 -8`} />
      </g>
      {/* Belt rollers */}
      <circle cx={cx - 78} cy={cy} r={7} fill={SW_COLORS.steelLite} />
      <circle cx={cx - 78} cy={cy} r={3} fill={SW_COLORS.ink} />
      <circle cx={cx + 78} cy={cy} r={7} fill={SW_COLORS.steelLite} />
      <circle cx={cx + 78} cy={cy} r={3} fill={SW_COLORS.ink} />
    </g>
  );
}

function IronHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <ellipse cx={cx + 1} cy={cy + 24} rx={36} ry={5} fill={SW_COLORS.ink} opacity={0.22} />
      {/* Pressing table — solid */}
      <ellipse cx={cx} cy={cy + 4} rx={36} ry={18} fill={SW_COLORS.paperEdge} />
      <ellipse cx={cx} cy={cy - 4} rx={36} ry={6} fill="#FFFFFF" />
      <ellipse cx={cx} cy={cy + 4} rx={36} ry={18} fill="none" stroke={SW_COLORS.ink} strokeWidth={1.2} />
      {/* Iron */}
      <path
        d={`M ${cx - 14} ${cy - 4} L ${cx + 14} ${cy - 6} L ${cx + 18} ${cy + 2} L ${cx - 14} ${cy + 4} Z`}
        fill={SW_COLORS.steelLite}
      />
      <path
        d={`M ${cx - 14} ${cy - 4} L ${cx + 14} ${cy - 6} L ${cx + 14} ${cy - 4} L ${cx - 14} ${cy - 3} Z`}
        fill="#FFFFFF"
      />
      <rect x={cx - 12} y={cy - 13} width={20} height={8} rx={3} fill={SW_COLORS.muted} />
      <rect x={cx - 12} y={cy - 13} width={20} height={2.5} rx={3} fill={SW_COLORS.steelLite} />
      {/* Steam — solid wavy glyphs */}
      <g stroke={SW_COLORS.bobbin} strokeWidth={2} fill="none" strokeLinecap="round">
        <path d={`M ${cx - 10} ${cy - 16} q -2 -3 0 -6 q 2 -3 0 -6`} />
        <path d={`M ${cx - 2} ${cy - 16} q -2 -3 0 -6 q 2 -3 0 -6`} />
        <path d={`M ${cx + 6} ${cy - 16} q -2 -3 0 -6 q 2 -3 0 -6`} />
      </g>
    </g>
  );
}

function SteamTunnelHead({ vw, vh }: { vw: number; vh: number }) {
  const cx = vw / 2;
  const cy = vh / 2;
  return (
    <g>
      <ellipse cx={cx + 4} cy={cy + 66} rx={180} ry={7} fill={SW_COLORS.ink} opacity={0.22} />
      {/* Tunnel body — solid steel cuboid */}
      <rect x={cx - 170} y={cy - 60} width={340} height={120} rx={20} fill={SW_COLORS.muted} />
      <rect x={cx - 170} y={cy - 60} width={340} height={24} rx={20} fill={SW_COLORS.steelLite} />
      <rect x={cx - 160} y={cy - 50} width={320} height={100} rx={14} fill={shade(SW_COLORS.steel, 0.18)} />
      {/* Inner cavity */}
      <rect x={cx - 152} y={cy - 42} width={304} height={84} rx={10} fill={SW_COLORS.ink} />
      {/* Garments on hangers passing through — solid silhouettes */}
      {[-100, -30, 40, 110].map((dx, i) => (
        <g key={i}>
          <rect x={cx + dx - 0.6} y={cy - 40} width={1.2} height={28} fill={SW_COLORS.steelLite} />
          <path
            d={`M ${cx + dx - 14} ${cy + 30} L ${cx + dx + 14} ${cy + 30} L ${cx + dx + 10} ${cy - 12} L ${cx + dx - 10} ${cy - 12} Z`}
            fill={SW_COLORS.fabric}
          />
          <path
            d={`M ${cx + dx - 14} ${cy + 30} L ${cx + dx + 14} ${cy + 30} L ${cx + dx + 10} ${cy - 12} L ${cx + dx - 10} ${cy - 12} Z`}
            fill="none"
            stroke={SW_COLORS.ink}
            strokeWidth={0.8}
          />
        </g>
      ))}
      {/* Steam stacks — solid clouds */}
      {[-60, 0, 60].map((dx, i) => (
        <g key={i}>
          <ellipse cx={cx + dx} cy={cy - 72} rx={8} ry={4} fill={SW_COLORS.bobbin} />
          <ellipse cx={cx + dx + 4} cy={cy - 78} rx={5} ry={3} fill={shade(SW_COLORS.bobbin, 0.3)} />
          <rect x={cx + dx - 2} y={cy - 62} width={4} height={6} fill={SW_COLORS.steelLite} />
        </g>
      ))}
    </g>
  );
}

function InspectionHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <ellipse cx={cx + 1} cy={cy + 22} rx={32} ry={4} fill={SW_COLORS.ink} opacity={0.22} />
      {/* Light table — solid yellow */}
      <rect x={cx - 30} y={cy - 20} width={60} height={40} rx={3} fill={SW_COLORS.thread} />
      <rect x={cx - 30} y={cy - 20} width={60} height={8} rx={3} fill={shade(SW_COLORS.thread, 0.25)} />
      <rect x={cx - 28} y={cy - 18} width={56} height={36} rx={2} fill="#FFFFFF" />
      {/* Solid garment silhouette on the table */}
      <path
        d={`M ${cx - 14} ${cy + 14} L ${cx - 14} ${cy - 4} L ${cx - 18} ${cy - 8} L ${cx - 10} ${cy - 14} L ${cx + 10} ${cy - 14} L ${cx + 18} ${cy - 8} L ${cx + 14} ${cy - 4} L ${cx + 14} ${cy + 14} Z`}
        fill={SW_COLORS.fabric}
      />
      <rect x={cx - 14} y={cy - 8} width={28} height={2} fill={shade(SW_COLORS.fabric, -0.25)} />
      {/* Solid magnifier */}
      <circle cx={cx + 18} cy={cy - 18} r={8} fill={SW_COLORS.steelLite} />
      <circle cx={cx + 18} cy={cy - 18} r={5.5} fill={SW_COLORS.bobbin} />
      <circle cx={cx + 16} cy={cy - 20} r={1.6} fill="#FFFFFF" />
      <rect x={cx + 22} y={cy - 13} width={8} height={3} rx={1} transform={`rotate(35 ${cx + 22} ${cy - 13})`} fill={SW_COLORS.muted} />
    </g>
  );
}

function ManualHead({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <ellipse cx={cx + 1} cy={cy + 20} rx={30} ry={4} fill={SW_COLORS.ink} opacity={0.22} />
      {/* Solid work surface */}
      <rect x={cx - 26} y={cy - 16} width={52} height={32} rx={3} fill={SW_COLORS.paperEdge} />
      <rect x={cx - 26} y={cy - 16} width={52} height={7} rx={3} fill="#FFFFFF" />
      {/* Solid scissors */}
      <polygon points={`${cx - 6},${cy + 6} ${cx + 12},${cy - 10} ${cx + 13},${cy - 9} ${cx - 5},${cy + 7}`} fill={SW_COLORS.steelLite} />
      <polygon points={`${cx + 6},${cy + 6} ${cx - 12},${cy - 10} ${cx - 13},${cy - 9} ${cx + 5},${cy + 7}`} fill={SW_COLORS.steelLite} />
      <circle cx={cx - 8} cy={cy + 6} r={3.4} fill={SW_COLORS.muted} />
      <circle cx={cx - 8} cy={cy + 6} r={1.6} fill={SW_COLORS.paperEdge} />
      <circle cx={cx + 8} cy={cy + 6} r={3.4} fill={SW_COLORS.muted} />
      <circle cx={cx + 8} cy={cy + 6} r={1.6} fill={SW_COLORS.paperEdge} />
      {/* Spool of thread */}
      <rect x={cx + 10} y={cy + 8} width={6} height={4} fill={SW_COLORS.thread} />
      <ellipse cx={cx + 13} cy={cy + 12} rx={3} ry={1} fill={shade(SW_COLORS.thread, -0.2)} />
    </g>
  );
}
