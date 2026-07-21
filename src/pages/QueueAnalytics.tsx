/**
 * Queue Analytics — cross-station view of the four queueing-theory observables
 * (operator saturation, bundles at station, bundle wait time, bundles waiting)
 * as time-series, sourced from the engine's `state.stationHistory`.
 *
 * Two layouts:
 *  - Strip mode  — one row per station, four small charts side-by-side. Best
 *                  for spot-checking every station at once after a sim run.
 *  - Compare mode — one metric picked from a toggle; every station stacked
 *                  with shared Y-axis. Best for ranking stations by ρ or Wq.
 *
 * Sister page to /queues (QueueIndex). The user enters here from a
 * "Compare stations →" button on QueueIndex when they want time-series
 * instead of the snapshot table.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  SectionHeader,
  StationTimeseriesChart,
  StationTimeseriesGrid,
  ToggleGroup,
  type StationMetric,
} from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import {
  meanOf,
  usePmlSim,
  EMPTY_TWIN,
  type QueueDiscipline,
  type StationView,
} from '../simulation';
import { buildGarmentTwin } from '../domain/reference-twin';
import { useGarments } from '../store/garments';
import { useProject } from '../store/project';
import { DRILL_PATHS } from '../lib/routes';

const WARMUP_MINUTES = 480;

type ViewMode = 'strip' | 'compare';

export function QueueAnalyticsPage() {
  const navigate = useNavigate();
  const selectedGarmentId = useProject((s) => s.selectedGarmentId);
  const defaultOperators = useProject((s) => s.defaultOperators);
  const garments = useGarments();
  const garment = garments.byId[selectedGarmentId] ?? garments.all[0];

  // Synthesise a single-line twin from the garment so PML has a graph to run.
  const twin = useMemo(
    () => buildGarmentTwin(garment, defaultOperators) ?? EMPTY_TWIN,
    [garment, defaultOperators],
  );

  const { state, step, reset } = usePmlSim(twin, { garment });

  useEffect(() => {
    if (state.time === 0) step(WARMUP_MINUTES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [view, setView] = useState<ViewMode>('strip');
  const [metric, setMetric] = useState<StationMetric>('rho');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '20px 24px',
        height: '100%',
        overflow: 'auto',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              letterSpacing: '0.6px',
              color: SW_COLORS.muted,
              textTransform: 'uppercase',
            }}
          >
            Σ · Queue analytics · time-series
          </div>
          <h1
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 32,
              fontWeight: 900,
              letterSpacing: '-0.02em',
              color: SW_COLORS.ink,
              margin: '6px 0 0 0',
            }}
          >
            How every station is moving
          </h1>
          <div style={{ fontSize: 13, color: SW_COLORS.muted, marginTop: 4 }}>
            Four observables per station over simulated time. Solid line = what
            the simulator saw; dashed line = the steady-state target from
            queueing theory. Watch for solid lines that don't settle near the
            dashed — those stations are the ones to tune first.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              reset();
              step(WARMUP_MINUTES);
            }}
            style={navBtn()}
            title="Re-run the 8-hour warm-up"
          >
            ⟲ Re-run sim
          </button>
          <button
            type="button"
            onClick={() => step(60)}
            style={{ ...navBtn(), background: SW_COLORS.brand, color: SW_COLORS.paper, border: 'none' }}
            title="Advance the sim by 1 hour"
          >
            +1 hr
          </button>
          <button
            type="button"
            onClick={() => navigate('/queues')}
            style={navBtn()}
            title="Back to the snapshot table"
          >
            ← Queue table
          </button>
        </div>
      </header>

      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <SectionHeader title="View" />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <ToggleGroup<ViewMode>
              value={view}
              options={[
                { value: 'strip', label: 'Strip · all four metrics per station' },
                { value: 'compare', label: 'Compare · one metric across stations' },
              ]}
              onChange={setView}
            />
            {view === 'compare' && (
              <ToggleGroup<StationMetric>
                value={metric}
                options={[
                  { value: 'rho', label: 'Saturation' },
                  { value: 'L', label: 'At station' },
                  { value: 'Wq', label: 'Wait' },
                  { value: 'Lq', label: 'Waiting' },
                ]}
                onChange={setMetric}
              />
            )}
          </div>
        </div>
      </Card>

      {state.stations.length === 0 ? (
        <Card>
          <p style={{ color: SW_COLORS.muted, fontSize: 13 }}>Warming up the simulator…</p>
        </Card>
      ) : view === 'strip' ? (
        <StripView
          stations={state.stations}
          stationHistory={state.stationHistory}
          bottleneckIdx={state.bottleneckOpIndex}
          onDrill={(opId) => navigate(DRILL_PATHS.workstation('sewing', opId))}
        />
      ) : (
        <CompareView
          stations={state.stations}
          stationHistory={state.stationHistory}
          bottleneckIdx={state.bottleneckOpIndex}
          metric={metric}
          onDrill={(opId) => navigate(DRILL_PATHS.workstation('sewing', opId))}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Sub-views
// ─────────────────────────────────────────────────────────────────────────

function StripView({
  stations,
  stationHistory,
  bottleneckIdx,
  onDrill,
}: {
  stations: StationView[];
  stationHistory: import('../simulation').StationHistoryPoint[][];
  bottleneckIdx: number;
  onDrill: (opId: string) => void;
}) {
  return (
    <Card>
      <SectionHeader
        title="Strip view"
        sub="Every station as a row. Click any row's title to open its full inspector."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {stations.map((s, i) => (
          <StationRow
            key={s.opId}
            station={s}
            history={stationHistory[i] ?? []}
            isBottleneck={i === bottleneckIdx}
            onDrill={() => onDrill(s.opId)}
          />
        ))}
      </div>
    </Card>
  );
}

function StationRow({
  station,
  history,
  isBottleneck,
  onDrill,
}: {
  station: StationView;
  history: import('../simulation').StationHistoryPoint[];
  isBottleneck: boolean;
  onDrill: () => void;
}) {
  return (
    <div
      style={{
        padding: 12,
        border: `1px solid ${isBottleneck ? SW_COLORS.alarm : SW_COLORS.line}`,
        borderRadius: SW_RADIUS.md,
        background: isBottleneck ? `${SW_COLORS.alarm}08` : SW_COLORS.paper,
      }}
    >
      <RowHeader station={station} isBottleneck={isBottleneck} onDrill={onDrill} />
      <div style={{ marginTop: 10 }}>
        <StationTimeseriesGrid station={station} history={history} height={70} />
      </div>
    </div>
  );
}

function CompareView({
  stations,
  stationHistory,
  bottleneckIdx,
  metric,
  onDrill,
}: {
  stations: StationView[];
  stationHistory: import('../simulation').StationHistoryPoint[][];
  bottleneckIdx: number;
  metric: StationMetric;
  onDrill: (opId: string) => void;
}) {
  return (
    <Card>
      <SectionHeader
        title={`Compare view — ${METRIC_LONG_LABEL[metric]}`}
        sub="One observable, every station, stacked. The slowest station's chart will visibly diverge from the others."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {stations.map((s, i) => {
          const ref = analyticalRefFor(s, metric);
          const isBottleneck = i === bottleneckIdx;
          return (
            <div
              key={s.opId}
              style={{
                padding: 10,
                border: `1px solid ${isBottleneck ? SW_COLORS.alarm : SW_COLORS.line}`,
                borderRadius: SW_RADIUS.sm,
                background: isBottleneck ? `${SW_COLORS.alarm}08` : SW_COLORS.paper,
              }}
            >
              <RowHeader station={s} isBottleneck={isBottleneck} onDrill={() => onDrill(s.opId)} />
              <div style={{ marginTop: 8 }}>
                <StationTimeseriesChart
                  history={stationHistory[i] ?? []}
                  metric={metric}
                  analyticalRef={ref}
                  height={60}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RowHeader({
  station,
  isBottleneck,
  onDrill,
}: {
  station: StationView;
  isBottleneck: boolean;
  onDrill: () => void;
}) {
  const serviceMin = meanOf(station.serviceDist);
  const stitchRatePerHr = serviceMin > 0 ? 60 / serviceMin : 0;
  const operatorWord = station.serversTotal === 1 ? 'operator' : 'operators';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onDrill}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: SW_FONTS.display,
            fontSize: 16,
            fontWeight: 800,
            color: SW_COLORS.ink,
            textAlign: 'left',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
            textDecorationColor: SW_COLORS.line,
          }}
          title="Open the full inspector for this station"
        >
          {station.opName}
        </button>
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
          {station.serversTotal} {operatorWord} · {stitchRatePerHr.toFixed(1)}/hr ·{' '}
          {disciplineToFloorLabel(station.notation.discipline)} · {station.notation.label}
        </span>
      </div>
      {isBottleneck && (
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.3px',
            background: `${SW_COLORS.alarm}20`,
            color: SW_COLORS.alarm,
            fontFamily: SW_FONTS.mono,
          }}
        >
          SLOWEST STATION
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────

const METRIC_LONG_LABEL: Record<StationMetric, string> = {
  rho: 'Operator saturation',
  L: 'Bundles at station',
  Wq: 'Bundle wait time (min)',
  Lq: 'Bundles waiting',
};

function analyticalRefFor(station: StationView, metric: StationMetric): number {
  switch (metric) {
    case 'rho': return station.analytical.rho;
    case 'L':   return station.analytical.L;
    case 'Lq':  return station.analytical.Lq;
    case 'Wq':  return station.analytical.Wq * 60; // queueing.ts returns hours
  }
}

function disciplineToFloorLabel(d: QueueDiscipline): string {
  switch (d) {
    case 'FCFS': return 'FIFO cart';
    case 'SIRO': return 'Random pick';
    case 'Priority': return 'Rush first';
    default: return d;
  }
}

// Function (not a const) so tokens are read at render time — the vibe system
// mutates SW_COLORS/SW_FONTS in place.
const navBtn = (): React.CSSProperties => ({
  background: SW_COLORS.paper,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: SW_FONTS.body,
  color: SW_COLORS.ink,
});
