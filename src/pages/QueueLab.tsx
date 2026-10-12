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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Icon,
  type IconName,
  EmptyState,
  HudSelect,
  QueueingReference,
  SectionHeader,
  Stat,
  Sym,
  Tag,
  ToggleGroup,
  DistPicker,
  ViewTitle,
  useConfirm,
  CollapsedRail,
  PaneCollapseButton,
  RAIL_W,
} from '../components';
import {
  CapacityField,
  DISCIPLINE_OPTIONS,
  DistParamInputs,
  DropdownField,
  NumberField,
  morphDist,
  patchDist,
  type DistParams,
} from '../components/queueParamFields';
import { FieldLabel } from '../components/Sym';
import { LabSchematic, LabSchematicLegend } from '../components/lab/LabSchematic';
import { LabSweep } from '../components/lab/LabSweep';
import { SW_COLORS, SW_CONTROL, SW_FONTS, SW_RADIUS, SW_SHADOWS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { QUANTITY, glossOf, type QuantityId } from '../simulation/notation';
import { solveNetwork, type NetworkSolution, type QueueNode } from '../simulation/network';
import { meanOf, type QueueDiscipline } from '../simulation';
import { workingFor, trafficEquationFor, type Working } from '../domain/lab-working';
import { useLab } from '../store/lab';
import { isSeedSystem } from '../domain/lab-systems';

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

  // Both rails fold to a RAIL_W stub, exactly as the Builder's palette and
  // inspector do, so the bench can be taken nearly full-width when you are
  // reading a schematic rather than editing one.
  const [systemsOpen, setSystemsOpen] = useState(true);
  const [paramsOpen, setParamsOpen] = useState(true);

  // [ / ] toggle the rails — the same Figma convention the Builder uses, so
  // one pair of keys works on both three-column surfaces.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as Element | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') {
        e.preventDefault();
        setSystemsOpen((o) => !o);
      } else if (e.key === ']') {
        e.preventDefault();
        setParamsOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    /* The route shell clips its child, so the horizontal scroll has to be
       owned here rather than by loosening an overflow every page shares. */
    <div style={{ height: '100%', overflowX: 'auto', background: SW_COLORS.paperDeep }}>
    <div
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateColumns: `${systemsOpen ? 278 : RAIL_W}px 1fr ${paramsOpen ? 352 : RAIL_W}px`,
        background: SW_COLORS.paperDeep,
        fontFamily: SW_FONTS.body,
        minHeight: 0,
        // Stitchworks is a desktop app with a 1024px floor and no responsive
        // reflow. Below the floor the two fixed rails would eat the whole width
        // and squeeze the bench to a column one word wide, so the grid holds
        // its intended proportions and the window scrolls instead. A collapsed
        // rail gives its width back to the floor rather than to the bench, so
        // folding one away is a real gain at any window size.
        minWidth: 1024 - (systemsOpen ? 0 : 278 - RAIL_W) - (paramsOpen ? 0 : 352 - RAIL_W),
      }}
    >
      {systemsOpen ? (
        <SystemsRail onCollapse={() => setSystemsOpen(false)} />
      ) : (
        <CollapsedRail side="left" label="SYSTEMS" onExpand={() => setSystemsOpen(true)} />
      )}

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

      {paramsOpen ? (
        <ParametersRail
          system={system}
          node={node}
          solution={solution}
          onCollapse={() => setParamsOpen(false)}
        />
      ) : (
        <CollapsedRail side="right" label="PARAMETERS" onExpand={() => setParamsOpen(true)} />
      )}
    </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  LEFT — the collection
// ─────────────────────────────────────────────────────────────────────────

