/**
 * Report charts.
 *
 * Extracted verbatim from `Reports.tsx`, where every one of these was a
 * module-private function — so the Sim screen could not reuse a single chart
 * even though it had the same data in hand, and the only way to see a
 * production curve was to leave the run and open Reports.
 *
 * They take plain arrays (`HistoryPoint[]`, station rows), which is what makes
 * them reusable against either data source: a completed multi-replication run
 * for statistical honesty, or the live session for a curve that grows as the
 * shift plays. Nothing in the SVG maths cares which.
 *
 * Every export is memoised. With a shared store ticking five times a second an
 * unmemoised chart re-renders on every tick even when its own data has not
 * changed — and `advanceSlot` hands out fresh array identities precisely so
 * that comparison is meaningful.
 */

import { memo, type ReactNode } from 'react';
import { Stat } from '../Stat';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../../design/tokens';
import type { AggregateKpis } from '../../simulation';

export interface KpiTileProps {
  label: string;
  mean: number;
  std: number;
  unit: string;
  formatter: (value: number) => string;
  color: string;
  info?: ReactNode;
}

/**
 * Per-line cumulative-output chart. Overlays one stroke per sewing line,
 * each in its dept-colour accent, with Y measured in pieces (the engine
 * emits bundle-counted `produced`; we multiply by each line's bundleSize
 * so the unit matches the per-line table above).
 */
function MultiLineHistoryChartBase({
  rows,
}: {
  rows: Array<{ line: { id: string; name: string; color: string }; bundleSize: number; agg: AggregateKpis }>;
}) {
  const w = 600, h = 220;
  const padL = 36, padR = 8, padT = 8, padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const usable = rows.filter((r) => r.agg.averagedHistory.length >= 2);
  if (usable.length === 0) {
    return (
      <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', color: SW_COLORS.muted, fontSize: 12 }}>
        Run a shift to see per-line output.
      </div>
    );
  }

  const maxT = Math.max(...usable.map((r) => r.agg.averagedHistory[r.agg.averagedHistory.length - 1].time));
  const maxPcs = Math.max(
    1,
    ...usable.map((r) => Math.max(...r.agg.averagedHistory.map((p) => p.produced * r.bundleSize))),
  );

  const xs = (t: number) => padL + (t / maxT) * innerW;
  const ys = (v: number) => padT + innerH - (v / maxPcs) * innerH;
  const xTicks = 5;
  const yTicks = 4;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%' }}>
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const v = (maxPcs / yTicks) * i;
        return (
          <g key={i}>
            <line x1={padL} y1={ys(v)} x2={w - padR} y2={ys(v)} stroke={SW_COLORS.line} />
            <text x={padL - 4} y={ys(v) + 3} textAnchor="end" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
              {Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}
      {Array.from({ length: xTicks + 1 }).map((_, i) => {
        const t = (maxT / xTicks) * i;
        return (
          <text key={i} x={xs(t)} y={h - 6} textAnchor="middle" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
            {Math.round(t)}m
          </text>
        );
      })}
      {usable.map((r) => {
        const stroke = DEPT_LINE_COLORS[r.line.color] ?? SW_COLORS.brand;
        const d = r.agg.averagedHistory
          .map((p, i) => `${i ? 'L' : 'M'} ${xs(p.time)} ${ys(p.produced * r.bundleSize)}`)
          .join(' ');
        return <path key={r.line.id} d={d} fill="none" stroke={stroke} strokeWidth="2.5" />;
      })}
    </svg>
  );
}

/** Department-colour palette mirrored from Builder so per-line rows pick up
 *  the same accent the sewing-line strip uses in LiveSim. */
export const DEPT_LINE_COLORS: Record<string, string> = {
  brand: SW_COLORS.brand,
  blue: SW_COLORS.fabric,
  green: SW_COLORS.ok,
  yellow: SW_COLORS.warn,
  red: SW_COLORS.alarm,
  steel: SW_COLORS.steel,
  bobbin: SW_COLORS.bobbin,
  thread: SW_COLORS.thread,
};

