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

import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, SectionHeader, StationTimeseriesGrid } from '../components';
import { QueueAnalysisPanel, type QueueAnalysisChange } from '../components/QueueAnalysisPanel';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import {
  meanOf,
  usePmlSim,
  EMPTY_TWIN,
  type QueueDiscipline,
  type ServiceDist,
  type StationView,
} from '../simulation';
import { buildGarmentTwin } from '../domain/reference-twin';
import { useGarments } from '../store/garments';
import { useProject } from '../store/project';
import { GARMENT_TEMPLATES } from '../domain';

const WARMUP_MINUTES = 480; // 8-hour shift — long enough for KPIs to stabilise.

export function WorkstationDetailPage() {
  const { deptId, wsId } = useParams();
  const navigate = useNavigate();

  // Project + garment + skill matrix → synthetic twin → PML
  const project = useProject();
  const selectedGarmentId = useProject((s) => s.selectedGarmentId);
  const defaultOperators = useProject((s) => s.defaultOperators);
  const updateOperation = useProject((s) => s.updateOperation);
  const garments = useGarments();
  const garment = garments.byId[selectedGarmentId] ?? garments.all[0];

  const opIndex = useMemo(() => {
    if (!garment) return -1;
    // Try direct match by id, then fall back to numeric index.
    const byId = garment.operations.findIndex((o) => o.id === wsId);
    if (byId >= 0) return byId;
    const n = Number(wsId);
    if (Number.isFinite(n) && n >= 0 && n < garment.operations.length) return n;
    return -1;
  }, [garment, wsId]);

  const op = opIndex >= 0 ? garment.operations[opIndex] : undefined;

  // Synthesise a single-line twin from the garment so PML has a graph to run.
  // Empty-twin fallback keeps the hook call unconditional in the corner case
  // where the garment carries no ops (the page renders an empty state below).
  const twin = useMemo(
    () => buildGarmentTwin(garment, defaultOperators) ?? EMPTY_TWIN,
    [garment, defaultOperators],
  );

  const { state, step, reset } = usePmlSim(twin, { garment });

  // Auto-warm the sim once on mount so KPIs aren't all zeros.
  useEffect(() => {
    if (state.time === 0) step(WARMUP_MINUTES);
    // We deliberately don't depend on `step` here — useSim provides a stable
    // reference, and we want this effect to run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!op || opIndex < 0) {
    return (
      <Card>
        <SectionHeader title="Workstation not found" />
        <p style={{ fontSize: 13, color: SW_COLORS.muted }}>
          No operation with id <code>{wsId}</code> in {garment?.name ?? 'this garment'}.
        </p>
        <button
          type="button"
          onClick={() => navigate('/factory')}
          style={navBtn()}
        >
          Back to factory
        </button>
      </Card>
    );
  }

  // Lookup by opId — robust to the adapter's ordering (which mirrors the
  // synthesised twin's workstation order, not the garment's operation index).
  const station = state.stations.find((s) => s.opId === op.id);

  // Save the change back to the operation in the project store so it
  // persists and re-flows through buildSimConfig on the next run.
  const handleChange = (patch: QueueAnalysisChange) => {
    if (!garment) return;
    const opPatch: Partial<{
      serviceDistribution: ServiceDist;
      queueCapacity: number;
      queueDiscipline: typeof patch.queueDiscipline;
      servers: number;
    }> = {};
    if (patch.serviceDistribution) opPatch.serviceDistribution = patch.serviceDistribution;
    if (patch.queueCapacity != null) opPatch.queueCapacity = patch.queueCapacity;
    if (patch.queueDiscipline) opPatch.queueDiscipline = patch.queueDiscipline;
    if (patch.servers != null) opPatch.servers = patch.servers;
    if (Object.keys(opPatch).length === 0) return;
    updateOperation(garment.id, GARMENT_TEMPLATES[garment.id], op.id, opPatch);
  };

  // Keep a reference to the project for future hooks (factory tree etc.).
  void project;

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
            Workstation · {deptId ?? '—'} / {wsId ?? '—'}
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
            {op.name}
          </h1>
          <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4 }}>
            {garment.name} · op #{opIndex + 1} of {garment.operations.length} · SMV {op.smv.toFixed(2)} min
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

      {station && (
        <Card>
          <SectionHeader
            title="How this station is doing — live"
            sub={`Last ${(state.stationHistory[opIndex] ?? []).length * 5} sim-min. Solid line = what the simulator saw. Dashed line = the steady-state target from queueing theory.`}
          />
          <FloorLine station={station} />
          <div style={{ marginTop: 12 }}>
            <StationTimeseriesGrid
              station={station}
              history={state.stationHistory[opIndex] ?? []}
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
