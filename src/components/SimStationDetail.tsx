/**
 * SimStationDetail — the Sim view's per-station "sim vs theory" drawer.
 *
 * Opens when a station is clicked in the ISO or TOP view. Unlike the old
 * Builder-embedded panel (which spun up a synthetic single-line twin and ran
 * its own throwaway simulation), this reads the REAL factory simulation that
 * is already running on this page — `state.stations[i]` and
 * `state.stationHistory[i]` — so the sim-vs-analytical comparison reflects the
 * factory the user actually built. Authoring happens in the Builder; here
 * everything is read-only.
 */

import { useState, type CSSProperties } from 'react';
import { Card } from './Card';
import { SectionHeader } from './SectionHeader';
import { ToggleGroup } from './ToggleGroup';
import { MetricLabel } from './Sym';
import { QueueAnalysisPanel } from './QueueAnalysisPanel';
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
