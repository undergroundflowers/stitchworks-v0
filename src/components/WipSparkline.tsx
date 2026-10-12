/**
 * WipSparkline — the line-level WIP (or throughput) chart on the queueing
 * index. One series over model time: an area wash, a 2px line, and a labelled
 * pair of axes.
 *
 * It used to be a true sparkline — no axes, no grid, two corner captions —
 * drawn into a fixed `1000 × 200` viewBox with `preserveAspectRatio="none"`.
 * That stretch was the root problem: at the width this actually renders, x was
 * scaled about six times harder than y, so the end-of-series dot came out an
 * ellipse and any tick text would have come out condensed. Nothing could be
 * measured off it either — with no y scale, "WIP is somewhere under the max"
 * was the whole reading.
 *
 * So it is drawn in pixel space now, from a measured width. One CSS pixel is
 * one unit on both axes: circles are round, text is text, and hairlines are
 * hairlines. On top of that the axes are real — a y scale on rounded steps
 * with recessive gridlines, time ticks along the bottom — and the pointer gets
 * a snapping crosshair with a readout, so a value can be taken off any sample
 * instead of only the last one.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { SW_COLORS, SW_FONTS } from '../design/tokens';
import type { HistoryPoint } from '../simulation';

export interface WipSparklineProps {
  history: HistoryPoint[];
  height?: number;
  yField?: 'wip' | 'throughputPerHr';
  /** The card colour behind the chart — the ring around the end dot and the
   *  hover dot is drawn in it, so they stay legible over the line. */
  surface?: string;
}

/** Plot insets. Left holds the y tick labels, bottom the time ticks. */
const PAD = { top: 10, right: 12, bottom: 20, left: 46 };
/** Width assumed for the first paint, before the observer reports the real one. */
const FALLBACK_W = 640;

