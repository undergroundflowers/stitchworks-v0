/**
 * Queue Analysis Panel — the per-station queueing-theory inspector.
 *
 * Shows a workstation through the lens of classical queueing theory:
 * Kendall–Lee classification, configurable service distribution / buffer /
 * discipline, and a side-by-side sim-vs-analytical KPI comparison so the
 * user can see how the simulator's behaviour lines up with closed-form
 * expectations from Naidu's textbook.
 *
 * The panel is decoupled from the store — pass `onChange` to make it
 * editable; omit it for read-only contexts (reports, scenario snapshots).
 *
 * The editable field widgets (distribution / servers / capacity / discipline)
 * live in `queueParamFields` so the Builder's sim-free authoring group renders
 * the same controls. This panel keeps the parts that need a live `StationView`:
 * the Kendall header, the sim-vs-analytical KPI table, and the footer stats.
 */

import { useState } from 'react';
import { Card } from './Card';
import { FieldLabel, Sym } from './Sym';
import { QueueDisciplineGraphic } from './QueueDisciplineGraphic';
import { DistPicker } from './DistPicker';
import { NumberInput } from './NumberInput';
import {
  DISCIPLINE_OPTIONS,
  DistParamInputs,
  NumberField,
  CapacityField,
  DropdownField,
  SubHeader,
  inputStyle,
  morphDist,
  patchDist,
  type DistKind,
  type DistParams,
  type QueueAnalysisChange,
} from './queueParamFields';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import type { StationView } from '../simulation';
import { describeDist, type QueueDiscipline } from '../simulation';
import { QUANTITY, glossOf, type QuantityId } from '../simulation/notation';

export type { QueueAnalysisChange };

interface QueueAnalysisPanelProps {
  station: StationView;
  /** Called when the user edits any field; omit to make the panel read-only. */
  onChange?: (patch: QueueAnalysisChange) => void;
}

