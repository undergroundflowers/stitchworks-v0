/**
 * TimeDisplay — the canonical way to render a time value in Stitchworks.
 * Every clock-like number in the UI must wear one of three chips so the
 * user can never confuse the kinds (per Big Book of Simulation Modelling,
 * AnyLogic Ch. 16):
 *
 *   MODEL  — the simulation's virtual clock         (orange)
 *   CAL    — model time projected onto a real date  (blue)
 *   WALL   — the user's device clock                (grey)
 *
 * Usage:
 *   <TimeDisplay kind="MODEL" primary="t = 83 min" />
 *   <TimeDisplay kind="CAL"   primary="Mon 18 May 2026 · 09:23" />
 *   <TimeDisplay kind="WALL"  primary="14:42:17" surface="dark" />
 */

import { SW_COLORS, SW_FONTS } from '../design/tokens';
import { TIME_GLOSSARY } from '../simulation/timeUnit';

export type TimeKind = 'MODEL' | 'CAL' | 'WALL';

const KIND_COLOR: Record<TimeKind, string> = {
  MODEL: SW_COLORS.brand,
  CAL: SW_COLORS.bobbin,
  WALL: SW_COLORS.muted,
};

export interface TimeChipProps {
  kind: TimeKind;
  /** Optional tweak to chip font size. */
  size?: number;
}

/** A small monochrome chip that names the kind of time. */
export function TimeChip({ kind, size = 9 }: TimeChipProps) {
  const color = KIND_COLOR[kind];
  return (
    <span
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: size,
        fontWeight: 900,
        letterSpacing: '1px',
        padding: '1px 5px',
        borderRadius: 3,
        background: `${color}22`,
        color,
        whiteSpace: 'nowrap',
      }}
      aria-label={`${kind.toLowerCase()} time`}
    >
      {kind}
    </span>
  );
}

export interface TimeDisplayProps {
  kind: TimeKind;
  /** The main string (e.g. "t = 83 min", "Mon 18 May 2026 · 09:23"). */
  primary: string;
  /** Optional caption shown beside the primary value. */
  secondary?: string;
  /** Dark backgrounds (LiveSim) need a brighter primary colour. */
  surface?: 'dark' | 'light';
  /** Size of the primary value (px). Defaults match the LiveSim HUD. */
  primarySize?: number;
  /** When true, drops the (?) tooltip affordance — use for compact rows. */
  compact?: boolean;
}

/** Renders a labelled time value: `[CHIP] primary  secondary  (?)`. */
export function TimeDisplay({
  kind,
  primary,
  secondary,
  surface = 'light',
  primarySize = 16,
  compact = false,
}: TimeDisplayProps) {
  const primaryColor = surface === 'dark' ? '#fff' : SW_COLORS.ink;
  const secondaryColor =
    surface === 'dark' ? '#ffffff80' : SW_COLORS.muted;
  return (
    <span
      title={TIME_GLOSSARY[kind]}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      <TimeChip kind={kind} />
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: primarySize,
          fontWeight: 700,
          color: primaryColor,
        }}
      >
        {primary}
      </span>
      {secondary && (
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: Math.max(10, Math.round(primarySize * 0.7)),
            fontWeight: 600,
            color: secondaryColor,
          }}
        >
          {secondary}
        </span>
      )}
      {!compact && (
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: Math.max(10, Math.round(primarySize * 0.65)),
            color: secondaryColor,
            opacity: 0.6,
            cursor: 'help',
          }}
        >
          (?)
        </span>
      )}
    </span>
  );
}
