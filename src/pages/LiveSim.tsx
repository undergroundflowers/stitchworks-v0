/**
 * Live Simulation — drives the discrete-event engine in real time, with three
 * synchronised views over the same engine state:
 *
 *   • ISO 3D — isometric line with cuboid sewing-machine sprites, walking
 *     operators, queue stacks, conveyor + WIP dots, bottleneck flag.
 *   • TOP 2D — flat blueprint with the operation flow + per-station card.
 *   • HEAT  — radial-gradient heat blobs sized by queue + utilisation.
 *
 * The engine is unchanged: SimEngine ticks against (garment, operators,
 * efficiency); the views are pure visualisations of `SimState.stations`.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import {
  CumulativeOutputChart,
  ThroughputChart,
  UtilizationBarChart,
  WipChart,
} from '../components/charts';
import { Button, ToggleGroup, HudSelect, TimeDisplay, ViewTitle, EmptyState, type HudSelectOption } from '../components';
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
  EMPTY_TWIN,
  buildFlowPlayback,
  type BuildFromTwinMeta,
  type SimState,
  type LineBuild,
  type StationView,
  type PmlLineInput,
  type BundleFrame,
} from '../simulation';
import {
  fmtModelTime,
  fmtModelCompact,
  fmtCalendar,
  fmtCalendarCompact,
  fmtWallClock,
  simDayNumber,
  shiftProgressPct,
  unitToSeconds,
  fmtMinutesAsHHMM,
  parseHHMM,
} from '../simulation/timeUnit';
import { useProject, useGarments, type OrderDraft } from '../store';
import { isoProj, ptsToStr, CuboidFaces, SW_PAL, shade, PRODUCTION_SYSTEMS, MACHINE_CATALOG, ISO_FIXTURE_CATALOG, type MachineCode, type ProductionSystem } from '../domain';
import { useTwin, selectActiveTwin } from '../store/twin';
import { runPmlOnTwin, type RunReport } from '../simulation/pml-runner';
import { getBlockSpec, getBlockKind, getBlockParams, apparelRoleFor } from '../domain/pml';
import {
  type DepartmentColorKey,
  type ProductionSystemKey,
  type Twin,
  type Workstation,
} from '../domain/twin';
import {
  buildSeededDraftTwin,
  buildSimReadyOrderTwin,
  mapToLineSystem,
} from '../lib/build-draft-twin';
import { REFERENCE_MODELS, REFERENCE_MODELS_BY_SLUG, type ReferenceModel } from '../domain/reference-models';
import { buildGarmentTwin } from '../domain/reference-twin';
import type { GarmentTemplate } from '../domain/garments';
import { useReferenceContext } from '../store/reference';

/**
 * Resolve a station's canonical visual asset from `MACHINE_CATALOG`. This
 * is the single source of truth for what each workstation should *look*
 * like — colour and glyph come from the machine type, never from live
 * state. ISO, TOP and LOGIC views all funnel through this helper so an
 * SNL bobbin looks the same everywhere it appears.
 */
function stationAsset(machineCode: string | undefined): {
  color: string;
  glyph: string;
  label: string;
  isManual: boolean;
} {
  const spec = machineCode
    ? MACHINE_CATALOG[machineCode as MachineCode]
    : undefined;
  if (!spec) {
    // Unknown machine type — neutral steel placeholder. Keeps the
    // workstation visually distinguishable from typed peers.
    return { color: SW_PAL.steel, glyph: '?', label: machineCode ?? 'UNKNOWN', isManual: false };
  }
  return {
    color: spec.color,
    glyph: spec.icon,
    label: spec.shortName,
    isManual: !!spec.isManual,
  };
}

/** Total operator pool count for a (paper, variant/scenario) selection.
 *  Falls back to the baseline op count if the chosen variant key is unknown. */
function variantOperatorCount(model: ReferenceModel, key: string): number {
  if (key === 'baseline') return model.baseline.operators;
  if (key === 'proposed') return model.proposed?.operators ?? model.baseline.operators;
  const scenario = model.scenarios?.find((s) => s.id === key);
  return scenario?.operators ?? model.baseline.operators;
}

type SimView = 'iso' | 'top' | 'heat' | 'logic' | 'pml';

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

/**
 * Mutate every Source block in a twin to use `bundleSize` as its
 * `piecesPerAgent`, rescaling `sourceRatePerHr` so the *piece* throughput
 * stays constant — what the legacy engine did when the user picked a
 * non-default BUNDLE in the HUD.
 *
 * Returns a shallow-cloned Twin (and shallow-cloned Source workstations)
 * so we don't mutate the store's authoritative twin. Non-Source blocks
 * are reused by reference.
 */