export function QueueAnalysisPanel({ station, onChange }: QueueAnalysisPanelProps) {
  const { notation, serviceDist, analytical, smv } = station;
  const editable = !!onChange;

  // ── Derived values ─────────────────────────────────────────────────────
  const capacity = station.capacity;
  const capacityFinite = Number.isFinite(capacity);

  const stabilityDot = stabilityIndicator(analytical.rho, capacityFinite);

  // ── Event handlers ─────────────────────────────────────────────────────
  function changeDistKind(kind: DistKind) {
    if (!onChange) return;
    onChange({ serviceDistribution: morphDist(serviceDist, kind, smv) });
  }
  function changeDistParam(patch: Partial<DistParams>) {
    if (!onChange) return;
    onChange({ serviceDistribution: patchDist(serviceDist, patch) });
  }
  function changeServers(servers: number) {
    if (!onChange) return;
    onChange({ servers: Math.max(1, Math.round(servers)) });
  }
  function changeCapacity(cap: number | 'inf') {
    if (!onChange) return;
    if (cap === 'inf') onChange({ queueCapacity: undefined as unknown as number });
    else onChange({ queueCapacity: Math.max(1, Math.round(cap)) });
  }
  function changeDiscipline(d: QueueDiscipline) {
    if (!onChange) return;
    onChange({ queueDiscipline: d });
  }

  // ── Sub-renders ────────────────────────────────────────────────────────
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Kendall header */}
      <header
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              color: SW_COLORS.muted,
              letterSpacing: '0.6px',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Kendall–Lee classification
          </div>
          <div
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 22,
              fontWeight: 900,
              letterSpacing: '-0.02em',
              color: SW_COLORS.ink,
            }}
          >
            {notation.label}
          </div>
          <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4 }}>
            {describeDist(serviceDist)} · {station.serversTotal} server
            {station.serversTotal === 1 ? '' : 's'}
          </div>
        </div>
        <StabilityDot color={stabilityDot.color} label={stabilityDot.label} />
      </header>

      {/* Configuration block */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SubHeader>Service-time distribution</SubHeader>
        <DistPicker
          dist={serviceDist}
          fallbackMean={smv}
          editable={editable}
          onChange={(v) => changeDistKind(v)}
        />
        <DistParamInputs
          dist={serviceDist}
          editable={editable}
          onChange={changeDistParam}
        />

        <SubHeader style={{ marginTop: 8 }}>Capacity and servers</SubHeader>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
            gap: 10,
            // Grid items default to min-content width; the discipline select
            // is wider than its column and would overhang the card without this.
            alignItems: 'end',
          }}
        >
          <NumberField
            label={<FieldLabel quantity="servers" />}
            value={station.serversTotal}
            min={1}
            step={1}
            editable={editable}
            onChange={changeServers}
          />
          <CapacityField
            capacity={capacity}
            editable={editable}
            onChange={changeCapacity}
          />
          <DropdownField<QueueDiscipline>
            label={<FieldLabel quantity="discipline" />}
            value={notation.discipline}
            options={DISCIPLINE_OPTIONS}
            editable={editable}
            onChange={changeDiscipline}
          />
        </div>
        <QueueDisciplineGraphic discipline={notation.discipline} />
      </section>

      {/* KPI comparison */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SubHeader>Sim vs analytical KPIs</SubHeader>
        <KpiTable station={station} />
      </section>

      {/* Notes / warnings */}
      {analytical.note && (
        <div
          style={{
            background: analytical.isStable
              ? SW_COLORS.paperDeep
              : alpha(SW_COLORS.alarm, 0.1),
            borderLeft: `3px solid ${analytical.isStable ? SW_COLORS.line : SW_COLORS.alarm}`,
            border: `1px solid ${alpha(analytical.isStable ? SW_COLORS.line : SW_COLORS.alarm, 0.5)}`,
            borderRadius: SW_RADIUS.sm,
            padding: '10px 12px',
            fontSize: 12,
            color: analytical.isStable ? SW_COLORS.muted : SW_COLORS.ink,
            lineHeight: 1.45,
          }}
        >
          {analytical.note}
        </div>
      )}

      {/* The textbook's probability sub-problems. Rows the active model has
          no closed form for render as a dash rather than being hidden, so the
          user can see which questions this Kendall class can answer. */}
      <ProbabilityBlock station={station} />

      {/* Throughput + WIP summary (sewing-floor language) */}
      <Footer station={station} />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────────────────

function StabilityDot({ color, label }: { color: string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: SW_COLORS.paperDeep,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        padding: '6px 10px',
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 0 3px ${color}22`,
        }}
      />
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 11,
          fontWeight: 700,
          color: SW_COLORS.ink,
          letterSpacing: '0.3px',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function KpiTable({ station }: { station: StationView }) {
  const a = station.analytical;
  // Every SIM column is a TIME-AVERAGE, because that is the only thing
  // comparable to a steady-state closed form.
  //
  // Lq and L used to read `station.queueLen` and `busy + queueLen` — the
  // INSTANTANEOUS counts at the displayed frame. So this panel reported Lq =
  // 0.00 for the bottleneck station at the same moment the queue table two
  // clicks away reported 2.10, and neither number was wrong: they were
  // answering different questions under the same label. Wq was simply blank.
  const rows: KpiRow[] = [
    { q: 'rho', sim: station.utilization, theory: a.rho, format: pct },
    { q: 'Lq', sim: station.LqObserved, theory: a.Lq, format: num2 },
    { q: 'L', sim: station.LObserved, theory: a.L, format: num2 },
    { q: 'Wq', sim: station.WqObservedMin, theory: hoursToMin(a.Wq), format: num2 },
    // W = Wq + service time. The engine measures the wait; adding the mean
    // service time is exact for a single server and the right first-cut for c>1.
    {
      q: 'W',
      sim: station.WqObservedMin + station.smv,
      theory: hoursToMin(a.W),
      format: num2,
    },
    { q: 'P0', sim: 1 - station.utilization, theory: a.P0, format: pct },
    // Formulas 10 and 13 — the two questions the textbook asks about whether
    // an arrival queues at all. The sim column reads the same fraction off the
    // run, so the pair is directly comparable.
    { q: 'pWait', sim: NaN, theory: a.pWait, format: pct },
    { q: 'pNoWait', sim: NaN, theory: a.pNoWait, format: pct },
    // Formula 9 — only defined for the single-server models.
    { q: 'D', sim: NaN, theory: a.D, format: num2 },
    // Both columns must be the ADMITTED rate. `station.lambda` is the OFFERED
    // rate (admitted + balked), so pairing it with the analytical λ_eff put two
    // different quantities under one symbol and made a balking station look
    // like a modelling error.
    { q: 'lambda', sim: station.lambda, theory: a.lambdaOffered, format: num2 },
    { q: 'lambdaEff', sim: station.lambdaEff, theory: a.lambdaEff, format: num2 },
    { q: 'pBalk', sim: station.balkFraction, theory: a.pBalk, format: pct },
  ];
  return (
    <div
      style={{
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr',
          background: SW_COLORS.paperDeep,
          padding: '8px 12px',
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: SW_COLORS.muted,
          fontWeight: 700,
          borderBottom: `1px solid ${SW_COLORS.line}`,
        }}
      >
        <span>Metric</span>
        <span style={{ textAlign: 'right' }}>Simulated</span>
        <span style={{ textAlign: 'right' }}>Analytical (Naidu)</span>
      </div>
      {rows.map((r, i) => (
        <KpiRowView key={r.q} row={r} alt={i % 2 === 1} />
      ))}
    </div>
  );
}

interface KpiRow {
  /** Names the quantity; label and symbol both come from the vocabulary. */
  q: QuantityId;
  sim: number;
  theory: number;
  format: (v: number) => string;
}

function KpiRowView({ row, alt }: { row: KpiRow; alt: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 1fr 1fr',
        padding: '8px 12px',
        background: alt ? SW_COLORS.paperDeep : SW_COLORS.paper,
        fontSize: 13,
        alignItems: 'center',
      }}
    >
      <span style={{ color: SW_COLORS.ink, fontWeight: 600 }} title={glossOf(row.q)}>
        <Sym quantity={row.q} color={SW_COLORS.brandText} />
        <span style={{ marginLeft: 8, fontWeight: 500 }}>{QUANTITY[row.q].name}</span>
        {QUANTITY[row.q].unit && (
          <span style={{ marginLeft: 5, color: SW_COLORS.muted, fontSize: 11 }}>
            {QUANTITY[row.q].unit}
          </span>
        )}
      </span>
      <span style={{ textAlign: 'right', fontFamily: SW_FONTS.mono, color: SW_COLORS.ink }}>
        {row.format(row.sim)}
      </span>
      <span style={{ textAlign: 'right', fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>
        {row.format(row.theory)}
      </span>
    </div>
  );
}

/**
 * Probability calculator — the textbook's four "what is the probability that…"
 * questions, answered live for this station.
 *
 * Naidu poses these as separate sub-problems (formulas 3, 4, 11 and 12) rather
 * than as steady-state means, and they are the questions a supervisor actually
 * asks: how often does a bundle sit longer than ten minutes, how often does the
 * rail back up past six. Each row shows the formula it evaluates so the number
 * is traceable to the page.
 */
function ProbabilityBlock({ station }: { station: StationView }) {
  const a = station.analytical;
  const [n, setN] = useState(3);
  const [w, setW] = useState(5);
  const [v, setV] = useState(8);

  // Formulas 11 and 12 take hours, matching 1/μ; the inputs are in minutes.
  const rows: ProbRow[] = [
    {
      q: 'Pn',
      control: { value: n, onChange: setN, min: 0, step: 1, suffix: 'bundles' },
      value: a.Pn(n),
      question: `Exactly ${n} bundle${n === 1 ? '' : 's'} at this station`,
    },
    {
      q: 'PnOrMore',
      control: { value: n, onChange: setN, min: 0, step: 1, suffix: 'bundles', mirrored: true },
      value: a.pNOrMore(n),
      // The textbook's own note: "more than n" is the same question at n+1.
      question: `${n} or more bundles — for “more than ${n}”, read the row at ${n + 1}`,
    },
    {
      q: 'pWqGt',
      control: { value: w, onChange: setW, min: 0, step: 1, suffix: 'min' },
      value: a.pWaitGreaterThan(w / 60),
      question: `A bundle waits longer than ${w} min before an operator starts it`,
    },
    {
      q: 'pWGt',
      control: { value: v, onChange: setV, min: 0, step: 1, suffix: 'min' },
      value: a.pSystemGreaterThan(v / 60),
      question: `A bundle is at this station longer than ${v} min in total`,
    },
  ];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SubHeader>Probability questions</SubHeader>
      <div
        style={{
          border: `1px solid ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.sm,
          overflow: 'hidden',
        }}
      >
        {rows.map((r, i) => (
          <ProbRowView key={r.q} row={r} alt={i % 2 === 1} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.45 }}>
        A dash means this Kendall class has no closed form for that question.
        The M/G/1 family has no elementary Pₙ, so the first two rows are blank
        for it; the finite-buffer models do have Pₙ but the textbook states the
        waiting-time tails only for the unbounded queue, so the last two are
        blank for them.
      </div>
    </section>
  );
}

