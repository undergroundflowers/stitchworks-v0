import type { ReactNode } from 'react';
import { visibleCellRange, type Cam } from '../domain/camera';
import type { Projection } from '../domain/iso';
import { SW_COLORS, SW_FONTS } from '../design/tokens';

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
 * ORIGIN AND AXES ARE PART OF THE RULING. The lattice on its own is a
 * texture — every cell looks like every other cell, so a coordinate readout
 * like the Inspector's "Position (cells)" has nothing to be read against and
 * the numbers are unfalsifiable. The `x = 0` and `y = 0` rules are therefore
 * drawn several alpha steps above the cell tier, the origin is marked, and
 * both axes carry numeric ticks at a zoom-chosen interval. That makes the
 * ruling a coordinate system rather than wallpaper, on all three canvases at
 * once.
 *
 * Renders a bare fragment of `<line>` / `<text>` in the caller's user space;
 * the caller places it inside its own pan/zoom `<g>`.
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

  // ── Axes ────────────────────────────────────────────────────────────────
  // Only drawn when the axis is actually in frame. `visibleCellRange` already
  // pads the range, so the test is just "does the visible span straddle 0".
  const yAxisVisible = minX <= 0 && maxX >= 0;   // the x = 0 rule
  const xAxisVisible = minY <= 0 && maxY >= 0;   // the y = 0 rule

  if (yAxisVisible) {
    const a = P(0, minY);
    const b = P(0, maxY);
    lines.push(
      <line key="axis-x0" x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy}
            stroke={SW_COLORS.gridAxis} strokeWidth={1.2 / cam.z} />,
    );
  }
  if (xAxisVisible) {
    const a = P(minX, 0);
    const b = P(maxX, 0);
    lines.push(
      <line key="axis-y0" x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy}
            stroke={SW_COLORS.gridAxis} strokeWidth={1.2 / cam.z} />,
    );
  }

  // ── Ticks ───────────────────────────────────────────────────────────────
  // Label every `tickStep` cells, chosen so consecutive labels stay at least
  // MIN_TICK_PX apart on screen however far the user has zoomed out. Pitch is
  // measured through the projection rather than assumed, so the ISO lattice —
  // whose cells are wider than they are tall — gets a step that suits the
  // diamond instead of the square.
  const MIN_TICK_PX = 72;
  const o = P(0, 0);
  const px = P(1, 0);
  const py = P(0, 1);
  const pitchX = Math.hypot(px.sx - o.sx, px.sy - o.sy) * cam.z;
  const pitchY = Math.hypot(py.sx - o.sx, py.sy - o.sy) * cam.z;
  const stepFor = (pitchPx: number) => {
    // 1, 2, 5, 10, 20, 50, … — the standard ruler progression.
    const LADDER = [1, 2, 5];
    for (let decade = 1; decade <= 1e4; decade *= 10) {
      for (const m of LADDER) {
        if (m * decade * pitchPx >= MIN_TICK_PX) return m * decade;
      }
    }
    return 1e5;
  };
  const stepX = stepFor(Math.max(pitchX, 0.001));
  const stepY = stepFor(Math.max(pitchY, 0.001));

  // Counter-scaled so a label is the same physical size at every zoom — a
  // label that scales with the canvas is unreadable at 0.2x and absurd at 6x.
  const fontSize = 10 / cam.z;
  const labelOffset = 5 / cam.z;

  if (xAxisVisible) {
    const from = Math.ceil(minX / stepX) * stepX;
    for (let x = from; x <= maxX; x += stepX) {
      if (x === 0) continue;
      const t = P(x, 0);
      lines.push(
        <text key={`tx-${x}`} x={t.sx} y={t.sy + labelOffset}
              fill={SW_COLORS.gridAxisText} fontSize={fontSize}
              fontFamily={SW_FONTS.mono} textAnchor="middle"
              dominantBaseline="hanging" style={{ pointerEvents: 'none' }}>
          {x}
        </text>,
      );
    }
  }
  if (yAxisVisible) {
    const from = Math.ceil(minY / stepY) * stepY;
    for (let y = from; y <= maxY; y += stepY) {
      if (y === 0) continue;
      const t = P(0, y);
      lines.push(
        <text key={`ty-${y}`} x={t.sx - labelOffset} y={t.sy}
              fill={SW_COLORS.gridAxisText} fontSize={fontSize}
              fontFamily={SW_FONTS.mono} textAnchor="end"
              dominantBaseline="middle" style={{ pointerEvents: 'none' }}>
          {y}
        </text>,
      );
    }
  }

  // ── Origin ──────────────────────────────────────────────────────────────
  // Marked even when only one axis is on screen: the corner of the viewport
  // still tells the user which way 0 lies.
  if (xAxisVisible && yAxisVisible) {
    const r = 3 / cam.z;
    lines.push(
      <circle key="origin-dot" cx={o.sx} cy={o.sy} r={r}
              fill={SW_COLORS.gridAxisText} style={{ pointerEvents: 'none' }} />,
      <text key="origin-label" x={o.sx - labelOffset - r} y={o.sy + labelOffset}
            fill={SW_COLORS.gridAxisText} fontSize={fontSize}
            fontFamily={SW_FONTS.mono} textAnchor="end"
            dominantBaseline="hanging" style={{ pointerEvents: 'none' }}>
        0,0
      </text>,
    );
  }

  return <>{lines}</>;
}
