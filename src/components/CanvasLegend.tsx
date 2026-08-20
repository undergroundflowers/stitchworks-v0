import { useState, type ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { StageOverlay } from './StageOverlay';

/**
 * The collapsible legend that sits directly above the zoom HUD.
 *
 * The Build floor's legend was a fixed, always-open, click-through panel in
 * the bottom-right; the simulation's was a collapsible panel in the
 * bottom-left. Same idea, opposite corner, opposite behaviour — so on one
 * screen you could put the key away and on the other you could not.
 *
 * One shell, collapsed by default, stacked above the zoom HUD in the same
 * corner on every canvas. Each canvas supplies its own rows.
 */
export function CanvasLegend({
  label,
  width,
  children,
}: {
  /** Which view this key describes — shown after "LEGEND ·". */
  label: string;
  /** Expanded width. Omit to size to content. */
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <StageOverlay
      style={{
        position: 'absolute',
        right: 14,
        bottom: 56,
        width: open ? width : 'auto',
        alignItems: 'stretch',
        maxHeight: 'calc(100% - 48px)',
        background: alpha(SW_COLORS.steel, 0.95),
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.md,
        boxShadow: SW_SHADOWS.hud,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 5,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse legend' : 'Expand legend'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          background: 'transparent',
          border: 'none',
          borderBottom: open ? `1px solid ${SW_COLORS.lineSoft}` : 'none',
          color: SW_COLORS.ink,
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 900,
          letterSpacing: '0.18em',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ color: SW_COLORS.brand }}>▣</span>
        <span>LEGEND · {label}</span>
        <span style={{ flex: 1, minWidth: 12 }} />
        <span style={{ color: SW_COLORS.muted, fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div
          style={{
            padding: '8px 10px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            overflow: 'auto',
          }}
        >
          {children}
        </div>
      )}
    </StageOverlay>
  );
}
