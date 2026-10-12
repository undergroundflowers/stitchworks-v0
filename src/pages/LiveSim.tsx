/**
 * Live Simulation — drives the discrete-event engine in real time, with four
 * views over the same engine state:
 *
 *   • ISO 3D — the Build floor's isometric projection, with walking
 *     operators, queue stacks, conveyor + WIP bundles, bottleneck flag.
 *   • TOP 2D — the same floor in plan, live state hung off each machine's
 *     footprint.
 *   • HEAT  — the same floor again, with pressure blobs over the machines.
 *   • LOGIC — the routing as a schema. The one view that is NOT the floor.
 *
 * ISO, TOP and HEAT draw ONE layout, computed once (`floor`) and handed to
 * all three, at the workstations' authored `ws.position` cells. A machine is
 * therefore at the same coordinates in RUN as in BUILD, at the same size, on
 * the same ruled grid — see the LAYOUT note above `layoutStations` for what
 * this replaced and why.
 *
 * The engine is unchanged: SimEngine ticks against (garment, operators,
 * efficiency); the views are pure visualisations of `SimState.stations`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import {
  CumulativeOutputChart,
  ThroughputChart,
  UtilizationBarChart,
  WipChart,
} from '../components/charts';
import {
  Chevron,
  SimTransportDock,
  HudSelect,
  CanvasGrid,
  CanvasLegend,
  LegendRow,
  ViewSwitch,
  ViewTitle,
  Icon,
  NumberInput,
  ZoomHud,
  useCanvasCamera,
} from '../components';
import { SimStationDetail } from '../components/SimStationDetail';
import {
  buildSimConfigFromTwin,
  buildLinesFromTwin,
  efficiencyFromSkillMatrix,
  usePmlSim,
  useMultiPmlSim,
  mergePmlSimStates,
  mergePmlTwinMetas,
  scopedTwinForLine,
  buildFlowPlayback,
  type BuildFromTwinMeta,
  type SimState,
  type LineBuild,
  type StationView,
  type PmlLineInput,
  type BundleFrame,
} from '../simulation';
import {
  fmtElapsed,
  fmtCalendar,
  simDayNumber,
  shiftProgressPct,
  unitToSeconds,
  fmtMinutesAsHHMM,
  parseHHMM,
} from '../simulation/timeUnit';
import { useProject, useGarments } from '../store';
import { isoProj, flatProj, CuboidFaces, SW_PAL, shade, isoFixtureForMachineCode, MACHINE_CATALOG, lookupFixture, stationMark, CAM_IDENTITY, fitBounds, ISO_PROJECTION, FLAT_PROJECTION, FLAT_CELL, type Cam, type CamBounds, type MachineCode, type Projection } from '../domain';
import { StationGlyph } from '../components/StationGlyph';
import { useTwin, selectActiveTwin } from '../store/twin';
import { getBlockKind, getBlockParams } from '../domain/pml';
import {
  wsBaseFootprint,
  type EntityColorKey,
} from '../domain/twin';
import { buildSeededDraftTwin } from '../lib/build-draft-twin';

/**
 * Resolve a station's canonical visual asset from `MACHINE_CATALOG`. This
 * is the single source of truth for what each workstation should *look*
 * like — colour and glyph come from the machine type, never from live
 * state. ISO, TOP and LOGIC views all funnel through this helper so an
 * SNL bobbin looks the same everywhere it appears.
 */
function stationAsset(machineCode: string | undefined): {
  glyph: string;
  label: string;
  isManual: boolean;
  /** False when `machineCode` names no machine in the catalog. Callers use
   *  this to leave the equipment slot EMPTY rather than printing a shrug:
   *  a logic block authored as a Service has no machine, and "? GENERIC"
   *  stamped on it claims otherwise. */
  known: boolean;
} {
  const spec = machineCode
    ? MACHINE_CATALOG[machineCode as MachineCode]
    : undefined;
  if (!spec) {
    // Unknown machine type — neutral steel placeholder. Keeps the
    // workstation visually distinguishable from typed peers.
    return { glyph: '?', label: machineCode ?? 'UNKNOWN', isManual: false, known: false };
  }
  return {
    glyph: spec.icon,
    label: spec.shortName,
    isManual: !!spec.isManual,
    known: true,
  };
}

/**
 * What to call a station on the floor.
 *
 * `opCode` is the bulletin's industry code (`OP-04`) and is the right label
 * the moment a station is bound to an operation. When it is not bound, the
 * station still has a name — the one the block carries in Builder — and that
 * is the honest thing to show.
 *
 * This used to fall back to `OP-${index + 1}`, which invented a code the
 * factory does not have and numbered it by position in the render list, so
 * the same machine answered to a different name depending on what else was
 * on the floor. A station is never labelled by its index now.
 */
function stationLabel(s: Pick<StationView, 'opCode' | 'opName'>, maxChars = 14): string {
  if (s.opCode) return s.opCode;
  const name = s.opName?.trim();
  if (!name) return '—';
  return name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
}

/** Total operator pool count for a (paper, variant/scenario) selection.
 *  Falls back to the baseline op count if the chosen variant key is unknown. */

type SimView = 'iso' | 'top' | 'heat' | 'logic';

/** Engine scope — what subset of the twin the run covers. Line is the
 *  legacy single-engine path; dept and factory both fan the engine out to
 *  one instance per line under the scope. */
type SimScope =
  | { kind: 'factory' }
  | { kind: 'dept'; id: string }
  | { kind: 'line'; id: string };

function scopeToParam(s: SimScope): string {
  if (s.kind === 'factory') return 'factory';
  return `${s.kind}:${s.id}`;
}

interface SimHudStatProps {
  label: string;
  value: number | string;
  unit: string;
  color: string;
}

