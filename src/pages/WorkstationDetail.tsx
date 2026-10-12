/**
 * Workstation Detail — one station, read as a queueing system.
 *
 * WHAT IT IS FOR. INSIGHTS ranks the whole line; this page answers the next
 * question about a single station on it: *is the model of this station sound,
 * and what happens if I change it?* It is built around the **Queue Analysis
 * Panel** — the station as a queueing-theory object (M/M/c, M/D/1, M/Ek/1,
 * M/M/c/N, …) with editable servers, buffer, service distribution and
 * discipline — and then spends the rest of its height putting the simulator's
 * measurements next to the closed-form steady state for that class. A gap that
 * refuses to close is the finding.
 *
 * HOW YOU GET HERE. It is not a rail destination. The only way in is to click
 * a station from INSIGHTS: the *Per-station queues* table (or its queue
 * diagrams), or a strip/compare chart under *Over time*. Both drills tag the
 * URL with `?from=<tab>` so the back link can return to the exact table the
 * user left, rather than dropping them on Diagnosis.
 *
 * Route: /workstation/:deptId/:wsId
 *   `wsId` is a WORKSTATION id; the operation id is accepted as a fallback so
 *   older saved links still land. `deptId` is legacy — every caller passes
 *   'sewing' and nothing resolves through it — so it is no longer printed as
 *   though it were a real department.
 */

import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Card,
  LineSimEmpty,
  SectionHeader,
  QueueingReference,
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

/** INSIGHTS tabs that drill in here, and how to name them going back. */
const BACK_TABS: Record<string, string> = {
  queues: 'Per-station queues',
  timeline: 'Over time',
};

export function WorkstationDetailPage() {
  const { wsId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Where the drill started. Unknown or absent ⇒ the station table, which is
  // the entry point for all but one of the links into this page.
  const from = searchParams.get('from') ?? 'queues';
  const backTab = from in BACK_TABS ? from : 'queues';
  const back = () => navigate(`/insights?tab=${backTab}`);

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
    // The discipline was the one field this handler dropped, so changing it
    // here relabelled the station without changing the run.
    if (patch.queueDiscipline) params.queueDiscipline = patch.queueDiscipline;
    setBlock(ws.id, {
      ...(ws.block ?? {}),
      kind: getBlockKind(ws),
      params: params as never,
    });
  };

  if (emptyReason) {
    return (
      <PageShell backTab={backTab} onBack={back}>
        <LineSimEmpty
          reason={emptyReason}
          unassignedStationCount={unassignedStationCount}
          what="Station analysis"
        />
      </PageShell>
    );
  }

  if (!station) {
    return (
      <PageShell backTab={backTab} onBack={back}>
        <Card>
          <SectionHeader title="Station not found" />
          <p style={{ fontSize: 13, color: SW_COLORS.muted }}>
            No station <code>{wsId}</code> on the line currently in scope. It may belong to a
            different line — change the line scope on INSIGHTS and pick the station again.
          </p>
          <button type="button" onClick={back} style={navBtn()}>
            Back to {BACK_TABS[backTab]}
          </button>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell backTab={backTab} onBack={back}>
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
            Workstation · {station.opCode ?? station.opId}
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
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* The two curves are one reading, not two: ρ̂ says how hard the
                operator is working and L̄q says what that does to the queue, and
                the interesting case is when only one of them has settled. Stacked
                full-width they could not be compared without moving your eyes a
                chart-height apart, and the SVG (600 units wide, drawn with
                `preserveAspectRatio: none`) was stretched ~2.5× horizontally at
                that width — squashed-looking axis labels on a chart nobody could
                read side by side anyway. Two columns puts them level with each
                other and lands the plot near its intended scale.

                `alignItems: start` because a chart that has not converged grows a
                divergence note underneath it; without this the shorter column
                would stretch to match and the two plots would stop being level,
                which is the whole point. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                alignItems: 'start',
                gap: 16,
              }}
            >
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
            </div>
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

      {/* The reference is generated from the same symbol vocabulary the
          Inspector fields use, so the sheet cannot drift from the labels. */}
      <QueueingReference />
    </PageShell>
  );
}

/**
 * The page's own scroll box.
 *
 * Every surface in this app owns its scrolling: the shell's route outlet is
 * `overflow: hidden` at `100vh`, so a page that lays itself out as a bare
 * column just grows past the viewport and everything below the fold becomes
 * unreachable. This page did exactly that — around 4,000px of charts inside a
 * clipped 100vh box, flush against the sidebar with no padding, because it was
 * the one surface that never got the container the others have.
 */
/**
 * The page's scroll box, and the way out of it.
 *
 * SCROLLING. Every surface in this app owns its own scrolling: the shell's
 * route outlet is `overflow: hidden` at `100vh`, so a page that lays itself
 * out as a bare column just grows past the viewport and everything below the
 * fold becomes unreachable. This page did exactly that — some 4,000px of
 * charts inside a clipped 100vh box, flush against the sidebar with no
 * padding, because it was the one surface that never got the container the
 * others have. The scroll box is a plain block and the column lives inside it,
 * so the cards keep their natural heights instead of being flex-shrunk into
 * each other on a short viewport.
 *
 * BACK. The page is only ever arrived at by drilling, and it had no back
 * affordance of any kind — no breadcrumb, no button, and a sidebar that
 * highlighted MENU while you stood on it. The browser back button worked,
 * which is not the same as the app admitting there is anywhere to go.
 */
function PageShell({
  backTab,
  onBack,
  children,
}: {
  backTab: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: '20px 24px',
        background: SW_COLORS.paperDeep,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: SW_FONTS.mono,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            color: SW_COLORS.muted,
          }}
          title={`Back to Insights · ${BACK_TABS[backTab]}`}
        >
          <span aria-hidden style={{ fontSize: 13 }}>←</span>
          Insights · {BACK_TABS[backTab]}
        </button>
        {children}
      </div>
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