export function WipSparkline({
  history,
  height = 168,
  yField = 'wip',
  surface = SW_COLORS.paper,
}: WipSparklineProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_W);
  // Index of the sample under the pointer / keyboard cursor; null when idle.
  const [cursor, setCursor] = useState<number | null>(null);

  // Pixel-space rendering needs the real width. Measure it rather than letting
  // the viewBox stretch — see the note at the top of the file.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const sync = () => setWidth(Math.max(160, el.clientWidth));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const enough = history.length >= 2;
  const yLabel = yField === 'wip' ? 'WIP' : 'OUT/hr';

  // Every sample is in play for the cursor, so the pointer handler needs the
  // same scales the marks use. Declared before the early return would be the
  // hook-order trap, so scales are computed inside a callback instead.
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const tMin = enough ? history[0].time : 0;
  const tMax = enough ? history[history.length - 1].time : 1;
  const span = Math.max(1e-6, tMax - tMin);
  const rawMax = enough ? Math.max(...history.map((h) => h[yField])) : 0;
  const ticks = niceTicks(rawMax);
  const yMax = ticks[ticks.length - 1];
  // Precision is a property of the scale, not of each value: a column
  // reading 0 / 5.0 / 10 / 15 looks like a typo. One decimal count, taken
  // from the step, applied to every tick on the axis.
  const yStep = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const yDec = yStep >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(yStep)));

  const xAt = useCallback(
    (t: number) => PAD.left + ((t - tMin) / span) * plotW,
    [tMin, span, plotW],
  );
  const yAt = useCallback(
    (v: number) => PAD.top + (1 - v / yMax) * plotH,
    [yMax, plotH],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!enough) return;
      const box = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - box.left;
      // Snap to the nearest sample: the reader aims at a moment in the run,
      // never at a 2px line.
      const frac = (px - PAD.left) / plotW;
      const t = tMin + Math.min(1, Math.max(0, frac)) * span;
      let best = 0;
      for (let i = 1; i < history.length; i++) {
        if (Math.abs(history[i].time - t) < Math.abs(history[best].time - t)) best = i;
      }
      setCursor(best);
    },
    [enough, history, plotW, span, tMin],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (!enough) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setCursor((c) => {
        const from = c ?? history.length - 1;
        const next = from + (e.key === 'ArrowRight' ? 1 : -1);
        return Math.min(history.length - 1, Math.max(0, next));
      });
    },
    [enough, history.length],
  );

  if (!enough) {
    return (
      <div
        ref={hostRef}
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: SW_FONTS.mono,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.6px',
          color: SW_COLORS.faint,
          border: `1px dashed ${SW_COLORS.line}`,
          borderRadius: 6,
        }}
      >
        WARMING UP — RUN THE SIM TO SEE {yLabel} HISTORY
      </div>
    );
  }

  const pts = history.map((h) => [xAt(h.time), yAt(h[yField])] as const);
  const linePath = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const baseY = (PAD.top + plotH).toFixed(1);
  const areaPath =
    `M${pts[0][0].toFixed(1)} ${baseY} ` +
    pts.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') +
    ` L${pts[pts.length - 1][0].toFixed(1)} ${baseY} Z`;

  const last = history[history.length - 1];
  // Clamped on read rather than reset by an effect: the series grows every
  // few sim-minutes, and a cursor held past a shrink is a render-time detail,
  // not state worth a second pass.
  const at = cursor == null ? null : Math.min(cursor, history.length - 1);
  const active = at == null ? null : history[at];
  const { ticks: xTicks, stepMin } = timeTicks(tMin, tMax);

  return (
    <div ref={hostRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block', touchAction: 'none', outline: 'none' }}
        role="img"
        tabIndex={0}
        aria-label={`${yLabel} over model time — now ${fmtValue(last[yField])}, peak ${fmtValue(rawMax)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={onKey}
        onBlur={() => setCursor(null)}
      >
        {/* Y grid + scale. Recessive hairlines on rounded steps — they carry
            every value that isn't directly labelled. */}
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yAt(v)}
              y2={yAt(v)}
              stroke={v === 0 ? SW_COLORS.lineSoft : SW_COLORS.gridLine}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={PAD.left - 8}
              y={yAt(v)}
              textAnchor="end"
              dominantBaseline="middle"
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontVariantNumeric: 'tabular-nums',
                fill: SW_COLORS.faint,
              }}
            >
              {v.toFixed(yDec)}
            </text>
          </g>
        ))}

        {/* Axis titles ride the gutters, so no legend box is needed — one
            series, named by the scale it is drawn against. */}
        <text
          transform={`translate(11 ${PAD.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.12em',
            fill: SW_COLORS.muted,
          }}
        >
          {yLabel}
        </text>

        <path d={areaPath} fill={SW_COLORS.brand} opacity={0.1} />
        <path
          d={linePath}
          fill="none"
          stroke={SW_COLORS.brand}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* X scale. Ticks on rounded time steps, plus the run's own end. */}
        {xTicks.map((t) => {
          const x = xAt(t);
          return (
            <text
              key={t}
              x={x}
              y={height - 6}
              // A middle-anchored label at either end would hang off the
              // plot; the ends anchor inward instead.
              textAnchor={
                x < PAD.left + 12 ? 'start' : x > width - PAD.right - 12 ? 'end' : 'middle'
              }
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontVariantNumeric: 'tabular-nums',
                fill: SW_COLORS.faint,
              }}
            >
              {fmtTick(t, stepMin)}
            </text>
          );
        })}

        {/* End dot, ringed in the surface so it clears the line under it. */}
        <circle
          cx={pts[pts.length - 1][0]}
          cy={pts[pts.length - 1][1]}
          r={4}
          fill={SW_COLORS.brand}
          stroke={surface}
          strokeWidth={2}
        />

        {/* Crosshair. Snaps to the nearest sample — see `onMove`. */}
        {active && at != null && (
          <g pointerEvents="none">
            <line
              x1={pts[at][0]}
              x2={pts[at][0]}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke={SW_COLORS.line}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <circle
              cx={pts[at][0]}
              cy={pts[at][1]}
              r={4.5}
              fill={SW_COLORS.brand}
              stroke={surface}
              strokeWidth={2}
            />
          </g>
        )}
      </svg>

      {/* Readout. Value leads, label follows — the reader has the series and
          wants the number. Pinned to whichever half of the plot the cursor
          isn't in, so it never covers the point it describes. */}
      {active && at != null && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: pts[at][0] > PAD.left + plotW / 2 ? PAD.left + 4 : undefined,
            right: pts[at][0] > PAD.left + plotW / 2 ? undefined : PAD.right + 4,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            padding: '3px 8px',
            borderRadius: 5,
            background: SW_COLORS.overlay,
            border: `1px solid ${SW_COLORS.lineSoft}`,
            fontFamily: SW_FONTS.mono,
            whiteSpace: 'nowrap',
          }}
        >
          <span
            aria-hidden
            style={{ width: 10, height: 2, borderRadius: 1, background: SW_COLORS.brand }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: SW_COLORS.ink }}>
            {fmtValue(active[yField])}
          </span>
          <span style={{ fontSize: 10, color: SW_COLORS.muted }}>
            {yLabel} · t = {fmtTime(active.time)}
          </span>
        </div>
      )}

      {/* Idle summary, in the same slot the readout takes over on hover. */}
      {!active && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: PAD.right + 4,
            pointerEvents: 'none',
            display: 'flex',
            gap: 10,
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.5px',
            color: SW_COLORS.muted,
          }}
        >
          <span>
            PEAK <span style={{ color: SW_COLORS.ink }}>{fmtValue(rawMax)}</span>
          </span>
          <span>
            NOW <span style={{ color: SW_COLORS.ink }}>{fmtValue(last[yField])}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Axis steps on rounded numbers — 0/5/10/15, never 0/3.7/7.4. Returns the
 * ticks including 0 and the rounded-up top, which is also the y maximum, so
 * the top gridline is the top of the plot instead of a line floating below a
 * headroom band nobody can read.
 */
