import type { CSSProperties } from 'react';

/**
 * Stroke-primitive icon set.
 *
 * Same rules as the station glyphs on the canvas: one weight, square caps,
 * no fills, everything drawn in `currentColor` so an icon inherits the tone
 * of whatever chip or button it sits in (brand, alarm, muted, ok). Icons are
 * authored on a 16×16 grid with a 1px inset so the strokes never clip.
 */
export type IconName =
  | 'save'
  | 'saveAs'
  | 'trash'
  | 'alert'
  | 'warn'
  | 'check'
  | 'back';

export interface IconProps {
  name: IconName;
  /** Rendered box in px (square). Defaults to 14 — toolbar chip size. */
  size?: number;
  /** Stroke weight; 1.5 reads correctly at 14–16px. */
  weight?: number;
  style?: CSSProperties;
}

/** Path geometry per icon, on the shared 16×16 grid. */
function paths(name: IconName) {
  switch (name) {
    // Floppy: outer body with a clipped corner, shutter at the top,
    // label plate at the bottom.
    case 'save':
      return (
        <>
          <path d="M2.5 2.5h8.5l2.5 2.5v8.5h-11z" />
          <path d="M5.5 2.5h5v3.5h-5z" />
          <path d="M5 13.5v-3.5h6v3.5" />
        </>
      );
    // Fork: one trunk splitting into two branches — "save as" makes a
    // second twin off the current one.
    case 'saveAs':
      return (
        <>
          <path d="M4.5 13.5v-11" />
          <path d="M4.5 8h4.5a2.5 2.5 0 0 0 2.5-2.5v-3" />
          <circle cx="4.5" cy="13.5" r="1.2" />
          <circle cx="4.5" cy="2.5" r="1.2" />
          <circle cx="11.5" cy="2.5" r="1.2" />
        </>
      );
    // Bin: lid, body, two ribs.
    case 'trash':
      return (
        <>
          <path d="M2.5 4h11" />
          <path d="M6 4V2.5h4V4" />
          <path d="M4 4v9.5h8V4" />
          <path d="M6.5 6.5v5M9.5 6.5v5" />
        </>
      );
    // Blocking error: crossed strokes.
    case 'alert':
      return (
        <>
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </>
      );
    // Non-blocking warning: triangle with a bang.
    case 'warn':
      return (
        <>
          <path d="M8 2.5l6 11h-12z" />
          <path d="M8 6.5v3.5M8 11.75v.5" />
        </>
      );
    case 'check':
      return <path d="M3 8.5l3.5 3.5 6.5-8" />;
    case 'back':
      return (
        <>
          <path d="M13 8h-10" />
          <path d="M6.5 3.5l-4.5 4.5 4.5 4.5" />
        </>
      );
  }
}

export function Icon({ name, size = 14, weight = 1.5, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      focusable="false"
      style={{ display: 'block', flex: 'none', ...style }}
    >
      {paths(name)}
    </svg>
  );
}
