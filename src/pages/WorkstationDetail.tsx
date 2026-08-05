/**
 * Workstation Detail — third-level drill-down from Department Interior.
 *
 * The page is built around the **Queue Analysis Panel**: one workstation as
 * a queueing-theory object (M/M/c, M/D/1, M/Ek/1, M/M/c/N, …), with the
 * sim engine running a short warm-up so the analytical and observed KPIs
 * have meaningful values to compare.
 *
 * Drill-down route: /workstation/:deptId/:wsId
 *   `wsId` is the operation id within the active garment bulletin
 *   (e.g. "OP-04"). Fallback: if the id doesn't match, we treat wsId as
 *   a positional index into the operations array.
 */

import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Card,
  LineSimEmpty,
  SectionHeader,
  SimTransportBar,
  StationTimeseriesGrid,
} from '../components';
import { BalkRatePanel, ConvergenceChart, LittlesLawCheck } from '../components/charts';
import { QueueAnalysisPanel, type QueueAnalysisChange } from '../components/QueueAnalysisPanel';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { meanOf, type QueueDiscipline, type StationView } from '../simulation';
import { useLineSim } from '../simulation/useLineSim';
import { useSimSession } from '../simulation/useSimSession';
import { useTwin } from '../store/twin';
import { getBlockKind } from '../domain/pml';

export function WorkstationDetailPage() {
  const { deptId, wsId } = useParams();
  const navigate = useNavigate();

  const { state, twin, emptyReason, unassignedStationCount } = useLineSim();
  const reset = useSimSession((s) => s.reset);
  const step = useSimSession((s) => s.step);
  const setBlock = useTwin((s) => s.setBlock);

  /**
   * Resolve the route parameter to a station.
   *
   * `wsId` is a WORKSTATION id. It used to be read as an operation id, which
   * cannot address a station at all on a balanced line: two stations running
   * the same operation are indistinguishable that way, and the first one always
   * won. The opId lookup is kept as a fallback so links saved before the change
   * still land somewhere sensible.
   */
  const stationIdx = useMemo(() => {
    if (!wsId) return -1;
    const byWs = state.stations.findIndex((s) => s.wsId === wsId);
    if (byWs >= 0) return byWs;
    return state.stations.findIndex((s) => s.opId === wsId);
  }, [state.stations, wsId]);

  const station: StationView | undefined = stationIdx >= 0 ? state.stations[stationIdx] : undefined;

  /**
   * Persist an edit onto the WORKSTATION, not the shared garment operation.
   *
   * Writing to the operation changed every station running it — on a balanced
   * line that is most of the floor — so tuning one station's buffer silently
   * retuned its neighbours. Block params are also what the engine and the
   * analytical layer both resolve through (`serversFor` / `systemCapacityFor`),
   * so a workstation-level write is what actually takes effect.
   */
  const handleChange = (patch: QueueAnalysisChange) => {
    if (!station) return;
    const ws = twin.workstations.find((w) => w.id === station.wsId);
    if (!ws) return;
    const params: Record<string, unknown> = { ...(ws.block?.params ?? {}) };
    if (patch.serviceDistribution) params.cycleDist = patch.serviceDistribution;
    if (patch.servers != null) params.servers = patch.servers;
    // `in` rather than a null check: `undefined` MEANS unbounded here, and a
    // null check made "set the buffer back to ∞" a silent no-op — the user
    // could cap a station but never uncap it. PmlBlockParams encodes unbounded
    // as 0, while Operation.queueCapacity encodes it as undefined.
    if ('queueCapacity' in patch) params.queueCapacity = patch.queueCapacity ?? 0;
    setBlock(ws.id, {
      ...(ws.block ?? {}),
      kind: getBlockKind(ws),
      params: params as never,
    });
  };

  if (emptyReason) {
    return (
      <div style={{ padding: '20px 24px' }}>
        <LineSimEmpty
          reason={emptyReason}
          unassignedStationCount={unassignedStationCount}
          what="Station analysis"
        />
      </div>
    );
  }

  if (!station) {
    return (
      <Card>
        <SectionHeader title="Station not found" />
        <p style={{ fontSize: 13, color: SW_COLORS.muted }}>
          No station <code>{wsId}</code> on the line currently in scope. It may belong to a
          different line — switch scope on the Queue Analysis page and try again.
        </p>
        <button type="button" onClick={() => navigate('/insights')} style={navBtn()}>
          Back to queue analysis
        </button>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
            Workstation · {deptId ?? '—'} / {station.opCode ?? station.opId}
          </div>
          <h1
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 28,
              fontWeight: 900,
              letterSpacing: '-0.02em',
              color: SW_COLORS.ink,
              margin: '6px 0 0 0',
            }}
          >
            {station.opName}
          </h1>
          <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4 }}>
            {station.machineCode} · station {stationIdx + 1} of {state.stations.length} ·
            {' '}SMV {station.smv.toFixed(2)} min · {station.notation.label}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => reset()}
            style={navBtn()}
            title="Rewind the shared sim clock to the start of the shift"
          >
            ⟲ Rewind
          </button>
          <button
            type="button"
            onClick={() => step(60)}
            style={{
              ...navBtn(),
              background: SW_COLORS.brand,
              color: SW_COLORS.paper,
              border: 'none',
            }}
            title="Advance the sim by 1 hour"
          >
            +1 hr
          </button>
        </div>
      </header>

      {station ? (
        <QueueAnalysisPanel station={station} onChange={handleChange} />
      ) : (
        <Card>
          <p style={{ fontSize: 13, color: SW_COLORS.muted }}>Warming up the simulator…</p>
        </Card>
      )}

      {/*
        Sim-versus-theory convergence.

        This section is the payoff of instrumenting the engine. Until ρ̂ was a
        cumulative time-average from ∫busy dt, the "observed" line here was an
        instantaneous 0/1 square wave that could never settle onto the analytical
        target beside it — so drawing them together was actively misleading.
        Watching them meet is the clearest evidence the model is sound, and a gap
        that refuses to close is itself the finding.
      */}
      {station && (
        <Card>
          <SectionHeader
            title="Simulated vs. theory"
            sub="Solid = measured from the run. Dashed = the closed-form steady state for this station's Kendall–Lee class. They should converge as the shift plays."
            right={<SimTransportBar />}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <ConvergenceChart
              station={station}
              history={state.stationHistory[stationIdx] ?? []}
              metric="rho"
            />
            <ConvergenceChart
              station={station}
              history={state.stationHistory[stationIdx] ?? []}
              metric="Lq"
            />
            <div style={{ borderTop: `1px solid ${SW_COLORS.line}`, paddingTop: 12 }}>
              <LittlesLawCheck station={station} />
            </div>
            <div style={{ borderTop: `1px solid ${SW_COLORS.line}`, paddingTop: 12 }}>
              <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.12em', marginBottom: 6 }}>
                BALKING
              </div>
              <BalkRatePanel station={station} />
            </div>
          </div>
        </Card>
      )}

      {station && (
        <Card>
          <SectionHeader
            title="How this station is doing — live"
            sub={`Last ${(state.stationHistory[stationIdx] ?? []).length * 5} sim-min. Solid line = what the simulator saw. Dashed line = the steady-state target from queueing theory.`}
          />
          <FloorLine station={station} />
          <div style={{ marginTop: 12 }}>
            <StationTimeseriesGrid
              station={station}
              history={state.stationHistory[stationIdx] ?? []}
            />
          </div>
        </Card>
      )}

      <Card>
        <SectionHeader title="Queueing-theory cheat sheet" />
        <ul
          style={{
            fontSize: 13,
            lineHeight: 1.6,
            paddingLeft: 18,
            margin: 0,
            color: SW_COLORS.ink,
          }}
        >
          <li>
            <strong>ρ (rho)</strong> — traffic intensity. For a single server ρ = λ/μ; for c servers
            ρ = λ/(cμ). Must be &lt; 1 for an infinite-buffer line to stay stable.
          </li>
          <li>
            <strong>Lq</strong> — average number of bundles waiting in queue. This is the bottleneck
            signal: high Lq → bundles pile up here → upstream throughput throttled.
          </li>
          <li>
            <strong>L = Lq + ρ</strong> — average WIP at this station (queue + in-service). When you
            sum L across all stations you get the line's total WIP.
          </li>
          <li>
            <strong>Wq</strong>, <strong>W</strong> — average time a bundle spends waiting / in the
            station. Little's law: L = λW, Lq = λWq.
          </li>
          <li>
            <strong>Balking</strong> — bundles rejected when the buffer is full (only in M/M/c/N).
            Real sewing lines block upstream instead of dropping; here we approximate with balking
            for textbook coherence.
          </li>
        </ul>
      </Card>
    </div>
  );
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

