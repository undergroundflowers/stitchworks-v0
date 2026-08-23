import { useState, type CSSProperties } from 'react';
import { SW_COLORS, SW_CONTROL, SW_FONTS, SW_MOTION, SW_RADIUS, SW_SHADOWS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';

/**
 * The Live Sim playback dock — one capsule holding every control that moves
 * the clock.
 *
 * The old bar was a flat full-width row: a green PLAY next to a red PAUSE
 * variant, five differently-sized speed buttons in raw hex, a "Virtual"
 * button that belonged to a different axis but sat in the same row, and a
 * gradient progress meter stretched across whatever width was left. It read
 * as seven unrelated controls sharing a strip.
 *
 * Now it reads as one instrument: a round brand transport button with the
 * run state beside it, a segmented speed well, and the shift readout — inside
 * a single capsule floating on the dock ground.
 *
 * Brand orange is the transport button and nothing else in here. Green/red
 * meant "safe/dangerous" on a control that is neither; play is simply the one
 * thing you act on, which is what brand means everywhere else in the app.
 */

export interface SpeedOption {
  value: string;
  label: string;
  /** Tooltip — carries the full meaning the short label drops. */
  title: string;
}

export interface SimTransportDockProps {
  playing: boolean;
  onToggle: () => void;
  onReset: () => void;
  /** Jump the clock forward. Label rides on the button (e.g. '+1h'). */
  onStep: () => void;
  stepLabel: string;
  speed: string;
  speedOptions: SpeedOption[];
  onSpeed: (value: string) => void;
  /** Accent readout at the tail of the capsule — the line's pace. */
  accent?: { label: string; value: string; unit?: string; title?: string } | null;
  /** 0–100. Drives the hairline meter under the time readout. */
  progressPct: number;
  progressLabel: string;
  /** Trailing action, rendered outside the capsule. */
  end?: { label: string; onClick: () => void };
}

/** Round icon button — the two secondary transport controls. */
function RoundButton({
  onClick,
  title,
  children,
  size,
  tone = 'ghost',
}: {
  onClick: () => void;
  title: string;
  children: string;
  size: number;
  tone?: 'ghost' | 'brand';
}) {
  const [hov, setHov] = useState(false);
  const brand = tone === 'brand';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        cursor: 'pointer',
        fontFamily: SW_FONTS.mono,
        fontSize: brand ? 17 : 11,
        fontWeight: 700,
        lineHeight: 1,
        border: brand ? 'none' : `1px solid ${hov ? SW_COLORS.ink : SW_COLORS.line}`,
        background: brand
          ? hov
            ? SW_COLORS.brandDeep
            : SW_COLORS.brand
          : hov
            ? SW_COLORS.steelLite
            : 'transparent',
        color: brand ? SW_COLORS.void : hov ? SW_COLORS.ink : SW_COLORS.muted,
        boxShadow: brand ? `0 0 0 4px ${alpha(SW_COLORS.brand, 0.14)}` : 'none',
        transition: `background ${SW_MOTION.instant}ms linear, color ${SW_MOTION.instant}ms linear, border-color ${SW_MOTION.instant}ms linear`,
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 26, flex: 'none', background: SW_COLORS.lineSoft }} />;
}