/** Renders the structured body of a KPI-tile info popover. */
function KpiFormulaBase({
  formula,
  where,
  note,
  replication,
}: {
  formula: string;
  where?: [string, string][];
  note?: string;
  replication?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: SW_FONTS.mono, fontWeight: 700, color: SW_COLORS.ink }}>
        {formula}
      </div>
      {where && where.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', color: SW_COLORS.muted, textTransform: 'uppercase' }}>
            where
          </div>
          {where.map(([k, v]) => (
            <div key={k} style={{ fontSize: 11, color: SW_COLORS.muted }}>
              <span style={{ color: SW_COLORS.ink, fontWeight: 700 }}>{k}</span> — {v}
            </div>
          ))}
        </div>
      )}
      {note && (
        <div style={{ fontSize: 11, color: SW_COLORS.muted, fontStyle: 'italic' }}>{note}</div>
      )}
      {replication && (
        <div style={{ fontSize: 10, color: SW_COLORS.muted, borderTop: `1px solid ${SW_COLORS.line}`, paddingTop: 6 }}>
          {replication}
        </div>
      )}
    </div>
  );
}

/** Stat tile that gracefully shows ± std when std > 0. */
function KpiTileBase({ label, mean, std, unit, formatter, color, info }: KpiTileProps) {
  return (
    <Stat
      big
      label={label}
      value={
        <>
          {formatter(mean)}
          {std > 0 && (
            <span style={{ fontSize: 12, fontWeight: 700, color: SW_COLORS.muted, marginLeft: 4, fontFamily: SW_FONTS.mono }}>
              ±{formatter(std)}
            </span>
          )}
        </>
      }
      unit={unit}
      color={color}
      info={info}
    />
  );
}

/** Shared chart header with title, sub-text, optional legend chips. Keeps
 *  every chart card visually consistent and gives analysts a one-line read
 *  of what they're looking at and what each colour means. */
