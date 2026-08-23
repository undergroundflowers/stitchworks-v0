/**
 * Sweep one number and watch a measure move.
 *
 * A single solved system tells you where you are. A sweep tells you what shape
 * you are standing on — and for queueing that shape is the whole lesson: Lq
 * does not rise linearly with load, it goes to the moon as ρ approaches 1. You
 * can read that from a formula, but you learn it from the curve.
 *
 * Drawn as a plain SVG line chart rather than through a chart library: the
 * series is a few hundred points of pure function output with no interaction
 * beyond a hover readout, and the ρ = 1 asymptote needs a bespoke guide line
 * that a generic chart would fight.
 */

import { useMemo, useState } from 'react';
import { SW_COLORS, SW_FONTS } from '../../design/tokens';
import { alpha } from '../../design/color-utils';
import { ToggleGroup } from '../ToggleGroup';
import { HudSelect } from '../HudSelect';
import { NumberField } from '../queueParamFields';
import { Sym } from '../Sym';
import { QUANTITY, type QuantityId } from '../../simulation/notation';
import { analyticalKpis, classify } from '../../simulation/queueing';
import { meanOf, scaleServiceDist } from '../../simulation/distributions';
import type { QueueNode } from '../../simulation/network';

/** What can be swept. Each maps to one field of the node. */
type SweepVar = 'lambda' | 'mu' | 'servers' | 'capacity';
/** What can be plotted. Restricted to measures that are always numeric. */
type PlotMetric = Extract<QuantityId, 'Lq' | 'L' | 'Wq' | 'W' | 'rho' | 'pWait'>;

const SWEEP_OPTIONS: { value: SweepVar; label: string }[] = [
  { value: 'lambda', label: 'Arrival rate λ' },
  { value: 'mu', label: 'Service rate μ' },
  { value: 'servers', label: 'Servers c' },
  { value: 'capacity', label: 'Capacity N' },
];

const PLOT_OPTIONS: { value: PlotMetric; label: string }[] = [
  { value: 'Lq', label: 'Lq' },
  { value: 'L', label: 'L' },
  { value: 'Wq', label: 'Wq' },
  { value: 'W', label: 'W' },
  { value: 'rho', label: 'ρ' },
  { value: 'pWait', label: 'P(wait)' },
];

const W = 640;
const H = 220;
const PAD_L = 52;
const PAD_B = 34;
const PAD_T = 14;
const PAD_R = 14;

export interface LabSweepProps {
  node: QueueNode;
  /** Arrival rate the node is currently solved at, per hour. */
  lambda: number;
}

interface Point {
  x: number;
  y: number;
  /** False where the model is unstable — the curve is cut, not drawn to ∞. */
  defined: boolean;
}