export function LiveSimPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = useProject();
  const garments = useGarments();
  const activeTwin = useTwin(selectActiveTwin);
  // Both are re-seeded from the built twin / active order as soon as one
  // resolves; these are only the value before that happens.
  const [garmentId, setGarmentId] = useState<string>(() => garments.all[0]?.id ?? '');
  const [operators, setOperators] = useState<number>(
    () => activeTwin.lines.find((l) => l.operatorTarget)?.operatorTarget ?? 4,
  );
  const [view, setView] = useState<SimView>('iso');
  /**
   * One camera per view, preserved across switches.
   *
   * ISO, TOP, HEAT and LOGIC are genuinely different coordinate spaces,
   * so they cannot share a camera — but each keeps its own, and each is
   * waiting where you left it. This used to snap every view back to 1x on
   * every switch, which made comparing two views of the same line a chore.
   */
  const [simCams, setSimCams] = useState<Record<SimView, Cam>>({
    iso: CAM_IDENTITY,
    top: CAM_IDENTITY,
    heat: CAM_IDENTITY,
    logic: CAM_IDENTITY,
  });
  const camFor = (v: SimView) => ({
    cam: simCams[v],
    onCam: (update: (c: Cam) => Cam) =>
      setSimCams((m) => ({ ...m, [v]: update(m[v]) })),
  });
  // Per-station "sim vs theory" drawer — selected by clicking a station in the
  // ISO/TOP views. Keyed by opId (what maps to a StationView); clicking a
  // second machine that runs the same op shows that op's queue, which is the
  // right granularity for the queueing analysis.
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null);

  // ── Reference-model picker state ────────────────────────────────────────
  // Reference context — set by the Reference Models page (LOAD & SIMULATE
  // strip). Sim reads it to fold the loaded paper into the engine inputs;
  // ISO/TOP/HEAT/LOGIC views also reflect the loaded reference. Sim doesn't
  // author refs anymore (the picker bar moved out), so we only need the
  // read + clear selectors here.
  // The simulation has exactly one source: the user's Factory Builder twin.
  //
  // There used to be three — the twin, an order committed from the Orders
  // wizard, and a published reference paper — behind a SOURCE dropdown. The
  // reference branch had already been dead for a while (`isRefSource` was a
  // hardcoded `false`, so the option could never render), and the order
  // branch went with the wizard. What remained was a one-item picker in front
  // of a `useTwinSource` flag that was always true, so both are gone and the
  // twin is read unconditionally below.

  // Engine scope — three levels: a single sewing line, an entire department
  // (every wired line whose deptId matches), or the whole factory (every
  // wired line in the twin). `?scope=<kind[:id]>` is canonical; the legacy
  // `?line=<id>` URL is honoured as a shortcut for line scope so existing
  // bookmarks keep resolving.
  const linesInTwin = activeTwin.lines ?? [];
  const scope: SimScope = useMemo(() => {
    const raw = searchParams.get('scope');
    if (raw?.startsWith('line:')) {
      const id = raw.slice(5);
      if (linesInTwin.some((l) => l.id === id)) return { kind: 'line', id };
    } else if (raw === 'factory') {
      return { kind: 'factory' };
    }
    const legacyLine = searchParams.get('line');
    if (legacyLine && legacyLine !== 'all' && linesInTwin.some((l) => l.id === legacyLine)) {
      return { kind: 'line', id: legacyLine };
    }
    return { kind: 'factory' };
  }, [searchParams, linesInTwin]);
  const selectedLineId = scope.kind === 'line' ? scope.id : null;

  // Per-line builds — drives the "LINES" strip's KPI cards. Computed every
  // time the twin or garment library changes so the cards stay live with the
  // Builder. Empty list when the twin has no lines.
  const lineBuilds: LineBuild[] = useMemo(() => {
    if (linesInTwin.length === 0) return [];
    return buildLinesFromTwin({
      twin: activeTwin,
      garmentsById: garments.byId,
      defaultGarmentId: garmentId,
      opEfficiency: efficiencyFromSkillMatrix(
        project.skillMatrix,
        (garments.byId[garmentId] ?? garments.all[0]).operations,
      ),
      modelTimeUnit: project.time.modelTimeUnit,
    });
  }, [activeTwin, linesInTwin.length, garments.byId, garmentId, project.skillMatrix, project.time.modelTimeUnit, garments.all]);

  // Twin-driven config + meta. Wrapped in a try because the user can land
  // on /sim with an empty twin — we fall back to the reference / garment
  // path in that case instead of blowing up the page.
  const twinBuild = useMemo(() => {
    try {
      return buildSimConfigFromTwin({
        twin: activeTwin,
        garmentsById: garments.byId,
        defaultGarmentId: garmentId,
        opEfficiency: efficiencyFromSkillMatrix(
          project.skillMatrix,
          (garments.byId[garmentId] ?? garments.all[0]).operations,
        ),
        modelTimeUnit: project.time.modelTimeUnit,
        lineId: selectedLineId ?? undefined,
      });
    } catch {
      return null;
    }
  }, [activeTwin, garments.byId, garmentId, project.skillMatrix, project.time.modelTimeUnit, garments.all, selectedLineId]);

  const garment = twinBuild?.meta.garment ?? (garments.byId[garmentId] ?? garments.all[0]);
  // Operator count for display. The slider owns it, re-seeded by the effect
  // below whenever the twin changes.
  const effectiveOperators = operators;

  const opEfficiency = useMemo(
    () => efficiencyFromSkillMatrix(project.skillMatrix, garment.operations),
    [project.skillMatrix, garment],
  );

  // Resolve the sim-source twin. PML drives off a Twin (not a SimConfig),
  // so each source (twin / reference / order / garment) materialises into
  // one.
  //   • Twin / reference path → the active twin (loadCanonical writes the
  //     active twin is already the reference graph).
  //   • Order / garment fallback → synthesise a single-line twin from the
  //     chosen bulletin so PML has a Source → ops → Sink to run.
  //
  // When the user picks a non-default bundle size in the HUD, mutate every
  // Source block's `piecesPerAgent` to match and rescale `sourceRatePerHr`
  // so the *piece* throughput stays constant — same semantics the legacy
  // engine had when bundleSize × arrivalRate stayed pinned.
  //
  // Empty-twin fallback keeps the hook call unconditional when no garment
  // is available either.
  const simSourceTwin = useMemo(
    () => (selectedLineId ? scopedTwinForLine(activeTwin, selectedLineId) : activeTwin),
    [selectedLineId, activeTwin],
  );
  // Captured for future PML wiring — it does not flow into the engine today
  // because the twin already encodes it. `opEfficiency` is mirrored back into
  // the skill matrix store by the operator slider effect above.
  void opEfficiency;

  // Re-seed the operator slider whenever the twin meta says the default has
  // changed (e.g. user edits Builder, returns to /sim). Skip when the user
  // has typed an explicit override (i.e. `operators` already differs from
  // the seed) — preserves their intent.
  const lastSeedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!twinBuild) return;
    if (lastSeedRef.current !== twinBuild.meta.seedOperators) {
      setOperators(twinBuild.meta.seedOperators);
      lastSeedRef.current = twinBuild.meta.seedOperators;
    }
  }, [twinBuild]);

  const baseSim = usePmlSim(simSourceTwin, { garment, recordFlow: true });

  // ── Multi-line scope ────────────────────────────────────────────────────
  // When no specific line is selected and the twin has more than one wired
  // line, drive one PML run per line and merge the resulting states + metas
  // into the same shape the existing views consume. Each per-line twin is
  // scoped to that line's workstations so different garments / bundle sizes
  // don't compose into one homogeneous simulation.
  //
  // Lines actually included in this scope's run: factory = all wired, dept
  // = every wired line, line = none (single-engine path
  // handles it).
  const wiredLineBuilds = useMemo(() => {
    const ok = lineBuilds.filter((lb) => lb.ok);
    if (scope.kind === 'line') return ok.filter((lb) => lb.line.id === scope.id);
    return ok; // factory
  }, [lineBuilds, scope]);
  const inMultiLineScope =
    scope.kind !== 'line' && wiredLineBuilds.length > 1;
  const multiInputs = useMemo<PmlLineInput[]>(
    () =>
      inMultiLineScope
        ? wiredLineBuilds.map((lb) => ({
            lineId: lb.line.id,
            twin: scopedTwinForLine(activeTwin, lb.line.id),
            garment: lb.build.meta.garment,
          }))
        : [],
    [inMultiLineScope, wiredLineBuilds, activeTwin],
  );
  const multiSim = useMultiPmlSim(multiInputs, { recordFlow: true });
  const multiLineIds = useMemo(
    () => wiredLineBuilds.map((lb) => lb.line.id),
    [wiredLineBuilds],
  );
  const multiLineNames = useMemo(
    () => wiredLineBuilds.map((lb) => lb.line.name),
    [wiredLineBuilds],
  );
  const mergedMultiState = useMemo<SimState>(
    () => mergePmlSimStates(multiSim.states, multiLineIds),
    [multiSim.states, multiLineIds],
  );
  const mergedMultiMeta = useMemo<BuildFromTwinMeta | null>(
    () => mergePmlTwinMetas(multiSim.views, multiLineIds, multiLineNames),
    [multiSim.views, multiLineIds, multiLineNames],
  );

  // Single set of {state, transport, meta} the rest of the page reads from.
  // In single-line scope this is just `baseSim` verbatim. In multi-line scope
  // every read transparently sees the merged shape.
  const state: SimState = inMultiLineScope ? mergedMultiState : baseSim.state;
  const playing = inMultiLineScope ? multiSim.playing : baseSim.playing;
  const speed = inMultiLineScope ? multiSim.speed : baseSim.speed;
  const setPlaying = inMultiLineScope ? multiSim.setPlaying : baseSim.setPlaying;
  const setSpeed = inMultiLineScope ? multiSim.setSpeed : baseSim.setSpeed;
  const reset = inMultiLineScope ? multiSim.reset : baseSim.reset;
  const step = inMultiLineScope ? multiSim.step : baseSim.step;

  // ── Real bundle playback (Phase 3) ────────────────────────────────────────
  // Index the recorded entity-flow stream so the views can place each bundle
  // at its actual station (waiting / in service / blocked) at the current
  // playback minute — replacing the old synthetic `simTime × const` motion.
  // Station ids are unique across lines, so multi-line flows concatenate.
  const flowPlayback = useMemo(() => {
    const flow = inMultiLineScope
      ? multiSim.results.flatMap((r) => r?.flow ?? [])
      : (baseSim.result?.flow ?? []);
    return buildFlowPlayback(flow);
  }, [inMultiLineScope, multiSim.results, baseSim.result]);
  const liveBundles = useMemo(
    () => flowPlayback.bundlesAt(state.time),
    [flowPlayback, state.time],
  );

  // Effective twin meta passed to the view components — the floor plan for
  // whatever is about to be drawn.
  //
  // It comes from the PML view, i.e. from the thing that actually RAN, and
  // not from `buildSimConfigFromTwin`. The two build different sets: PML
  // makes a station of every Service block, the legacy builder keeps only
  // the blocks whose `operation.opId` resolves in a garment bulletin and
  // THROWS when that leaves nothing. So on a floor where no station is bound
  // to an operation yet — every hand-built line, before the bulletin is
  // wired — the meta was null, `layoutStations` fell through to its synthetic
  // row, and the run's stations were drawn as evenly-spaced placeholder slabs
  // at the grid origin while the user's actual blocks were drawn a second
  // time, as ambient scenery, where they really stood. Three ghosts of a
  // four-block floor, labelled OP-1 / OP-2 / OP-3.
  //
  // Reading the PML meta makes the floor and the run the same list by
  // construction: one cell per simulated block, at `ws.position`, with the
  // block's own footprint and catalog id. Multi-line scope already merged
  // PML metas (`mergePmlTwinMetas`) — this is the single-line path catching
  // up, not a new idea.
  const effectiveTwinMeta: BuildFromTwinMeta | null = inMultiLineScope
    ? mergedMultiMeta
    : baseSim.view.meta;
  // Ambient workstations — everything the user placed in Factory Builder that
  // *isn't* a sewing-op-bearing engine station. Spreaders, cutters, QC tables,
  // inline irons, packing benches, fabric racks, bundle trolleys, supervisors,
  // helpers, conveyors — all of it. The Sim views render these as static iso
  // cuboids behind the engine stations so the floor reads as a full factory.
  // Without this, only the sewing line shows up in the simulation and the
  // rest of the factory user authored seems to disappear.
  const ambientWorkstations = useMemo<AmbientWorkstationInput[]>(() => {
    if (!activeTwin?.workstations) return [];
    const simulatedSet = new Set(effectiveTwinMeta?.simulatedWsIds ?? []);
    const lineById = new Map(
      (activeTwin.lines ?? []).map((l) => [l.id, l] as const),
    );
    return activeTwin.workstations
      .filter((ws) => !simulatedSet.has(ws.id))
      .map((ws): AmbientWorkstationInput => {
        const fix = lookupFixture(ws.catalogId);
        const line = ws.lineId ? lineById.get(ws.lineId) : undefined;
        const deptColor = line ? (DEPT_LINE_COLORS[line.color] ?? '#888') : '#888';
        // `wsBaseFootprint`, not the raw catalogue dims: a station carrying a
        // per-ws `size` override covers those cells on the Build floor, so it
        // has to cover them here too.
        const fp = wsBaseFootprint(ws);
        return {
          wsId: ws.id,
          catalogId: ws.catalogId,
          name: ws.name,
          gx: ws.position.x,
          gy: ws.position.y,
          w: fp.w,
          d: fp.d,
          h: fp.h,
          rotation: ws.rotation ?? 0,
          deptColor,
          cat: fix?.cat ?? 'fix',
          lineId: ws.lineId,
        };
      });
  }, [activeTwin, effectiveTwinMeta]);

  /**
   * The floor — one layout, shared by ISO, TOP and HEAT.
   *
   * Laid out here rather than inside each view so there is exactly one answer
   * to "where is this machine", and so the coordinate marker below can read
   * the same cells the views draw. See the LAYOUT note further down for what
   * happened when there were four answers.
   */
  const floor = useMemo(
    () => layoutStations(state.stations, effectiveTwinMeta, ambientWorkstations),
    [state.stations, effectiveTwinMeta, ambientWorkstations],
  );

  // Time displays — see `lib/timeUnit`. Everything here is derived from model
  // time, never the device clock, so a paused session resumes reading the
  // same day and the same elapsed total.
  //
  // The device clock used to be pinned in the dock beside these, ticking a
  // `setInterval` that re-rendered this whole page once a second to show the
  // user something their menu bar already shows. Both the readout and its
  // timer are gone.
  const unit = project.time.modelTimeUnit;
  const dayN = simDayNumber(state.time, unit, project.time.shiftDurationMin);
  const shiftPct = shiftProgressPct(state.time, unit, project.time.shiftDurationMin);
  const elapsedStr = fmtElapsed(state.time, unit);
  const calStr = fmtCalendar(state.time, unit, project.time.startDate, project.units.dateFormat);

  // Collapse state for the floating STATS overlay. Useful in LOGIC view where
  // the operation grid spans the canvas — the user can fold it away to see the
  // cards underneath without losing it entirely.
  const [hudOpen, setHudOpen] = useState(false);

  // TIME SETUP — model-time semantics + calendar anchoring for the run.
  //
  // These four fields have moved twice. They came off the old Settings page
  // to be near the clocks they define, landing as a drawer under the page
  // header; then the clocks themselves moved into the transport dock, which
  // left the drawer defining readouts a full screen height below it and
  // holding 106px of floor open to do it. They render inside the dock now
  // (see SimTransportDock's `setup` prop) — same fields, no reserved strip,
  // and the settings sit on the instrument they configure.
  //
  // Dark-surface styling below mirrors the Sim view's overlays; colours go
  // through alpha()/tokens so no raw literals hit the ratchet.
  const setupLabel: CSSProperties = {
    display: 'block',
    fontFamily: SW_FONTS.mono,
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.14em',
    color: alpha(SW_COLORS.ink, 0.6),
    marginBottom: 6,
  };
  const setupInput: CSSProperties = {
    width: '100%',
    padding: '7px 9px',
    background: alpha(SW_COLORS.ink, 0.06),
    border: `1px solid ${alpha(SW_COLORS.ink, 0.2)}`,
    borderRadius: SW_RADIUS.sm,
    color: SW_COLORS.ink,
    fontFamily: SW_FONTS.mono,
    fontSize: 13,
    fontWeight: 700,
    colorScheme: 'dark',
  };

  // The panel itself, handed to the dock. Two columns rather than the
  // drawer's four: a popover is sized by its contents, so the fields can sit
  // at a readable width instead of being stretched to whatever a full-bleed
  // strip happened to be.
  const timeSetupPanel = (
    <>
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: '0.18em',
            color: SW_COLORS.ink,
          }}
        >
          TIME SETUP
        </div>
        {/* One sentence. The drawer's caption also explained where playback
            speed lived, which was only worth saying while the two were a
            screen apart — the speed well is now four pixels to the left. */}
        <div
          style={{
            marginTop: 4,
            fontFamily: SW_FONTS.body,
            fontSize: 11,
            lineHeight: 1.45,
            color: alpha(SW_COLORS.ink, 0.55),
          }}
        >
          What one tick of the clock is worth, and where the run starts on the calendar.
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 14,
          alignItems: 'start',
        }}
      >
        {/* Model time unit — dark inline toggle (ToggleGroup is light-only).
            Full width: four segments need the room, and it is the field the
            other three are measured in. */}
        <div style={{ gridColumn: '1 / -1' }}>
          <span style={setupLabel}>MODEL TIME UNIT</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['second', 'minute', 'hour', 'day'] as const).map((u) => {
              const active = project.time.modelTimeUnit === u;
              return (
                <button
                  key={u}
                  onClick={() => project.setTime('modelTimeUnit', u)}
                  style={{
                    flex: 1,
                    padding: '7px 4px',
                    textTransform: 'capitalize',
                    background: active ? SW_COLORS.brand : alpha(SW_COLORS.ink, 0.06),
                    color: active ? SW_COLORS.void : alpha(SW_COLORS.ink, 0.7),
                    border: 'none',
                    borderRadius: SW_RADIUS.sm,
                    fontFamily: SW_FONTS.mono,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {u}
                </button>
              );
            })}
          </div>
        </div>

        {/* Shift duration (minutes). */}
        <div>
          <span style={setupLabel}>SHIFT DURATION</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <NumberInput
              aria-label="Shift duration in minutes"
              min={30}
              max={1440}
              step={30}
              value={project.time.shiftDurationMin}
              onChange={(v) => {
                if (v !== undefined) project.setTime('shiftDurationMin', v);
              }}
              style={{ ...setupInput, width: 76 }}
            />
            <span
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                color: alpha(SW_COLORS.ink, 0.55),
                whiteSpace: 'nowrap',
              }}
            >
              min · {(project.time.shiftDurationMin / 60).toFixed(1)} h
            </span>
          </div>
        </div>

        {/* Shift start time-of-day. */}
        <div>
          <span style={setupLabel}>SHIFT START</span>
          <input
            type="time"
            value={fmtMinutesAsHHMM(project.time.shiftStartMinuteOfDay)}
            onChange={(e) => project.setTime('shiftStartMinuteOfDay', parseHHMM(e.target.value))}
            style={setupInput}
          />
        </div>

        {/* Simulation start date — calendar anchor for t = 0. */}
        <div style={{ gridColumn: '1 / -1' }}>
          <span style={setupLabel}>START DATE · t = 0</span>
          <input
            type="date"
            value={project.time.startDate.slice(0, 10)}
            onChange={(e) => {
              const day = e.target.value;
              if (!day) return;
              // Preserve the existing time-of-day portion of startDate.
              const existing = new Date(project.time.startDate);
              const next = new Date(day);
              if (!Number.isNaN(existing.getTime())) {
                next.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
              }
              project.setTime('startDate', next.toISOString());
            }}
            style={setupInput}
          />
        </div>
      </div>
    </>
  );

  // Throughput in pieces/hour, read straight off the history.
  //
  // This used to multiply by the run's bundle size, which double-counted by
  // exactly that factor: on the starter line it reported 2,134 pcs/hr next to
  // an OUTPUT tile reading 569 pcs after 8 hours (really 71 pcs/hr). The
  // multiplier is a leftover from the legacy engine, which counted BUNDLES —
  // the PML engine accumulates `agent.pieces` at the Sink, so
  // `HistoryPoint.throughputPerHr` is already pieces per hour. Multi-line
  // scope needs no multiplier either, since `mergePmlSimStates` sums pieces.
  const throughputPerHr = useMemo(() => {
    if (inMultiLineScope) {
      let total = 0;
      for (const s of multiSim.states) {
        const last = s.history.length > 0 ? s.history[s.history.length - 1] : undefined;
        if (last) total += last.throughputPerHr;
      }
      return total;
    }
    return state.history.length > 0
      ? state.history[state.history.length - 1].throughputPerHr
      : 0;
  }, [inMultiLineScope, multiSim.states, state.history]);

  const efficiencyPct = Math.round(state.utilization * 100);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        // A flex column, not a row-track grid. The grid's track list had to
        // match the child count exactly, so the conditionally-rendered TIME
        // SETUP drawer shifted the floor into the wrong track and zeroed its
        // height whenever the drawer was open. A column has nothing to keep
        // in sync: the header (plus drawer) size to content and the floor
        // takes every pixel that is left.
        display: 'flex',
        flexDirection: 'column',
        // Dark ground. This read `background: ink / color: paper` from before
        // the Control Room flip made `ink` the near-white and `paper` the
        // near-black — which painted the whole HUD white-on-white. The
        // `surface="dark"` children and `colorScheme: 'dark'` inputs below
        // are the evidence of the original intent.
        background: SW_COLORS.paper,
        color: SW_COLORS.ink,
      }}
    >
      {/* HUD — page identity, run setup, line scope and the Builder escape
          hatch on one line. The sewing-line picker used to be its own 78px
          strip under this bar, which cost the canvas a full row to say what
          fits in a rail of pills. */}
      <div
        style={{
          padding: '10px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          borderBottom: '1px solid #ffffff15',
          flexWrap: 'nowrap',
          minWidth: 0,
        }}
      >
        {/* Back to menu — same affordance, same spot as the Builder's, so
            leaving a surface is the same gesture on every tab. */}
        <button
          onClick={() => navigate('/')}
          title="Back to menu"
          aria-label="Back to menu"
          style={{
            flex: 'none',
            width: 30,
            height: 30,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            background: alpha(SW_COLORS.ink, 0.08),
            border: `1px solid ${alpha(SW_COLORS.ink, 0.2)}`,
            borderRadius: SW_RADIUS.sm,
            color: alpha(SW_COLORS.ink, 0.8),
            cursor: 'pointer',
          }}
        >
          <Icon name="back" />
        </button>
        <ViewTitle title="Live Sim" surface="dark" />
        <div style={{ width: 1, height: 20, flex: 'none', background: '#ffffff20' }} />

        {/* The run's clock used to sit here, and a TIME SETUP button next to
            it opened the drawer that defined what the clock counted. Both are
            in the transport dock now — see SimTransportDock — beside the
            controls that move the run. This bar is left saying only what the
            run IS. */}

        {/* SEWING LINES — scope picker, in the top bar with the other
            controls that say what the run IS. Was a full-width strip of
            three-line cards below this bar; the detail those cards carried
            lives in each pill's tooltip now. */}
        {lineBuilds.length > 0 ? (
          <SewingLinesScope
            lineBuilds={lineBuilds}
            scope={scope}
            activeTwin={activeTwin}
            onPickScope={(next) => {
              const params = new URLSearchParams(searchParams);
              params.delete('line');
              if (next.kind === 'factory') params.delete('scope');
              else params.set('scope', scopeToParam(next));
              setSearchParams(params);
            }}
          />
        ) : (
          <div style={{ flex: 1 }} />
        )}

        {/* EDIT IN BUILDER — opens a fresh, isolated Builder draft in a new
            browser tab. We DO NOT touch the active twin: instead we build a
            blank twin in memory with a single Sewing dept + one SewingLine
            seeded from the currently-scoped line (name, garment, production
            system, operator target), push it as a non-active scenario, and
            open `/builder?scenario=<id>&line=<id>` in a new tab. The
            originating tab keeps its current view and simulation state.
            When scope is factory/dept (no specific line), the seed line
            still carries the active sim's garment/operator-count so the
            user lands on something coherent. */}
        {(() => {
          const scopedLine =
            scope.kind === 'line'
              ? linesInTwin.find((l) => l.id === scope.id)
              : null;
          const label = scopedLine
            ? `Edit ${scopedLine.name} in Builder`
            : 'Open Builder draft';
          return (
            <button
              type="button"
              onClick={() => {
                // Pick the garment template the seed should populate. A
                // specific line's pinned garment wins; otherwise we use the
                // sim's active garment so the draft reflects what the user
                // is currently looking at.
                const seedGarmentId =
                  scopedLine?.garmentId ?? garmentId;
                const seedGarment = garments.byId[seedGarmentId];
                const draftName = scopedLine
                  ? scopedLine.name
                  : `Line · ${seedGarment?.name ?? seedGarmentId ?? 'New line'}`;
                const blank = buildSeededDraftTwin({
                  draftName,
                  garment: seedGarment,
                  operatorTarget: operators,
                  color: (scopedLine?.color ?? 'brand') as EntityColorKey,
                  notes: scopedLine
                    ? `Draft branched from ${scopedLine.name}.`
                    : `Draft opened from Simulation (${seedGarment?.name ?? seedGarmentId}, ${operators} operators).`,
                });
                const scenarioId = useTwin
                  .getState()
                  .createScenarioFromTwin({
                    name: `Draft · ${draftName}`,
                    notes: scopedLine
                      ? `Edit-in-Builder draft of ${scopedLine.name}.`
                      : 'Edit-in-Builder draft from Simulation.',
                    twin: blank.twin,
                    activate: false,
                  });
                const targetHash = `#/builder?scenario=${encodeURIComponent(scenarioId)}&line=${encodeURIComponent(blank.lineId)}`;
                const url = `${window.location.pathname}${window.location.search}${targetHash}`;
                const win = window.open(url, '_blank', 'noopener');
                if (!win) {
                  // Popup blocked — fall through to in-tab navigation so the
                  // user still ends up in the draft.
                  navigate(
                    `/builder?scenario=${encodeURIComponent(scenarioId)}&line=${encodeURIComponent(blank.lineId)}`,
                  );
                }
              }}
              title={
                scopedLine
                  ? `Open ${scopedLine.name} in a fresh Builder draft (new tab). The current factory is untouched.`
                  : 'Open a fresh Builder draft in a new tab. The current factory is untouched.'
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                flex: 'none',
                padding: '6px 12px',
                fontFamily: SW_FONTS.display,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: '0.12em',
                color: '#fff',
                background: scopedLine ? SW_COLORS.brand : '#ffffff14',
                border: `1px solid ${scopedLine ? SW_COLORS.brand : '#ffffff30'}`,
                borderRadius: SW_RADIUS.sm,
                cursor: 'pointer',
              }}
            >
              <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>↗</span>
              {label.toUpperCase()}
            </button>
          );
        })()}
      </div>

      {/* SIMULATION FLOOR — every remaining pixel. The transport dock rides
          on top of it as an overlay rather than claiming a row of its own. */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          background: 'radial-gradient(ellipse at 50% 30%, #182231 0%, #0a0d12 100%)',
        }}
      >
        {view === 'iso' && (
          <PanZoomViewport {...camFor('iso')} projection={ISO_PROJECTION}>
            <SimIsoView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              simTime={state.time}
              floor={floor}
              selectedOpId={selectedOpId}
              onSelectStation={setSelectedOpId}
              bundles={liveBundles}
            />
          </PanZoomViewport>
        )}
        {view === 'top' && (
          <PanZoomViewport {...camFor('top')} projection={FLAT_PROJECTION}>
            <SimTopView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              simTime={state.time}
              floor={floor}
              selectedOpId={selectedOpId}
              onSelectStation={setSelectedOpId}
            />
          </PanZoomViewport>
        )}
        {view === 'heat' && (
          <PanZoomViewport {...camFor('heat')} projection={FLAT_PROJECTION}>
            <SimHeatView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              simTime={state.time}
              floor={floor}
            />
          </PanZoomViewport>
        )}
        {view === 'logic' && (
          <PanZoomViewport {...camFor('logic')} projection={FLAT_PROJECTION}>
            <SimLogicView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              simTime={state.time}
              floor={floor}
            />
          </PanZoomViewport>
        )}

        {/* VIEW TOGGLE — floats over the top-center of the canvas so the
            mode picker sits with the thing it controls (the floor) instead
            of buried in the HUD strip. Same pill styling as before; just
            absolutely-positioned and given a translucent backdrop so it
            stays legible over any view. */}
        <ViewSwitch
          value={view}
          onChange={setView}
          options={[
            { value: 'iso', label: 'ISO 3D' },
            { value: 'top', label: 'TOP 2D' },
            { value: 'heat', label: 'HEAT' },
            { value: 'logic', label: 'LOGIC' },
          ]}
        />

        {/* Legend overlay — view-aware key for every glyph on the floor. */}
        <SimLegend view={view} />

        {/* HUD stat tiles — collapsible so the user can reclaim the
            top-left corner (e.g. LOGIC's first card sits beneath it). */}
          <div
            style={{
              position: 'absolute',
              left: 24,
              top: 24,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 6,
              zIndex: 5,
              // Bounded and scrollable: the curve rail can make this column
              // taller than the viewport, and without a cap it ran underneath
              // the floor legend. The reserve leaves that bottom-left corner
              // free rather than relying on z-order to hide the collision.
              maxHeight: 'calc(100% - 128px)',
              overflowY: 'auto',
              overflowX: 'hidden',
              paddingRight: 4,
            }}
          >
            <button
              onClick={() => setHudOpen((o) => !o)}
              title={hudOpen ? 'Collapse stats' : 'Expand stats'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                background: '#0a0d12cc',
                border: '1px solid #ffffff20',
                borderRadius: SW_RADIUS.sm,
                color: '#fff',
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: '0.2em',
                cursor: 'pointer',
                backdropFilter: 'blur(6px)',
              }}
            >
              <span style={{ color: SW_COLORS.brand }}>▣</span>
              <span>STATS</span>
              <Chevron open={hudOpen} color="#ffffff80" />
            </button>
            {hudOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* ── RUNNING context ──────────────────────────────────────
                    Read-only: what the sim is running against. Authoring
                    happens in Factory Builder; this section just confirms
                    garment / operator count / bundle / system topology.
                    BUNDLE here is the actual emitted bundle from the twin's
                    Source block (single source of truth); SYSTEM only names
                    the layout topology. Placed BELOW the KPI grid so the
                    headline numbers come first; context is reference info. */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '8px 12px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.082)',
                    borderRadius: SW_RADIUS.sm,
                    fontFamily: SW_FONTS.body,
                    fontSize: 11,
                    order: 2,
                  }}
                >
                  {/* GARMENT — full-width row, label on top so the select can
                      take the full panel width without colliding with the label. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ color: '#ffffff80', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 9, letterSpacing: '0.1em' }}>
                      GARMENT
                    </span>
                    {(() => {
                      // When the active twin pins a dominant garment (workstations carry
                      // a garmentId), `buildSimConfigFromTwin` runs against that garment
                      // regardless of the dropdown — so showing the project's default
                      // garment label here is a lie. Surface the twin's actual garment
                      // and lock the control so the user can't pick something that
                      // would be silently ignored.
                      const twinGarment = twinBuild?.meta.garment ?? null;
                      const twinPins =
                        !!twinGarment && !!twinBuild?.meta.garmentPinned;
                      const displayedValue = twinPins ? twinGarment.id : garmentId;
                      const visibleHasTwinGarment =
                        twinPins && garments.all.some((g) => g.id === twinGarment.id);
                      const twinExtraOption =
                        twinPins && !visibleHasTwinGarment
                          ? [{
                              value: twinGarment.id,
                              label: twinGarment.name,
                              tag: 'TWIN',
                              disabled: true,
                            }]
                          : [];
                      const options = [
                        ...twinExtraOption,
                        ...garments.all.map((g) => ({
                          value: g.id,
                          label: g.name.replace(/\s*\(.*\)/, ''),
                          tag: twinPins && g.id === twinGarment.id ? 'TWIN' : undefined,
                          disabled: twinPins,
                        })),
                      ];
                      const title = twinPins
                        ? `Garment is pinned by the workstations in Factory Builder (${twinGarment.name}). Change the workstation operation in Builder to switch garments.`
                        : undefined;
                      return (
                        <HudSelect
                          value={displayedValue}
                          minWidth={180}
                          mono
                          disabled={twinPins}
                          title={title}
                          options={options}
                          onChange={(id) => {
                            if (id === '__ref__') return;
                            setGarmentId(id);
                          }}
                        />
                      );
                    })()}
                  </div>

                  {/* Read-only OPERATORS / BUNDLE / SYSTEM rows. Sim observes
                      the twin — authoring lives in Factory Builder. */}
                  <div
                    title="Operator count — edit in Factory Builder"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 2 }}
                  >
                    <span style={{ color: '#ffffff80', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 9, letterSpacing: '0.1em' }}>
                      OPERATORS
                    </span>
                    <span style={{ color: '#fff', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 12 }}>
                      {effectiveOperators}
                    </span>
                  </div>

                  {twinBuild && (
                    <div
                      title="Bundle size — edit in Factory Builder (Source block)"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
                    >
                      <span style={{ color: '#ffffff80', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 9, letterSpacing: '0.1em' }}>
                        BUNDLE
                      </span>
                      <span style={{ color: '#fff', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 12 }}>
                        {twinBuild.meta.seedBundleSize}
                      </span>
                    </div>
                  )}

                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: 12, order: 1 }}>
                  <SimHudStat label="OUTPUT" value={state.producedPieces.toLocaleString()} unit="pcs" color={SW_COLORS.brand} />
                  <SimHudStat label="THROUGHPUT" value={Math.round(throughputPerHr).toLocaleString()} unit="pcs/hr" color={SW_COLORS.ok} />
                  <SimHudStat label="WIP" value={state.totalArrivals - state.produced} unit="bundles" color={SW_COLORS.thread} />
                  <SimHudStat label="UTIL" value={efficiencyPct} unit="%" color={SW_COLORS.fabric} />
                </div>

                {/* Per-line breakdown — only meaningful in dept/factory scope
                    where >1 engine is running in parallel. Surfaces which line
                    is contributing what so the aggregate tiles above don't
                    hide a quiet line behind a busy one. */}
                {inMultiLineScope && multiSim.states.length > 0 && (
                  <PerLineStatsRow
                    lineBuilds={wiredLineBuilds}
                    states={multiSim.states}
                  />
                )}

                {/*
                  Live curves, directly under the tiles they belong to.

                  The data was always here — `state.history` grows causally as
                  playback advances — but this page read only its LAST element
                  for the tiles and threw the rest away, so the only way to see
                  a production curve was to leave the run and open Reports. The
                  chart components were module-private inside Reports.tsx, which
                  is why nobody had wired them up: they were unreachable.

                  A tile answers "what is it now"; the curve answers "is it
                  settling, climbing, or stalled", which is the question an IE is
                  actually asking while watching a shift.
                */}
                <SimChartRail history={state.history} stations={state.stations} />
              </div>
            )}
          </div>

        {/* Per-station sim-vs-theory drawer — fed by the REAL run on this page. */}
        {(() => {
          const idx = selectedOpId ? state.stations.findIndex((s) => s.opId === selectedOpId) : -1;
          if (idx < 0) return null;
          return (
            <SimStationDetail
              station={state.stations[idx]}
              history={state.stationHistory[idx] ?? []}
              onClose={() => setSelectedOpId(null)}
            />
          );
        })()}

        {/* TRANSPORT DOCK — an overlay pinned to the bottom of the floor,
            not a row beneath it. The controls that move the run now sit on
            the thing they move, and the canvas keeps the ~90px the docked
            bar used to take off the bottom of every view. */}
        {(() => {
          // Speed and execution mode were two controls on one axis: picking a
          // tier while Virtual was on changed a number the pacer then ignored.
          // They are one selector now — a numeric tier means real-time pacing,
          // VIRT means "run as fast as compute allows".
          const virtual = project.time.executionMode === 'virtual';
          const speedValue = virtual ? 'virtual' : String(speed);
          // Line pace — the bottleneck station's cycle time, which is the
          // interval the floor actually delivers a piece at. Not demand takt:
          // this comes from the run, not from an order.
          const bn =
            state.stations[state.bottleneckOpIndex] ??
            state.stations.reduce<(typeof state.stations)[number] | undefined>(
              (slowest, st) =>
                !slowest || st.smv / Math.max(1, st.serversTotal) > slowest.smv / Math.max(1, slowest.serversTotal)
                  ? st
                  : slowest,
              undefined,
            );
          const paceMin = bn && bn.serversTotal > 0 ? bn.smv / bn.serversTotal : null;
          // Reported as pieces per hour rather than minutes per piece. Same
          // fact, but "0.417 min/pc" has to be inverted in the reader's head
          // before it means anything, and a floor is planned in pieces.
          const pcsPerHour = paceMin != null && paceMin > 0 ? Math.round(60 / paceMin) : null;
          return (
            <SimTransportDock
              playing={playing}
              onToggle={() => setPlaying(!playing)}
              onReset={reset}
              onStep={() => step(3600 / unitToSeconds(unit))}
              stepLabel="1h"
              speed={speedValue}
              speedOptions={[
                { value: '1', label: '1×', title: `Real-time · 1 model-${unit} per real-sec` },
                { value: '10', label: '10×', title: `10 model-${unit} per real-sec` },
                { value: '60', label: '60×', title: '1 model-hour per real-sec' },
                { value: '480', label: '480×', title: 'Full 8-hr shift in 1 real-sec' },
                { value: 'virtual', label: 'VIRT', title: 'Virtual — engine runs as fast as compute allows, no real-time pacing' },
              ]}
              onSpeed={(v) => {
                if (v === 'virtual') {
                  project.setTime('executionMode', 'virtual');
                  return;
                }
                if (virtual) project.setTime('executionMode', 'realtime');
                setSpeed(Number(v));
              }}
              accent={
                pcsPerHour != null
                  ? {
                      label: 'RATE',
                      value: String(pcsPerHour),
                      unit: 'pcs/hr',
                      title: `The slowest step on the line is ${bn?.opName}, which passes a piece every ${Math.round(paceMin! * 60)} s. That caps the whole line at about ${pcsPerHour} pieces an hour.`,
                    }
                  : null
              }
              progressPct={shiftPct}
              clock={{
                elapsed: elapsedStr,
                day: dayN,
                date: calStr,
              }}
              setup={timeSetupPanel}
              end={{ label: 'End shift →', onClick: () => navigate('/kpi') }}
            />
          );
        })()}
      </div>

      <style>{`
        @keyframes sim-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes sim-march { to { stroke-dashoffset: -16; } }
        @keyframes sim-ping { 0% { opacity: 0.55; transform: scale(1); } 100% { opacity: 0; transform: scale(2.1); } }
      `}</style>
    </div>
  );
}

