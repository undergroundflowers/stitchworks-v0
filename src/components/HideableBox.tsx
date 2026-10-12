import { useState, type ReactNode, type CSSProperties } from 'react';
import { SW_COLORS, SW_CONTROL, SW_RADIUS, SW_SHADOWS } from '../design/tokens';
import { Icon } from './Icon';

interface HideableBoxProps {
  children: ReactNode;
  defaultHidden?: boolean;
  style?: CSSProperties;
  toggleOffset?: number;
  toggleSize?: number;
}

/** Wraps any report tile/card with an eye toggle in the top-right corner.
 *  Clicking the toggle blurs the wrapped content and disables pointer
 *  events on it, while the toggle itself stays sharp and clickable.
 *
 *  The toggle is a standard square icon button: `SW_CONTROL.icon` on a
 *  raised surface step above the card it floats on. It used to paint a
 *  near-white `rgba(255,255,255,0.92)` pill carrying `SW_COLORS.muted`
 *  glyphs — a light-theme leftover that, once `muted` became ink-alpha on a
 *  dark ground, drew a near-white eye on a near-white chip. */
export function HideableBox({
  children,
  defaultHidden = false,
  style,
  toggleOffset = 10,
  toggleSize = SW_CONTROL.icon,
}: HideableBoxProps) {
  const [hidden, setHidden] = useState(defaultHidden);
  const [hover, setHover] = useState(false);
  const iconSize = Math.max(12, toggleSize - 14);
  return (
    <div style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setHidden((h) => !h);
        }}
        title={hidden ? 'Show section' : 'Hide section'}
        aria-label={hidden ? 'Show section' : 'Hide section'}
        aria-pressed={hidden}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'absolute',
          top: toggleOffset,
          right: toggleOffset,
          zIndex: 6,
          width: toggleSize,
          height: toggleSize,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: hidden
            ? SW_COLORS.brand
            : hover
              ? SW_COLORS.steelLite
              : SW_COLORS.steel,
          color: hidden ? SW_COLORS.paper : hover ? SW_COLORS.ink : SW_COLORS.muted,
          border: `1px solid ${hidden ? SW_COLORS.brand : hover ? SW_COLORS.faint : SW_COLORS.line}`,
          borderRadius: SW_RADIUS.sm,
          padding: 0,
          cursor: 'pointer',
          boxShadow: SW_SHADOWS.pop,
          transition: 'background 140ms, color 140ms, border-color 140ms',
        }}
      >
        <Icon name={hidden ? 'eyeOff' : 'eye'} size={iconSize} />
      </button>
      <div
        aria-hidden={hidden}
        style={{
          filter: hidden ? 'blur(10px)' : 'none',
          pointerEvents: hidden ? 'none' : 'auto',
          userSelect: hidden ? 'none' : 'auto',
          transition: 'filter 220ms',
        }}
      >
        {children}
      </div>
    </div>
  );
}