export function LabSweep({ node, lambda }: LabSweepProps) {
  const [variable, setVariable] = useState<SweepVar>('lambda');
  const [metric, setMetric] = useState<PlotMetric>('Lq');

  const muNow = 60 / Math.max(1e-9, meanOf(node.serviceDist));
  const capNow = Number.isFinite(node.capacity) ? node.capacity : 20;

  // Sensible default range per variable, recomputed when the variable changes.
  const defaults = useMemo(() => {
    switch (variable) {
      case 'lambda':
        // Up to just past saturation, so the asymptote is on screen.
        return { from: 0.1, to: Math.max(1, node.servers * muNow * 1.3), step: 0 };
      case 'mu':
        return { from: Math.max(0.1, lambda / Math.max(1, node.servers) * 0.6), to: muNow * 2.5, step: 0 };
      case 'servers':
        return { from: 1, to: 8, step: 1 };
      case 'capacity':
        return { from: Math.max(1, node.servers), to: Math.max(node.servers + 1, capNow * 2), step: 1 };
    }
  }, [variable, node.servers, muNow, lambda, capNow]);

  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  // Re-seed the range when the variable changes; the previous range is
  // meaningless in the new units (a λ range of 0–30 is nonsense for c).
  const [seededFor, setSeededFor] = useState<SweepVar>(variable);
  if (seededFor !== variable) {
    setSeededFor(variable);
    setFrom(defaults.from);
    setTo(defaults.to);
  }

  const integral = variable === 'servers' || variable === 'capacity';

  const { points, saturationX } = useMemo(() => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const steps = integral ? Math.min(40, Math.max(1, Math.round(hi - lo))) : 120;
    const out: Point[] = [];
    let satX: number | null = null;

    for (let i = 0; i <= steps; i++) {
      const raw = lo + ((hi - lo) * i) / steps;
      const x = integral ? Math.round(raw) : raw;

      let lam = lambda;
      let dist = node.serviceDist;
      let servers = node.servers;
      let capacity = node.capacity;

      switch (variable) {
        case 'lambda':
          lam = x;
          break;
        case 'mu': {
          // Scale the distribution so its MEAN becomes 60/x, preserving shape
          // (and therefore the Kendall service code) rather than swapping it
          // for an exponential at the new rate.
          const targetMean = 60 / Math.max(1e-9, x);
          dist = scaleServiceDist(node.serviceDist, targetMean / Math.max(1e-9, meanOf(node.serviceDist)));
          break;
        }
        case 'servers':
          servers = Math.max(1, Math.round(x));
          break;
        case 'capacity':
          capacity = Math.max(1, Math.round(x));
          break;
      }

      const notation = classify(dist, servers, capacity, node.discipline);
      const k = analyticalKpis(notation, lam, dist);
      const value = readMetric(k, metric);
      const unbounded = !Number.isFinite(capacity);
      const defined = Number.isFinite(value) && (!unbounded || k.isStable);

      // Mark where an unbounded queue tips over — the asymptote is the lesson.
      if (unbounded && satX == null && k.rho >= 1) satX = x;

      out.push({ x, y: value, defined });
    }
    return { points: out, saturationX: satX };
  }, [from, to, integral, variable, lambda, node, metric]);

  const defined = points.filter((p) => p.defined);
  const yMaxRaw = defined.length ? Math.max(...defined.map((p) => p.y)) : 1;
  // Clip the y-axis so one near-asymptote point doesn't flatten the rest of
  // the curve into the baseline.
  const yCap = metric === 'rho' || metric === 'pWait' ? 1 : niceCap(defined.map((p) => p.y));
  const yMax = Math.max(1e-6, Math.min(yMaxRaw, yCap));

  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  const sx = (x: number) =>
    PAD_L + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * (W - PAD_L - PAD_R);
  const sy = (y: number) =>
    H - PAD_B - (Math.min(y, yMax) / yMax) * (H - PAD_T - PAD_B);

  // Break the path wherever the model stops being defined, so an unstable
  // region is a gap rather than a line drawn through nonsense.
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of points) {
    if (!p.defined) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${current.length ? 'L' : 'M'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(' '));

  const q = QUANTITY[metric];
  const unitSuffix = metric === 'Wq' || metric === 'W' ? ' hr' : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 168 }}>
          <span style={labelStyle}>Sweep</span>
          <HudSelect
            value={variable}
            onChange={(v) => setVariable(v as SweepVar)}
            variant="light"
            size="sm"
            width="100%"
            options={SWEEP_OPTIONS}
          />
        </label>
        <div style={{ width: 92 }}>
          <NumberField
            label="From"
            value={round3(from)}
            step={integral ? 1 : 0.5}
            editable
            onChange={setFrom}
          />
        </div>
        <div style={{ width: 92 }}>
          <NumberField
            label="To"
            value={round3(to)}
            step={integral ? 1 : 0.5}
            editable
            onChange={setTo}
          />
        </div>
        <div style={{ flex: 1 }} />
        <ToggleGroup<PlotMetric> value={metric} options={PLOT_OPTIONS} onChange={setMetric} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ display: 'block', minWidth: 420 }}
          role="img"
          aria-label={`${q.name} against ${variable}`}
        >
          {/* Frame + gridlines. */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y = H - PAD_B - f * (H - PAD_T - PAD_B);
            return (
              <g key={f}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  stroke={SW_COLORS.line}
                  strokeWidth={f === 0 ? 1.2 : 0.6}
                />
                <text
                  x={PAD_L - 7}
                  y={y + 3}
                  textAnchor="end"
                  fill={SW_COLORS.muted}
                  fontFamily={SW_FONTS.mono}
                  fontSize={9}
                >
                  {fmtAxis(yMax * f, metric)}
                </text>
              </g>
            );
          })}

          {/* The ρ = 1 wall. Everything to its right is a queue with no bound. */}
          {saturationX != null && saturationX <= xMax && (
            <g>
              <line
                x1={sx(saturationX)}
                y1={PAD_T}
                x2={sx(saturationX)}
                y2={H - PAD_B}
                stroke={SW_COLORS.alarm}
                strokeWidth={1.2}
                strokeDasharray="4 3"
              />
              <text
                x={sx(saturationX) + 5}
                y={PAD_T + 10}
                fill={SW_COLORS.alarm}
                fontFamily={SW_FONTS.mono}
                fontSize={9}
                fontWeight={700}
              >
                ρ = 1
              </text>
              <rect
                x={sx(saturationX)}
                y={PAD_T}
                width={Math.max(0, W - PAD_R - sx(saturationX))}
                height={H - PAD_T - PAD_B}
                fill={alpha(SW_COLORS.alarm, 0.07)}
              />
            </g>
          )}

          {/* The curve. */}
          {segments.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={SW_COLORS.brand} strokeWidth={2} />
          ))}

          {/* Where the system sits right now. */}
          {(() => {
            const nowX =
              variable === 'lambda'
                ? lambda
                : variable === 'mu'
                  ? muNow
                  : variable === 'servers'
                    ? node.servers
                    : Number.isFinite(node.capacity)
                      ? node.capacity
                      : null;
            if (nowX == null || nowX < xMin || nowX > xMax) return null;
            const here = points.reduce((best, p) =>
              Math.abs(p.x - nowX) < Math.abs(best.x - nowX) ? p : best,
            );
            if (!here.defined) return null;
            return (
              <g>
                <circle cx={sx(here.x)} cy={sy(here.y)} r={4} fill={SW_COLORS.ink} />
                <circle
                  cx={sx(here.x)}
                  cy={sy(here.y)}
                  r={7}
                  fill="none"
                  stroke={SW_COLORS.ink}
                  strokeWidth={1}
                  opacity={0.5}
                />
                <text
                  x={sx(here.x)}
                  y={sy(here.y) - 12}
                  textAnchor="middle"
                  fill={SW_COLORS.ink}
                  fontFamily={SW_FONTS.mono}
                  fontSize={9}
                  fontWeight={700}
                >
                  now
                </text>
              </g>
            );
          })()}

          {/* x axis ticks. */}
          {[0, 0.5, 1].map((f) => {
            const x = xMin + (xMax - xMin) * f;
            return (
              <text
                key={f}
                x={sx(x)}
                y={H - PAD_B + 14}
                textAnchor="middle"
                fill={SW_COLORS.muted}
                fontFamily={SW_FONTS.mono}
                fontSize={9}
              >
                {round3(x)}
              </text>
            );
          })}
          <text
            x={(PAD_L + W - PAD_R) / 2}
            y={H - 4}
            textAnchor="middle"
            fill={SW_COLORS.muted}
            fontFamily={SW_FONTS.mono}
            fontSize={9}
          >
            {SWEEP_OPTIONS.find((o) => o.value === variable)?.label}
          </text>
        </svg>
      </div>

      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.45 }}>
        Plotting <Sym quantity={metric} /> {q.name.toLowerCase()}
        {unitSuffix}. The curve breaks where the model has no answer — past ρ = 1 an
        unbounded queue has no steady state at all, which is why the line stops rather
        than climbing off the top.
      </div>
    </div>
  );
}

