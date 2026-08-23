/**
 * QUEUE LAB — build any queueing system and take it apart.
 *
 * The rest of the app answers "how is my line doing". This one answers "what
 * does a queue like this actually do", which is a different question and needs
 * a different surface: nothing here is tied to a factory, a run, or a garment.
 * You state a system — arrivals at some rate, a service that takes a while,
 * some servers, maybe a buffer — and it is solved in full, on every keystroke.
 *
 * Three columns, matching the Builder's shell so the app has one layout
 * language: the collection on the left, the bench in the middle, the parameters
 * on the right.
 *
 * Topology is edited with verbs, not by dragging boxes on a canvas. "Add a
 * stage after this one", "branch", "send work back" — each produces a valid
 * graph by construction, so there is no such thing as a dangling arrow or an
 * unreachable node to diagnose, and the schematic can lay itself out.
 */

import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  HudSelect,
  QueueingReference,
  SectionHeader,
  Stat,
  Sym,
  Tag,
  ToggleGroup,
  ViewTitle,
  useConfirm,
} from '../components';
import {
  CapacityField,
  DISCIPLINE_OPTIONS,
  DIST_OPTIONS,
  DistParamInputs,
  DropdownField,
  NumberField,
  morphDist,
  patchDist,
  type DistKind,
  type DistParams,
} from '../components/queueParamFields';
import { FieldLabel } from '../components/Sym';
import { LabSchematic, LabSchematicLegend } from '../components/lab/LabSchematic';
import { LabSweep } from '../components/lab/LabSweep';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { QUANTITY, glossOf, type QuantityId } from '../simulation/notation';
import { solveNetwork, type NetworkSolution, type QueueNode } from '../simulation/network';
import { meanOf, type QueueDiscipline } from '../simulation';
import { workingFor, trafficEquationFor, type Working } from '../domain/lab-working';
import { useLab } from '../store/lab';
import { isSeedSystem } from '../domain/lab-systems';
import { useLineSim } from '../simulation/useLineSim';
import { serversFor, systemCapacityFor, disciplineFor } from '../simulation';
import { useTwin } from '../store/twin';

type ResultScope = 'stage' | 'network';

export function QueueLabPage() {
  const systems = useLab((s) => s.systems);
  const activeId = useLab((s) => s.activeId);
  const selectedNodeId = useLab((s) => s.selectedNodeId);
  const lab = useLab();

  const system = systems.find((s) => s.id === activeId) ?? systems[0] ?? null;
  const node =
    system?.nodes.find((n) => n.id === selectedNodeId) ?? system?.nodes[0] ?? null;

  // The whole analysis, recomputed whenever the system changes. Pure and fast
  // enough (a Gaussian solve over a handful of nodes) to run on every edit.
  const solution: NetworkSolution | null = useMemo(
    () => (system ? solveNetwork({ nodes: system.nodes, edges: system.edges }) : null),
    [system],
  );

  const [scope, setScope] = useState<ResultScope>('stage');
  const multi = (system?.nodes.length ?? 0) > 1;
  const effectiveScope: ResultScope = multi ? scope : 'stage';

  return (
    /* The route shell clips its child, so the horizontal scroll has to be
       owned here rather than by loosening an overflow every page shares. */
    <div style={{ height: '100%', overflowX: 'auto', background: SW_COLORS.paperDeep }}>
    <div
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateColumns: '278px 1fr 352px',
        background: SW_COLORS.paperDeep,
        fontFamily: SW_FONTS.body,
        minHeight: 0,
        // Stitchworks is a desktop app with a 1024px floor and no responsive
        // reflow. Below the floor the two fixed rails would eat the whole width
        // and squeeze the bench to a column one word wide, so the grid holds
        // its intended proportions and the window scrolls instead.
        minWidth: 1024,
      }}
    >
      <SystemsRail />

      <main style={{ minWidth: 0, overflowY: 'auto', padding: '18px 22px 40px' }}>
        {!system ? (
          <Card>
            <EmptyState
              icon="∑"
              title="Nothing on the bench"
              body="A queueing system is arrivals at some rate, a service that takes a while, and some servers. Start one and it will be solved as you type."
              action={{ label: 'Start a system', onClick: () => lab.createSystem() }}
            />
          </Card>
        ) : (
          <Bench
            system={system}
            solution={solution}
            node={node}
            scope={effectiveScope}
            onScope={setScope}
            multi={multi}
          />
        )}
      </main>

      <ParametersRail system={system} node={node} solution={solution} />
    </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  LEFT — the collection
