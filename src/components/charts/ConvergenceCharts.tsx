/**
 * Sim-versus-theory convergence charts.
 *
 * These could not exist before the engine recorded real queueing observables.
 * The old ρ̂ series was the INSTANTANEOUS `busy / servers` — a 0/1 square wave
 * at c = 1 — drawn against a flat analytical ρ it could never settle onto, so a
 * chart of it was worse than none: it looked like the model disagreed with the
 * theory when in fact nothing was being measured.
 *
 * Now the solid line is a cumulative time-average from ∫busy dt and the dashed
 * line is the closed form. Watching the two meet is the most direct evidence
 * the simulator is right — and when they DON'T meet, that gap is the finding.
 */

import { memo } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../../design/tokens';
import { alpha } from '../../design/color-utils';
import type { StationHistoryPoint, StationView } from '../../simulation';

const W = 600;
const H = 150;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 22;

interface SeriesSpec {
  label: string;
  /** Pull the plotted value out of a history point. */
  pick: (p: StationHistoryPoint) => number;
  /** Closed-form steady-state target for the dashed reference. */
  target: (s: StationView) => number;
  format: (v: number) => string;
  color: string;
  /** What to conclude when solid and dashed diverge. Takes the SIGN, because
   *  over- and under-running the closed form mean opposite things and a
   *  single sentence covering both would be wrong half the time. */
  divergenceNote: (dir: 'above' | 'below') => string;
  /** Hard ceiling for the y-axis, where the quantity has one. */
  yCap?: number;
}

