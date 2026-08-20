import { SW_COLORS, SW_FONTS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { MACHINE_GLYPH_FAMILY, glyphMark } from '../domain/machine-glyphs';
import type { MachineCode } from '../domain/machines';

interface StationGlyphProps {
  /** Machine code — draws the family mark plus the code as its label. */
  code?: MachineCode;
  /** Non-machine fixture (rack, trolley, buffer): label only, no mark. */
  label?: string;
  /** Box to fill, in the parent's user space. Drawn from (0,0). */
  width: number;
  height: number;
  /** Zones read as regions, not equipment — let the floor grid show through. */
  muted?: boolean;
}

/**
 * A workstation as a neutral box with one geometric mark and its type code.
 *
 * Replaces `assets/workstations.tsx`, which drew thirteen hand-illustrated
 * machine heads. See `domain/machine-glyphs.ts` for the mark vocabulary and
 * why it is monochrome.
 *
 * Returns a `<g>` in the parent's user space — not a nested `<svg>`. The old
 * module letterboxed itself into a fixed viewBox, which was only ever needed
 * because the artwork was drawn at a fixed size; plain primitives can just be
 * drawn at the size asked for.
 */
export function StationGlyph({
  code,
  label,
  width,
  height,
  muted,
}: StationGlyphProps) {
  const min = Math.min(width, height);

  // Degrade rather than render mush. Below ~22px there is no room for a
  // readable code under the mark; below ~14px the mark itself stops reading
  // and the footprint alone is the honest signal.
  const showCode = height >= 22 && min >= 14;
  const showMark = min >= 14;

  const hasMark = showMark && !!code;
  // The mark spans half the station's short side — big enough to read at a
  // glance on a 30-station floor, small enough to leave the footprint legible.
  const s = min * 0.5;
  const cx = width / 2;
  const cy = showCode ? height * 0.42 : height / 2;
  const fontSize = Math.max(7, Math.min(10, height * 0.2));
  // With a mark above it the code sits on the floor of the box; alone (a rack,
  // a trolley — anything with no mechanism to draw) it centres instead.
  const textY = hasMark ? height - 5 : height / 2 + fontSize / 3;

  return (
    <g>
      <rect
        x={0.5}
        y={0.5}
        width={Math.max(0, width - 1)}
        height={Math.max(0, height - 1)}
        rx={2}
        fill={SW_COLORS.steel}
        fillOpacity={muted ? 0.35 : 1}
        stroke={alpha(SW_COLORS.ink, 0.22)}
        strokeWidth={1}
      />

      <g>
        {hasMark && glyphMark(MACHINE_GLYPH_FAMILY[code], cx, cy, s, SW_COLORS.muted)}

        {showCode && (code || label) && (
          <text
            x={cx}
            y={textY}
            textAnchor="middle"
            fontFamily={SW_FONTS.mono}
            fontSize={fontSize}
            fontWeight={800}
            fill={alpha(SW_COLORS.ink, 0.55)}
            style={{ pointerEvents: 'none', letterSpacing: '0.06em' }}
          >
            {code ?? label?.slice(0, 10).toUpperCase()}
          </text>
        )}
      </g>
    </g>
  );
}