/**
 * One-line header above the time-series grid. Translates the technical layer
 * (c, μ, queue discipline) into floor language so a production manager who
 * skipped the cheat sheet still gets the operating picture at a glance. The
 * actual `c` (operators here) is the answer to "why does it look like 1?" —
 * it's surfaced explicitly here.
 */
function FloorLine({ station }: { station: StationView }) {
  const serviceMin = meanOf(station.serviceDist);
  const stitchRatePerHr = serviceMin > 0 ? 60 / serviceMin : 0;
  const cartLabel = disciplineToFloorLabel(station.notation.discipline);
  const operatorWord = station.serversTotal === 1 ? 'operator' : 'operators';
  return (
    <div
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: 12,
        color: SW_COLORS.ink,
        background: SW_COLORS.paperEdge,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        padding: '8px 12px',
        display: 'flex',
        gap: 14,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <span>
        <strong>{station.serversTotal}</strong> {operatorWord} here
      </span>
      <Dot />
      <span>
        Stitch rate <strong>{stitchRatePerHr.toFixed(1)}</strong>/hr
      </span>
      <Dot />
      <span>{cartLabel}</span>
      <Dot />
      <span style={{ color: SW_COLORS.muted }}>{station.notation.label}</span>
    </div>
  );
}

function Dot() {
  return (
    <span
      aria-hidden
      style={{
        width: 4,
        height: 4,
        borderRadius: '50%',
        background: SW_COLORS.muted,
        display: 'inline-block',
      }}
    />
  );
}

function disciplineToFloorLabel(d: QueueDiscipline): string {
  switch (d) {
    case 'FCFS': return 'FIFO cart (first in, first out)';
    case 'SIRO': return 'Random pick';
    case 'Priority': return 'Rush bundles first';
    default: return d;
  }
}