function ChartHeaderBase({
  title,
  sub,
  legend,
}: {
  title: string;
  sub: string;
  legend?: Array<{ color: string; label: string; dashed?: boolean }>;
}) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14, paddingRight: 36, gap: 14, flexWrap: 'wrap' }}>
      <div>
        <div style={{ ...SW_TYPE.heading }}>{title}</div>
        <div style={{ fontSize:12, color: SW_COLORS.muted, marginTop: 2, maxWidth: 520, lineHeight: 1.45 }}>{sub}</div>
      </div>
      {legend && legend.length > 0 && (
        <div style={{ display:'flex', gap:12, fontSize:10, fontFamily: SW_FONTS.mono, fontWeight:700, flexWrap: 'wrap', alignItems: 'center', maxWidth: 260 }}>
          {legend.map((l, i) => (
            <span key={i} style={{ display:'inline-flex', alignItems:'center', gap:5, color: SW_COLORS.muted }}>
              {l.dashed ? (
                <span style={{ width: 14, height: 0, borderTop: `2px dashed ${l.color}` }} />
              ) : (
                <span style={{ width: 10, height: 10, background: l.color, borderRadius: 2 }} />
              )}
              <span style={{ letterSpacing: '0.02em' }}>{l.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Inference blurb shown directly under a chart. Three-line max so it
 * stays scannable during the demo narrative. Pass the chart's key insight
 * — the line should answer "what does this say about the factory?", not
 * just describe the chart's axes (those are already in ChartHeader).
 */
function ChartInferenceBase({
  observation,
  inference,
  action,
}: {
  observation: string;
  inference: string;
  action?: string;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 12px',
        background: SW_COLORS.brandLite,
        borderLeft: `3px solid ${SW_COLORS.brand}`,
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.55,
        color: SW_COLORS.ink,
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={{ ...SW_TYPE.overline, fontWeight: 800, color: SW_COLORS.brand, letterSpacing: '0.06em', minWidth: 60 }}>
          OBSERVE
        </span>
        <span>{observation}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <span style={{ ...SW_TYPE.overline, fontWeight: 800, color: SW_COLORS.brand, letterSpacing: '0.06em', minWidth: 60 }}>
          INFER
        </span>
        <span>{inference}</span>
      </div>
      {action && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <span style={{ ...SW_TYPE.overline, fontWeight: 800, color: SW_COLORS.brand, letterSpacing: '0.06em', minWidth: 60 }}>
            ACTION
          </span>
          <span>{action}</span>
        </div>
      )}
    </div>
  );
}

/** Empty-state placeholder for charts that need at least 2 samples. */
function ChartEmptyBase({ height = 200 }: { height?: number }) {
  return (
    <div style={{ height, display:'flex', alignItems:'center', justifyContent:'center', color: SW_COLORS.muted, fontSize: 12 }}>
      Run a shift to populate this chart.
    </div>
  );
}

export interface HistorySeries {
  history: { time: number; produced: number; wip: number; throughputPerHr: number }[];
  targetPerHr?: number;
  warmupMin?: number;
}

/** Cumulative output vs time, with warm-up shading, theoretical-ceiling
 *  reference, and a callout pin at the final value so the analyst doesn't
 *  have to mouse-track to read it. Y-axis is pieces; X-axis is sim-minutes
 *  (480 = end of shift). */
function CumulativeOutputChartBase({ history, targetPerHr = 0, warmupMin = 0 }: HistorySeries) {
  const w = 600, h = 220;
  const padL = 44, padR = 56, padT = 10, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  if (history.length < 2) return <ChartEmpty height={h} />;

  const maxT = Math.max(history[history.length - 1].time, 480);
  // Pieces = bundles for now (history.produced is in engine "agents"); the
  // engine emits whatever the source piecesPerAgent says. For factory-scope
  // sums the multiplier already lives in piecesPerAgent so values are
  // numerically the right magnitude.
  const observedMax = history[history.length - 1].produced;
  const ceilingMax = (targetPerHr * maxT) / 60;
  const maxY = Math.max(observedMax, ceilingMax, 1) * 1.05;

  const xs = (t: number) => padL + (t / maxT) * innerW;
  const ys = (v: number) => padT + innerH - (v / maxY) * innerH;

  const xTicks = 4;
  const yTicks = 4;
  const finalPt = history[history.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width:'100%' }}>
      {/* Warm-up region — first traversal time, shaded grey */}
      {warmupMin > 0 && warmupMin < maxT && (
        <>
          <rect x={padL} y={padT} width={xs(warmupMin) - padL} height={innerH} fill="#0F141908" />
          <line x1={xs(warmupMin)} y1={padT} x2={xs(warmupMin)} y2={padT + innerH} stroke={SW_COLORS.faint} strokeDasharray="3 3" />
          <text x={xs(warmupMin) + 4} y={padT + 11} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700}>
            WARM-UP {Math.round(warmupMin)}m
          </text>
        </>
      )}
      {/* Y gridlines + tick labels */}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const v = (maxY / yTicks) * i;
        return (
          <g key={i}>
            <line x1={padL} y1={ys(v)} x2={w - padR} y2={ys(v)} stroke={SW_COLORS.line} />
            <text x={padL - 6} y={ys(v) + 3} textAnchor="end" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
              {Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}
      {/* X tick labels */}
      {Array.from({ length: xTicks + 1 }).map((_, i) => {
        const t = (maxT / xTicks) * i;
        return (
          <text key={i} x={xs(t)} y={h - 12} textAnchor="middle" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
            {Math.round(t)}m
          </text>
        );
      })}
      {/* Theoretical ceiling line (dashed) */}
      {targetPerHr > 0 && (
        <line
          x1={xs(0)} y1={ys(0)}
          x2={xs(maxT)} y2={ys(ceilingMax)}
          stroke={SW_COLORS.faint} strokeWidth="1.5" strokeDasharray="5 4"
        />
      )}
      {/* Observed cumulative produced */}
      <path
        d={history.map((h, i) => `${i ? 'L' : 'M'} ${xs(h.time)} ${ys(h.produced)}`).join(' ')}
        fill="none" stroke={SW_COLORS.brand} strokeWidth="2.5"
      />
      {/* Final-value callout */}
      <g>
        <circle cx={xs(finalPt.time)} cy={ys(finalPt.produced)} r={3.5} fill={SW_COLORS.brand} />
        <rect x={xs(finalPt.time) + 6} y={ys(finalPt.produced) - 9} width={48} height={18} rx={3} fill={SW_COLORS.brand} />
        <text x={xs(finalPt.time) + 30} y={ys(finalPt.produced) + 4} textAnchor="middle" fill="#fff" fontSize="10" fontWeight={800} fontFamily={SW_FONTS.mono}>
          {Math.round(finalPt.produced).toLocaleString()}
        </text>
      </g>
      {/* Axis titles */}
      <text x={padL - 32} y={padT + innerH / 2} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} transform={`rotate(-90 ${padL - 32} ${padT + innerH / 2})`} textAnchor="middle">
        PIECES
      </text>
      <text x={padL + innerW / 2} y={h - 1} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} textAnchor="middle">
        SIM MINUTES
      </text>
    </svg>
  );
}

/** Instantaneous throughput (pcs/hr) over the shift, with a dashed
 *  ceiling at the bottleneck-SMV theoretical max. The gap between the
 *  observed curve and the ceiling is the loss budget — wait, blockage,
 *  starvation, warm-up. */
function ThroughputChartBase({ history, targetPerHr = 0, warmupMin = 0 }: HistorySeries) {
  const w = 600, h = 220;
  const padL = 44, padR = 8, padT = 10, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  if (history.length < 2) return <ChartEmpty height={h} />;

  const maxT = Math.max(history[history.length - 1].time, 480);
  const observedMax = Math.max(...history.map((p) => p.throughputPerHr));
  const maxY = Math.max(observedMax, targetPerHr, 1) * 1.10;
  const xs = (t: number) => padL + (t / maxT) * innerW;
  const ys = (v: number) => padT + innerH - (v / maxY) * innerH;
  const xTicks = 4;
  const yTicks = 4;
  const finalPt = history[history.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width:'100%' }}>
      {warmupMin > 0 && warmupMin < maxT && (
        <rect x={padL} y={padT} width={xs(warmupMin) - padL} height={innerH} fill="#0F141908" />
      )}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const v = (maxY / yTicks) * i;
        return (
          <g key={i}>
            <line x1={padL} y1={ys(v)} x2={w - 8} y2={ys(v)} stroke={SW_COLORS.line} />
            <text x={padL - 6} y={ys(v) + 3} textAnchor="end" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
              {Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}
      {Array.from({ length: xTicks + 1 }).map((_, i) => {
        const t = (maxT / xTicks) * i;
        return (
          <text key={i} x={xs(t)} y={h - 12} textAnchor="middle" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
            {Math.round(t)}m
          </text>
        );
      })}
      {/* Ceiling line */}
      {targetPerHr > 0 && (
        <line x1={padL} y1={ys(targetPerHr)} x2={w - 8} y2={ys(targetPerHr)} stroke={SW_COLORS.faint} strokeWidth="1.5" strokeDasharray="5 4" />
      )}
      {/* Filled area under throughput */}
      <path
        d={`M ${xs(history[0].time)} ${ys(0)} ${history.map((h) => `L ${xs(h.time)} ${ys(h.throughputPerHr)}`).join(' ')} L ${xs(finalPt.time)} ${ys(0)} Z`}
        fill={`${SW_COLORS.ok}22`}
      />
      <path
        d={history.map((h, i) => `${i ? 'L' : 'M'} ${xs(h.time)} ${ys(h.throughputPerHr)}`).join(' ')}
        fill="none" stroke={SW_COLORS.ok} strokeWidth="2.5"
      />
      <text x={padL - 32} y={padT + innerH / 2} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} transform={`rotate(-90 ${padL - 32} ${padT + innerH / 2})`} textAnchor="middle">
        PCS / HR
      </text>
      <text x={padL + innerW / 2} y={h - 1} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} textAnchor="middle">
        SIM MINUTES
      </text>
    </svg>
  );
}

