/**
 * The two halves of a collapsible side panel, shared by every three-column
 * surface in the app.
 *
 * `PaneCollapseButton` is the « / » in a panel's header that folds it away;
 * `CollapsedRail` is the thin stub it leaves behind, which is entirely a hit
 * target so getting the panel back is one click anywhere on the strip.
 *
 * These started life inside the Builder. The Queue Lab is deliberately built
 * on the same three-column shell, so the collapse behaviour lives here rather
 * than being drawn a second time and drifting.
 */

import { useState } from 'react';
import { SW_COLORS, SW_CONTROL, SW_FONTS, SW_MOTION, SW_RADIUS } from '../design/tokens';

/** Width of the thin stub a side panel leaves behind when collapsed. Wide
 *  enough for the chevron + vertical label, narrow enough that the middle
 *  column gets almost the whole window back. */
export const RAIL_W = 26;

export interface CollapsedRailProps {
  /** Which edge the panel came from — sets the border and which way the
   *  chevron points (back toward the middle of the screen). */
  side: 'left' | 'right';
  /** Shown vertically down the stub. Also the tooltip, lowercased. */
  label: string;
  onExpand: () => void;
  /** Placement, when the stub sits in a grid the caller owns. */
  style?: React.CSSProperties;
}

/**
 * The stub a collapsed side panel leaves in its column: a vertical label plus
 * a chevron pointing back toward the edge it came from.
 */
export function CollapsedRail({ side, label, onExpand, style }: CollapsedRailProps) {
  const [hover, setHover] = useState(false);
  const edge = `1px solid ${SW_COLORS.line}`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onExpand();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Show ${label.toLowerCase()}`}
      aria-label={`Show ${label.toLowerCase()}`}
      style={{
        ...(side === 'left' ? { borderRight: edge } : { borderLeft: edge }),
        background: hover ? SW_COLORS.paperEdge : SW_COLORS.paper,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '10px 0',
        cursor: 'pointer',
        userSelect: 'none',
        overflow: 'hidden',
        transition: 'background 120ms ease',
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 12,
          fontWeight: 800,
          lineHeight: 1,
          color: hover ? SW_COLORS.brand : SW_COLORS.muted,
        }}
      >
        {side === 'left' ? '»' : '«'}
      </span>
      <span
        style={{
          writingMode: 'vertical-rl',
          fontFamily: SW_FONTS.display,
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: '0.18em',
          color: hover ? SW_COLORS.ink : SW_COLORS.muted,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  );
}

export interface PaneCollapseButtonProps {
  side: 'left' | 'right';
  onClick: () => void;
  /** What the tooltip calls the panel — "palette", "systems", "parameters". */
  label: string;
}

/** The « / » button a side panel header uses to collapse itself to a rail. */
export function PaneCollapseButton({ side, onClick, label }: PaneCollapseButtonProps) {
  const [hover, setHover] = useState(false);
  const title = `Collapse ${label.toLowerCase()}`;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      aria-label={title}
      style={{
        // Square, on the shared header-row unit: the left « and the right »
        // are the same control mirrored, and both sit level with whatever
        // chips or actions share the header with them.
        width: SW_CONTROL.icon,
        height: SW_CONTROL.icon,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: `1px solid ${hover ? SW_COLORS.ink : SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1,
        fontFamily: SW_FONTS.mono,
        fontSize: 15,
        fontWeight: 800,
        color: hover ? SW_COLORS.ink : SW_COLORS.muted,
        transition: `border-color ${SW_MOTION.instant}ms linear, color ${SW_MOTION.instant}ms linear`,
      }}
    >
      {side === 'left' ? '«' : '»'}
    </button>
  );
}