/**
 * Compact per-line breakdown that sits beneath the four aggregate HUD tiles
 * when the run spans multiple lines (dept / factory scope). Each row gives
 * the line's OUTPUT (pcs), THROUGHPUT (pcs/hr) and capacity-weighted UTIL,
 * so the user can see which line is dragging or leading the aggregates.
 */
function PerLineStatsRow({
  lineBuilds,
  states,
}: {
  lineBuilds: LineBuild[];
  states: SimState[];
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: '#0a0d12cc',
        border: '1px solid #ffffff15',
        borderRadius: SW_RADIUS.sm,
        padding: '6px 10px',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 800,
          color: '#ffffff80',
          letterSpacing: '0.2em',
        }}
      >
        PER LINE
      </div>
      {lineBuilds.map((lb, i) => {
        const s = states[i];
        if (!s) return null;
        const accent = DEPT_LINE_COLORS[lb.line.color] ?? SW_COLORS.brand;
        const bundle = lb.build.config.bundleSize;
        const last = s.history.length > 0 ? s.history[s.history.length - 1] : undefined;
        const pcsPerHr = last ? Math.round(last.throughputPerHr * bundle) : 0;
        const utilPct = Math.round(s.utilization * 100);
        const wip = s.totalArrivals - s.produced;
        return (
          <div
            key={lb.line.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, 1fr) repeat(4, auto)',
              gap: 10,
              alignItems: 'baseline',
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
              <span
                aria-hidden
                style={{ width: 6, height: 6, borderRadius: 1, background: accent, flexShrink: 0 }}
              />
              <span
                style={{
                  color: '#fff',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {lb.line.name}
              </span>
            </div>
            <PerLineCell label="OUT" value={s.producedPieces.toLocaleString()} unit="pcs" color={SW_COLORS.brand} />
            <PerLineCell label="TPUT" value={pcsPerHr.toLocaleString()} unit="pcs/hr" color={SW_COLORS.ok} />
            <PerLineCell label="WIP" value={wip.toLocaleString()} unit="b" color={SW_COLORS.thread} />
            <PerLineCell label="UTIL" value={`${utilPct}`} unit="%" color={SW_COLORS.fabric} />
          </div>
        );
      })}
    </div>
  );
}

function PerLineCell({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  color: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{ color: '#ffffff60', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em' }}>
        {label}
      </span>
      <span style={{ color, fontWeight: 800 }}>{value}</span>
      <span style={{ color: '#ffffff60', fontSize: 9 }}>{unit}</span>
    </div>
  );
}

function SimHudStat({ label, value, unit, color }: SimHudStatProps) {
  return (
    <div
      style={{
        background: '#ffffff08',
        border: '1px solid #ffffff15',
        borderRadius: SW_RADIUS.sm,
        padding: '8px 14px',
        minWidth: 120,
      }}
    >
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, color: '#ffffff80', letterSpacing: '1px' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 2 }}>
        <span style={{ fontFamily: SW_FONTS.display, fontSize: 22, fontWeight: 900, color }}>{value}</span>
        <span style={{ fontSize: 10, color: '#ffffff80', fontFamily: SW_FONTS.mono, fontWeight: 600 }}>{unit}</span>
      </div>
    </div>
  );
}

// ============================================================================
// LEGEND — view-aware key for every glyph on screen
// ============================================================================
//
// Each simulation view paints a different cast of shapes (cuboids, dots,
// stacked rects, pulsing rings…). This panel translates them into plain
// English so anyone — not just whoever built the view — can read the floor.
// Collapsible header so power users can hide it; reopens with one click.

interface SimLegendEntry {
  glyph: React.ReactNode;
  label: string;
  hint: string;
}

function SimLegend({ view }: { view: SimView }) {
  const entries = legendEntriesForView(view);
  const viewLabel =
    view === 'iso' ? 'ISO 3D'
      : view === 'top' ? 'TOP 2D'
        : view === 'heat' ? 'HEAT'
          : 'LOGIC';

  return (
    <CanvasLegend label={viewLabel} width={268}>
      {entries.map((e, i) => (
        <LegendRow key={i} glyph={e.glyph} label={e.label} hint={e.hint} />
      ))}
    </CanvasLegend>
  );
}

