/**
 * SimStationDetail — the Sim view's per-station "sim vs theory" drawer.
 *
 * Opens when a station is clicked in the ISO or TOP view. Unlike the old
 * Builder-embedded panel (which spun up a synthetic single-line twin and ran
 * its own throwaway simulation), this reads the REAL factory simulation that
 * is already running on this page — `state.stations[i]` and
 * `state.stationHistory[i]` — so the sim-vs-analytical comparison reflects the
 * factory the user actually built.
 *
 * Almost everything here is read-only — with one exception, and it is a
 * deliberate one. The station's KPI TARGETS are authored in this drawer, not
 * in the Builder Inspector where they used to live. A target is a claim about
 * how the line performs; it belongs beside the run that either meets it or
 * does not, so the number you type has the number it is being compared to
 * directly under it.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Card } from './Card';
import { SectionHeader } from './SectionHeader';
import { ToggleGroup } from './ToggleGroup';
import { MetricLabel, Sym } from './Sym';
import { NumberInput } from './NumberInput';
import { QueueAnalysisPanel } from './QueueAnalysisPanel';
import { useTwin, selectActiveTwin } from '../store/twin';
import {
  StationTimeseriesChart,
  StationTimeseriesGrid,
  type StationMetric,
} from './StationTimeseriesChart';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import type { StationView, StationHistoryPoint } from '../simulation';

export function SimStationDetail({
  station,
  history,
  onClose,
}: {
  station: StationView;
  history: StationHistoryPoint[];
  onClose: () => void;
}) {
  const [compareMetric, setCompareMetric] = useState<StationMetric>('rho');
  const warm = history.length > 1;

  return (
    <div style={drawer()}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 9,
              fontWeight: 700,
              color: SW_COLORS.muted,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
            }}
          >
            Station · sim vs theory
          </div>
          <div
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 18,
              fontWeight: 900,
              color: SW_COLORS.ink,
              lineHeight: 1.1,
              marginTop: 2,
            }}
          >
            {station.opCode ? `${station.opCode} · ` : ''}
            {station.opName}
          </div>
        </div>
        <button type="button" onClick={onClose} title="Close" style={closeBtn()}>
          ✕
        </button>
      </div>

      {!warm && (
        <div style={hint()}>
          Press <strong>▶ PLAY</strong> or <strong>+1h</strong> to accumulate history for the trend
          charts.
        </div>
      )}

      {/* Read-only Kendall classification + sim-vs-analytical KPI table, fed by
          the real run on this page. */}
      <QueueAnalysisPanel station={station} />

      <StationTargets station={station} history={history} />

      {/* Sim vs theory — solid line = simulated, dashed = steady-state target. */}
      <Card>
        <SectionHeader
          title="Sim vs theory"
          sub={`Last ${history.length * 5} sim-min. Solid is what the simulator saw; dashed is the steady-state target from queueing theory.`}
        />
        <StationTimeseriesGrid station={station} history={history} height={80} />
      </Card>

      {/* Focus one metric */}
      <Card>
        <SectionHeader
          title="Focus one metric"
          sub="Zoom in on a single observable — same data as the grid, larger so drift from the target line is easy to read."
          right={
            <ToggleGroup<StationMetric>
              value={compareMetric}
              options={[
                { value: 'rho', label: <MetricLabel name="Saturation" quantity="rho" /> },
                { value: 'L', label: <MetricLabel name="At station" quantity="L" /> },
                { value: 'Wq', label: <MetricLabel name="Wait" quantity="Wq" /> },
                { value: 'Lq', label: <MetricLabel name="Waiting" quantity="Lq" /> },
              ]}
              onChange={setCompareMetric}
            />
          }
        />
        <StationTimeseriesChart
          history={history}
          metric={compareMetric}
          analyticalRef={analyticalRefFor(station, compareMetric)}
          height={180}
        />
      </Card>
    </div>
  );
}

/**
 * Target vs achieved, for the three KPIs a station carries.
 *
 * The targets are the same `Workstation.kpiTargets` the Builder Inspector used
 * to edit, written through the same store action. What has changed is where
 * they are typed: there, the panel could show you a target and the result of
 * the previous run, and the previous run was the only thing on that screen
 * that had ever been measured. Here the comparison is live, against the run
 * playing behind the drawer.
 *
 * `Output / hr` is the one target the ENGINE reads back: `runPmlOnTwin`
 * divides a station's observed throughput by it to record an efficiency
 * percentage on the twin. Leaving it at 0 makes that percentage a flat 100.
 */