// ─────────────────────────────────────────────────────────────────────────

function SystemsRail() {
  const systems = useLab((s) => s.systems);
  const activeId = useLab((s) => s.activeId);
  const lab = useLab();
  const confirm = useConfirm();

  return (
    <aside
      style={{
        borderRight: `1px solid ${SW_COLORS.line}`,
        background: SW_COLORS.paper,
        overflowY: 'auto',
        padding: '14px 12px 24px',
        minWidth: 0,
      }}
    >
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted, marginBottom: 8 }}>
        Systems
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {systems.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              onClick={() => lab.selectSystem(s.id)}
              style={{
                textAlign: 'left',
                background: active ? alpha(SW_COLORS.brand, 0.12) : SW_COLORS.paperDeep,
                border: `1px solid ${active ? SW_COLORS.brandEdge : SW_COLORS.line}`,
                borderLeft: `3px solid ${active ? SW_COLORS.brand : 'transparent'}`,
                borderRadius: SW_RADIUS.sm,
                padding: '9px 10px',
                cursor: 'pointer',
                color: SW_COLORS.ink,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>{s.name}</span>
              {s.blurb && (
                <span style={{ fontSize: 10.5, color: SW_COLORS.muted, lineHeight: 1.4 }}>
                  {s.blurb.length > 96 ? `${s.blurb.slice(0, 95)}…` : s.blurb}
                </span>
              )}
              <span style={{ display: 'flex', gap: 5, marginTop: 2, flexWrap: 'wrap' }}>
                <Tag soft color={SW_COLORS.muted}>
                  {s.nodes.length === 1 ? '1 stage' : `${s.nodes.length} stages`}
                </Tag>
                {s.source && (
                  <Tag soft color={SW_COLORS.fabric}>
                    {s.source}
                  </Tag>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" onClick={() => lab.createSystem()}>
          + New
        </Button>
        {activeId && (
          <Button size="sm" variant="secondary" onClick={() => lab.duplicateSystem(activeId)}>
            Duplicate
          </Button>
        )}
        {activeId && isSeedSystem(activeId) && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => lab.resetSeeded(activeId)}
          >
            Reset
          </Button>
        )}
        {activeId && systems.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const s = systems.find((x) => x.id === activeId);
              if (
                await confirm({
                  title: 'Delete system',
                  message: `Delete "${s?.name}"? This cannot be undone.`,
                  confirmLabel: 'Delete',
                  variant: 'danger',
                })
              ) {
                lab.deleteSystem(activeId);
              }
            }}
          >
            Delete
          </Button>
        )}
      </div>

      <ImportFromFloor />
    </aside>
  );
}

/**
 * One-way import from the factory.
 *
 * Every parameter is resolved through the ENGINE's own functions rather than
 * read off the workstation record, so the system that lands on the bench is
 * the one the simulator would actually run. λ is the only measured value; the
 * rest are authored, so a station can be pulled before any run exists and the
 * chip says which fallback was used.
 */