function legendEntriesForView(view: SimView): SimLegendEntry[] {
  switch (view) {
    case 'iso':
      return [
        {
          glyph: <IsoTableGlyph color={SW_COLORS.bobbin} />,
          label: 'Sewing-machine table',
          hint: 'Cuboid colour = machine type from the catalog (SNL, OL, FL…).',
        },
        {
          glyph: <DotGlyph color={SW_COLORS.ok} />,
          label: 'Status pip on machine head',
          hint: 'Green = running healthy · yellow = hot (>70%) · red = alarm.',
        },
        {
          glyph: <OperatorGlyph working />,
          label: 'Operator (working)',
          hint: 'Filled blue circle = an operator currently sewing a bundle.',
        },
        {
          glyph: <OperatorGlyph working={false} />,
          label: 'Operator (idle)',
          hint: 'Faded ring = station seat unoccupied or operator starved.',
        },
        {
          glyph: <PulseRingGlyph />,
          label: 'Active-sewing pulse',
          hint: 'Brand-coloured ring breathing around a working operator.',
        },
        {
          glyph: <WipStackGlyph />,
          label: 'WIP queue (stacked bars)',
          hint: 'Thread-yellow bundles waiting on the inbound side of the station.',
        },
        {
          glyph: <BottleneckGlyph />,
          label: 'Bottleneck flag',
          hint: 'Pulsing red disc with "!" — slowest operation, queue is building.',
        },
      ];
    case 'top':
      return [
        {
          glyph: <CardGlyph color={SW_COLORS.brand} />,
          label: 'Machine footprint',
          hint: 'The cells the machine occupies — the same box, at the same coordinates, as on the Build floor.',
        },
        {
          glyph: <UtilBarGlyph />,
          label: 'Utilisation fill',
          hint: 'Level rising inside the footprint = busy share · red when the station bottlenecks.',
        },
        {
          glyph: <WipStackGlyph />,
          label: 'Queue at station',
          hint: 'Stacked thread-coloured bars on the inbound side = bundles waiting.',
        },
        {
          glyph: <ConveyorDotGlyph />,
          label: 'Bundle on conveyor',
          hint: 'Yellow dots travelling along dashed lines = WIP moving between operations.',
        },
        {
          glyph: <CardGlyph color={SW_COLORS.muted} />,
          label: 'Service block',
          hint: 'Dimmed footprint = a workstation that carries no sewing operation — racks, tables, buffers.',
        },
        {
          glyph: <BottleneckGlyph />,
          label: 'Bottleneck flag',
          hint: 'Pulsing red disc with "!" — flags the slowest operation in the line.',
        },
      ];
    case 'heat':
      return [
        {
          glyph: <HeatGradientGlyph />,
          label: 'Pressure blob',
          hint: 'Radial glow sized by utilisation × queue. Green → orange → red.',
        },
        {
          glyph: <DotGlyph color="#fff" />,
          label: 'Station marker',
          hint: 'White dot at the centre of each blob = the station\'s anchor point.',
        },
        {
          glyph: <DotGlyph color={SW_COLORS.alarm} />,
          label: 'Bottleneck marker',
          hint: 'Red dot replaces white when the station is the slowest operation.',
        },
      ];
    case 'logic':
      return [
        {
          glyph: <CardGlyph color={SW_COLORS.brand} />,
          label: 'Operation block',
          hint: 'Flow card with operation code, SMV, queue, busy/total, throughput.',
        },
        {
          glyph: <ArrowGlyph color={SW_COLORS.ok} />,
          label: 'Healthy connector',
          hint: 'Green arrow — upstream station running under 85% utilisation.',
        },
        {
          glyph: <ArrowGlyph color={SW_COLORS.warn} />,
          label: 'Warming connector',
          hint: 'Orange arrow — upstream station ≥ 85% utilisation.',
        },
        {
          glyph: <ArrowGlyph color={SW_COLORS.alarm} />,
          label: 'Bottleneck connector',
          hint: 'Red arrow — upstream station is the bottleneck with queue building.',
        },
        {
          glyph: <DiamondGlyph />,
          label: 'Bottleneck marker (◆)',
          hint: 'Diamond on a card header = this operation is the slowest in the line.',
        },
      ];
  }
}

/**
 * Wraps a simulation view in a pan/zoom viewport.
 *
 * This is the same canvas the Build floor is: one stage-filling `<svg>` with
 * a **centred, 1:1 viewBox**, a single pan/zoom `<g>` inside it, and
 * `<CanvasGrid>` ruling the plane through the view's own projection. Sim
 * views render as bare `<g>` fragments in world coordinates — no view sizes
 * a `viewBox` to its own content any more.
 *
 * That last point is the whole change. A content-sized viewBox is a
 * *container*: it letterboxes the diagram into a fixed box in the middle of
 * the canvas, scales it to fit rather than to the camera, and gives the view
 * a bottom edge to hang titles and legends off. Everything the user drew
 * lived inside that box instead of on the floor. Now the floor is the only
 * surface: elements sit at world coordinates, the grid runs past them in
 * every direction, and zoom is the camera rather than a fit factor.
 *
 * The grid comes from the projection, so ISO rules the same diamond lattice
 * as Builder's ISO 3D floor and the plan views rule the same square one as
 * Builder's 2D — no canvas paints its own private ruling.
 *
 * The camera is owned by the page and keyed by view, so switching ISO → TOP
 * → ISO returns you to the framing you left — the same rule the Build floor
 * and PROCESS canvas follow.
 */
function PanZoomViewport({
  cam,
  onCam,
  projection,
  children,
}: {
  cam: Cam;
  onCam: (update: (c: Cam) => Cam) => void;
  /** Rules the grid and fixes the world units. ISO for the 3D floor, FLAT
   *  for the plan-space views. */
  projection: Projection;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<SVGGElement | null>(null);
  const camRef = useRef(cam);
  camRef.current = cam;

  /** Live stage size in CSS px. The viewBox is `[-w/2, -h/2, w, h]`, so one
   *  user-space unit is one stage pixel and (0,0) is the element centre —
   *  the geometry `useCanvasCamera`'s `origin: 'center'` and
   *  `visibleCellRange` both assume. */
  const [stageSize, setStageSize] = useState({ w: 1200, h: 700 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setStageSize({ w: r.width, h: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * World-space extent of whatever the active view actually drew, or null
   * while it has drawn nothing.
   *
   * Measured off the DOM rather than derived per view: each view lays itself
   * out differently (iso cells, plan pixels, card grids), and asking the
   * group what it rendered is both exact and immune to a view changing its
   * layout later. `getBBox` throws in some engines on a detached node, hence
   * the guard.
   */
  const measureContent = useCallback((): CamBounds | null => {
    const g = contentRef.current;
    if (!g) return null;
    let box: DOMRect;
    try {
      box = g.getBBox();
    } catch {
      return null;
    }
    if (box.width <= 0 || box.height <= 0) return null;
    return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };
  }, []);

  /** ⛶ / ⌘0 — frame everything. Measured at click time, so it always
   *  reflects the live station count. */
  const fit = useCallback(() => {
    const bounds = measureContent();
    const el = containerRef.current;
    if (!bounds || !el) {
      onCam(() => CAM_IDENTITY);
      return;
    }
    const r = el.getBoundingClientRect();
    onCam(() => fitBounds(bounds, { w: r.width, h: r.height }));
  }, [measureContent, onCam]);

  const api = useCanvasCamera({
    ref: containerRef,
    // Centred viewBox — the camera's zero is the middle of the stage, same
    // as every SVG canvas in Build.
    origin: 'center',
    read: () => camRef.current,
    write: onCam,
    fit,
  });

  /**
   * Frame the content the first time there is any.
   *
   * Views used to arrive pre-fitted for free, because a content-sized
   * viewBox scaled the diagram to the element. On a free canvas nothing
   * scales it, so a 60-station line would open with the camera parked in
   * the middle of it. This runs the same ⛶ the user would have pressed —
   * once, and only while the camera is still untouched. A camera that has
   * been moved (including one restored from another view switch) is the
   * user's framing and is never overridden.
   *
   * No dependency list on purpose: the sim can mount with zero stations and
   * fill in a tick later, so this re-checks each render until there is
   * something to frame, then latches.
   */
  const didAutoFit = useRef(false);
  useEffect(() => {
    if (didAutoFit.current) return;
    const c = camRef.current;
    if (c.x !== 0 || c.y !== 0 || c.z !== 1) {
      didAutoFit.current = true;
      return;
    }
    // An empty measurement means the engine hasn't produced stations yet —
    // stay unlatched and try again next render rather than burning the one
    // auto-fit on a blank canvas.
    if (!measureContent()) return;
    didAutoFit.current = true;
    fit();
  });

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Let buttons / inputs handle their own clicks — only grab empty space.
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, select, textarea, a, [role="button"]')) return;
    api.beginPan(e.clientX, e.clientY);
  };

  const W = Math.max(1, stageSize.w);
  const H = Math.max(1, stageSize.h);

  return (
    <div
      ref={containerRef}
      onMouseDown={startPan}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        cursor: api.panning ? 'grabbing' : 'grab',
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`${-W / 2} ${-H / 2} ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', userSelect: 'none' }}
      >
        {/* Pan/zoom in SVG space, not CSS `transform: scale` on a wrapper —
            the children re-render at the zoomed resolution and stay
            vector-sharp instead of being rasterised at 1x and stretched. */}
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.z})`}>
          {/* The same ruling the Build floor draws, through the same
              component. Pitch and lattice shape come from `projection`, so
              ISO gets Builder's diamond grid with no branch here. */}
          <CanvasGrid projection={projection} cam={cam} stageSize={stageSize} />
          {/* Content lives directly on the plane. No backing rect, no
              content-sized frame — `getBBox()` on this group is what ⛶
              frames. */}
          <g ref={contentRef}>{children}</g>
        </g>
      </svg>

      <ZoomHud zoom={cam.z} onZoomStep={api.zoomStep} onFit={fit} />
    </div>
  );
}

// Glyph primitives — tiny SVGs that mirror what each view actually renders.
function IsoTableGlyph({ color }: { color: string }) {
  return (
    <svg width={32} height={24} viewBox="0 0 32 24">
      <polygon points="6,18 16,22 26,18 16,14" fill={SW_PAL.cream} stroke="#0F1419" strokeWidth={0.5} />
      <polygon points="6,18 16,14 16,8 6,12" fill={SW_PAL.creamLo} stroke="#0F1419" strokeWidth={0.5} />
      <polygon points="26,18 16,14 16,8 26,12" fill={SW_PAL.cream} stroke="#0F1419" strokeWidth={0.5} />
      <polygon points="10,10 16,12.4 22,10 16,7.6" fill={color} stroke="#0F1419" strokeWidth={0.5} />
      <polygon points="10,10 16,7.6 16,3.6 10,6" fill={shade(color, -0.2)} stroke="#0F1419" strokeWidth={0.5} />
      <polygon points="22,10 16,7.6 16,3.6 22,6" fill={color} stroke="#0F1419" strokeWidth={0.5} />
    </svg>
  );
}
function DotGlyph({ color }: { color: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16">
      <circle cx={8} cy={8} r={4.5} fill={color} stroke="#0F1419" strokeWidth={0.8} />
    </svg>
  );
}
/**
 * IsoOperatorBody — standing-figure silhouette for the ISO 3D view.
 *
 * Mirrors the Builder's `operator()` iso drawer (domain/iso.ts) so the worker
 * the user placed in Factory Builder reads as the *same* person once they
 * step onto the simulation floor. Solid colours, no opacity stunts:
 *
 *   pants (legs + belt)   — dark `#1F2630`
 *   shirt (torso + arms)  — brand-bobbin when working, alarm-red when hot,
 *                           muted slate when idle; side-shade is a solid
 *                           darker fill, not a translucent overlay
 *   head                  — `#E8B98A` skin (same hex as Builder)
 *   hair cap              — `#1B1B22` (same as Builder's HAIR)
 *
 * Drawn around origin (0,0) so callers can `<g transform="translate(x,y)">`
 * the whole figure to any screen position. Total footprint ≈ 8×16 px, which
 * lines up with the previous lollipop so layouts (slot offsets, walk anchors)
 * don't need to move.
 */
function IsoOperatorBody({
  working,
  hot = false,
}: {
  working: boolean;
  hot?: boolean;
}) {
  const shirt = working ? (hot ? SW_COLORS.alarm : SW_COLORS.bobbin) : '#3a4250';
  const shirtDark = shade(shirt, -0.3);
  const shirtLite = shade(shirt, 0.18);
  const PANTS = '#1F2630';
  const PANTS_LITE = '#2C3540';
  const SKIN = '#E8B98A';
  const HAIR = '#1B1B22';
  return (
    <g>
      {/* Legs / pants — two stacked rects so feet read separately */}
      <rect x={-2.4} y={-1.5} width={4.8} height={4.4} rx={0.6} fill={PANTS} />
      <rect x={-2.4} y={-1.5} width={1.6} height={4.4} rx={0.6} fill={PANTS_LITE} />
      <rect x={-0.4} y={-1.5} width={0.5} height={4.4} fill={SW_COLORS.ink} />
      {/* Belt — thin contrast band where torso meets legs */}
      <rect x={-2.6} y={-1.9} width={5.2} height={0.8} fill={SW_COLORS.ink} />
      {/* Torso / shirt — main body block */}
      <rect x={-3} y={-7} width={6} height={5.5} rx={0.9} fill={shirt} stroke="#0F1419" strokeWidth={0.5} />
      {/* Solid side-shade on the left face of the torso (not opacity) */}
      <rect x={-3} y={-7} width={1.7} height={5.5} rx={0.9} fill={shirtDark} />
      {/* Collar V */}
      <polygon points="-1.3,-7 1.3,-7 0,-5.3" fill={shirtDark} />
      {/* Pocket — small light patch on the right face of the shirt */}
      <rect x={0.6} y={-4.8} width={1.9} height={2.6} fill={shirtLite} stroke="#0F1419" strokeWidth={0.3} />
      {/* Head (skin) */}
      <circle cx={0} cy={-9.6} r={2.6} fill={SKIN} stroke="#0F1419" strokeWidth={0.5} />
      {/* Hair cap — rounded dome over the head */}
      <path d="M -2.4 -10 Q 0 -12.6 2.4 -10 L 2.4 -8.7 L -2.4 -8.7 Z" fill={HAIR} />
    </g>
  );
}

function OperatorGlyph({ working }: { working: boolean }) {
  // Legend chip — same Builder-style standing figure as the floor worker,
  // just scaled to fit the 20×24 viewBox used by other legend glyphs.
  return (
    <svg width={20} height={24} viewBox="0 0 20 24">
      <ellipse cx={10} cy={21} rx={6} ry={1.8} fill="#0F141955" />
      <g transform="translate(10, 18) scale(1.35)">
        <IsoOperatorBody working={working} />
      </g>
    </svg>
  );
}
function PulseRingGlyph() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24">
      <circle cx={12} cy={12} r={5} fill={SW_COLORS.bobbin} stroke="#fff" strokeWidth={1} />
      <circle cx={12} cy={12} r={9} fill="none" stroke={SW_COLORS.brand} strokeWidth={1.2} opacity={0.7}>
        <animate attributeName="r" values="8;10;8" dur="1.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.7;0.3;0.7" dur="1.2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
function WipStackGlyph() {
  return (
    <svg width={28} height={20} viewBox="0 0 28 20">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (
        <rect
          key={k}
          x={(k % 4) * 6 + 2}
          y={14 - Math.floor(k / 4) * 5}
          width={5}
          height={3.5}
          fill={SW_COLORS.thread}
          opacity={0.9 - k * 0.05}
        />
      ))}
    </svg>
  );
}
function BottleneckGlyph() {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20">
      <circle cx={10} cy={10} r={7} fill={SW_COLORS.alarm}>
        <animate attributeName="r" values="6;8;6" dur="0.9s" repeatCount="indefinite" />
      </circle>
      <text x={10} y={13.5} textAnchor="middle" fontFamily={SW_FONTS.display} fontSize={11} fontWeight={900} fill="#fff">
        !
      </text>
    </svg>
  );
}
function CardGlyph({ color }: { color: string }) {
  return (
    <svg width={30} height={22} viewBox="0 0 30 22">
      <rect x={2} y={3} width={26} height={16} rx={3} fill={`${color}25`} stroke={color} strokeWidth={1.2} />
      <rect x={2} y={3} width={26} height={4} rx={3} fill={color} />
    </svg>
  );
}
function ConveyorDotGlyph() {
  return (
    <svg width={32} height={16} viewBox="0 0 32 16">
      <line x1={2} y1={8} x2={30} y2={8} stroke="#ffffff40" strokeWidth={1.5} strokeDasharray="3 2" />
      <circle cx={8} cy={8} r={2.5} fill={SW_COLORS.thread} />
      <circle cx={18} cy={8} r={2.5} fill={SW_COLORS.thread} opacity={0.8} />
      <circle cx={26} cy={8} r={2.5} fill={SW_COLORS.thread} opacity={0.6} />
    </svg>
  );
}
function UtilBarGlyph() {
  return (
    <svg width={32} height={14} viewBox="0 0 32 14">
      <rect x={2} y={5} width={28} height={4} fill="#ffffff20" />
      <rect x={2} y={5} width={18} height={4} fill={SW_COLORS.ok} />
      <text x={2} y={13} fontFamily={SW_FONTS.mono} fontSize={6} fill="#ffffff90" fontWeight={700}>
        2/3
      </text>
    </svg>
  );
}
function HeatGradientGlyph() {
  return (
    <svg width={34} height={18} viewBox="0 0 34 18">
      <defs>
        <linearGradient id="sim-legend-heat" x1="0%" x2="100%">
          <stop offset="0%" stopColor={SW_COLORS.ok} />
          <stop offset="55%" stopColor={SW_COLORS.warn} />
          <stop offset="100%" stopColor={SW_COLORS.alarm} />
        </linearGradient>
      </defs>
      <rect x={1} y={4} width={32} height={10} rx={5} fill="url(#sim-legend-heat)" />
    </svg>
  );
}
function ArrowGlyph({ color }: { color: string }) {
  return (
    <svg width={30} height={14} viewBox="0 0 30 14">
      <line x1={2} y1={7} x2={22} y2={7} stroke={color} strokeWidth={2.2} />
      <polygon points="22,3 28,7 22,11" fill={color} />
    </svg>
  );
}
function DiamondGlyph() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18">
      <circle cx={9} cy={9} r={7.5} fill="#ffffff22" />
      <text x={9} y={12.5} textAnchor="middle" fontFamily={SW_FONTS.display} fontSize={12} fontWeight={900} fill="#fff">
        ◆
      </text>
    </svg>
  );
}

