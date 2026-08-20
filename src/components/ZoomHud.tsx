import { useState, type ReactNode } from 'react';
import { SW_COLORS, SW_MOTION, SW_RADIUS, SW_SHADOWS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { StageOverlay } from './StageOverlay';
import { ZOOM_STEP } from '../domain/camera';

/**
 * The zoom control, in one place, for every canvas in the app.
 *
 * The Build floor and the Run floor each used to grow their own: different
 * button order (`− %  +` vs `+ %  −`), different step (1.15 vs 1.25),
 * different reset glyph (⛶ vs ⟲), different corner inset, and one of them
 * painted in raw hex instead of tokens. Same control, four ways to be wrong.
 *
 * `⛶` frames all content rather than jumping to 100%. "Show me everything"
 * is what you actually want after getting lost, and it is the one reset that
 * means the same thing on a floor plan, a block graph and a simulation.
 */
export function ZoomHud({
  zoom,
  onZoomStep,
  onFit,
}: {
  /** Current scale — rendered as a percentage. */
  zoom: number;
  /** Multiply the zoom. The HUD supplies the factor so the step matches the
   *  `+` / `−` keys by construction. */
  onZoomStep: (factor: number) => void;
  /** Frame all content (also ⌘0). */
  onFit: () => void;
}) {
  return (
    <StageOverlay
      style={{
        position: 'absolute',
        bottom: 14,
        right: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        background: alpha(SW_COLORS.steel, 0.95),
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        padding: 2,
        borderRadius: SW_RADIUS.md,
        border: `1px solid ${SW_COLORS.line}`,
        boxShadow: SW_SHADOWS.hud,
        zIndex: 5,
      }}
    >
      <ZoomHudBtn onClick={() => onZoomStep(1 / ZOOM_STEP)} title="Zoom out  (−)">
        −
      </ZoomHudBtn>
      <div
        style={{
          ...SW_TYPE.numeric,
          color: SW_COLORS.ink,
          padding: '0 8px',
          minWidth: 52,
          textAlign: 'center',
          userSelect: 'none',
        }}
      >
        {Math.round(zoom * 100)}%
      </div>
      <ZoomHudBtn onClick={() => onZoomStep(ZOOM_STEP)} title="Zoom in  (+)">
        +
      </ZoomHudBtn>
      <div
        style={{ width: 1, alignSelf: 'stretch', background: SW_COLORS.lineSoft, margin: '3px 2px' }}
      />
      <ZoomHudBtn onClick={onFit} title="Frame everything  (⌘0)">
        ⛶
      </ZoomHudBtn>
    </StageOverlay>
  );
}

function ZoomHudBtn({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...SW_TYPE.numeric,
        width: 30,
        height: 28,
        borderRadius: SW_RADIUS.sm,
        border: 'none',
        background: hover ? SW_COLORS.steelLite : 'transparent',
        color: hover ? SW_COLORS.ink : SW_COLORS.muted,
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
        transition: `background ${SW_MOTION.instant}ms ${SW_MOTION.standard}, color ${SW_MOTION.instant}ms ${SW_MOTION.standard}`,
      }}
    >
      {children}
    </button>
  );
}