function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Time steps a clock actually divides on, in model minutes. */
const TIME_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

/**
 * Time ticks on whole steps — 0h / 2h / 4h / 6h / 8h. Dividing the run into
 * four equal parts instead put the labels wherever the run happened to have
 * reached ("2.7h", "5.3h"), which is a reading nobody takes off an axis. The
 * ladder above is the one a shift is actually spoken in.
 */
function timeTicks(tMin: number, tMax: number, target = 4): { ticks: number[]; stepMin: number } {
  if (!(tMax > tMin)) return { ticks: [tMin], stepMin: 1 };
  const want = (tMax - tMin) / target;
  const stepMin = TIME_STEPS_MIN.find((s) => s >= want) ?? TIME_STEPS_MIN[TIME_STEPS_MIN.length - 1];
  const ticks: number[] = [];
  for (let v = Math.ceil(tMin / stepMin) * stepMin; v <= tMax + 1e-6; v += stepMin) ticks.push(v);
  return { ticks: ticks.length ? ticks : [tMin, tMax], stepMin };
}

/** Axis tick label. Whole-hour steps print in hours so "0h" sits under "2h". */
function fmtTick(t: number, stepMin: number): string {
  if (!Number.isFinite(t)) return '—';
  if (stepMin >= 60) {
    const h = t / 60;
    return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)}h`;
  }
  return `${Math.round(t)}m`;
}

/** A single value in prose — the readout, the peak/now summary, the label.
 *  Carries a decimal only when it has one, unlike the axis, which is uniform
 *  across its ticks by construction. */
function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return v.toLocaleString();
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1);
}

function fmtTime(simMinutes: number): string {
  if (!Number.isFinite(simMinutes)) return '—';
  if (simMinutes < 60) return `${simMinutes.toFixed(0)}m`;
  const h = simMinutes / 60;
  return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)}h`;
}