// ============================================================================
// LAYOUT — where every element on the Run floor sits
// ============================================================================
//
// ONE COORDINATE SYSTEM, EVERY VIEW.
//
// A station's position is `ws.position`, in world cells, authored on the
// Build floor. That is the only position it has, and every canvas in the app
// now draws it there — Build 2D, Build ISO, Run ISO, Run TOP, Run HEAT — with
// nothing between the authored number and the projection but
// `projection.project(x, y)`.
//
// It did not use to be. Each Run view re-mapped the same coordinates its own
// way:
//
//   ISO   rebased every cell to `2 + (gx - minX)` and then translated the
//         whole floor by half its own bounding box, so a machine authored at
//         cell 40 drew at cell 2.
//   TOP   normalised the floor into a 1200 x 600 box — a *non-uniform* scale
//         that stretched x and y by different factors, so the plan was not
//         even the same shape as the ISO floor beside it.
//   HEAT  did the same with a different padding, so it was not the same shape
//         as TOP either.
//   LOGIC did it a third time, into a box whose size depended on the station
//         count.
//
// Four views, four mappings, none of them Builder's — and all four drawn on
// top of `<CanvasGrid>`, which rules numbered axes. The ruler said one thing
// and the content another, in four different ways.
//
// Footprints had the same problem. Builder sizes a sprite from the fixture
// catalogue (`wsBaseFootprint`), so an SNLS covers 1 x 2 cells and a spread
// table covers 6 x 2. The Run floor hard-coded 0.9 x 1.4 for every station
// and ignored rotation, so machines that abutted in BUILD floated apart in
// RUN and a 6-cell table shrank to one. Cells now carry the workstation's
// real extent, straight off the same helper Builder draws from.
//
// The camera is what frames content — `PanZoomViewport` auto-fits on first
// paint and ⛶ / ⌘0 re-frames on demand. That is why no view needs to move
// content to the middle of the stage any more, and why none of them may:
// re-centring is precisely what made the coordinates a lie.

interface StationLayout {
  s: StationView;
  /** Top-left of the footprint, in world cells — `ws.position`, verbatim. */
  gx: number;
  gy: number;
  /** EFFECTIVE (post-rotation) footprint in cells. Anything that centres on,
   *  outlines or hit-tests the station uses this. */
  w: number;
  d: number;
  /** UNROTATED catalogue extent + the rotation itself. A fixture's `draw()`
   *  wants these, because it turns its own geometry on the build plane via
   *  `isoProjR` rather than spinning in screen space — same call Builder's
   *  `WorkstationSprite` makes. */
  base: { w: number; d: number; h: number };
  rotation: number;
  /** Catalogue id, so the Run floor can draw the very sprite Builder drew.
   *  Absent on synthetic cells, which have no authored workstation. */
  catalogId?: string;
  /** Stable per-cell React key. Falls back to opId when one cell per op; in
   *  workstation mode multiple cells share an opId so we key by wsId. */
  cellKey?: string;
  /** Sewing-line membership when the cell came from a Builder-authored
   *  workstation. Used by the SimIsoView/SimTopView chaining logic to avoid
   *  drawing a stray conveyor between the last cell of Line A and the first
   *  cell of Line B in multi-line scope. */
  lineId?: string;
}

/** A non-simulated Builder workstation rendered as ambient floor context so
 *  the simulation view reads as a full factory — spreaders, cutters, QC
 *  tables, presses, fabric racks, buffers — not just the sewing line. */
interface AmbientLayout {
  wsId: string;
  catalogId: string;
  name: string;
  gx: number;
  gy: number;
  /** Effective (post-rotation) footprint; `base` is what `draw()` takes. */
  w: number;
  d: number;
  base: { w: number; d: number; h: number };
  rotation: number;
  /** Department accent colour (from DEPT_COLOR_HEX), used as a faint tint so
   *  the dept zones read at a glance. */
  deptColor: string;
  /** Asset family — 'sew' / 'cut' / 'fix' / 'store' / 'mh' / 'buf' / 'op' / … */
  cat: string;
  lineId?: string;
}

/** Caller-side shape for ambient workstations passed into layoutStations.
 *  Straight off the twin: authored cell, catalogue extent, rotation. */
interface AmbientWorkstationInput {
  wsId: string;
  catalogId: string;
  name: string;
  gx: number;
  gy: number;
  /** Unrotated catalogue extent, `size` override included. */
  w: number;
  d: number;
  h: number;
  rotation: number;
  deptColor: string;
  cat: string;
  lineId?: string;
}

/** Swap w/d for a station stood at 90° or 270°, exactly as `wsFootprint`
 *  does for the Build floor. */
function turnedFootprint(
  base: { w: number; d: number },
  rotation: number,
): { w: number; d: number } {
  return rotation === 90 || rotation === 270
    ? { w: base.d, d: base.w }
    : { w: base.w, d: base.d };
}

/**
 * Cells for a run with no authored floor behind it — an empty placeholder, a
 * demo twin, an older save. A wrapping row of generic 1 x 2 machines on whole
 * cells starting at the origin, so it lands on the same lattice an authored
 * floor does and every view agrees on it.
 *
 * There used to be one of these per view, in three different unit systems
 * (cells here, plan pixels in TOP and HEAT), which is why an unauthored run
 * looked like a different factory in every tab.
 */
const FALLBACK_COL_STEP = 3; // cells between machines along a row
const FALLBACK_ROW_STEP = 5; // cells between rows
const FALLBACK_PER_ROW = 8;
const FALLBACK_FOOTPRINT = { w: 1, d: 2, h: 1.4 };

function fallbackCell(i: number): { gx: number; gy: number } {
  return {
    gx: (i % FALLBACK_PER_ROW) * FALLBACK_COL_STEP,
    gy: Math.floor(i / FALLBACK_PER_ROW) * FALLBACK_ROW_STEP,
  };
}

/**
 * The floor, in world cells. Shared by ISO, TOP and HEAT so all three draw
 * the same factory — one geometry, three projections of it, which is the
 * same relationship Builder's 2D and ISO floors already have.
 */
interface FloorLayout {
  cells: StationLayout[];
  ambientCells: AmbientLayout[];
}

function layoutStations(
  stations: StationView[],
  twinMeta?: BuildFromTwinMeta | null,
  ambientWorkstations?: AmbientWorkstationInput[],
): FloorLayout {
  const ambientCells: AmbientLayout[] = (ambientWorkstations ?? []).map((aw) => ({
    wsId: aw.wsId,
    catalogId: aw.catalogId,
    name: aw.name,
    gx: aw.gx,
    gy: aw.gy,
    ...turnedFootprint(aw, aw.rotation),
    base: { w: aw.w, d: aw.d, h: aw.h },
    rotation: aw.rotation,
    deptColor: aw.deptColor,
    cat: aw.cat,
    lineId: aw.lineId,
  }));

  const n = stations.length;
  if (n === 0) return { cells: [], ambientCells };

  // Twin workstation path — honour every physical machine the user placed in
  // Factory Builder. One cell per workstation; cells that share an opId all
  // read the same engine StationView (parallel servers in the queueing model),
  // so the floor reads like the actual factory while the live state remains
  // op-level. Preferred over the op-averaged path below whenever the meta
  // carries a workstations array.
  if (twinMeta && twinMeta.workstations && twinMeta.workstations.length > 0) {
    const stationByOpId = new Map<string, StationView>();
    for (const s of stations) stationByOpId.set(s.opId, s);
    const placed = twinMeta.workstations.filter((wc) => stationByOpId.has(wc.opId));
    if (placed.length > 0) {
      const cells: StationLayout[] = placed.map((wc) => ({
        s: stationByOpId.get(wc.opId)!,
        gx: wc.gx,
        gy: wc.gy,
        ...turnedFootprint(wc, wc.rotation),
        base: { w: wc.w, d: wc.d, h: wc.h },
        rotation: wc.rotation,
        catalogId: wc.catalogId,
        cellKey: wc.wsId,
        lineId: wc.lineId,
      }));
      return { cells, ambientCells };
    }
  }

  // Twin op-averaged fallback — used when the meta only carries `stations`
  // (e.g. older builds or empty placeholders). Each engine station maps back
  // to its workstations' mean grid position, so views still read like a
  // top-down of the floor, just with one box per op instead of per machine.
  if (twinMeta) {
    const byOpId = new Map<string, { gx: number; gy: number }>();
    for (const ts of twinMeta.stations) byOpId.set(ts.opId, { gx: ts.gx, gy: ts.gy });
    if (stations.some((s) => byOpId.has(s.opId))) {
      const cells: StationLayout[] = stations.map((s, i) => {
        const p = byOpId.get(s.opId) ?? fallbackCell(i);
        return {
          s,
          gx: p.gx,
          gy: p.gy,
          w: FALLBACK_FOOTPRINT.w,
          d: FALLBACK_FOOTPRINT.d,
          base: FALLBACK_FOOTPRINT,
          rotation: 0,
        };
      });
      return { cells, ambientCells };
    }
  }

  // Nothing authored at all — the synthetic row.
  //
  // There used to be four layouts here, chosen by the line's production
  // system: a U-shaped cell for `modular` so operators faced each other, a
  // tight 2-column cluster for `make_through` so the scene read as one
  // workbench, spaced clusters for `clump`, and a grid for everything else.
  // Production systems are out of scope, so the one layout that served the
  // majority is the one that stays.
  const cells: StationLayout[] = stations.map((s, i) => ({
    s,
    ...fallbackCell(i),
    w: FALLBACK_FOOTPRINT.w,
    d: FALLBACK_FOOTPRINT.d,
    base: FALLBACK_FOOTPRINT,
    rotation: 0,
  }));
  return { cells, ambientCells };
}

// ============================================================================
// ISO 3D VIEW
// ============================================================================

interface SimViewProps {
  stations: StationView[];
  bottleneckOpIndex: number;
  simTime: number;
  /**
   * The floor, laid out ONCE at page level and handed to every view.
   *
   * Each view used to call its own layout — which is how four views ended up
   * with four different mappings of the same authored coordinates. Passing
   * the finished cells in makes "the same machine is in the same place in
   * every view" a structural fact rather than a convention four functions
   * have to keep agreeing on.
   */
  floor: FloorLayout;
  /** opId of the station whose detail drawer is open (highlights it). */
  selectedOpId?: string | null;
  /** Click a station to open its sim-vs-theory drawer. Omit for read-only views. */
  onSelectStation?: (opId: string) => void;
  /** Live bundles from the recorded flow stream at the current playback minute,
   *  keyed to stations by wsId. Empty when the run hasn't recorded flow. */
  bundles?: BundleFrame[];
}

function SimIsoView({ stations, bottleneckOpIndex, simTime, floor, selectedOpId, onSelectStation, bundles = [] }: SimViewProps) {
  if (stations.length === 0) return <g />;

  const { cells, ambientCells } = floor;
  // Workstation mode = more cells than engine stations. The synthetic conveyor
  // and travelling-WIP markers chain consecutive cells, which is meaningful
  // when cells are placed in op order along a row but degenerates into noise
  // when cells reflect arbitrary Builder positions across 60+ machines.
  const oneCellPerOp = cells.length === stations.length;
  // Bottleneck highlight needs to follow the opId, not a cell index — in
  // workstation mode multiple cells share an op and the index would point at
  // the wrong row.
  const bottleneckOpId = stations[bottleneckOpIndex]?.opId ?? null;

  // No group transform. Cells are already at their authored world cells, and
  // `PanZoomViewport` frames them with the camera — see the LAYOUT note. The
  // floor used to be shifted by half its own bounding box to park it under
  // the identity camera, which is what made cell 40 draw at cell 2.
  return (
    <g>
      {/* Ambient service blocks — non-sewing workstations (spreaders, cutters,
          QC tables, presses, fabric racks, buffers, operators) authored in
          Builder. Drawn behind the engine stations as muted iso cuboids so
          the floor reads as a full factory, not just a sewing line. They
          don't carry live state — they're scene context. */}
      {[...ambientCells]
        .sort((a, b) => a.gx + a.gy - (b.gx + b.gy))
        .map((a) => (
          <IsoAmbientBlock key={`amb-${a.wsId}`} amb={a} />
        ))}

      {/* Conveyor between rows of stations — only meaningful when cells are
          laid out in op order along a row. In workstation mode the cells
          reflect arbitrary Builder positions, so chaining them with a dashed
          line just produces visual noise. Multi-line mode: skip segments that
          cross a lineId boundary (otherwise we'd draw a stray conveyor from
          Line A's last station to Line B's first station). */}
      {oneCellPerOp && cells.length > 1 &&
        cells.slice(0, -1).map((c, i) => {
          const next = cells[i + 1];
          // Same-line guard — if either cell carries a lineId, both must match
          // before we draw the connecting conveyor.
          if (c.lineId && next.lineId && c.lineId !== next.lineId) return null;
          const a = isoProj(c.gx + c.w / 2, c.gy + c.d + 0.2);
          const b = isoProj(next.gx + next.w / 2, next.gy + next.d + 0.2);
          return (
            <line
              key={`conv-${i}`}
              x1={a.sx}
              y1={a.sy}
              x2={b.sx}
              y2={b.sy}
              stroke="#ffffff30"
              strokeWidth={2.4}
              strokeDasharray="6 4"
              style={{ animation: 'sim-march 0.8s linear infinite' }}
            />
          );
        })}

      {/* Stations — depth-sorted */}
      {[...cells]
        .sort((a, b) => a.gx + a.gy - (b.gx + b.gy))
        .map((c, i) => (
          <g
            key={c.cellKey ?? `${c.s.opId}-${i}`}
            onClick={onSelectStation ? (e) => { e.stopPropagation(); onSelectStation(c.s.opId); } : undefined}
            style={onSelectStation ? { cursor: 'pointer' } : undefined}
          >
            <IsoSewingStation
              layout={c}
              index={i}
              isHot={c.s.opId === bottleneckOpId && c.s.queueLen > 0}
              isSelected={c.s.opId === selectedOpId}
              simTime={simTime}
            />
            {/* Blocked-after-service marker — this station finished a bundle it
                can't hand off because the downstream buffer is full. The
                expanding ring is the sonar ping from the design language: a
                constraint should catch the eye from across the floor while
                the run is playing, without moving the marker itself. */}
            {c.s.blocked > 0 && (() => {
              const bp = isoProj(c.gx + c.w / 2, c.gy + c.d / 2, c.base.h + 0.2);
              return (
                <g pointerEvents="none">
                  <circle
                    cx={bp.sx}
                    cy={bp.sy}
                    r={8}
                    fill="none"
                    stroke={SW_COLORS.alarm}
                    strokeWidth={1.5}
                    style={{ animation: 'sim-ping 1.6s ease-out infinite', transformBox: 'fill-box', transformOrigin: 'center' }}
                  />
                  <circle cx={bp.sx} cy={bp.sy} r={8} fill="#0F1419CC" stroke={SW_COLORS.alarm} strokeWidth={2} />
                  <text x={bp.sx} y={bp.sy + 3.5} textAnchor="middle" fontSize={10} fontWeight={800} fill={SW_COLORS.alarm}>!</text>
                </g>
              );
            })()}
          </g>
        ))}

      {/* Real WIP bundles from the recorded entity-flow stream — each is
          anchored to its ACTUAL station and coloured by state: waiting in the
          input buffer (fabric), in service (thread), or blocked-after-service
          on the output side (alarm). Replaces the old synthetic simTime-phased
          motion, and works in any layout because each bundle joins to its
          station by wsId. Sprites are keyed by agentId so React reuses them
          frame-to-frame as they move between stations. */}
      {bundles.length > 0 && (() => {
        const cellByWsId = new Map(cells.map((c) => [c.cellKey, c] as const));
        // Cap sprites per (station, state) group — the numeric queue badge on
        // the station already carries the exact count; this just keeps a deep
        // queue legible instead of spilling across the floor.
        const MAX_PER_GROUP = 8;
        return bundles.map((bnd) => {
          const cell = cellByWsId.get(bnd.wsId);
          if (!cell || bnd.rank >= MAX_PER_GROUP) return null;
          const cx = cell.gx + cell.w / 2;
          const cy = cell.gy + cell.d / 2;
          let wx = cx;
          const wy = cy;
          let z = 0.35;
          let fill: string = SW_COLORS.fabric;
          if (bnd.state === 'waiting') {
            // Conga line into the front (−x) of the station.
            wx = cx - 0.5 - bnd.rank * 0.28;
          } else if (bnd.state === 'service') {
            wx = cx;
            z = 0.6;
            fill = SW_COLORS.thread;
          } else {
            // blocked — piled on the output side (+x), can't advance.
            wx = cx + 0.5 + bnd.rank * 0.28;
            fill = SW_COLORS.alarm;
          }
          const p = isoProj(wx, wy, z);
          return (
            <g key={`bnd-${bnd.agentId}`} pointerEvents="none">
              <ellipse cx={p.sx} cy={p.sy + 4} rx={5} ry={1.6} fill="#0F141944" />
              <rect
                x={p.sx - 4}
                y={p.sy - 4}
                width={8}
                height={8}
                fill={fill}
                stroke="#0F1419"
                strokeWidth={0.6}
                opacity={0.92}
              />
              <line
                x1={p.sx - 3}
                y1={p.sy - 4}
                x2={p.sx + 3}
                y2={p.sy - 4}
                stroke="#0F1419"
                strokeWidth={0.5}
                opacity={0.7}
              />
            </g>
          );
        });
      })()}

      {/* Fallback: when the run recorded no flow (e.g. a factory whose process
          graph isn't wired with connectors, so the DES can't route), fall back
          to the legacy synthetic conveyor motion so the floor still reads as
          active. Real bundles above take over the moment the twin actually
          flows. */}
      {bundles.length === 0 && oneCellPerOp && cells.length > 1 &&
        cells.slice(0, -1).flatMap((c, i) => {
          const next = cells[i + 1];
          if (c.lineId && next.lineId && c.lineId !== next.lineId) return [];
          const colors = [SW_COLORS.thread, SW_COLORS.fabric, SW_COLORS.bobbin, SW_COLORS.trim];
          const qLen = next.s?.queueLen ?? 0;
          const count = Math.max(1, Math.min(4, 1 + Math.floor(qLen / 3)));
          return Array.from({ length: count }, (_, k) => {
            const offset = k / count;
            const phase = ((simTime * 0.06 + i * 0.27 + offset) % 1 + 1) % 1;
            const x = c.gx + c.w / 2 + (next.gx + next.w / 2 - (c.gx + c.w / 2)) * phase;
            const y = c.gy + c.d / 2 + (next.gy + next.d / 2 - (c.gy + c.d / 2)) * phase;
            const p = isoProj(x, y, 0.3);
            return (
              <g key={`wip-${i}-${k}`} pointerEvents="none">
                <ellipse cx={p.sx} cy={p.sy + 4} rx={5} ry={1.6} fill="#0F141944" />
                <rect
                  x={p.sx - 4}
                  y={p.sy - 4}
                  width={8}
                  height={8}
                  fill={colors[(i + k) % colors.length]}
                  stroke="#0F1419"
                  strokeWidth={0.6}
                  opacity={0.92}
                />
                <line x1={p.sx - 3} y1={p.sy - 4} x2={p.sx + 3} y2={p.sy - 4} stroke="#0F1419" strokeWidth={0.5} opacity={0.7} />
              </g>
            );
          });
        })}

    </g>
  );
}

