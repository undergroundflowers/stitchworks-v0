import type { ReactNode } from 'react';
import type { PmlIconComponent } from '../assets/pml-icons';
import { PML_CATEGORY_TINT, SW_COLORS } from '../design/tokens';
import { contrastInk } from '../design/color-utils';

/** Canvas size of a block face — the same square `processLayout` seeds. */
export const PML_FACE_SIZE = 56;

/** Reference geometry, expressed as ratios of the face so a palette tile is a
 *  true miniature of the canvas node rather than a differently-proportioned
 *  cousin. Values are the canvas treatment at 56px. */
const RADIUS_RATIO = 12 / PML_FACE_SIZE;
const ICON_RATIO = 30 / PML_FACE_SIZE;

export interface PmlBlockFaceProps {
  /** PML category — picks the plate colour. Unknown falls back to a neutral. */
  category: string;
  /** The kind's PML glyph. Always what the face draws. */
  Icon: PmlIconComponent;
  size?: number;
  /** Drop preview: translucent plate plus a dashed brand outline. */
  ghost?: boolean;
}

/**
 * One block, drawn once.
 *
 * The BLOCKS palette tile, the PROCESS canvas node and the PROCESS drop ghost
 * all render this, so the thing you pick, the thing that previews under your
 * cursor and the thing that lands are the same object by construction. They
 * used to be three separate treatments, and two of them were *inverted*
 * against each other: the palette drew a coloured glyph on a 14%-tinted well
 * and the canvas drew a white glyph on a solid plate.
 *
 * DIRECTION OF THE MATCH: the canvas wins and the palette adopts it. The
 * canvas is where the object actually lives, and the STATIONS palette next
 * door had already settled the same question the same way by rendering the
 * literal `StationGlyph` in its tiles.
 *
 * Returns a `<g>` in the caller's user space — no viewBox, no nested `<svg>`,
 * no transform of its own — the contract `StationGlyph` already uses, so it
 * drops onto an SVG canvas directly and into an HTML button wrapped in a small
 * `<svg>`.
 *
 * THE FACE DRAWS THE BLOCK KIND, NEVER THE MACHINE. There used to be a `mark`
 * prop that swapped the PML glyph for the station's machine mark and type code
 * whenever `stationMark()` resolved one. It meant the PROCESS canvas — the one
 * view whose entire subject is the block graph — stopped showing block kinds
 * the moment the stations were real sewing machines, so a Service and a Delay
 * were the same picture. Machine identity belongs to the floor and the
 * STATIONS palette; those still draw `StationGlyph` directly.
 */
export function PmlBlockFace({
  category,
  Icon,
  size = PML_FACE_SIZE,
  ghost,
}: PmlBlockFaceProps): ReactNode {
  const tint = PML_CATEGORY_TINT[category] ?? {
    fill: SW_COLORS.paper,
    stroke: SW_COLORS.line,
  };
  const ink = contrastInk(tint.stroke);
  const iconSize = size * ICON_RATIO;

  return (
    <g>
      <rect
        x={0}
        y={0}
        width={size}
        height={size}
        rx={size * RADIUS_RATIO}
        fill={tint.stroke}
        fillOpacity={ghost ? 0.35 : 1}
      />

      <Icon
        size={iconSize}
        color={ink}
        x={(size - iconSize) / 2}
        y={(size - iconSize) / 2}
      />

      {ghost && (
        <rect
          x={0}
          y={0}
          width={size}
          height={size}
          rx={size * RADIUS_RATIO}
          fill="none"
          stroke={SW_COLORS.brand}
          strokeWidth={2}
          strokeDasharray="3 2"
        />
      )}
    </g>
  );
}
