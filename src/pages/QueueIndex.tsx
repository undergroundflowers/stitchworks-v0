/**
 * Queue Analysis index — one row per workstation on the sewing lines in
 * scope, showing the Kendall–Lee classification and the measured ρ̂ / L̄q
 * beside the closed-form ρ / Lq they should converge to.
 *
 * Sim and theory sit in ADJACENT columns on purpose. The table used to print
 * only the analytical values under bare "ρ" and "Lq" headers, which read as
 * observations — so a station could look perfectly healthy while the run
 * disagreed, and nothing on screen would say so.
 *
 * This is the top-level entry point for the queueing-theory module: pick a
 * station here, drill in for the deep view.
 */

import { useNavigate } from 'react-router-dom';
import {
  Card,
  DataTable,
  LineScopePicker,
  LineSimEmpty,
  QueueDiagram,
  SectionHeader,
  WipSparkline,
  Sym,
  type DataTableColumn,
} from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { type StationView } from '../simulation';
import { useLineSim } from '../simulation/useLineSim';
import { useSimSession } from '../simulation/useSimSession';
import { DRILL_PATHS } from '../lib/routes';

export interface QueueIndexPageProps {
  /** Rendered inside another surface (INSIGHTS): drop the page chrome and the
   *  outer scroll container so the host owns both. */
  embedded?: boolean;
}

