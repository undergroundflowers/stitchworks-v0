import type { ReactNode } from 'react';
import type { PmlIconComponent } from '../assets/pml-icons';
import { glyphFamilyOf, glyphMark, type GlyphFamily } from '../domain/machine-glyphs';
import type { MachineCode } from '../domain/machines';
import { PML_CATEGORY_TINT, SW_COLORS, SW_FONTS } from '../design/tokens';
import { alpha, contrastInk } from '../design/color-utils';

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
  /** The kind's PML glyph. Drawn when the station has no machine mark. */
  Icon: PmlIconComponent;
  /** `stationMark()` result. When it resolves a family, the machine's own mark
   *  and code replace the PML glyph. */
  mark?: { code?: MachineCode; family?: GlyphFamily; markCode?: string };
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
 */
export function PmlBlockFace({
  category,
  Icon,
  mark,
  size = PML_FACE_SIZE,
  ghost,
}: PmlBlockFaceProps): ReactNode {
  const tint = PML_CATEGORY_TINT[category] ?? {
    fill: SW_COLORS.paper,
    stroke: SW_COLORS.line,
  };
  const ink = contrastInk(tint.stroke);
  const family = mark ? glyphFamilyOf(mark) : undefined;
  const code = mark?.code ?? mark?.markCode;

  // Below ~44px there is no room for a readable code under the mark, so the
  // mark alone carries it — the same degradation rule `StationGlyph` uses,
  // scaled to this face.
  const showCode = size >= 44 && !!code;
  const markY = showCode ? size * 0.42 : size / 2;
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

      {family ? (
        <>
          {glyphMark(family, size / 2, markY, size * 0.5, ink)}
          {showCode && (
            <text
              x={size / 2}
              y={size - 7}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={Math.max(7, Math.min(10, size * 0.18))}
              fontWeight={800}
              fill={alpha(ink, 0.75)}
              style={{ pointerEvents: 'none', letterSpacing: '0.06em' }}
            >
              {code}
            </text>
          )}
        </>
      ) : (
        <Icon
          size={iconSize}
          color={ink}
          x={(size - iconSize) / 2}
          y={(size - iconSize) / 2}
        />
      )}

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
