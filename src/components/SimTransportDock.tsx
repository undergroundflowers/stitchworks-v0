import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { SW_COLORS, SW_CONTROL, SW_FONTS, SW_MOTION, SW_RADIUS, SW_SHADOWS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { Icon } from './Icon';
import { StageOverlay } from './StageOverlay';

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
 * run state beside it, a segmented speed well, and the run's clocks — inside
 * a single capsule floating over the floor.
 *
 * The run's clock used to live in the page header, a full screen height away
 * from the controls that move it: you pressed play at the bottom and read the
 * result at the top. It is here now, so the thing that advances time and the
 * thing that reports it are one object.
 *
 * It reports one number, in words. The tail used to carry three chipped
 * clocks — MODEL "t = 5.0 min", CAL, WALL — plus "1% of shift", which asked
 * the reader to learn a vocabulary before they could learn how far the run
 * had got. WALL was the device clock, which the operating system already
 * shows. MODEL and CAL were the same instant said twice. So: how long the
 * run has been going, how far through the shift that is, and the date it
 * lands on, each named in the words someone would use out loud.
 *
 * Brand orange is the transport button and nothing else in here. Green/red
 * meant "safe/dangerous" on a control that is neither; play is simply the one
 * thing you act on, which is what brand means everywhere else in the app.
 *
 * It floats over the bottom of the canvas rather than sitting in a row
 * beneath it. The capsule was already a self-contained object on a mostly
 * empty ground, so the strip around it was ~90px of canvas spent framing
 * something that framed itself — and the floor is the one thing on this page
 * that can always use the height. Same corner logic as the zoom HUD and the
 * legend: controls live on the stage they act on.
 *
 * `setup` follows the clock down here for the same reason the clock did. The
 * run's time settings — what one model tick is worth, how long a shift runs,
 * what date t = 0 lands on — were a 106px drawer under the page header, at
 * the far end of the screen from every readout they define. They are four
 * fields you set once and then read the consequences of all shift, so a
 * permanently-reserved strip was the wrong shape for them twice over: too
 * far from their own output, and charging the floor rent for it. They open
 * upward off the speed well now, next to the other control that decides how
 * time passes, and cost the canvas nothing when shut.
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
  /** Accent readout at the tail of the capsule — the line's output rate. */
  accent?: { label: string; value: string; unit?: string; title?: string } | null;
  /** 0–100. Drives the hairline meter under the clock. */
  progressPct: number;
  /** Where the run has got to, in plain words. */
  clock: {
    /** Time elapsed inside the run — "45 s", "5 min", "1h 20m". */
    elapsed: string;
    /** Which day of the run this is, 1-based. */
    day: number;
    /** The date and time this moment lands on — "2026-08-24 Mon · 23:18". */
    date: string;
  };
  /**
   * The run's time settings. Rendered inside a popover that opens upward off
   * a clock button in the capsule — see the note above on why they live here
   * rather than in a drawer under the page header.
   */
  setup?: ReactNode;
  /** Trailing action, rendered at the tail of the capsule. */
  end?: { label: string; onClick: () => void };
}