function ImportFromFloor() {
  const lab = useLab();
  const twin = useTwin((s) => s.canonical);
  const { state } = useLineSim();
  const [pick, setPick] = useState<string>('');

  const stations = twin?.workstations ?? [];
  if (stations.length === 0) return null;

  const options = stations.map((ws) => ({ value: ws.id, label: ws.name }));

  const pull = () => {
    const ws = stations.find((w) => w.id === pick) ?? stations[0];
    if (!ws) return;
    const observed = state.stations.find((s) => s.wsId === ws.id);
    const cap = systemCapacityFor(ws);
    // λ is the one measured quantity. With no run to read it from, fall back to
    // the station's own service rate — which makes ρ = 1 and is at least an
    // honest starting point rather than a fabricated load.
    const dist = observed?.serviceDist ?? { kind: 'exp' as const, mean: 6 };
    const mu = 60 / Math.max(1e-9, meanOf(dist));
    const lambda = observed && observed.lambda > 0 ? observed.lambda : mu;

    const node: QueueNode = {
      id: `n-${ws.id}`,
      name: ws.name,
      externalArrivalPerHr: lambda,
      serviceDist: dist,
      servers: serversFor(ws),
      capacity: cap,
      discipline: disciplineFor(ws),
    };
    lab.addSystem({
      id: `imp-${ws.id}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${ws.name} (from floor)`,
      blurb:
        observed && observed.lambda > 0
          ? 'Pulled from a run. Nothing you change here goes back to the floor.'
          : 'Pulled before any run, so λ was set to μ. Nothing here goes back to the floor.',
      nodes: [node],
      edges: [],
    });
  };

  return (
    <div
      style={{
        marginTop: 18,
        paddingTop: 14,
        borderTop: `1px solid ${SW_COLORS.line}`,
      }}
    >
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted, marginBottom: 8 }}>
        Pull from the floor
      </div>
      <HudSelect
        value={pick || options[0]?.value}
        onChange={setPick}
        variant="light"
        size="sm"
        width="100%"
        options={options}
      />
      <div style={{ marginTop: 6 }}>
        <Button size="sm" variant="secondary" full onClick={pull}>
          ↓ Pull onto the bench
        </Button>
      </div>
      <div style={{ marginTop: 6, fontSize: 10.5, color: SW_COLORS.muted, lineHeight: 1.45 }}>
        Copies c, N, the discipline and the service distribution as the engine resolves
        them. One way — nothing you change in the Lab reaches your factory.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  CENTRE — the bench
// ─────────────────────────────────────────────────────────────────────────

