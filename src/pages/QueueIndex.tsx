/**
 * Queue Analysis index — table of every workstation in the active garment,
 * one row per operation, showing Kendall–Lee classification, observed ρ,
 * Lq, L (WIP), and a click-through to the per-station inspector at
 * /workstation/:deptId/:wsId.
 *
 * This is the top-level entry point for the queueing-theory module: pick a
 * station here, drill in for the deep view.
 */

import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, QueueDiagram, SectionHeader, WipSparkline } from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { usePmlSim, EMPTY_TWIN, type StationView } from '../simulation';
import { buildGarmentTwin } from '../domain/reference-twin';
import { useGarments } from '../store/garments';
import { useProject } from '../store/project';
import { DRILL_PATHS } from '../lib/routes';

const WARMUP_MINUTES = 480; // 8-hour shift warm-up

export function QueueIndexPage() {
  const navigate = useNavigate();
  const selectedGarmentId = useProject((s) => s.selectedGarmentId);
  const defaultOperators = useProject((s) => s.defaultOperators);
  const garments = useGarments();
  const garment = garments.byId[selectedGarmentId] ?? garments.all[0];

  // Synthesise a single-line twin from the garment so PML has a graph to run.
  // The page lists stations against the bulletin; this twin lays out the same
  // ops in the same order and the adapter surfaces them in state.stations[].
  // Falls back to an empty twin so the hook call stays unconditional even when
  // the garment carries no ops (corner case — UI shows the empty-state below).
  const twin = useMemo(
    () => buildGarmentTwin(garment, defaultOperators) ?? EMPTY_TWIN,
    [garment, defaultOperators],
  );

  const { state, step, reset } = usePmlSim(twin, { garment });

  useEffect(() => {
    if (state.time === 0) step(WARMUP_MINUTES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bottleneckIdx = state.bottleneckOpIndex;

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
            Σ · Queueing-theory analysis
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
            Stations on {garment?.name ?? '—'}
          </h1>
          <div style={{ fontSize: 13, color: SW_COLORS.muted, marginTop: 4 }}>
            One row per workstation, classified in Kendall–Lee notation and
            evaluated against Naidu's closed-form formulas alongside the
            simulator's observed values. Click any row to open the per-station
            inspector.
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
            title="Re-run 8-hour warm-up"
          >
            ⟲ Re-run sim
          </button>
          <button
            type="button"
            onClick={() => step(60)}
            style={{ ...navBtn(), background: SW_COLORS.brand, color: SW_COLORS.paper, border: 'none' }}
            title="Advance sim by 1 hour"
          >
            +1 hr
          </button>
          <button
            type="button"
            onClick={() => navigate('/queues/analytics')}
            style={navBtn()}
            title="Open the time-series view"
          >
            Compare stations →
          </button>
        </div>
      </header>

      <Card>
        <SectionHeader title="Workstations" />
        <StationTable
          stations={state.stations}
          bottleneckIdx={bottleneckIdx}
          onPick={(opId) => navigate(DRILL_PATHS.workstation('sewing', opId))}
        />
      </Card>

      <Card>
        <SectionHeader
          title="Queue graphics"
          sub="Live picture of the line. The sparkline tracks total WIP over time; each strip below is one workstation as a classical M/M/c queue (arrival → bundles waiting → server boxes → departure)."
        />
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            color: SW_COLORS.muted,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            fontWeight: 700,
            marginBottom: 6,
          }}
        >
          Line WIP over time
        </div>
        <WipSparkline history={state.history} />
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            color: SW_COLORS.muted,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            fontWeight: 700,
            margin: '18px 0 8px',
          }}
        >
          Per-station queue diagrams
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.stations.map((s, i) => (
            <QueueDiagram
              key={s.opId}
              station={s}
              isBottleneck={i === bottleneckIdx}
              onClick={() => navigate(DRILL_PATHS.workstation('sewing', s.opId))}
            />
          ))}
          {state.stations.length === 0 && (
            <p style={{ color: SW_COLORS.muted, fontSize: 13 }}>Warming up the simulator…</p>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title="How to use this view" />
        <ol style={{ fontSize: 13, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
          <li>
            <strong>Spot the bottleneck</strong> — the row marked{' '}
            <Tag color={SW_COLORS.alarm}>BOTTLENECK</Tag> has the highest ρ on the line; it caps the
            line's throughput. Move operators to it (Resources page) or relax its service-time
            distribution to drop ρ below 1.
          </li>
          <li>
            <strong>Read WIP per station</strong> — the <code>L</code> column is the
            steady-state expected number of bundles at the station (queue + in-service). Sum across
            stations to estimate total line WIP.
          </li>
          <li>
            <strong>Open the inspector</strong> on any station to switch its service-time
            distribution (M/D/G/Eₖ/Normal), apply a finite buffer (M/M/c/N), or compare simulated
            ρ/Lq against Naidu's analytical values.
          </li>
        </ol>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────────────────

function StationTable({
  stations,
  bottleneckIdx,
  onPick,
}: {
  stations: StationView[];
  bottleneckIdx: number;
  onPick: (opId: string) => void;
}) {
  if (stations.length === 0) {
    return <p style={{ color: SW_COLORS.muted, fontSize: 13 }}>Warming up the simulator…</p>;
  }
  return (
    <div
      style={{
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        overflow: 'hidden',
        marginTop: 12,
      }}
    >
      <Row header>
        <Col w="40px">#</Col>
        <Col w="2fr">Operation</Col>
        <Col w="1.2fr">Classification</Col>
        <Col w="60px" right>
          c
        </Col>
        <Col w="80px" right>
          λ /hr
        </Col>
        <Col w="80px" right>
          ρ
        </Col>
        <Col w="70px" right>
          Lq
        </Col>
        <Col w="70px" right>
          L (WIP)
        </Col>
        <Col w="100px">Flags</Col>
        <Col w="100px" />
      </Row>
      {stations.map((s, i) => (
        <Row key={s.opId} alt={i % 2 === 1} highlight={i === bottleneckIdx}>
          <Col w="40px" mono>
            {i + 1}
          </Col>
          <Col w="2fr">
            <strong>{s.opName}</strong>
            <span style={{ color: SW_COLORS.muted, marginLeft: 6, fontSize: 11 }}>
              {s.opCode ?? s.opId}
            </span>
          </Col>
          <Col w="1.2fr" mono>
            {s.notation.label}
          </Col>
          <Col w="60px" right mono>
            {s.serversTotal}
          </Col>
          <Col w="80px" right mono>
            {fmt2(s.lambda)}
          </Col>
          <Col w="80px" right mono>
            <RhoCell value={s.analytical.rho} stable={s.isStable} />
          </Col>
          <Col w="70px" right mono>
            {fmt2(s.analytical.Lq)}
          </Col>
          <Col w="70px" right mono>
            {fmt2(s.analytical.L)}
          </Col>
          <Col w="100px">
            {i === bottleneckIdx && <Tag color={SW_COLORS.alarm}>BOTTLENECK</Tag>}
            {!s.isStable && i !== bottleneckIdx && <Tag color={SW_COLORS.alarm}>UNSTABLE</Tag>}
            {s.balked > 0 && <Tag color={SW_COLORS.warn}>{s.balked} BALKED</Tag>}
          </Col>
          <Col w="100px" right>
            <button
              type="button"
              onClick={() => onPick(s.opId)}
              style={analyzeBtn()}
            >
              Analyze →
            </button>
          </Col>
        </Row>
      ))}
    </div>
  );
}

function Row({
  children,
  header,
  alt,
  highlight,
}: {
  children: React.ReactNode;
  header?: boolean;
  alt?: boolean;
  highlight?: boolean;
}) {
  const bg = header
    ? SW_COLORS.paperDeep
    : highlight
    ? `${SW_COLORS.alarm}10`
    : alt
    ? '#FAF7F0'
    : SW_COLORS.paper;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns:
          '40px 2fr 1.2fr 60px 80px 80px 70px 70px 100px 100px',
        gap: 8,
        padding: '10px 12px',
        background: bg,
        borderBottom: `1px solid ${SW_COLORS.line}`,
        fontFamily: header ? SW_FONTS.mono : SW_FONTS.body,
        fontSize: header ? 10 : 13,
        fontWeight: header ? 700 : 500,
        textTransform: header ? 'uppercase' : 'none',
        letterSpacing: header ? '0.5px' : 'normal',
        color: header ? SW_COLORS.muted : SW_COLORS.ink,
        alignItems: 'center',
      }}
    >
      {children}
    </div>
  );
}

function Col({
  children,
  w,
  right,
  mono,
}: {
  children?: React.ReactNode;
  w: string;
  right?: boolean;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        gridColumn: 'auto',
        width: undefined,
        textAlign: right ? 'right' : 'left',
        fontFamily: mono ? SW_FONTS.mono : undefined,
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        minWidth: 0,
      }}
      data-w={w}
    >
      {children}
    </div>
  );
}

function RhoCell({ value, stable }: { value: number; stable: boolean }) {
  const color = !Number.isFinite(value)
    ? SW_COLORS.alarm
    : value >= 1
    ? SW_COLORS.alarm
    : value >= 0.85
    ? SW_COLORS.warn
    : value >= 0.5
    ? SW_COLORS.ok
    : SW_COLORS.muted;
  const text = !Number.isFinite(value)
    ? '∞'
    : (value * 100).toFixed(0) + '%';
  return (
    <span style={{ color, fontWeight: 700 }}>
      {text}
      {!stable && <span style={{ marginLeft: 4 }}>✕</span>}
    </span>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.3px',
        background: `${color}20`,
        color,
        marginRight: 4,
        fontFamily: SW_FONTS.mono,
      }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────

function fmt2(v: number): string {
  if (!Number.isFinite(v)) return v === Infinity ? '∞' : '—';
  return v.toFixed(2);
}

// Functions (not consts) so tokens are read at render time — the vibe system
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

const analyzeBtn = (): React.CSSProperties => ({
  ...navBtn(),
  padding: '5px 10px',
  fontSize: 11,
});
