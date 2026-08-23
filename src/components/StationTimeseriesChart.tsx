/**
 * StationTimeseriesChart — per-station time-series plot for one of the four
 * queueing-theory observables (ρ, L, Wq, Lq). Solid line is what the engine
 * actually saw; dashed horizontal line is the closed-form steady-state target
 * from `queueing.ts::analyticalKpis()`. Convergence of the solid toward the
 * dashed is the visual validation that the sim matches theory.
 *
 * Styled to match WipSparkline.tsx — same viewBox, same area+line+dot
 * primitives, same caption overlay. The Grid wrapper below renders all four
 * charts in a 2×2 layout and wires each metric to its source field and
 * analytical reference automatically.
 *
 * Floor-language labels are the default; the math labels live in tooltips
 * until Phase 2 ships an engineer-view toggle.
 */

import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import type { StationHistoryPoint, StationView } from '../simulation';
import type { QuantityId } from '../simulation/notation';
import { Sym } from './Sym';

export type StationMetric = 'rho' | 'L' | 'Wq' | 'Lq';

export interface StationTimeseriesChartProps {
  history: StationHistoryPoint[];
  metric: StationMetric;
  /** Closed-form steady-state value. NaN ⇒ no dashed line. Infinity ⇒ unstable. */
  analyticalRef: number;
  /** Header above the chart. Defaults to the floor-language label for this metric. */
  caption?: string;
  /** Hover/aria description; defaults to the apparel-floor interpretation. */
  tooltip?: string;
  height?: number;
  color?: string;
}

interface MetricSpec {
  field: keyof StationHistoryPoint;
  caption: string;
  /** The textbook quantity this chart plots. Drives the symbol beside the
   *  caption; see the note in `simulation/notation.ts` on why it is data. */
  quantity: QuantityId;
  tooltip: string;
  color: string;
  unit: string;
  /** Formatter for the "now" / "target" numeric labels. */
  fmt: (v: number) => string;
}

const METRICS: Record<StationMetric, MetricSpec> = {
  rho: {
    field: 'utilization',
    caption: 'Operator saturation',
    quantity: 'rho',
    tooltip:
      'How much of her shift this operator is actually sewing. 85%+ sustained = this is the slowest station; bundles will stack up behind her.',
    color: SW_COLORS.brand,
    unit: '%',
    fmt: (v) => `${(v * 100).toFixed(0)}%`,
  },
  L: {
    field: 'inSystem',
    caption: 'Bundles at station',
    quantity: 'L',
    tooltip:
      'All bundles physically here — being sewn plus waiting. Multiply by bundle size to see pieces tied up at this seat.',
    color: SW_COLORS.bobbin,
    unit: '',
    fmt: (v) => v.toFixed(1),
  },
  Wq: {
    field: 'meanWqMin',
    caption: 'Bundle wait time',
    quantity: 'Wq',
    tooltip:
      'Average minutes a fresh bundle sits on the cart before this operator picks it up. Long wait = upstream is overproducing.',
    color: SW_COLORS.press,
    unit: ' min',
    fmt: (v) => `${v.toFixed(1)} min`,
  },
  Lq: {
    field: 'queueLen',
    caption: 'Bundles waiting',
    quantity: 'Lq',
    tooltip:
      'The visible pile on her left — bundles not yet started. This is the WIP a manager sees on a floor walk.',
    color: SW_COLORS.warn,
    unit: '',
    fmt: (v) => v.toFixed(1),
  },
};

const W = 1000; // SVG viewBox width
const H = 200;  // SVG viewBox height
const PAD_X = 6;
const PAD_Y = 8;

