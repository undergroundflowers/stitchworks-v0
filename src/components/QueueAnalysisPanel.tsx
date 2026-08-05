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
import { ToggleGroup } from './ToggleGroup';
import { QueueDisciplineGraphic } from './QueueDisciplineGraphic';
import {
  DIST_OPTIONS,
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
import type { StationView } from '../simulation';
import { describeDist, type QueueDiscipline } from '../simulation';

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
  const distKind: DistKind = serviceDist.kind;
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
        <ToggleGroup<DistKind>
          value={distKind}
          options={DIST_OPTIONS}
          onChange={(v) => changeDistKind(v)}
        />
        <DistParamInputs
          dist={serviceDist}
          editable={editable}
          onChange={changeDistParam}
        />

        <SubHeader style={{ marginTop: 8 }}>Capacity and servers</SubHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <NumberField
            label="Servers (c)"
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
            label="Discipline"
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
            background: analytical.isStable ? '#F5F1E6' : '#FCE6E1',
            border: `1px solid ${analytical.isStable ? SW_COLORS.paperEdge : SW_COLORS.alarm}30`,
            borderRadius: SW_RADIUS.sm,
            padding: '10px 12px',
            fontSize: 12,
            color: SW_COLORS.ink,
            lineHeight: 1.4,
          }}
        >
          {analytical.note}
        </div>
      )}

      {/* P(wait > w) for M/M/1 */}
      {notation.service === 'M' && notation.servers === 1 && capacity === Infinity && (
        <WaitProbabilityBlock station={station} />
      )}

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
    { label: 'ρ (utilization)', sim: station.utilization, theory: a.rho, format: pct },
    { label: 'Lq (avg queue length)', sim: station.LqObserved, theory: a.Lq, format: num2 },
    { label: 'L (avg in system, WIP)', sim: station.LObserved, theory: a.L, format: num2 },
    { label: 'Wq (avg queue wait, min)', sim: station.WqObservedMin, theory: hoursToMin(a.Wq), format: num2 },
    // W = Wq + service time. The engine measures the wait; adding the mean
    // service time is exact for a single server and the right first-cut for c>1.
    {
      label: 'W (avg system time, min)',
      sim: station.WqObservedMin + station.smv,
      theory: hoursToMin(a.W),
      format: num2,
    },
    { label: 'P₀ (idle prob)', sim: 1 - station.utilization, theory: a.P0, format: pct },
    { label: 'λ offered (/hr)', sim: station.lambda, theory: a.lambdaEff, format: num2 },
    { label: 'Balked', sim: station.balked, theory: NaN, format: intFmt },
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
        <KpiRowView key={r.label} row={r} alt={i % 2 === 1} />
      ))}
    </div>
  );
}

interface KpiRow {
  label: string;
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
        background: alt ? '#FAF7F0' : SW_COLORS.paper,
        fontSize: 13,
        alignItems: 'center',
      }}
    >
      <span style={{ color: SW_COLORS.ink, fontWeight: 600 }}>{row.label}</span>
      <span style={{ textAlign: 'right', fontFamily: SW_FONTS.mono, color: SW_COLORS.ink }}>
        {row.format(row.sim)}
      </span>
      <span style={{ textAlign: 'right', fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>
        {row.format(row.theory)}
      </span>
    </div>
  );
}

function WaitProbabilityBlock({ station }: { station: StationView }) {
  const [w, setW] = useState(5);
  const prob = station.analytical.pWaitGreaterThan(w / 60); // w is in minutes; formula expects hours
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SubHeader>P(wait &gt; w) — M/M/1 only</SubHeader>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="number"
          value={w}
          min={0}
          step={1}
          onChange={(e) => setW(Math.max(0, Number(e.target.value)))}
          style={{ ...inputStyle(true), width: 80 }}
        />
        <span style={{ fontSize: 12, color: SW_COLORS.muted }}>min in queue</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 16,
            fontWeight: 700,
            color: SW_COLORS.ink,
          }}
        >
          {pct(prob)}
        </span>
      </div>
    </section>
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
        label="Avg service (min)"
        value={station.produced > 0 ? (station.totalBusyTime / station.produced).toFixed(2) : '—'}
      />
      <FooterStat
        label="Operator util"
        value={pct(station.utilization)}
      />
    </div>
  );
}

function FooterStat({ label, value }: { label: string; value: React.ReactNode }) {
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

function intFmt(v: number): string {
  if (!Number.isFinite(v)) return v === Infinity ? '∞' : '—';
  return String(Math.round(v));
}