/** WIP (bundles in flight) vs time. A horizontal dashed line at the
 *  time-averaged mean WIP gives the analyst a quick read on whether the
 *  current sample is above or below average. */
function WipChartBase({ history, meanWip }: { history: HistorySeries['history']; meanWip: number }) {
  const w = 600, h = 200;
  const padL = 44, padR = 8, padT = 10, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  if (history.length < 2) return <ChartEmpty height={h} />;

  const maxT = Math.max(history[history.length - 1].time, 480);
  const maxWip = Math.max(...history.map((p) => p.wip), meanWip, 1) * 1.10;
  const xs = (t: number) => padL + (t / maxT) * innerW;
  const ys = (v: number) => padT + innerH - (v / maxWip) * innerH;
  const yTicks = 4;
  const xTicks = 4;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width:'100%' }}>
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const v = (maxWip / yTicks) * i;
        return (
          <g key={i}>
            <line x1={padL} y1={ys(v)} x2={w - 8} y2={ys(v)} stroke={SW_COLORS.line} />
            <text x={padL - 6} y={ys(v) + 3} textAnchor="end" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
              {Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}
      {Array.from({ length: xTicks + 1 }).map((_, i) => {
        const t = (maxT / xTicks) * i;
        return (
          <text key={i} x={xs(t)} y={h - 12} textAnchor="middle" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
            {Math.round(t)}m
          </text>
        );
      })}
      <path
        d={`M ${xs(history[0].time)} ${ys(0)} ${history.map((p) => `L ${xs(p.time)} ${ys(p.wip)}`).join(' ')} L ${xs(history[history.length - 1].time)} ${ys(0)} Z`}
        fill={`${SW_COLORS.bobbin}22`}
      />
      <path
        d={history.map((p, i) => `${i ? 'L' : 'M'} ${xs(p.time)} ${ys(p.wip)}`).join(' ')}
        fill="none" stroke={SW_COLORS.bobbin} strokeWidth="2.5"
      />
      {meanWip > 0 && (
        <>
          <line x1={padL} y1={ys(meanWip)} x2={w - 8} y2={ys(meanWip)} stroke={SW_COLORS.warn} strokeWidth="1.5" strokeDasharray="5 4" />
          <text x={w - 12} y={ys(meanWip) - 4} textAnchor="end" fill={SW_COLORS.warn} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={800}>
            x̄ {Math.round(meanWip).toLocaleString()}
          </text>
        </>
      )}
      <text x={padL - 32} y={padT + innerH / 2} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} transform={`rotate(-90 ${padL - 32} ${padT + innerH / 2})`} textAnchor="middle">
        BUNDLES
      </text>
      <text x={padL + innerW / 2} y={h - 1} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} textAnchor="middle">
        SIM MINUTES
      </text>
    </svg>
  );
}

