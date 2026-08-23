import type { ReactNode } from 'react';
import { visibleCellRange, type Cam } from '../domain/camera';
import type { Projection } from '../domain/iso';
import { SW_COLORS } from '../design/tokens';

/**
 * The ruling on every canvas in the Builder — 2D, ISO and PROCESS.
 *
 * The three views used to draw their own. The floor ruled 40px cells through
 * its projection with four zoom tiers at ~3–7% alpha; the PROCESS graph ruled
 * a flat 24px lattice, one tier, at 50% alpha. Same product, two different
 * sheets of paper, and switching tabs read as switching applications.
 *
 * PITCH COMES FROM THE PROJECTION, NOT A PROP. `flatProj` already multiplies
 * by `FLAT_CELL`, so passing `FLAT_PROJECTION` from the PROCESS canvas — whose
 * world units are plain pixels — lays lines every 40 world px, exactly the
 * floor's pitch at the same zoom. Adding a `cell` prop would hand the two
 * views a knob to drift apart on again, which is the whole bug class this
 * closes. If a canvas needs a different pitch, it needs a different
 * projection.
 *
 * Renders a bare fragment of `<line>` in the caller's user space; the caller
 * places it inside its own pan/zoom `<g>`.
 */
export function CanvasGrid({
  projection,
  cam,
  stageSize,
  pad = 4,
}: {
  projection: Projection;
  cam: Cam;
  stageSize: { w: number; h: number };
  /** Cells of overdraw beyond the viewport, so a pan never reveals an edge. */
  pad?: number;
}): ReactNode {
  const P = projection.project;
  const { minX, maxX, minY, maxY } = visibleCellRange(projection, cam, stageSize, pad);

  // Subdivision density. Each integer cell divides into more sub-cells as the
  // user zooms in, the steps tuned so the next tier arrives just as the
  // previous becomes too coarse to track sub-cell sizing in the inspector.
  // At 0.2× (the zoom floor) a viewport is ~320 cells wide, so the cap on line
  // count is the viewport and the zoom floor — never the content.
  const subdivisions = cam.z < 0.9 ? 1 : cam.z < 1.6 ? 2 : cam.z < 2.4 ? 4 : 8;

  const lines: ReactNode[] = [];

  // Sub-cell tier first, so it sits *under* the cell tier and cell boundaries
  // stay visually dominant however far the grid subdivides.
  if (subdivisions > 1) {
    for (let i = 0; i <= (maxX - minX) * subdivisions; i++) {
      if (i % subdivisions === 0) continue;
      const x = minX + i / subdivisions;
      const a = P(x, minY);
      const b = P(x, maxY);
      lines.push(
        <line key={`vs-${i}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy}
              stroke={SW_COLORS.gridLineSub} strokeWidth={0.3} />,
      );
    }
    for (let i = 0; i <= (maxY - minY) * subdivisions; i++) {
      if (i % subdivisions === 0) continue;
      const y = minY + i / subdivisions;
      const a = P(minX, y);
      const b = P(maxX, y);
      lines.push(
        <line key={`hs-${i}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy}
              stroke={SW_COLORS.gridLineSub} strokeWidth={0.3} />,
      );
    }
  }

  for (let x = minX; x <= maxX; x++) {
    const a = P(x, minY);
    const b = P(x, maxY);
    lines.push(
      <line key={`v-${x}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy}
            stroke={SW_COLORS.gridLine} strokeWidth={0.6} />,
    );
  }
  for (let y = minY; y <= maxY; y++) {
    const a = P(minX, y);
    const b = P(maxX, y);
    lines.push(
      <line key={`h-${y}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy}
            stroke={SW_COLORS.gridLine} strokeWidth={0.6} />,
    );
  }

  return <>{lines}</>;
}