/** Round icon button — the secondary transport controls and the setup toggle. */
function RoundButton({
  onClick,
  title,
  children,
  size,
  tone = 'ghost',
  active = false,
  expanded,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  size: number;
  tone?: 'ghost' | 'brand';
  /**
   * Held open. Reads exactly like hover rather than taking brand: the panel
   * standing open is already the loudest possible signal that the button is
   * on, and brand in this capsule means the transport button and nothing
   * else.
   */
  active?: boolean;
  /** Sets aria-expanded when the button owns a disclosure. */
  expanded?: boolean;
}) {
  const [hov, setHov] = useState(false);
  const brand = tone === 'brand';
  const lit = hov || active;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={expanded}
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
        border: brand ? 'none' : `1px solid ${lit ? SW_COLORS.ink : SW_COLORS.line}`,
        background: brand
          ? hov
            ? SW_COLORS.brandDeep
            : SW_COLORS.brand
          : lit
            ? SW_COLORS.steelLite
            : 'transparent',
        color: brand ? SW_COLORS.void : lit ? SW_COLORS.ink : SW_COLORS.muted,
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

/**
 * The clock button and the panel it opens.
 *
 * The panel is anchored to the button and opens upward, because everything
 * below the capsule is 14px of margin. It is centred on the button and
 * width-capped against the viewport so it cannot run off the side of a narrow
 * stage.
 *
 * Dismissal is deliberately not a close button. `StageOverlay` stops click
 * and pointerdown at the capsule, so a native listener on the document only
 * ever hears clicks that landed somewhere else — which makes "clicked outside"
 * free and exact here, with no ref-contains test and no risk of the toggle
 * closing the panel it just opened.
 */
function SetupPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div style={{ position: 'relative', flex: 'none', display: 'flex' }}>
      <RoundButton
        onClick={() => setOpen((o) => !o)}
        title="Time setup — what one tick of the clock means, and where the run starts on the calendar"
        size={SW_CONTROL.icon + 6}
        active={open}
        expanded={open}
      >
        <Icon name="clock" size={14} weight={1.6} />
      </RoundButton>
      {open && (
        <div
          role="dialog"
          aria-label="Time setup"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 12px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 420,
            maxWidth: 'calc(100vw - 48px)',
            padding: '12px 14px 14px',
            borderRadius: SW_RADIUS.md,
            // Same material as the capsule it grows out of, one step more
            // opaque: this one has text to read over a moving floor.
            background: alpha(SW_COLORS.steel, 0.97),
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: `1px solid ${SW_COLORS.line}`,
            boxShadow: SW_SHADOWS.hud,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
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
  clock,
  setup,
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
        // Pinned to the bottom of the stage, centred, click-through
        // everywhere the capsule isn't — the floor keeps its full height and
        // stays draggable to either side of the controls.
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 14,
        padding: '0 16px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        pointerEvents: 'none',
        // Above the zoom HUD and legend (both z 5) — those two sit in the
        // right-hand corners the capsule can reach at narrow widths.
        zIndex: 6,
      }}
    >
      <StageOverlay
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minWidth: 0,
          padding: '8px 14px',
          borderRadius: 999,
          // Translucent + blurred like every other overlay on these canvases,
          // so the floor reads through it instead of being cut off by it.
          background: alpha(SW_COLORS.steel, 0.95),
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${SW_COLORS.line}`,
          boxShadow: SW_SHADOWS.hud,
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RoundButton onClick={onReset} title="Rewind to the start of the shift" size={SW_CONTROL.icon + 6}>
            <Icon name="rewind" size={13} weight={1.6} />
          </RoundButton>
          <RoundButton
            onClick={onToggle}
            title={playing ? 'Pause the run' : 'Play the run'}
            size={46}
            tone="brand"
          >
            <Icon name={playing ? 'pause' : 'play'} size={19} weight={2} />
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

        {/* Time setup sits against the speed well because the two are the
            same question asked at different scales: speed is how fast a model
            tick is served, setup is how much a model tick is worth. Together
            they define every number in the readout immediately to the right. */}
        {setup && <SetupPopover>{setup}</SetupPopover>}

        <Divider />

        {/* How far the run has got. Elapsed leads because it is the one thing
            the controls to the left actually move; the percentage names what
            the meter under it draws; the date is the quiet line, there for
            anyone reading a multi-day run and never in the way of the number
            that matters. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 236px', minWidth: 196 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ ...SW_TYPE.micro, fontSize: 9, letterSpacing: '0.14em', color: SW_COLORS.muted }}>
              ELAPSED
            </span>
            <span
              title="How long the run has been going in simulated time"
              style={{ fontFamily: SW_FONTS.mono, fontSize: 13, fontWeight: 700, color: SW_COLORS.ink }}
            >
              {clock.elapsed}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 600,
                color: SW_COLORS.muted,
                whiteSpace: 'nowrap',
              }}
            >
              {Math.round(progressPct)}% of shift
            </span>
          </div>
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
          <span
            title="The date and time this moment of the run falls on, counting from the project's start date"
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 600,
              color: SW_COLORS.muted,
              opacity: 0.85,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {`Day ${clock.day} · ${clock.date}`}
          </span>
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

        {/* End shift closes the run out, so it belongs with the controls that
            move it rather than floating alongside them. Last in the capsule,
            behind a divider: it is the one control here that leaves the page,
            and it should not sit a thumb's width from PLAY. */}
        {end && (
          <>
            <Divider />
            <EndButton label={end.label} onClick={end.onClick} />
          </>
        )}
      </StageOverlay>
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