/** Little's Law verification card. WIP = λ × W (throughput × cycle time).
 *  We compute the law's prediction from observed throughput and lead time
 *  and compare it to the observed time-averaged WIP. Internal-consistency
 *  check: large gaps suggest scrap, rework loops, or a non-stationary run. */
function LittlesLawPanelBase({
  wipBundles,
  throughputPerHr,
  meanLeadTime,
  bundleSize,
}: {
  wipBundles: number;
  throughputPerHr: number;
  meanLeadTime: number;
  bundleSize: number;
}) {
  // λ in pcs/min × W in min = WIP in pieces, divided by bundleSize ⇒ bundles
  const lambdaPcsPerMin = throughputPerHr / 60;
  const predictedPieces = lambdaPcsPerMin * meanLeadTime;
  const predictedBundles = bundleSize > 0 ? predictedPieces / bundleSize : predictedPieces;
  const observed = wipBundles;
  const deltaPct = observed > 0 ? ((predictedBundles - observed) / observed) * 100 : 0;
  const withinTol = Math.abs(deltaPct) <= 15;
  const ratio = observed > 0 && predictedBundles > 0
    ? Math.min(observed, predictedBundles) / Math.max(observed, predictedBundles)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ ...SW_TYPE.heading }}>LITTLE'S LAW · CHECK</div>
      <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4, marginBottom: 14, lineHeight: 1.45 }}>
        Steady-state queueing identity: <strong style={{ color: SW_COLORS.ink, fontFamily: SW_FONTS.mono }}>L = λ × W</strong>. If observed WIP and the prediction diverge by &gt;15 %, the run isn't in steady state — extend simulation time or trim warm-up.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <LLRow label="λ · throughput" value={`${throughputPerHr.toFixed(1)} pcs/hr`} accent={SW_COLORS.ok} />
        <LLRow label="W · mean lead" value={`${meanLeadTime.toFixed(1)} min`} accent={SW_COLORS.bobbin} />
        <LLRow label="L̂ predicted" value={`${predictedBundles.toFixed(1)} bundles`} accent={SW_COLORS.thread} />
        <LLRow label="L observed" value={`${observed.toFixed(1)} bundles`} accent={SW_COLORS.warn} />
      </div>

      <div style={{ marginTop: 14, padding: '10px 12px', border: `1px solid ${withinTol ? SW_COLORS.ok : SW_COLORS.warn}`, borderRadius: SW_RADIUS.sm, background: withinTol ? '#1FB36B11' : '#F5A62311' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span style={{ ...SW_TYPE.kicker, fontWeight: 800, letterSpacing: '0.1em', color: SW_COLORS.muted }}>
            AGREEMENT
          </span>
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 12, fontWeight: 900, color: withinTol ? SW_COLORS.ok : SW_COLORS.warn }}>
            {withinTol ? '✓ within ±15 %' : `⚠ ${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)} %`}
          </span>
        </div>
        <div style={{ marginTop: 6, height: 6, background: SW_COLORS.line, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', background: withinTol ? SW_COLORS.ok : SW_COLORS.warn }} />
        </div>
        <div style={{ marginTop: 6, fontSize: 10, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono }}>
          ratio {observed > 0 && predictedBundles > 0 ? `${(ratio * 100).toFixed(0)} %` : '—'}
        </div>
      </div>
    </div>
  );
}