function IsoSewingStation({
  layout,
  index,
  isHot,
  isSelected,
  simTime,
}: {
  layout: StationLayout;
  index: number;
  isHot: boolean;
  isSelected?: boolean;
  simTime: number;
}) {
  const { s, gx, gy, w, d, base, rotation, catalogId } = layout;
  const origin = isoProj(gx, gy);
  // Altitudes for the decorations that float above the machine. Derived from
  // the fixture's own height rather than the old hard-coded 1.4 / 1.45 / 1.7
  // / 2.6, so a 4.5-cell-tall fabric rack doesn't wear its badge inside its
  // own geometry.
  const topZ = base.h;
  const occupancy = s.serversTotal > 0 ? s.busy / s.serversTotal : 0;
  // Workstation visual identity is sourced from the global asset library
  // (MACHINE_CATALOG) keyed off the operation's machineCode. SNL → brand,
  // 4OL → bobbin, FL → flatlock steel, BT → yellow, BH → green, etc.
  // The icon never changes with live state; bottleneck/load are surfaced
  // separately via the badge above, the base alarm ring, and the
  // utilization pip.
  const asset = stationAsset(s.machineCode);

  return (
    <g transform={`translate(${origin.sx}, ${origin.sy})`}>
      {/* Alarm ring around the base — only visible when this station is
          the bottleneck, so the icon itself doesn't need to change colour. */}
      {isHot && (() => {
        const c = isoProj(w / 2, d / 2, 0.02);
        const o = isoProj(0, 0, 0);
        const rx = (w + 0.8) * 16;
        const ry = (d + 0.8) * 8;
        return (
          <ellipse
            cx={c.sx - o.sx}
            cy={c.sy - o.sy}
            rx={rx}
            ry={ry}
            fill="none"
            stroke={SW_COLORS.alarm}
            strokeWidth={2}
            opacity={0.85}
            pointerEvents="none"
          >
            <animate attributeName="opacity" values="0.85;0.35;0.85" dur="0.9s" repeatCount="indefinite" />
          </ellipse>
        );
      })()}
      {/* Selection ring — drawn when this station's detail drawer is open. */}
      {isSelected && (() => {
        const c = isoProj(w / 2, d / 2, 0.02);
        const o = isoProj(0, 0, 0);
        const rx = (w + 1.1) * 16;
        const ry = (d + 1.1) * 8;
        return (
          <ellipse
            cx={c.sx - o.sx}
            cy={c.sy - o.sy}
            rx={rx}
            ry={ry}
            fill={`${SW_COLORS.brand}18`}
            stroke={SW_COLORS.brand}
            strokeWidth={2.5}
            pointerEvents="none"
          />
        );
      })()}
      {/* Station body — drawn by the shared fixture catalog so the Sim floor
          and the Builder floor cannot drift apart. Falls back to a plain
          table when the machine code resolves to no fixture. Total height
          matches the old hand-rolled table + head (0.8 + 0.6 = 1.4), so
          nothing above it relayouts. */}
      <g>
        {(() => {
          // The workstation's OWN fixture first — same `lookupFixture` +
          // `draw({ base, r })` call Builder's `WorkstationSprite` makes, so
          // the machine on the Run floor is the machine on the Build floor,
          // at the same size and standing the same way round. Machine-code
          // lookup is the fallback for synthetic cells, which have no
          // authored workstation behind them.
          const fixture =
            (catalogId ? lookupFixture(catalogId) : undefined) ??
            isoFixtureForMachineCode(s.machineCode ?? '') ??
            undefined;
          return (
            fixture?.draw({ w: base.w, d: base.d, h: base.h, r: rotation }) ??
            CuboidFaces({ w, d, h: 0.8, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream })
          );
        })()}
      </g>
      {/* Utilization pip on the machine head — small status light, doesn't
          recolour the equipment. Reads green / yellow / red against an
          otherwise-static silhouette. */}
      {(() => {
        const a = isoProj(w * 0.78, d * 0.35, topZ + 0.05);
        const o = isoProj(0, 0, 0);
        const pipCol = isHot
          ? SW_COLORS.alarm
          : occupancy > 0.7
            ? SW_COLORS.warn
            : SW_COLORS.ok;
        return (
          <circle
            cx={a.sx - o.sx}
            cy={a.sy - o.sy}
            r={2.4}
            fill={pipCol}
            stroke="#0F1419"
            strokeWidth={0.5}
          />
        );
      })()}
      {/* Op label badge floating above.
          The box is sized to its contents rather than fixed at 84px. It used
          to hold a 4-character op code, which always fit; a station with no
          code carries its NAME here instead, and a fixed box either clipped
          it or ran it straight through the machine tag on its right. */}
      {(() => {
        const p = isoProj(w / 2, d / 2, topZ + 0.3);
        const nameText = stationLabel(s, 18);
        const machineText = asset.known ? `${asset.glyph} ${asset.label}` : '';
        // IBM Plex Mono advances 0.6em per glyph; the +0.05em letter-spacing
        // on both runs is folded in. The pictographic machine glyph is the
        // one non-monospaced character, so it is budgeted as two.
        const runW = (text: string, px: number) => text.length * px * 0.65;
        const inner =
          runW(nameText, 10)
          + (machineText ? runW(machineText, 9) + 9 + 12 : 0);
        const bw = Math.max(84, Math.ceil(inner) + 20);
        return (
          <g transform={`translate(${p.sx}, ${p.sy})`} pointerEvents="none">
            <rect x={-bw / 2} y={-32} width={bw} height={30} rx={4} fill="#0a0d12" stroke="#ffffff20" strokeWidth={1} />
            <text
              x={-bw / 2 + 10}
              y={-21}
              fontFamily={SW_FONTS.mono}
              fontSize={10}
              fontWeight={900}
              fill="#fff"
              letterSpacing="0.05em"
            >
              {nameText}
            </text>
            {machineText && (
              <text
                x={bw / 2 - 10}
                y={-21}
                textAnchor="end"
                fontFamily={SW_FONTS.mono}
                fontSize={9}
                fontWeight={800}
                fill={SW_COLORS.muted}
                letterSpacing="0.05em"
              >
                {machineText}
              </text>
            )}
            <text
              x={0}
              y={-7}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={8}
              fontWeight={700}
              fill={isHot ? SW_COLORS.alarm : '#ffffffaa'}
            >
              Q={s.queueLen} · {s.busy}/{s.serversTotal}
            </text>
          </g>
        );
      })()}

      {/* Walking operators in front of the table. Each worker runs a short
          fetch-and-return loop: they walk from a rest position behind the
          station to the machine head, dwell while their stitch cycle runs,
          then walk back to swap bundles. Animation phase is per-worker so
          a 3-server station reads as three independent crew members rather
          than a synchronised chorus. Idle workers (k >= busy) stand still
          at the rest position; busy ones move. */}
      {Array.from({ length: Math.min(s.serversTotal, 3) }).map((_, k) => {
        const headCount = Math.min(s.serversTotal, 3);
        const slot = (k - (headCount - 1) / 2) * 0.45;
        const isWorking = k < s.busy;
        // Per-worker walk cycle — 6-second period. Phase ∈ [0,1):
        //   0.0 → 0.4   walk OUT  (rest position → machine head)
        //   0.4 → 0.6   dwell AT  (sewing)
        //   0.6 → 1.0   walk BACK (machine head → rest position)
        // Bottleneck stations cycle faster (operator under pressure).
        const period = isHot ? 4 : 6;
        const t = ((simTime + k * 1.7 + index * 0.9) % period) / period;
        let walkPhase: number;
        if (t < 0.4) walkPhase = t / 0.4;                   // 0 → 1 (walk out)
        else if (t < 0.6) walkPhase = 1;                    // dwell at machine
        else walkPhase = 1 - (t - 0.6) / 0.4;               // 1 → 0 (walk back)
        // Rest position sits BEHIND the station footprint; work position is
        // a hair in front of the machine head. Idle workers stand at rest.
        const restOy = d + 0.6;
        const workOy = d * 0.55;
        const oy = isWorking
          ? restOy + (workOy - restOy) * walkPhase
          : restOy;
        const ox = w / 2 + slot;
        // Subtle vertical bob while actually working (at the machine, dwelling).
        const bob = isWorking && walkPhase > 0.95
          ? Math.sin(simTime * 6 + k) * 0.05
          : 0;
        const p = isoProj(ox, oy + bob, 0);
        // Walking workers gait — alternate left/right step accent on their
        // shadow so the eye reads them as moving, not sliding.
        const stride = isWorking && walkPhase > 0 && walkPhase < 1
          ? Math.sin(simTime * 8 + k * 1.3) * 1.4
          : 0;
        return (
          <g key={k} transform={`translate(${p.sx}, ${p.sy})`}>
            {/* Stretched shadow during the walk; tight when standing still. */}
            <ellipse
              cx={stride}
              cy={3}
              rx={Math.abs(stride) > 0.2 ? 7 : 6}
              ry={2.4}
              fill="#0F141944"
            />
            {/* Carried bundle — small fabric square the worker brings to the
                machine on the way out and returns empty-handed. Only visible
                during the OUTBOUND half of the walk cycle. */}
            {isWorking && walkPhase > 0 && walkPhase < 0.95 && (
              <rect
                x={-3}
                y={-2}
                width={6}
                height={4}
                fill={SW_COLORS.thread}
                stroke="#0F1419"
                strokeWidth={0.4}
                opacity={0.95}
                transform={`translate(${stride * 0.3}, 0)`}
              />
            )}
            {/* Standing-figure body — matches the Builder's iso operator
                fixture so the worker the user placed on the floor in Factory
                Builder reads as the same person once they step into the sim. */}
            <IsoOperatorBody working={isWorking} hot={isHot} />
            {/* Working aura — visible only during the dwell-at-machine phase. */}
            {isWorking && walkPhase > 0.9 && (
              <circle
                cx={0}
                cy={-4}
                r={8 + Math.sin(simTime * 2 + index + k) * 1.4}
                fill="none"
                stroke={isHot ? SW_COLORS.alarm : SW_COLORS.brand}
                strokeWidth={0.8}
                opacity={0.45}
              />
            )}
          </g>
        );
      })}

      {/* WIP queue — small stacked rects on the inbound side */}
      {(() => {
        const visible = Math.min(s.queueLen, 12);
        const p = isoProj(-0.6, d * 0.5, 0.85);
        return (
          <g transform={`translate(${p.sx}, ${p.sy})`}>
            {Array.from({ length: visible }).map((_, k) => (
              <rect
                key={k}
                x={(k % 4) * 5 - 10}
                y={Math.floor(k / 4) * -4}
                width={4}
                height={3}
                fill={SW_COLORS.thread}
                opacity={0.85 - k * 0.04}
              />
            ))}
            {s.queueLen > 12 && (
              <text x={12} y={-2} fill={SW_COLORS.thread} fontFamily={SW_FONTS.mono} fontSize={9} fontWeight={800}>
                +{s.queueLen - 12}
              </text>
            )}
          </g>
        );
      })()}

      {/* Bottleneck flag */}
      {isHot && (() => {
        const p = isoProj(w / 2, d / 2, topZ + 1.2);
        return (
          <g transform={`translate(${p.sx}, ${p.sy})`} pointerEvents="none">
            <circle r={7} fill={SW_COLORS.alarm}>
              <animate attributeName="r" values="7;10;7" dur="0.8s" repeatCount="indefinite" />
            </circle>
            <text x={0} y={3} textAnchor="middle" fontFamily={SW_FONTS.display} fontSize={10} fontWeight={900} fill="#fff">
              !
            </text>
          </g>
        );
      })()}
    </g>
  );
}

/**
 * Iso-projected ambient service block — a non-sewing workstation drawn as
 * scene context behind the engine stations. Colour comes from the asset
 * family (`cat`) so a fabric rack reads differently from a press table
 * which reads differently from an inspect bench. Static — no live state.
 */
function IsoAmbientBlock({ amb }: { amb: AmbientLayout }) {
  const origin = isoProj(amb.gx, amb.gy);

  // Asset-family palette — keeps service blocks visually grouped on the
  // floor while staying distinct from the brand-coloured sewing line.
  // One neutral surface for every ambient prop. Category is spelled out in
  // the badge below; it does not also need a colour. Twelve tinted cuboids
  // scattered across the floor competed with the sim's own state colours —
  // the only thing on this canvas that should catch the eye is a station in
  // trouble.
  const palette: Record<string, { top: string; left: string; right: string; label: string }> = {
    cut:   { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'CUT'   },
    fix:   { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'FIX'   },
    store: { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'STORE' },
    mh:    { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'MH'    },
    buf:   { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'BUF'   },
    conv:  { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'CONV'  },
    zone:  { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'ZONE'  },
    arch:  { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'ARCH'  },
    util:  { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'UTIL'  },
    pml:   { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'PML'   },
    sew:   { top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, label: 'SEW'   },
  };
  const pal = palette[amb.cat] ?? palette.fix;

  // Buffers and mat-handling carts sit at floor level — short height so
  // they don't overpower the engine stations.
  const h = Math.max(0.2, Math.min(amb.base.h, 1.6));

  return (
    <g transform={`translate(${origin.sx}, ${origin.sy})`} opacity={0.78} pointerEvents="none">
      {/* Shadow under the block — sells the height. */}
      {(() => {
        const c = isoProj(amb.w / 2, amb.d / 2, 0);
        const o = isoProj(0, 0, 0);
        return (
          <ellipse
            cx={c.sx - o.sx}
            cy={c.sy - o.sy + 3}
            rx={amb.w * 14}
            ry={amb.d * 6}
            fill="#0F141955"
          />
        );
      })()}
      {/* Body — short cuboid in the asset-family palette. */}
      {CuboidFaces({
        w: amb.w,
        d: amb.d,
        h,
        top: pal.top,
        left: pal.left,
        right: pal.right,
      })}
      {/* Small category-tag pip on top — a 6×6 brand-coloured square that
          encodes the block role so the user can scan the floor and tell
          a rack from a cart from a press. */}
      {(() => {
        const p = isoProj(amb.w / 2, amb.d / 2, h + 0.15);
        return (
          <g transform={`translate(${p.sx}, ${p.sy})`}>
            <rect x={-12} y={-9} width={24} height={10} rx={2} fill={alpha(SW_COLORS.void, 0.8)} stroke={alpha(SW_COLORS.ink, 0.25)} strokeWidth={0.8} />
            <text
              x={0}
              y={-2}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={6}
              fontWeight={900}
              fill={SW_COLORS.muted}
              letterSpacing="0.1em"
            >
              {pal.label}
            </text>
          </g>
        );
      })()}
    </g>
  );
}