export function QueueIndexPage({ embedded = false }: QueueIndexPageProps = {}) {
  const navigate = useNavigate();
  // The user's OWN lines, through the shared session — not a throwaway line
  // synthesised from the selected garment template, which is what this page
  // used to analyse.
  const { state, lines, allLines, emptyReason, unassignedStationCount } = useLineSim();
  const step = useSimSession((s) => s.step);
  const reset = useSimSession((s) => s.reset);

  const bottleneckIdx = state.bottleneckOpIndex;
  const subject = lines.length === 1 ? lines[0].name : `${lines.length} sewing lines`;

  if (emptyReason) {
    return (
      <div style={{ padding: '20px 24px', height: '100%' }}>
        <LineSimEmpty
          reason={emptyReason}
          unassignedStationCount={unassignedStationCount}
          what="Queueing analysis"
        />
      </div>
    );
  }

  return (
    <div
      style={
        embedded
          ? { display: 'flex', flexDirection: 'column', gap: 16 }
          : {
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              padding: '20px 24px',
              height: '100%',
              overflow: 'auto',
            }
      }
    >
      {!embedded && (
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
          <div style={{ marginTop: 6 }}>
            <LineScopePicker lines={allLines} />
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
            Stations on {subject}
          </h1>
          <div style={{ fontSize: 13, color: SW_COLORS.muted, marginTop: 4 }}>
            One row per workstation, classified in Kendall–Lee notation and
            evaluated against Naidu's closed-form formulas alongside the
            simulator's observed values. Click any row to open the per-station
            inspector.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
      )}

      <Card>
        <SectionHeader title="Workstations" />
        <StationTable
          stations={state.stations}
          bottleneckIdx={bottleneckIdx}
          onPick={(wsId) => navigate(DRILL_PATHS.workstation('sewing', wsId, 'queues'))}
        />
      </Card>

      {/* Graphics and instructions are two columns, not two stacked bands.
          The how-to is read once, beside the thing it describes; stacked, it
          sat below a variable-length list of station diagrams, so on any real
          line it was off-screen at the moment it was any use. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.75fr) minmax(280px, 1fr)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <Card>
          <SectionHeader
            title="Queue graphics"
            sub="Live picture of the line. The chart tracks total WIP over time; each strip below is one workstation as a classical M/M/c queue (arrival → bundles waiting → server boxes → departure)."
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
            Line WIP over time (<Sym quantity="L" />, summed over stations)
          </div>
          <WipSparkline history={state.history} height={180} />
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
                key={s.wsId}
                station={s}
                isBottleneck={i === bottleneckIdx}
                onClick={() => navigate(DRILL_PATHS.workstation('sewing', s.wsId, 'queues'))}
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row per workstation.
 *
 * Ten columns of dense classification and measurement, which is exactly the
 * case a fixed layout cannot serve: `Operation` needs room for a real op
 * name, `ρ theory` needs six characters forever. So the widths here are only
 * a starting point — every rule between headers is draggable, and the choice
 * is remembered.
 *
 * This used to band alternate rows with a hard-coded `#FAF7F0`, a light-theme
 * cream left behind by the move to the Control Room ground. On near-black
 * paper that band was a white slab under near-white text: every second row
 * was unreadable. Rows are separated by a hairline now, and the only row that
 * carries colour is the one that has earned it — the bottleneck.
 */
function StationTable({
  stations,
  bottleneckIdx,
  onPick,
}: {
  stations: StationView[];
  bottleneckIdx: number;
  /** Receives a WORKSTATION id — two stations can share an operation. */
  onPick: (wsId: string) => void;
}) {
  // Symbols go through <Sym>, which resets the header's inherited
  // `text-transform: uppercase`. Written as plain text they render as Λ, Ρ
  // and LQ — a different letter and a different quantity.
  const columns: DataTableColumn<StationView>[] = [
    {
      key: 'n',
      header: '#',
      width: 46,
      minWidth: 36,
      align: 'right',
      numeric: true,
      cell: (_s, i) => i + 1,
    },
    {
      key: 'operation',
      header: 'Operation',
      width: 300,
      minWidth: 120,
      cell: (s) => (
        <span title={`${s.opName} · ${s.opCode ?? s.opId}`}>
          <strong style={{ fontWeight: 600 }}>{s.opName}</strong>
          <span style={{ color: SW_COLORS.muted, marginLeft: 6, fontSize: 11 }}>
            {s.opCode ?? s.opId}
          </span>
        </span>
      ),
    },
    {
      key: 'classification',
      header: 'Classification',
      width: 168,
      minWidth: 90,
      numeric: true,
      cell: (s) => <span title={s.notation.label}>{s.notation.label}</span>,
    },
    {
      key: 'servers',
      header: <Sym quantity="servers" />,
      width: 62,
      align: 'right',
      numeric: true,
      cell: (s) => s.serversTotal,
    },
    {
      key: 'lambda',
      header: <><Sym quantity="lambda" /> /hr</>,
      width: 86,
      align: 'right',
      numeric: true,
      cell: (s) => fmt2(s.lambda),
    },
    {
      key: 'rhoSim',
      header: <><Sym quantity="rho" /> sim</>,
      width: 82,
      align: 'right',
      numeric: true,
      cell: (s) => <RhoCell value={s.utilization} stable={s.isStable} />,
    },
    {
      key: 'rhoTheory',
      header: <><Sym quantity="rho" /> theory</>,
      width: 82,
      align: 'right',
      numeric: true,
      cell: (s) => fmt2(s.analytical.rho),
    },
    {
      key: 'LqSim',
      header: <><Sym quantity="Lq" /> sim</>,
      width: 78,
      align: 'right',
      numeric: true,
      cell: (s) => fmt2(s.LqObserved),
    },
    {
      key: 'LqTheory',
      header: <><Sym quantity="Lq" /> theory</>,
      width: 82,
      align: 'right',
      numeric: true,
      cell: (s) => fmt2(s.analytical.Lq),
    },
    {
      key: 'flags',
      header: 'Flags',
      width: 150,
      minWidth: 80,
      cell: (s, i) => (
        <>
          {i === bottleneckIdx && <Tag color={SW_COLORS.alarm}>BOTTLENECK</Tag>}
          {!s.isStable && i !== bottleneckIdx && <Tag color={SW_COLORS.alarm}>UNSTABLE</Tag>}
          {s.balked > 0 && <Tag color={SW_COLORS.warn}>{s.balked} BALKED</Tag>}
        </>
      ),
    },
    {
      key: 'action',
      header: '',
      width: 104,
      minWidth: 80,
      // Left-aligned: the table's slack parks in the filler track past this
      // column, so a right-aligned button would float away from the data it
      // belongs to.
      cell: (s) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPick(s.wsId);
          }}
          style={analyzeBtn()}
        >
          Analyze →
        </button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={stations}
      rowKey={(s) => s.wsId}
      onRowClick={(s) => onPick(s.wsId)}
      rowStyle={(_s, i) => (i === bottleneckIdx ? { tone: SW_COLORS.alarm } : null)}
      empty="Warming up the simulator…"
      storageKey="queueIndex.stationTable.widths"
      style={{ marginTop: 12 }}
    />
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