export function SimTransportDock({
  playing,
  onToggle,
  onReset,
  onStep,
  stepLabel,
  speed,
  speedOptions,
  onSpeed,
  accent,
  progressPct,
  progressLabel,
  end,
}: SimTransportDockProps) {
  const statusTone = playing ? SW_COLORS.ok : SW_COLORS.warn;

  const tile = (active: boolean): CSSProperties => ({
    ...SW_TYPE.micro,
    fontSize: 11,
    letterSpacing: '0.06em',
    padding: '6px 9px',
    borderRadius: SW_RADIUS.sm,
    border: 'none',
    background: active ? SW_COLORS.steelLite : 'transparent',
    color: active ? SW_COLORS.ink : SW_COLORS.muted,
    cursor: 'pointer',
    transition: `background ${SW_MOTION.instant}ms linear, color ${SW_MOTION.instant}ms linear`,
  });

  return (
    <div
      style={{
        padding: '12px 24px',
        background: SW_COLORS.void,
        borderTop: `1px solid ${SW_COLORS.lineSoft}`,
        // Three tracks, not a centred flex row: the empty left track and the
        // End-shift track balance each other so the capsule sits optically
        // centred, and both side tracks collapse before the capsule is asked
        // to shrink. A plain `justify-content: center` row let the capsule
        // grow straight under the trailing button at 1024–1280.
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minWidth: 0,
          padding: '8px 14px',
          borderRadius: 999,
          background: SW_COLORS.steel,
          border: `1px solid ${SW_COLORS.line}`,
          boxShadow: SW_SHADOWS.hud,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RoundButton onClick={onReset} title="Rewind to the start of the shift" size={SW_CONTROL.icon + 6}>
            ⏮
          </RoundButton>
          <RoundButton
            onClick={onToggle}
            title={playing ? 'Pause the run' : 'Play the run'}
            size={46}
            tone="brand"
          >
            {playing ? '❚❚' : '▶'}
          </RoundButton>
          <RoundButton onClick={onStep} title={`Jump the clock forward ${stepLabel}`} size={SW_CONTROL.icon + 6}>
            {`+${stepLabel}`}
          </RoundButton>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusTone,
              boxShadow: playing ? `0 0 10px ${statusTone}` : 'none',
              animation: playing ? 'sim-pulse 1s infinite' : undefined,
            }}
          />
          <span style={{ ...SW_TYPE.micro, letterSpacing: '0.16em', color: statusTone }}>
            {playing ? 'RUNNING' : 'PAUSED'}
          </span>
        </div>

        <Divider />

        <div
          role="radiogroup"
          aria-label="Playback speed"
          style={{
            display: 'flex',
            gap: 2,
            padding: 3,
            borderRadius: SW_RADIUS.sm + 3,
            background: SW_COLORS.void,
            border: `1px solid ${SW_COLORS.lineSoft}`,
          }}
        >
          {speedOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={speed === o.value}
              title={o.title}
              onClick={() => onSpeed(o.value)}
              style={tile(speed === o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        <Divider />

        {/* Shift readout — the old full-width gradient meter, reduced to the
            two things it actually said: where the shift is, and how far in. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 132px', minWidth: 104 }}>
          <span
            style={{
              ...SW_TYPE.micro,
              fontSize: 10,
              letterSpacing: '0.08em',
              // Never uppercase: this line carries model-time notation, and
              // `t = 0.0 min` reads as `T = 0.0 MIN` under text-transform.
              textTransform: 'none',
              color: SW_COLORS.muted,
            }}
          >
            {progressLabel}
          </span>
          <div style={{ height: 4, borderRadius: 999, background: SW_COLORS.void, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.max(0, Math.min(100, progressPct))}%`,
                background: SW_COLORS.brand,
                transition: `width ${SW_MOTION.base}ms linear`,
              }}
            />
          </div>
        </div>

        {accent && (
          <span
            title={accent.title}
            style={{
              ...SW_TYPE.micro,
              textTransform: 'none',
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 5,
              height: SW_CONTROL.height,
              padding: '0 10px',
              borderRadius: SW_RADIUS.sm,
              background: SW_COLORS.brandLite,
              border: `1px solid ${SW_COLORS.brandEdge}`,
              color: SW_COLORS.brandText,
              lineHeight: `${SW_CONTROL.height}px`,
            }}
          >
            {accent.label} {accent.value}
            {accent.unit && (
              <span style={{ fontSize: 9, opacity: 0.75 }}>{accent.unit}</span>
            )}
          </span>
        )}
      </div>

      {/* No `minWidth: 0` here on purpose: that zeroes the track's automatic
          minimum, and the button then overflows its track leftwards, under
          the capsule. Letting the track keep its content minimum makes the
          capsule yield instead. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {end && <EndButton label={end.label} onClick={end.onClick} />}
      </div>
    </div>
  );
}

function EndButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...SW_TYPE.micro,
        fontSize: 11,
        height: SW_CONTROL.height + 4,
        padding: '0 14px',
        borderRadius: 999,
        background: hov ? SW_COLORS.steelLite : 'transparent',
        border: `1px solid ${hov ? SW_COLORS.ink : SW_COLORS.line}`,
        color: hov ? SW_COLORS.ink : SW_COLORS.muted,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: `background ${SW_MOTION.instant}ms linear, color ${SW_MOTION.instant}ms linear, border-color ${SW_MOTION.instant}ms linear`,
      }}
    >
      {label}
    </button>
  );
}