function Bench({
  system,
  solution,
  node,
  scope,
  onScope,
  multi,
}: {
  system: NonNullable<ReturnType<typeof useLab.getState>['systems'][number]>;
  solution: NetworkSolution | null;
  node: QueueNode | null;
  scope: ResultScope;
  onScope: (s: ResultScope) => void;
  multi: boolean;
}) {
  const lab = useLab();
  const solved = node && solution ? solution.byNodeId[node.id] : undefined;
  const errors = solution?.issues.filter((i) => i.level === 'error') ?? [];
  const notes = solution?.issues.filter((i) => i.level !== 'error') ?? [];
  /**
   * Two very different failures wear the same 'error' level.
   *
   * A STRUCTURAL failure — routing that sums past 100%, a loop with no exit,
   * nothing arriving — means there is no solution to show at all. Instability
   * is not that: the traffic equations solved fine, and every stage that is
   * under capacity has real, useful numbers. Hiding them because one stage
   * saturated throws away the information that would tell you which one and by
   * how much, so only the structural case suppresses the results.
   */
  const solvable = (solution?.nodes.length ?? 0) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <ViewTitle title={system.name} />
        {solved && (
          <div
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 20,
              fontWeight: 900,
              color: SW_COLORS.ink,
              letterSpacing: '-0.01em',
            }}
          >
            {solved.notation.label}
          </div>
        )}
      </div>

      {system.blurb && (
        <div style={{ ...SW_TYPE.body, color: SW_COLORS.muted, marginTop: -8 }}>
          {system.blurb}
        </div>
      )}

      {/* Schematic */}
      <Card>
        <SectionHeader
          title="The system"
          sub="Click a stage to inspect it. Add stages from the panel on the right."
        />
        {solution && (
          <>
            <LabSchematic
              nodes={system.nodes}
              edges={system.edges}
              solvedById={solution.byNodeId}
              selectedNodeId={node?.id ?? null}
              onSelect={(id) => lab.selectNode(id)}
            />
            <LabSchematicLegend style={{ marginTop: 8 }} />
          </>
        )}
      </Card>

      {errors.length > 0 && (
        <Card accent={SW_COLORS.alarm}>
          <SectionHeader
            title={solvable ? 'This system will not settle' : 'This system cannot be solved'}
            sub={
              solvable
                ? 'The numbers below still hold for every stage that is under capacity.'
                : undefined
            }
          />
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: SW_COLORS.ink, lineHeight: 1.5, marginTop: 4 }}>
              {e.message}
            </div>
          ))}
        </Card>
      )}

      {/* Results */}
      {solution && solved && solvable && (
        <>
          <Card>
            <SectionHeader
              title="Results"
              sub={
                scope === 'network'
                  ? 'The whole network, aggregated.'
                  : `Closed-form solution for ${node?.name}.`
              }
              right={
                multi ? (
                  <ToggleGroup<ResultScope>
                    value={scope}
                    options={[
                      { value: 'stage', label: 'This stage' },
                      { value: 'network', label: 'Whole network' },
                    ]}
                    onChange={onScope}
                  />
                ) : undefined
              }
            />
            {scope === 'network' ? (
              <NetworkResults solution={solution} />
            ) : (
              <StageResults node={node!} solved={solved} />
            )}
          </Card>

          {scope === 'stage' && node && (
            <Card>
              <SectionHeader
                title="Sweep one number"
                sub="Hold everything else and move one dial. The shape is the lesson — Lq does not rise in a straight line."
              />
              <LabSweep node={node} lambda={solved.lambda} />
            </Card>
          )}

          {multi && scope === 'network' && (
            <Card>
              <SectionHeader
                title="Traffic equations"
                sub="What each stage actually sees, once the routing has been followed round."
              />
              <TrafficEquations system={system} solution={solution} />
            </Card>
          )}
        </>
      )}

      {notes.length > 0 && (
        <Card>
          <SectionHeader title="How to read these numbers" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            {notes.map((nte, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11.5,
                  color: SW_COLORS.muted,
                  lineHeight: 1.5,
                  borderLeft: `3px solid ${nte.level === 'warn' ? SW_COLORS.warn : SW_COLORS.line}`,
                  paddingLeft: 10,
                }}
              >
                {nte.message}
              </div>
            ))}
          </div>
        </Card>
      )}

      <QueueingReference />
    </div>
  );
}