function LLRow({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderBottom: `1px dashed ${SW_COLORS.line}`, paddingBottom: 6 }}>
      <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.08em' }}>
        <span style={{ display: 'inline-block', width: 6, height: 6, background: accent, borderRadius: 1, marginRight: 6 }} />
        {label}
      </span>
      <span style={{ fontFamily: SW_FONTS.mono, fontSize: 12, fontWeight: 800, color: SW_COLORS.ink }}>
        {value}
      </span>
    </div>
  );
}

/** Horizontal bar chart of station utilization. Bottleneck (highest util)
 *  is marked with a left rail; zones at 70 % / 90 % give visual thresholds
 *  for "healthy / busy / risk". Top N shown; the rest are summarised. */
function UtilizationBarChartBase({
  stations,
}: {
  stations: Array<{
    opId: string;
    opCode?: string;
    opName: string;
    utilization: number;
    queueLen: number;
    lineName?: string;
  }>;
}) {
  if (stations.length === 0) return <ChartEmpty height={220} />;
  const sorted = [...stations].sort((a, b) => b.utilization - a.utilization);
  const top = sorted.slice(0, 10);
  const remaining = sorted.slice(10);
  const barH = 22, gap = 6;
  const labelW = 210;
  const innerW = 600 - labelW - 60;
  const h = top.length * (barH + gap) + 16 + (remaining.length > 0 ? 20 : 0);

  const zoneColor = (u: number) =>
    u >= 0.9 ? SW_COLORS.alarm : u >= 0.7 ? SW_COLORS.thread : SW_COLORS.ok;

  // Strip leading numeric prefix ("1. Sleeve attach" → "Sleeve attach") and
  // trim to fit the label gutter. Line affiliation is shown beneath so the
  // op name itself stays legible.
  const cleanName = (s: { opName: string; opCode?: string }) => {
    const raw = s.opName.replace(/^\d+\.\s*/, '');
    const codePrefix = s.opCode ? `${s.opCode} · ` : '';
    const full = `${codePrefix}${raw}`;
    return full.length > 26 ? full.slice(0, 25) + '…' : full;
  };

  return (
    <svg viewBox={`0 0 600 ${h}`} style={{ width: '100%' }}>
      {[0, 0.5, 0.7, 0.9, 1].map((u, i) => {
        const x = labelW + u * innerW;
        const isThreshold = u === 0.7 || u === 0.9;
        return (
          <g key={i}>
            <line x1={x} y1={0} x2={x} y2={top.length * (barH + gap)} stroke={isThreshold ? SW_COLORS.faint : SW_COLORS.line} strokeDasharray={isThreshold ? '3 3' : undefined} />
            <text x={x} y={top.length * (barH + gap) + 12} textAnchor="middle" fill={isThreshold ? SW_COLORS.steel : SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={isThreshold ? 800 : 600}>
              {Math.round(u * 100)}%
            </text>
          </g>
        );
      })}
      {top.map((s, i) => {
        const y = i * (barH + gap);
        const u = Math.max(0, Math.min(1, s.utilization));
        const isBottleneck = i === 0;
        const label = cleanName(s);
        return (
          <g key={`${s.lineName ?? ''}::${s.opId}::${i}`}>
            {/* Primary op label — left-anchored so long names truncate on the right */}
            <text x={6} y={y + (s.lineName ? 10 : barH / 2 + 3)} textAnchor="start" fill={SW_COLORS.ink} fontSize="11" fontWeight={isBottleneck ? 800 : 600} fontFamily={SW_FONTS.body}>
              {isBottleneck && '◆ '}
              {label}
            </text>
            {/* Secondary line chip beneath op name */}
            {s.lineName && (
              <text x={6} y={y + barH - 2} textAnchor="start" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
                {s.lineName}
              </text>
            )}
            {/* Bar track */}
            <rect x={labelW} y={y + 2} width={innerW} height={barH - 4} fill={SW_COLORS.line} opacity={0.35} rx={2} />
            {/* Filled bar */}
            <rect x={labelW} y={y + 2} width={u * innerW} height={barH - 4} fill={zoneColor(u)} rx={2} />
            {/* Value */}
            <text x={labelW + u * innerW + 4} y={y + barH / 2 + 3} fill={SW_COLORS.ink} fontSize="10" fontWeight={800} fontFamily={SW_FONTS.mono}>
              {Math.round(u * 100)}%
            </text>
            <title>{`${s.opCode ? `${s.opCode} · ` : ''}${s.opName}${s.lineName ? ` · ${s.lineName}` : ''} — util ${(u * 100).toFixed(1)}%, queue ${s.queueLen.toFixed(1)}`}</title>
          </g>
        );
      })}
      {remaining.length > 0 && (
        <text x={6} y={h - 4} fill={SW_COLORS.muted} fontSize="10" fontStyle="italic" fontFamily={SW_FONTS.mono}>
          +{remaining.length} more stations · max {Math.round(remaining[0].utilization * 100)}% · min {Math.round(remaining[remaining.length - 1].utilization * 100)}%
        </text>
      )}
    </svg>
  );
}

/** Pareto chart of station queue depths. Bars descend by queue length;
 *  the cumulative-share line on a secondary axis shows the 80/20 — useful
 *  for telling the analyst which 2-3 stations own most of the line's WIP. */
function QueueParetoChartBase({
  stations,
}: {
  stations: Array<{ opId: string; opCode?: string; opName: string; queueLen: number; lineName?: string }>;
}) {
  if (stations.length === 0) return <ChartEmpty height={220} />;
  const sorted = [...stations].sort((a, b) => b.queueLen - a.queueLen).slice(0, 10);
  const total = sorted.reduce((s, x) => s + x.queueLen, 0);
  if (total === 0) {
    return (
      <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: SW_COLORS.muted, fontSize: 12, textAlign: 'center', padding: 10 }}>
        All queues are empty — no bundles waiting at any station.
      </div>
    );
  }
  const cum: number[] = [];
  let running = 0;
  for (const s of sorted) {
    running += s.queueLen;
    cum.push(running / total);
  }

  const w = 600, h = 240;
  const padL = 30, padR = 38, padT = 12, padB = 56;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxQ = sorted[0].queueLen;
  const barW = innerW / sorted.length;
  const xs = (i: number) => padL + (i + 0.5) * barW;
  const yQ = (v: number) => padT + innerH - (v / maxQ) * innerH;
  const yC = (v: number) => padT + innerH - v * innerH;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%' }}>
      {/* Y-left gridlines (queue length) */}
      {[0, 0.25, 0.5, 0.75, 1].map((u, i) => {
        const v = u * maxQ;
        return (
          <g key={i}>
            <line x1={padL} y1={yQ(v)} x2={w - padR} y2={yQ(v)} stroke={SW_COLORS.line} />
            <text x={padL - 4} y={yQ(v) + 3} textAnchor="end" fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
              {Math.round(v)}
            </text>
          </g>
        );
      })}
      {/* Y-right ticks (cumulative %) */}
      {[0, 0.5, 0.8, 1].map((u, i) => (
        <text key={i} x={w - padR + 4} y={yC(u) + 3} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono}>
          {Math.round(u * 100)}%
        </text>
      ))}
      {/* 80 % reference */}
      <line x1={padL} y1={yC(0.8)} x2={w - padR} y2={yC(0.8)} stroke={SW_COLORS.faint} strokeDasharray="4 3" />
      <text x={padL + 4} y={yC(0.8) - 3} fill={SW_COLORS.muted} fontSize="9" fontWeight={700} fontFamily={SW_FONTS.mono}>80 %</text>

      {/* Bars */}
      {sorted.map((s, i) => {
        const bx = padL + i * barW + 3;
        const bw = barW - 6;
        const by = yQ(s.queueLen);
        const bh = padT + innerH - by;
        const label = s.opCode ?? s.opName.slice(0, 4).toUpperCase();
        return (
          <g key={`${s.lineName ?? ''}::${s.opId}::${i}`}>
            <rect x={bx} y={by} width={bw} height={bh} fill={i === 0 ? SW_COLORS.alarm : SW_COLORS.thread} rx={2} />
            <text x={bx + bw / 2} y={by - 4} textAnchor="middle" fill={SW_COLORS.ink} fontSize="9" fontWeight={800} fontFamily={SW_FONTS.mono}>
              {Math.round(s.queueLen)}
            </text>
            <text x={bx + bw / 2} y={padT + innerH + 12} textAnchor="middle" fill={SW_COLORS.muted} fontSize="9" fontWeight={700} fontFamily={SW_FONTS.mono}>
              {label}
            </text>
            <title>{`${s.opCode ? `${s.opCode} · ` : ''}${s.opName}${s.lineName ? ` · ${s.lineName}` : ''} — queue ${s.queueLen.toFixed(1)}`}</title>
          </g>
        );
      })}
      {/* Cumulative % line */}
      <path
        d={sorted.map((_, i) => `${i ? 'L' : 'M'} ${xs(i)} ${yC(cum[i])}`).join(' ')}
        fill="none" stroke={SW_COLORS.brand} strokeWidth="2.5"
      />
      {sorted.map((_, i) => (
        <circle key={i} cx={xs(i)} cy={yC(cum[i])} r={2.5} fill={SW_COLORS.brand} />
      ))}
      {/* Axis labels */}
      <text x={padL - 20} y={padT + innerH / 2} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} transform={`rotate(-90 ${padL - 20} ${padT + innerH / 2})`} textAnchor="middle">
        QUEUE LEN
      </text>
      <text x={w - padR + 26} y={padT + innerH / 2} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} transform={`rotate(90 ${w - padR + 26} ${padT + innerH / 2})`} textAnchor="middle">
        CUM %
      </text>
      <text x={padL + innerW / 2} y={h - 36} fill={SW_COLORS.muted} fontSize="9" fontFamily={SW_FONTS.mono} fontWeight={700} textAnchor="middle">
        STATIONS · descending queue depth
      </text>
    </svg>
  );
}



// ============================================================================
// PUBLIC, MEMOISED
// ============================================================================
//
// `memo` is load-bearing here rather than a micro-optimisation: these mount
// against a store that ticks five times a second during playback, and most of
// them redraw dozens of SVG segments. Without it, moving the throughput clock
// would re-render the utilisation bars and the Pareto chart too.

export const MultiLineHistoryChart = memo(MultiLineHistoryChartBase);
export const KpiFormula = memo(KpiFormulaBase);
export const KpiTile = memo(KpiTileBase);
export const ChartHeader = memo(ChartHeaderBase);
export const ChartInference = memo(ChartInferenceBase);
export const ChartEmpty = memo(ChartEmptyBase);
export const CumulativeOutputChart = memo(CumulativeOutputChartBase);
export const ThroughputChart = memo(ThroughputChartBase);
export const WipChart = memo(WipChartBase);
export const LittlesLawPanel = memo(LittlesLawPanelBase);
export const UtilizationBarChart = memo(UtilizationBarChartBase);
export const QueueParetoChart = memo(QueueParetoChartBase);