function StationTargets({
  station,
  history,
}: {
  station: StationView;
  history: StationHistoryPoint[];
}) {
  const twin = useTwin(selectActiveTwin);
  const setKpiTargets = useTwin((s) => s.setKpiTargets);
  const ws = twin.workstations.find((w) => w.id === station.wsId);
  if (!ws) return null;
  const targets = ws.kpiTargets;

  // Achieved output, straight off the run: bundles completed here over the
  // sim-hours elapsed. The station history carries the clock; without a
  // second sample there is no elapsed span to divide by yet.
  const elapsedMin = history.length > 0 ? history[history.length - 1].time : 0;
  const achievedPerHr = elapsedMin > 0 ? (station.produced * 60) / elapsedMin : null;
  const achievedUtilPct = station.utilization * 100;
  const achievedEffPct =
    achievedPerHr != null && targets.capacityPerHr
      ? (achievedPerHr / targets.capacityPerHr) * 100
      : null;

  return (
    <Card>
      <SectionHeader
        title="Targets"
        sub="What this station is meant to hit, and what the run has it doing. Blank or 0 means no target set."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        <TargetRow
          label={<>Output / hr <Sym quantity="mu" bracketed /></>}
          unit="bundles"
          value={targets.capacityPerHr ?? 0}
          onChange={(v) => setKpiTargets(ws.id, { capacityPerHr: v })}
          achieved={achievedPerHr == null ? '—' : achievedPerHr.toFixed(1)}
        />
        <TargetRow
          label="Efficiency %"
          unit="%"
          value={targets.efficiencyPct ?? 0}
          onChange={(v) => setKpiTargets(ws.id, { efficiencyPct: v })}
          achieved={achievedEffPct == null ? '—' : achievedEffPct.toFixed(1)}
        />
        <TargetRow
          label={<>Utilisation % <Sym quantity="rho" bracketed /></>}
          unit="%"
          value={targets.utilizationPct ?? 0}
          onChange={(v) => setKpiTargets(ws.id, { utilizationPct: v })}
          achieved={achievedUtilPct.toFixed(1)}
        />
      </div>
    </Card>
  );
}

/** One target: the field you set, and the number the run put beside it. The
 *  achieved column is toned by whether the target was met — and stays neutral
 *  while there is no target to be met. */
function TargetRow({
  label,
  unit,
  value,
  onChange,
  achieved,
}: {
  label: ReactNode;
  unit: string;
  value: number;
  onChange: (v: number) => void;
  achieved: string;
}) {
  const met = value > 0 && achieved !== '—' ? Number(achieved) >= value : null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 82px 64px', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: SW_COLORS.muted, fontWeight: 700 }}>{label}</span>
      <NumberInput
        value={value}
        min={0}
        onChange={(v) => onChange(v ?? 0)}
        style={{
          width: '100%',
          padding: '4px 6px',
          fontSize: 11,
          fontFamily: SW_FONTS.mono,
          background: SW_COLORS.paper,
          color: SW_COLORS.ink,
          border: `1px solid ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.sm,
        }}
      />
      <span
        title={`Achieved so far in this run (${unit})`}
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 12,
          fontWeight: 800,
          textAlign: 'right',
          color: met == null ? SW_COLORS.muted : met ? SW_COLORS.ok : SW_COLORS.alarm,
        }}
      >
        {achieved}
      </span>
    </div>
  );
}

function analyticalRefFor(station: StationView, metric: StationMetric): number {
  switch (metric) {
    case 'rho': return station.analytical.rho;
    case 'L':   return station.analytical.L;
    case 'Lq':  return station.analytical.Lq;
    case 'Wq':  return station.analytical.Wq * 60; // queueing.ts returns hours
  }
}

// Functions (not consts) so SW_COLORS/SW_RADIUS are read at render time — the
// vibe system mutates the token objects in place, and a module-level const
// would capture the pre-vibe values forever.
const drawer = (): CSSProperties => ({
  position: 'absolute',
  right: 24,
  top: 24,
  width: 380,
  maxHeight: 'calc(100% - 48px)',
  overflow: 'auto',
  background: SW_COLORS.paper,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.md,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
  zIndex: 7,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 14,
});

const closeBtn = (): CSSProperties => ({
  background: SW_COLORS.paper,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
  width: 28,
  height: 28,
  flexShrink: 0,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 700,
  color: SW_COLORS.ink,
  lineHeight: 1,
});

const hint = (): CSSProperties => ({
  fontSize: 12,
  color: SW_COLORS.muted,
  lineHeight: 1.5,
  padding: 8,
  background: SW_COLORS.paperDeep,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
});