/** The measures for one stage: verdict tiles, then the full table with working. */
function StageResults({
  node,
  solved,
}: {
  node: QueueNode;
  solved: NonNullable<NetworkSolution['byNodeId'][string]>;
}) {
  const k = solved.kpis;
  const mu = 60 / Math.max(1e-9, meanOf(node.serviceDist));
  const rhoTone =
    !Number.isFinite(k.rho) || k.rho >= 1
      ? SW_COLORS.alarm
      : k.rho >= 0.85
        ? SW_COLORS.warn
        : SW_COLORS.ok;

  const ROWS: QuantityId[] = [
    'rho', 'P0', 'Lq', 'L', 'Wq', 'W', 'D', 'pWait', 'pNoWait', 'lambdaEff', 'pBalk',
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {/* Symbols go through <Sym>: these labels are uppercased in CSS, which
            renders a bare ρ as Ρ and a bare Lq as LQ. */}
        <Stat label={<StatLabel name="Utilisation" q="rho" />} value={fmt(k.rho, 3)} color={rhoTone} big />
        <Stat label={<StatLabel name="Queue length" q="Lq" />} value={fmt(k.Lq, 2)} unit="waiting" big />
        <Stat label={<StatLabel name="Queue wait" q="Wq" />} value={fmt(k.Wq * 60, 1)} unit="min" big />
        <Stat label={<StatLabel name="In system" q="L" />} value={fmt(k.L, 2)} unit="units" big />
      </div>

      <div
        style={{
          border: `1px solid ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.sm,
          overflow: 'hidden',
        }}
      >
        {ROWS.map((id, i) => (
          <MeasureRow
            key={id}
            id={id}
            value={valueFor(id, k)}
            working={workingFor(id, { notation: solved.notation, kpis: k, lambda: solved.lambda, mu })}
            alt={i % 2 === 1}
          />
        ))}
      </div>
    </div>
  );
}

/** One measure: symbol, name, value, and the derivation on demand. */
function MeasureRow({
  id,
  value,
  working,
  alt,
}: {
  id: QuantityId;
  value: string;
  working: Working | null;
  alt: boolean;
}) {
  const [open, setOpen] = useState(false);
  const q = QUANTITY[id];
  return (
    <div style={{ background: alt ? SW_COLORS.paperDeep : SW_COLORS.paper }}>
      <button
        onClick={() => working && setOpen((v) => !v)}
        title={glossOf(id)}
        style={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: '18px 1.5fr 1fr',
          gap: 10,
          alignItems: 'baseline',
          padding: '9px 12px',
          background: 'none',
          border: 'none',
          cursor: working ? 'pointer' : 'default',
          textAlign: 'left',
          color: SW_COLORS.ink,
          fontFamily: SW_FONTS.body,
        }}
      >
        <span style={{ color: SW_COLORS.muted, fontSize: 10 }}>{working ? (open ? '▾' : '▸') : ''}</span>
        <span style={{ fontSize: 12.5 }}>
          <Sym quantity={id} color={SW_COLORS.brandText} />
          <span style={{ marginLeft: 8, fontWeight: 500 }}>{q.name}</span>
          {q.unit && (
            <span style={{ marginLeft: 5, color: SW_COLORS.muted, fontSize: 11 }}>{q.unit}</span>
          )}
        </span>
        <span
          style={{
            textAlign: 'right',
            fontFamily: SW_FONTS.mono,
            fontSize: 13,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
      </button>

      {open && working && (
        <div
          style={{
            padding: '2px 12px 12px 40px',
            fontFamily: SW_FONTS.mono,
            fontSize: 11.5,
            color: SW_COLORS.muted,
            lineHeight: 1.75,
          }}
        >
          {working.unavailable ? (
            <div style={{ fontFamily: SW_FONTS.body, lineHeight: 1.5 }}>{working.unavailable}</div>
          ) : (
            <>
              <div style={{ color: SW_COLORS.ink }}>{working.symbolic}</div>
              {working.substituted && <div>= {working.substituted}</div>}
              <div style={{ color: SW_COLORS.brandText, fontWeight: 700 }}>= {working.result}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NetworkResults({ solution }: { solution: NetworkSolution }) {
  const lost = solution.admittedPerHr < solution.externalArrivalPerHr - 1e-9;
  const pathAgrees = Math.abs(solution.pathSumW - solution.networkW) < 1e-6;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <Stat
          label={<StatLabel name="In the network Σ" q="L" />}
          value={fmt(solution.totalL, 2)}
          unit="units"
          big
        />
        <Stat
          label={<StatLabel name="Waiting Σ" q="Lq" />}
          value={fmt(solution.totalLq, 2)}
          unit="units"
          big
        />
        <Stat
          label={<StatLabel name="Lead time" q="W" />}
          value={fmt(solution.networkW * 60, 1)}
          unit="min"
          big
        />
        <Stat
          label="Throughput"
          value={fmt(solution.throughputPerHr, 1)}
          unit="/hr out"
          big
        />
      </div>

      <div style={{ fontSize: 11.5, color: SW_COLORS.muted, lineHeight: 1.6 }}>
        Lead time is Little&rsquo;s law over the whole network:{' '}
        <Sym quantity="L" /> ÷ the rate work actually gets in
        {lost ? (
          <>
            {' '}— {fmt(solution.admittedPerHr, 1)} /hr of the {fmt(solution.externalArrivalPerHr, 1)}{' '}
            offered, the rest turned away at a full buffer.
          </>
        ) : (
          <> — {fmt(solution.externalArrivalPerHr, 1)} /hr, since nothing is turned away.</>
        )}
        <br />
        {pathAgrees ? (
          <>
            Every unit visits every stage exactly once here, so the{' '}
            <Sym quantity="W" /> column adds up to the same number.
          </>
        ) : (
          <>
            The per-stage <Sym quantity="W" /> column sums to {fmt(solution.pathSumW * 60, 1)} min,
            which is not the network figure: units revisit or skip stages, and the gap between the
            two is exactly that.
          </>
        )}
      </div>

      <Rankings solution={solution} />
    </div>
  );
}

/**
 * Three bottleneck answers side by side.
 *
 * "Which stage is the bottleneck" is really three questions — which saturates
 * first, which is holding the work, and which costs the most time per unit —
 * and they disagree exactly when a stage is visited more than once. Showing all
 * three is what makes that visible instead of arbitrary.
 */
function Rankings({ solution }: { solution: NetworkSolution }) {
  const name = (id: string) => solution.byNodeId[id]?.nodeId ?? id;
  const cols: { title: string; sub: string; ids: string[]; render: (id: string) => string }[] = [
    {
      title: 'Saturates first',
      sub: 'by ρ',
      ids: solution.byUtilization,
      render: (id) => fmt(solution.byNodeId[id]?.kpis.rho ?? NaN, 2),
    },
    {
      title: 'Holds the work',
      sub: 'by L',
      ids: solution.byWip,
      render: (id) => fmt(solution.byNodeId[id]?.kpis.L ?? NaN, 2),
    },
    {
      title: 'Costs the most time',
      sub: 'by v · Wq',
      ids: solution.byDelayContribution,
      render: (id) => {
        const s = solution.byNodeId[id];
        return s ? `${fmt(s.visitRatio * s.kpis.Wq * 60, 1)} min` : '—';
      },
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
      {cols.map((c) => (
        <div
          key={c.title}
          style={{
            border: `1px solid ${SW_COLORS.line}`,
            borderRadius: SW_RADIUS.sm,
            padding: 10,
            background: SW_COLORS.paperDeep,
          }}
        >
          <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>{c.title}</div>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 9, color: SW_COLORS.faint, marginBottom: 6 }}>
            {c.sub}
          </div>
          {c.ids.slice(0, 4).map((id, i) => (
            <div
              key={id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 11.5,
                padding: '3px 0',
                color: i === 0 ? SW_COLORS.ink : SW_COLORS.muted,
                fontWeight: i === 0 ? 700 : 400,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name(id)}
              </span>
              <span style={{ fontFamily: SW_FONTS.mono, flex: 'none' }}>{c.render(id)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function TrafficEquations({
  system,
  solution,
}: {
  system: { nodes: QueueNode[]; edges: { from: string; to: string; probability: number }[] };
  solution: NetworkSolution;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
      {system.nodes.map((n) => {
        const s = solution.byNodeId[n.id];
        if (!s) return null;
        const contributions = system.edges
          .filter((e) => e.to === n.id)
          .map((e) => ({
            fromName: system.nodes.find((x) => x.id === e.from)?.name ?? e.from,
            lambda: solution.byNodeId[e.from]?.lambdaEff ?? 0,
            probability: e.probability,
          }));
        const w = trafficEquationFor(n.name, n.externalArrivalPerHr, contributions, s.lambda);
        return (
          <div
            key={n.id}
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 11.5,
              color: SW_COLORS.muted,
              lineHeight: 1.7,
              borderLeft: `3px solid ${SW_COLORS.line}`,
              paddingLeft: 10,
            }}
          >
            <div>{w.substituted}</div>
            <div style={{ color: SW_COLORS.brandText, fontWeight: 700 }}>= {w.result}</div>
          </div>
        );
      })}
      <div style={{ fontFamily: SW_FONTS.body, fontSize: 11.5, color: SW_COLORS.muted, lineHeight: 1.5 }}>
        Each stage&rsquo;s arrival rate is what comes from outside plus what the other stages send
        it. With a loop the two sides refer to each other, so this is solved as a system rather than
        followed forwards — which is why a 15% rework share costs more than 15%.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  RIGHT — parameters and topology
// ─────────────────────────────────────────────────────────────────────────

function ParametersRail({
  system,
  node,
  solution,
}: {
  system: { id: string; nodes: QueueNode[] } | null;
  node: QueueNode | null;
  solution: NetworkSolution | null;
}) {
  const lab = useLab();

  if (!system || !node) {
    return (
      <aside style={railStyle}>
        <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>Parameters</div>
      </aside>
    );
  }

  const patch = (p: Partial<QueueNode>) => lab.patchNode(system.id, node.id, p);
  const mu = 60 / Math.max(1e-9, meanOf(node.serviceDist));
  const solved = solution?.byNodeId[node.id];

  return (
    <aside style={railStyle}>
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted, marginBottom: 6 }}>
        Stage
      </div>
      <input
        value={node.name}
        onChange={(e) => patch({ name: e.target.value })}
        style={{
          width: '100%',
          border: `1px solid ${SW_COLORS.line}`,
          background: SW_COLORS.paper,
          borderRadius: SW_RADIUS.sm,
          padding: '7px 9px',
          fontFamily: SW_FONTS.body,
          fontSize: 13,
          color: SW_COLORS.ink,
          outline: 'none',
        }}
      />

      <Group title="Arrivals">
        <NumberField
          label={<FieldLabel quantity="lambda" name="From outside" />}
          value={node.externalArrivalPerHr}
          min={0}
          step={0.5}
          editable
          onChange={(v) => patch({ externalArrivalPerHr: Math.max(0, v) })}
        />
        {solved && solved.lambda !== node.externalArrivalPerHr && (
          <div style={{ fontSize: 10.5, color: SW_COLORS.muted, marginTop: 4, lineHeight: 1.45 }}>
            This stage actually sees <strong style={{ color: SW_COLORS.ink }}>{fmt(solved.lambda, 2)}</strong>{' '}
            /hr once the routing is followed round — {fmt(solved.visitRatio, 2)} visits per unit.
          </div>
        )}
      </Group>

      <Group title="Service">
        <ToggleGroup<DistKind>
          value={node.serviceDist.kind as DistKind}
          options={DIST_OPTIONS}
          onChange={(kind) => patch({ serviceDist: morphDist(node.serviceDist, kind, meanOf(node.serviceDist)) })}
        />
        <div style={{ height: 8 }} />
        <DistParamInputs
          dist={node.serviceDist}
          editable
          onChange={(p: Partial<DistParams>) => patch({ serviceDist: patchDist(node.serviceDist, p) })}
        />
        <div style={{ marginTop: 6, fontFamily: SW_FONTS.mono, fontSize: 10.5, color: SW_COLORS.muted }}>
          <Sym quantity="mu" color={SW_COLORS.brandText} /> ={' '}
          <strong style={{ color: SW_COLORS.ink }}>{fmt(mu, 2)}</strong> /hr per server
        </div>
      </Group>

      <Group title="Servers and capacity">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 10 }}>
          <NumberField
            label={<FieldLabel quantity="servers" />}
            value={node.servers}
            min={1}
            step={1}
            editable
            onChange={(v) => patch({ servers: Math.max(1, Math.round(v)) })}
          />
          <CapacityField
            capacity={node.capacity}
            editable
            onChange={(v) => patch({ capacity: v === 'inf' ? Infinity : Math.max(1, Math.round(v)) })}
          />
          <DropdownField<QueueDiscipline>
            label={<FieldLabel quantity="discipline" />}
            value={node.discipline}
            options={DISCIPLINE_OPTIONS}
            editable
            onChange={(d) => patch({ discipline: d })}
          />
        </div>
      </Group>

      <Group title="Topology">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Button
            size="sm"
            variant="secondary"
            full
            onClick={() => {
              const id = lab.addNode(system.id, { name: `Stage ${system.nodes.length + 1}` });
              lab.connect(system.id, node.id, id, 1);
            }}
          >
            + Stage after this one
          </Button>
          <Button
            size="sm"
            variant="secondary"
            full
            onClick={() => {
              // Two children at 50/50. `connect` rescales whatever this stage
              // already routed so the shares still total 1 — otherwise adding a
              // branch to a mid-chain stage would take it to 200% and the whole
              // system would refuse to solve.
              const a = lab.addNode(system.id, { name: `${node.name} · route A` });
              const b = lab.addNode(system.id, { name: `${node.name} · route B` });
              lab.connect(system.id, node.id, a, 0.5);
              lab.connect(system.id, node.id, b, 0.5);
            }}
          >
            + Branch into two routes
          </Button>
          {system.nodes.length > 1 && (
            <ReworkControl systemId={system.id} node={node} nodes={system.nodes} />
          )}
          {system.nodes.length > 1 && (
            <Button size="sm" variant="ghost" full onClick={() => lab.removeNode(system.id, node.id)}>
              Remove this stage
            </Button>
          )}
        </div>
      </Group>
    </aside>
  );
}

/** Send a share of this stage's output back to an earlier one. */
function ReworkControl({
  systemId,
  node,
  nodes,
}: {
  systemId: string;
  node: QueueNode;
  nodes: QueueNode[];
}) {
  const lab = useLab();
  const targets = nodes.filter((n) => n.id !== node.id);
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [share, setShare] = useState(15);
  if (targets.length === 0) return null;

  return (
    <div
      style={{
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        padding: 9,
        background: SW_COLORS.paperDeep,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>Send work back</div>
      <HudSelect
        value={target || targets[0].id}
        onChange={setTarget}
        variant="light"
        size="sm"
        width="100%"
        options={targets.map((t) => ({ value: t.id, label: t.name }))}
      />
      <NumberField
        label="Share %"
        value={share}
        min={0}
        max={100}
        step={5}
        editable
        onChange={setShare}
      />
      <Button
        size="sm"
        variant="secondary"
        full
        onClick={() =>
          lab.connect(systemId, node.id, target || targets[0].id, Math.min(1, Math.max(0, share / 100)))
        }
      >
        Add rework loop
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Small bits
// ─────────────────────────────────────────────────────────────────────────

/** Stat-tile label: plain name plus the symbol, which must escape the
 *  uppercase transform the tile applies to everything else. */
function StatLabel({ name, q }: { name: string; q: QuantityId }) {
  return (
    <span title={glossOf(q)}>
      {name} <Sym quantity={q} />
    </span>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 16 }}>
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted, marginBottom: 7 }}>{title}</div>
      {children}
    </section>
  );
}

const railStyle: React.CSSProperties = {
  borderLeft: `1px solid ${SW_COLORS.line}`,
  background: SW_COLORS.paper,
  overflowY: 'auto',
  padding: '14px 14px 32px',
  minWidth: 0,
};

function valueFor(id: QuantityId, k: NetworkSolution['nodes'][number]['kpis']): string {
  switch (id) {
    case 'rho': return fmt(k.rho, 3);
    case 'P0': return pct(k.P0);
    case 'Lq': return fmt(k.Lq, 3);
    case 'L': return fmt(k.L, 3);
    case 'Wq': return `${fmt(k.Wq * 60, 2)} min`;
    case 'W': return `${fmt(k.W * 60, 2)} min`;
    case 'D': return fmt(k.D, 3);
    case 'pWait': return pct(k.pWait);
    case 'pNoWait': return pct(k.pNoWait);
    case 'lambdaEff': return `${fmt(k.lambdaEff, 2)} /hr`;
    case 'pBalk': return pct(k.pBalk);
    default: return '—';
  }
}

function fmt(v: number, dp = 2): string {
  if (Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return '∞';
  return v.toFixed(dp);
}

function pct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}
