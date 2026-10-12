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
  | 'back'
  | 'collapseAll'
  | 'expandAll'
  | 'eye'
  | 'eyeOff'
  | 'play'
  | 'pause'
  | 'rewind'
  | 'clock'
  | 'help'
  | 'plus'
  | 'duplicate'
  | 'reset'
  | 'bulletin'
  | 'import';

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
    // Plus: two strokes, same length, on the grid centre.
    case 'plus':
      return (
        <>
          <path d="M8 3.5v9M3.5 8h9" />
        </>
      );
    // Duplicate: two offset sheets, the front one whole and the back one
    // showing as an L behind it.
    case 'duplicate':
      return (
        <>
          <path d="M5.5 5.5h8v8h-8z" />
          <path d="M10.5 5.5v-3h-8v8h3" />
        </>
      );
    // Reset: a circular arrow back to the start — the same "return it to how
    // it was" gesture as `rewind`, but for state rather than for time.
    case 'reset':
      return (
        <>
          <path d="M3 8a5 5 0 1 0 1.6-3.7" />
          <path d="M2.5 2.5v3.5h3.5" />
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
    // Help: the question mark's hook and tittle, drawn on the same grid as
    // the `warn` bang so a "?" affordance and a "!" callout read as the same
    // family. No enclosing circle — the button that hosts it draws that.
    case 'help':
      return (
        <>
          <path d="M5.5 5.5a2.5 2.5 0 1 1 2.5 2.5v1.75" />
          <path d="M8 12.25v.5" />
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
    // Collapse / expand all: two chevrons and the seam they fold onto. The
    // pair is the same drawing mirrored about that seam, so the button reads
    // as one control changing direction rather than two different icons.
    case 'collapseAll':
      return (
        <>
          <path d="M4.5 2l3.5 3.5L11.5 2" />
          <path d="M2.5 8h11" />
          <path d="M4.5 14l3.5-3.5 3.5 3.5" />
        </>
      );
    case 'expandAll':
      return (
        <>
          <path d="M4.5 5.5l3.5-3.5 3.5 3.5" />
          <path d="M2.5 8h11" />
          <path d="M4.5 10.5l3.5 3.5 3.5-3.5" />
        </>
      );
    // Eye / eye-struck: the show-hide pair on report tiles. Same lens
    // outline in both, so the button reads as one control being crossed
    // out rather than swapping to a different drawing.
    case 'eye':
      return (
        <>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
        </>
      );
    case 'eyeOff':
      return (
        <>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
          <path d="M2.5 13.5l11-11" />
        </>
      );
    // Transport glyphs. The `\u25b6` / `\u23ee` text characters these replace carried
    // their own side bearings, which sat the triangle visibly left of the
    // centre of a round button. Drawn on the grid instead, the play triangle
    // is placed by its centroid (x = left + width/3, not the bounding-box
    // centre) so its mass — all of it on the flat left edge — lands on the
    // button's axis.
    case 'play':
      return <path d="M5.6 3.2l7.2 4.8-7.2 4.8z" />;
    case 'pause':
      return <path d="M6 3.4v9.2M10 3.4v9.2" />;
    // Rewind to the start: the wall the run returns to, plus the triangle
    // travelling back into it.
    case 'rewind':
      return (
        <>
          <path d="M3.6 3.4v9.2" />
          <path d="M12.8 3.4l-7.2 4.6 7.2 4.6z" />
        </>
      );
    // Operation bulletin: three ruled rows, each led by its own tick. A
    // garment's breakdown is a numbered list of operations, so the glyph is
    // the list — not a garment, which would claim the sheet is about cloth.
    case 'bulletin':
      return (
        <>
          <path d="M2.5 4h1" />
          <path d="M6 4h7.5" />
          <path d="M2.5 8h1" />
          <path d="M6 8h7.5" />
          <path d="M2.5 12h1" />
          <path d="M6 12h7.5" />
        </>
      );
    // Dial and two hands. Not a gear: the panel it opens does not configure
    // the app, it says what one tick of the run's clock means and where that
    // clock starts on the calendar — so the glyph is the clock itself.
    case 'clock':
      return (
        <>
          <circle cx="8" cy="8" r="5.8" />
          <path d="M8 4.6V8l2.6 1.6" />
        </>
      );
    // Arrow dropping into an open tray — a file coming in from outside the
    // app. The mirror of the tray-out glyph an export would use, so import
    // and export read as one pair rather than two unrelated marks.
    case 'import':
      return (
        <>
          <path d="M8 2.5v7.5" />
          <path d="M4.8 7l3.2 3.2 3.2-3.2" />
          <path d="M2.5 11v2.5h11v-2.5" />
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