export function StationTimeseriesChart({
  history,
  metric,
  analyticalRef,
  caption,
  tooltip,
  height = 90,
  color,
}: StationTimeseriesChartProps) {
  const spec = METRICS[metric];
  const seriesColor = color ?? spec.color;
  const headerCaption = caption ?? spec.caption;
  // A caller-supplied caption is free text, so only the built-in ones name a
  // quantity we can attach a symbol to.
  const headerQuantity = caption ? undefined : spec.quantity;
  const hoverText = tooltip ?? spec.tooltip;

  if (history.length < 2) {
    return (
      <div title={hoverText}>
        <ChartHeader caption={headerCaption} quantity={headerQuantity} />
        <div
          style={{
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.5px',
            color: SW_COLORS.faint,
            border: `1px dashed ${SW_COLORS.line}`,
            borderRadius: SW_RADIUS.sm,
          }}
        >
          WARMING UP
        </div>
      </div>
    );
  }

  const values = history.map((h) => h[spec.field] as number);
  const observedMax = Math.max(...values);
  const refIsFinite = Number.isFinite(analyticalRef);
  const refIsInfinite = analyticalRef === Infinity;

  // Pick a y-max that always shows the dashed reference. For ρ, anchor at
  // 1.0 so the "100% saturated" line reads as the natural ceiling.
  let yMax: number;
  if (metric === 'rho') {
    yMax = Math.max(observedMax, refIsFinite ? analyticalRef : 0, 1) * 1.05;
  } else {
    yMax = Math.max(observedMax, refIsFinite ? analyticalRef : 0, 0.5) * 1.1;
  }
  if (!Number.isFinite(yMax) || yMax <= 0) yMax = 1;

  const tMin = history[0].time;
  const tMax = history[history.length - 1].time;
  const span = Math.max(1, tMax - tMin);

  const points = history.map((h) => {
    const x = PAD_X + ((h.time - tMin) / span) * (W - PAD_X * 2);
    const v = h[spec.field] as number;
    const y = PAD_Y + (1 - v / yMax) * (H - PAD_Y * 2);
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const areaPath =
    `M${points[0][0].toFixed(1)} ${(H - PAD_Y).toFixed(1)} ` +
    points.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') +
    ` L${points[points.length - 1][0].toFixed(1)} ${(H - PAD_Y).toFixed(1)} Z`;

  const last = values[values.length - 1];

  // Analytical reference line. Inf → render at top edge in alarm color.
  let refY: number | null = null;
  let refLabel: string = '';
  let refColor: string = SW_COLORS.muted;
  if (refIsFinite) {
    refY = PAD_Y + (1 - analyticalRef / yMax) * (H - PAD_Y * 2);
    refLabel = `Target ${spec.fmt(analyticalRef)}`;
    refColor = SW_COLORS.muted;
  } else if (refIsInfinite) {
    refY = PAD_Y + 4;
    refLabel = 'Target ∞ (unstable)';
    refColor = SW_COLORS.alarm;
  }

  return (
    <div title={hoverText}>
      <ChartHeader caption={headerCaption} quantity={headerQuantity} />
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height, display: 'block' }}
          role="img"
          aria-label={`${headerCaption} over time`}
        >
          <line
            x1={PAD_X}
            x2={W - PAD_X}
            y1={H - PAD_Y}
            y2={H - PAD_Y}
            stroke={SW_COLORS.line}
            strokeWidth={1}
          />
          <path d={areaPath} fill={`${seriesColor}1A`} />
          <path
            d={linePath}
            fill="none"
            stroke={seriesColor}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {refY != null && (
            <>
              <line
                x1={PAD_X}
                x2={W - PAD_X}
                y1={refY}
                y2={refY}
                stroke={refColor}
                strokeWidth={1.5}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={W - PAD_X - 6}
                y={Math.max(refY - 4, 14)}
                fontFamily={SW_FONTS.mono}
                fontSize={11}
                fontWeight={700}
                fill={refColor}
                textAnchor="end"
              >
                {refLabel}
              </text>
            </>
          )}
          <circle
            cx={points[points.length - 1][0]}
            cy={points[points.length - 1][1]}
            r={5}
            fill={seriesColor}
            stroke={SW_COLORS.paper}
            strokeWidth={2}
          />
        </svg>

        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            padding: '4px 8px',
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.4px',
            color: SW_COLORS.muted,
          }}
        >
          <span>
            now <span style={{ color: SW_COLORS.ink }}>{spec.fmt(last)}</span>
          </span>
          {refIsFinite && (
            <span>
              target <span style={{ color: SW_COLORS.ink }}>{spec.fmt(analyticalRef)}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ChartHeader({ caption, quantity }: { caption: string; quantity?: QuantityId }) {
  return (
    <div
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: 10,
        color: SW_COLORS.muted,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        fontWeight: 700,
        marginBottom: 4,
      }}
    >
      {caption}
      {quantity && (
        <>
          {' '}
          <Sym quantity={quantity} bracketed color={SW_COLORS.brandText} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Grid wrapper — renders all four charts for one station, wires each metric
//  to its source field and analytical reference from `StationView`. Use this
//  as the default surface; reach for the raw chart only when you need a
//  single metric (e.g. the cross-station "compare" view).
// ─────────────────────────────────────────────────────────────────────────

export interface StationTimeseriesGridProps {
  station: StationView;
  history: StationHistoryPoint[];
  /** Override the chart height. Defaults to 90 — comfortable in a 2×2 grid. */
  height?: number;
}

export function StationTimeseriesGrid({
  station,
  history,
  height,
}: StationTimeseriesGridProps) {
  // queueing.ts returns W and Wq in HOURS. Convert to minutes to match
  // engine.recordHistory's `meanWqMin` output.
  const refRho = station.analytical.rho;
  const refL = station.analytical.L;
  const refLq = station.analytical.Lq;
  const refWq = station.analytical.Wq * 60;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 14,
      }}
    >
      <StationTimeseriesChart
        history={history}
        metric="rho"
        analyticalRef={refRho}
        height={height}
      />
      <StationTimeseriesChart
        history={history}
        metric="L"
        analyticalRef={refL}
        height={height}
      />
      <StationTimeseriesChart
        history={history}
        metric="Wq"
        analyticalRef={refWq}
        height={height}
      />
      <StationTimeseriesChart
        history={history}
        metric="Lq"
        analyticalRef={refLq}
        height={height}
      />
    </div>
  );
}