interface ProbRow {
  q: QuantityId;
  control: {
    value: number;
    onChange: (v: number) => void;
    min: number;
    step: number;
    suffix: string;
    /** Second row driven by the same input — show it read-only. */
    mirrored?: boolean;
  };
  value: number;
  question: string;
}

function ProbRowView({ row, alt }: { row: ProbRow; alt: boolean }) {
  const q = QUANTITY[row.q];
  return (
    // Two lines rather than three columns: this panel also renders inside the
    // Sim station drawer, which is far narrower than the detail page, and a
    // three-column row wrapped the question into a five-line column there.
    <div
      style={{
        padding: '10px 12px',
        background: alt ? SW_COLORS.paperDeep : SW_COLORS.paper,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <Sym quantity={row.q} color={SW_COLORS.brandText} />
        <span style={{ fontSize: 12, color: SW_COLORS.ink, lineHeight: 1.4 }}>{row.question}</span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginTop: 6,
        }}
      >
        {row.control.mirrored ? (
          <span style={{ fontSize: 10, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono }}>
            follows the row above
          </span>
        ) : (
          <>
            <NumberInput
              value={row.control.value}
              min={row.control.min}
              step={row.control.step}
              onChange={(v) => { if (v !== undefined) row.control.onChange(v); }}
              style={{ ...inputStyle(true), width: 62, padding: '4px 6px', fontSize: 12 }}
            />
            <span style={{ fontSize: 10, color: SW_COLORS.muted }}>{row.control.suffix}</span>
          </>
        )}
        {q.formula && (
          <span
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              color: SW_COLORS.muted,
              marginLeft: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={q.formula}
          >
            {q.formula}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 15,
            fontWeight: 700,
            color: Number.isFinite(row.value) ? SW_COLORS.ink : SW_COLORS.faint,
          }}
        >
          {pct(row.value)}
        </span>
      </div>
    </div>
  );
}