function plot(
  history: StationHistoryPoint[],
  spec: SeriesSpec,
  station: StationView,
): {
  path: string;
  targetY: number | null;
  yMax: number;
  last: number;
  target: number;
} | null {
  if (history.length < 2) return null;
  const target = spec.target(station);
  const values = history.map(spec.pick);
  const last = values[values.length - 1];
  // Include the target in the y-range or a converged line would sit on the
  // frame edge and the whole point of the chart would be invisible.
  let yMax = Math.max(...values, Number.isFinite(target) ? target : 0, 1e-6) * 1.15;
  if (spec.yCap != null) yMax = Math.min(yMax, spec.yCap);
  const t0 = history[0].time;
  const t1 = history[history.length - 1].time;
  const span = Math.max(1e-6, t1 - t0);
  const x = (t: number) => PAD_L + ((t - t0) / span) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B);
  const path = history
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.time).toFixed(1)},${y(spec.pick(p)).toFixed(1)}`)
    .join(' ');
  return {
    path,
    targetY: Number.isFinite(target) ? y(target) : null,
    yMax,
    last,
    target,
  };
}

export interface ConvergenceChartProps {
  station: StationView;
  history: StationHistoryPoint[];
  metric: 'rho' | 'Lq' | 'balk';
}

const SPECS: Record<ConvergenceChartProps['metric'], SeriesSpec> = {
  rho: {
    label: 'ρ̂ — operator saturation',
    pick: (p) => p.utilization,
    target: (s) => s.analytical.rho,
    format: (v) => `${(v * 100).toFixed(1)}%`,
    color: SW_COLORS.bobbin,
    // ρ̂ = ∫busy dt / (c·t) cannot exceed 1, so the axis shouldn't imply it can.
    yCap: 1,
    divergenceNote: (dir) =>
      dir === 'below'
        ? 'The station is idler than theory predicts — it is being starved, so it never sees the '
          + 'arrival rate the closed form assumes. Look upstream for the real bottleneck.'
        : 'The station is busier than theory predicts, which usually means its effective service '
          + 'time is longer than the authored SMV — check for a shared operator or rework.',
  },
  Lq: {
    label: 'L̄q — bundles waiting',
    pick: (p) => p.queueLen,
    target: (s) => s.analytical.Lq,
    format: (v) => v.toFixed(2),
    color: SW_COLORS.thread,
    divergenceNote: (dir) =>
      dir === 'below'
        ? 'The queue has not filled to its steady-state depth yet. Lq converges slowly when ρ is '
          + 'high — one shift is often too short to reach it, so let the run go longer before '
          + 'reading this as disagreement.'
        : 'The queue is deeper than the closed form predicts, which points at burstier-than-Poisson '
          + 'arrivals or an upstream station releasing work in clumps.',
  },
  balk: {
    label: 'Balk fraction — arrivals turned away',
    pick: () => 0,
    target: () => 0,
    format: (v) => `${(v * 100).toFixed(1)}%`,
    color: SW_COLORS.alarm,
    divergenceNote: () => '',
  },
};

function ConvergenceChartBase({ station, history, metric }: ConvergenceChartProps) {
  const spec = SPECS[metric];
  const geom = plot(history, spec, station);

  if (!geom) {
    return (
      <div
        style={{
          height: H,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px dashed ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.sm,
          ...SW_TYPE.micro,
          color: SW_COLORS.faint,
        }}
      >
        PLAY THE SHIFT TO DRAW THIS CURVE
      </div>
    );
  }

  // "Converged" is deliberately generous at 10%: these are stochastic
  // estimates over a finite run, and demanding tighter agreement on screen
  // would flag honest sampling noise as a problem.
  const gap = geom.target > 0 ? Math.abs(geom.last - geom.target) / geom.target : 0;
  const converged = Number.isFinite(geom.target) && gap <= 0.1;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
        <span style={{ ...SW_TYPE.micro, color: SW_COLORS.muted }}>{spec.label}</span>
        <span style={{ ...SW_TYPE.numeric, color: spec.color, fontWeight: 800 }}>
          {spec.format(geom.last)}
        </span>
        <span style={{ ...SW_TYPE.micro, color: SW_COLORS.faint }}>
          theory {spec.format(geom.target)}
        </span>
        <span
          style={{
            ...SW_TYPE.micro,
            marginLeft: 'auto',
            color: converged ? SW_COLORS.ok : SW_COLORS.warn,
            fontWeight: 800,
          }}
        >
          {converged ? 'CONVERGED' : `${(gap * 100).toFixed(0)}% OFF`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        <rect
          x={PAD_L}
          y={PAD_T}
          width={W - PAD_L - PAD_R}
          height={H - PAD_T - PAD_B}
          fill={alpha(SW_COLORS.ink, 0.02)}
          stroke={SW_COLORS.lineSoft}
        />
        {/* Closed-form steady state. */}
        {geom.targetY !== null && (
          <>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={geom.targetY}
              y2={geom.targetY}
              stroke={SW_COLORS.ink}
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.55}
            />
            <text
              x={W - PAD_R - 2}
              y={geom.targetY - 3}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fill={SW_COLORS.muted}
            >
              theory
            </text>
          </>
        )}
        {/* Measured. */}
        <path d={geom.path} fill="none" stroke={spec.color} strokeWidth={1.8} />
        <text
          x={PAD_L - 4}
          y={PAD_T + 8}
          textAnchor="end"
          fontFamily={SW_FONTS.mono}
          fontSize={9}
          fill={SW_COLORS.faint}
        >
          {spec.format(geom.yMax)}
        </text>
        <text
          x={PAD_L - 4}
          y={H - PAD_B}
          textAnchor="end"
          fontFamily={SW_FONTS.mono}
          fontSize={9}
          fill={SW_COLORS.faint}
        >
          0
        </text>
        <text
          x={PAD_L}
          y={H - 6}
          fontFamily={SW_FONTS.mono}
          fontSize={9}
          fill={SW_COLORS.faint}
        >
          {history[0].time.toFixed(0)} min
        </text>
        <text
          x={W - PAD_R}
          y={H - 6}
          textAnchor="end"
          fontFamily={SW_FONTS.mono}
          fontSize={9}
          fill={SW_COLORS.faint}
        >
          {history[history.length - 1].time.toFixed(0)} min
        </text>
      </svg>
      {!converged && spec.divergenceNote(geom.last < geom.target ? 'below' : 'above') && (
        <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted, marginTop: 2 }}>
          {spec.divergenceNote(geom.last < geom.target ? 'below' : 'above')}
        </div>
      )}
    </div>
  );
}

export const ConvergenceChart = memo(ConvergenceChartBase);

/**
 * Balk fraction against the analytical P_N.
 *
 * Only meaningful for a finite buffer, so it says so rather than drawing a flat
 * zero — a chart of "nothing is being turned away, because nothing can be" is
 * noise on an unbounded station.
 */
function BalkRatePanelBase({ station }: { station: StationView }) {
  const finite = Number.isFinite(station.capacity);
  if (!finite) {
    return (
      <div style={{ ...SW_TYPE.caption, color: SW_COLORS.faint }}>
        Unbounded buffer — nothing can be turned away. Set a Buffer (N) on this station in the
        Builder to model a cart or rack that fills up.
      </div>
    );
  }
  const pN = station.analytical.Pn(station.capacity);
  const observed = station.balkFraction;
  const gap = pN > 0 ? Math.abs(observed - pN) / pN : 0;
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
      <Readout label="Turned away (sim)" value={`${(observed * 100).toFixed(1)}%`} accent={SW_COLORS.alarm} />
      <Readout label={`P(N=${station.capacity}) theory`} value={`${(pN * 100).toFixed(1)}%`} accent={SW_COLORS.muted} />
      <Readout
        label="Agreement"
        value={gap <= 0.1 ? 'converged' : `${(gap * 100).toFixed(0)}% off`}
        accent={gap <= 0.1 ? SW_COLORS.ok : SW_COLORS.warn}
      />
    </div>
  );
}

export const BalkRatePanel = memo(BalkRatePanelBase);

function Readout({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.faint }}>{label}</div>
      <div style={{ ...SW_TYPE.numeric, color: accent, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

/**
 * Little's law as a CHECK rather than a restatement.
 *
 * This is only possible because Ŵq is now measured from per-agent waits instead
 * of being derived as Lq/λ. When Wq was a rearrangement of Little's law, a panel
 * like this could only ever confirm its own arithmetic; now the residual is a
 * real signal about whether the run has reached steady state.
 */
function LittlesLawCheckBase({ station }: { station: StationView }) {
  const lambdaPerMin = station.lambdaEff / 60;
  const predictedLq = lambdaPerMin * station.WqObservedMin;
  const observedLq = station.LqObserved;
  const residual = observedLq > 0 ? Math.abs(predictedLq - observedLq) / observedLq : 0;
  const holds = residual <= 0.05;
  return (
    <div>
      <div style={{ ...SW_TYPE.micro, color: SW_COLORS.muted, marginBottom: 4 }}>
        LITTLE&apos;S LAW · L̄q = λ_eff · Ŵq
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Readout label="λ_eff /hr" value={station.lambdaEff.toFixed(1)} accent={SW_COLORS.fabric} />
        <Readout label="Ŵq measured (min)" value={station.WqObservedMin.toFixed(2)} accent={SW_COLORS.thread} />
        <Readout label="λ·Ŵq" value={predictedLq.toFixed(2)} accent={SW_COLORS.muted} />
        <Readout label="L̄q measured" value={observedLq.toFixed(2)} accent={SW_COLORS.bobbin} />
        <Readout
          label="Residual"
          value={holds ? 'holds' : `${(residual * 100).toFixed(0)}%`}
          accent={holds ? SW_COLORS.ok : SW_COLORS.warn}
        />
      </div>
      {!holds && (
        <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted, marginTop: 4 }}>
          The two sides disagree, which means this station has not reached steady state over the
          window being measured — let the shift run longer, or raise the warm-up.
        </div>
      )}
    </div>
  );
}

export const LittlesLawCheck = memo(LittlesLawCheckBase);
