import type { CSSProperties } from 'react';
import { SW_COLORS, SW_CONTROL, SW_MOTION } from '../design/tokens';

/**
 * One disclosure triangle for the whole app.
 *
 * Every collapsible thing — palette sections, inspector groups, lens
 * sections, the canvas legend, the sim HUD panels — used to draw its own:
 * some swapped glyph (▸ → ▾), some rotated (▶ turned 90°), at 9/10/11px, in
 * boxes 8px or 10px wide, with or without a transition. Side by side in one
 * panel that reads as three different controls.
 *
 * The rule now: ONE glyph that rotates. Closed points right, open points
 * down, and the turn is the animation — so the eye tracks a single object
 * moving instead of two glyphs swapping. The box is square and fixed at
 * `SW_CONTROL.chevron`, so rotating it never nudges the label beside it.
 */
export function Chevron({
  open,
  color = SW_COLORS.muted,
  style,
}: {
  open: boolean;
  /** Override for tinted headers (active lens, HUD-on-canvas). */
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: SW_CONTROL.chevron,
        height: SW_CONTROL.chevron,
        fontSize: 12,
        lineHeight: 1,
        color,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: `transform ${SW_MOTION.instant}ms ${SW_MOTION.standard}`,
        ...style,
      }}
    >
      ▸
    </span>
  );
}

/**
 * The dropdown caret — a *different* job from `Chevron` and deliberately a
 * different glyph. A chevron discloses content in place; a caret says "this
 * opens a menu" (HudSelect, the CONTROLS popover, the factory library). It
 * points down at rest and flips on open, and shares the chevron's box so both
 * occupy the same slot in a header row.
 */
export function Caret({
  open,
  color = SW_COLORS.muted,
  openColor = SW_COLORS.brand,
  style,
}: {
  open: boolean;
  color?: string;
  /** Colour while the menu is open. Pass `color` to disable the tint. */
  openColor?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: SW_CONTROL.chevron,
        height: SW_CONTROL.chevron,
        fontSize: 12,
        lineHeight: 1,
        color: open ? openColor : color,
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: `transform ${SW_MOTION.fast}ms ${SW_MOTION.standard}, color ${SW_MOTION.instant}ms linear`,
        ...style,
      }}
    >
      ▾
    </span>
  );
}