function readMetric(
  k: ReturnType<typeof analyticalKpis>,
  metric: PlotMetric,
): number {
  switch (metric) {
    case 'Lq': return k.Lq;
    case 'L': return k.L;
    case 'Wq': return k.Wq;
    case 'W': return k.W;
    case 'rho': return k.rho;
    case 'pWait': return k.pWait;
  }
}

/**
 * A y-axis ceiling that keeps the interesting part of the curve visible.
 *
 * Near ρ = 1 the last computed point can be thousands of times the rest, and
 * scaling to it would flatten everything else onto the axis. The 90th
 * percentile with a little headroom keeps the shape readable and lets the
 * blow-up run off the top, which is the honest picture of an asymptote.
 */
function niceCap(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return 1;
  const p90 = finite[Math.floor(finite.length * 0.9)] ?? finite[finite.length - 1];
  return Math.max(1e-6, p90 * 1.15);
}

function fmtAxis(v: number, metric: PlotMetric): string {
  if (metric === 'rho' || metric === 'pWait') return `${Math.round(v * 100)}%`;
  if (v >= 100) return v.toFixed(0);
  return Number(v.toFixed(2)).toString();
}

function round3(v: number): number {
  return Number.isFinite(v) ? Number(v.toFixed(3)) : 0;
}

const labelStyle = {
  fontFamily: SW_FONTS.mono,
  fontSize: 10,
  letterSpacing: '0.5px',
  textTransform: 'uppercase' as const,
  color: SW_COLORS.muted,
  fontWeight: 700,
};
