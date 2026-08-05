/**
 * Playback controls for the shared sim session.
 *
 * Mountable on any surface. That is the point: because the clock lives in the
 * store and the driver sits above the router, a transport bar on the analysis
 * screen drives the same run as the one on the Sim screen — it is the visible
 * proof the two are not separate simulations.
 *
 * Deliberately compact. The Sim screen keeps its own full-width transport with
 * speed tiers and a shift-progress readout; this is the version that fits in a
 * card header.
 */

import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { useSimSession, selectMaxFrame } from '../simulation/useSimSession';

export function SimTransportBar() {
  const frame = useSimSession((s) => s.frame);
  const maxFrame = useSimSession(selectMaxFrame);
  const playing = useSimSession((s) => s.playing);
  const speed = useSimSession((s) => s.speed);
  const setPlaying = useSimSession((s) => s.setPlaying);
  const setSpeed = useSimSession((s) => s.setSpeed);
  const setFrame = useSimSession((s) => s.setFrame);
  const reset = useSimSession((s) => s.reset);

  if (maxFrame === 0) return null;

  const btn = (active = false): React.CSSProperties => ({
    ...SW_TYPE.micro,
    padding: '4px 9px',
    borderRadius: SW_RADIUS.sm,
    border: `1px solid ${active ? SW_COLORS.brand : SW_COLORS.line}`,
    background: active ? alpha(SW_COLORS.brand, 0.16) : 'transparent',
    color: active ? SW_COLORS.brand : SW_COLORS.muted,
    cursor: 'pointer',
    fontFamily: SW_FONTS.mono,
  });

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" style={btn()} onClick={reset} title="Rewind to the start of the shift">
        ⏮
      </button>
      <button
        type="button"
        style={{
          ...btn(playing),
          borderColor: playing ? SW_COLORS.alarm : SW_COLORS.ok,
          color: playing ? SW_COLORS.alarm : SW_COLORS.ok,
          background: alpha(playing ? SW_COLORS.alarm : SW_COLORS.ok, 0.14),
          fontWeight: 800,
        }}
        onClick={() => setPlaying(!playing)}
      >
        {playing ? '⏸ PAUSE' : '▶ PLAY'}
      </button>
      {[1, 10, 60].map((s) => (
        <button key={s} type="button" style={btn(speed === s)} onClick={() => setSpeed(s)}>
          {s}×
        </button>
      ))}
      <input
        type="range"
        min={0}
        max={maxFrame}
        value={frame}
        onChange={(e) => setFrame(Number(e.target.value))}
        style={{ flex: 1, minWidth: 120, accentColor: SW_COLORS.brand }}
        title="Scrub the shift"
      />
      <span style={{ ...SW_TYPE.numeric, color: SW_COLORS.muted, minWidth: 62, textAlign: 'right' }}>
        {Math.round(frame)}/{maxFrame} min
      </span>
    </div>
  );
}