function overrideBundleSize(twin: import('./../domain/twin').Twin, bundleSize: number): import('./../domain/twin').Twin {
  if (bundleSize <= 0) return twin;
  let touched = false;
  const workstations = twin.workstations.map((ws) => {
    if (ws.block?.kind !== 'Source') return ws;
    const existingPieces = (ws.block.params?.piecesPerAgent as number | undefined) ?? 1;
    const existingRate = (ws.block.params?.sourceRatePerHr as number | undefined) ?? 60;
    if (existingPieces === bundleSize) return ws;
    touched = true;
    // Keep pieces/hour constant: rate' = rate · (oldPieces / newPieces).
    const newRate = (existingRate * existingPieces) / bundleSize;
    return {
      ...ws,
      block: {
        ...ws.block,
        params: {
          ...(ws.block.params ?? {}),
          piecesPerAgent: bundleSize,
          sourceRatePerHr: newRate,
        },
      },
    };
  });
  return touched ? { ...twin, workstations } : twin;
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
  const [garmentId, setGarmentId] = useState<string>(project.selectedGarmentId);
  const [operators, setOperators] = useState<number>(project.defaultOperators);
  // User-edited bundle override; null means "follow the seed (twin or system)".
  const [bundleOverride, setBundleOverride] = useState<number | null>(null);
  const [view, setView] = useState<SimView>('iso');
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
  const refCtx = useReferenceContext();
  const clearRefContext = useReferenceContext((s) => s.clear);

  // When a reference is loaded, its garment bulletin + operator pool drive the
  // legacy SimEngine too — otherwise the ISO/TOP/HEAT/LOGIC views would still
  // show the project's default garment, which is jarring after LOAD & SIMULATE.
  const refOverride = useMemo(() => {
    if (!refCtx.slug || !refCtx.variantKey) return null;
    const model = REFERENCE_MODELS_BY_SLUG[refCtx.slug];
    if (!model) return null;
    return {
      garment: model.garmentTemplate,
      operators: variantOperatorCount(model, refCtx.variantKey),
    };
  }, [refCtx.slug, refCtx.variantKey]);

  // Source select — twin path (default when no reference is loaded) draws the
  // simulation from the user's Factory Builder twin; `source=reference` keeps
  // the legacy garment-template flow for paper comparisons; `source=order:<id>`
  // means the user came from the Orders wizard (or picked an order from the
  // SOURCE dropdown) and wants the run driven by that order's garment / crew /
  // production system rather than whatever the canonical twin pins.
  const sourceParam = searchParams.get('source');
  // Accept legacy `source=order` (no id) by falling through to the latest
  // saved order — keeps deep-links from older sessions working.
  const orderIdFromParam = sourceParam?.startsWith('order:')
    ? sourceParam.slice('order:'.length)
    : sourceParam === 'order'
      ? project.orders[0]?.id ?? null
      : null;
  const activeOrder = useMemo(
    () => (orderIdFromParam ? project.orders.find((o) => o.id === orderIdFromParam) ?? null : null),
    [orderIdFromParam, project.orders],
  );
  const isOrderSource = !!activeOrder;
  const useTwinSource =
    sourceParam === 'twin' ||
    (!refOverride && sourceParam !== 'reference' && !isOrderSource && !sourceParam?.startsWith('order'));

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
    } else if (raw?.startsWith('dept:')) {
      const id = raw.slice(5);
      if ((activeTwin.departments ?? []).some((d) => d.id === id)) {
        return { kind: 'dept', id };
      }
    } else if (raw === 'factory') {
      return { kind: 'factory' };
    }
    const legacyLine = searchParams.get('line');
    if (legacyLine && legacyLine !== 'all' && linesInTwin.some((l) => l.id === legacyLine)) {
      return { kind: 'line', id: legacyLine };
    }
    return { kind: 'factory' };
  }, [searchParams, linesInTwin, activeTwin.departments]);
  const selectedLineId = scope.kind === 'line' ? scope.id : null;

  // Per-line builds — drives the "LINES" strip's KPI cards. Computed every
  // time the twin or garment library changes so the cards stay live with the
  // Builder. Empty list when the twin has no lines.
  const lineBuilds: LineBuild[] = useMemo(() => {
    if (!useTwinSource || linesInTwin.length === 0) return [];
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
  }, [useTwinSource, activeTwin, linesInTwin.length, garments.byId, garmentId, project.skillMatrix, project.time.modelTimeUnit, garments.all]);

  // Twin-driven config + meta. Wrapped in a try because the user can land
  // on /sim with an empty twin — we fall back to the reference / garment
  // path in that case instead of blowing up the page.
  const twinBuild = useMemo(() => {
    if (!useTwinSource) return null;
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
  }, [useTwinSource, activeTwin, garments.byId, garmentId, project.skillMatrix, project.time.modelTimeUnit, garments.all, selectedLineId]);

  // When the user picks an order from the SOURCE dropdown (or arrives from
  // the Orders wizard), the engine should reflect that order's garment and
  // crew instead of the global `selectedGarmentId` / slider state.
  const orderGarment = activeOrder ? garments.byId[activeOrder.garmentTemplateId] ?? null : null;

  const garment = twinBuild?.meta.garment
    ?? refOverride?.garment
    ?? orderGarment
    ?? (garments.byId[garmentId] ?? garments.all[0]);
  // Effective operator count for display + reference path. Twin path always
  // shows the slider's current value (re-seeded by the effect below when the
  // twin changes). Reference path uses the variant's authored count.
  const effectiveOperators = twinBuild
    ? operators
    : activeOrder
      ? operators
      : (refOverride?.operators ?? operators);

  // Production-system bundle size — picked up from the Orders wizard. PBS
  // batches 30, modular/UPS/make-through run piece-by-piece (size 1), etc.
  // Reference-paper runs keep the paper's own bundle size, so they're
  // unaffected by this hook-up.
  const productionSystemId = activeOrder?.productionSystem ?? project.selectedProductionSystem;
  const productionSystemDef = PRODUCTION_SYSTEMS[productionSystemId];
  const systemBundleSize = refOverride
    ? undefined
    : (bundleOverride ?? twinBuild?.meta.seedBundleSize ?? productionSystemDef.typicalBatchSize);

  const opEfficiency = useMemo(
    () => efficiencyFromSkillMatrix(project.skillMatrix, garment.operations),
    [project.skillMatrix, garment],
  );

  // Resolve the sim-source twin. PML drives off a Twin (not a SimConfig),
  // so each source (twin / reference / order / garment) materialises into
  // one.
  //   • Twin / reference path → the active twin (loadCanonical writes the
  //     reference twin in-place, so by the time refOverride is set the
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
  const simSourceTwin = useMemo(() => {
    let base: Twin;
    if (useTwinSource || refOverride) {
      base = selectedLineId
        ? scopedTwinForLine(activeTwin, selectedLineId)
        : activeTwin;
    } else if (garment) {
      // Order / garment fallback — route through the same per-system seed
      // helper the Build-in-Builder button uses so picking modular gives
      // the user a U-cell in the sim, not a snaking grid. The helper
      // tacks Source / ResourcePool / Sink onto the seeded line so the
      // PML engine still has a closed graph to run.
      base =
        buildSimReadyOrderTwin({
          draftName: garment.name,
          productionSystem: mapToLineSystem(productionSystemId),
          garment,
          operators: effectiveOperators,
        }) ?? EMPTY_TWIN;
    } else {
      base = EMPTY_TWIN;
    }
    if (!bundleOverride || bundleOverride <= 0) return base;
    return overrideBundleSize(base, bundleOverride);
  }, [useTwinSource, refOverride, selectedLineId, activeTwin, garment, effectiveOperators, bundleOverride, productionSystemId]);
  // Captured for future PML wiring — neither flows into the engine today
  // because the twin already encodes both. `systemBundleSize` is read by the
  // HUD's BUNDLE chip; opEfficiency is mirrored back into the skill matrix
  // store by the operator slider effect above.
  void opEfficiency;
  void systemBundleSize;

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

  // Snap slider state to the active order whenever the user switches between
  // orders in the SOURCE dropdown (or arrives via /sim?source=order:<id>).
  // Tracked separately from the twin seed so toggling Order → Twin → Order
  // restores the order's values instead of leaving the prior twin state.
  const lastOrderIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeOrder) {
      lastOrderIdRef.current = null;
      return;
    }
    if (lastOrderIdRef.current !== activeOrder.id) {
      setGarmentId(activeOrder.garmentTemplateId);
      setOperators(activeOrder.operators);
      setBundleOverride(null);
      lastOrderIdRef.current = activeOrder.id;
    }
  }, [activeOrder]);

  const baseSim = usePmlSim(simSourceTwin, { garment, recordFlow: true });

  // ── Multi-line scope ────────────────────────────────────────────────────
  // When no specific line is selected and the twin has more than one wired
  // line, drive one PML run per line and merge the resulting states + metas
  // into the same shape the existing views consume. Each per-line twin is
  // scoped to that line's workstations so different garments / bundle sizes
  // don't compose into one homogeneous simulation.
  //
  // Lines actually included in this scope's run: factory = all wired, dept
  // = wired lines whose deptId matches, line = none (single-engine path
  // handles it).
  const wiredLineBuilds = useMemo(() => {
    const ok = lineBuilds.filter((lb) => lb.ok);
    if (scope.kind === 'dept') return ok.filter((lb) => lb.line.deptId === scope.id);
    if (scope.kind === 'line') return ok.filter((lb) => lb.line.id === scope.id);
    return ok; // factory
  }, [lineBuilds, scope]);
  const inMultiLineScope =
    useTwinSource && scope.kind !== 'line' && wiredLineBuilds.length > 1;
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

  // Effective twin meta passed to the view components — merged across lines
  // in multi-line scope so iso/top/heat/logic see every authored Builder
  // coord, not just the dominant garment's stations.
  const effectiveTwinMeta: BuildFromTwinMeta | null = inMultiLineScope
    ? mergedMultiMeta
    : (twinBuild?.meta ?? null);
  const effectiveSourceLabel = inMultiLineScope
    ? 'All lines'
    : garment.name;

  // Ambient workstations — everything the user placed in Factory Builder that
  // *isn't* a sewing-op-bearing engine station. Spreaders, cutters, QC tables,
  // inline irons, packing benches, fabric racks, bundle trolleys, supervisors,
  // helpers, conveyors — all of it. The Sim views render these as static iso
  // cuboids behind the engine stations so the floor reads as a full factory.
  // Without this, only the sewing line shows up in the simulation and the
  // rest of the factory user authored seems to disappear.
  const ambientWorkstations = useMemo<AmbientWorkstationInput[]>(() => {
    if (!useTwinSource || !activeTwin?.workstations) return [];
    const simulatedSet = new Set(effectiveTwinMeta?.simulatedWsIds ?? []);
    const deptById = new Map(
      (activeTwin.departments ?? []).map((d) => [d.id, d] as const),
    );
    return activeTwin.workstations
      .filter((ws) => !simulatedSet.has(ws.id))
      .map((ws): AmbientWorkstationInput => {
        const fix = ISO_FIXTURE_CATALOG.find((f) => f.id === ws.catalogId);
        const dept = deptById.get(ws.deptId);
        const deptColor = dept ? (DEPT_LINE_COLORS[dept.color] ?? '#888') : '#888';
        return {
          wsId: ws.id,
          catalogId: ws.catalogId,
          name: ws.name,
          gx: ws.position.x,
          gy: ws.position.y,
          w: fix?.w ?? 1,
          d: fix?.d ?? 1,
          h: fix?.h ?? 1,
          rotation: ws.rotation ?? 0,
          deptColor,
          cat: fix?.cat ?? 'fix',
          lineId: ws.lineId,
        };
      });
  }, [useTwinSource, activeTwin, effectiveTwinMeta]);

  // The reference-line picker (paper + variant + LOAD & SIMULATE) used to
  // live here as a sim-toolbar strip. It now lives on the Reference Models
  // page so authoring + loading happens in one place and the Sim chrome
  // stays focused on observing. We still resolve `refLoadedLabel` from
  // `refCtx` because the Sim source picker surfaces it as a source option.
  const refLoadedLabel =
    refCtx.slug && refCtx.variantKey
      ? (() => {
          const m = REFERENCE_MODELS.find((x) => x.slug === refCtx.slug);
          if (!m) return null;
          const vlabel =
            refCtx.variantKey === 'baseline'
              ? 'Baseline'
              : refCtx.variantKey === 'proposed'
                ? 'Proposed'
                : refCtx.variantKey;
          return `${m.authorYear} · ${vlabel}`;
        })()
      : null;

  // Time displays — see `lib/timeUnit`. Three labelled kinds replace the
  // old `hr = 8 + floor(t/60)` fake clock that conflated model time with
  // calendar HH:MM. DAY N is derived from model time (not wall clock) so
  // it stays correct across paused sessions.
  const unit = project.time.modelTimeUnit;
  const dayN = simDayNumber(state.time, unit, project.time.shiftDurationMin);
  const shiftPct = shiftProgressPct(state.time, unit, project.time.shiftDurationMin);
  const modelStr = fmtModelTime(state.time, unit);
  const calStr = fmtCalendar(state.time, unit, project.time.startDate, project.units.dateFormat);

  // Wall clock ticks every second for the corner pin. Recompute via a
  // local interval — does NOT affect the engine, which is wall-clock-free.
  const [wallNow, setWallNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setWallNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const wallStr = fmtWallClock(wallNow);

  // Event log can display model time ("t = 83 min", compact) or its
  // calendar projection ("09:23 Mon 18 May"). User-toggleable so power users
  // can pick whichever helps them reason about the rolling event feed.
  const [eventTimeKind, setEventTimeKind] = useState<'model' | 'cal'>('model');

  // Collapse state for the two floating overlays. Useful in LOGIC view where
  // the operation grid spans the canvas — the user can fold these away to
  // see the cards underneath without losing them entirely.
  const [hudOpen, setHudOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // TIME SETUP drawer — model-time semantics + calendar anchoring for the
  // run. Relocated here from the old Settings page so the controls that
  // define what the header clocks mean live next to those clocks. Execution
  // mode + playback speed stay in the transport bar (they already lived
  // there). Dark-surface styling below mirrors the Sim view's overlays;
  // colours go through alpha()/tokens so no raw literals hit the ratchet.
  const [setupOpen, setSetupOpen] = useState(false);
  const setupLabel: CSSProperties = {
    display: 'block',
    fontFamily: SW_FONTS.mono,
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.14em',
    color: alpha(SW_COLORS.paper, 0.6),
    marginBottom: 6,
  };
  const setupInput: CSSProperties = {
    width: '100%',
    padding: '7px 9px',
    background: alpha(SW_COLORS.paper, 0.06),
    border: `1px solid ${alpha(SW_COLORS.paper, 0.2)}`,
    borderRadius: SW_RADIUS.sm,
    color: SW_COLORS.paper,
    fontFamily: SW_FONTS.mono,
    fontSize: 13,
    fontWeight: 700,
    colorScheme: 'dark',
  };

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
        display: 'grid',
        // 4 row tracks for the 4 top-level children: HUD, sewing-lines
        // strip, simulation floor (fills remaining height), playback bar.
        // Keeping a fifth track here is what caused the canvas to collapse
        // after the reference-picker row was lifted to Reference Models —
        // the floor div landed in an `auto` track and zeroed its height.
        gridTemplateRows: 'auto auto 1fr auto',
        background: SW_COLORS.ink,
        color: SW_COLORS.paper,
      }}
    >
      {/* HUD */}
      <div
        style={{
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          borderBottom: '1px solid #ffffff15',
          flexWrap: 'wrap',
        }}
      >
        <ViewTitle kicker="Simulation" title="Live Sim" surface="dark" />
        <div style={{ width: 1, height: 20, background: '#ffffff20' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: playing ? SW_COLORS.ok : SW_COLORS.warn,
              boxShadow: playing ? `0 0 12px ${SW_COLORS.ok}` : 'none',
              animation: playing ? 'sim-pulse 1s infinite' : undefined,
            }}
          />
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 12, fontWeight: 700, letterSpacing: '2px' }}>
            {playing ? 'RUNNING' : 'PAUSED'}
          </span>
        </div>
        <div style={{ width: 1, height: 20, background: '#ffffff20' }} />

        {/* SOURCE picker — clicking opens a dropdown of every source the
            engine can run: the Builder-authored twin (the user's factory),
            any orders they've committed from the Orders wizard, and the
            loaded reference paper (when active). Switching is instant —
            the slider/garment/system snap to the picked source. */}
        <SimSourceMenu
          activeOrderId={activeOrder?.id ?? null}
          orders={project.orders}
          garmentsById={garments.byId}
          twinBuild={inMultiLineScope && effectiveTwinMeta ? { meta: effectiveTwinMeta } : twinBuild}
          refOverride={refOverride}
          refLoadedLabel={refLoadedLabel}
          totalWorkstations={activeTwin.workstations.length}
          factoryName={project.meta.name}
          onPickTwin={() => {
            if (refOverride) clearRefContext();
            setSearchParams({ source: 'twin' });
          }}
          onPickOrder={(id) => {
            if (refOverride) clearRefContext();
            setSearchParams({ source: `order:${id}` });
          }}
          onNewOrder={() => navigate('/orders')}
        />

        <div style={{ width: 1, height: 20, background: '#ffffff20' }} />
        {/* Three labelled clocks — model (sim t), calendar (projection), wall (device). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TimeDisplay
            kind="MODEL"
            surface="dark"
            primarySize={18}
            primary={modelStr}
            secondary={`day ${dayN} · ${Math.round(shiftPct)}% of shift`}
            compact
          />
          <TimeDisplay
            kind="CAL"
            surface="dark"
            primarySize={12}
            primary={calStr}
            compact
          />
        </div>
        <TimeDisplay kind="WALL" surface="dark" primarySize={12} primary={wallStr} compact />

        {/* TIME SETUP toggle — sits with the clocks because it defines what
            they mean. Opens the model-time / calendar drawer below the bar. */}
        <button
          onClick={() => setSetupOpen((o) => !o)}
          title="Model time unit, shift length & calendar anchor for the run"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            background: setupOpen ? SW_COLORS.brand : alpha(SW_COLORS.paper, 0.08),
            border: `1px solid ${setupOpen ? SW_COLORS.brand : alpha(SW_COLORS.paper, 0.2)}`,
            borderRadius: SW_RADIUS.sm,
            color: setupOpen ? SW_COLORS.paper : alpha(SW_COLORS.paper, 0.8),
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: '0.14em',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden>⚙</span>
          <span>TIME SETUP</span>
          <span aria-hidden style={{ opacity: 0.7 }}>{setupOpen ? '▾' : '▸'}</span>
        </button>

        <div style={{ flex: 1 }} />

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
                  productionSystem: (scopedLine?.productionSystem ?? 'PBS') as ProductionSystemKey,
                  garment: seedGarment,
                  operatorTarget: operators,
                  color: (scopedLine?.color ?? 'brand') as DepartmentColorKey,
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

      {/* TIME SETUP DRAWER ─────────────────────────────────────────────────
          Model-time semantics + calendar anchoring for the run, relocated
          from the old Settings page. Full-width dark strip under the header;
          collapses to nothing when closed so it never steals canvas height.
          Execution mode + speed are intentionally NOT duplicated here — they
          live in the transport bar at the bottom. */}
      {setupOpen && (
        <div
          style={{
            padding: '12px 24px 14px',
            background: alpha(SW_COLORS.paper, 0.03),
            borderBottom: `1px solid ${alpha(SW_COLORS.paper, 0.12)}`,
          }}
        >
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              color: alpha(SW_COLORS.paper, 0.5),
              letterSpacing: '0.04em',
              marginBottom: 10,
              lineHeight: 1.5,
            }}
          >
            MODEL &amp; TIME — what one tick of{' '}
            <b style={{ color: alpha(SW_COLORS.paper, 0.85) }}>t</b> means, and how it maps to
            the calendar. Execution mode &amp; playback speed are in the transport bar below.
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 18,
              alignItems: 'start',
            }}
          >
            {/* Model time unit — dark inline toggle (ToggleGroup is light-only). */}
            <div>
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
                        background: active ? SW_COLORS.brand : alpha(SW_COLORS.paper, 0.06),
                        color: active ? SW_COLORS.paper : alpha(SW_COLORS.paper, 0.7),
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
                <input
                  type="number"
                  min={30}
                  max={1440}
                  step={30}
                  value={project.time.shiftDurationMin}
                  onChange={(e) =>
                    project.setTime(
                      'shiftDurationMin',
                      Math.max(30, Math.min(1440, parseInt(e.target.value) || 480)),
                    )
                  }
                  style={{ ...setupInput, width: 84 }}
                />
                <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: alpha(SW_COLORS.paper, 0.55) }}>
                  min · {(project.time.shiftDurationMin / 60).toFixed(1)} h
                </span>
              </div>
            </div>

            {/* Simulation start date — calendar anchor for t = 0. */}
            <div>
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
          </div>
        </div>
      )}

      {/* SEWING LINES STRIP ────────────────────────────────────────────────
          One card per sewing line in the active twin. Click a card to scope
          the engine + visuals to just that line; click ALL LINES to widen the
          run back to every workstation in the factory. Hidden when the twin
          has no lines (single-line factories keep the legacy chrome). */}
      {useTwinSource && lineBuilds.length > 0 ? (
        <SewingLinesStrip
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
        <div />
      )}

      {/* SIMULATION FLOOR */}
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          background: 'radial-gradient(ellipse at 50% 30%, #182231 0%, #0a0d12 100%)',
        }}
      >
        {view === 'iso' && (
          <PanZoomViewport viewKey="iso">
            <SimIsoView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              garmentName={effectiveSourceLabel}
              simTime={state.time}
              system={productionSystemId}
              twinMeta={effectiveTwinMeta}
              ambientWorkstations={ambientWorkstations}
              selectedOpId={selectedOpId}
              onSelectStation={setSelectedOpId}
              bundles={liveBundles}
            />
          </PanZoomViewport>
        )}
        {view === 'top' && (
          <PanZoomViewport viewKey="top">
            <SimTopView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              garmentName={effectiveSourceLabel}
              simTime={state.time}
              system={productionSystemId}
              twinMeta={effectiveTwinMeta}
              ambientWorkstations={ambientWorkstations}
              selectedOpId={selectedOpId}
              onSelectStation={setSelectedOpId}
            />
          </PanZoomViewport>
        )}
        {view === 'heat' && (
          <PanZoomViewport viewKey="heat">
            <SimHeatView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              garmentName={effectiveSourceLabel}
              simTime={state.time}
              system={productionSystemId}
              twinMeta={effectiveTwinMeta}
              ambientWorkstations={ambientWorkstations}
            />
          </PanZoomViewport>
        )}
        {view === 'logic' && (
          <PanZoomViewport viewKey="logic">
            <SimLogicView
              stations={state.stations}
              bottleneckOpIndex={state.bottleneckOpIndex}
              garmentName={effectiveSourceLabel}
              simTime={state.time}
              system={productionSystemId}
              twinMeta={effectiveTwinMeta}
              ambientWorkstations={ambientWorkstations}
            />
          </PanZoomViewport>
        )}
        {view === 'pml' && (
          <PanZoomViewport viewKey="pml">
            <SimPmlView
              garment={garment}
              operators={effectiveOperators}
              hasReference={!!(refCtx.slug && refCtx.variantKey)}
              useActiveTwin={inMultiLineScope}
            />
          </PanZoomViewport>
        )}

        {/* VIEW TOGGLE — floats over the top-center of the canvas so the
            mode picker sits with the thing it controls (the floor) instead
            of buried in the HUD strip. Same pill styling as before; just
            absolutely-positioned and given a translucent backdrop so it
            stays legible over any view. */}
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 2,
            background: '#0a0d12cc',
            border: '1px solid #ffffff20',
            padding: 3,
            borderRadius: 8,
            backdropFilter: 'blur(6px)',
            zIndex: 6,
          }}
        >
          {(['iso', 'top', 'heat', 'logic', 'pml'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                background: view === v ? SW_COLORS.brand : 'transparent',
                color: view === v ? '#fff' : '#ffffffaa',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 14px',
                fontFamily: SW_FONTS.display,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: '0.1em',
                borderRadius: 4,
              }}
              title={v === 'pml' ? 'PML — block-graph snapshot of the active twin' : undefined}
            >
              {v === 'iso' ? 'ISO 3D' : v === 'top' ? 'TOP 2D' : v === 'heat' ? 'HEAT' : v === 'logic' ? 'LOGIC' : '⚙ PML'}
            </button>
          ))}
        </div>

        {/* Legend overlay — view-aware key for every glyph on the floor. */}
        <SimLegend view={view} />

        {/* HUD stat tiles — PML view owns its own KPI strip, so hide these
            there. Other views keep the strip but make it collapsible so the
            user can reclaim the top-left corner (e.g. LOGIC's first card
            sits beneath it). */}
        {view !== 'pml' && (
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
              maxHeight: 'calc(100% - 108px)',
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
              <span style={{ color: '#ffffff80', fontSize: 11 }}>{hudOpen ? '▾' : '▸'}</span>
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
                        !!twinGarment && !refOverride && !!twinBuild?.meta.garmentPinned;
                      const displayedValue = refOverride
                        ? '__ref__'
                        : twinPins
                          ? twinGarment.id
                          : garmentId;
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
                        ...(refOverride
                          ? [{
                              value: '__ref__',
                              label: refOverride.garment.name.replace(/\s*\(.*\)/, ''),
                              tag: 'REF',
                              disabled: true,
                            }]
                          : []),
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
                        : refOverride
                          ? 'Garment is pinned by the loaded reference scenario. Clear the reference (× on the source chip) to pick freely.'
                          : undefined;
                      return (
                        <HudSelect
                          value={displayedValue}
                          minWidth={180}
                          mono
                          disabled={twinPins || !!refOverride}
                          title={title}
                          options={options}
                          onChange={(id) => {
                            if (id === '__ref__') return;
                            if (refOverride) clearRefContext();
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

                  {!refOverride && (
                    <div
                      title={`${productionSystemDef.label}\n${productionSystemDef.description}`}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, cursor: 'help' }}
                    >
                      <span style={{ color: '#ffffff80', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 9, letterSpacing: '0.1em' }}>
                        SYSTEM
                      </span>
                      <span style={{ color: '#fff', fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 12 }}>
                        {productionSystemDef.short}
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
        )}

        {/* Right inspector — Bottleneck + Event feed. Collapsible so it
            doesn't permanently clobber the rightmost column of operation
            cards in LOGIC view (or the floor edge in ISO/TOP/HEAT). */}
        {view !== 'pml' && (
        <div
          style={{
            position: 'absolute',
            right: 24,
            top: 24,
            width: inspectorOpen ? 280 : 'auto',
            maxHeight: 'calc(100% - 48px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 6,
            zIndex: 5,
          }}
        >
          <button
            onClick={() => setInspectorOpen((o) => !o)}
            title={inspectorOpen ? 'Collapse inspector' : 'Expand inspector'}
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
              alignSelf: 'flex-end',
            }}
          >
            <span style={{ color: SW_COLORS.brand }}>▣</span>
            <span>INSPECTOR</span>
            <span style={{ color: '#ffffff80', fontSize: 11 }}>{inspectorOpen ? '▾' : '▸'}</span>
          </button>
          {inspectorOpen && (
          <>
          <div
            style={{
              background: '#ffffff08',
              border: '1px solid #ffffff15',
              borderRadius: SW_RADIUS.sm,
              padding: 12,
              width: '100%',
            }}
          >
            <div
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 700,
                color: '#ffffff80',
                letterSpacing: '1.5px',
                marginBottom: 8,
              }}
            >
              BOTTLENECK
            </div>
            <div style={{ fontSize: 12, color: SW_COLORS.alarm, fontWeight: 700, marginBottom: 4 }}>
              {state.stations[state.bottleneckOpIndex]?.opCode ?? '—'} ·{' '}
              {state.stations[state.bottleneckOpIndex]?.opName ?? '—'}
            </div>
            <div style={{ fontSize: 11, color: '#ffffffaa', fontFamily: SW_FONTS.mono }}>
              Q={state.stations[state.bottleneckOpIndex]?.queueLen ?? 0} · BUSY=
              {state.stations[state.bottleneckOpIndex]?.busy ?? 0}/
              {state.stations[state.bottleneckOpIndex]?.serversTotal ?? 0}
            </div>
          </div>

          <div
            style={{
              background: '#ffffff08',
              border: '1px solid #ffffff15',
              borderRadius: SW_RADIUS.sm,
              padding: 12,
              overflow: 'hidden',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 120,
              width: '100%',
            }}
          >
            <div
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 700,
                color: '#ffffff80',
                letterSpacing: '1.5px',
                marginBottom: 8,
                flexShrink: 0,
              }}
            >
              EVENT FEED
            </div>
            {/* Toggle between model time (default) and the calendar projection. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, color: '#ffffff60', letterSpacing: '1px' }}>SHOW</span>
              <ToggleGroup
                value={eventTimeKind}
                onChange={(v) => setEventTimeKind(v as 'model' | 'cal')}
                options={[
                  { value: 'model', label: 't =' },
                  { value: 'cal',   label: 'CAL' },
                ]}
              />
            </div>
            <div style={{ fontSize: 11, fontFamily: SW_FONTS.mono, lineHeight: 1.6, overflow: 'auto', flex: 1 }}>
              {state.events.length === 0 && (
                <EmptyState
                  size="sm"
                  surface="dark"
                  icon="▶"
                  title="No events yet"
                  body="Press PLAY to start the run."
                  action={{ label: '▶ Play', onClick: () => setPlaying(true) }}
                />
              )}
              {state.events.map((e, i) => {
                const col =
                  e.tag === 'OUT'
                    ? SW_COLORS.ok
                    : e.tag === 'STARVE'
                      ? SW_COLORS.warn
                      : SW_COLORS.alarm;
                const label =
                  eventTimeKind === 'cal'
                    ? fmtCalendarCompact(e.time, unit, project.time.startDate)
                    : fmtModelCompact(e.time, unit);
                return (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                    <span style={{ color: '#ffffff60', width: eventTimeKind === 'cal' ? 130 : 50, fontFamily: SW_FONTS.mono }}>
                      {label}
                    </span>
                    <span style={{ color: col, flex: 1 }}>{e.msg}</span>
                  </div>
                );
              })}
            </div>
          </div>
          </>
          )}
        </div>
        )}

        {/* Per-station sim-vs-theory drawer — fed by the REAL run on this page. */}
        {view !== 'pml' && (() => {
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
      </div>

      {/* TRANSPORT BAR */}
      <div
        style={{
          padding: '14px 24px',
          background: '#0a0d12',
          borderTop: '1px solid #ffffff15',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <Button variant="secondary" size="sm" onClick={reset}>
          ⏮
        </Button>
        <Button variant={playing ? 'danger' : 'success'} size="lg" onClick={() => setPlaying(!playing)}>
          {playing ? '⏸ PAUSE' : '▶ PLAY'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => step(3600 / unitToSeconds(unit))}>
          ⏭ +1h
        </Button>
        <div style={{ width: 1, height: 28, background: '#ffffff20' }} />
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: '#ffffff80', fontWeight: 700 }}>SPEED</span>
        {/*
          Named speed tiers. Tooltip explains the unit translation so the
          user never confuses "1×" for an opaque multiplier. The active tier
          becomes effective when multiplied by the project-level
          realTimeScale (see useSim).
        */}
        {[
          { mult: 1,   label: 'Real-time',     hint: `1 model-${project.time.modelTimeUnit} per real-sec` },
          { mult: 10,  label: '10×',           hint: `10 model-${project.time.modelTimeUnit} per real-sec` },
          { mult: 60,  label: '60× (1 hr/s)',  hint: '1 model-hour per real-sec' },
          { mult: 480, label: 'Shift/sec',     hint: 'Full 8-hr shift in 1 real-sec' },
        ].map((p) => (
          <button
            key={p.mult}
            onClick={() => setSpeed(p.mult)}
            title={p.hint}
            style={{
              background: speed === p.mult ? SW_COLORS.brand : '#ffffff10',
              color: speed === p.mult ? '#fff' : '#ffffffaa',
              border: 'none',
              borderRadius: SW_RADIUS.sm,
              padding: '6px 12px',
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => project.setTime('executionMode',
            project.time.executionMode === 'virtual' ? 'realtime' : 'virtual')}
          title="Toggle virtual mode — engine runs as fast as compute allows, no real-time pacing"
          style={{
            background: project.time.executionMode === 'virtual' ? SW_COLORS.brand : '#ffffff10',
            color: project.time.executionMode === 'virtual' ? '#fff' : '#ffffffaa',
            border: 'none',
            borderRadius: SW_RADIUS.sm,
            padding: '6px 12px',
            fontFamily: SW_FONTS.mono,
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Virtual
        </button>
        <div
          style={{
            flex: 1,
            position: 'relative',
            height: 28,
            background: '#ffffff08',
            borderRadius: SW_RADIUS.sm,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${shiftPct}%`,
              background: `linear-gradient(90deg, ${SW_COLORS.brand}, ${SW_COLORS.thread})`,
            }}
          />
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            DAY {dayN} · {Math.round(shiftPct)}% complete · {modelStr}
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/kpi')}>
          End shift →
        </Button>
      </div>

      <style>{`
        @keyframes sim-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes sim-march { to { stroke-dashoffset: -16; } }
      `}</style>
    </div>
  );
}

interface SimSourceMenuProps {
  activeOrderId: string | null;
  orders: OrderDraft[];
  garmentsById: Record<string, GarmentTemplate>;
  twinBuild: { meta: BuildFromTwinMeta } | null;
  refOverride: { garment: GarmentTemplate; operators: number } | null;
  refLoadedLabel: string | null;
  totalWorkstations: number;
  factoryName: string;
  onPickTwin: () => void;
  onPickOrder: (id: string) => void;
  onNewOrder: () => void;
}

/**
 * SOURCE picker — a HudSelect-styled dropdown showing every source the engine
 * can run: the canonical twin (always), each saved order from the Orders
 * wizard, and the loaded reference paper (when active). Selecting an option
 * switches the engine; the slider/garment snap to the picked source via the
 * order-seed effect in LiveSimPage.
 */
function SimSourceMenu({
  activeOrderId,
  orders,
  garmentsById,
  twinBuild,
  refOverride,
  refLoadedLabel,
  totalWorkstations,
  factoryName,
  onPickTwin,
  onPickOrder,
  onNewOrder,
}: SimSourceMenuProps) {
  const factoryLabel = (factoryName?.trim() || 'Untitled factory').toUpperCase();
  const isOrderSource = !!activeOrderId && !refOverride;
  const isRefSource = !!refOverride;
  const isTwinSource = !isOrderSource && !isRefSource;
  const simCount = twinBuild?.meta.simulatedWsIds.length ?? 0;
  const infraCount = twinBuild?.meta.infrastructure.length ?? 0;
  const wiredCount = simCount + infraCount;
  const tone = isRefSource
    ? SW_COLORS.fabric
    : isOrderSource
      ? SW_COLORS.thread
      : SW_COLORS.brand;

  type SourceValue = `twin` | `order:${string}` | `ref`;

  // The FACTORY row's meta has to be sensible in every mode — twinBuild is
  // null when an order/reference is active, so fall back to the raw station
  // count from activeTwin (which the parent already gives us via
  // `totalWorkstations`). Only print "build a factory first" when the twin
  // is genuinely empty.
  const twinMeta = twinBuild
    ? `${wiredCount} of ${totalWorkstations} wired · ${simCount} station${simCount === 1 ? '' : 's'}`
    : totalWorkstations > 0
      ? `${totalWorkstations} workstation${totalWorkstations === 1 ? '' : 's'}`
      : 'build a factory first';

  const orderOptions: HudSelectOption<SourceValue>[] = orders.map((o) => {
    const g = garmentsById[o.garmentTemplateId];
    const sys = PRODUCTION_SYSTEMS[o.productionSystem];
    return {
      value: `order:${o.id}`,
      label: `${o.po} · ${g?.name ?? o.style}`,
      tag: 'ORDER',
      meta: `${o.operators} OPR · ${sys.short} · ${o.qty}/${o.deadlineDays}d`,
    };
  });

  const refOption: HudSelectOption<SourceValue>[] = isRefSource
    ? [{
        value: 'ref',
        label: refLoadedLabel ?? '—',
        tag: 'REF',
        meta: `${refOverride!.operators} OPR`,
        disabled: true,
      }]
    : [];

  const options: HudSelectOption<SourceValue>[] = [
    {
      value: 'twin',
      label: factoryLabel,
      tag: 'FACTORY',
      meta: twinMeta,
    },
    ...orderOptions,
    ...refOption,
  ];

  const currentValue: SourceValue = isRefSource
    ? 'ref'
    : isOrderSource
      ? (`order:${activeOrderId}` as SourceValue)
      : 'twin';

  const title = isTwinSource
    ? `Reading workstations + connectors from Factory Builder.\nTopology: ${twinBuild?.meta.topologySource === 'connectors' ? 'flow connectors' : 'operation precedence'}.`
    : isRefSource
      ? `Reading a published case-study line. Pick Factory to return to ${factoryName?.trim() || 'your factory'}.`
      : `Running an order from the Orders wizard. Pick Factory or another order from the menu to switch.`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          color: tone,
          fontFamily: SW_FONTS.mono,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.1em',
        }}
      >
        SOURCE
      </span>
      <HudSelect<SourceValue>
        value={currentValue}
        options={options}
        onChange={(v) => {
          if (v === 'twin') onPickTwin();
          else if (v.startsWith('order:')) onPickOrder(v.slice('order:'.length));
        }}
        mono
        minWidth={300}
        title={title}
        variant="dark"
        size="sm"
      />
      {orders.length === 0 ? (
        <button
          onClick={onNewOrder}
          title="Create a new production order"
          style={{
            background: 'transparent',
            border: `1px dashed ${SW_COLORS.thread}99`,
            color: SW_COLORS.thread,
            padding: '4px 8px',
            borderRadius: SW_RADIUS.sm,
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            cursor: 'pointer',
          }}
        >
          + NEW ORDER
        </button>
      ) : (
        <button
          onClick={onNewOrder}
          title="Open the Orders wizard"
          style={{
            background: 'transparent',
            border: 'none',
            color: SW_COLORS.thread,
            padding: '0 2px',
            fontFamily: SW_FONTS.mono,
            fontSize: 14,
            fontWeight: 900,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          +
        </button>
      )}
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
          label: 'Operation card',
          hint: 'One sewing operation in the routing — labelled by operation code + SMV.',
        },
        {
          glyph: <OperatorGlyph working />,
          label: 'Operator (working)',
          hint: 'Filled circle on the card = currently processing a bundle.',
        },
        {
          glyph: <OperatorGlyph working={false} />,
          label: 'Operator (idle)',
          hint: 'Faded ring = unmanned seat or no work to pull.',
        },
        {
          glyph: <ConveyorDotGlyph />,
          label: 'Bundle on conveyor',
          hint: 'Yellow dots travelling along dashed lines = WIP moving between operations.',
        },
        {
          glyph: <WipStackGlyph />,
          label: 'Queue at station',
          hint: 'Stacked thread-coloured bars under each card = bundles waiting.',
        },
        {
          glyph: <UtilBarGlyph />,
          label: 'Utilisation bar',
          hint: 'Green fill = busy share · turns red when the station bottlenecks.',
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
    case 'pml':
      return [
        {
          glyph: <CardGlyph color={SW_COLORS.brand} />,
          label: 'PML block (Source / Op / Sink)',
          hint: 'Each card = one node in the Process Modelling Library graph.',
        },
        {
          glyph: <CardGlyph color={SW_COLORS.alarm} />,
          label: 'Bottleneck block',
          hint: 'Red border + dark fill = slowest block in the current run.',
        },
        {
          glyph: <QBadgeGlyph />,
          label: 'Q badge',
          hint: 'Queue length including bundles in service at this block.',
        },
        {
          glyph: <ThroughputGlyph />,
          label: 'Throughput readout',
          hint: 'Big white number = live pieces/hr through this block.',
        },
      ];
  }
}

/**
 * Wraps a simulation view in a pan/zoom viewport. Wheel zooms toward the
 * cursor, left-drag on empty space pans, and a small control puck in the
 * bottom-right offers +/- buttons plus a reset. The transform resets when
 * the active `viewKey` changes so switching ISO ↔ TOP doesn't strand the
 * user in a far-off corner of the previous view.
 */
function PanZoomViewport({ viewKey, children }: { viewKey: string; children: React.ReactNode }) {
  const [tf, setTf] = useState({ x: 0, y: 0, s: 1 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const [panning, setPanning] = useState(false);

  // Reset the transform whenever the user picks a different view, so each
  // view starts neutral instead of inheriting the previous zoom level.
  useEffect(() => {
    setTf({ x: 0, y: 0, s: 1 });
  }, [viewKey]);

  // Wheel-to-zoom needs a non-passive listener so we can preventDefault and
  // stop the parent page from scrolling underneath the simulation floor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Pinch (ctrlKey) or a mouse wheel zooms toward the cursor; a plain
      // trackpad two-finger swipe pans. tf.x/tf.y are screen-space (same as the
      // mouse-drag pan below), so subtract the raw deltas for 1:1 tracking.
      const isPinch = e.ctrlKey || e.metaKey;
      const isMouseWheel =
        e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
      if (!(isPinch || isMouseWheel)) {
        setTf((t) => ({ ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }));
        return;
      }
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setTf((t) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.max(0.3, Math.min(6, t.s * factor));
        const ratio = next / t.s;
        return { s: next, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      const s = panRef.current;
      if (!s) return;
      setTf((t) => ({ ...t, x: s.tx + (e.clientX - s.sx), y: s.ty + (e.clientY - s.sy) }));
    };
    const onUp = () => {
      panRef.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Let buttons / inputs handle their own clicks — only grab empty space.
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, select, textarea, a, [role="button"]')) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, tx: tf.x, ty: tf.y };
    setPanning(true);
  };

  // Compute the next scale inside the functional updater so back-to-back
  // button clicks chain correctly instead of all reading the same stale
  // `tf.s` from closure and overwriting each other.
  const zoomBy = (factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setTf((t) => {
      const next = Math.max(0.3, Math.min(6, t.s * factor));
      const ratio = next / t.s;
      return { s: next, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
    });
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={startPan}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        cursor: panning ? 'grabbing' : 'grab',
      }}
    >
      {/* Sizing-based zoom (vs CSS `transform: scale`) so SVG children
          re-render at the zoomed pixel resolution and stay vector-sharp.
          CSS scale would rasterize the layer at 1× and stretch the bitmap,
          which is what was causing the blur at higher zoom levels. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${tf.s * 100}%`,
          height: `${tf.s * 100}%`,
          transform: `translate(${tf.x}px, ${tf.y}px)`,
          transformOrigin: '0 0',
        }}
      >
        {children}
      </div>

      {/* Control puck — sits above the transformed content, beneath the
          main HUD overlays (which use zIndex 5). Stops propagation so its
          buttons don't double as a pan handle. */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          right: 24,
          bottom: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: 4,
          background: '#0a0d12cc',
          border: '1px solid #ffffff20',
          borderRadius: SW_RADIUS.sm,
          backdropFilter: 'blur(6px)',
          zIndex: 4,
        }}
      >
        <PzButton onClick={() => zoomBy(1.25)} title="Zoom in">+</PzButton>
        <div
          style={{
            minWidth: 44,
            textAlign: 'center',
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 800,
            color: alpha(SW_COLORS.ink, 0.8),
            letterSpacing: '0.1em',
          }}
        >
          {Math.round(tf.s * 100)}%
        </div>
        <PzButton onClick={() => zoomBy(1 / 1.25)} title="Zoom out">−</PzButton>
        <div style={{ width: 1, height: 18, background: '#ffffff20', margin: '0 2px' }} />
        <PzButton onClick={() => setTf({ x: 0, y: 0, s: 1 })} title="Reset view">⟲</PzButton>
      </div>
    </div>
  );
}

function PzButton({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: '1px solid #ffffff15',
        borderRadius: 4,
        color: '#fff',
        fontFamily: SW_FONTS.mono,
        fontSize: 13,
        fontWeight: 900,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

function SimLegend({ view }: { view: SimView }) {
  const [open, setOpen] = useState(false);
  const entries = legendEntriesForView(view);
  const viewLabel =
    view === 'iso' ? 'ISO 3D'
      : view === 'top' ? 'TOP 2D'
        : view === 'heat' ? 'HEAT'
          : view === 'logic' ? 'LOGIC'
            : 'PML';

  return (
    <div
      style={{
        position: 'absolute',
        left: 24,
        bottom: 24,
        width: open ? 320 : 'auto',
        maxHeight: 'calc(100% - 48px)',
        background: '#0a0d12e8',
        border: '1px solid #ffffff20',
        borderRadius: SW_RADIUS.sm,
        boxShadow: '0 10px 40px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 5,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          borderBottom: open ? '1px solid #ffffff15' : 'none',
          color: '#fff',
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: '0.2em',
          cursor: 'pointer',
          textAlign: 'left',
        }}
        title={open ? 'Collapse legend' : 'Expand legend'}
      >
        <span style={{ color: SW_COLORS.brand }}>▣</span>
        <span>LEGEND · {viewLabel}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: '#ffffff80', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div
          style={{
            padding: '8px 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            overflow: 'auto',
          }}
        >
          {entries.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div
                style={{
                  width: 36,
                  height: 28,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {e.glyph}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: SW_FONTS.mono,
                    fontSize: 11,
                    fontWeight: 800,
                    color: '#fff',
                    letterSpacing: '0.04em',
                  }}
                >
                  {e.label}
                </div>
                <div
                  style={{
                    fontFamily: SW_FONTS.body,
                    fontSize: 10.5,
                    color: '#ffffff90',
                    lineHeight: 1.35,
                    marginTop: 2,
                  }}
                >
                  {e.hint}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
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
function QBadgeGlyph() {
  return (
    <svg width={26} height={16} viewBox="0 0 26 16">
      <rect x={1} y={2} width={24} height={12} rx={3} fill={`${SW_COLORS.thread}25`} stroke={SW_COLORS.thread} strokeWidth={0.8} />
      <text x={13} y={11.5} textAnchor="middle" fontFamily={SW_FONTS.mono} fontSize={9} fontWeight={900} fill={SW_COLORS.thread}>
        Q 7
      </text>
    </svg>
  );
}
function ThroughputGlyph() {
  return (
    <svg width={32} height={16} viewBox="0 0 32 16">
      <text x={2} y={12} fontFamily={SW_FONTS.mono} fontSize={11} fontWeight={900} fill="#fff">
        842
      </text>
      <text x={22} y={12} fontFamily={SW_FONTS.mono} fontSize={6} fontWeight={700} fill="#ffffff90">
        pcs/hr
      </text>
    </svg>
  );
}

// ============================================================================
// LAYOUT — map sim stations onto a synthetic grid
// ============================================================================

interface StationLayout {
  s: StationView;
  /** Cell coordinates in world space (1 unit = isoProj cell). */
  gx: number;
  gy: number;
  /** Footprint width / depth in cells. */
  w: number;
  d: number;
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
  w: number;
  d: number;
  h: number;
  rotation: number;
  /** Department accent colour (from DEPT_COLOR_HEX), used as a faint tint so
   *  the dept zones read at a glance. */
  deptColor: string;
  /** Asset family — 'sew' / 'cut' / 'fix' / 'store' / 'mh' / 'buf' / 'op' / … */
  cat: string;
  lineId?: string;
}

/** Caller-side shape for ambient workstations passed into layoutStations.
 *  Same fields as `AmbientLayout` but in world-grid coords (pre-rebase). */
interface AmbientWorkstationInput {
  wsId: string;
  catalogId: string;
  name: string;
  gx: number;
  gy: number;
  w: number;
  d: number;
  h: number;
  rotation: number;
  deptColor: string;
  cat: string;
  lineId?: string;
}

/**
 * Map Builder workstation coordinates into a viewBox of the given size. Used
 * by TOP / HEAT / LOGIC to honour the user-painted layout when the twin
 * source is active. Returns `null` when no twin meta is available, signalling
 * the caller to fall back to its canonical row-wrapped layout.
 */
function twinPositionsForView(
  stations: StationView[],
  twinMeta: BuildFromTwinMeta | null | undefined,
  viewW: number,
  viewH: number,
  paddingX: number,
  paddingY: number,
): { x: number; y: number }[] | null {
  if (!twinMeta || stations.length === 0) return null;
  const byOpId = new Map<string, { gx: number; gy: number }>();
  for (const ts of twinMeta.stations) {
    byOpId.set(ts.opId, { gx: ts.gx, gy: ts.gy });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stations) {
    const p = byOpId.get(s.opId);
    if (!p) continue;
    if (p.gx < minX) minX = p.gx;
    if (p.gy < minY) minY = p.gy;
    if (p.gx > maxX) maxX = p.gx;
    if (p.gy > maxY) maxY = p.gy;
  }
  if (!isFinite(minX)) return null;
  const usableW = viewW - paddingX * 2;
  const usableH = viewH - paddingY * 2;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  return stations.map((s) => {
    const p = byOpId.get(s.opId) ?? { gx: minX, gy: minY };
    return {
      x: paddingX + ((p.gx - minX) / spanX) * usableW,
      y: paddingY + ((p.gy - minY) / spanY) * usableH,
    };
  });
}

function layoutStations(
  stations: StationView[],
  system: ProductionSystem,
  twinMeta?: BuildFromTwinMeta | null,
  ambientWorkstations?: AmbientWorkstationInput[],
): {
  cells: StationLayout[];
  ambientCells: AmbientLayout[];
  gridW: number;
  gridH: number;
  perRow: number;
} {
  const n = stations.length;
  if (n === 0) return { cells: [], ambientCells: [], gridW: 1, gridH: 1, perRow: 1 };

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
      // Compute the world-grid extent across BOTH simulated cells and ambient
      // service blocks so the iso floor fits everything the user authored.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const wc of placed) {
        if (wc.gx < minX) minX = wc.gx;
        if (wc.gy < minY) minY = wc.gy;
        if (wc.gx > maxX) maxX = wc.gx;
        if (wc.gy > maxY) maxY = wc.gy;
      }
      for (const aw of ambientWorkstations ?? []) {
        if (aw.gx < minX) minX = aw.gx;
        if (aw.gy < minY) minY = aw.gy;
        if (aw.gx + aw.w > maxX) maxX = aw.gx + aw.w;
        if (aw.gy + aw.d > maxY) maxY = aw.gy + aw.d;
      }
      const cells: StationLayout[] = placed.map((wc) => ({
        s: stationByOpId.get(wc.opId)!,
        gx: 2 + (wc.gx - minX),
        gy: 2 + (wc.gy - minY),
        // Tighter footprint than the op-level path — workstations in Builder
        // sit at ~1-cell spacing, so the box must fit inside one cell with a
        // small gutter or adjacent machines visually collide.
        w: 0.9,
        d: 1.4,
        cellKey: wc.wsId,
        lineId: wc.lineId,
      }));
      const ambientCells: AmbientLayout[] = (ambientWorkstations ?? []).map((aw) => ({
        wsId: aw.wsId,
        catalogId: aw.catalogId,
        name: aw.name,
        gx: 2 + (aw.gx - minX),
        gy: 2 + (aw.gy - minY),
        w: aw.w,
        d: aw.d,
        h: aw.h,
        rotation: aw.rotation,
        deptColor: aw.deptColor,
        cat: aw.cat,
        lineId: aw.lineId,
      }));
      const gridW = Math.max(8, 2 + (maxX - minX) + 4);
      const gridH = Math.max(6, 2 + (maxY - minY) + 4);
      return { cells, ambientCells, gridW, gridH, perRow: cells.length };
    }
  }

  // Twin op-averaged fallback — used when the meta only carries `stations`
  // (e.g. older builds or empty placeholders). Each engine station maps back
  // to its workstations' mean grid position, so views still read like a
  // top-down of the floor, just with one box per op instead of per machine.
  if (twinMeta) {
    const byOpId = new Map<string, { gx: number; gy: number }>();
    for (const ts of twinMeta.stations) {
      byOpId.set(ts.opId, { gx: ts.gx, gy: ts.gy });
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of stations) {
      const p = byOpId.get(s.opId);
      if (!p) continue;
      if (p.gx < minX) minX = p.gx;
      if (p.gy < minY) minY = p.gy;
      if (p.gx > maxX) maxX = p.gx;
      if (p.gy > maxY) maxY = p.gy;
    }
    if (!isFinite(minX)) {
      // Fall through to synthetic layout below.
    } else {
      const cells: StationLayout[] = stations.map((s) => {
        const p = byOpId.get(s.opId) ?? { gx: minX, gy: minY };
        return {
          s,
          gx: 2 + (p.gx - minX),
          gy: 2 + (p.gy - minY),
          w: 1.4,
          d: 2,
        };
      });
      const gridW = Math.max(8, 2 + (maxX - minX) + 4);
      const gridH = Math.max(6, 2 + (maxY - minY) + 4);
      return { cells, ambientCells: [], gridW, gridH, perRow: stations.length };
    }
  }

  // Modular (TSS) — U-shape. Operators face each other across the U so they
  // can rotate between adjacent stations. Pieces flow top-row L→R, turn at
  // the right end, then return along the bottom row R→L.
  if (system === 'modular') {
    const stride = 3;
    const topCount = Math.ceil(n / 2);
    const bottomCount = n - topCount;
    const topY = 2;
    const bottomY = 7;
    const cells: StationLayout[] = stations.map((s, i) => {
      if (i < topCount) {
        return { s, gx: 2 + i * stride, gy: topY, w: 1.4, d: 2 };
      }
      const j = i - topCount;
      const col = topCount - 1 - j; // reverse so flow returns along the bottom
      return { s, gx: 2 + col * stride, gy: bottomY, w: 1.4, d: 2 };
    });
    void bottomCount;
    return {
      cells,
      ambientCells: [],
      gridW: 2 + topCount * stride + 2,
      gridH: bottomY + 4,
      perRow: topCount,
    };
  }

  // Make-through — one highly-skilled operator owns the whole garment. All
  // "operations" cluster tightly at the same workbench so the scene reads as
  // a single workstation rather than a multi-station line.
  if (system === 'make_through') {
    const cols = Math.min(2, n);
    const rows = Math.ceil(n / cols);
    const stride = 2;
    const cells: StationLayout[] = stations.map((s, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      return { s, gx: 4 + col * stride, gy: 2 + row * stride, w: 1.4, d: 2 };
    });
    return {
      cells,
      ambientCells: [],
      gridW: 4 + cols * stride + 4,
      gridH: 2 + rows * stride + 2,
      perRow: cols,
    };
  }

  // Clump — senior op + helpers grouped around critical operations. Stations
  // split into 2–3 small clusters spaced apart so the topology reads as
  // "clusters" rather than "a single line."
  if (system === 'clump') {
    const clumps = Math.min(3, Math.max(2, Math.ceil(n / 3)));
    const inner = 2;
    const between = 5;
    const cells: StationLayout[] = stations.map((s, i) => {
      const g = i % clumps;
      const within = Math.floor(i / clumps);
      return {
        s,
        gx: 2 + g * between + (within % 2) * inner,
        gy: 2 + Math.floor(within / 2) * (inner + 1),
        w: 1.4,
        d: 2,
      };
    });
    const perGroupRows = Math.ceil(Math.ceil(n / clumps) / 2);
    return {
      cells,
      ambientCells: [],
      gridW: 2 + clumps * between + 2,
      gridH: 2 + perGroupRows * (inner + 1) + 2,
      perRow: clumps * 2,
    };
  }

  // Linear default — PBS / straight / synchro / UPS / bundle / unit_handle.
  // PBS-family systems leave wide gaps between stations to suggest bundle
  // buffers; piece-flow systems (straight, synchro, UPS) sit closer.
  const stride =
    system === 'PBS' || system === 'bundle' || system === 'unit_handle' ? 4 : 3;
  const perRow = Math.min(n, 8);
  const rows = Math.ceil(n / perRow);
  const cells: StationLayout[] = stations.map((s, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    return {
      s,
      gx: 2 + col * stride,
      gy: 2 + row * (stride + 1),
      w: 1.4,
      d: 2,
    };
  });
  const gridW = 2 + perRow * stride + 2;
  const gridH = 2 + rows * (stride + 1) + 2;
  return { cells, ambientCells: [], gridW, gridH, perRow };
}

// ============================================================================
// ISO 3D VIEW
// ============================================================================

interface SimViewProps {
  stations: StationView[];
  bottleneckOpIndex: number;
  garmentName: string;
  simTime: number;
  system: ProductionSystem;
  /** When present, the view uses Builder-authored workstation positions
   *  instead of the canonical system-based line layout. */
  twinMeta?: BuildFromTwinMeta | null;
  /** Authored workstations that aren't tied to a sewing operation — spreaders,
   *  cutters, QC tables, presses, fabric racks, buffers, operators. Rendered
   *  as static floor context so the simulation reads as the full factory. */
  ambientWorkstations?: AmbientWorkstationInput[];
  /** opId of the station whose detail drawer is open (highlights it). */
  selectedOpId?: string | null;
  /** Click a station to open its sim-vs-theory drawer. Omit for read-only views. */
  onSelectStation?: (opId: string) => void;
  /** Live bundles from the recorded flow stream at the current playback minute,
   *  keyed to stations by wsId. Empty when the run hasn't recorded flow. */
  bundles?: BundleFrame[];
}

function SimIsoView({ stations, bottleneckOpIndex, simTime, system, twinMeta, ambientWorkstations, selectedOpId, onSelectStation, bundles = [] }: SimViewProps) {
  if (stations.length === 0) return <svg style={{ width: '100%', height: '100%' }} />;

  const { cells, ambientCells, gridW, gridH } = layoutStations(stations, system, twinMeta, ambientWorkstations);
  // Workstation mode = more cells than engine stations. The synthetic conveyor
  // and travelling-WIP markers chain consecutive cells, which is meaningful
  // when cells are placed in op order along a row but degenerates into noise
  // when cells reflect arbitrary Builder positions across 60+ machines.
  const oneCellPerOp = cells.length === stations.length;
  // Bottleneck highlight needs to follow the opId, not a cell index — in
  // workstation mode multiple cells share an op and the index would point at
  // the wrong row.
  const bottleneckOpId = stations[bottleneckOpIndex]?.opId ?? null;

  const cTL = isoProj(0, 0);
  const cTR = isoProj(gridW, 0);
  const cBR = isoProj(gridW, gridH);
  const cBL = isoProj(0, gridH);
  const minX = Math.min(cTL.sx, cBL.sx) - 80;
  const maxX = Math.max(cTR.sx, cBR.sx) + 80;
  const minY = Math.min(cTL.sy, cTR.sy) - 80;
  const maxY = Math.max(cBL.sy, cBR.sy) + 80;

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      <defs>
        <pattern id="sim-grid-iso" width={32} height={32} patternUnits="userSpaceOnUse">
          <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#ffffff06" strokeWidth={1} />
        </pattern>
        <radialGradient id="sim-vig" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#000" stopOpacity={0} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.55} />
        </radialGradient>
      </defs>
      <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill="url(#sim-grid-iso)" />

      {/* Floor */}
      <polygon points={ptsToStr([cTL, cTR, cBR, cBL])} fill="#ffffff05" stroke="#ffffff15" strokeWidth={1} />

      {/* Iso grid lines */}
      {Array.from({ length: gridW + 1 }, (_, i) => {
        const a = isoProj(i, 0);
        const b = isoProj(i, gridH);
        return (
          <line key={`v-${i}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} stroke="#ffffff08" strokeWidth={0.5} />
        );
      })}
      {Array.from({ length: gridH + 1 }, (_, i) => {
        const a = isoProj(0, i);
        const b = isoProj(gridW, i);
        return (
          <line key={`h-${i}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} stroke="#ffffff08" strokeWidth={0.5} />
        );
      })}

      {/* Ambient service blocks — non-sewing workstations (spreaders, cutters,
          QC tables, presses, fabric racks, buffers, operators) authored in
          Builder. Drawn behind the engine stations as muted iso cuboids so
          the floor reads as a full factory, not just a sewing line. They
          don't carry live state — they're scene context. */}
      {[...ambientCells]
        .sort((a, b) => a.gx + a.gy - (b.gx + b.gy))
        .map((a) => (
          <IsoAmbientBlock key={`amb-${a.wsId}`} amb={a} simTime={simTime} />
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
                can't hand off because the downstream buffer is full. */}
            {c.s.blocked > 0 && (() => {
              const bp = isoProj(c.gx + c.w / 2, c.gy + c.d / 2, 1.6);
              return (
                <g pointerEvents="none">
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

      <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill="url(#sim-vig)" pointerEvents="none" />
    </svg>
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
  const { s, gx, gy, w, d } = layout;
  const origin = isoProj(gx, gy);
  const occupancy = s.serversTotal > 0 ? s.busy / s.serversTotal : 0;
  // Workstation visual identity is sourced from the global asset library
  // (MACHINE_CATALOG) keyed off the operation's machineCode. SNL → brand,
  // 4OL → bobbin, FL → flatlock steel, BT → yellow, BH → green, etc.
  // The icon never changes with live state; bottleneck/load are surfaced
  // separately via the badge above, the base alarm ring, and the
  // utilization pip.
  const asset = stationAsset(s.machineCode);
  const machineHead = asset.color;

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
      {/* Sewing-machine table */}
      <g>
        {CuboidFaces({
          w,
          d,
          h: 0.8,
          top: SW_PAL.cream,
          left: SW_PAL.creamLo,
          right: SW_PAL.cream,
        })}
      </g>
      {/* Machine head on top — colour comes from the asset library
          (`MACHINE_CATALOG[machineCode].color`), so an SNL bobbin, a 4OL,
          and a flatlock each read as visually distinct equipment that
          stays consistent across views and runs. */}
      <g
        transform={(() => {
          const a = isoProj(0, d * 0.3, 0.8);
          const o = isoProj(0, 0, 0);
          return `translate(${a.sx - o.sx}, ${a.sy - o.sy})`;
        })()}
      >
        {CuboidFaces({
          w: w * 0.75,
          d: d * 0.4,
          h: 0.6,
          top: machineHead,
          left: shade(machineHead, -0.2),
          right: machineHead,
        })}
      </g>
      {/* Utilization pip on the machine head — small status light, doesn't
          recolour the equipment. Reads green / yellow / red against an
          otherwise-static silhouette. */}
      {(() => {
        const a = isoProj(w * 0.78, d * 0.35, 1.45);
        const o = isoProj(0, 0, 0);
        const pipCol = isHot
          ? SW_COLORS.alarm
          : occupancy > 0.7
            ? SW_PAL.yellow
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
      {/* Op label badge floating above */}
      {(() => {
        const p = isoProj(w / 2, d / 2, 1.7);
        return (
          <g transform={`translate(${p.sx}, ${p.sy})`} pointerEvents="none">
            <rect x={-42} y={-32} width={84} height={30} rx={4} fill="#0a0d12" stroke="#ffffff20" strokeWidth={1} />
            {/* Asset-typed colour chip on the left edge of the badge so the
                badge itself echoes the catalog colour of the workstation. */}
            <rect x={-42} y={-32} width={4} height={30} fill={asset.color} />
            <text
              x={-32}
              y={-21}
              fontFamily={SW_FONTS.mono}
              fontSize={10}
              fontWeight={900}
              fill="#fff"
              letterSpacing="0.05em"
            >
              {s.opCode ?? `OP-${index + 1}`}
            </text>
            <text
              x={36}
              y={-21}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={800}
              fill={asset.color}
              letterSpacing="0.05em"
            >
              {asset.glyph} {asset.label}
            </text>
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
        const p = isoProj(w / 2, d / 2, 2.6);
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
// Per-fixture role code stamped on the badge over an operator-family ambient
// block. Falls back to a generic "OPR" when the catalogId isn't a known
// op_*. Mirrors the role taxonomy in domain/workers.ts.
const OP_BADGE_CODE: Record<string, string> = {
  op_sewer: 'SEW',
  op_cutter: 'CUT',
  op_helper: 'HLP',
  op_super: 'SUP',
  op_qc: 'QC',
};

function IsoAmbientBlock({ amb, simTime }: { amb: AmbientLayout; simTime: number }) {
  const origin = isoProj(amb.gx, amb.gy);

  // Asset-family palette — keeps service blocks visually grouped on the
  // floor while staying distinct from the brand-coloured sewing line.
  const palette: Record<string, { top: string; left: string; right: string; label: string }> = {
    cut:   { top: SW_PAL.green,  left: shade(SW_PAL.green, -0.25), right: SW_PAL.green,  label: 'CUT'   },
    fix:   { top: SW_PAL.cream,  left: SW_PAL.creamLo,             right: SW_PAL.cream,  label: 'FIX'   },
    store: { top: SW_PAL.yellow, left: SW_PAL.yellowLo,            right: SW_PAL.yellow, label: 'STORE' },
    mh:    { top: SW_PAL.steel,  left: shade(SW_PAL.steel, -0.25), right: SW_PAL.steel,  label: 'MH'    },
    buf:   { top: SW_PAL.blue,   left: SW_PAL.blueLo,              right: SW_PAL.blue,   label: 'BUF'   },
    op:    { top: SW_PAL.red,    left: SW_PAL.redLo,               right: SW_PAL.red,    label: 'OPR'   },
    conv:  { top: SW_PAL.metal,  left: SW_PAL.metalLo,             right: SW_PAL.metal,  label: 'CONV'  },
    zone:  { top: SW_PAL.blue,   left: SW_PAL.blueLo,              right: SW_PAL.blue,   label: 'ZONE'  },
    arch:  { top: SW_PAL.steel,  left: SW_PAL.creamLo,             right: SW_PAL.steel,  label: 'ARCH'  },
    util:  { top: SW_PAL.steel,  left: shade(SW_PAL.steel, -0.3),  right: SW_PAL.steel,  label: 'UTIL'  },
    pml:   { top: SW_PAL.blue,   left: SW_PAL.blueLo,              right: SW_PAL.blue,   label: 'PML'   },
    sew:   { top: SW_PAL.cream,  left: SW_PAL.creamLo,             right: SW_PAL.cream,  label: 'SEW'   },
  };
  const pal = palette[amb.cat] ?? palette.fix;

  // Buffers, mat-handling carts and operators sit at floor level — short
  // height so they don't overpower the engine stations.
  const h = Math.max(0.2, Math.min(amb.h, 1.6));

  // Operators get a tiny walking jitter so the scene feels alive even when
  // the sewing line is idle — the spreader / packer / supervisor crews
  // sway around their post.
  const jitterX = amb.cat === 'op' ? Math.cos(simTime * 1.2 + amb.gx) * 0.08 : 0;
  const jitterY = amb.cat === 'op' ? Math.sin(simTime * 1.2 + amb.gy) * 0.08 : 0;

  // ── Operator-family ambient blocks read as PEOPLE, not red cubes ─────────
  //
  // Every other `cat` (cut/fix/store/mh/buf/conv/zone/util/sew) is a piece
  // of equipment — a fabric rack, a press table, a buffer bin — and the
  // generic cuboid below renders fine. But `cat === 'op'` represents a
  // human post (supervisor stand, helper, QC seat, etc.) and the Builder
  // already has a rich isometric standing-figure for it via the catalog's
  // own `draw()` function. Delegating to that same function keeps Sim and
  // Builder visually identical: whatever silhouette the user sees when
  // they drop an `op_super` block in Builder is exactly what they see on
  // the simulation floor.
  if (amb.cat === 'op') {
    const fixture = ISO_FIXTURE_CATALOG.find((f) => f.id === amb.catalogId);
    const figH = fixture?.h ?? 2.4;
    const j = isoProj(jitterX, jitterY, 0);
    const o = isoProj(0, 0, 0);
    const badgeCode = OP_BADGE_CODE[amb.catalogId] ?? 'OPR';
    return (
      <g transform={`translate(${origin.sx}, ${origin.sy})`} pointerEvents="none">
        {/* Foot shadow — tight ellipse under the figure (smaller than the
            generic cuboid shadow because a person has a tighter footprint
            than a fabric rack). */}
        {(() => {
          const c = isoProj(amb.w / 2 + jitterX, amb.d / 2 + jitterY, 0);
          return (
            <ellipse
              cx={c.sx - o.sx}
              cy={c.sy - o.sy + 3}
              rx={amb.w * 9}
              ry={amb.d * 4}
              fill="#0F141955"
            />
          );
        })()}
        {/* The figure itself — Builder catalog's draw(), called with this
            block's footprint and rotation. If the fixture lookup fails for
            any reason, we still keep the scene populated by falling back
            to the small IsoOperatorBody silhouette used by the walking
            sewing crew. */}
        <g transform={`translate(${j.sx - o.sx}, ${j.sy - o.sy})`}>
          {fixture
            ? fixture.draw({ w: amb.w, d: amb.d, h: figH, r: amb.rotation })
            : (() => {
                const c = isoProj(amb.w / 2, amb.d / 2, 0);
                return (
                  <g transform={`translate(${c.sx - o.sx}, ${c.sy - o.sy})`}>
                    <IsoOperatorBody working={false} />
                  </g>
                );
              })()}
        </g>
        {/* Role badge — sits above the figure's head, encoding the specific
            op role (SUP / QC / HLP / SEW / CUT) so the user can scan the
            floor and tell a supervisor stand from a QC seat at a glance. */}
        {(() => {
          const p = isoProj(amb.w / 2 + jitterX, amb.d / 2 + jitterY, figH + 0.25);
          return (
            <g transform={`translate(${p.sx - o.sx}, ${p.sy - o.sy})`}>
              <rect x={-12} y={-9} width={24} height={10} rx={2} fill="#0a0d12cc" stroke={amb.deptColor} strokeWidth={0.8} />
              <text
                x={0}
                y={-2}
                textAnchor="middle"
                fontFamily={SW_FONTS.mono}
                fontSize={6}
                fontWeight={900}
                fill={amb.deptColor}
                letterSpacing="0.1em"
              >
                {badgeCode}
              </text>
            </g>
          );
        })()}
      </g>
    );
  }

  return (
    <g transform={`translate(${origin.sx}, ${origin.sy})`} opacity={0.78} pointerEvents="none">
      {/* Shadow under the block — sells the height. */}
      {(() => {
        const c = isoProj(amb.w / 2 + jitterX, amb.d / 2 + jitterY, 0);
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
      <g
        transform={(() => {
          const a = isoProj(jitterX, jitterY, 0);
          const o = isoProj(0, 0, 0);
          return `translate(${a.sx - o.sx}, ${a.sy - o.sy})`;
        })()}
      >
        {CuboidFaces({
          w: amb.w,
          d: amb.d,
          h,
          top: pal.top,
          left: pal.left,
          right: pal.right,
        })}
      </g>
      {/* Small category-tag pip on top — a 6×6 brand-coloured square that
          encodes the block role so the user can scan the floor and tell
          a rack from a cart from a press. */}
      {(() => {
        const p = isoProj(amb.w / 2, amb.d / 2, h + 0.15);
        return (
          <g transform={`translate(${p.sx}, ${p.sy})`}>
            <rect x={-12} y={-9} width={24} height={10} rx={2} fill="#0a0d12cc" stroke={amb.deptColor} strokeWidth={0.8} />
            <text
              x={0}
              y={-2}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={6}
              fontWeight={900}
              fill={amb.deptColor}
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

function SimTopView({ stations, bottleneckOpIndex, garmentName, simTime, twinMeta, selectedOpId, onSelectStation }: SimViewProps) {
  if (stations.length === 0) return <svg style={{ width: '100%', height: '100%' }} />;
  const VIEWBOX_W = 1200;
  const VIEWBOX_H = 600;
  const stationCount = stations.length;
  const perRow = Math.min(stationCount, 12);
  const rows = Math.ceil(stationCount / perRow);
  const xStep = (VIEWBOX_W - 200) / Math.max(1, perRow - 1);
  const xStart = perRow === 1 ? VIEWBOX_W / 2 : 100;
  const yStart = rows === 1 ? VIEWBOX_H / 2 : 200;
  const yStep = rows > 1 ? 200 : 0;

  const twinPositions = twinPositionsForView(stations, twinMeta, VIEWBOX_W, VIEWBOX_H, 120, 120);
  const positions = twinPositions ?? stations.map((_, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    return { x: xStart + col * xStep, y: yStart + row * yStep };
  });

  return (
    <svg viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`} style={{ width: '100%', height: '100%' }}>
      <defs>
        <pattern id="sim-grid-top" width={40} height={40} patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#ffffff10" strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="#0d1219" />
      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="url(#sim-grid-top)" />

      {/* Title */}
      <text
        x={VIEWBOX_W / 2}
        y={28}
        textAnchor="middle"
        fill="#ffffff80"
        fontFamily={SW_FONTS.mono}
        fontSize={12}
        fontWeight={800}
        letterSpacing="2px"
      >
        {garmentName.toUpperCase()} · TOP 2D · BLUEPRINT FLOW
      </text>

      {/* Connecting flow line + animated WIP dots */}
      {Array.from({ length: rows }).map((_, r) => {
        const startCol = r * perRow;
        const endCol = Math.min(startCol + perRow, stationCount) - 1;
        if (endCol <= startCol) return null;
        const y = positions[startCol].y;
        return (
          <g key={`flow-${r}`}>
            <line
              x1={positions[startCol].x}
              y1={y}
              x2={positions[endCol].x}
              y2={y}
              stroke="#ffffff25"
              strokeWidth={3}
              strokeDasharray="6 6"
              style={{ animation: 'sim-march 1s linear infinite' }}
            />
            {/* WIP travelling dots */}
            {Array.from({ length: 6 }).map((_, k) => {
              const phase = ((simTime * 0.03 + k / 6 + r * 0.13) % 1 + 1) % 1;
              const x = positions[startCol].x + (positions[endCol].x - positions[startCol].x) * phase;
              return <circle key={k} cx={x} cy={y} r={4} fill={SW_COLORS.thread} opacity={0.85} />;
            })}
          </g>
        );
      })}

      {stations.map((s, i) => {
        const { x, y } = positions[i];
        const isHot = i === bottleneckOpIndex && s.queueLen > 0;
        const isSelected = s.opId === selectedOpId;
        const occupancy = s.serversTotal > 0 ? s.busy / s.serversTotal : 0;
        return (
          <g
            key={`${s.opId}-${i}`}
            transform={`translate(${x}, ${y})`}
            onClick={onSelectStation ? (e) => { e.stopPropagation(); onSelectStation(s.opId); } : undefined}
            style={onSelectStation ? { cursor: 'pointer' } : undefined}
          >
            {isSelected && (
              <rect x={-42} y={-56} width={84} height={112} rx={8} fill="none" stroke={SW_COLORS.brand} strokeWidth={3} />
            )}
            <rect
              x={-36}
              y={-50}
              width={72}
              height={100}
              rx={6}
              fill={isHot ? `${SW_COLORS.alarm}30` : `${SW_COLORS.brand}20`}
              stroke={isHot ? SW_COLORS.alarm : `${SW_COLORS.brand}80`}
              strokeWidth={2}
            />
            <text
              x={0}
              y={-32}
              textAnchor="middle"
              fill="#ffffffaa"
              fontFamily={SW_FONTS.mono}
              fontSize={10}
              fontWeight={800}
            >
              {s.opCode ?? `OP-${i + 1}`}
            </text>
            <text x={0} y={-20} textAnchor="middle" fill="#ffffff60" fontFamily={SW_FONTS.mono} fontSize={8} fontWeight={700}>
              {s.smv.toFixed(2)}m
            </text>
            {/* Operators */}
            {Array.from({ length: Math.min(s.serversTotal, 3) }).map((_, k) => {
              const cx = (k - (Math.min(s.serversTotal, 3) - 1) / 2) * 18;
              const isWorking = k < s.busy;
              return (
                <g key={k} transform={`translate(${cx}, 0)`}>
                  <circle
                    cx={0}
                    cy={0}
                    r={9}
                    fill={isWorking ? (isHot ? SW_COLORS.alarm : SW_COLORS.bobbin) : '#ffffff30'}
                    stroke="#fff"
                    strokeWidth={1.5}
                  />
                  {isWorking && (
                    <circle
                      cx={0}
                      cy={0}
                      r={12 + Math.sin(simTime * 2 + i + k) * 2}
                      fill="none"
                      stroke={SW_COLORS.brand}
                      strokeWidth={1}
                      opacity={0.4}
                    />
                  )}
                </g>
              );
            })}
            {/* Queue */}
            <g transform="translate(-26, 25)">
              {Array.from({ length: Math.min(s.queueLen, 12) }).map((_, k) => (
                <rect
                  key={k}
                  x={(k % 4) * 7}
                  y={Math.floor(k / 4) * 5}
                  width={6}
                  height={4}
                  fill={SW_COLORS.thread}
                  opacity={0.9 - k * 0.04}
                />
              ))}
              {s.queueLen > 12 && (
                <text x={38} y={14} fill={SW_COLORS.thread} fontFamily={SW_FONTS.mono} fontSize={10} fontWeight={800}>
                  +{s.queueLen - 12}
                </text>
              )}
            </g>
            {/* Util bar */}
            <g transform="translate(-30, 42)">
              <rect x={0} y={0} width={60} height={4} fill="#ffffff15" />
              <rect x={0} y={0} width={60 * occupancy} height={4} fill={isHot ? SW_COLORS.alarm : SW_COLORS.ok} />
              <text x={0} y={16} fill="#ffffff80" fontFamily={SW_FONTS.mono} fontSize={8} fontWeight={700}>
                {s.busy}/{s.serversTotal}
              </text>
            </g>
            {isHot && (
              <g>
                <circle cx={26} cy={-44} r={6} fill={SW_COLORS.alarm}>
                  <animate attributeName="r" values="6;9;6" dur="0.8s" repeatCount="indefinite" />
                </circle>
                <text x={26} y={-40} textAnchor="middle" fill="#fff" fontFamily={SW_FONTS.display} fontSize={9} fontWeight={900}>
                  !
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ============================================================================
// HEAT VIEW
// ============================================================================

function SimHeatView({ stations, bottleneckOpIndex, garmentName, twinMeta }: SimViewProps) {
  if (stations.length === 0) return <svg style={{ width: '100%', height: '100%' }} />;
  const VIEWBOX_W = 1200;
  const VIEWBOX_H = 600;
  const perRow = Math.min(stations.length, 12);
  const rows = Math.ceil(stations.length / perRow);
  const xStep = (VIEWBOX_W - 200) / Math.max(1, perRow - 1);
  const xStart = perRow === 1 ? VIEWBOX_W / 2 : 100;
  const yStart = rows === 1 ? VIEWBOX_H / 2 : 200;
  const yStep = rows > 1 ? 200 : 0;
  const twinPositions = twinPositionsForView(stations, twinMeta, VIEWBOX_W, VIEWBOX_H, 140, 120);
  const positions = twinPositions ?? stations.map((_, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    return { x: xStart + col * xStep, y: yStart + row * yStep };
  });

  return (
    <svg viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`} style={{ width: '100%', height: '100%' }}>
      <defs>
        {stations.map((s, i) => {
          const isHot = i === bottleneckOpIndex && s.queueLen > 0;
          const intensity = isHot
            ? 1
            : Math.min(1, 0.2 + (s.serversTotal > 0 ? s.busy / s.serversTotal : 0) * 0.7 + Math.min(0.5, s.queueLen / 10));
          const col = isHot ? SW_COLORS.alarm : intensity > 0.7 ? SW_COLORS.warn : SW_COLORS.ok;
          return (
            <radialGradient key={`hg-${s.opId}-${i}`} id={`sim-heat-${s.opId}-${i}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={col} stopOpacity={intensity} />
              <stop offset="100%" stopColor={col} stopOpacity={0} />
            </radialGradient>
          );
        })}
        <linearGradient id="sim-heat-legend" x1="0%" x2="100%">
          <stop offset="0%" stopColor={SW_COLORS.ok} />
          <stop offset="60%" stopColor={SW_COLORS.warn} />
          <stop offset="100%" stopColor={SW_COLORS.alarm} />
        </linearGradient>
      </defs>

      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="#0d1219" />

      {/* Title */}
      <text
        x={VIEWBOX_W / 2}
        y={28}
        textAnchor="middle"
        fill="#ffffff80"
        fontFamily={SW_FONTS.mono}
        fontSize={12}
        fontWeight={800}
        letterSpacing="2px"
      >
        {garmentName.toUpperCase()} · HEAT · UTIL × QUEUE PRESSURE
      </text>

      {/* Heat blobs */}
      {stations.map((s, i) => (
        <circle
          key={`blob-${s.opId}-${i}`}
          cx={positions[i].x}
          cy={positions[i].y}
          r={120}
          fill={`url(#sim-heat-${s.opId}-${i})`}
          style={{ mixBlendMode: 'screen' }}
        />
      ))}

      {/* Station markers + label */}
      {stations.map((s, i) => {
        const isHot = i === bottleneckOpIndex && s.queueLen > 0;
        return (
          <g key={`mk-${s.opId}-${i}`} transform={`translate(${positions[i].x}, ${positions[i].y})`}>
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
              {s.opCode ?? `OP-${i + 1}`}
            </text>
            <text y={20} textAnchor="middle" fontFamily={SW_FONTS.mono} fontSize={8} fill="#ffffff80">
              Q={s.queueLen} · {s.busy}/{s.serversTotal}
            </text>
          </g>
        );
      })}

      {/* Legend */}
      <g transform={`translate(${VIEWBOX_W - 220}, 50)`}>
        <rect width={200} height={62} fill="#0a0d12cc" stroke="#ffffff20" rx={4} />
        <text x={12} y={20} fill="#fff" fontFamily={SW_FONTS.mono} fontSize={10} fontWeight={900} letterSpacing="0.15em">
          PRESSURE HEAT
        </text>
        <rect x={12} y={30} width={176} height={10} fill="url(#sim-heat-legend)" />
        <text x={12} y={54} fill="#ffffff80" fontFamily={SW_FONTS.mono} fontSize={9}>
          flowing
        </text>
        <text x={188} y={54} fill="#ffffff80" fontFamily={SW_FONTS.mono} fontSize={9} textAnchor="end">
          choked
        </text>
      </g>
    </svg>
  );
}

// ============================================================================
// LOGIC VIEW — block-flow / schema diagram (AnyLogic-style)
// ============================================================================
//
// Each operation becomes a flow card with its OP code, SMV, queue length,
// busy/total servers, and live throughput. Cards are connected in routing
// order with marching arrows, so the user can see WHERE in the logical flow
// the bottleneck sits — independent of physical layout.

function SimLogicView({ stations, bottleneckOpIndex, garmentName, simTime, twinMeta }: SimViewProps) {
  // Measure the parent container so the operation grid can pick a
  // cols × rows shape whose aspect ratio matches the available area —
  // otherwise the fixed 1200×1790 viewBox letterboxes hard on a wide
  // landscape canvas and the cards render postage-stamp small.
  const wrapRef = useRef(null as HTMLDivElement | null);
  const [contSize, setContSize] = useState({ w: 1200, h: 700 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setContSize({ w: r.width, h: r.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (stations.length === 0) {
    return (
      <div ref={wrapRef} style={{ width: '100%', height: '100%' }}>
        <svg style={{ width: '100%', height: '100%' }} />
      </div>
    );
  }

  // Cards carry an explicit label for every number; flow connectors are
  // bright and thick so the routing reads at a glance.
  const CARD_W = 260;
  const CARD_H = 210;
  const PAD_X = 40;
  const PAD_TOP = 70;
  const PAD_BOTTOM = 110;
  const ROW_GAP = 70;
  const COL_GAP = 56;

  // Pick the cols count that yields an SVG aspect ratio closest to the
  // container's — that way `preserveAspectRatio="xMidYMid meet"` fills
  // the canvas with no letterboxing and cards render as large as possible.
  const targetRatio = contSize.w / Math.max(1, contSize.h);
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
  const rows = Math.ceil(stations.length / cols);
  const W = PAD_X * 2 + cols * CARD_W + (cols - 1) * COL_GAP;
  const H = PAD_TOP + rows * CARD_H + (rows - 1) * ROW_GAP + PAD_BOTTOM;

  const twinPositions = twinPositionsForView(stations, twinMeta, W - CARD_W, H - CARD_H, PAD_X, PAD_TOP);
  const positions = stations.map((_, i) => {
    const row = Math.floor(i / cols);
    const rawCol = i % cols;
    const col = row % 2 === 0 ? rawCol : cols - 1 - rawCol;
    if (twinPositions) {
      return { x: twinPositions[i].x, y: twinPositions[i].y, col, row };
    }
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
    <div ref={wrapRef} style={{ width: '100%', height: '100%' }}>
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <pattern id="sim-logic-grid" width={32} height={32} patternUnits="userSpaceOnUse">
          <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#ffffff06" strokeWidth={1} />
        </pattern>
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
      <rect width={W} height={H} fill="#0d1219" />
      <rect width={W} height={H} fill="url(#sim-logic-grid)" />

      <text
        x={W / 2}
        y={36}
        textAnchor="middle"
        fill="#ffffffcc"
        fontFamily={SW_FONTS.mono}
        fontSize={13}
        fontWeight={800}
        letterSpacing="2px"
      >
        {garmentName.toUpperCase()} · LOGIC · OPERATION FLOW SCHEMA
      </text>

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
        // Card accent = machine-type colour from the asset library. Stays
        // stable as the sim runs; bottleneck state is communicated by a
        // separate red outline + alarm pip below, not by recolouring the
        // identity strip itself.
        const cardAsset = stationAsset(s.machineCode);
        const accent = cardAsset.color;
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
              {s.opCode ?? `OP-${i + 1}`}
            </text>
            {/* Machine-type tag on the right of the header strip — single
                glyph + short name pulled from the asset library so the
                card always announces the equipment that runs this op. */}
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

            {/* Op name + SMV. */}
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

      {/* Legend — colour-coded swatches with explicit labels for each tier. */}
      <g transform={`translate(${PAD_X}, ${H - 80})`}>
        <rect width={W - PAD_X * 2} height={56} fill="#0a0d12cc" stroke="#ffffff20" rx={6} />
        <text
          x={16}
          y={22}
          fill="#fff"
          fontFamily={SW_FONTS.mono}
          fontSize={11}
          fontWeight={900}
          letterSpacing="0.2em"
        >
          LEGEND
        </text>
        {[
          { color: SW_COLORS.ok, label: 'Healthy flow (util < 85%)' },
          { color: SW_COLORS.warn, label: 'Warming (util ≥ 85%)' },
          { color: SW_COLORS.alarm, label: 'Bottleneck (queue building)' },
          { color: SW_COLORS.brand, label: 'Operation card · throughput' },
        ].map((it, i) => (
          <g key={i} transform={`translate(${90 + i * 245}, 14)`}>
            <rect width={14} height={14} rx={3} fill={it.color} />
            <text
              x={22}
              y={11}
              fill="#ffffffcc"
              fontFamily={SW_FONTS.mono}
              fontSize={10}
              fontWeight={700}
            >
              {it.label}
            </text>
          </g>
        ))}
        <text
          x={16}
          y={42}
          fill="#ffffff80"
          fontFamily={SW_FONTS.mono}
          fontSize={10}
          fontWeight={600}
        >
          Connectors flow left-to-right and snake across rows. Arrow colour matches the upstream station's pressure tier.
        </text>
      </g>
    </svg>
    </div>
  );
}

// ============================================================================
// PML VIEW — block-graph snapshot of the active twin
// ============================================================================
//
// Reads `kpiObserved` off each workstation in the active twin and renders
// a card grid sorted by throughput. Inline `▶ Run PML` button kicks off
// a fresh sim against the active twin without leaving this page. Skips
// the per-tick streaming animation that the legacy views have — the PML
// engine is one-shot for v1; per-minute timeseries playback is scoped to
// a follow-up turn (the engine needs to record samples first).

interface SimPmlViewProps {
  garment: GarmentTemplate;
  operators: number;
  /** True when a reference paper has been loaded — currently unused beyond
   *  the playback-reset effect since we always build from the garment prop
   *  (which already folds in the reference's garmentTemplate when loaded). */
  hasReference: boolean;
  /** Dept/factory scope — run PML against the actual twin (every block,
   *  every line, every garment) instead of a single-garment synth. PML is
   *  twin-native: `runPmlOnTwin` already simulates every block in the twin
   *  in one pass, so multi-line is just a matter of feeding the real twin
   *  instead of a synthetic one. Defaults to false (single-line scope keeps
   *  the synth so swapping garment in the HUD reshapes the grid). */
  useActiveTwin?: boolean;
}

// In single-line scope the PML view synthesises a Source → ops → Sink twin
// from the garment prop so picking a different garment in LiveSim's HUD
// immediately reshapes the block grid. In dept/factory scope we drive PML
// from the active twin directly — that's the only honest way to surface
// every wired line's Petri-net behaviour in one pass.
function SimPmlView({ garment, operators, hasReference, useActiveTwin = false }: SimPmlViewProps) {
  const activeTwin = useTwin(selectActiveTwin);
  const garmentTwin = useMemo(
    () => (useActiveTwin ? null : buildGarmentTwin(garment, operators)),
    [garment, operators, useActiveTwin],
  );
  const twin = garmentTwin ?? activeTwin;
  /** Last completed run, retained so the timeline can scrub through it. */
  const [report, setReport] = useState<RunReport | null>(null);
  /** Index into report.raw.samples — the frame currently rendered. */
  const [frame, setFrame] = useState(0);
  /** Wall-clock playback state. Each tick advances `frame` by 1. */
  const [playing, setPlaying] = useState(false);
  /** Sim-minutes per real-second (1× = real time, 60× = 1 sim-min/sec). */
  const [speed, setSpeed] = useState(60);

  // When the user switches garment / operator count / reference flag, the
  // previous report's workstation ids no longer match the new twin's stations
  // — every block card would vanish. Reset playback state so the user sees
  // the empty "Run PML" prompt for the new twin instead of stale empty cards.
  useEffect(() => {
    setReport(null);
    setFrame(0);
    setPlaying(false);
  }, [hasReference, garment.id, operators, useActiveTwin]);

  const samples = report?.raw.samples ?? [];
  const lastFrame = Math.max(0, samples.length - 1);
  const currentSample = samples[Math.min(frame, lastFrame)];
  const simMin = currentSample?.time ?? 0;

  // Playback loop. Advances `frame` every 50ms by `speed/20` sim-minutes
  // (so speed=60 → 3 sim-min per 50ms = 60 sim-min/sec wall-clock).
  // Uses setInterval rather than rAF so playback continues smoothly even
  // when the tab is in the background or under a hidden preview frame.
  useEffect(() => {
    if (!playing || samples.length === 0) return;
    const STEP_MS = 50;
    const id = setInterval(() => {
      setFrame((f) => {
        const advance = Math.max(1, Math.round((speed * STEP_MS) / 1000));
        const next = f + advance;
        if (next >= lastFrame) {
          setPlaying(false);
          return lastFrame;
        }
        return next;
      });
    }, STEP_MS);
    return () => clearInterval(id);
  }, [playing, samples.length, speed, lastFrame]);
  // Suppress unused-import lint until/unless we revisit rAF playback.
  void useRef;

  /** Build the per-block render list for the current frame. Throughput
   *  is computed from cumulative pieces / elapsed sim hours, so the
   *  numbers ramp up smoothly as playback advances. */
  const blockData = useMemo(() => {
    if (!currentSample || samples.length === 0) return [];
    const elapsedHr = currentSample.time / 60;
    return twin.workstations
      .map((w) => {
        const snap = currentSample.blocks[w.id];
        if (!snap) return null;
        const spec = getBlockSpec(w);
        const tputPerHr = elapsedHr > 0 ? snap.producedPieces / elapsedHr : 0;
        const obs = report?.raw.blocks.get(w.id);
        return {
          ws: w,
          spec,
          role: apparelRoleFor(w),
          producedPieces: snap.producedPieces,
          queueLen: snap.queueLen,
          inService: snap.inService,
          throughputPerHr: tputPerHr,
          // util only makes sense for resource-using blocks at the run-end;
          // mid-playback we show the live queue instead.
          utilizationPct: obs?.utilization ? obs.utilization * 100 : 0,
          bottleneck: obs?.bottleneck ?? false,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((b) => b.producedPieces > 0 || b.queueLen > 0 || b.inService > 0)
      .sort((a, b) => b.throughputPerHr - a.throughputPerHr);
  }, [twin, currentSample, samples.length, report]);

  const sinkThroughput = blockData
    .filter((b) => b.spec.kind === 'Sink')
    .reduce((s, b) => s + b.throughputPerHr, 0);
  const bottleneck = blockData.find((b) => b.bottleneck);

  const runIt = () => {
    // Synthesised twin's workstation ids aren't in the store, so we skip
    // writeKpiObserved — a silent no-op anyway. The Reports page still has
    // its own auto-run that writes against the active store twin.
    const r = runPmlOnTwin(twin, { samplePeriodMin: 1 });
    setReport(r);
    setFrame(0);
    setPlaying(true);
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: 24,
        overflow: 'auto',
        color: '#fff',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontFamily: SW_FONTS.display, fontSize: 18, fontWeight: 900, letterSpacing: '0.06em' }}>
          ⚙ PML SIMULATION
        </div>
        <div style={{ fontSize: 12, color: '#ffffffaa', fontFamily: SW_FONTS.mono }}>
          {twin.name} · {twin.workstations.length} blocks · {twin.connectors.length} connectors
        </div>
        <div style={{ flex: 1 }} />
        <Button variant="primary" size="sm" icon="▶" onClick={runIt}>
          Run PML
        </Button>
      </div>

      {/* Playback strip — only shown after a run has produced samples. */}
      {samples.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 16,
            padding: '8px 12px',
            background: '#ffffff08',
            border: '1px solid #ffffff20',
            borderRadius: 6,
          }}
        >
          <button
            onClick={() => setPlaying((p) => !p)}
            disabled={frame >= lastFrame && !playing}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: playing ? SW_COLORS.alarm : SW_COLORS.brand,
              border: 'none',
              color: '#fff',
              fontSize: 14,
              fontWeight: 900,
              cursor: 'pointer',
            }}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            onClick={() => {
              setFrame(0);
              setPlaying(false);
            }}
            style={{
              padding: '4px 10px',
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 800,
              color: '#fff',
              background: 'transparent',
              border: '1px solid #ffffff30',
              borderRadius: 4,
              cursor: 'pointer',
            }}
            title="Restart"
          >
            ↻ RESTART
          </button>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 13, fontWeight: 700, minWidth: 80, color: SW_COLORS.brand }}>
            t = {simMin.toFixed(0)} min
          </div>
          <input
            type="range"
            min={0}
            max={lastFrame}
            value={frame}
            onChange={(e) => {
              setFrame(parseInt(e.target.value));
              setPlaying(false);
            }}
            style={{ flex: 1, accentColor: SW_COLORS.brand }}
          />
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: '#ffffff80' }}>
            {frame + 1} / {samples.length}
          </div>
          <HudSelect
            value={String(speed)}
            onChange={(v) => setSpeed(parseInt(v))}
            mono
            size="sm"
            minWidth={150}
            title="Sim-minutes per wall-clock-second"
            options={[
              { value: '15', label: '15×', meta: 'SLOW' },
              { value: '60', label: '60×' },
              { value: '240', label: '240×', meta: 'FAST' },
              { value: '480', label: '480×', meta: 'FASTEST' },
            ]}
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        <SimHudStat label="SINK THROUGHPUT" value={Math.round(sinkThroughput).toLocaleString()} unit="pcs/hr" color={SW_COLORS.brand} />
        <SimHudStat label="SUNK PIECES"     value={(currentSample?.totalSunkPieces ?? 0).toLocaleString()}    unit=""        color={SW_COLORS.fabric} />
        <SimHudStat label="BOTTLENECK"      value={bottleneck ? bottleneck.ws.name.slice(0, 18) : '—'}        unit=""        color={bottleneck ? SW_COLORS.alarm : '#ffffff60'} />
        <SimHudStat label="MAX UTIL"        value={Math.max(0, ...blockData.map((b) => b.utilizationPct)).toFixed(0)} unit="%" color={SW_COLORS.thread} />
      </div>

      {blockData.length === 0 ? (
        <div
          style={{
            padding: '40px 24px',
            textAlign: 'center',
            border: '1px dashed #ffffff30',
            borderRadius: 8,
            color: '#ffffff80',
            fontFamily: SW_FONTS.mono,
          }}
        >
          {samples.length === 0
            ? <>No PML run on this twin yet. Click <strong style={{ color: SW_COLORS.brand }}>▶ Run PML</strong> to simulate the wired graph.</>
            : 'No flow yet at this time. Press play to advance the timeline.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {blockData.map((b) => (
            <SimPmlCard key={b.ws.id} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

interface PmlCardData {
  ws: Workstation;
  spec: ReturnType<typeof getBlockSpec>;
  role: string;
  producedPieces: number;
  queueLen: number;
  inService: number;
  throughputPerHr: number;
  utilizationPct: number;
  bottleneck: boolean;
}

/** One block card in the PML view, fed by a per-frame snapshot so values
 *  ramp up as playback advances. */
function SimPmlCard({ block: b }: { block: PmlCardData }) {
  return (
    <div
      style={{
        padding: 12,
        background: b.bottleneck ? '#3a1212' : '#ffffff08',
        border: `1px solid ${b.bottleneck ? SW_COLORS.alarm : '#ffffff20'}`,
        borderLeft: `4px solid ${b.bottleneck ? SW_COLORS.alarm : SW_COLORS.brand}`,
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        color: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-flex', color: SW_COLORS.brand }}>
          <b.spec.spec.Icon size={16} color={SW_COLORS.brand} />
        </span>
        <span style={{ fontFamily: SW_FONTS.display, fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', color: '#ffffffcc' }}>
          {b.spec.kind.toUpperCase()}
        </span>
        {b.bottleneck && (
          <span style={{ marginLeft: 'auto', fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 800, color: SW_COLORS.alarm, letterSpacing: '0.1em' }}>
            ◆ BOTTLENECK
          </span>
        )}
      </div>
      <div style={{ fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
        {b.ws.name}
      </div>
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: '#ffffff80' }}>
        {b.role}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
        <div>
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 18, fontWeight: 900, color: '#fff' }}>
            {Math.round(b.throughputPerHr).toLocaleString()}
          </span>
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: '#ffffff80', marginLeft: 4 }}>
            pcs/hr
          </span>
        </div>
        {b.queueLen + b.inService > 0 && (
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.thread }}>
            Q {b.queueLen + b.inService}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SEWING LINES STRIP — per-line KPI cards above the canvas
// ============================================================================

/**
 * Horizontal strip of cards, one per sewing line in the active twin, plus an
 * "ALL LINES" pill that resets the scope. Selecting a card writes `?line=<id>`
 * to the URL; LiveSim re-reads that on the next render to rebuild the engine
 * scope. The card surfaces the line's name, production system, dominant
 * garment, simulated workstation count and a seed throughput derived from the
 * line's own bottleneck cycle.
 */
function SewingLinesStrip({
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
  // Departments that contain at least one wired line. When the twin only has
  // a single such dept, "DEPT · X" would be a duplicate of "FACTORY" — hide
  // it to keep the strip clean. The picker grows naturally when the user
  // adds a second sewing dept (or a finishing line in another dept).
  const deptsWithLines = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; count: number }>();
    for (const lb of lineBuilds) {
      if (!lb.ok) continue;
      const dept = (activeTwin.departments ?? []).find((d) => d.id === lb.line.deptId);
      if (!dept) continue;
      const entry = seen.get(dept.id);
      if (entry) entry.count += 1;
      else seen.set(dept.id, { id: dept.id, name: dept.name, count: 1 });
    }
    return [...seen.values()];
  }, [lineBuilds, activeTwin.departments]);
  const showDeptPills = deptsWithLines.length > 1;
  return (
    <div
      style={{
        padding: '8px 24px',
        borderBottom: '1px solid #ffffff15',
        background: '#0a0d12',
        display: 'flex',
        alignItems: 'stretch',
        gap: 10,
        overflowX: 'auto',
      }}
    >
      <span
        style={{
          alignSelf: 'center',
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.18em',
          color: SW_COLORS.brand,
        }}
      >
        SEWING LINES
      </span>

      <button
        onClick={() => onPickScope({ kind: 'factory' })}
        title="Simulate every wired sewing line in the twin — one engine per line, transport bar drives them together"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minWidth: 120,
          padding: '6px 12px',
          borderRadius: 6,
          border: `1px solid ${factoryActive ? SW_COLORS.brand : '#ffffff20'}`,
          background: factoryActive ? `${SW_COLORS.brand}26` : 'transparent',
          color: '#fff',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontFamily: SW_FONTS.display, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em' }}>
          {showDeptPills ? 'FACTORY' : 'ALL LINES'}
        </span>
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: '#ffffffaa' }}>
          {activeTwin.workstations.length} workstations · whole twin
        </span>
      </button>

      {showDeptPills && deptsWithLines.map((d) => {
        const active = scope.kind === 'dept' && scope.id === d.id;
        return (
          <button
            key={d.id}
            onClick={() => onPickScope({ kind: 'dept', id: d.id })}
            title={`Scope the engine to every wired line in ${d.name} (${d.count} line${d.count === 1 ? '' : 's'})`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 140,
              padding: '6px 12px',
              borderRadius: 6,
              border: `1px solid ${active ? SW_COLORS.fabric : '#ffffff20'}`,
              background: active ? `${SW_COLORS.fabric}26` : 'transparent',
              color: '#fff',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontFamily: SW_FONTS.display, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em' }}>
              DEPT · {d.name.toUpperCase()}
            </span>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: '#ffffffaa' }}>
              {d.count} line{d.count === 1 ? '' : 's'}
            </span>
          </button>
        );
      })}

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
            onClick={() => onPickScope({ kind: 'line', id: line.id })}
            title={
              ok
                ? `Scope the engine to ${line.name} — ${ops} operations on ${memberCount} workstation${memberCount === 1 ? '' : 's'}.`
                : `Line not runnable yet — ${reason ?? 'no simulatable workstation'}.`
            }
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 200,
              padding: '6px 12px',
              borderRadius: 6,
              border: `1px solid ${active ? accent : '#ffffff20'}`,
              borderLeft: `4px solid ${accent}`,
              background: active ? `${accent}26` : 'transparent',
              color: '#fff',
              cursor: 'pointer',
              textAlign: 'left',
              opacity: ok ? 1 : 0.6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: SW_FONTS.display, fontSize: 11, fontWeight: 800, letterSpacing: '0.06em' }}>
                {line.name}
              </span>
              {!ok && (
                <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, color: SW_COLORS.warn, fontWeight: 800 }}>
                  · EMPTY
                </span>
              )}
            </div>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: '#ffffffaa' }}>
              {line.productionSystem.toUpperCase()}
              {line.garmentId ? ` · ${line.garmentId}` : ''}
              {' · '}
              {memberCount} workstation{memberCount === 1 ? '' : 's'}
            </span>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: ok ? SW_COLORS.ok : '#ffffff60' }}>
              {ok
                ? `${ops} operations · seed ${seedPiecesPerHr.toLocaleString()} pcs/hr`
                : 'drop machines + assign opIds to wire this line'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Department-colour palette mirrored from Builder so the line strip's accent
 *  bar matches the canvas band. Hard-coded here (rather than imported from
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
        {open ? '▾' : '▸'} CURVES {ready ? '' : '· press play'}
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