// ============================================================================
// TOP 2D VIEW
// ============================================================================

/**
 * The plan projection of the ISO floor.
 *
 * Same cells, same footprints, same authored coordinates — the only
 * difference between this and `SimIsoView` is `flatProj` in place of
 * `isoProj`, which is exactly the relationship Builder's 2D and ISO floors
 * have to each other.
 *
 * It used to be a different factory. It laid out one card per *operation*
 * (not per machine) at the mean position of that op's machines, normalised
 * into a 1200 x 600 box under a non-uniform scale, in a fixed 72 x 100 card
 * that had nothing to do with the machine's footprint. So a 3-machine
 * operation was three boxes in ISO and one card here, at a spot no machine
 * stood on, at a spacing that was not the floor's.
 *
 * Live state now hangs off the footprint rather than replacing it: the box is
 * the machine, a fill bar inside it is utilisation, the inbound queue stacks
 * on the −x side (where it stacks in ISO), and the op badge floats above.
 */
function SimTopView({ stations, bottleneckOpIndex, simTime, floor, selectedOpId, onSelectStation }: SimViewProps) {
  if (stations.length === 0) return <g />;

  const { cells, ambientCells } = floor;
  // Same rule as ISO: chaining consecutive cells with a conveyor only means
  // something when there is one cell per operation.
  const oneCellPerOp = cells.length === stations.length;
  const bottleneckOpId = stations[bottleneckOpIndex]?.opId ?? null;

  /** Centre of a cell's footprint, in world px. */
  const centreOf = (c: { gx: number; gy: number; w: number; d: number }) =>
    flatProj(c.gx + c.w / 2, c.gy + c.d / 2);

  return (
    <g>
      {/* Ambient service blocks — the rest of the factory, as footprints.
          ISO has drawn these for a while; the plan view showed none of them,
          so the same floor had a different set of things on it depending on
          which tab you were in. */}
      {ambientCells.map((a) => {
        const o = flatProj(a.gx, a.gy);
        const mark = stationMark(a.catalogId);
        return (
          <g key={`amb-${a.wsId}`} transform={`translate(${o.sx}, ${o.sy})`} opacity={0.5} pointerEvents="none">
            <StationGlyph
              {...mark}
              label={mark.code || mark.markCode ? undefined : a.name}
              width={a.w * FLAT_CELL}
              height={a.d * FLAT_CELL}
              muted={a.cat === 'zone'}
            />
          </g>
        );
      })}

      {/* Conveyor between consecutive stations + marching WIP dots. Skips
          segments that cross a lineId boundary, same guard as ISO. */}
      {oneCellPerOp && cells.length > 1 &&
        cells.slice(0, -1).map((c, i) => {
          const next = cells[i + 1];
          if (c.lineId && next.lineId && c.lineId !== next.lineId) return null;
          const a = centreOf(c);
          const b = centreOf(next);
          return (
            <g key={`flow-${i}`} pointerEvents="none">
              <line
                x1={a.sx}
                y1={a.sy}
                x2={b.sx}
                y2={b.sy}
                stroke="#ffffff25"
                strokeWidth={3}
                strokeDasharray="6 6"
                style={{ animation: 'sim-march 1s linear infinite' }}
              />
              {Array.from({ length: 3 }).map((_, k) => {
                const phase = ((simTime * 0.03 + k / 3 + i * 0.13) % 1 + 1) % 1;
                return (
                  <circle
                    key={k}
                    cx={a.sx + (b.sx - a.sx) * phase}
                    cy={a.sy + (b.sy - a.sy) * phase}
                    r={4}
                    fill={SW_COLORS.thread}
                    opacity={0.85}
                  />
                );
              })}
            </g>
          );
        })}

      {/* Stations — the footprint IS the sprite. */}
      {cells.map((c, i) => {
        const { s } = c;
        const o = flatProj(c.gx, c.gy);
        const W = c.w * FLAT_CELL;
        const H = c.d * FLAT_CELL;
        const isHot = s.opId === bottleneckOpId && s.queueLen > 0;
        const isSelected = s.opId === selectedOpId;
        const occupancy = s.serversTotal > 0 ? s.busy / s.serversTotal : 0;
        const mark = c.catalogId ? stationMark(c.catalogId) : { code: s.machineCode as MachineCode };
        return (
          <g
            key={c.cellKey ?? `${s.opId}-${i}`}
            transform={`translate(${o.sx}, ${o.sy})`}
            onClick={onSelectStation ? (e) => { e.stopPropagation(); onSelectStation(s.opId); } : undefined}
            style={onSelectStation ? { cursor: 'pointer' } : undefined}
          >
            {/* The machine, drawn with the same glyph the Build floor uses.
                Fixtures with no mark to draw (PML blocks, racks) fall back to
                a label, exactly as Builder's `FlatStationBody` does. */}
            <StationGlyph
              {...mark}
              label={mark.code || mark.markCode ? undefined : stationLabel(s)}
              width={W}
              height={H}
            />

            {/* Utilisation — a fill rising from the foot of the footprint, so
                load reads as a level inside the machine rather than as a
                separate widget parked next to it. */}
            <rect
              x={0}
              y={H * (1 - occupancy)}
              width={W}
              height={H * occupancy}
              fill={isHot ? alpha(SW_COLORS.alarm, 0.28) : alpha(SW_COLORS.ok, 0.22)}
              pointerEvents="none"
            />

            {(isHot || isSelected) && (
              <rect
                x={-2}
                y={-2}
                width={W + 4}
                height={H + 4}
                fill="none"
                stroke={isHot ? SW_COLORS.alarm : SW_COLORS.brand}
                strokeWidth={2.5}
                pointerEvents="none"
              />
            )}

            {/* Inbound queue — stacked on the −x side, the side it stacks on
                in ISO, so the two views agree on where work waits. */}
            {s.queueLen > 0 && (
              <g transform={`translate(${-6}, ${H / 2})`} pointerEvents="none">
                {Array.from({ length: Math.min(s.queueLen, 12) }).map((_, k) => (
                  <rect
                    key={k}
                    x={-6 - Math.floor(k / 4) * 7}
                    y={(k % 4) * 5 - 10}
                    width={5}
                    height={4}
                    fill={SW_COLORS.thread}
                    opacity={0.9 - k * 0.04}
                  />
                ))}
                {s.queueLen > 12 && (
                  <text x={-30} y={16} textAnchor="end" fill={SW_COLORS.thread} fontFamily={SW_FONTS.mono} fontSize={9} fontWeight={800}>
                    +{s.queueLen - 12}
                  </text>
                )}
              </g>
            )}

            {/* Op badge — same content and same anchor as the ISO badge:
                above the footprint, centred on it. */}
            <g transform={`translate(${W / 2}, ${-6})`} pointerEvents="none">
              <text
                x={0}
                y={-12}
                textAnchor="middle"
                fill={isHot ? SW_COLORS.alarm : '#ffffffcc'}
                fontFamily={SW_FONTS.mono}
                fontSize={10}
                fontWeight={900}
                letterSpacing="0.05em"
              >
                {stationLabel(s)}
              </text>
              <text
                x={0}
                y={-2}
                textAnchor="middle"
                fill="#ffffff80"
                fontFamily={SW_FONTS.mono}
                fontSize={8}
                fontWeight={700}
              >
                Q={s.queueLen} · {s.busy}/{s.serversTotal}
              </text>
            </g>

            {isHot && (
              <g transform={`translate(${W + 8}, ${-8})`} pointerEvents="none">
                <circle r={6} fill={SW_COLORS.alarm}>
                  <animate attributeName="r" values="6;9;6" dur="0.8s" repeatCount="indefinite" />
                </circle>
                <text y={3.5} textAnchor="middle" fill="#fff" fontFamily={SW_FONTS.display} fontSize={9} fontWeight={900}>
                  !
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ============================================================================
// HEAT VIEW
// ============================================================================

/**
 * Pressure, painted on the floor plan.
 *
 * Same cells and same coordinates as ISO and TOP — the blobs sit on the
 * machines they describe, so "the heat is over there" points at a place on
 * the floor the user can walk to. It used to normalise the floor into its own
 * 1200 x 600 box with a *different* padding from TOP's, so the same factory
 * was a different shape in the two plan views standing next to each other.
 *
 * Blob radius is in cells rather than pixels for the same reason: `HEAT_R`
 * cells of bleed is a claim about the floor, and it holds at any zoom.
 */
const HEAT_BLOB_CELLS = 3;

function SimHeatView({ stations, bottleneckOpIndex, floor }: SimViewProps) {
  if (stations.length === 0) return <g />;

  const { cells } = floor;
  const bottleneckOpId = stations[bottleneckOpIndex]?.opId ?? null;

  return (
    <g>
      <defs>
        {cells.map((c, i) => {
          const s = c.s;
          const isHot = s.opId === bottleneckOpId && s.queueLen > 0;
          const intensity = isHot
            ? 1
            : Math.min(1, 0.2 + (s.serversTotal > 0 ? s.busy / s.serversTotal : 0) * 0.7 + Math.min(0.5, s.queueLen / 10));
          const col = isHot ? SW_COLORS.alarm : intensity > 0.7 ? SW_COLORS.warn : SW_COLORS.ok;
          return (
            <radialGradient key={`hg-${i}`} id={`sim-heat-${c.cellKey ?? s.opId}-${i}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={col} stopOpacity={intensity} />
              <stop offset="100%" stopColor={col} stopOpacity={0} />
            </radialGradient>
          );
        })}
      </defs>

      {/* Heat blobs, centred on each machine's footprint. */}
      {cells.map((c, i) => {
        const p = flatProj(c.gx + c.w / 2, c.gy + c.d / 2);
        return (
          <circle
            key={`blob-${i}`}
            cx={p.sx}
            cy={p.sy}
            r={HEAT_BLOB_CELLS * FLAT_CELL}
            fill={`url(#sim-heat-${c.cellKey ?? c.s.opId}-${i})`}
            style={{ mixBlendMode: 'screen' }}
          />
        );
      })}

      {/* Station markers + label */}
      {cells.map((c, i) => {
        const s = c.s;
        const isHot = s.opId === bottleneckOpId && s.queueLen > 0;
        const p = flatProj(c.gx + c.w / 2, c.gy + c.d / 2);
        return (
          <g key={`mk-${i}`} transform={`translate(${p.sx}, ${p.sy})`}>
            <circle r={5} fill={isHot ? SW_COLORS.alarm : '#fff'} opacity={0.9} />
            <text
              y={-14}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={800}
              fill={isHot ? SW_COLORS.alarm : '#ffffffcc'}
              letterSpacing="0.05em"
            >
              {stationLabel(s)}
            </text>
            <text y={20} textAnchor="middle" fontFamily={SW_FONTS.mono} fontSize={8} fill="#ffffff80">
              Q={s.queueLen} · {s.busy}/{s.serversTotal}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ============================================================================
// LOGIC VIEW — block-flow / schema diagram (AnyLogic-style)
// ============================================================================
//
// Each operation becomes a flow card with its OP code, SMV, queue length,
// busy/total servers, and live throughput. Cards are connected in routing
// order with marching arrows, so the user can see WHERE in the logical flow
// the bottleneck sits.
//
// THE ONE VIEW THAT IS NOT THE FLOOR. Its x/y are routing order, not floor
// position, and it says so — a card carrying seven labelled numbers is six
// cells wide, and cannot stand on the 1 x 2 cell its machine occupies without
// burying the four cards around it.
//
// What it must not do is *pretend*. It used to stretch the authored floor
// coordinates into a box sized by the card grid, under yet a third scale
// factor, which put the cards neither in flow order nor at their machines'
// positions. Now the layout is honestly ordinal — but it is still ruled by
// the same lattice as every other canvas: every pad, card and gap below is a
// whole number of `FLAT_CELL`s, and the grid starts at the world origin, so
// the axis ticks under a card are as readable here as anywhere else.

function SimLogicView({ stations, bottleneckOpIndex, simTime }: SimViewProps) {
  if (stations.length === 0) return <g />;

  // Cards carry an explicit label for every number; flow connectors are
  // bright and thick so the routing reads at a glance. Every dimension is a
  // multiple of FLAT_CELL (40) so card corners land on ruled lines.
  const CARD_W = 6 * FLAT_CELL;  // 240
  const CARD_H = 5 * FLAT_CELL;  // 200
  // Even margin all round. The old asymmetric pads reserved room for a title
  // strip at the top and a legend strip at the bottom; both belonged to the
  // fixed viewBox and both are gone.
  const PAD_X = FLAT_CELL;
  const PAD_TOP = FLAT_CELL;
  const PAD_BOTTOM = FLAT_CELL;
  const ROW_GAP = 2 * FLAT_CELL;
  const COL_GAP = 2 * FLAT_CELL;

  // Pick the cols count whose block shape comes closest to a landscape
  // sheet. This used to chase the container's live aspect ratio, because a
  // fitted viewBox letterboxed hard on a wide canvas; on a free canvas there
  // is nothing to letterbox against, so the schema keeps one stable shape
  // and the user pans and zooms to it rather than having it reflow under
  // the window.
  const targetRatio = 16 / 9;
  let cols = Math.min(stations.length, 4);
  let bestDiff = Infinity;
  for (let c = 1; c <= stations.length; c++) {
    const r = Math.ceil(stations.length / c);
    const wCand = PAD_X * 2 + c * CARD_W + (c - 1) * COL_GAP;
    const hCand = PAD_TOP + r * CARD_H + (r - 1) * ROW_GAP + PAD_BOTTOM;
    const diff = Math.abs(wCand / hCand - targetRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      cols = c;
    }
  }
  // Serpentine, so the last card of a row sits directly above the first card
  // of the next and the wrap connector stays short.
  const positions = stations.map((_, i) => {
    const row = Math.floor(i / cols);
    const rawCol = i % cols;
    const col = row % 2 === 0 ? rawCol : cols - 1 - rawCol;
    return {
      x: PAD_X + col * (CARD_W + COL_GAP),
      y: PAD_TOP + row * (CARD_H + ROW_GAP),
      col,
      row,
    };
  });

  const totalBusyTime = simTime > 0 ? simTime : 1;
  const stationsThroughput = stations.map((s) => {
    if (totalBusyTime <= 0) return 0;
    return Math.round((s.produced / totalBusyTime) * 60);
  });

  // Connector colour follows the upstream station's utilization tier so the
  // routing line itself communicates pressure: green = healthy flow, orange
  // = warming, red = bottleneck. Brighter than the previous translucent
  // dashed stroke so the path stays legible on the dark grid.
  function connectorColor(i: number): string {
    const s = stations[i];
    if (!s) return '#ffffff80';
    if (i === bottleneckOpIndex && s.queueLen > 0) return SW_COLORS.alarm;
    const occ = s.serversTotal > 0 ? s.busy / s.serversTotal : 0;
    if (occ >= 0.85) return SW_COLORS.warn;
    return SW_COLORS.ok;
  }

  return (
    <g>
      <defs>
        <marker
          id="sim-logic-arrow-ok"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={SW_COLORS.ok} />
        </marker>
        <marker
          id="sim-logic-arrow-warn"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={SW_COLORS.warn} />
        </marker>
        <marker
          id="sim-logic-arrow-alarm"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={SW_COLORS.alarm} />
        </marker>
      </defs>
      {/* Flow connectors — colour-coded by the upstream station's pressure. */}
      {stations.map((_, i) => {
        if (i === stations.length - 1) return null;
        const a = positions[i];
        const b = positions[i + 1];
        const sx = a.x + CARD_W;
        const sy = a.y + CARD_H / 2;
        const ex = b.x;
        const ey = b.y + CARD_H / 2;
        const col = connectorColor(i);
        const markerKey = col === SW_COLORS.alarm ? 'alarm' : col === SW_COLORS.warn ? 'warn' : 'ok';
        let path: string;
        if (a.row === b.row) {
          // Same-row hop — direct horizontal segment.
          path = `M ${sx} ${sy} L ${ex - 6} ${ey}`;
        } else {
          // Row wrap — snake-routed through the gap so the line returns to
          // the opposite end of the canvas without crossing cards.
          const midY = (a.y + CARD_H + b.y) / 2;
          const exitX = a.col === cols - 1 || b.col < a.col ? sx + 20 : sx + 20;
          const entryX = b.col === 0 || b.x < a.x ? b.x - 20 : b.x - 20;
          path = `M ${sx} ${sy} L ${exitX} ${sy} L ${exitX} ${midY} L ${entryX} ${midY} L ${entryX} ${ey} L ${ex - 6} ${ey}`;
        }
        return (
          <path
            key={`flow-${i}`}
            d={path}
            fill="none"
            stroke={col}
            strokeWidth={3}
            strokeOpacity={0.85}
            strokeDasharray="8 5"
            markerEnd={`url(#sim-logic-arrow-${markerKey})`}
            style={{ animation: 'sim-march 0.9s linear infinite' }}
            pointerEvents="none"
          />
        );
      })}

      {/* Operation cards — each metric carries its own label. */}
      {stations.map((s, i) => {
        const p = positions[i];
        const isHot = i === bottleneckOpIndex && s.queueLen > 0;
        const occupancy = s.serversTotal > 0 ? s.busy / s.serversTotal : 0;
        const utilCol = isHot ? SW_COLORS.alarm : occupancy >= 0.85 ? SW_COLORS.warn : SW_COLORS.ok;
        // The card is neutral steel; machine type is spelled out in the card
        // body rather than encoded as a colour. Bottleneck state gets the red
        // outline + alarm pip below — the only thing here worth a colour.
        const cardAsset = stationAsset(s.machineCode);
        const accent = SW_COLORS.steel;
        const pcsHr = stationsThroughput[i];
        const queueOver = s.queueLen > 8;

        return (
          <g key={`${s.opId}-${i}`} transform={`translate(${p.x}, ${p.y})`}>
            <rect
              x={0}
              y={0}
              width={CARD_W}
              height={CARD_H}
              rx={8}
              fill="#0a0d12"
              stroke={isHot ? SW_COLORS.alarm : accent}
              strokeWidth={isHot ? 3 : 1.5}
            />
            {/* Header strip — machine-type colour. */}
            <rect x={0} y={0} width={CARD_W} height={32} rx={8} fill={accent} />
            <rect x={0} y={24} width={CARD_W} height={8} fill={accent} />
            <text
              x={14}
              y={21}
              fontFamily={SW_FONTS.display}
              fontSize={13}
              fontWeight={900}
              fill="#fff"
              letterSpacing="0.08em"
            >
              {stationLabel(s)}
            </text>
            {/* Machine-type tag on the right of the header strip — single
                glyph + short name pulled from the asset library so the
                card always announces the equipment that runs this op.
                Omitted when the block has no machine behind it (a Service
                authored out of the BLOCKS palette), rather than printing a
                placeholder where the equipment would go. */}
            {cardAsset.known && (
            <text
              x={CARD_W - 14}
              y={21}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={11}
              fontWeight={900}
              fill="#fff"
              letterSpacing="0.1em"
            >
              {cardAsset.glyph} {cardAsset.label}
            </text>
            )}

            {/* Op name + SMV. The name is skipped when the header strip is
                already showing it — that happens on a station with no op
                code, where `stationLabel` falls back to the same string and
                the card would otherwise print it twice, one line apart. */}
            {s.opCode && (
              <text
                x={CARD_W / 2}
                y={52}
                textAnchor="middle"
                fontFamily={SW_FONTS.body}
                fontSize={12}
                fontWeight={700}
                fill="#fff"
              >
                {s.opName.length > 30 ? s.opName.slice(0, 28) + '…' : s.opName}
              </text>
            )}
            <text
              x={CARD_W / 2}
              y={66}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={10}
              fontWeight={700}
              fill="#ffffff80"
              letterSpacing="0.05em"
            >
              SMV {s.smv.toFixed(2)} min
            </text>

            {/* Throughput hero. Inline label sits underneath so the meaning
                of the big number is unmistakable. */}
            <text
              x={CARD_W / 2}
              y={92}
              textAnchor="middle"
              fontFamily={SW_FONTS.display}
              fontSize={32}
              fontWeight={900}
              fill={SW_COLORS.brand}
              letterSpacing="-0.02em"
            >
              {pcsHr}
            </text>
            <text
              x={CARD_W / 2}
              y={107}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={800}
              fill="#ffffff80"
              letterSpacing="0.15em"
            >
              THROUGHPUT (PCS/HR)
            </text>

            {/* Util bar with explicit "UTIL" label on the left and the % on
                the right so it doesn't read as a mystery percentage. */}
            <text
              x={14}
              y={130}
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={800}
              fill="#ffffff90"
              letterSpacing="0.1em"
            >
              UTIL
            </text>
            <text
              x={CARD_W - 14}
              y={130}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={11}
              fontWeight={800}
              fill={utilCol}
            >
              {Math.round(occupancy * 100)}%
            </text>
            <rect x={14} y={136} width={CARD_W - 28} height={6} rx={3} fill="#ffffff15" />
            <rect
              x={14}
              y={136}
              width={Math.max(0, (CARD_W - 28) * occupancy)}
              height={6}
              rx={3}
              fill={utilCol}
            />

            {/* Bottom metric tiles — Queue & Busy/Servers, each with a label. */}
            <g transform={`translate(14, ${CARD_H - 50})`}>
              <rect width={(CARD_W - 38) / 2} height={36} rx={4} fill="#ffffff08" />
              <text
                x={10}
                y={14}
                fontFamily={SW_FONTS.mono}
                fontSize={8}
                fontWeight={800}
                fill="#ffffff80"
                letterSpacing="0.1em"
              >
                QUEUE
              </text>
              <text
                x={10}
                y={29}
                fontFamily={SW_FONTS.mono}
                fontSize={14}
                fontWeight={900}
                fill={queueOver ? SW_COLORS.alarm : '#fff'}
              >
                {s.queueLen}
              </text>
              <text
                x={(CARD_W - 38) / 2 - 10}
                y={29}
                textAnchor="end"
                fontFamily={SW_FONTS.mono}
                fontSize={9}
                fontWeight={700}
                fill="#ffffff70"
              >
                pcs
              </text>
            </g>
            <g transform={`translate(${14 + (CARD_W - 38) / 2 + 10}, ${CARD_H - 50})`}>
              <rect width={(CARD_W - 38) / 2} height={36} rx={4} fill="#ffffff08" />
              <text
                x={10}
                y={14}
                fontFamily={SW_FONTS.mono}
                fontSize={8}
                fontWeight={800}
                fill="#ffffff80"
                letterSpacing="0.1em"
              >
                BUSY / SERVERS
              </text>
              <text
                x={10}
                y={29}
                fontFamily={SW_FONTS.mono}
                fontSize={14}
                fontWeight={900}
                fill="#fff"
              >
                {s.busy}/{s.serversTotal}
              </text>
            </g>

            {/* Bottleneck flag — diamond on the header strip's right side. */}
            {isHot && (
              <g transform={`translate(${CARD_W - 18}, 16)`} pointerEvents="none">
                <circle r={9} fill="#fff" opacity={0.18}>
                  <animate attributeName="r" values="9;14;9" dur="0.9s" repeatCount="indefinite" />
                </circle>
                <text
                  textAnchor="middle"
                  y={5}
                  fontFamily={SW_FONTS.display}
                  fontSize={13}
                  fontWeight={900}
                  fill="#fff"
                >
                  ◆
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* The in-canvas legend strip is gone: it was pinned to the bottom
          edge of the old fixed viewBox, and a free canvas has no bottom
          edge. The floating `<SimLegend view="logic">` overlay already
          keys every connector colour and the ◆ bottleneck marker. */}
    </g>
  );
}

// ============================================================================
// SEWING LINES SCOPE — line pills in the top bar
// ============================================================================

/**
 * The engine's scope picker: an "ALL LINES" pill plus one pill per sewing
 * line in the active twin. Selecting a pill writes `?scope=<...>` to the URL;
 * LiveSim re-reads that on the next render to rebuild the engine scope.
 *
 * This was a full-width strip of three-line cards sitting between the header
 * and the canvas — 78px of chrome to hold a radio group. Every card repeated
 * production system, garment, workstation count and a seed rate that nobody
 * reads while a run is playing; the one thing you look at is which line is
 * lit. So the pills came up into the header beside TIME SETUP (the other
 * control that says what the run IS), and the numbers moved into the
 * tooltips, where they are one hover away instead of one row down.
 *
 * The rail scrolls horizontally rather than wrapping: the header must stay
 * one line tall no matter how many lines the twin has.
 */
function SewingLinesScope({
  lineBuilds,
  scope,
  activeTwin,
  onPickScope,
}: {
  lineBuilds: LineBuild[];
  scope: SimScope;
  activeTwin: ReturnType<typeof selectActiveTwin>;
  onPickScope: (next: SimScope) => void;
}) {
  const factoryActive = scope.kind === 'factory';
  const selectedLineId = scope.kind === 'line' ? scope.id : null;
  // Departments are no longer a user-facing concept: a sewing floor has LINES,
  // and every twin now carries exactly one auto-managed "Sewing Floor" that the
  // Builder creates and grows on its own. The scope rail is therefore
  // ALL LINES + one pill per line, with no department tier in between.
  //
  // `Department` stays in the schema and `deptId` stays on every entity, so
  // saved .swproj files and IndexedDB twins keep loading untouched — this is a
  // UI removal, not a migration.

  /** Shared pill shell. `accent` lights the border + wash when selected. */
  const pill = (active: boolean, accent: string): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flex: 'none',
    height: 28,
    padding: '0 10px',
    borderRadius: 999,
    border: `1px solid ${active ? accent : '#ffffff20'}`,
    background: active ? `${accent}26` : 'transparent',
    color: '#fff',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  const nameStyle: CSSProperties = {
    fontFamily: SW_FONTS.display,
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: '0.1em',
  };
  const metaStyle: CSSProperties = {
    fontFamily: SW_FONTS.mono,
    fontSize: 10,
    color: '#ffffff99',
  };

  return (
    <div
      role="radiogroup"
      aria-label="Simulation scope"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Claims the space the old spacer held, and shrinks before any of the
        // fixed controls do — the rail scrolls, the buttons never squash.
        flex: '1 1 0',
        minWidth: 0,
        overflowX: 'auto',
        paddingBottom: 2,
      }}
    >
      <span
        style={{
          flex: 'none',
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.18em',
          color: SW_COLORS.brand,
        }}
      >
        LINES
      </span>

      <button
        type="button"
        role="radio"
        aria-checked={factoryActive}
        onClick={() => onPickScope({ kind: 'factory' })}
        title={`Simulate every wired sewing line in the twin — ${activeTwin.workstations.length} workstations, one engine per line, transport bar drives them together`}
        style={pill(factoryActive, SW_COLORS.brand)}
      >
        <span style={nameStyle}>ALL LINES</span>
        <span style={metaStyle}>{activeTwin.workstations.length} ws</span>
      </button>

      {lineBuilds.map(({ line, build, ok, reason }) => {
        const active = selectedLineId === line.id;
        const memberCount = activeTwin.workstations.filter((w) => w.lineId === line.id).length;
        const ops = build.config.operations.length;
        // Seed rate in pieces/hr, read off the line's actual Source block —
        // which is what the engine runs on.
        //
        // This used to be `SimConfig.arrivalRatePerHour × bundleSize`, and
        // SimConfig is documentation-only now: nothing feeds it to the engine
        // (see simulation/index.ts). On the starter line that reported 94
        // pcs/hr while the Source was emitting 73, so the headline number on
        // the sim screen described a model that wasn't running.
        const seedPiecesPerHr = (() => {
          if (!ok || ops === 0) return 0;
          const src = activeTwin.workstations.find(
            (w) => w.lineId === line.id && getBlockKind(w) === 'Source',
          );
          if (!src) return 0;
          const p = getBlockParams(src);
          return Math.round(p.sourceRatePerHr * Math.max(1, p.piecesPerAgent));
        })();
        const accent = DEPT_LINE_COLORS[line.color] ?? SW_COLORS.brand;
        return (
          <button
            key={line.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPickScope({ kind: 'line', id: line.id })}
            // Everything the old card printed on its three lines, one hover
            // away. Nothing was dropped — it just stopped costing a row.
            title={
              ok
                ? [
                    line.name,
                    ...(line.garmentId ? [line.garmentId] : []),
                    `${ops} operations on ${memberCount} workstation${memberCount === 1 ? '' : 's'}`,
                    `seed ${seedPiecesPerHr.toLocaleString()} pcs/hr`,
                  ].join('\n')
                : `${line.name} — not runnable yet: ${reason ?? 'no simulatable workstation'}.\nDrop machines + assign opIds to wire this line.`
            }
            style={{ ...pill(active, accent), opacity: ok ? 1 : 0.6 }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                flex: 'none',
                borderRadius: '50%',
                background: accent,
              }}
            />
            <span style={nameStyle}>{line.name}</span>
            {ok ? (
              <span style={metaStyle}>{memberCount} ws</span>
            ) : (
              <span style={{ ...metaStyle, color: SW_COLORS.warn, fontWeight: 800 }}>EMPTY</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Department-colour palette mirrored from Builder so each line pill's dot
 *  matches the canvas band. Hard-coded here (rather than imported from
 *  Builder.tsx) to keep this file's import surface narrow. */
const DEPT_LINE_COLORS: Record<string, string> = {
  fabric: '#d4a574',
  thread: '#d97757',
  brand:  '#bf5d2e',
  red:    '#c04437',
  blue:   '#4a73b8',
  yellow: '#d8b13a',
  green:  '#6d9658',
  cream:  '#c2b59b',
};




/**
 * Collapsible strip of live curves inside the sim HUD.
 *
 * Dark-surface framing rather than the light `Card` the Reports grid uses, so
 * it sits on the floor view without fighting it. The charts themselves are the
 * same components Reports mounts — they take plain arrays and don't care
 * whether the series came from a completed replication set or a run that is
 * still playing.
 */
function SimChartRail({
  history,
  stations,
}: {
  history: SimState['history'];
  stations: SimState['stations'];
}) {
  const [open, setOpen] = useState(false);

  // Nothing to draw before the clock has moved. Say so rather than rendering an
  // empty frame that reads like a broken chart.
  const ready = history.length >= 2;

  return (
    <div style={{ marginTop: 12, order: 3 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...SW_TYPE.micro,
          width: '100%',
          textAlign: 'left',
          padding: '5px 8px',
          borderRadius: SW_RADIUS.sm,
          border: `1px solid ${alpha(SW_COLORS.ink, 0.14)}`,
          background: alpha(SW_COLORS.ink, 0.05),
          color: alpha(SW_COLORS.ink, 0.8),
          cursor: 'pointer',
          fontFamily: SW_FONTS.mono,
        }}
        title="Live curves for this run"
      >
        <Chevron open={open} color={alpha(SW_COLORS.ink, 0.8)} style={{ marginRight: 6, verticalAlign: '-3px' }} />
        CURVES {ready ? '' : '· press play'}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ready ? (
            <>
              <MiniChartFrame label="CUMULATIVE OUTPUT">
                <CumulativeOutputChart history={history} />
              </MiniChartFrame>
              <MiniChartFrame label="THROUGHPUT / HR">
                <ThroughputChart history={history} />
              </MiniChartFrame>
              <MiniChartFrame label="WIP">
                <WipChart
                  history={history}
                  meanWip={history.reduce((s, h) => s + h.wip, 0) / history.length}
                />
              </MiniChartFrame>
              <MiniChartFrame label="STATION UTILISATION">
                <UtilizationBarChart stations={stations.map((s) => ({ ...s, lineName: '' }))} />
              </MiniChartFrame>
            </>
          ) : (
            <div style={{ ...SW_TYPE.caption, color: alpha(SW_COLORS.ink, 0.4) }}>
              Curves draw as the shift plays — hit ▶ PLAY, or ⏭ +1h to jump ahead.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniChartFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: alpha(SW_COLORS.ink, 0.04),
        border: `1px solid ${alpha(SW_COLORS.ink, 0.12)}`,
        borderRadius: SW_RADIUS.sm,
        padding: 8,
      }}
    >
      <div
        style={{
          ...SW_TYPE.overline,
          color: alpha(SW_COLORS.ink, 0.53),
          marginBottom: 4,
          fontFamily: SW_FONTS.mono,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