function Footer({ station }: { station: StationView }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 8,
        borderTop: `1px solid ${SW_COLORS.line}`,
        paddingTop: 12,
      }}
    >
      <FooterStat label="Bundles done" value={station.produced} />
      <FooterStat
        label={<>Avg service <Sym quantity="serviceTime" bracketed /> min</>}
        value={station.produced > 0 ? (station.totalBusyTime / station.produced).toFixed(2) : '—'}
      />
      <FooterStat
        label={<>Operator util <Sym quantity="rho" bracketed /></>}
        value={pct(station.utilization)}
      />
    </div>
  );
}

function FooterStat({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: SW_COLORS.muted,
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 16,
          fontWeight: 900,
          color: SW_COLORS.ink,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────

function stabilityIndicator(rho: number, finiteBuffer: boolean) {
  if (!Number.isFinite(rho) || rho < 0) {
    return { color: SW_COLORS.faint, label: 'WARMING UP' };
  }
  if (finiteBuffer) {
    // Finite-capacity systems are always stable; flag high traffic anyway.
    if (rho >= 0.95) return { color: SW_COLORS.warn, label: `ρ=${rho.toFixed(2)} HIGH` };
    return { color: SW_COLORS.ok, label: `ρ=${rho.toFixed(2)} OK` };
  }
  if (rho >= 1) return { color: SW_COLORS.alarm, label: `ρ=${rho.toFixed(2)} UNSTABLE` };
  if (rho >= 0.85) return { color: SW_COLORS.warn, label: `ρ=${rho.toFixed(2)} HIGH` };
  return { color: SW_COLORS.ok, label: `ρ=${rho.toFixed(2)} STABLE` };
}

function hoursToMin(h: number): number {
  if (!Number.isFinite(h)) return h;
  return h * 60;
}

function pct(v: number): string {
  if (!Number.isFinite(v)) return v === Infinity ? '∞' : '—';
  return `${(v * 100).toFixed(1)}%`;
}

function num2(v: number): string {
  if (!Number.isFinite(v)) return v === Infinity ? '∞' : '—';
  return v.toFixed(2);
}