function SystemsRail({ onCollapse }: { onCollapse: () => void }) {
  const systems = useLab((s) => s.systems);
  const activeId = useLab((s) => s.activeId);
  const lab = useLab();
  const confirm = useConfirm();

  return (
    <aside
      style={{
        borderRight: `1px solid ${SW_COLORS.line}`,
        background: SW_COLORS.paper,
        // The rail is a fixed header over a scrolling list, not one long
        // scrolling column: the actions belong to the collection as a whole,
        // so they stay put while you scroll through it.
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {/* Header + actions. The four actions used to sit in a wrapping row of
          labelled buttons BELOW the list, which put them at an offset that
          moved every time a system was added and, on a long list, off the
          bottom of the rail entirely. Icon-only and pinned to the header,
          they are always in the same place and always visible — and they now
          match how every other action in the app is drawn. */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '14px 12px 8px',
          background: SW_COLORS.paper,
          borderBottom: `1px solid ${SW_COLORS.line}`,
        }}
      >
        <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>Systems</div>
        <div style={{ display: 'flex', gap: 2 }}>
          <RailAction icon="plus" label="New system" onClick={() => lab.createSystem()} />
          <RailAction
            icon="duplicate"
            label="Duplicate this system"
            disabled={!activeId}
            onClick={() => activeId && lab.duplicateSystem(activeId)}
          />
          <RailAction
            icon="reset"
            label="Reset this system to its textbook values"
            disabled={!activeId || !isSeedSystem(activeId)}
            onClick={() => activeId && lab.resetSeeded(activeId)}
          />
          <RailAction
            icon="trash"
            label="Delete this system"
            danger
            disabled={!activeId || systems.length <= 1}
            onClick={async () => {
              if (!activeId) return;
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
          />
          {/* Separated from the four list actions by a hairline: collapsing
              the rail acts on the rail, not on the selected system, and the
              trash sits close enough that the two want telling apart. */}
          <div style={{ width: 1, alignSelf: 'stretch', margin: '0 4px', background: SW_COLORS.line }} />
          <PaneCollapseButton side="left" label="systems" onClick={onCollapse} />
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 12px 24px',
        }}
      >
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

    </aside>
  );
}

/**
 * One icon-only action in the Systems rail header.
 *
 * The actions are shown disabled rather than hidden. The old row rendered
 * each button only when it applied, so the set changed width and membership
 * as you clicked around the list and there was no way to learn that "reset"
 * exists at all until you happened to select a seeded system. A greyed icon
 * with a tooltip says both that the action exists and why it is not available.
 */
function RailAction({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const active = hover && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: SW_CONTROL.chevron,
        height: SW_CONTROL.chevron,
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        borderRadius: SW_RADIUS.sm,
        border: '1px solid transparent',
        background: active ? SW_COLORS.paperDeep : 'transparent',
        color: disabled
          ? SW_COLORS.faint
          : active
            ? danger
              ? SW_COLORS.alarm
              : SW_COLORS.ink
            : SW_COLORS.muted,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon name={icon} size={13} />
    </button>
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

/**
 * Every measure the closed form gives for a single stage, in reading order:
 * the four you form a verdict from, then the rest of the solution.
 */
const STAGE_MEASURES: QuantityId[] = [
  'rho', 'Lq', 'Wq', 'L', 'W', 'D', 'P0', 'pWait', 'pNoWait', 'lambdaEff', 'pBalk',
];
const MEASURE_COLS = 4;

/**
 * The measures for one stage — every one of them a tile.
 *
 * This was four headline tiles above a table of the other eleven, which said
 * by its layout that the four were the answer and the rest were footnotes.
 * They are all the same kind of thing: one closed-form number about this
 * stage. So they are all drawn the same way.
 *
 * The working did not go anywhere — it moved. Point at a tile and its
 * derivation appears under that tile's row, in a strip that hugs its own
 * working and may run the full width of the grid, which is the only place
 * wide enough for a line like P₀ = 1 / [ Σₙ₌₀ᶜ⁻¹ … ] to print without
 * wrapping into porridge. Clicking
 * pins it so it survives the pointer leaving; Escape or a second click
 * releases it.
 *
 * ── Why the strip floats instead of sitting in the flow ────────────────────
 * In the flow it would push every row below it down. Then moving the pointer
 * from a row-1 tile down onto a row-2 tile removes the row-1 strip, row 2
 * jumps up under the cursor, the pointer lands back on row 1, the strip
 * returns, and the grid oscillates. Absolutely positioned, nothing below it
 * ever moves, so hover cannot fight itself.
 */
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

  const [hovered, setHovered] = useState<QuantityId | null>(null);
  const [pinned, setPinned] = useState<QuantityId | null>(null);
  const open = hovered ?? pinned;

  /* Leaving a tile is deferred by a beat so the pointer can cross the 6px gap
     into the strip without the strip vanishing under it mid-travel. */
  const closeTimer = useRef<number | null>(null);
  const hold = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const show = (id: QuantityId) => {
    hold();
    setHovered(id);
  };
  const release = () => {
    hold();
    closeTimer.current = window.setTimeout(() => setHovered(null), 120);
  };
  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  const input = { notation: solved.notation, kpis: k, lambda: solved.lambda, mu };
  const openWorking = open ? workingFor(open, input) : null;
  const openRow = open ? Math.floor(STAGE_MEASURES.indexOf(open) / MEASURE_COLS) : -1;

  const rows: QuantityId[][] = [];
  for (let i = 0; i < STAGE_MEASURES.length; i += MEASURE_COLS) {
    rows.push(STAGE_MEASURES.slice(i, i + MEASURE_COLS));
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setPinned(null);
      }}
    >
      {rows.map((row, r) => (
        <div
          key={r}
          style={{
            position: 'relative',
            display: 'grid',
            gridTemplateColumns: `repeat(${MEASURE_COLS}, 1fr)`,
            gap: 10,
          }}
        >
          {row.map((id) => {
            const q = QUANTITY[id];
            const working = workingFor(id, input);
            return (
              /* The wrapper carries the pointer and focus events so `Stat`
                 stays a tile and does not grow a handler for every way of
                 pointing at one. `display: grid` so the tile still fills the
                 cell and the row's tiles stay the same height. */
              <div
                key={id}
                style={{ display: 'grid' }}
                onMouseEnter={() => working && show(id)}
                onMouseLeave={release}
                onFocus={() => working && show(id)}
                onBlur={release}
              >
                {/* Symbols go through <Sym>: tile labels are uppercased in
                    CSS, which renders a bare ρ as Ρ and a bare Lq as LQ. */}
                <Stat
                  label={<StatLabel name={q.name} q={id} />}
                  title={working ? `${glossOf(id)}\n\nClick to keep the working open.` : glossOf(id)}
                  value={valueFor(id, k)}
                  unit={q.unit}
                  color={id === 'rho' ? rhoTone : undefined}
                  onClick={working ? () => setPinned((p) => (p === id ? null : id)) : undefined}
                  expanded={open === id}
                />
              </div>
            );
          })}
          {openWorking && openRow === r && (
            <WorkingStrip
              id={open!}
              working={openWorking}
              pinned={pinned === open}
              onMouseEnter={hold}
              onMouseLeave={release}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** One measure's derivation, floating under the row of tiles it belongs to. */
function WorkingStrip({
  id,
  working,
  pinned,
  onMouseEnter,
  onMouseLeave,
}: {
  id: QuantityId;
  working: Working;
  pinned: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'absolute',
        left: 0,
        top: 'calc(100% + 6px)',
        zIndex: 5,
        /* Hugs its own working. A strip stretched to the grid is mostly empty
           paper for a line like L = λW, so it sizes to content and only grows
           as wide as the grid when a line like P₀ = 1 / [ Σₙ₌₀ᶜ⁻¹ … ] needs
           the room. */
        width: 'max-content',
        maxWidth: '100%',
        /* Transparent to the pointer until it is pinned. Hovering a tile
           overlays this on the row below, and a strip that swallowed clicks
           and hovers would hide the very tiles you are reaching for. Pinned,
           it becomes solid so the formula can be selected and copied. */
        pointerEvents: pinned ? 'auto' : 'none',
        border: `1px solid ${SW_COLORS.brandEdge}`,
        borderRadius: SW_RADIUS.md,
        background: SW_COLORS.paperEdge,
        boxShadow: SW_SHADOWS.float,
        padding: '10px 14px 11px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>
          {QUANTITY[id].name} <Sym quantity={id} color={SW_COLORS.brandText} />
        </div>
        {pinned && (
          <div style={{ ...SW_TYPE.overline, color: SW_COLORS.faint }}>Pinned · esc</div>
        )}
      </div>
      {/* Capped so a prose sentence wraps instead of setting the box's
          width — the formula decides how wide the strip is, not the gloss. */}
      <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted, margin: '5px 0 7px', maxWidth: '52ch' }}>
        {glossOf(id)}
      </div>
      {working.unavailable ? (
        <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted, lineHeight: 1.5 }}>
          {working.unavailable}
        </div>
      ) : (
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 12,
            lineHeight: 1.75,
            color: SW_COLORS.muted,
          }}
        >
          <div style={{ color: SW_COLORS.ink }}>{working.symbolic}</div>
          {working.substituted && <div>= {working.substituted}</div>}
          <div style={{ color: SW_COLORS.brandText, fontWeight: 700 }}>= {working.result}</div>
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
  onCollapse,
}: {
  system: { id: string; nodes: QueueNode[] } | null;
  node: QueueNode | null;
  solution: NetworkSolution | null;
  onCollapse: () => void;
}) {
  const lab = useLab();

  if (!system || !node) {
    return (
      <aside style={railStyle}>
        <RailHeader title="Parameters" onCollapse={onCollapse} />
      </aside>
    );
  }

  const patch = (p: Partial<QueueNode>) => lab.patchNode(system.id, node.id, p);
  const mu = 60 / Math.max(1e-9, meanOf(node.serviceDist));
  const solved = solution?.byNodeId[node.id];

  return (
    <aside style={railStyle}>
      <RailHeader title="Stage" onCollapse={onCollapse} />
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
        <DistPicker
          dist={node.serviceDist}
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

/**
 * The parameters rail's top row: what the rail is showing, plus the » that
 * folds it away. The rail scrolls as one column rather than having a pinned
 * header — there is nothing below the fold worth pinning past — so this rides
 * with the content.
 */
function RailHeader({ title, onCollapse }: { title: string; onCollapse: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 6,
      }}
    >
      <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>{title}</div>
      <PaneCollapseButton side="right" label="parameters" onClick={onCollapse} />
    </div>
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

/**
 * The number alone. The unit is NOT baked in here — every tile takes it from
 * `QUANTITY[id].unit`, so a measure is named and dimensioned in exactly one
 * place and the numerals stay in the display face while the unit stays small.
 */
function valueFor(id: QuantityId, k: NetworkSolution['nodes'][number]['kpis']): string {
  switch (id) {
    case 'rho': return fmt(k.rho, 3);
    case 'P0': return pct(k.P0);
    case 'Lq': return fmt(k.Lq, 2);
    case 'L': return fmt(k.L, 2);
    case 'Wq': return fmt(k.Wq * 60, 1);
    case 'W': return fmt(k.W * 60, 1);
    case 'D': return fmt(k.D, 2);
    case 'pWait': return pct(k.pWait);
    case 'pNoWait': return pct(k.pNoWait);
    case 'lambdaEff': return fmt(k.lambdaEff, 2);
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
