/**
 * Factory Builder — the authoring surface for the new Twin model.
 *
 * Architecture (locked 2026-05-07):
 *   • One drawable layer: Workstation (machines, tables, racks) placed freely
 *     on an unzoned floor. Sewing lines group stations logically, not spatially.
 *   • Three lenses (Operations · Resources · KPIs) decorate the same scene.
 *     Toggling a lens never changes the underlying data — it changes overlays
 *     and which inspector group is highlighted.
 *   • Scenario = a fork of the canonical twin. Switch scenarios with the picker
 *     in the top toolbar; edits route to whichever twin is active.
 *
 * This page reads/writes through the `useTwin` store. It is the single
 * authoring surface for the factory digital twin — there is no separate
 * "iso builder" anymore.
 */

import {
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PML_CATEGORY_TINT, SW_COLORS, SW_CONTROL, SW_FONTS, SW_MOTION, SW_RADIUS, SW_SHADOWS, SW_TYPE } from '../design/tokens';
import { alpha, contrastInk } from '../design/color-utils';
import {
  Caret,
  Chevron,
  HudSelect,
  Icon,
  StationGlyph,
  BlockParamRow,
  StationTypeDialog,
  CanvasGrid,
  CanvasLegend,
  PmlBlockFace,
  ViewSwitch,
  Sym,
  ViewTitle,
  ZoomHud,
  useCanvasCamera,
  useConfirm,
} from '../components';
import { ProcessCodeView } from '../components/ProcessCodeView';
import { ServiceQueueParams } from '../components/ServiceQueueParams';
import {
  APPAREL_CATEGORIES,
  APPAREL_FIXTURE_PALETTE,
  ptsToStr,
  type IsoFixture,
  type GarmentTemplate,
  type Projection,
  ISO_PROJECTION,
  FLAT_PROJECTION,
  lerpProjection,
  FLAT_CELL,
  ISO_FIXTURE_TO_MACHINE_CODE,
  CAM_IDENTITY,
  fitBounds,
  visibleCellRange,
  lookupFixture,
  resolveBlockKindForDrop,
  stationMark,
  stationTypeFor,
  type StationType,
  type Cam,
} from '../domain';
import {
  useTwin,
  selectActiveTwin,
  type EntityColorKey,
} from '../store/twin';
import { useProject, useFactoryLibrary, useGarments } from '../store';
import type {
  Assignment,
  Workstation,
  Connector,
  ConnectorKind,
  Operator,
  SewingLine,
  LinePolicy,
} from '../domain/twin';
import { defaultPolicyFor, lineSystemBadge, shareDebtForLine, validateTwinWarnings } from '../domain/twin';
import {
  getBlockSpec,
  getBlockParams,
  apparelRoleFor,
  inferBlockKindFromCatalog,
  pmlFixtureId,
  PML_BLOCK_LIBRARY,
  PARAM_FIELDS_BY_KIND,
  SELECTABLE_BLOCK_KINDS,
  type ParamFieldSpec,
  type PmlBlock,
  type PmlBlockKind,
  type PmlBlockOverride,
  type PmlBlockParams,
  type PmlPort,
} from '../domain/pml';
import {
  APPAREL_BLOCK_GROUPS,
  apparelPresetsInGroup,
  findApparelPreset,
  type ApparelBlockPreset,
  type ApparelPresetId,
} from '../domain/apparelPresets';
import {
  serversFor,
  systemCapacityFor,
  validatePmlGraph,
  type PmlIssue,
} from '../simulation/pml-engine';
import { classify } from '../simulation/queueing';
import { defaultDist } from '../simulation/distributions';
import { runPmlOnTwin } from '../simulation/pml-runner';
import {
  resolveProcessPositions,
  processContentBounds,
  computeProcessSeedPositions,
  PROCESS_BLOCK_W,
  PROCESS_BLOCK_H,
  PROCESS_PAD_X,
  PROCESS_PAD_TOP,
  snapProcess,
} from '../domain/processLayout';

// ============================================================================
// CONSTANTS
// ============================================================================

type Lens = 'operations' | 'resources' | 'kpis';
/** Canvas render mode:
 *  • 2d      — flat top-down authoring plan (default). Same grid, entities,
 *              and editing verbs as ISO; only the projection differs.
 *  • iso     — isometric 3D-feel authoring surface.
 *  • process — workstation-level PML diagram with explicit input/output ports
 *              (every entity is a Process Modeling Library block). */
type CanvasMode = '2d' | 'iso' | 'process';
type DropTool =
  | { kind: 'none' }
  | {
      kind: 'ws';
      catalogId: string;
      /** Apparel preset id the user dragged from the BLOCKS palette, when
       *  applicable. Drives default-param stamping + auto-naming at drop
       *  time. Absent for drops originating from the STATIONS palette
       *  (physical-fixture drops). */
      presetId?: import('../domain/apparelPresets').ApparelPresetId;
    };

const DEPT_COLOR_HEX: Record<EntityColorKey, string> = {
  fabric: SW_COLORS.fabric,
  thread: SW_COLORS.thread,
  brand: SW_COLORS.brand,
  red: SW_COLORS.alarm,
  blue: SW_COLORS.bobbin,
  yellow: SW_COLORS.thread,
  green: SW_COLORS.fabric,
  cream: SW_COLORS.paperEdge,
};

/** Connector colours by kind. Flow is the brand red (the dominant arrow on a
 *  factory drawing); operator + material are visually distinct so multiple
 *  overlays don't blur together. */
const CONNECTOR_HEX: Record<ConnectorKind, string> = {
  flow: SW_COLORS.brand,
  operator: SW_COLORS.bobbin,
  material: SW_COLORS.thread,
};

const CONNECTOR_LABEL: Record<ConnectorKind, string> = {
  flow: 'FLOW',
  operator: 'OPERATOR',
  material: 'MATERIAL',
};

/** Per-`MaterialFlow.carrier` visual style. Bundle is the heaviest line —
 *  it carries the most pieces per move. Piece flow is a thin solid line
 *  because each move is one unit. Hanger flow is dotted to suggest the
 *  small clips along an overhead rail. Takt flow is dashed long-short to
 *  evoke a metronome / belt pulse. Returned dash strings use SVG's
 *  `stroke-dasharray` grammar; `null` means "no dash". */
const CARRIER_STYLE: Record<
  'bundle' | 'piece' | 'hanger' | 'takt',
  { stroke: string; width: number; dash: string | null; label: string }
> = {
  bundle: { stroke: SW_COLORS.brand, width: 2.6, dash: null, label: 'B' },
  piece: { stroke: SW_COLORS.muted, width: 1.6, dash: null, label: 'P' },
  hanger: { stroke: SW_COLORS.brand, width: 2.0, dash: '1 4', label: 'H' },
  takt: { stroke: SW_COLORS.ink, width: 2.0, dash: '8 4', label: 'T' },
};

interface FlowStyle {
  stroke: string;
  width: number;
  dash: string | null;
  label: string | null;
}

/** Resolve a Connector to its render style. Flow connectors with a
 *  `flow.carrier` annotation get a per-carrier look; everything else
 *  falls through to the base ConnectorKind color so the existing
 *  operator/material/un-annotated-flow visuals don't regress. */
function flowStyleFor(c: Connector): FlowStyle {
  if (c.kind === 'flow' && c.flow?.carrier) {
    const s = CARRIER_STYLE[c.flow.carrier];
    return { stroke: s.stroke, width: s.width, dash: s.dash, label: s.label };
  }
  return {
    stroke: CONNECTOR_HEX[c.kind],
    width: c.kind === 'flow' ? 2.4 : 1.8,
    dash: c.kind === 'flow' ? null : '6 4',
    label: null,
  };
}

/** Opacity of unfocused entities while a selection is active. Tuned so dimmed
 *  shapes stay legible as context but the selection clearly pops. Used by
 *  all three Builder views (2d · iso · process) to render focus-dimming. */
const FOCUS_DIM = 0.22;

/** Resolve a catalog id to its IsoFixture entry — draw-fn, footprint and
 *  label. Goes through the registry, so a user-authored station type
 *  resolves exactly like a built-in fixture. */
function resolveFixture(catalogId: string): IsoFixture | undefined {
  return lookupFixture(catalogId);
}

/** Effective footprint for a workstation. Per-ws `size` override wins over
 *  the catalog fixture's defaults, so two SNLS machines can be different
 *  sizes. Values are decimal (no integer rounding).
 *
 *  When the workstation is rotated 90° or 270° on the build plane, the
 *  effective floor occupancy swaps w ↔ d — a 1 × 2 SNLS lying lengthwise
 *  along Y becomes 2 × 1 along X. The selection ring, dept-containment
 *  check, marquee hit-test, and centroid all read this rotated footprint
 *  so they outline the cells the sprite actually covers after rotation.
 *  The raw (unrotated) catalog dims are still available via
 *  `wsBaseFootprint` when a fixture's draw fn needs them. */
function wsBaseFootprint(ws: Workstation): { w: number; d: number; h: number } {
  const fix = lookupFixture(ws.catalogId);
  return {
    w: ws.size?.w ?? fix?.w ?? 1,
    d: ws.size?.d ?? fix?.d ?? 1,
    h: ws.size?.h ?? fix?.h ?? 1,
  };
}
function wsFootprint(ws: Workstation): { w: number; d: number; h: number } {
  const base = wsBaseFootprint(ws);
  const turned = ws.rotation === 90 || ws.rotation === 270;
  return turned ? { w: base.d, d: base.w, h: base.h } : base;
}

// ============================================================================
// SHARED STYLE FRAGMENTS
// ============================================================================

// Functions (not consts) so SW_COLORS/SW_FONTS are read at render time — the
// vibe system mutates the token objects in place, and a module-level const
// would capture the pre-vibe values forever.
const btnPrim = (): CSSProperties => ({
  background: SW_COLORS.brand,
  border: 'none',
  color: SW_COLORS.paper,
  padding: '6px 12px',
  fontFamily: SW_FONTS.display,
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: '0.06em',
  cursor: 'pointer',
  borderRadius: 6,
});

const btnSec = (): CSSProperties => ({
  background: SW_COLORS.paper,
  border: `1px solid ${SW_COLORS.line}`,
  padding: '6px 11px',
  fontFamily: SW_FONTS.display,
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: '0.06em',
  cursor: 'pointer',
  borderRadius: 6,
  color: SW_COLORS.muted,
});

/** Square icon-only variant of btnSec — same chrome, glyph-sized box. */
const btnIcon = (): CSSProperties => ({
  ...btnSec(),
  padding: 0,
  width: 30,
  height: 30,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const sectionLabel: CSSProperties = {
  fontFamily: SW_FONTS.mono,
  fontSize: 11,
  fontWeight: 600,
  color: SW_COLORS.muted,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  lineHeight: 1.1,
  marginBottom: 6,
};

// Field label + control pair — the inspector's field anatomy: a quiet
// Plex Sans label over a 32px paper well with a hairline edge.
const fieldLabel: CSSProperties = {
  fontFamily: SW_FONTS.body,
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: '0.005em',
  color: SW_COLORS.muted,
  marginBottom: 5,
  display: 'block',
};

const inputBase: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 12px',
  fontSize: 13,
  fontFamily: SW_FONTS.body,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: 6,
  background: SW_COLORS.paper,
  color: SW_COLORS.ink,
};

// Side-panel resize bounds. Keeps the canvas usable at minimum widths and
// prevents either panel from eating the screen.
const PALETTE_MIN = 220;
const PALETTE_MAX = 520;
const INSPECTOR_MIN = 260;
const INSPECTOR_MAX = 560;
const SPLITTER_W = 5;
/** Width of the thin stub a side panel leaves behind when collapsed. Wide
 *  enough for the chevron + vertical label, narrow enough that the canvas
 *  gets almost the whole window back. */
const RAIL_W = 26;

// ============================================================================
// DEEP-LINK INITIAL STATE
// ============================================================================

/**
 * Read `?scenario=<id>&line=<id>` from the URL the BuilderPage first mounts
 * with, activate the requested scenario synchronously in the twin store, and
 * return the dept selection + flash-chip target the page should paint on
 * its first render. This is invoked from a lazy `useState` initialiser so
 * the selection is committed in the very first paint — no later effect can
 * race with it and the Inspector opens straight on the seeded line's dept.
 *
 * Side-effect: calls `useTwin.getState().setActiveScenario(...)` when a
 * scenario id is supplied (or implied by the line lookup). Safe to call
 * during render because zustand's `set` is synchronous and the twin store
 * doesn't subscribe back to React during this call.
 */
function resolveDeepLinkInitialState(searchParams: URLSearchParams): {
  selected: { kind: 'ws'; id: string } | null;
  lineDeepLink: string | null;
} {
  const scenarioId = searchParams.get('scenario');
  const lineId = searchParams.get('line');
  if (!scenarioId && !lineId) return { selected: null, lineDeepLink: null };

  const store = useTwin.getState();

  // Resolve which twin the line lives in. Prefer the supplied scenario; fall
  // back to scanning every scenario, then the canonical twin.
  let twinForLine: ReturnType<typeof selectActiveTwin> | null = null;
  let scenarioToActivate: string | null | undefined = undefined;
  if (scenarioId && store.scenarios.some((s) => s.id === scenarioId)) {
    twinForLine = store.scenarios.find((s) => s.id === scenarioId)!.twin;
    scenarioToActivate = scenarioId;
  }
  if (!twinForLine && lineId) {
    for (const scn of store.scenarios) {
      if ((scn.twin.lines ?? []).some((l) => l.id === lineId)) {
        twinForLine = scn.twin;
        scenarioToActivate = scn.id;
        break;
      }
    }
    if (!twinForLine && (store.canonical.lines ?? []).some((l) => l.id === lineId)) {
      twinForLine = store.canonical;
      scenarioToActivate = null;
    }
  }
  if (scenarioToActivate !== undefined) {
    store.setActiveScenario(scenarioToActivate);
  }
  const line = lineId && twinForLine
    ? (twinForLine.lines ?? []).find((l) => l.id === lineId) ?? null
    : null;
  return {
    selected: null,
    lineDeepLink: line?.id ?? null,
  };
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export function BuilderPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const twin = useTwin(selectActiveTwin);
  const activeScenarioId = useTwin((s) => s.activeScenarioId);
  const scenarios = useTwin((s) => s.scenarios);
  const canonical = useTwin((s) => s.canonical);

  const addLine = useTwin((s) => s.addLine);
  const updateLine = useTwin((s) => s.updateLine);
  const removeLine = useTwin((s) => s.removeLine);
  const setLineForWorkstations = useTwin((s) => s.setLineForWorkstations);
  const addWorkstation = useTwin((s) => s.addWorkstation);
  const moveWorkstation = useTwin((s) => s.moveWorkstation);
  const updateWorkstation = useTwin((s) => s.updateWorkstation);
  const setProcessPositions = useTwin((s) => s.setProcessPositions);
  const removeWorkstation = useTwin((s) => s.removeWorkstation);
  const rotateWorkstation = useTwin((s) => s.rotateWorkstation);
  const duplicateWorkstation = useTwin((s) => s.duplicateWorkstation);
  const pasteWorkstations = useTwin((s) => s.pasteWorkstations);
  const setOperation = useTwin((s) => s.setOperation);
  const setResources = useTwin((s) => s.setResources);
  const setKpiTargets = useTwin((s) => s.setKpiTargets);
  const setKpiObserved = useTwin((s) => s.setKpiObserved);
  const setBlock = useTwin((s) => s.setBlock);
  const addConnector = useTwin((s) => s.addConnector);
  const removeConnector = useTwin((s) => s.removeConnector);
  const createScenarioFromCanonical = useTwin(
    (s) => s.createScenarioFromCanonical,
  );
  const forkScenario = useTwin((s) => s.forkScenario);
  const setActiveScenario = useTwin((s) => s.setActiveScenario);
  const deleteScenario = useTwin((s) => s.deleteScenario);
  const touchActive = useTwin((s) => s.touchActive);
  // Project meta name (the authoritative label the TopBar shows) — the
  // Builder's factory picker mirrors this so both surfaces agree.
  const projectName = useProject((s) => s.meta.name);
  // Station types the user authored. They render as their own palette
  // sections and resolve through the fixture registry once placed.
  const stationTypes = useProject((s) => s.stationTypes);
  const addStationType = useProject((s) => s.addStationType);
  const updateStationType = useProject((s) => s.updateStationType);
  const removeStationType = useProject((s) => s.removeStationType);
  const [typeDialogOpen, setTypeDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<StationType | null>(null);

  /** Commit the dialog. An edit keeps the id, so every station already placed
   *  from that type re-draws with the change — which is the point of editing
   *  a type rather than a station. */
  const saveStationType = useCallback(
    (type: StationType) => {
      if (stationTypes.some((t) => t.id === type.id)) {
        updateStationType(type.id, type);
      } else {
        addStationType(type);
      }
      setTypeDialogOpen(false);
      setEditingType(null);
    },
    [stationTypes, addStationType, updateStationType],
  );

  /** Delete a type, refusing while stations of it are still on the floor —
   *  dropping it would leave them unresolvable, and silently deleting the
   *  stations too is not the user's ask. */
  const deleteStationType = useCallback(
    async (type: StationType) => {
      const placed = twin.workstations.filter((w) => w.catalogId === type.id);
      if (placed.length > 0) {
        await confirm({
          title: `${type.label} is in use`,
          message: `${placed.length} station${placed.length === 1 ? '' : 's'} on the floor ${
            placed.length === 1 ? 'is' : 'are'
          } of this type. Delete or change ${placed.length === 1 ? 'it' : 'them'} first, then the type can go.`,
          confirmLabel: 'OK',
          cancelLabel: null,
        });
        return;
      }
      const ok = await confirm({
        title: `Delete ${type.label}?`,
        message: 'The type is removed from the palette. Nothing on the floor uses it.',
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (ok) removeStationType(type.id);
    },
    [twin.workstations, confirm, removeStationType],
  );
  // Saved factories from the library so the picker can switch to any
  // archived factory (not just scenarios of the active canonical).
  const savedFactories = useFactoryLibrary((s) => s.savedFactories);
  const loadSavedFactory = useFactoryLibrary((s) => s.loadFactory);

  // Undo / redo wired off the twin store. Both update history in place; the
  // toolbar disables the buttons when the relevant stack is empty.
  const undoTwin = useTwin((s) => s.undo);
  const redoTwin = useTwin((s) => s.redo);

  // ── Local UI state ─────────────────────────────────────────────────────────
  const [drop, setDrop] = useState<DropTool>({ kind: 'none' });
  /** Active canvas tool. 'pointer' is the default authoring mode where
   *  clicking selects a single entity and dragging an entity moves it.
   *  'select' arms the rectangle-select gesture — dragging on canvas
   *  background paints a marquee that picks every workstation whose
   *  footprint centre lands inside it. */
  const [tool, setTool] = useState<'pointer' | 'select'>('pointer');
  /** Live marquee rectangle while the user is drawing one. Coordinates are
   *  in iso-projected SVG user-space (the same space the canvas <g>
   *  renders in), so the rect can be drawn directly without re-mapping. */
  const [selectRect, setSelectRect] = useState<
    { sx0: number; sy0: number; sx1: number; sy1: number } | null
  >(null);
  /** Connect-flow modal tool state. When `on` is true:
   *    • In ISO mode, clicking a workstation picks the source (if
   *      `fromWsId` is null) or the target — fromPort/toPort default
   *      to the first output / first input of the respective block.
   *    • In PROCESS mode, clicking a specific output port dot picks
   *      `(fromWsId, fromPort)`; clicking a specific input port dot
   *      picks `(toWsId, toPort)` and creates the connector.
   *  ESC clears. */
  const [connect, setConnect] = useState<{
    on: boolean;
    kind: ConnectorKind;
    fromWsId: string | null;
    fromPort: string | null;
  }>({ on: false, kind: 'flow', fromWsId: null, fromPort: null });
  // Resolve the deep-link target (?scenario=<id>&line=<id>) synchronously
  // during the very first render so `selected` is initialised to the seeded
  // line's parent dept BEFORE any other effect can race with it. This also
  // activates the draft scenario in the twin store as a side-effect so the
  // selector below resolves against the right twin. Cleaning the URL params
  // is deferred to a useEffect — that doesn't affect the resolved selection.
  const initialSelection = useState(() =>
    resolveDeepLinkInitialState(searchParams),
  )[0];
  const [selected, setSelected] = useState<
    { kind: 'ws'; id: string } | null
  >(initialSelection.selected);
  /** Additional workstation ids selected via SHIFT+click. The `selected`
   *  anchor (when it's a workstation) is always implicitly part of the
   *  selection set — `selectedWsIds` below merges the two for rendering
   *  and clipboard operations. Plain click clears this set; SHIFT+click
   *  toggles ids into/out of it. Departments are not multi-selectable. */
  const [extraSelectedWs, setExtraSelectedWs] = useState<Set<string>>(() => new Set());
  /** In-memory copy/paste buffer for workstations. Captured snapshots are
   *  deep-cloned at copy time so later edits to the originals don't bleed
   *  into pending pastes. `anchor` is the top-left of the snapshot bounding
   *  box; paste re-anchors that point to the current hover cell so the
   *  cluster lands where the cursor is. */
  const [clipboard, setClipboard] = useState<{
    workstations: Workstation[];
    connectors: Connector[];
    anchor: { x: number; y: number };
  } | null>(null);
  const [lens, setLens] = useState<Lens>('operations');
  // Last-used view persists like the splitter widths below; the validation
  // guard silently retires stale values (e.g. the removed 'logic' mode).
  const [canvasMode, setCanvasMode] = useState<CanvasMode>(() => {
    const v = localStorage.getItem('builder.canvasMode');
    return v === 'iso' || v === 'process' || v === '2d' ? v : '2d';
  });
  useEffect(() => { localStorage.setItem('builder.canvasMode', canvasMode); }, [canvasMode]);
  /** 0 = flat plan, 1 = isometric — the floor-view morph parameter. Driven
   *  by the rAF tween in `switchCanvasMode`; the active projection derives
   *  from this, so while the tween runs every polygon on the floor
   *  re-projects continuously and the plan visibly tips up into the iso
   *  stage (and lays back flat on the way out) instead of snapping. */
  const [isoBlend, setIsoBlend] = useState<number>(() => (canvasMode === 'iso' ? 1 : 0));
  const isoBlendRef = useRef(isoBlend);
  isoBlendRef.current = isoBlend;
  /** Live rAF id of the in-flight view morph, so a second view switch (or
   *  unmount) can cancel a running tween instead of fighting it. */
  const morphRaf = useRef<number | null>(null);
  useEffect(() => () => {
    if (morphRaf.current !== null) cancelAnimationFrame(morphRaf.current);
  }, []);

  // Dev-time escape hatch — exposes the live useTwin hook on `window` so
  // browser-console tests / e2e harnesses can mutate the same store
  // instance the React tree is mounted against. Vite's dev module graph
  // can otherwise hand out separate instances for different import paths,
  // making it impossible to drive the UI from a side script. Stripped
  // from production builds by the `import.meta.env.DEV` guard.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __swUseTwin?: typeof useTwin }).__swUseTwin = useTwin;
  }, []);

  // Flash chip ("✎ EDITING LINE …") shown for ~4s when the user lands here
  // via a deep-link from Orders or Simulation. Initial value is captured by
  // resolveDeepLinkInitialState (which also activated the scenario during
  // the very first render), so the chip paints in the same commit as the
  // selected-dept Inspector — no flicker.
  const [lineDeepLink, setLineDeepLink] = useState<string | null>(
    initialSelection.lineDeepLink,
  );
  useEffect(() => {
    // Clean the URL once we've consumed the params so a refresh inside the
    // Builder doesn't re-fire activation. Auto-hide the flash chip after 4s.
    const scenarioId = searchParams.get('scenario');
    const lineId = searchParams.get('line');
    if (scenarioId || lineId) {
      const next = new URLSearchParams(searchParams);
      next.delete('scenario');
      next.delete('line');
      setSearchParams(next, { replace: true });
    }
    if (!initialSelection.lineDeepLink) return;
    const t = setTimeout(() => setLineDeepLink(null), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /** When true the pre-flight validation list is expanded under the chip. */
  const [issuesOpen, setIssuesOpen] = useState(false);

  // Live graph validation — recomputed on every twin change. Cheap, runs
  // the same pure validator the engine uses post-run for consistency. PML
  // is the only engine now, so the chip is always live. We also fold in
  // operator-allocation warnings from `validateTwinWarnings` so an over-
  // allocated operator surfaces in the same WARN chip the user already
  // watches for engine wiring issues.
  const pmlIssues = useMemo<PmlIssue[]>(() => {
    const graph = validatePmlGraph(twin);
    const staffing: PmlIssue[] = validateTwinWarnings(twin).map((m) => ({
      level: 'warn' as const,
      message: m,
    }));
    return [...graph, ...staffing];
  }, [twin]);

  /** Effective selected-workstation id set: the primary `selected` anchor
   *  (when it's a ws) plus every id in `extraSelectedWs`. This is what the
   *  canvas highlights and what copy/cut operate on. */
  const selectedWsIds = useMemo<Set<string>>(() => {
    const ids = new Set(extraSelectedWs);
    if (selected?.kind === 'ws') ids.add(selected.id);
    return ids;
  }, [extraSelectedWs, selected]);
  // Mirror to a ref so the drag-handler closure (created once with stable
  // dependencies) can read the latest selection without re-binding.
  const selectedWsIdsRef = useRef(selectedWsIds);
  selectedWsIdsRef.current = selectedWsIds;

  /**
   * Apply a selection click to the workstation multi-selection model.
   *
   * SHIFT toggles a station in and out without disturbing the rest — the
   * Figma/Sketch convention. A plain click replaces the selection.
   *
   * Shared by the floor canvas and the PROCESS graph. The two canvases used
   * to disagree about this because only one of them had multi-select at all;
   * one implementation is what keeps them honest.
   */
  const selectWs = useCallback(
    (s: { kind: 'ws'; id: string } | null, additive?: boolean) => {
      if (additive && s?.kind === 'ws') {
        const id = s.id;
        const anchorIsWs = selected?.kind === 'ws';
        const anchorId = anchorIsWs ? selected.id : null;
        if (anchorId === id) {
          // Toggling off the anchor — promote an extra if any, else clear.
          if (extraSelectedWs.size > 0) {
            const [next, ...rest] = Array.from(extraSelectedWs);
            setSelected({ kind: 'ws', id: next });
            setExtraSelectedWs(new Set(rest));
          } else {
            setSelected(null);
          }
          return;
        }
        if (extraSelectedWs.has(id)) {
          const next = new Set(extraSelectedWs);
          next.delete(id);
          setExtraSelectedWs(next);
          return;
        }
        // Not yet selected — add. With no ws anchor this id becomes one.
        if (!anchorIsWs) {
          setSelected({ kind: 'ws', id });
          setExtraSelectedWs(new Set());
        } else {
          setExtraSelectedWs(new Set([...extraSelectedWs, id]));
        }
        return;
      }
      setExtraSelectedWs(new Set());
      setSelected(s);
    },
    [selected, extraSelectedWs],
  );

  // Best scenario — leader on latest-run throughput/hr, with efficiencyPct as
  // a tiebreaker. Scenarios with no runs are ignored. Null when nothing's
  // been simulated yet.
  const bestScenario = useMemo(() => {
    let winner: { id: string; name: string; throughput: number; eff: number } | null = null;
    for (const scn of scenarios) {
      const k = scn.runs[0]?.kpis;
      if (!k) continue;
      const cand = { id: scn.id, name: scn.name, throughput: k.throughputPerHr, eff: k.efficiencyPct };
      if (
        !winner ||
        cand.throughput > winner.throughput ||
        (cand.throughput === winner.throughput && cand.eff > winner.eff)
      ) {
        winner = cand;
      }
    }
    return winner;
  }, [scenarios]);
  const errorCount = pmlIssues.filter((i) => i.level === 'error').length;
  const warnCount = pmlIssues.filter((i) => i.level === 'warn').length;
  const infoCount = pmlIssues.filter((i) => i.level === 'info').length;
  // The palette follows the view: floor views (2D · ISO) author with
  // STATIONS; the PROCESS view authors with BLOCKS. Derived, not stateful,
  // so the two can never drift apart.
  const paletteTab: 'ws' | 'pml' = canvasMode === 'process' ? 'pml' : 'ws';
  const [paletteSearch, setPaletteSearch] = useState<string>('');
  // Pan starts with the factory footprint centred in the stage under the
  // initial projection — in flat space the whole grid lives in the positive
  // quadrant, so a 0,0 pan would hang the factory off the bottom-right.
  //
  // Seeded even when the app boots straight into PROCESS: switching views
  // preserves each camera rather than re-centring, so an unseeded floor
  // camera would strand the factory the first time you left the graph.
  const [pan, setPan] = useState(() => {
    const p = canvasMode === 'iso' ? ISO_PROJECTION : FLAT_PROJECTION;
    const c = p.project(twin.gridW / 2, twin.gridH / 2);
    return { x: -c.sx, y: -c.sy };
  });
  const [zoom, setZoom] = useState(1);
  /**
   * The PROCESS view's own camera, independent of the floor's `pan`/`zoom`.
   *
   * The two are unrelated coordinate spaces — the floor's pan is in projected
   * iso/flat pixels and gets re-centred through `centerPan(projection)`, while
   * the process canvas is a flat diagram of blocks. Sharing one camera meant
   * a shared camera meant the floor's large negative pan leaked into the
   * process view and parked the whole diagram out of reach.
   *
   * Page-level rather than inside BuilderProcessView because the zoom HUD and
   * the +/-/Cmd-0 keys are page-level, and because the process view unmounts
   * on every canvas-mode flip. Framing survives a round trip to 2D and back.
   */
  const [processCam, setProcessCam] = useState({ x: 0, y: 0, z: 1 });
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);
  /** Live stage element size in CSS pixels. Drives the SVG viewBox so the
   *  canvas user-space matches stage pixels 1:1 — required for the cursor
   *  → world projection to be exact regardless of element aspect ratio. */
  const [stageSize, setStageSize] = useState({ w: 1200, h: 800 });
  // Side-panel widths. User drags the splitters; values persist in
  // localStorage so the layout survives reloads.
  const [paletteWidth, setPaletteWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('builder.paletteW'));
    return Number.isFinite(v) && v >= PALETTE_MIN && v <= PALETTE_MAX ? v : 280;
  });
  const [inspectorWidth, setInspectorWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('builder.inspectorW'));
    return Number.isFinite(v) && v >= INSPECTOR_MIN && v <= INSPECTOR_MAX ? v : 340;
  });
  useEffect(() => { localStorage.setItem('builder.paletteW', String(paletteWidth)); }, [paletteWidth]);
  useEffect(() => { localStorage.setItem('builder.inspectorW', String(inspectorWidth)); }, [inspectorWidth]);
  // Collapsed side panels. Each leaves a RAIL_W stub behind so the canvas can
  // take the full window for layout work and the pane is one click away. The
  // dragged widths above are untouched, so re-opening restores the user's size.
  const [paletteOpen, setPaletteOpen] = useState<boolean>(
    () => localStorage.getItem('builder.paletteOpen') !== '0',
  );
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(
    () => localStorage.getItem('builder.inspectorOpen') !== '0',
  );
  useEffect(() => { localStorage.setItem('builder.paletteOpen', paletteOpen ? '1' : '0'); }, [paletteOpen]);
  useEffect(() => { localStorage.setItem('builder.inspectorOpen', inspectorOpen ? '1' : '0'); }, [inspectorOpen]);

  const startSideResize = useCallback((side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? paletteWidth : inspectorWidth;
    const min = side === 'left' ? PALETTE_MIN : INSPECTOR_MIN;
    const max = side === 'left' ? PALETTE_MAX : INSPECTOR_MAX;
    const setter = side === 'left' ? setPaletteWidth : setInspectorWidth;
    // Dragging right grows the left palette; dragging right shrinks the right inspector.
    const dir = side === 'left' ? 1 : -1;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(min, Math.min(max, startW + (ev.clientX - startX) * dir));
      setter(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [paletteWidth, inspectorWidth]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef(pan);
  panRef.current = pan;
  const processCamRef = useRef(processCam);
  processCamRef.current = processCam;
  // Read by listeners that must behave differently per view without being
  // re-bound (the non-passive wheel listener in particular).
  const canvasModeRef = useRef(canvasMode);
  canvasModeRef.current = canvasMode;
  // Hover cell mirror — paste reads the latest cursor cell without re-binding
  // the keyboard effect on every mouse move.
  const hoverCellRef = useRef(hoverCell);
  hoverCellRef.current = hoverCell;
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;
  const twinRef = useRef(twin);
  twinRef.current = twin;

  // Active canvas projection — ISO diamonds, FLAT top-down cells, or the
  // in-between blend while a view morph is running. At rest `isoBlend` is
  // exactly 0 or 1, and `lerpProjection` returns the canonical FLAT / ISO
  // projection objects for those values. The PROCESS view ignores it (its
  // canvas is a freeform pixel space).
  const proj = useMemo(() => lerpProjection(isoBlend), [isoBlend]);
  const projRef = useRef(proj);
  projRef.current = proj;

  // Track the stage element's pixel size. The SVG inside uses a viewBox
  // sized to match — `[-w/2, -h/2, w, h]` — so 1 user-space unit equals
  // 1 stage pixel and (0,0) sits at the element centre. That makes the
  // cursor → world math (which divides client-coords by zoom and feeds the
  // result to `unproject`) exact at any aspect ratio or zoom level.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      setStageSize({ w: r.width, h: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Projected bounds of everything on the floor, in stage pixels at 1x.
   *
   * All four footprint corners go in, not just the origin: under the iso
   * projection a station's extent runs diagonally, so a bbox built from
   * origins alone clips the far edge of the floor.
   */
  const floorBounds = useCallback((p: Projection) => {
    const t = twinRef.current;
    const pts: { sx: number; sy: number }[] = [];
    for (const w of t.workstations) {
      const fp = wsFootprint(w);
      const { x, y } = w.position;
      pts.push(
        p.project(x, y),
        p.project(x + fp.w, y),
        p.project(x, y + fp.d),
        p.project(x + fp.w, y + fp.d),
      );
    }
    // An empty floor still deserves a sensible frame — fall back to the grid.
    if (pts.length === 0) {
      pts.push(
        p.project(0, 0),
        p.project(t.gridW, 0),
        p.project(0, t.gridH),
        p.project(t.gridW, t.gridH),
      );
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of pts) {
      if (q.sx < minX) minX = q.sx;
      if (q.sy < minY) minY = q.sy;
      if (q.sx > maxX) maxX = q.sx;
      if (q.sy > maxY) maxY = q.sy;
    }
    return { minX, minY, maxX, maxY };
  }, []);

  /**
   * The floor camera, as one value.
   *
   * `pan` and `zoom` stay separate state because dozens of render sites read
   * them, but every *write* funnels through `writeFloorCam` so a burst of
   * wheel events composes instead of each event reading the same stale
   * render. The ref is re-synced on render, which also picks up the writes
   * the view-morph tween makes directly.
   */
  const floorCamRef = useRef<Cam>(CAM_IDENTITY);
  floorCamRef.current = { x: pan.x, y: pan.y, z: zoom };
  const writeFloorCam = useCallback((update: (c: Cam) => Cam) => {
    const next = update(floorCamRef.current);
    floorCamRef.current = next;
    setPan({ x: next.x, y: next.y });
    setZoom(next.z);
  }, []);

  /** One camera interface over two independent cameras. Which one a gesture
   *  drives is a function of the active view, so the shared gesture layer
   *  never has to know there are two. */
  const readCam = useCallback(
    (): Cam =>
      canvasModeRef.current === 'process' ? processCamRef.current : floorCamRef.current,
    [],
  );
  const writeCam = useCallback(
    (update: (c: Cam) => Cam) => {
      if (canvasModeRef.current === 'process') setProcessCam((c) => update(c));
      else writeFloorCam(update);
    },
    [writeFloorCam],
  );

  /** Frame everything — the ⛶ button and Cmd-0. Means the same thing in all
   *  three views: show me all of my content. */
  const fitView = useCallback(() => {
    if (canvasModeRef.current === 'process') {
      setProcessCam(
        fitBounds(
          processContentBounds(twinRef.current) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          stageSize,
        ),
      );
      return;
    }
    writeFloorCam(() => fitBounds(floorBounds(projRef.current), stageSize));
  }, [floorBounds, stageSize, writeFloorCam]);

  /** Wheel, pinch, space-drag, middle-drag, +/-, Cmd-0 — the same gestures
   *  every canvas in the app responds to. */
  const cam = useCanvasCamera({
    ref: stageRef,
    origin: 'center',
    read: readCam,
    write: writeCam,
    fit: fitView,
  });

  /**
   * Switch the canvas view. 2D ↔ ISO runs the projection-blend morph — the
   * plan tips up into the isometric stage over SW_MOTION.slow, with pan and
   * zoom re-framing along the same tween so the factory stays centred
   * throughout. PROCESS is an unrelated pixel space, so entering or leaving
   * it re-frames instantly (there is nothing continuous to morph through).
   * Honors prefers-reduced-motion by jumping straight to the target.
   */
  const switchCanvasMode = (m: CanvasMode) => {
    if (m === canvasMode) return;
    // Disarm any pending drop — the palette flips with the view, so an
    // armed BLOCKS drop must not land via the STATIONS placement path
    // (and vice versa).
    setDrop({ kind: 'none' });
    if (morphRaf.current !== null) {
      cancelAnimationFrame(morphRaf.current);
      morphRaf.current = null;
    }
    setCanvasMode(m);
    if (m === 'process') {
      // Touches neither camera. Both are preserved, so a 2D → PROCESS → 2D
      // round trip puts you back exactly where you were — the same rule the
      // simulation views follow.
      return;
    }
    const toBlend = m === 'iso' ? 1 : 0;
    const fromBlend = isoBlendRef.current;
    // Hold your framing through the projection change: whatever world point
    // is at the stage centre stays there, at the zoom you were already at.
    // Re-centring on the grid and snapping back to 100% — which is what this
    // used to do — threw away your position on every single view switch.
    const camNow = floorCamRef.current;
    const world = lerpProjection(fromBlend).unproject(
      -camNow.x / camNow.z,
      -camNow.y / camNow.z,
    );
    const anchor = lerpProjection(toBlend).project(world.x, world.y);
    const panTo = { x: -anchor.sx * camNow.z, y: -anchor.sy * camNow.z };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (canvasMode === 'process' || reduceMotion || fromBlend === toBlend) {
      setPan(panTo);
      setIsoBlend(toBlend);
      return;
    }
    const panFrom = { x: camNow.x, y: camNow.y };
    const duration = SW_MOTION.slow;
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / duration);
      // Ease-out cubic — close cousin of SW_MOTION.standard, cheap to eval
      // per frame without a bezier solver.
      const e = 1 - Math.pow(1 - u, 3);
      setIsoBlend(fromBlend + (toBlend - fromBlend) * e);
      setPan({
        x: panFrom.x + (panTo.x - panFrom.x) * e,
        y: panFrom.y + (panTo.y - panFrom.y) * e,
      });
      morphRaf.current = u < 1 ? requestAnimationFrame(step) : null;
    };
    morphRaf.current = requestAnimationFrame(step);
  };

  /** Every apparel category, resolved and kept in catalogue order, so the
   *  STATIONS palette can render one continuous scroller with a section
   *  header per category instead of a tab strip. Search narrows within
   *  each section; sections that go empty are dropped by the pane. */
  const apparelSections = useMemo<ApparelSection[]>(() => {
    const q = paletteSearch.trim().toLowerCase();
    const hits = (label: string, id: string) =>
      !q || label.toLowerCase().includes(q) || id.toLowerCase().includes(q);

    const builtIn: ApparelSection[] = APPAREL_CATEGORIES.map((cat) => ({
      ...cat,
      items: APPAREL_FIXTURE_PALETTE[cat.id]
        .map(resolveFixture)
        .filter((f): f is IsoFixture => Boolean(f))
        .filter((f) => hits(f.label, f.id)),
    }));

    // Authored types, one section per group the user named, in first-authored
    // order so the palette doesn't reshuffle itself as types are added.
    const groups: string[] = [];
    for (const t of stationTypes) if (!groups.includes(t.group)) groups.push(t.group);
    const authored: ApparelSection[] = groups.map((group) => {
      const types = stationTypes.filter(
        (t) => t.group === group && hits(t.label, t.code),
      );
      return {
        id: `grp:${group}`,
        label: group,
        icon: '✎',
        items: types
          .map((t) => resolveFixture(t.id))
          .filter((f): f is IsoFixture => Boolean(f)),
        types,
      };
    });

    return [...builtIn, ...authored];
  }, [paletteSearch, stationTypes]);

  // ── Canvas pointer handlers ────────────────────────────────────────────────
  const onCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!stageRef.current) return;
      // hoverCell is an iso/flat FLOOR cell. In PROCESS the cursor is over an
      // unrelated pixel space, and tracking it there is what made Cmd-V paste
      // at a bogus cell while the process view was open.
      if (canvasMode === 'process') return;
      const rect = stageRef.current.getBoundingClientRect();
      // Stage pixel offset from element centre, undone by the wrapper's
      // CSS transform (`translate(pan) scale(zoom)`). Because the SVG's
      // viewBox is `[-w/2, -h/2, w, h]`, the result is the exact iso
      // projected coordinate of the cursor in SVG user-space — no
      // viewBox-to-viewport fit factor to compensate for. The canvas is
      // unbounded, so we accept any cell (negative or beyond the original
      // gridW/gridH) and let the placement land where the cursor is.
      const sx = (e.clientX - rect.left - rect.width / 2 - pan.x) / zoom;
      const sy = (e.clientY - rect.top - rect.height / 2 - pan.y) / zoom;
      const w = proj.unproject(sx, sy);
      setHoverCell({ x: Math.floor(w.x), y: Math.floor(w.y) });
    },
    [pan, zoom, proj, canvasMode],
  );

  const onCanvasClick = useCallback(() => {
    // PROCESS places blocks at the cursor in its own space — see dropAtCursor
    // in BuilderProcessView. This handler would drop them on the floor grid.
    if (canvasMode === 'process') return;
    if (!hoverCell) return;
    if (drop.kind === 'ws') {
      // Stations drop wherever the user clicked. The floor is free space —
      // there is no zone to join and nothing grows to swallow the cell.
      // When the drop originated from the BLOCKS palette (apparel preset),
      // stamp the preset's default params + auto-name with its label.
      const preset = drop.presetId ? findApparelPreset(drop.presetId) : null;
      // An authored station type auto-names the same way a preset does, so
      // three drops read "Inline iron 1 / 2 / 3". Its params are stamped by
      // `makeWorkstation` from the type itself.
      const authored = stationTypeFor(drop.catalogId);
      const id = addWorkstation({
        catalogId: drop.catalogId,
        position: { x: hoverCell.x, y: hoverCell.y },
        presetLabel: preset?.label ?? authored?.label,
        blockParams: preset?.defaultParams,
      });
      setSelected({ kind: 'ws', id });
      setDrop({ kind: 'none' });
      return;
    }
    // When the select tool is armed, the mouseup half of the marquee
    // gesture already handled selection — don't second-guess it here.
    if (tool === 'select') return;
    // No tool: clicking empty canvas clears selection.
    setSelected(null);
    setExtraSelectedWs(new Set());
  }, [hoverCell, drop, tool, addWorkstation, canvasMode]);


  /** Project a screen point to SVG user-space — the same coordinate system
   *  the active canvas's inner <g> renders in after applying
   *  `translate(cam) scale(cam.z)`. Used by the marquee handler so the
   *  rectangle can be authored in the same space the entity centres live in.
   *
   *  Reads whichever camera the current view is driving. Both canvases use a
   *  centred viewBox with pixel-for-pixel user units, so one expression
   *  serves both — only the camera differs, which is the same trick
   *  `readCam` plays for the gesture layer. */
  const screenToWorldSvg = useCallback(
    (clientX: number, clientY: number) => {
      const el = stageRef.current;
      if (!el) return { sx: 0, sy: 0 };
      const r = el.getBoundingClientRect();
      const c = canvasMode === 'process' ? processCam : { x: pan.x, y: pan.y, z: zoom };
      return {
        sx: (clientX - r.left - r.width / 2 - c.x) / c.z,
        sy: (clientY - r.top - r.height / 2 - c.y) / c.z,
      };
    },
    [pan, zoom, processCam, canvasMode],
  );

  const beginSelectRect = useCallback(
    (startX: number, startY: number, additive: boolean) => {
      const { sx: sx0, sy: sy0 } = screenToWorldSvg(startX, startY);
      setSelectRect({ sx0, sy0, sx1: sx0, sy1: sy0 });
      // Snapshot the existing selection so SHIFT+marquee can UNION rather than
      // replace. Captured at gesture start so live React state changes during
      // the drag don't muddy the merge.
      const baseIds = additive ? new Set(selectedWsIdsRef.current) : new Set<string>();
      let moved = false;
      function move(ev: MouseEvent) {
        const { sx, sy } = screenToWorldSvg(ev.clientX, ev.clientY);
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
        moved = true;
        setSelectRect({ sx0, sy0, sx1: sx, sy1: sy });
      }
      function up(ev: MouseEvent) {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (!moved) {
          // Plain click with the select tool — clear selection like the
          // pointer tool would, so the gesture isn't a dead-end. SHIFT+click
          // on empty canvas preserves the current selection (additive intent
          // with nothing to add is a no-op).
          if (!additive) {
            setSelected(null);
            setExtraSelectedWs(new Set());
          }
          setSelectRect(null);
          return;
        }
        const { sx: sx1, sy: sy1 } = screenToWorldSvg(ev.clientX, ev.clientY);
        const minSx = Math.min(sx0, sx1);
        const maxSx = Math.max(sx0, sx1);
        const minSy = Math.min(sy0, sy1);
        const maxSy = Math.max(sy0, sy1);
        // Every workstation whose centre falls inside the marquee joins the
        // selection. Centre rather than bounding rect so small marquees can
        // still pick tightly-packed stations without overlap fights.
        //
        // The two canvases place entities in unrelated spaces, so only the
        // centre differs: the floor projects a rotated footprint, the PROCESS
        // graph reads the same resolved positions it renders from (and that
        // `processContentBounds` frames with), offset to the block's middle.
        const t = twinRef.current;
        const hits: string[] = [];
        const inRect = (sx: number, sy: number) =>
          sx >= minSx && sx <= maxSx && sy >= minSy && sy <= maxSy;
        if (canvasModeRef.current === 'process') {
          const positions = resolveProcessPositions(t);
          for (const w of t.workstations) {
            const pos = positions.get(w.id);
            if (!pos) continue;
            if (inRect(pos.x + PROCESS_BLOCK_W / 2, pos.y + PROCESS_BLOCK_H / 2)) {
              hits.push(w.id);
            }
          }
        } else {
          for (const w of t.workstations) {
            const fp = wsFootprint(w);
            const c = proj.project(w.position.x + fp.w / 2, w.position.y + fp.d / 2);
            if (inRect(c.sx, c.sy)) hits.push(w.id);
          }
        }
        const merged = new Set<string>(baseIds);
        for (const id of hits) merged.add(id);
        if (merged.size === 0) {
          setSelected(null);
          setExtraSelectedWs(new Set());
        } else {
          const all = Array.from(merged);
          const [first, ...rest] = all;
          setSelected({ kind: 'ws', id: first });
          setExtraSelectedWs(new Set(rest));
        }
        setSelectRect(null);
      }
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [screenToWorldSvg, proj],
  );

  const onPanStart = (e: React.MouseEvent) => {
    // An armed drop still pans on the process canvas: the block is placed on
    // click (mouseup without movement), so dragging the background is
    // unambiguous. On the floor the click-to-place path owns the gesture.
    if (drop.kind !== 'none' && canvasMode !== 'process') return;
    if (e.button !== 0) return;
    if (cam.spacePan) return; // the shared capture-phase listener owns space-pan
    const t = e.target as Element;
    // Only react to background drags — let entity clicks bubble.
    if (t.tagName !== 'svg' && !(t as SVGElement).getAttribute?.('data-canvas-bg')) return;
    if (tool === 'select') {
      e.preventDefault();
      beginSelectRect(e.clientX, e.clientY, e.shiftKey);
      return;
    }
    cam.beginPan(e.clientX, e.clientY);
  };



  // ── Drag-to-move ───────────────────────────────────────────────────────────
  // Keep zoom in a ref so the drag closure always reads the latest zoom
  // without re-binding listeners on every zoom change.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const startEntityDrag = useCallback(
    (kind: 'ws', id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const t0 = selectActiveTwin(useTwin.getState());

      // Preserve a multi-selection when the user grabs a workstation that's
      // already part of it. Otherwise replace with a single selection. SHIFT
      // is reserved for toggling — leave the selection untouched on mousedown
      // so the click handler (fires on mouseup-without-drag) can flip the
      // membership without us first replacing it here.
      const inMulti = kind === 'ws' && selectedWsIdsRef.current.has(id);
      if (!e.shiftKey) {
        setSelected({ kind, id });
        if (!inMulti) setExtraSelectedWs(new Set());
      }

      // Build the snapshot set — every entity whose initial position the
      // drag delta should be added to. Captured once at gesture start so
      // live state changes during the drag can't poison the math.
      //
      //  • Grabbing a multi-selected ws (no SHIFT) drags the whole multi-set
      //    as one rigid group — the user's explicit ask.
      //  • SHIFT-drag intentionally moves only the grabbed station so a user
      //    can nudge one member without losing the rest of the selection.
      const wsSnap: { id: string; x0: number; y0: number }[] = [];

      const ids = new Set<string>();
      ids.add(id);
      if (!e.shiftKey && inMulti) {
        for (const wid of selectedWsIdsRef.current) ids.add(wid);
      }
      for (const w of t0.workstations) {
        if (ids.has(w.id)) wsSnap.push({ id: w.id, x0: w.position.x, y0: w.position.y });
      }

      if (wsSnap.length === 0) return;

      let moved = false;
      function onMove(ev: MouseEvent) {
        const sx = (ev.clientX - startX) / zoomRef.current;
        const sy = (ev.clientY - startY) / zoomRef.current;
        const delta = proj.unproject(sx, sy);
        const dx = Math.round(delta.x);
        const dy = Math.round(delta.y);
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
        moved = true;
        for (const s of wsSnap) {
          moveWorkstation(s.id, { x: s.x0 + dx, y: s.y0 + dy });
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [moveWorkstation, proj],
  );

  // ── Select / Copy / Paste ──────────────────────────────────────────────────
  // `selectAllWs` floods every workstation in the active twin into the
  // multi-select set, with the first as the anchor. Useful for "copy this
  // whole factory's layout into a scenario fork" workflows.
  const selectAllWs = useCallback(() => {
    const t = twinRef.current;
    if (t.workstations.length === 0) {
      setSelected(null);
      setExtraSelectedWs(new Set());
      return;
    }
    const [first, ...rest] = t.workstations;
    setSelected({ kind: 'ws', id: first.id });
    setExtraSelectedWs(new Set(rest.map((w) => w.id)));
  }, []);

  /** Snapshot the current workstation selection into the clipboard. The
   *  anchor is the top-left of the selection bounding box so paste can
   *  re-anchor cleanly at the cursor. Connectors with both endpoints in
   *  the selection are captured as well so wired-up clusters round-trip
   *  cleanly. */
  const copySelection = useCallback(() => {
    const t = twinRef.current;
    const ids = new Set<string>();
    if (selected?.kind === 'ws') ids.add(selected.id);
    for (const id of extraSelectedWs) ids.add(id);
    if (ids.size === 0) return false;
    const wss = t.workstations.filter((w) => ids.has(w.id));
    if (wss.length === 0) return false;
    let minX = Infinity, minY = Infinity;
    for (const w of wss) {
      if (w.position.x < minX) minX = w.position.x;
      if (w.position.y < minY) minY = w.position.y;
    }
    const conns = (t.connectors ?? []).filter(
      (c) => ids.has(c.fromWsId) && ids.has(c.toWsId),
    );
    setClipboard({
      workstations: wss.map((w) => structuredClone(w)),
      connectors: conns.map((c) => structuredClone(c)),
      anchor: { x: minX, y: minY },
    });
    return true;
  }, [selected, extraSelectedWs]);

  /** Paste the clipboard contents at the current hover cell. Positions
   *  preserve relative offsets from the captured anchor. Each pasted ws
   *  is re-homed to whatever department covers its new cell — if it lands
   *  outside any department, the snapshot is skipped (no orphan ws). */
  const pasteClipboard = useCallback(() => {
    const cb = clipboardRef.current;
    if (!cb || cb.workstations.length === 0) return;
    // Anchor target: prefer the hover cell so the user can aim the paste.
    // Falls back to +2 of the original anchor when the cursor is off-stage
    // (e.g. focused on a side panel), matching the "duplicate-ish" idiom.
    const hc = hoverCellRef.current;
    const tx = hc ? hc.x : cb.anchor.x + 2;
    const ty = hc ? hc.y : cb.anchor.y + 2;
    const dx = tx - cb.anchor.x;
    const dy = ty - cb.anchor.y;
    // Every buffered station pastes — the floor is free space, so there is
    // no zone to land inside and nothing to reject a paste for.
    const snaps: (Workstation & { _srcId: string })[] = cb.workstations.map((w) => ({
      ...w,
      _srcId: w.id,
      position: { x: w.position.x + dx, y: w.position.y + dy },
    }));
    if (snaps.length === 0) return;
    const result = pasteWorkstations({
      snapshots: snaps,
      connectors: cb.connectors,
    });
    if (result.newWsIds.length > 0) {
      const [first, ...rest] = result.newWsIds;
      setSelected({ kind: 'ws', id: first });
      setExtraSelectedWs(new Set(rest));
    }
    // Drop the buffer once the cluster lands so the paste-preview ghost
    // and the "N ON CLIPBOARD" chip clear — the canvas returns to its
    // resting drag/select look instead of trailing a ghost under the
    // cursor after the paste is done. To paste another cluster, ⌘C re-fills
    // the buffer. (⌘D still handles single-block duplication unchanged.)
    setClipboard(null);
  }, [pasteWorkstations]);

  const cutSelection = useCallback(() => {
    const ok = copySelection();
    if (!ok) return;
    const ids = new Set<string>();
    if (selected?.kind === 'ws') ids.add(selected.id);
    for (const id of extraSelectedWs) ids.add(id);
    for (const id of ids) removeWorkstation(id);
    setSelected(null);
    setExtraSelectedWs(new Set());
  }, [copySelection, selected, extraSelectedWs, removeWorkstation]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as Element)?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Camera keys (Space-pan, Cmd-0, +/-) live in `useCanvasCamera` so the
      // simulation floor answers to exactly the same ones.
      // [ / ] — collapse or restore the side panels (Figma convention), so the
      // canvas can be taken full-width without reaching for the headers.
      if (!inField && !e.metaKey && !e.ctrlKey && e.key === '[') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (!inField && !e.metaKey && !e.ctrlKey && e.key === ']') {
        e.preventDefault();
        setInspectorOpen((o) => !o);
        return;
      }

      if (inField) return;
      if (e.key === 'Escape') {
        setDrop({ kind: 'none' });
        setConnect((c) => (c.on ? { ...c, on: false, fromWsId: null, fromPort: null } : c));
        setExtraSelectedWs(new Set());
        setTool('pointer');
        setSelectRect(null);
        return;
      }

      // Cmd/Ctrl+Z — undo. Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) — redo.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoTwin();
        else undoTwin();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoTwin();
        return;
      }

      // V — toggle the SELECT tool (Figma/Sketch convention).
      if (e.key === 'v' || e.key === 'V') {
        if (!e.metaKey && !e.ctrlKey) {
          setTool((t) => (t === 'select' ? 'pointer' : 'select'));
          setDrop({ kind: 'none' });
          setConnect((c) => ({ ...c, on: false, fromWsId: null, fromPort: null }));
          setSelectRect(null);
          return;
        }
      }

      // Cmd/Ctrl+A — select every workstation in the active twin.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        selectAllWs();
        return;
      }
      // Cmd/Ctrl+C — copy current ws selection.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
        if (copySelection()) e.preventDefault();
        return;
      }
      // Cmd/Ctrl+X — cut current ws selection.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X')) {
        const before = (selected?.kind === 'ws' ? 1 : 0) + extraSelectedWs.size;
        if (before > 0) {
          e.preventDefault();
          cutSelection();
        }
        return;
      }
      // Cmd/Ctrl+V — paste at cursor.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        if (clipboardRef.current && clipboardRef.current.workstations.length > 0) {
          e.preventDefault();
          pasteClipboard();
        }
        return;
      }

      if (!selected && extraSelectedWs.size === 0) return;
      if (e.key === 'r' || e.key === 'R') {
        // Rotate every selected workstation in step (anchor + marquee extras)
        // so a multi-select cluster all face the same new direction together.
        // SHIFT reverses the rotation step (counter-clockwise).
        const dir: 1 | -1 = e.shiftKey ? -1 : 1;
        const ids = new Set<string>();
        if (selected?.kind === 'ws') ids.add(selected.id);
        for (const id of extraSelectedWs) ids.add(id);
        for (const id of ids) rotateWorkstation(id, dir);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete the entire ws selection set (anchor + extras).
        const ids = new Set<string>();
        if (selected?.kind === 'ws') ids.add(selected.id);
        for (const id of extraSelectedWs) ids.add(id);
        for (const id of ids) removeWorkstation(id);
        setSelected(null);
        setExtraSelectedWs(new Set());
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        if (selected?.kind === 'ws') {
          e.preventDefault();
          const newId = duplicateWorkstation(selected.id);
          if (newId) setSelected({ kind: 'ws', id: newId });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, extraSelectedWs, rotateWorkstation, removeWorkstation, duplicateWorkstation, selectAllWs, copySelection, cutSelection, pasteClipboard, undoTwin, redoTwin]);

  // ── Save / Save As ─────────────────────────────────────────────────────────
  // Two flows:
  //   • Save     — re-stamps modifiedAt on the active twin (canonical or
  //                scenario) and flashes a "Saved" toast. Edits are already
  //                auto-persisted by the zustand persist middleware; the
  //                button exists to give the user a clear commit moment.
  //   • Save As… — opens a small inline modal that asks for a scenario
  //                name + optional notes, then forks the *active* twin
  //                (canonical → new scenario, or scenario → branched
  //                scenario via forkScenario). Activates the new scenario
  //                so the user immediately edits the fork rather than the
  //                source.
  /** Transient "Saved · HH:MM:SS" indicator next to the Save button. */
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** Open state + draft fields for the Save-As modal. */
  const [saveAs, setSaveAs] = useState<{
    open: boolean;
    name: string;
    notes: string;
    activate: boolean;
  }>({ open: false, name: '', notes: '', activate: true });

  const onSave = useCallback(() => {
    touchActive();
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    setSavedAt(`${hh}:${mm}:${ss}`);
    // Clear after a short window so the chip doesn't linger forever.
    window.setTimeout(() => {
      setSavedAt((cur) => (cur === `${hh}:${mm}:${ss}` ? null : cur));
    }, 2400);
  }, [touchActive]);

  const onSaveAsOpen = useCallback(() => {
    // Default name: "<active name> (copy)" so the user sees the lineage; if
    // that would collide with an existing scenario name we suffix a counter.
    const base = `${twin.name || 'Factory'} (copy)`;
    const existing = new Set(scenarios.map((s) => s.name));
    let candidate = base;
    let i = 2;
    while (existing.has(candidate)) {
      candidate = `${base} ${i++}`;
    }
    setSaveAs({ open: true, name: candidate, notes: '', activate: true });
  }, [twin.name, scenarios]);

  const onSaveAsConfirm = useCallback(() => {
    const name = saveAs.name.trim();
    if (!name) return;
    if (activeScenarioId === null) {
      createScenarioFromCanonical({
        name,
        notes: saveAs.notes.trim() || undefined,
        activate: saveAs.activate,
      });
    } else {
      forkScenario(activeScenarioId, {
        name,
        notes: saveAs.notes.trim() || undefined,
        activate: saveAs.activate,
      });
    }
    setSaveAs({ open: false, name: '', notes: '', activate: true });
  }, [saveAs, activeScenarioId, createScenarioFromCanonical, forkScenario]);

  const onSaveAsCancel = useCallback(() => {
    setSaveAs({ open: false, name: '', notes: '', activate: true });
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        // Collapsed panes shrink to a RAIL_W stub and give up their splitter
        // (a 0px resize column) so there's no orphan drag handle beside a rail.
        gridTemplateColumns: [
          `${paletteOpen ? paletteWidth : RAIL_W}px`,
          `${paletteOpen ? SPLITTER_W : 0}px`,
          '1fr',
          `${inspectorOpen ? SPLITTER_W : 0}px`,
          `${inspectorOpen ? inspectorWidth : RAIL_W}px`,
        ].join(' '),
        gridTemplateRows: 'auto 1fr',
        background: SW_COLORS.paperDeep,
        fontFamily: SW_FONTS.body,
      }}
    >
      {/* TOP TOOLBAR */}
      <div
        style={{
          gridColumn: '1 / 6',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          rowGap: 8,
          gap: 12,
          padding: '10px 16px',
          background: SW_COLORS.paper,
          borderBottom: `1px solid ${SW_COLORS.line}`,
          minWidth: 0,
        }}
      >
        <button onClick={() => navigate('/')} style={btnIcon()} title="Back to menu" aria-label="Back to menu">
          <Icon name="back" />
        </button>
        {/* Title and the full action row (FACTORY picker, SAVE, SAVE AS,
            DELETE, ✓ READY chip, SIMULATE, BEST) sit on a single
            horizontal baseline. The READY chip lives between DELETE and
            SIMULATE so the pre-flight health is read right before the
            user commits to a sim run. */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <ViewTitle title="Factory Builder" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ ...sectionLabel, marginBottom: 0 }}>FACTORY</span>
            <HudSelect
              value={activeScenarioId ?? '__canonical__'}
              onChange={(v) => {
                if (v.startsWith('lib:')) {
                  loadSavedFactory(v.slice(4));
                  setSelected(null);
                  return;
                }
                if (v === '__divider_saved__') return;
                setActiveScenario(v === '__canonical__' ? null : v);
                setSelected(null);
              }}
              variant="light"
              size="sm"
              minWidth={280}
              options={[
                {
                  value: '__canonical__',
                  label: `◆ Canonical · ${projectName || canonical.name}`,
                },
                ...scenarios.map((scn) => ({
                  value: scn.id,
                  label: `${bestScenario?.id === scn.id ? '★' : '✦'} ${scn.name}`,
                  tag: bestScenario?.id === scn.id ? 'BEST' : undefined,
                })),
                ...(savedFactories.length > 0
                  ? [
                      {
                        value: '__divider_saved__',
                        label: `── SAVED FACTORIES · ${savedFactories.length} ──`,
                        disabled: true,
                      },
                      ...[...savedFactories]
                        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
                        .map((f) => ({
                          value: `lib:${f.id}`,
                          label: `${f.pinned ? '★' : '📚'} ${f.name}`,
                          tag: `${f.stationCount} STN`,
                        })),
                    ]
                  : []),
              ]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={onSave}
            style={{
              ...btnPrim(),
              ...btnIcon(),
              background: savedAt ? SW_COLORS.ok : SW_COLORS.brand,
              border: 'none',
              color: SW_COLORS.void,
              transition: 'background 160ms',
            }}
            aria-label="Save"
            title={
              savedAt
                ? `Saved at ${savedAt} — save again`
                : activeScenarioId === null
                  ? 'Save the current configuration into the canonical factory'
                  : 'Save the current configuration into this scenario'
            }
          >
            <Icon name={savedAt ? 'check' : 'save'} />
          </button>
          <button
            onClick={onSaveAsOpen}
            style={btnIcon()}
            aria-label="Save as new scenario"
            title={
              activeScenarioId === null
                ? 'Save as… — fork the canonical twin into a new scenario'
                : 'Save as… — fork this scenario into a new branched scenario'
            }
          >
            <Icon name="saveAs" />
          </button>
          <button
            onClick={async () => {
              if (activeScenarioId === null) return;
              const name = twin.name || 'this scenario';
              if (await confirm({ title: 'Delete scenario', message: `Delete scenario "${name}"? This cannot be undone.`, confirmLabel: 'Delete', variant: 'danger' })) {
                deleteScenario(activeScenarioId);
                setSelected(null);
              }
            }}
            disabled={activeScenarioId === null}
            style={{
              ...btnIcon(),
              color: activeScenarioId === null ? SW_COLORS.muted : SW_COLORS.alarm,
              borderColor: activeScenarioId === null ? SW_COLORS.line : SW_COLORS.alarm + '60',
              cursor: activeScenarioId === null ? 'not-allowed' : 'pointer',
              opacity: activeScenarioId === null ? 0.55 : 1,
            }}
            title={
              activeScenarioId === null
                ? 'Canonical factory cannot be deleted — switch to a scenario first, or fork via SAVE AS…'
                : `Delete the active scenario "${twin.name}"`
            }
            aria-label="Delete scenario"
          >
            <Icon name="trash" />
          </button>
          {/* Pre-flight graph health chip — sits between DELETE and
              SIMULATE so the green / amber / red status is the last
              thing the user reads before committing to a run. */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setIssuesOpen((v) => !v)}
              title={
                pmlIssues.length === 0
                  ? 'Graph passes pre-flight checks — ready to run.'
                  : 'Click to expand the pre-flight issue list.'
              }
              style={{
                ...btnSec(),
                background:
                  errorCount > 0
                    ? SW_COLORS.alarmWell
                    : warnCount > 0
                      ? alpha(SW_COLORS.warn, 0.10)
                      : alpha(SW_COLORS.ok, 0.10),
                borderColor:
                  errorCount > 0
                    ? SW_COLORS.alarm + '55'
                    : warnCount > 0
                      ? SW_COLORS.warn + '55'
                      : SW_COLORS.okDeep,
                color:
                  errorCount > 0 ? SW_COLORS.alarm : warnCount > 0 ? SW_COLORS.warn : SW_COLORS.ok,
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 800,
                height: 30,
                padding: '0 9px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
              aria-label={`Pre-flight — ${errorCount} error, ${warnCount} warning, ${infoCount} hint`}
            >
              {/* Glyph carries the verdict, the digits carry the volume —
                  no words, same read as the rest of the toolbar. */}
              <Icon
                name={errorCount > 0 ? 'alert' : warnCount > 0 ? 'warn' : 'check'}
                size={12}
              />
              {pmlIssues.length > 0 && (
                <span>
                  {errorCount > 0
                    ? `${errorCount}${warnCount + infoCount > 0 ? ` · ${warnCount + infoCount}` : ''}`
                    : warnCount > 0
                      ? `${warnCount}${infoCount > 0 ? ` · ${infoCount}` : ''}`
                      : `${infoCount}`}
                </span>
              )}
            </button>
            {issuesOpen && pmlIssues.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  zIndex: 10,
                  width: 360,
                  maxHeight: 320,
                  overflowY: 'auto',
                  background: SW_COLORS.steel,
                  border: `1px solid ${SW_COLORS.line}`,
                  borderRadius: 6,
                  boxShadow: SW_SHADOWS.hud,
                  padding: 8,
                }}
              >
                <div style={{ ...sectionLabel, marginBottom: 6 }}>
                  Pre-flight · {pmlIssues.length} issue{pmlIssues.length === 1 ? '' : 's'}
                </div>
                {pmlIssues.map((iss, i) => {
                  const tone =
                    iss.level === 'error'
                      ? SW_COLORS.alarm
                      : iss.level === 'warn'
                        ? SW_COLORS.warn
                        : SW_COLORS.muted;
                  const glyph =
                    iss.level === 'error' ? '⨯' : iss.level === 'warn' ? '⚠' : '·';
                  return (
                    <div
                      key={i}
                      onClick={() => {
                        if (iss.wsId) setSelected({ kind: 'ws', id: iss.wsId });
                      }}
                      style={{
                        padding: '6px 8px',
                        borderLeft: `3px solid ${tone}`,
                        background: SW_COLORS.paperDeep,
                        borderRadius: 3,
                        marginBottom: 4,
                        fontSize: 11,
                        lineHeight: 1.4,
                        color: SW_COLORS.muted,
                        cursor: iss.wsId ? 'pointer' : 'default',
                      }}
                      title={iss.wsId ? 'Click to select this block in the inspector' : undefined}
                    >
                      <strong style={{ color: tone, fontFamily: SW_FONTS.mono, marginRight: 6 }}>
                        {glyph} {iss.level.toUpperCase()}
                      </strong>
                      {iss.message}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {(() => {
            const simulatableCount = twin.workstations.filter(
              (ws) => ws.operation.opId != null,
            ).length;
            const canSimulate = simulatableCount > 0;
            return (
              <button
                onClick={() => {
                  if (!canSimulate) return;
                  touchActive();
                  // Run PML once synchronously and write per-block observed
                  // KPIs back to the twin store so the Inspector's KPI lens
                  // surfaces fresh numbers immediately (no manual re-run
                  // required). The legacy ▶ RUN SIM button did this too.
                  // Wrapped in try/catch — engine throws only on truly
                  // broken graphs, and the pre-flight chip already warns.
                  try {
                    runPmlOnTwin(twin, { writeKpiObserved: setKpiObserved });
                  } catch {
                    /* pre-flight chip already surfaces the cause */
                  }
                  navigate('/sim?source=twin');
                }}
                disabled={!canSimulate}
                style={{
                  ...btnPrim(),
                  background: canSimulate ? SW_COLORS.brand : SW_COLORS.steel,
                  color: canSimulate ? SW_COLORS.void : SW_COLORS.muted,
                  cursor: canSimulate ? 'pointer' : 'not-allowed',
                  opacity: canSimulate ? 1 : 0.65,
                }}
                title={
                  canSimulate
                    ? `Simulate this factory · ${simulatableCount} workstation${simulatableCount === 1 ? '' : 's'} ready`
                    : 'Assign an operation to at least one workstation before simulating.'
                }
              >
                ▶ SIMULATE
              </button>
            );
          })()}
          {bestScenario && (
            <button
              onClick={() => {
                setActiveScenario(bestScenario.id);
                setSelected(null);
              }}
              title={`Leader on latest sim · ${Math.round(bestScenario.throughput).toLocaleString()} pcs/hr · ${bestScenario.eff.toFixed(1)}% eff — click to switch`}
              style={{
                background: activeScenarioId === bestScenario.id ? SW_COLORS.okDeep : alpha(SW_COLORS.ok, 0.10),
                border: `1px solid ${SW_COLORS.okDeep}`,
                color: activeScenarioId === bestScenario.id ? SW_COLORS.void : SW_COLORS.ok,
                padding: '5px 9px',
                fontFamily: SW_FONTS.display,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: '0.06em',
                cursor: 'pointer',
                borderRadius: 6,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                maxWidth: 180,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              <span>★ BEST</span>
              <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {bestScenario.name}
              </span>
            </button>
          )}
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* Undo / redo and the SELECT tool used to live here as toolbar
            chips; they were removed because the keyboard shortcuts
            (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z, V) cover the same ground without
            crowding the header. The handlers below — undoTwin, redoTwin,
            and the tool toggle in the keydown listener — stay wired so
            the features themselves are unchanged. */}

        {/* Selection + clipboard chip — surfaces the number of workstations
            currently selected (use the SELECT tool's rectangle marquee to
            pick many at once) and the size of the copy buffer, plus the
            shortcuts. Hidden when both are empty so the toolbar stays
            clean at rest. */}
        {(selectedWsIds.size > 0 || clipboard) && (
          <div
            title="▭ SELECT marquee · ⇧+Click toggles a station in/out · Drag any selected to move the whole group · ⌘/Ctrl+A select all · ⌘/Ctrl+C copy · ⌘/Ctrl+X cut · ⌘/Ctrl+V paste at cursor · Esc clears"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 9px',
              borderRadius: 6,
              border: `1px solid ${SW_COLORS.line}`,
              background: SW_COLORS.paperDeep,
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: SW_COLORS.muted,
            }}
          >
            {selectedWsIds.size > 0 && (
              <span>
                <span style={{ color: SW_COLORS.brand, fontWeight: 900 }}>
                  {selectedWsIds.size}
                </span>
                {' '}SELECTED
              </span>
            )}
            {selectedWsIds.size > 0 && clipboard && (
              <span style={{ opacity: 0.4 }}>·</span>
            )}
            {clipboard && (
              <span>
                <span style={{ color: SW_COLORS.bobbin, fontWeight: 900 }}>
                  {clipboard.workstations.length}
                </span>
                {' '}ON CLIPBOARD
              </span>
            )}
          </div>
        )}

        {/* Canvas-mode toggle moved into the canvas overlay (top-center,
            in line with the CONTROLS dropdown). See the absolute-positioned
            block inside the canvas div below. */}

        {/* Connect-flow tool moved into the canvas overlay (top-left,
            in line with the canvas-mode toggle and CONTROLS dropdown).
            See the absolute-positioned block inside the canvas div below. */}

        {/* EXPORT JSON moved to Settings → PROJECT card so factory-level
            actions (export, scenarios, composition) live in one place.
            LOAD REF FACTORY moved to Menu → SAVED FACTORIES as a
            "Reference Factory" preset tile so picking which factory to
            open happens on the home screen, not from inside Builder. */}

        {/* RUN SIM button + its inline toast were removed when the legacy
            engine was retired. ▶ SIMULATE (above) is the single entry point
            into /sim, which auto-runs PML on mount and shows the same
            throughput / lead-time numbers in the playback chrome. */}
      </div>


      {/* Deep-link confirmation chip — shows for a few seconds after the
          user lands on /builder?line=<id> from the Simulation or Orders tab,
          confirming which line is now selected in the Inspector. */}
      {lineDeepLink && (() => {
        const ln = (twin.lines ?? []).find((l) => l.id === lineDeepLink);
        if (!ln) return null;
        return (
          <div
            onClick={() => setLineDeepLink(null)}
            title="Click to dismiss"
            style={{
              gridColumn: '3',
              gridRow: '2',
              position: 'absolute',
              top: 56,
              right: 16,
              zIndex: 6,
              padding: '8px 12px',
              background: SW_COLORS.ink,
              color: SW_COLORS.paper,
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              fontWeight: 700,
              borderRadius: 6,
              boxShadow: '0 6px 16px rgba(0,0,0,0.22)',
              cursor: 'pointer',
              borderLeft: `4px solid ${SW_COLORS.ok}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontFamily: SW_FONTS.display, fontSize: 10, letterSpacing: '0.1em', color: SW_COLORS.ok }}>
              ✎ EDITING LINE
            </span>
            <span>{ln.name}</span>
          </div>
        );
      })()}

      {/* Station-type authoring. Mounted here rather than inside the palette
          so it survives the palette collapsing while the dialog is open. */}
      <StationTypeDialog
        open={typeDialogOpen}
        editing={editingType}
        groups={Array.from(new Set(stationTypes.map((t) => t.group)))}
        onSave={saveStationType}
        onCancel={() => { setTypeDialogOpen(false); setEditingType(null); }}
      />

      {/* LEFT PALETTE — collapses to a click-to-open rail */}
      {paletteOpen ? (
        <Palette
          tab={paletteTab}
          apparelSections={apparelSections}
          paletteSearch={paletteSearch}
          onPaletteSearch={setPaletteSearch}
          drop={drop}
          onPickWs={(catalogId, presetId) => setDrop({ kind: 'ws', catalogId, presetId })}
          onEditStationType={(t) => { setEditingType(t); setTypeDialogOpen(true); }}
          onDeleteStationType={deleteStationType}
          onCollapse={() => setPaletteOpen(false)}
        />
      ) : (
        <CollapsedRail side="left" label="PALETTE" onExpand={() => setPaletteOpen(true)} />
      )}

      {/* LEFT SPLITTER (palette ↔ canvas) — only while the palette is open */}
      {paletteOpen && (
        <div
          onMouseDown={startSideResize('left')}
          onDoubleClick={() => setPaletteWidth(280)}
          title="Drag to resize · double-click to reset"
          style={{
            gridColumn: '2',
            gridRow: '2',
            cursor: 'col-resize',
            background: 'transparent',
            position: 'relative',
            zIndex: 5,
          }}
        />
      )}

      {/* CANVAS — the stage ground sits a full surface step below the panels
          (void, not paper) with the blueprint grid painted on it, so the
          floor plan reads as the brightest thing on screen and the side
          panels read as chrome floating above it. */}
      <div
        ref={stageRef}
        onMouseMove={onCanvasMouseMove}
        onClick={onCanvasClick}
        onMouseDown={onPanStart}
        style={{
          gridColumn: '3',
          gridRow: '2',
          position: 'relative',
          overflow: 'hidden',
          // Void ground with a faint overhead glow — the SVG above it keeps
          // its background transparent so this vignette reads through.
          background: `radial-gradient(120% 90% at 50% 12%, ${alpha(SW_COLORS.paperDeep, 0.55)} 0%, ${SW_COLORS.void} 70%)`,
          cursor: cam.spacePan
            ? (cam.panning ? 'grabbing' : 'grab')
            : cam.panning
              ? 'grabbing'
              : drop.kind !== 'none'
                ? 'crosshair'
                : tool === 'select'
                  ? 'crosshair'
                  // Dragging the background pans in every view, so every view
                  // shows the grab hand for it.
                  : 'grab',
          touchAction: 'none',
        }}
      >
        {/* Hint chip when a tool is armed. Sits below the top-left toolbar
            row (Connect · canvas-mode · Controls) so the banner doesn't get
            hidden behind those overlays. Subtle paper-on-ink styling so it
            reads as guidance, not as the loud orange accent. */}
        {drop.kind !== 'none' && (
          <div
            style={{
              position: 'absolute',
              top: 56,
              left: 12,
              zIndex: 5,
              padding: '7px 11px',
              background: SW_COLORS.paper + 'ee',
              color: SW_COLORS.muted,
              border: `1px solid ${SW_COLORS.line}`,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              fontFamily: SW_FONTS.body,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.02em',
              borderRadius: 6,
            }}
          >
            <span style={{ color: SW_COLORS.brand, fontWeight: 900, marginRight: 6 }}>✚</span>
            Click anywhere on the canvas to place a workstation
          </div>
        )}

        {tool === 'select' && drop.kind === 'none' && !connect.on && (
          <div
            style={{
              position: 'absolute',
              top: 56,
              left: 12,
              zIndex: 5,
              padding: '7px 11px',
              background: SW_COLORS.paper + 'ee',
              color: SW_COLORS.muted,
              border: `1px solid ${SW_COLORS.line}`,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              fontFamily: SW_FONTS.body,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.02em',
              borderRadius: 6,
            }}
          >
            <span style={{ color: SW_COLORS.brand, fontWeight: 900, marginRight: 6 }}>▭</span>
            Drag to select · ⇧+drag adds to selection · ⇧+click toggles a station · Esc or V to exit
          </div>
        )}

        {connect.on && (
          <div
            style={{
              position: 'absolute',
              top: 56,
              left: 12,
              zIndex: 5,
              padding: '8px 12px',
              background: CONNECTOR_HEX[connect.kind],
              color: SW_COLORS.paper,
              fontFamily: SW_FONTS.display,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: '0.06em',
              borderRadius: 6,
              boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            }}
          >
            ➜ {connect.kind.toUpperCase()} ·{' '}
            {connect.fromWsId === null
              ? canvasMode === 'process'
                ? 'Click an OUTPUT port (●) to start'
                : 'Click the SOURCE workstation'
              : canvasMode === 'process'
                ? `from ${connect.fromPort ?? 'out'} → click an INPUT port (◯)`
                : 'Click the TARGET (Esc to stop)'}
          </div>
        )}

        {/* Empty floor — the ONE empty state for the canvas, in every view.
            It lives on the stage rather than inside a view so 2D, ISO and
            PROCESS cannot disagree about whether the floor is empty; only the
            second line changes, because the palette changes with the view. */}
        {twin.workstations.length === 0 && drop.kind === 'none' && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              color: SW_COLORS.muted,
              fontFamily: SW_FONTS.body,
              pointerEvents: 'none',
              zIndex: 4,
            }}
          >
            <div style={{ ...SW_TYPE.title, color: SW_COLORS.muted, marginBottom: 4 }}>
              Empty factory
            </div>
            <div style={{ fontSize: 13 }}>
              {canvasMode === 'process'
                ? 'Pick a block from the palette and click anywhere to place it, then wire the ports.'
                : 'Pick a station from the palette and click anywhere to place it.'}
            </div>
          </div>
        )}

        {/* Stage transform — pan/zoom is applied inside the SVG (see the
            inner <g> in CanvasSVG) so the SVG itself always fills the stage
            at 100%. If we instead CSS-scaled this wrapper, zooming out would
            shrink the SVG into a small island and let the stage background
            bleed through; doing it inside the SVG keeps the floor + grid
            covering the whole viewport at any zoom. */}
        {canvasMode !== 'process' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
            }}
          >
            <CanvasSVG
              twin={twin}
              lens={lens}
              hoverCell={hoverCell}
              drop={drop}
              projection={proj}
              selected={selected}
              selectedWsIds={selectedWsIds}
              selectRect={selectRect}
              connect={connect}
              zoom={zoom}
              pan={pan}
              stageSize={stageSize}
              clipboardGhost={
                // Only paint the ghost when paste is the next likely action —
                // i.e. no drop tool armed, not wiring connectors, not arming
                // the marquee. Keeps the canvas quiet at rest while still
                // showing the user exactly where ⌘V will land.
                clipboard && drop.kind === 'none' && !connect.on && tool === 'pointer' && hoverCell
                  ? { workstations: clipboard.workstations, anchor: clipboard.anchor }
                  : null
              }
              onSelect={(s, modifiers) => {
                if (connect.on && s?.kind === 'ws') {
                  if (connect.fromWsId === null) {
                    // Default fromPort to the source block's first output —
                    // overridden if the user authors via the PROCESS canvas.
                    const src = twin.workstations.find((w) => w.id === s.id);
                    const fromPort = src ? getBlockSpec(src).outputs[0]?.id ?? null : null;
                    setConnect((c) => ({ ...c, fromWsId: s.id, fromPort }));
                  } else if (connect.fromWsId !== s.id) {
                    const tgt = twin.workstations.find((w) => w.id === s.id);
                    const toPort = tgt ? getBlockSpec(tgt).inputs[0]?.id : undefined;
                    addConnector({
                      kind: connect.kind,
                      fromWsId: connect.fromWsId,
                      toWsId: s.id,
                      fromPort: connect.fromPort ?? undefined,
                      toPort,
                    });
                    // Chain: keep target as the next source so users can build
                    // a sequential line quickly. ESC or button toggles off.
                    const nextFromPort = tgt ? getBlockSpec(tgt).outputs[0]?.id ?? null : null;
                    setConnect((c) => ({ ...c, fromWsId: s.id, fromPort: nextFromPort }));
                  }
                  return;
                }
                selectWs(s, modifiers?.shift);
              }}
              onRemoveConnector={removeConnector}
              onStartDrag={(kind, id, e) => {
                // Suppress drag while connecting so the click selects instead.
                if (connect.on && kind === 'ws') return;
                startEntityDrag(kind, id, e);
              }}
            />
          </div>
        ) : (
          <BuilderProcessView
            twin={twin}
            selected={selected}
            selectedWsIds={selectedWsIds}
            onSelect={selectWs}
            selectRect={selectRect}
            selectToolArmed={tool === 'select'}
            drop={drop}
            setDrop={setDrop}
            addWorkstation={addWorkstation}
            addConnector={addConnector}
            removeConnector={removeConnector}
            setProcessPositions={setProcessPositions}
            connect={connect}
            cam={processCam}
            stageSize={stageSize}
            onFitRequest={fitView}
            onPickFromPort={(wsId, portId) =>
              setConnect((c) => ({ ...c, fromWsId: wsId, fromPort: portId }))
            }
            onPickToPort={(wsId, portId) => {
              if (!connect.fromWsId || connect.fromWsId === wsId) return;
              addConnector({
                kind: connect.kind,
                fromWsId: connect.fromWsId,
                toWsId: wsId,
                fromPort: connect.fromPort ?? undefined,
                toPort: portId,
              });
              // Chain: leave the target as the next source on its first
              // output, so users can extend the wire down the line by
              // clicking input ports without re-picking the source.
              const tgt = twin.workstations.find((w) => w.id === wsId);
              const nextFromPort = tgt ? getBlockSpec(tgt).outputs[0]?.id ?? null : null;
              setConnect((c) => ({ ...c, fromWsId: wsId, fromPort: nextFromPort }));
            }}
          />
        )}

        {/* Save-As modal — fork the active twin into a new scenario */}
        {saveAs.open && (
          <SaveAsScenarioModal
            sourceLabel={
              activeScenarioId === null
                ? `Canonical · ${twin.name}`
                : twin.name
            }
            isForkOfScenario={activeScenarioId !== null}
            name={saveAs.name}
            notes={saveAs.notes}
            activate={saveAs.activate}
            onNameChange={(name) => setSaveAs((s) => ({ ...s, name }))}
            onNotesChange={(notes) => setSaveAs((s) => ({ ...s, notes }))}
            onActivateChange={(activate) => setSaveAs((s) => ({ ...s, activate }))}
            onCancel={onSaveAsCancel}
            onConfirm={onSaveAsConfirm}
          />
        )}

        {/* Zoom & framing — the same control the simulation floor uses. */}
        <ZoomHud
          zoom={canvasMode === 'process' ? processCam.z : zoom}
          onZoomStep={cam.zoomStep}
          onFit={fitView}
        />

        {/* Bottom-left counter strip */}
        <div
          style={{
            position: 'absolute',
            bottom: 14,
            left: 14,
            display: 'flex',
            gap: 8,
            zIndex: 5,
            alignItems: 'center',
          }}
        >
          <CountChip label="LINES" value={(twin.lines ?? []).length} />
          <CountChip label="STATIONS" value={twin.workstations.length} />
        </div>

        {/* Bottom-right canvas legend — sits above the zoom controls.
            Explains the connector kinds (flow / operator / material) and the
            carrier letter badges painted on flow connectors (B/P/H/T). In ISO
            it also shows the station-header pill for the ACTIVE lens only, so
            the legend matches what's currently painted on the floor. */}
        <IsoLegend lens={lens} canvasMode={canvasMode} />

        {/* Top-left connect-flow tool — sits at the same vertical baseline
            as the canvas-mode toggle and CONTROLS dropdown so the three
            read as one row of overlays. */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 6,
            display: 'flex',
            gap: 2,
            background: alpha(SW_COLORS.void, 0.92),
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            padding: 2,
            borderRadius: SW_RADIUS.sm + 2,
            border: `1px solid ${SW_COLORS.line}`,
          }}
          title="Draw a directed flow / operator / material link between two workstations"
        >
          <button
            onClick={() => {
              setDrop({ kind: 'none' });
              setConnect((c) => ({ ...c, on: !c.on, fromWsId: null, fromPort: null }));
            }}
            onMouseEnter={(e) => {
              if (!connect.on) e.currentTarget.style.color = SW_COLORS.ink;
            }}
            onMouseLeave={(e) => {
              if (!connect.on) e.currentTarget.style.color = SW_COLORS.muted;
            }}
            style={{
              ...SW_TYPE.kicker,
              letterSpacing: '0.08em',
              background: connect.on ? SW_COLORS.brand : 'transparent',
              color: connect.on ? SW_COLORS.void : SW_COLORS.muted,
              border: 'none',
              padding: '7px 13px',
              cursor: 'pointer',
              borderRadius: SW_RADIUS.sm,
              transition: `background ${SW_MOTION.instant}ms ${SW_MOTION.standard}, color ${SW_MOTION.instant}ms ${SW_MOTION.standard}`,
            }}
          >
            ➜ CONNECT
          </button>
          {connect.on && (
            <HudSelect
              value={connect.kind}
              onChange={(v) => setConnect((c) => ({ ...c, kind: v as ConnectorKind }))}
              variant="light"
              size="sm"
              mono
              minWidth={120}
              options={[
                { value: 'flow', label: 'FLOW' },
                { value: 'operator', label: 'OPERATOR' },
                { value: 'material', label: 'MATERIAL' },
              ]}
            />
          )}
        </div>

        {/* Top-centre canvas-mode toggle — sits at the same vertical baseline
            as the CONTROLS dropdown so the two read as one row of overlays. */}
        <ViewSwitch
          value={canvasMode}
          onChange={switchCanvasMode}
          title="Switch the canvas: 2D top-down plan (default) · ISO isometric · PROCESS PML block diagram with input/output ports"
          options={[
            { value: '2d', label: '2D' },
            { value: 'iso', label: 'ISO' },
            { value: 'process', label: 'PROCESS' },
          ]}
        />

        {/* Floor-overlay lens switch — moved here from the inspector so it
            reads as a canvas view-mode control. It drives what every station
            paints (operation code · worker count · utilisation heat-map); the
            floor canvases (2D · ISO) render those overlays, so the switch is
            scoped to them. Sits directly under the canvas-mode toggle; active
            = ink so it reads distinctly from the brand-green toggle above. */}
        {canvasMode !== 'process' && (
          <div
            role="tablist"
            style={{
              position: 'absolute',
              top: 52,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 6,
              display: 'flex',
              gap: 2,
              background: alpha(SW_COLORS.void, 0.92),
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              padding: 2,
              borderRadius: SW_RADIUS.sm + 2,
              border: `1px solid ${SW_COLORS.line}`,
            }}
            title="Floor overlay — what each station shows · OPERATIONS: operation code · RESOURCES: worker count · KPIS: utilisation heat-map"
          >
            {(
              [
                ['operations', 'OPERATIONS'],
                ['resources', 'RESOURCES'],
                ['kpis', 'KPIS'],
              ] as const
            ).map(([l, label]) => (
              <button
                key={l}
                role="tab"
                aria-selected={lens === l}
                onClick={() => setLens(l)}
                onMouseEnter={(e) => {
                  if (lens !== l) e.currentTarget.style.color = SW_COLORS.ink;
                }}
                onMouseLeave={(e) => {
                  if (lens !== l) e.currentTarget.style.color = SW_COLORS.muted;
                }}
                style={{
                  ...SW_TYPE.kicker,
                  letterSpacing: '0.08em',
                  background: lens === l ? SW_COLORS.steelLite : 'transparent',
                  color: lens === l ? SW_COLORS.ink : SW_COLORS.muted,
                  border: 'none',
                  padding: '7px 13px',
                  cursor: 'pointer',
                  borderRadius: SW_RADIUS.sm,
                  transition: `background ${SW_MOTION.instant}ms ${SW_MOTION.standard}, color ${SW_MOTION.instant}ms ${SW_MOTION.standard}`,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Top-right controls dropdown — keyboard / pointer shortcut reference */}
        <ControlsMenu />
      </div>

      {/* RIGHT SPLITTER (canvas ↔ inspector) — only while the inspector is open */}
      {inspectorOpen && (
        <div
          onMouseDown={startSideResize('right')}
          onDoubleClick={() => setInspectorWidth(340)}
          title="Drag to resize · double-click to reset"
          style={{
            gridColumn: '4',
            gridRow: '2',
            cursor: 'col-resize',
            background: 'transparent',
            position: 'relative',
            zIndex: 5,
          }}
        />
      )}

      {/* RIGHT INSPECTOR — collapses to a click-to-open rail */}
      {!inspectorOpen ? (
        <CollapsedRail side="right" label="INSPECTOR" onExpand={() => setInspectorOpen(true)} />
      ) : (
      <Inspector
        onCollapse={() => setInspectorOpen(false)}
        twin={twin}
        selected={selected}
        lens={lens}
        onUpdateWs={(id, patch) => updateWorkstation(id, patch)}
        onRemoveWs={(id) => {
          removeWorkstation(id);
          setSelected(null);
        }}
        onSetOperation={setOperation}
        onSetResources={setResources}
        onSetKpiTargets={setKpiTargets}
        onSetBlock={setBlock}
        onRemoveConnector={removeConnector}
        onAddLine={() => {
          const n = (twin.lines ?? []).length + 1;
          addLine({
            name: `Line ${String.fromCharCode(64 + n)} · new`,
            productionSystem: 'PBS',
            color: 'blue',
            garmentId: undefined,
          });
        }}
        onRemoveLine={(id) => removeLine(id)}
        onUpdateLine={(id, patch) => updateLine(id, patch)}
        onAssignLine={(wsId, lineId) => setLineForWorkstations([wsId], lineId)}
      />
      )}
    </div>
  );
}

/**
 * The stub a collapsed side panel leaves in its grid column: a vertical label
 * plus a chevron pointing back toward the canvas edge it came from. The whole
 * strip is the hit target, so re-opening is a single click anywhere on it.
 */
function CollapsedRail({
  side,
  label,
  onExpand,
}: {
  side: 'left' | 'right';
  label: string;
  onExpand: () => void;
}) {
  const [hover, setHover] = useState(false);
  const edge = `1px solid ${SW_COLORS.line}`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onExpand();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Show ${label.toLowerCase()}`}
      aria-label={`Show ${label.toLowerCase()}`}
      style={{
        gridColumn: side === 'left' ? '1' : '5',
        gridRow: '2',
        ...(side === 'left' ? { borderRight: edge } : { borderLeft: edge }),
        background: hover ? SW_COLORS.paperEdge : SW_COLORS.paper,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '10px 0',
        cursor: 'pointer',
        userSelect: 'none',
        overflow: 'hidden',
        transition: 'background 120ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 12,
          fontWeight: 800,
          lineHeight: 1,
          color: hover ? SW_COLORS.brand : SW_COLORS.muted,
        }}
      >
        {side === 'left' ? '»' : '«'}
      </span>
      <span
        style={{
          writingMode: 'vertical-rl',
          fontFamily: SW_FONTS.display,
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: '0.18em',
          color: hover ? SW_COLORS.ink : SW_COLORS.muted,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  );
}

/** The ‹‹ / ›› button a side panel header uses to collapse itself to a rail. */
function PaneCollapseButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={side === 'left' ? 'Collapse palette' : 'Collapse inspector'}
      aria-label={side === 'left' ? 'Collapse palette' : 'Collapse inspector'}
      style={{
        // Square, on the shared header-row unit: the palette « and the
        // inspector » are the same control mirrored, and both sit level with
        // the chips beside them.
        width: SW_CONTROL.icon,
        height: SW_CONTROL.icon,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: `1px solid ${hover ? SW_COLORS.ink : SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1,
        fontFamily: SW_FONTS.mono,
        fontSize: 15,
        fontWeight: 800,
        color: hover ? SW_COLORS.ink : SW_COLORS.muted,
        transition: `border-color ${SW_MOTION.instant}ms linear, color ${SW_MOTION.instant}ms linear`,
      }}
    >
      {side === 'left' ? '«' : '»'}
    </button>
  );
}

// ============================================================================
// PALETTE (left)
// ============================================================================

/** One STATIONS section: a heading plus the fixtures that survive the
 *  current palette search.
 *
 *  `id` is a plain string, not an `ApparelCategoryId`: only the sewing
 *  machines are built in, and every other section is a group the user named
 *  while authoring a station type. */
interface ApparelSection {
  id: string;
  label: string;
  icon: string;
  items: IsoFixture[];
  /** Station types in this section, aligned index-for-index with `items`.
   *  Absent on the built-in section. */
  types?: StationType[];
}

interface PaletteProps {
  /** Which pane is active. Derived from the canvas view upstream (2D / ISO
   *  → 'ws' stations, PROCESS → 'pml' blocks) — the palette itself has no
   *  switcher. */
  tab: 'ws' | 'pml';
  /** Every category, in catalogue order — the pane renders them all in one
   *  scroller and skips the ones search has emptied. */
  apparelSections: ApparelSection[];
  paletteSearch: string;
  onPaletteSearch: (q: string) => void;
  drop: DropTool;
  /** `presetId` carries the apparel preset identity for BLOCKS-palette
   *  drops, enabling default-param stamping + auto-naming. Other palette
   *  drops from the STATIONS tab call this without a presetId. */
  onPickWs: (catalogId: string, presetId?: ApparelPresetId) => void;
  /** Open the station-type dialog. `type` = edit that one, null = author a
   *  new one. */
  onEditStationType: (type: StationType | null) => void;
  /** Delete an authored type. The Builder owns this because only it can see
   *  whether the twin still has stations of that type. */
  onDeleteStationType: (type: StationType) => void;
  /** Collapse the pane to its rail. */
  onCollapse: () => void;
}

/** Corner control on an authored palette tile. Kept tiny and monochrome so
 *  it reads as chrome on the tile rather than competing with the station
 *  artwork underneath it. */
function TileAction({
  glyph,
  title,
  onClick,
}: {
  glyph: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        // The tile behind this arms a drop — a click on the control must not
        // also place a station.
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 15,
        height: 15,
        padding: 0,
        lineHeight: 1,
        fontSize: 8,
        fontFamily: SW_FONTS.display,
        fontWeight: 900,
        color: SW_COLORS.muted,
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: 3,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {glyph}
    </button>
  );
}

function Palette(props: PaletteProps) {
  const wsHitCount = props.apparelSections.reduce((n, s) => n + s.items.length, 0);
  const searching = Boolean(props.paletteSearch.trim());

  /** Collapsed STATIONS sections, by category id. Local to the palette —
   *  it's view furniture, not authored twin state, so it doesn't belong in
   *  the store or a saved factory. */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSection = (id: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const nonEmpty = props.apparelSections.filter((s) => s.items.length > 0);
  const allCollapsed = nonEmpty.length > 0 && nonEmpty.every((s) => collapsedSections.has(s.id));
  const toggleAllSections = () =>
    setCollapsedSections(allCollapsed ? new Set() : new Set(nonEmpty.map((s) => s.id)));

  return (
    <div
      style={{
        gridColumn: '1',
        gridRow: '2',
        borderRight: `1px solid ${SW_COLORS.line}`,
        borderTop: `3px solid ${SW_COLORS.brand}`,
        background: SW_COLORS.steel,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Header row — the pane label follows the active view (the old manual
          STATIONS/BLOCKS dropdown is gone: floor views always author with
          stations, PROCESS always authors with blocks). */}
      <div
        style={{
          height: 40,
          flex: 'none',
          padding: '0 12px',
          borderBottom: `1px solid ${SW_COLORS.line}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ ...SW_TYPE.kicker, color: SW_COLORS.ink }}>Palette</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            title="Palette follows the view — STATIONS in 2D/ISO · BLOCKS in PROCESS"
            style={{
              ...SW_TYPE.kicker,
              fontSize: 10,
              letterSpacing: '0.08em',
              background: SW_COLORS.steelLite,
              color: SW_COLORS.ink,
              borderRadius: SW_RADIUS.sm,
              height: SW_CONTROL.height,
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0 8px',
            }}
          >
            {props.tab === 'ws' ? 'STN' : 'BLK'}
          </span>
          <PaneCollapseButton side="left" onClick={props.onCollapse} />
        </div>
      </div>

      {props.tab === 'ws' && (
        <>
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${SW_COLORS.line}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{ ...sectionLabel, flex: 1 }}>
                {searching
                  ? `SEARCH · ${wsHitCount} HIT${wsHitCount === 1 ? '' : 'S'}`
                  : 'ALL STATIONS'}
              </div>
              {!searching && nonEmpty.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAllSections}
                  title={allCollapsed ? 'Expand every section' : 'Collapse every section'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    ...SW_TYPE.kicker,
                    fontSize: 9,
                    color: SW_COLORS.muted,
                  }}
                >
                  {allCollapsed ? 'EXPAND ALL' : 'COLLAPSE ALL'}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => props.onEditStationType(null)}
              title="Define a station of your own — how it looks, and what it is to the simulation"
              style={{
                width: '100%',
                marginBottom: 6,
                padding: '6px 8px',
                background: SW_COLORS.paper,
                border: `1px dashed ${SW_COLORS.line}`,
                borderRadius: SW_RADIUS.sm,
                cursor: 'pointer',
                ...SW_TYPE.kicker,
                fontSize: 9,
                color: SW_COLORS.brandText,
                textAlign: 'center',
              }}
            >
              + NEW STATION TYPE
            </button>
            <input
              value={props.paletteSearch}
              onChange={(e) => props.onPaletteSearch(e.target.value)}
              placeholder="Search assets…"
              style={{ ...inputBase, fontSize: 11, fontFamily: SW_FONTS.mono }}
            />
          </div>
          {/* One continuous scroller. Every category is present at all times,
              separated by a sticky header, so the whole station catalogue is
              reachable by scrolling instead of hunting through icon tabs. */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {props.apparelSections.map((section) => {
              if (section.items.length === 0) return null;
              // A search is a request to see the hits — honour it over any
              // collapse the user left behind, without discarding that state.
              const open = !collapsedSections.has(section.id) || searching;
              return (
                <div key={section.id}>
                  <button
                    type="button"
                    onClick={() => toggleSection(section.id)}
                    aria-expanded={open}
                    title={`${open ? 'Collapse' : 'Expand'} ${section.label}`}
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 10px',
                      background: SW_COLORS.steel,
                      // Per-axis shorthands, not borderTop/borderLeft/… —
                      // mixing side longhands with the `border` shorthand the
                      // station cards use makes React warn when it reconciles
                      // one button against the other on collapse/expand.
                      borderWidth: '1px 0',
                      borderStyle: 'solid',
                      borderColor: SW_COLORS.line,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <Chevron open={open} />
                    <span style={{ fontSize: 12, color: SW_COLORS.muted, lineHeight: 1 }}>{section.icon}</span>
                    <span style={{ ...sectionLabel, flex: 1 }}>{section.label.toUpperCase()}</span>
                    <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, color: SW_COLORS.muted }}>
                      {section.items.length}
                    </span>
                  </button>
                  <div hidden={!open} style={{ padding: 8, display: open ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {section.items.map((a, i) => {
                      const armed = props.drop.kind === 'ws' && props.drop.catalogId === a.id;
                      const authored = section.types?.[i];
                      const mark = stationMark(a.id);
                      return (
                        <div key={a.id} style={{ position: 'relative' }}>
                          <button
                            onClick={() => props.onPickWs(a.id)}
                            title={a.label}
                            style={{
                              width: '100%',
                              background: armed ? SW_COLORS.brandLite : SW_COLORS.paper,
                              border: `1px solid ${armed ? SW_COLORS.brand : SW_COLORS.line}`,
                              borderRadius: 6,
                              padding: 6,
                              cursor: 'pointer',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            {/* Anything with a mark shows it — the same thing
                                it will look like once dropped on the floor.
                                Fixtures with no mechanism to draw keep the
                                isometric cuboid, which is what distinguishes a
                                rack from a trolley. */}
                            {mark.code || mark.markCode ? (
                              <svg width={56} height={42} style={{ display: 'block' }}>
                                <StationGlyph {...mark} width={56} height={42} />
                              </svg>
                            ) : (
                              <svg width={56} height={42} viewBox="-32 -24 64 48" style={{ display: 'block' }}>
                                {a.draw({ w: a.w, d: a.d, h: a.h }) as ReactNode}
                              </svg>
                            )}
                            <div style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, color: SW_COLORS.muted, textAlign: 'center', lineHeight: 1.2 }}>
                              {a.label}
                            </div>
                          </button>
                          {authored && (
                            <div style={{ position: 'absolute', top: 2, right: 2, display: 'flex', gap: 2 }}>
                              <TileAction
                                glyph="✎"
                                title={`Edit ${authored.label}`}
                                onClick={() => props.onEditStationType(authored)}
                              />
                              <TileAction
                                glyph="✕"
                                title={`Delete ${authored.label}`}
                                onClick={() => props.onDeleteStationType(authored)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {wsHitCount === 0 && (
              <div style={{ fontSize: 11, color: SW_COLORS.muted, fontStyle: 'italic', textAlign: 'center', padding: 16 }}>
                No assets match.
              </div>
            )}
          </div>
        </>
      )}

      {props.tab === 'pml' && <PmlPalettePane drop={props.drop} onPickWs={props.onPickWs} />}
    </div>
  );
}

/** BLOCKS palette pane — apparel-named block presets, grouped by apparel
 *  concept (Flow / Stations / Buffers / Routing / Resources / Bundling /
 *  Movement). Each card drops a workstation whose `block.kind` is the
 *  preset's underlying PML primitive. The user never sees raw PML
 *  vocabulary unless they open the Inspector or the Code view.
 *
 *  Tint is driven by the *underlying PML category* (consistent with the
 *  PROCESS canvas) but the labels + groupings are apparel-domain. */
function PmlPalettePane({
  drop,
  onPickWs,
}: {
  drop: DropTool;
  onPickWs: (catalogId: string, presetId?: ApparelPresetId) => void;
}) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          padding: '6px 8px',
          background: SW_COLORS.paperDeep,
          border: `1px dashed ${SW_COLORS.line}`,
          borderRadius: 4,
          fontSize: 11,
          color: SW_COLORS.muted,
          lineHeight: 1.4,
        }}
      >
        Drop a block to model one piece of the floor — a bundle source,
        an op station, a buffer, an inspection gate. Wire them in the
        <strong> PROCESS</strong> view by clicking port dots.
      </div>

      {APPAREL_BLOCK_GROUPS.map((group) => {
        const presets = apparelPresetsInGroup(group.id);
        if (presets.length === 0) return null;
        return (
          <div key={group.id}>
            <div
              style={{
                ...sectionLabel,
                marginBottom: 4,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
              title={group.blurb}
            >
              <span>{group.label}</span>
              <span style={{ fontSize: 9, color: SW_COLORS.muted, fontWeight: 700 }}>
                {presets.length}
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))',
                gap: 6,
              }}
            >
              {presets.map((preset: ApparelBlockPreset) => {
                const baseSpec = PML_BLOCK_LIBRARY[preset.baseKind];
                const fixtureId = pmlFixtureId(preset.baseKind);
                const armed = drop.kind === 'ws' && drop.catalogId === fixtureId;
                const ports = `${baseSpec.inputs.length} IN · ${baseSpec.outputs.length} OUT${baseSpec.usesResources ? ' · uses resources' : ''}`;
                return (
                  <button
                    key={preset.id}
                    onClick={() => onPickWs(fixtureId, preset.id)}
                    aria-label={preset.label}
                    title={`${preset.label} — ${preset.blurb}\n${ports}${preset.example ? '\n\n' + preset.example : ''}`}
                    style={{
                      // Neutral chrome. The tile used to BE the coloured square,
                      // inverted against the canvas (coloured glyph on a 14%
                      // well, where the canvas draws a white glyph on a solid
                      // plate). Now the button is just a surface and the face
                      // inside it is the literal miniature of what lands — the
                      // same answer the STATIONS palette gives with StationGlyph.
                      // The armed state stays on the button rather than mutating
                      // the face, so the preview never lies about the colour.
                      background: armed ? SW_COLORS.brandLite : SW_COLORS.paper,
                      border: `1px solid ${armed ? SW_COLORS.brand : SW_COLORS.line}`,
                      borderRadius: 6,
                      padding: 0,
                      aspectRatio: '1 / 1',
                      minWidth: 0,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg width={30} height={30} style={{ display: 'block', overflow: 'visible' }}>
                      <title>{preset.label}</title>
                      <PmlBlockFace category={baseSpec.category} Icon={baseSpec.Icon} size={30} />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// CANVAS SVG
// ============================================================================

interface CanvasSVGProps {
  twin: ReturnType<typeof selectActiveTwin>;
  lens: Lens;
  hoverCell: { x: number; y: number } | null;
  drop: DropTool;
  selected: { kind: 'ws'; id: string } | null;
  /** Full set of workstation ids currently in the selection (primary +
   *  marquee-extended). Every id in here gets the selection ring on the
   *  canvas. Passed in addition to `selected` so the Inspector still
   *  binds to the single anchor. */
  selectedWsIds: Set<string>;
  /** Live marquee rectangle in SVG user-space (post-pan/zoom). When
   *  non-null, the canvas paints a translucent select rect overlay. */
  selectRect: { sx0: number; sy0: number; sx1: number; sy1: number } | null;
  connect: { on: boolean; kind: ConnectorKind; fromWsId: string | null };
  /** Current canvas zoom — used to choose grid subdivision density so the
   *  grid divides further when the user zooms in. */
  zoom: number;
  /** Current pan offset in stage pixels. Drives the visible-region
   *  computation that keeps the floor + grid centred on what the user is
   *  actually looking at, so the canvas feels infinite at any pan. */
  pan: { x: number; y: number };
  /** Live size of the stage element in CSS pixels. Used to set a centred,
   *  1:1 viewBox and to compute which cells are currently on screen. */
  stageSize: { w: number; h: number };
  onSelect: (
    s: { kind: 'ws'; id: string } | null,
    modifiers?: { shift: boolean },
  ) => void;
  onRemoveConnector: (id: string) => void;
  onStartDrag: (kind: 'ws', id: string, e: React.MouseEvent) => void;
  /** Clipboard ghost — when non-empty AND no other tool is armed, the canvas
   *  paints translucent footprints at the cursor previewing where ⌘V would
   *  drop the buffered cluster. Lets users aim a paste without guessing. */
  clipboardGhost: {
    workstations: Workstation[];
    anchor: { x: number; y: number };
  } | null;
  /** Active projection pair — ISO (diamond grid, cuboid sprites) or FLAT
   *  (2D top-down plan). Every projected polygon below goes through this,
   *  so the same canvas serves both floor views. */
  projection: Projection;
}

/** Footprint center of a workstation in screen coordinates (under the given
 *  projection). Used as the arrow anchor when drawing connectors. */
function workstationScreenCenter(ws: Workstation, projection: Projection): { sx: number; sy: number } {
  const { w, d } = wsFootprint(ws);
  return projection.project(ws.position.x + w / 2, ws.position.y + d / 2);
}

function CanvasSVG(props: CanvasSVGProps) {
  const { twin, lens, hoverCell, drop, selected, selectedWsIds, selectRect, zoom, pan, stageSize, clipboardGhost, projection } = props;
  const P = projection.project;
  // OPERATIONS-lens labels resolve through the garment template (bulletin code
  // or short name) instead of the noisy namespaced opId. Pulled once here so
  // the per-station map below is a cheap dictionary lookup.
  const garmentsById = useGarments().byId;

  // Focus-dim: when there's an active selection, fade everything that isn't
  // the focused entity so the user sees what they've picked. `focusActive` is
  // true when any dept or ws is selected; `dim(focused)` returns the wrapper
  // opacity (1 for focused, FOCUS_DIM for unfocused, 1 when nothing selected).
  const focusActive = selectedWsIds.size > 0 || selected !== null;
  const dim = (focused: boolean) => (focusActive && !focused ? FOCUS_DIM : 1);
  // A line is in focus when it holds a selected workstation.
  const lineFocused = (line: SewingLine) =>
    twin.workstations.some((w) => w.lineId === line.id && selectedWsIds.has(w.id));

  // Centred 1:1 viewBox — SVG user-space units == stage CSS pixels, with
  // (0,0) at the element centre. The cursor handler in the parent relies
  // on this to map clientX/Y -> world cells without an aspect-ratio fudge.
  const W = Math.max(1, stageSize.w);
  const H = Math.max(1, stageSize.h);
  const vbMinX = -W / 2;
  const vbMinY = -H / 2;

  // Visible cell range, from the shared camera helper. The grid needs it and
  // so does the floor base polygon below, which is why it lives in
  // `domain/camera.ts` rather than inside `<CanvasGrid>`.
  const cam: Cam = { x: pan.x, y: pan.y, z: zoom };
  const { minX: gMinX, maxX: gMaxX, minY: gMinY, maxY: gMaxY } =
    visibleCellRange(projection, cam, stageSize);

  const floorTL = P(gMinX, gMinY);
  const floorTR = P(gMaxX, gMinY);
  const floorBR = P(gMaxX, gMaxY);
  const floorBL = P(gMinX, gMaxY);

  // Ghost outline of the original factory footprint — keeps the user
  // oriented while still allowing drops anywhere outside it.
  const factoryTL = P(0, 0);
  const factoryTR = P(twin.gridW, 0);
  const factoryBR = P(twin.gridW, twin.gridH);
  const factoryBL = P(0, twin.gridH);

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`${vbMinX} ${vbMinY} ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', userSelect: 'none' }}
    >
      {/* Stage-filling background — catches pan-drag clicks anywhere the
          floor doesn't reach (paranoid safeguard; the floor below already
          covers the visible cell range). Transparent so the stage's void
          ground and vignette read through; a transparent fill still
          hit-tests, a `none` fill would not. */}
      <rect
        data-canvas-bg="true"
        x={vbMinX}
        y={vbMinY}
        width={W}
        height={H}
        fill="transparent"
      />
      {/* Pan/zoom transform — applied in SVG-space rather than via CSS on
          the wrapper, so the SVG keeps filling the stage at 100% even when
          the user zooms out. Everything below this <g> is in iso-projected
          user-space (1 unit = 1 pre-zoom stage pixel). */}
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
      {/* Floor base — covers the visible cell range so the surface feels
          infinite. Marked as canvas background so panning ignores entity
          clicks but accepts background drags. Transparent (the stage ground
          shows through) but still hit-testable. */}
      <polygon
        data-canvas-bg="true"
        points={ptsToStr([floorTL, floorTR, floorBR, floorBL])}
        fill="transparent"
        stroke="none"
      />

      {/* Grid — the same component the PROCESS canvas uses, so the two
          views rule the same paper. Pitch comes from `projection`, so this
          is a diamond lattice in ISO and a square one in 2D with no branch. */}
      <CanvasGrid projection={projection} cam={cam} stageSize={stageSize} />

      {/* Original factory footprint — drawn as a faint outline so the user
          retains a "you are here" reference inside the otherwise infinite
          surface. Pointer-events disabled so the floor underneath still
          receives canvas-background clicks for panning. */}
      <polygon
        points={ptsToStr([factoryTL, factoryTR, factoryBR, factoryBL])}
        fill="none"
        stroke="#E8EDF52E"
        strokeWidth={1.2}
        strokeDasharray="6 4"
        style={{ pointerEvents: 'none' }}
      />


      {/* SEWING LINE BANDS — translucent halo around the convex bounding box
          of each line's member workstations. Drawn above departments so the
          line accent reads on top of the dept fill, but below workstations so
          machine sprites stay clickable. */}
      {(twin.lines ?? []).map((line) => (
        <g
          key={line.id}
          style={{ opacity: dim(lineFocused(line)), transition: 'opacity 160ms' }}
        >
          <SewingLineBand line={line} twin={twin} projection={projection} />
        </g>
      ))}

      {/* ROTATION CELLS — dashed loops connecting rotation_member stations
          in rotation order. One overlay per unique cell (ws-set). Modular
          / TSS twins get a visible cycle showing operators traverse the
          cell; PBS / synchro / UPS have no rotation assignments so this
          renders nothing. */}
      <RotationCellsOverlay twin={twin} projection={projection} />

      {/* CONNECTOR HIT TARGETS — mounted UNDER the workstations so a station
          crossed by a flow line still wins the click; clicking a connector in
          the open (between stations) still prompts delete as before. The
          visible strokes render in a second, pointer-transparent pass above
          the stations (see below). */}
      <ConnectorLayer
        twin={twin}
        connect={props.connect}
        onRemove={props.onRemoveConnector}
        focusActive={focusActive}
        focusedWsIds={selectedWsIds}
        projection={projection}
        layer="hit"
      />

      {/* WORKSTATIONS — depth-sorted by x+y */}
      {[...twin.workstations]
        .sort((a, b) => a.position.x + a.position.y - (b.position.x + b.position.y))
        .map((w) => {
          const isConnectSource =
            props.connect.on && props.connect.fromWsId === w.id;
          const isWsFocused = selectedWsIds.has(w.id);
          // "Shared" = at least one non-rotation assignment is fractional.
          // Rotation cells are already labelled at the line-band level, so
          // we deliberately exclude them here to keep the canvas readable
          // on modular twins (otherwise every modular station would carry
          // a redundant ⇄ pill).
          const sharedAsgn = (twin.assignments ?? []).find(
            (a) =>
              a.wsId === w.id &&
              a.role !== 'rotation_member' &&
              (a.shareFrac ?? 1) < 1,
          );
          const sharedPct = sharedAsgn
            ? Math.round((sharedAsgn.shareFrac ?? 1) * 100)
            : null;
          // Count operators primarily assigned to this workstation. This is
          // the c (server count) the queue analysis will use, so showing it
          // on every tile keeps the Builder visually honest with the report.
          const wsAssignments = (twin.assignments ?? []).filter(
            (a) => a.wsId === w.id && a.role !== 'floater',
          );
          const operatorCount = wsAssignments.length > 0
            ? wsAssignments.length
            : (w.resources?.workersRequired ?? 0);
          const operatorNames = wsAssignments
            .map((a) => (twin.operators ?? []).find((o) => o.id === a.operatorId)?.name ?? null)
            .filter((n): n is string => !!n);
          return (
            <g
              key={w.id}
              style={{ opacity: dim(isWsFocused), transition: 'opacity 160ms' }}
            >
              <WorkstationSprite
                ws={w}
                selected={selectedWsIds.has(w.id)}
                connectSource={isConnectSource}
                lens={lens}
                placing={props.drop.kind !== 'none'}
                projection={projection}
                sharedPct={sharedPct}
                operatorCount={operatorCount}
                operatorNames={operatorNames}
                opMeta={opMetaFor(w, garmentsById)}
                onClick={(e) => props.onSelect({ kind: 'ws', id: w.id }, { shift: e.shiftKey })}
                onMouseDown={(e) => props.onStartDrag('ws', w.id, e)}
              />
            </g>
          );
        })}

      {/* CONNECTORS (visual pass) — strokes/arrowheads drawn above stations
          so arrows aren't occluded, but pointer-transparent: clicks fall
          through to the station sprites, and connector deletion is handled
          by the hit layer mounted under the stations. Connectors stay fully
          visible when either endpoint is in focus, otherwise they fade with
          the rest of the scene. */}
      <ConnectorLayer
        twin={twin}
        connect={props.connect}
        onRemove={props.onRemoveConnector}
        focusActive={focusActive}
        focusedWsIds={selectedWsIds}
        projection={projection}
        layer="visual"
      />

      {/* HOVER PREVIEW */}
      {hoverCell && drop.kind !== 'none' && (
        <HoverPreview cell={hoverCell} drop={drop} projection={projection} />
      )}

      {/* CLIPBOARD GHOST — translucent footprints showing where ⌘V will
          paste the buffered cluster. Anchored to the hover cell minus the
          clipboard anchor offset so the buffer's top-left lands exactly
          where the cursor is, matching pasteClipboard's anchor math. */}
      {hoverCell && clipboardGhost && (
        <g pointerEvents="none">
          {clipboardGhost.workstations.map((w) => {
            const dx = hoverCell.x - clipboardGhost.anchor.x;
            const dy = hoverCell.y - clipboardGhost.anchor.y;
            const nx = w.position.x + dx;
            const ny = w.position.y + dy;
            const fp = wsFootprint(w);
            const tl = P(nx, ny);
            const tr = P(nx + fp.w, ny);
            const br = P(nx + fp.w, ny + fp.d);
            const bl = P(nx, ny + fp.d);
            return (
              <polygon
                key={w.id}
                points={ptsToStr([tl, tr, br, bl])}
                fill={SW_COLORS.brand}
                fillOpacity={0.1}
                stroke={SW_COLORS.brand}
                strokeOpacity={0.6}
                strokeWidth={1.5 / Math.max(0.001, zoom)}
                strokeDasharray={`${3 / Math.max(0.001, zoom)} ${2 / Math.max(0.001, zoom)}`}
              />
            );
          })}
        </g>
      )}

      {/* SELECT-TOOL MARQUEE — drawn last so it sits on top of everything.
          Coordinates are in SVG user-space, which is the same space the
          <g> renders in after pan/zoom — so the rect tracks the cursor at
          any zoom level without rescaling. */}
      {selectRect && (
        <rect
          x={Math.min(selectRect.sx0, selectRect.sx1)}
          y={Math.min(selectRect.sy0, selectRect.sy1)}
          width={Math.abs(selectRect.sx1 - selectRect.sx0)}
          height={Math.abs(selectRect.sy1 - selectRect.sy0)}
          fill={SW_COLORS.brand + '18'}
          stroke={SW_COLORS.brand}
          strokeWidth={1 / Math.max(0.001, zoom)}
          strokeDasharray={`${4 / Math.max(0.001, zoom)} ${3 / Math.max(0.001, zoom)}`}
          style={{ pointerEvents: 'none' }}
        />
      )}
      </g>
    </svg>
  );
}

// ── DEPARTMENT shape ──────────────────────────────────────────────────────────


// ── SEWING LINE band ──────────────────────────────────────────────────────────

/**
 * Soft outline around the bounding box of a sewing line's member workstations
 * (clipped to the parent department's bounds). Decorative — does not catch
 * pointer events so workstation clicks pass through. Hidden when the line has
 * no member workstations yet (skeleton placeholder).
 */
/**
 * Dashed-loop overlay showing the rotation order across stations in each
 * modular / TSS rotation cell. Renders one loop per unique cell (cells
 * are identified by their canonical wsId-set, so multiple operators
 * rotating the same group collapse to one overlay).
 *
 * Static today — the loop is fixed at sim build time. A future revision
 * can animate the marker between dots using `PmlSimSample.rotationPointers`
 * from LiveSim playback; until then, the static loop already communicates
 * the rotation structure on the Builder canvas.
 */
function RotationCellsOverlay({
  twin,
  projection,
}: {
  twin: ReturnType<typeof selectActiveTwin>;
  projection: Projection;
}) {
  // Bucket rotation_member assignments by canonical ws-id set so two
  // operators rotating through the same cell render one overlay.
  const cellsByKey = new Map<string, { wsIds: string[] }>();
  const byOp = new Map<string, { wsId: string; rotationOrder: number }[]>();
  for (const a of twin.assignments ?? []) {
    if (a.role !== 'rotation_member') continue;
    const arr = byOp.get(a.operatorId) ?? [];
    arr.push({ wsId: a.wsId, rotationOrder: a.rotationOrder ?? arr.length });
    byOp.set(a.operatorId, arr);
  }
  for (const members of byOp.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.rotationOrder - b.rotationOrder);
    const wsIds = members.map((m) => m.wsId);
    const key = wsIds.join('|');
    if (!cellsByKey.has(key)) cellsByKey.set(key, { wsIds });
  }
  if (cellsByKey.size === 0) return null;

  const wsById = new Map(twin.workstations.map((w) => [w.id, w]));
  return (
    <g style={{ pointerEvents: 'none' }}>
      {[...cellsByKey.values()].map((cell, ci) => {
        // Project each workstation's centre to screen coords.
        const points = cell.wsIds
          .map((id) => wsById.get(id))
          .filter((w): w is NonNullable<typeof w> => !!w)
          .map((w) => {
            const fixture = lookupFixture(w.catalogId);
            const fw = w.size?.w ?? fixture?.w ?? 1;
            const fd = w.size?.d ?? fixture?.d ?? 1;
            const cx = w.position.x + fw / 2;
            const cy = w.position.y + fd / 2;
            return projection.project(cx, cy);
          });
        if (points.length < 2) return null;
        // Close the loop.
        const ringPoints = [...points, points[0]];
        const pathStr = ringPoints
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.sx.toFixed(1)} ${p.sy.toFixed(1)}`)
          .join(' ');
        return (
          <g key={ci}>
            <path
              d={pathStr}
              fill="none"
              stroke={SW_COLORS.bobbin}
              strokeOpacity={0.55}
              strokeWidth={1.2}
              strokeDasharray="4 3"
            />
            {points.map((p, i) => (
              <circle
                key={i}
                cx={p.sx}
                cy={p.sy}
                r={3}
                fill={SW_COLORS.paper}
                stroke={SW_COLORS.bobbin}
                strokeWidth={1.2}
              />
            ))}
            {/* Tiny arrow head at the second point so the user reads the
                rotation direction. */}
            {points.length >= 2 && (
              <text
                x={points[1].sx + 6}
                y={points[1].sy - 6}
                fontFamily={SW_FONTS.mono}
                fontSize={8}
                fontWeight={800}
                fill={SW_COLORS.bobbin}
                style={{ letterSpacing: '0.05em' }}
              >
                ↻ ROT
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function SewingLineBand({
  line,
  twin,
  projection,
}: {
  line: SewingLine;
  twin: ReturnType<typeof selectActiveTwin>;
  projection: Projection;
}) {
  const members = twin.workstations.filter((w) => w.lineId === line.id);
  if (members.length === 0) return null;

  // Bounding box of all member workstations, in world cells.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of members) {
    const fixture = lookupFixture(w.catalogId);
    const fw = w.size?.w ?? fixture?.w ?? 1;
    const fd = w.size?.d ?? fixture?.d ?? 1;
    if (w.position.x < minX) minX = w.position.x;
    if (w.position.y < minY) minY = w.position.y;
    if (w.position.x + fw > maxX) maxX = w.position.x + fw;
    if (w.position.y + fd > maxY) maxY = w.position.y + fd;
  }
  // 0.4-cell padding so the band breathes around the equipment.
  const PAD = 0.4;
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  // No clipping: the band is the hull of its own member stations, and with
  // zones gone there is no parent rect that could clip it.
  const P = projection.project;
  const tl = P(minX, minY);
  const tr = P(maxX, minY);
  const br = P(maxX, maxY);
  const bl = P(minX, maxY);
  const accent = DEPT_COLOR_HEX[line.color] ?? SW_COLORS.brand;

  // Label anchored at the top-left corner.
  const labelX = tl.sx + 8;
  const labelY = tl.sy + 4;

  const badge = lineSystemBadge(line, twin);
  const nameWidth = Math.max(70, line.name.length * 5.6 + 18);
  const badgeWidth = Math.max(60, badge.length * 5 + 14);

  // Share-debt rollup for this line — same rule the engine and Reports use,
  // pulled from the shared helper so the three call sites can't drift.
  const { stations: sharedStations, savings: sharedSavings } = shareDebtForLine(twin, line.id);
  const shareChip = sharedStations > 0
    ? `⇄ ${sharedStations} · −${sharedSavings.toFixed(1)} OPR`
    : null;
  const shareChipWidth = shareChip ? Math.max(60, shareChip.length * 5 + 14) : 0;

  return (
    <g style={{ pointerEvents: 'none' }}>
      <polygon
        points={ptsToStr([tl, tr, br, bl])}
        fill={accent}
        fillOpacity={0.08}
        stroke={accent}
        strokeOpacity={0.85}
        strokeWidth={1.6}
        strokeDasharray="5 4"
      />
      <rect
        x={labelX - 4}
        y={labelY - 10}
        width={nameWidth}
        height={14}
        rx={2}
        fill={accent}
        opacity={0.92}
      />
      <text
        x={labelX}
        y={labelY}
        fontFamily={SW_FONTS.mono}
        fontSize={9}
        fontWeight={800}
        fill="#fff"
        style={{ letterSpacing: '0.06em' }}
      >
        {line.name.toUpperCase()}
      </text>
      {/* Second-line system badge — pale fill, accent border so it reads
          as supplemental metadata rather than competing with the name. */}
      <rect
        x={labelX - 4}
        y={labelY + 4}
        width={badgeWidth}
        height={12}
        rx={2}
        fill={SW_COLORS.paper}
        stroke={accent}
        strokeOpacity={0.8}
        strokeWidth={1}
      />
      <text
        x={labelX}
        y={labelY + 12}
        fontFamily={SW_FONTS.mono}
        fontSize={8}
        fontWeight={800}
        fill={accent}
        style={{ letterSpacing: '0.08em' }}
      >
        {badge}
      </text>
      {/* Third-line share-debt chip — only rendered when any station on this
          line has a non-rotation shareFrac < 1. Alarm-tinted to flag the
          engine cycle slowdown (each shared station cycles 1/shareFrac×). */}
      {shareChip && (
        <>
          <rect
            x={labelX - 4}
            y={labelY + 16}
            width={shareChipWidth}
            height={12}
            rx={2}
            fill={SW_COLORS.paper}
            stroke={SW_COLORS.alarm}
            strokeOpacity={0.85}
            strokeWidth={1}
            strokeDasharray="2 1.5"
          />
          <text
            x={labelX}
            y={labelY + 24}
            fontFamily={SW_FONTS.mono}
            fontSize={8}
            fontWeight={800}
            fill={SW_COLORS.alarm}
            style={{ letterSpacing: '0.08em' }}
          >
            {shareChip}
          </text>
        </>
      )}
    </g>
  );
}

// ── WORKSTATION sprite ────────────────────────────────────────────────────────

/**
 * Resolve the OPERATIONS-lens label parts for a station. Returns both the
 * bulletin `code` (e.g. "1081") and a short operation `name` (e.g. "Bartack
 * pkt mouth") so the canvas pill can show what work is being done, not just
 * the opaque code. Falls back gracefully when the garment template can't
 * resolve the opId; the raw `mod-{style}-imp-{code}-{idx}` namespacing is
 * stripped so the user never sees it.
 */
function opMetaFor(
  ws: Workstation,
  garmentsById: Record<string, GarmentTemplate>,
): { code: string; name: string } {
  const { opId, garmentId, freeText } = ws.operation;
  if (!opId) return { code: freeText ?? '—', name: '' };
  const op = garmentId
    ? garmentsById[garmentId]?.operations.find((o) => o.id === opId)
    : undefined;
  if (op) {
    const fullName = (op.name ?? '').trim();
    const shortName =
      fullName.length > 18 ? fullName.slice(0, 17) + '…' : fullName;
    if (op.code) return { code: op.code, name: shortName };
    if (shortName) return { code: shortName, name: '' };
  }
  const stripped = opId
    .replace(/^mod-[a-z0-9]+-/i, '')
    .replace(/^imp-/i, '')
    .replace(/-\d+$/, '');
  return { code: stripped, name: '' };
}

/**
 * Compact operator ID for the chip next to a workstation. Modelama operators
 * are named like `PRO-OP01` — already short. For other twins where `name` may
 * be a free-text string we cap it so the chip stays readable.
 */
function operatorIdLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '—';
  return trimmed.length > 10 ? trimmed.slice(0, 9) + '…' : trimmed;
}

/**
 * Flat (2D top-down) station body. Replaces the iso cuboid `fixture.draw()`
 * in the 2D plan view: a footprint-accurate rounded rect "table" plus, when
 * the fixture maps to a MachineCode, the top-down machine glyph from
 * `assets/workstations.tsx` letterboxed into the base footprint and rotated
 * about the footprint center. rotate(90/270) maps the unrotated base box
 * exactly onto the rotated footprint `wsFootprint` reports for the selection
 * ring and hit-tests. Fixtures without a machine glyph (racks, trolleys,
 * buffers, zones, operators, PML blocks) fall back to an abbreviated label.
 */
function FlatStationBody({ ws, fixture }: { ws: Workstation; fixture: IsoFixture }) {
  const { w: fw, d: fd } = wsFootprint(ws);
  const W = fw * FLAT_CELL;
  const H = fd * FLAT_CELL;
  const mark = stationMark(ws.catalogId);
  // Machines get their family mark and type code; everything else (racks,
  // trolleys, buffers, zones) gets the same box with an abbreviated label,
  // because there is no mechanism to draw.
  //
  // No rotation is applied here: `wsFootprint` already reports the footprint
  // the station occupies AFTER rotation, so the box is the right shape
  // already, and the mark and its code stay axis-aligned. The old sprite
  // rotated its artwork inside the box because a drawn machine has a front;
  // a diagonal stroke does not.
  return (
    <StationGlyph
      {...mark}
      label={
        mark.code || mark.markCode ? undefined : fixture.label.split('\u00b7')[0].trim()
      }
      width={W}
      height={H}
      muted={fixture.cat === 'zone'}
    />
  );
}

function WorkstationSprite({
  ws,
  selected,
  connectSource,
  lens,
  placing,
  projection,
  sharedPct = null,
  operatorCount = 0,
  operatorNames = [],
  opMeta = { code: '—', name: '' },
  onClick,
  onMouseDown,
}: {
  ws: Workstation;
  selected: boolean;
  connectSource: boolean;
  lens: Lens;
  placing: boolean;
  /** Active canvas projection. ISO draws the fixture's cuboid `draw()`;
   *  FLAT swaps the body for the top-down `FlatStationBody`. Rings, heat
   *  overlay, and every lens pill share the same projected corner math. */
  projection: Projection;
  /** When this workstation's primary operator covers more than one
   *  station (`shareFrac < 1`), the integer percentage of an operator
   *  shift that lands here. `null` ⇒ not shared; no badge is drawn.
   *  Rotation cells stay `null` because the line-band already calls
   *  them out — adding a pill on every rotation station would just
   *  clutter the canvas. */
  sharedPct?: number | null;
  /** Operators assigned to this workstation (= c, the server count the
   *  queue analysis uses). Drives the always-on operator chip below
   *  the sprite so the Builder makes the c-count visible without the
   *  user having to switch to the RESOURCES lens. */
  operatorCount?: number;
  /** Operator names — first one is shown as the chip ID; full roster
   *  shows in the hover tooltip. */
  operatorNames?: string[];
  /** OPERATIONS-lens label parts: `code` is the bulletin handle (e.g.
   *  "1081"), `name` is the short operation name (e.g. "Bartack pkt mouth").
   *  Both are resolved upstream so the sprite stays free of garment-template
   *  lookups. */
  opMeta?: { code: string; name: string };
  onClick: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  // Declared before the early return below so hook order stays stable across
  // renders (react-hooks/rules-of-hooks).
  const [hovered, setHovered] = useState(false);
  const fixture = lookupFixture(ws.catalogId);
  if (!fixture) return null;

  const P = projection.project;
  const origin = P(ws.position.x, ws.position.y);
  // `fw / fd / fh` is the effective (rotated) footprint used by the selection
  // ring + heat overlay — those should outline the cells the sprite actually
  // occupies after rotation. The fixture draw fn instead receives the raw
  // catalog dims plus `r: ws.rotation` so it can rotate its geometry on the
  // iso build plane (via isoProjR) rather than spinning in screen space.
  const { w: fw, d: fd } = wsFootprint(ws);
  const base = wsBaseFootprint(ws);

  // KPI heat tint (lens=kpis only) — based on observed.utilizationPct.
  const heat =
    lens === 'kpis' && ws.kpiObserved
      ? heatColor(ws.kpiObserved.utilizationPct)
      : null;

  // Compute footprint bounds for the selection ring.
  const tl = P(ws.position.x, ws.position.y);
  const tr = P(ws.position.x + fw, ws.position.y);
  const br = P(ws.position.x + fw, ws.position.y + fd);
  const bl = P(ws.position.x, ws.position.y + fd);

  // Reveal the per-station detail layer (operation pill + operator chip)
  // only on hover OR when the station is selected. With 270 stations on a
  // dense floor, painting both for every sprite at once buries the iso
  // geometry under text — the lens header pill and operator chip become
  // an inspect-on-demand affordance instead.
  const detailsOpen = hovered || selected;

  return (
    <g
      transform={`translate(${origin.sx}, ${origin.sy})`}
      onClick={(e) => {
        if (placing) return; // let placement click bubble to the stage
        e.stopPropagation();
        onClick(e);
      }}
      onMouseDown={(e) => {
        if (placing) return; // don't start a ws drag while a tool is armed
        onMouseDown(e);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: placing ? 'crosshair' : 'move' }}
    >
      {selected && (
        <polygon
          points={ptsToStr([
            { sx: 0, sy: 0 },
            { sx: tr.sx - tl.sx, sy: tr.sy - tl.sy },
            { sx: br.sx - tl.sx, sy: br.sy - tl.sy },
            { sx: bl.sx - tl.sx, sy: bl.sy - tl.sy },
          ])}
          fill="none"
          stroke={SW_COLORS.brand}
          strokeWidth={2.5}
          strokeDasharray="4 3"
        />
      )}
      {connectSource && (
        <polygon
          points={ptsToStr([
            { sx: 0, sy: 0 },
            { sx: tr.sx - tl.sx, sy: tr.sy - tl.sy },
            { sx: br.sx - tl.sx, sy: br.sy - tl.sy },
            { sx: bl.sx - tl.sx, sy: bl.sy - tl.sy },
          ])}
          fill="none"
          stroke={SW_COLORS.brand}
          strokeWidth={3.2}
          strokeOpacity={0.9}
        />
      )}
      {projection.kind === 'flat' ? (
        <FlatStationBody ws={ws} fixture={fixture} />
      ) : (
        (fixture.draw({ w: base.w, d: base.d, h: base.h, r: ws.rotation }) as ReactNode)
      )}

      {/* KPI heat overlay */}
      {heat && (
        <polygon
          points={ptsToStr([
            { sx: 0, sy: 0 },
            { sx: tr.sx - tl.sx, sy: tr.sy - tl.sy },
            { sx: br.sx - tl.sx, sy: br.sy - tl.sy },
            { sx: bl.sx - tl.sx, sy: bl.sy - tl.sy },
          ])}
          fill={heat}
          fillOpacity={0.45}
        />
      )}

      {/* OPERATIONS lens badge — two-line pill so the user sees BOTH the
          bulletin code (top, mono) and the operation name (bottom, smaller).
          Gated on `detailsOpen` so the dense 270-station floor stays
          readable by default; hover or click a sprite to reveal its
          operation. Full opId still appears on hover via the <title>. */}
      {lens === 'operations' && detailsOpen && (() => {
        const code = opMeta.code || '—';
        const name = opMeta.name || '';
        const widest = Math.max(code.length, name.length);
        const pillW = Math.max(34, Math.min(120, widest * 5.6 + 12));
        const pillH = name ? 22 : 14;
        const pillY = name ? -15 : -9;
        return (
          <g transform="translate(0, -28)">
            <title>{ws.operation.opId ?? ws.operation.freeText ?? ''}</title>
            <rect x={-pillW / 2} y={pillY} width={pillW} height={pillH} rx={3} fill={SW_COLORS.ink} fillOpacity={0.88} />
            <text x={0} y={name ? -5 : 1} textAnchor="middle" fontFamily={SW_FONTS.mono} fontSize={9} fontWeight={700} fill="#fff" style={{ letterSpacing: '0.04em' }}>
              {code}
            </text>
            {name && (
              <text x={0} y={4} textAnchor="middle" fontFamily={SW_FONTS.body} fontSize={7} fontWeight={500} fill="#fff" fillOpacity={0.88} style={{ letterSpacing: '0.02em' }}>
                {name}
              </text>
            )}
          </g>
        );
      })()}

      {/* RESOURCES lens badge — worker count */}
      {lens === 'resources' && ws.resources.workersRequired > 0 && (
        <g transform="translate(0, -28)">
          <rect x={-22} y={-9} width={44} height={14} rx={3} fill={SW_COLORS.bobbin} fillOpacity={0.92} />
          <text x={0} y={1} textAnchor="middle" fontFamily={SW_FONTS.mono} fontSize={9} fontWeight={700} fill="#fff" style={{ letterSpacing: '0.04em' }}>
            ☻ × {ws.resources.workersRequired}
          </text>
        </g>
      )}

      {/* KPIS lens badge — utilisation pct or "no run" */}
      {lens === 'kpis' && (
        <g transform="translate(0, -28)">
          <rect x={-26} y={-9} width={52} height={14} rx={3} fill={ws.kpiObserved ? SW_COLORS.brandDeep : SW_COLORS.muted} fillOpacity={0.92} />
          <text x={0} y={1} textAnchor="middle" fontFamily={SW_FONTS.mono} fontSize={9} fontWeight={700} fill="#fff" style={{ letterSpacing: '0.04em' }}>
            {ws.kpiObserved ? `${Math.round(ws.kpiObserved.utilizationPct)}% util` : 'no run'}
          </text>
        </g>
      )}

      {/* OPERATOR chip — reveals on hover / selection (any lens). Shows the
          primary operator's ID (e.g. "PRO-OP01") so the canvas distinguishes
          the PERSON working at this station from the OPERATION being
          performed on it (the pill above). A small ☻ head-icon sits on the
          left of the chip so it reads as "a person", brand-orange ring so
          it pops against the iso scene. When >1 operator is assigned, a
          "+N" badge appears to the right of the primary ID. Full roster
          surfaces on hover via the <title> tooltip. */}
      {operatorCount > 0 && detailsOpen && (() => {
        const primary = operatorNames[0] ?? '';
        const idLabel = primary ? operatorIdLabel(primary) : `OP×${operatorCount}`;
        const extra = Math.max(0, operatorCount - 1);
        const labelLen = idLabel.length + (extra > 0 ? 3 : 0);
        const chipW = Math.max(48, Math.min(110, labelLen * 6 + 22));
        return (
          <g transform="translate(0, 22)" style={{ pointerEvents: 'all' }}>
            <title>
              {operatorNames.length > 0
                ? `Operators: ${operatorNames.join(', ')}`
                : `${operatorCount} operator${operatorCount === 1 ? '' : 's'} required`}
            </title>
            <rect
              x={-chipW / 2}
              y={-8}
              width={chipW}
              height={14}
              rx={7}
              fill={SW_COLORS.ink}
              fillOpacity={0.82}
              stroke={SW_COLORS.brand}
              strokeOpacity={0.7}
              strokeWidth={0.8}
            />
            {/* head-icon: small filled circle in brand-orange so the chip
                reads as "operator" at a glance. */}
            <circle
              cx={-chipW / 2 + 7}
              cy={-1}
              r={3.2}
              fill={SW_COLORS.brand}
              fillOpacity={0.95}
            />
            <text
              x={-chipW / 2 + 13}
              y={3}
              textAnchor="start"
              fontFamily={SW_FONTS.mono}
              fontSize={8.5}
              fontWeight={700}
              fill="#fff"
              style={{ letterSpacing: '0.04em' }}
            >
              {idLabel}
            </text>
            {extra > 0 && (
              <text
                x={chipW / 2 - 4}
                y={3}
                textAnchor="end"
                fontFamily={SW_FONTS.mono}
                fontSize={8}
                fontWeight={800}
                fill={SW_COLORS.brand}
                style={{ letterSpacing: '0.04em' }}
              >
                {`+${extra}`}
              </text>
            )}
          </g>
        );
      })()}

      {/* SHARED-WORKER pill — lens-independent, sits above the per-lens
          badge so the user can spot shared stations from across the
          canvas without entering Resources lens or opening the
          Inspector. Brand-orange so it pops against the iso scene. */}
      {sharedPct !== null && (
        <g transform="translate(0, -44)" style={{ pointerEvents: 'none' }}>
          <rect
            x={-22}
            y={-9}
            width={44}
            height={14}
            rx={3}
            fill={SW_COLORS.brand}
            fillOpacity={0.95}
          />
          <text
            x={0}
            y={1}
            textAnchor="middle"
            fontFamily={SW_FONTS.mono}
            fontSize={9}
            fontWeight={800}
            fill="#fff"
            style={{ letterSpacing: '0.05em' }}
          >
            {`⇄ ${sharedPct}%`}
          </text>
        </g>
      )}
    </g>
  );
}

function heatColor(util: number): string {
  // 0–60% green, 60–85% amber, 85+% red
  if (util < 60) return SW_COLORS.ok;
  if (util < 85) return SW_COLORS.warn;
  return SW_COLORS.alarm;
}


/**
 * Save-As-Scenario dialog. Pure form: parent owns the field state so the
 * Builder can pre-fill the name with "<active> (copy)" and so the confirm
 * handler can decide whether to fork from canonical or branch a scenario.
 *
 * Keyboard: Enter on the name field confirms, Esc cancels.
 */
function SaveAsScenarioModal({
  sourceLabel,
  isForkOfScenario,
  name,
  notes,
  activate,
  onNameChange,
  onNotesChange,
  onActivateChange,
  onCancel,
  onConfirm,
}: {
  sourceLabel: string;
  isForkOfScenario: boolean;
  name: string;
  notes: string;
  activate: boolean;
  onNameChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onActivateChange: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const trimmed = name.trim();
  const canConfirm = trimmed.length > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: SW_COLORS.overlay,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          width: 'min(460px, 92%)',
          background: SW_COLORS.paper,
          border: `1px solid ${SW_COLORS.line}`,
          borderRadius: 8,
          boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: SW_FONTS.display,
                fontSize: 14,
                fontWeight: 900,
                letterSpacing: '-0.01em',
                color: SW_COLORS.ink,
              }}
            >
              SAVE AS NEW SCENARIO
            </div>
            <div
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                color: SW_COLORS.muted,
                marginTop: 3,
                letterSpacing: '0.04em',
              }}
            >
              FORK FROM · {sourceLabel}
            </div>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: 'transparent',
              border: 'none',
              color: SW_COLORS.muted,
              fontSize: 18,
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
            title="Cancel (Esc)"
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={fieldLabel}>SCENARIO NAME</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) onConfirm();
              }}
              placeholder="e.g. Sewing line — 2 extra operators"
              style={inputBase}
            />
          </div>
          <div>
            <label style={fieldLabel}>NOTES · OPTIONAL</label>
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="What does this fork explore? (visible in the Scenarios list)"
              rows={3}
              style={{ ...inputBase, resize: 'vertical', minHeight: 64, fontFamily: SW_FONTS.body }}
            />
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              color: SW_COLORS.muted,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => onActivateChange(e.target.checked)}
            />
            Switch to the new scenario after saving
          </label>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              color: SW_COLORS.muted,
              lineHeight: 1.5,
              padding: '8px 10px',
              background: SW_COLORS.paperDeep,
              border: `1px dashed ${SW_COLORS.line}`,
              borderRadius: 6,
            }}
          >
            {isForkOfScenario
              ? 'This creates a new scenario branched from the current scenario. The source scenario keeps its own state.'
              : 'This creates a new scenario forked from the canonical factory. The canonical stays untouched.'}
          </div>
        </div>
        <div
          style={{
            padding: '12px 18px',
            borderTop: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            background: SW_COLORS.paperDeep,
          }}
        >
          <button onClick={onCancel} style={btnSec()}>
            CANCEL
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            style={{
              ...btnPrim(),
              opacity: canConfirm ? 1 : 0.5,
              cursor: canConfirm ? 'pointer' : 'not-allowed',
            }}
          >
            ✦ SAVE SCENARIO
          </button>
        </div>
      </div>
    </div>
  );
}


// ── CONNECTOR LAYER ───────────────────────────────────────────────────────────

/**
 * Draws every connector in the active twin as a directed arrow from source
 * footprint center to target footprint center. One <defs> arrowhead marker
 * per kind so flow / operator / material arrows can be tinted independently.
 */
function ConnectorLayer({
  twin,
  connect,
  onRemove,
  focusActive,
  focusedWsIds,
  projection,
  layer,
}: {
  twin: ReturnType<typeof selectActiveTwin>;
  connect: { on: boolean; kind: ConnectorKind; fromWsId: string | null };
  onRemove: (id: string) => void;
  /** When true, dim every connector whose endpoints aren't in `focusedWsIds`.
   *  Driven by the canvas-wide focus-dim feature. */
  focusActive: boolean;
  focusedWsIds: Set<string>;
  projection: Projection;
  /** Which half of the layer to paint. The component mounts twice so the
   *  arrows can be SEEN above stations but CLICKED below them:
   *  - 'hit'    — invisible 14px click targets, mounted under the
   *               workstations so a station crossing a line still wins the
   *               click (selecting a station must never surface the
   *               delete-connector confirm).
   *  - 'visual' — the visible strokes, arrowheads and carrier badges,
   *               mounted above the workstations with pointer events off. */
  layer: 'hit' | 'visual';
}) {
  const confirm = useConfirm();
  const wsById = new Map(twin.workstations.map((w) => [w.id, w] as const));
  const dim = connect.on ? 0.35 : 1; // de-emphasise existing arrows while connecting

  if (layer === 'hit') {
    return (
      <g>
        {(twin.connectors ?? []).map((c) => {
          const a = wsById.get(c.fromWsId);
          const b = wsById.get(c.toWsId);
          if (!a || !b) return null;
          const pa = workstationScreenCenter(a, projection);
          const pb = workstationScreenCenter(b, projection);
          return (
            <line
              key={c.id}
              x1={pa.sx}
              y1={pa.sy}
              x2={pb.sx}
              y2={pb.sy}
              stroke="transparent"
              strokeWidth={14}
              onClick={async (e) => {
                e.stopPropagation();
                if (await confirm({ title: 'Delete connector', message: `Delete ${CONNECTOR_LABEL[c.kind]} connector?`, confirmLabel: 'Delete', variant: 'danger' })) {
                  onRemove(c.id);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <title>
                {`${CONNECTOR_LABEL[c.kind]}${c.flow?.carrier ? ` · ${c.flow.carrier}` : ''} · ${a.name} → ${b.name} (click to delete)`}
              </title>
            </line>
          );
        })}
      </g>
    );
  }

  return (
    <g style={{ pointerEvents: 'none' }}>
      <defs>
        {(['flow', 'operator', 'material'] as ConnectorKind[]).map((k) => (
          <marker
            key={k}
            id={`sw-arrow-${k}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={CONNECTOR_HEX[k]} />
          </marker>
        ))}
      </defs>

      {(twin.connectors ?? []).map((c) => {
        const a = wsById.get(c.fromWsId);
        const b = wsById.get(c.toWsId);
        if (!a || !b) return null;
        const pa = workstationScreenCenter(a, projection);
        const pb = workstationScreenCenter(b, projection);
        const style = flowStyleFor(c);
        const color = style.stroke;
        const mx = (pa.sx + pb.sx) / 2;
        const my = (pa.sy + pb.sy) / 2 - 6;
        const focusKept = focusedWsIds.has(c.fromWsId) || focusedWsIds.has(c.toWsId);
        const focusOpacity = focusActive && !focusKept ? FOCUS_DIM : 1;
        // Carrier mini-badge near the midpoint when the connector carries
        // a system-specific annotation (B / P / H / T). Lets the user read
        // the line type at a glance without opening the inspector.
        const carrierLabel = style.label;
        return (
          <g key={c.id} style={{ opacity: focusOpacity, transition: 'opacity 160ms' }}>
            <line
              x1={pa.sx}
              y1={pa.sy}
              x2={pb.sx}
              y2={pb.sy}
              stroke={color}
              strokeOpacity={dim}
              strokeWidth={style.width}
              strokeDasharray={style.dash ?? undefined}
              markerEnd={`url(#sw-arrow-${c.kind})`}
            />
            {c.label ? (
              <text
                x={mx}
                y={my}
                textAnchor="middle"
                fontFamily={SW_FONTS.mono}
                fontSize={9}
                fontWeight={700}
                fill={color}
                opacity={dim}
                style={{ pointerEvents: 'none', letterSpacing: '0.04em' }}
              >
                {c.label}
              </text>
            ) : carrierLabel ? (
              <g style={{ pointerEvents: 'none' }} opacity={dim * 0.9}>
                <circle cx={mx} cy={my} r={6} fill={SW_COLORS.paper} stroke={color} strokeWidth={1} />
                <text
                  x={mx}
                  y={my + 3}
                  textAnchor="middle"
                  fontFamily={SW_FONTS.mono}
                  fontSize={8}
                  fontWeight={800}
                  fill={color}
                >
                  {carrierLabel}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {/* In-progress preview: source → cursor isn't tracked here (it would
       *  require pointer state lifted to BuilderPage). The source ring on the
       *  selected workstation is enough of a visual cue for now. */}
    </g>
  );
}

// ── HOVER PREVIEW ─────────────────────────────────────────────────────────────

function HoverPreview({ cell, drop, projection }: { cell: { x: number; y: number }; drop: DropTool; projection: Projection }) {
  if (drop.kind === 'ws') {
    const fixture = lookupFixture(drop.catalogId);
    if (!fixture) return null;
    const P = projection.project;
    const tl = P(cell.x, cell.y);
    const tr = P(cell.x + fixture.w, cell.y);
    const br = P(cell.x + fixture.w, cell.y + fixture.d);
    const bl = P(cell.x, cell.y + fixture.d);
    return (
      <polygon
        points={ptsToStr([tl, tr, br, bl])}
        fill={SW_COLORS.brand}
        fillOpacity={0.18}
        stroke={SW_COLORS.brand}
        strokeWidth={2}
        strokeDasharray="3 2"
        pointerEvents="none"
      />
    );
  }
  return null;
}


// ============================================================================
// BUILDER PROCESS VIEW — workstation-level PML block diagram
// ============================================================================
//
// Renders every workstation as a PML block (Source / Queue / Service /
// Delay / SelectOutput / Sink / Conveyor / ResourcePool / …) with explicit
// input + output port dots. Connectors in the twin are drawn as wires
// from a source block's output port to a target block's input port.
//
// Layout: each Department is a horizontal swim lane. Within a lane,
// blocks are sorted by their iso-canvas x position so the PML diagram
// reads left-to-right in the same order the floor reads left-to-right.
// ResourcePool blocks (operators / mechanics) are pulled out into a
// dedicated bottom lane — they have no flow ports; they are *referenced*
// by Service blocks, not wired into the flow.

interface BuilderProcessViewProps {
  twin: ReturnType<typeof selectActiveTwin>;
  selected: { kind: 'ws'; id: string } | null;
  /** Full selection (primary anchor + marquee/shift extras). Every id in here
   *  gets the selection ring and moves together on a drag. `selected` stays
   *  the single anchor the Inspector binds to. */
  selectedWsIds: Set<string>;
  onSelect: (s: { kind: 'ws'; id: string } | null, additive?: boolean) => void;
  /** Live marquee rectangle in this canvas's world px, or null. */
  selectRect: { sx0: number; sy0: number; sx1: number; sy1: number } | null;
  /** True while the SELECT tool is armed — the background drag is then a
   *  marquee rather than a pan, and its mouseup owns the selection, so the
   *  background's click handler must not second-guess it. */
  selectToolArmed: boolean;
  /** Active drop tool. `kind === 'ws'` makes a click in any dept lane
   *  drop a new workstation in that dept. */
  drop: DropTool;
  setDrop: React.Dispatch<React.SetStateAction<DropTool>>;
  /** Twin-store mutators surfaced for authoring from this view. */
  addWorkstation: (input: {
    lineId?: string;
    catalogId: string;
    position: { x: number; y: number };
    presetLabel?: string;
    blockParams?: Record<string, unknown>;
    processPos?: { x: number; y: number };
  }) => string;
  /** Connector store mutators — drag-to-connect creates, select+Del removes. */
  addConnector: (input: {
    kind: ConnectorKind;
    fromWsId: string;
    toWsId: string;
    fromPort?: string;
    toPort?: string;
  }) => string | null;
  removeConnector: (id: string) => void;
  /** Bulk freeform-position writer (block.processPos) — one undo step.
   *  Used for drag-commit and the "Auto-arrange" action. */
  setProcessPositions: (entries: { wsId: string; pos: { x: number; y: number } }[]) => void;
  /** Active CONNECT-tool state. When `on` is true, port dots become
   *  clickable and the cursor switches to crosshair. */
  connect: { on: boolean; kind: ConnectorKind; fromWsId: string | null; fromPort: string | null };
  /** Called when the user clicks an OUTPUT port dot in CONNECT mode. */
  onPickFromPort: (wsId: string, portId: string) => void;
  /** Called when the user clicks an INPUT port dot in CONNECT mode and
   *  the source is already chosen. Implementations should call
   *  addConnector and then advance the connect chain. */
  onPickToPort: (wsId: string, portId: string) => void;
  /** This view's own camera. Separate from the floor's pan/zoom because the
   *  two are unrelated coordinate spaces — see `processCam` on the page. */
  cam: ProcessCam;
  /** Live stage size in CSS px; drives the centred viewBox. */
  stageSize: { w: number; h: number };
  /** Ask the page to frame all content (same path as Cmd-0 / ⛶). */
  onFitRequest: () => void;
}

/** Pan (screen px, offset from stage centre) + zoom for the process canvas. */
interface ProcessCam {
  x: number;
  y: number;
  z: number;
}

/** Layout result for a single workstation block. */
interface ProcessNode {
  ws: Workstation;
  block: PmlBlock;
  /** Top-left in SVG coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Sewing line this block belongs to (already resolved from ws.lineId). */
  line: SewingLine | undefined;
}

/** Returns the SVG-space center of a port on a node. Inputs are spread
 *  along the left edge, outputs along the right edge. */
function portPosition(
  node: ProcessNode,
  port: PmlPort,
  side: 'in' | 'out',
): { x: number; y: number } {
  const ports = side === 'in' ? node.block.inputs : node.block.outputs;
  const idx = Math.max(0, ports.findIndex((p) => p.id === port.id));
  const slot = (idx + 1) / (ports.length + 1);
  return {
    x: side === 'in' ? node.x : node.x + node.w,
    y: node.y + node.h * slot,
  };
}

function BuilderProcessView({
  twin,
  selected,
  selectedWsIds,
  onSelect,
  selectRect,
  selectToolArmed,
  drop,
  setDrop,
  addWorkstation,
  addConnector,
  removeConnector,
  setProcessPositions,
  connect,
  onPickFromPort,
  onPickToPort,
  cam,
  stageSize,
  onFitRequest,
}: BuilderProcessViewProps) {
  // Minimal AnyLogic-style nodes: a small category-coloured symbol square with
  // the station name beneath it. BLOCK_W/H is the symbol footprint that the
  // ports attach to; the wider column/row spacing lives in the seed layout.
  const BLOCK_W = PROCESS_BLOCK_W;
  const BLOCK_H = PROCESS_BLOCK_H;

  // ── Interaction state ─────────────────────────────────────────────────
  // Declared up-front because the layout/extent pass below reads the live
  // drag position. `dragWsIds` + `dragDelta` are the ghost offset during a
  // drag (only committed to the store on drop); `pendingWire` is the
  // rubber-band while drawing a connector; `hoverPort` is the input port
  // currently under the wire end; `selectedConnId` is the wire selected for
  // deletion.
  //
  // A SET and a shared DELTA rather than one id and one absolute position:
  // dragging a marquee selection has to move every member rigidly, and a
  // delta does that without tracking a separate origin per block.
  const [dragWsIds, setDragWsIds] = useState<Set<string>>(() => new Set());
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [pendingWire, setPendingWire] = useState<
    { fromWsId: string; fromPort: string; x: number; y: number } | null
  >(null);
  const [hoverPort, setHoverPort] = useState<{ wsId: string; portId: string } | null>(null);
  const hoverPortRef = useRef<{ wsId: string; portId: string } | null>(null);
  const setHover = (v: { wsId: string; portId: string } | null) => {
    hoverPortRef.current = v;
    setHoverPort(v);
  };
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  /** Snapped top-left of the block that would land if the user clicked now.
   *  Process-world px — deliberately NOT the page's `hoverCell`, which is in
   *  floor cells; conflating the two unrelated spaces is exactly what made
   *  Cmd-V paste at a bogus cell here before. */
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  // Two-stage arm for AUTO-ARRANGE (see the button).
  const [arrangeArmed, setArrangeArmed] = useState(false);
  const arrangeTimer = useRef<number | null>(null);
  useEffect(() => () => { if (arrangeTimer.current) window.clearTimeout(arrangeTimer.current); }, []);

  // Authored `processPos` when the block has one, otherwise the flow-ordered
  // serpentine seed. One resolver, shared with fit-to-content on the page.
  const resolved = useMemo(() => resolveProcessPositions(twin), [twin]);

  const positions = new Map<string, ProcessNode>();
  twin.workstations.forEach((ws) => {
    const block = getBlockSpec(ws);
    const p = resolved.get(ws.id) ?? { x: PROCESS_PAD_X, y: PROCESS_PAD_TOP };
    positions.set(ws.id, {
      ws,
      block,
      x: p.x,
      y: p.y,
      w: BLOCK_W,
      h: BLOCK_H,
      line: (twin.lines ?? []).find((l) => l.id === ws.lineId),
    });
  });

  // Live position of a node, honouring an in-progress drag (ghost preview).
  const posOf = (wsId: string): { x: number; y: number } | null => {
    const n = positions.get(wsId);
    if (!n) return null;
    if (dragDelta && dragWsIds.has(wsId)) {
      return { x: n.x + dragDelta.dx, y: n.y + dragDelta.dy };
    }
    return { x: n.x, y: n.y };
  };

  // Pre-resolve connector wire endpoints. Honour the connector's named
  // `fromPort` / `toPort` when set; otherwise default to the source's
  // first output and the target's first input.
  const wires = twin.connectors
    .map((c) => {
      const from = positions.get(c.fromWsId);
      const to = positions.get(c.toWsId);
      if (!from || !to) return null;
      const outPort =
        (c.fromPort ? from.block.outputs.find((p) => p.id === c.fromPort) : null) ??
        from.block.outputs[0];
      const inPort =
        (c.toPort ? to.block.inputs.find((p) => p.id === c.toPort) : null) ??
        to.block.inputs[0];
      if (!outPort || !inPort) return null;
      const fl = posOf(from.ws.id)!;
      const tl = posOf(to.ws.id)!;
      const a = portPosition({ ...from, x: fl.x, y: fl.y }, outPort, 'out');
      const b = portPosition({ ...to, x: tl.x, y: tl.y }, inPort, 'in');
      return { c, a, b, outPortLabel: outPort.label, inPortLabel: inPort.label };
    })
    .filter(Boolean) as {
      c: Connector;
      a: { x: number; y: number };
      b: { x: number; y: number };
      outPortLabel: string;
      inPortLabel: string;
    }[];

  // The camera lives at page level, and every gesture that drives it —
  // wheel, pinch, swipe, space-drag, +/-, Cmd-0 — is installed once on the
  // stage by `useCanvasCamera`. This view just renders through it.

  const svgRef = useRef<SVGGElement | null>(null);
  /** Screen point → process-world px. The ref is on the INNER <g>, which
   *  carries the pan/zoom transform, so this needs no extra maths and block
   *  drag, the wire rubber-band and cursor drop are all correct by
   *  construction. */
  const screenToSvg = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const ctm = el.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    const pt = new DOMPoint(clientX, clientY);
    return pt.matrixTransform(inv);
  };

  // ── Free block drag ────────────────────────────────────────────────────
  // Drag a block anywhere on the canvas; the ghost previews live and commits
  // once on drop (snapped to an 8px grid) as `block.processPos`. No
  // department reassignment — physical/org membership is edited in the 2D /
  // ISO views; this canvas is purely the logical-graph layout.
  // Frame the diagram on first mount. Without this the camera starts at
  // {0,0,1}, which under a centred viewBox puts the content's top-left at the
  // stage centre — i.e. most of the diagram off-screen to the bottom-right.
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current) return;
    if (twin.workstations.length === 0) return;
    if (stageSize.w <= 0 || stageSize.h <= 0) return;
    didFit.current = true;
    onFitRequest();
  }, [twin.workstations.length, stageSize.w, stageSize.h, onFitRequest]);

  // No non-negative clamp: the canvas extends in every direction, and
  // clamping here was the second half of why you could not work to the left
  // of where the seed happened to put things.
  //
  // `snapProcess` is a 10px lattice, the tier-4 subdivision of the grid drawn
  // below, so a block settles on a line the user can see. `dropAtCursor` and
  // the drop ghost both call it on the same expression, which is what makes
  // the ghost's promise and the drop's behaviour identical by construction.

  /** Which line a newly-dropped block joins, now that there are no lanes to
   *  drop into: inherit from the selected block ("I am extending this line"),
   *  else the only line if there is exactly one, else none — an unlined block
   *  is a normal thing to author on a free floor. */
  const inferLineIdForNewBlock = (): string | undefined => {
    if (selected?.kind === 'ws') {
      const cur = twin.workstations.find((w) => w.id === selected.id);
      if (cur?.lineId) return cur.lineId;
    }
    const lines = twin.lines ?? [];
    return lines.length === 1 ? lines[0].id : undefined;
  };

  /** Where a block dropped at cursor-point `p` lands: centred on the cursor,
   *  snapped to the grid lattice. The ghost and the drop both call this, so
   *  the preview cannot promise a position the drop does not honour. */
  const dropPosAt = (p: { x: number; y: number }) => ({
    x: snapProcess(p.x - BLOCK_W / 2),
    y: snapProcess(p.y - BLOCK_H / 2),
  });

  /** Place an armed palette block where the user clicked. */
  const dropAtCursor = (clientX: number, clientY: number): boolean => {
    if (drop.kind !== 'ws') return false;
    const p = screenToSvg(clientX, clientY);
    const preset = drop.presetId ? findApparelPreset(drop.presetId) : null;
    const lineId = inferLineIdForNewBlock();
    // The floor cell is still required — a block is a workstation and shows
    // up in the 2D/ISO views too. Park it to the right of its line's existing
    // members so stations do not pile up on the origin over there.
    const members = twin.workstations.filter((w) => lineId && w.lineId === lineId);
    const position = members.length > 0
      ? { x: Math.max(...members.map((w) => w.position.x)) + 1, y: Math.min(...members.map((w) => w.position.y)) }
      : { x: 0, y: 0 };
    const id = addWorkstation({
      ...(lineId ? { lineId } : {}),
      catalogId: drop.catalogId,
      position,
      // Written at creation, not as a follow-up setProcessPositions call —
      // otherwise a single drop costs two undo steps.
      processPos: dropPosAt(p),
      presetLabel: preset?.label,
      blockParams: preset?.defaultParams,
    });
    onSelect({ kind: 'ws', id });
    setDrop({ kind: 'none' });
    return true;
  };
  const beginBlockDrag = (node: ProcessNode, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedConnId(null);
    // The grabbed block moves the whole selection when it is part of one —
    // matching the floor's `startEntityDrag`. SHIFT peels a single block out
    // of a group, which is the same escape hatch the floor offers.
    const group =
      !e.shiftKey && selectedWsIds.has(node.ws.id) && selectedWsIds.size > 1
        ? new Set(selectedWsIds)
        : new Set([node.ws.id]);
    const start = screenToSvg(e.clientX, e.clientY);
    setDragWsIds(group);
    setDragDelta({ dx: 0, dy: 0 });
    let didMove = false;
    const move = (ev: MouseEvent) => {
      const w = screenToSvg(ev.clientX, ev.clientY);
      didMove = true;
      setDragDelta({ dx: w.x - start.x, dy: w.y - start.y });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragWsIds(new Set());
      setDragDelta(null);
      if (!didMove) {
        onSelect({ kind: 'ws', id: node.ws.id }, ev.shiftKey);
        return;
      }
      const w = screenToSvg(ev.clientX, ev.clientY);
      const dx = w.x - start.x;
      const dy = w.y - start.y;
      // One bulk write, so a group move is a single undo step.
      const entries: { wsId: string; pos: { x: number; y: number } }[] = [];
      for (const wsId of group) {
        const base = positions.get(wsId);
        if (!base) continue;
        entries.push({
          wsId,
          pos: { x: snapProcess(base.x + dx), y: snapProcess(base.y + dy) },
        });
      }
      if (entries.length > 0) setProcessPositions(entries);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // ── Drag-to-connect ─────────────────────────────────────────────────────
  // Press on an OUTPUT port, drag a rubber-band wire, release over a
  // compatible INPUT port to create a connector with explicit ports. The
  // target is tracked via the input ports' hover (enter/leave) so the drop
  // doesn't depend on the mouseup landing exactly on the dot.
  const beginWireDrag = (wsId: string, portId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedConnId(null);
    const p = screenToSvg(e.clientX, e.clientY);
    setPendingWire({ fromWsId: wsId, fromPort: portId, x: p.x, y: p.y });
    setHover(null);
    const move = (ev: MouseEvent) => {
      const w = screenToSvg(ev.clientX, ev.clientY);
      setPendingWire((pw) => (pw ? { ...pw, x: w.x, y: w.y } : pw));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const target = hoverPortRef.current;
      if (target && target.wsId !== wsId) {
        addConnector({
          kind: connect.kind ?? 'flow',
          fromWsId: wsId,
          toWsId: target.wsId,
          fromPort: portId,
          toPort: target.portId,
        });
      }
      setPendingWire(null);
      setHover(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Kind of the source output port mid-drag — used to highlight only
  // compatible input ports (agent→agent, resource→resource).
  const pendingFromKind: 'agent' | 'resource' | null = pendingWire
    ? positions.get(pendingWire.fromWsId)?.block.outputs.find((p) => p.id === pendingWire.fromPort)?.kind ?? null
    : null;

  // Delete the selected connector on Del/Backspace (ignoring text fields).
  useEffect(() => {
    if (!selectedConnId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      removeConnector(selectedConnId);
      setSelectedConnId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedConnId, removeConnector]);

  return (
    <>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        // No `overflow: auto`. The canvas is not a sheet inside a scroll box
        // any more — it is an unbounded camera over an inner <g>, and a scroll
        // container would clamp panning to the positive quadrant again. The
        // grid is drawn in SVG (see `<CanvasGrid>`) rather than as a CSS
        // background, so it tracks the camera instead of the element.
        overflow: 'hidden',
        // NO background of its own. The stage paints the void plus an overhead
        // vignette, and `CanvasSVG` leaves its own base transparent so that
        // ground reads through. Painting a flat `paperDeep` here occluded it,
        // which is why 2D was near-black with a glow and PROCESS was flat
        // slate — the single largest reason the two canvases did not look like
        // the same sheet of paper.
        // Only the states this view knows about. Everything else — the
        // grab hand, space-pan, mid-pan grabbing — is the stage's cursor
        // showing through, so it reads the same in every view.
        cursor: connect.on ? 'crosshair' : dragWsIds.size > 0 ? 'grabbing' : undefined,
      }}
      // Ghost tracking is bound HERE, on the container, not on the background
      // <rect>: the rect is occluded by every block and every wire, so a
      // rect-bound handler would freeze the ghost the moment the cursor
      // crossed a node. This div is inset:0 and receives everything by
      // bubbling. The page's own mousemove early-returns in PROCESS and the
      // camera hook binds none outside an active pan, so nothing contends.
      onMouseMove={(e) => {
        if (drop.kind !== 'ws') return;
        setHoverPos(dropPosAt(screenToSvg(e.clientX, e.clientY)));
      }}
      onMouseLeave={() => setHoverPos(null)}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`${-stageSize.w / 2} ${-stageSize.h / 2} ${stageSize.w} ${stageSize.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        <defs>
          <marker
            id="builder-process-arrow"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M0 0 L10 5 L0 10 z" fill={SW_COLORS.brand} />
          </marker>
        </defs>

        {/* Background plate. Carries `data-canvas-bg` so the page's single
            background-drag handler treats it exactly like the floor canvas's,
            and owns the click that clears selection or places an armed block. */}
        <rect
          data-canvas-bg="true"
          x={-stageSize.w / 2}
          y={-stageSize.h / 2}
          width={stageSize.w}
          height={stageSize.h}
          fill="transparent"
          onClick={(e) => {
            if (dropAtCursor(e.clientX, e.clientY)) return;
            // With the SELECT tool armed the marquee's own mouseup already
            // resolved the selection; clearing here would undo it on every
            // successful drag-select. Same guard the floor's onCanvasClick has.
            if (selectToolArmed) return;
            onSelect(null);
            setSelectedConnId(null);
          }}
        />

        <g ref={svgRef} transform={`translate(${cam.x} ${cam.y}) scale(${cam.z})`}>
          {/* The same grid the floor draws. FLAT_PROJECTION is what makes it
              the same: it multiplies by FLAT_CELL, and this canvas's world
              units are plain px, so the lines land 40 world px apart —
              identical pitch to 2D at identical zoom. */}
          <CanvasGrid projection={FLAT_PROJECTION} cam={cam} stageSize={stageSize} />

        {/* Connector wires (drawn before blocks so blocks sit on top).
            Wires stay full opacity when either endpoint is part of the focus,
            otherwise they fade with the rest of the diagram. */}
        {(() => {
          const focusActive = selected !== null;
          const selectedWsId = selected?.kind === 'ws' ? selected.id : null;
          const wireFocused = (c: Connector) => {
            if (selectedWsId)
              return c.fromWsId === selectedWsId || c.toWsId === selectedWsId;
            return false;
          };
          return wires.map(({ c, a, b }) => {
            const dx = b.x - a.x;
            const cx1 = a.x + Math.max(28, dx / 2);
            const cx2 = b.x - Math.max(28, dx / 2);
            const path = `M ${a.x} ${a.y} C ${cx1} ${a.y}, ${cx2} ${b.y}, ${b.x} ${b.y}`;
            const isSel = selectedConnId === c.id;
            const wireOpacity =
              focusActive && !wireFocused(c) ? FOCUS_DIM : 1;
            const fs = flowStyleFor(c);
            return (
              <g
                key={c.id}
                style={{ opacity: isSel ? 1 : wireOpacity, transition: 'opacity 160ms' }}
              >
                {/* Fat transparent hit-area so the thin wire is easy to
                    click-select; the visible stroke stays non-interactive. */}
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(null);
                    setSelectedConnId(c.id);
                  }}
                />
                {isSel && (
                  <path
                    d={path}
                    fill="none"
                    stroke={SW_COLORS.brand}
                    strokeWidth={(fs.width ?? 2) + 5}
                    strokeOpacity={0.28}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                )}
                <path
                  d={path}
                  fill="none"
                  stroke={isSel ? SW_COLORS.brand : fs.stroke}
                  strokeWidth={fs.width}
                  strokeDasharray={fs.dash ?? undefined}
                  strokeOpacity={0.85}
                  markerEnd="url(#builder-process-arrow)"
                  pointerEvents="none"
                />
              </g>
            );
          });
        })()}

        {/* Rubber-band wire shown while dragging out a new connector. */}
        {pendingWire && (() => {
          const from = positions.get(pendingWire.fromWsId);
          if (!from) return null;
          const outPort =
            from.block.outputs.find((p) => p.id === pendingWire.fromPort) ??
            from.block.outputs[0];
          if (!outPort) return null;
          const live = posOf(from.ws.id)!;
          const a = portPosition({ ...from, x: live.x, y: live.y }, outPort, 'out');
          const bx = pendingWire.x;
          const by = pendingWire.y;
          const dx = bx - a.x;
          const cx1 = a.x + Math.max(28, dx / 2);
          const cx2 = bx - Math.max(28, dx / 2);
          return (
            <path
              d={`M ${a.x} ${a.y} C ${cx1} ${a.y}, ${cx2} ${by}, ${bx} ${by}`}
              fill="none"
              stroke={SW_COLORS.brand}
              strokeWidth={2.5}
              strokeDasharray="5 4"
              strokeOpacity={0.9}
              pointerEvents="none"
            />
          );
        })()}

        {/* Block cards. A block stays in focus when it is itself selected, or
            when the selected dept is its parent lane (so picking a dept lights
            up all of its blocks). */}
        {Array.from(positions.values()).map((n) => {
          const isSelected = selectedWsIds.has(n.ws.id);
          const isDragging = dragWsIds.has(n.ws.id);
          const live = posOf(n.ws.id) ?? { x: n.x, y: n.y };
          const renderX = live.x;
          const renderY = live.y;
          // Port dots pick up the category accent so a wire's endpoints read as
          // belonging to the block they leave. The face itself resolves its own
          // tint from the same token.
          const tint = PML_CATEGORY_TINT[n.block.spec.category] ?? {
            fill: SW_COLORS.paper,
            stroke: SW_COLORS.line,
          };
          const bottleneck = !!n.ws.kpiObserved?.bottleneck;
          const focusActive = selectedWsIds.size > 0;
          const focusOpacity = focusActive && !isSelected ? FOCUS_DIM : 1;
          return (
            <g
              key={n.ws.id}
              transform={`translate(${renderX}, ${renderY})`}
              style={{
                cursor: connect.on
                  ? 'crosshair'
                  : isDragging
                    ? 'grabbing'
                    : 'grab',
                opacity: (isDragging ? 0.75 : 1) * focusOpacity,
                transition: 'opacity 160ms',
              }}
              onMouseDown={(e) => {
                // Skip when port-connect is the user's intent: ports have
                // their own handlers and we don't want to start a drag from
                // a clicked port.
                if (connect.on) return;
                if (drop.kind !== 'none') return;
                beginBlockDrag(n, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedConnId(null);
                onSelect({ kind: 'ws', id: n.ws.id }, e.shiftKey);
              }}
            >
              {/* Selection / bottleneck halo — drawn behind the symbol so it
                  reads as a ring whatever the symbol's fill colour is. */}
              {(isSelected || bottleneck) && (
                <rect
                  x={-4}
                  y={-4}
                  width={n.w + 8}
                  height={n.h + 8}
                  rx={14}
                  fill="none"
                  stroke={isSelected ? SW_COLORS.brand : SW_COLORS.alarm}
                  strokeWidth={3}
                />
              )}
              {/* Line tag. This is what replaced the dashed lane bands: the
                  band showed membership but could not be interrogated per
                  block, and it was drawn from the seed rather than from where
                  blocks actually sat, so it went stale the moment anyone
                  dragged one. No line → no tag; absence is the signal. */}
              {n.line && (() => {
                const accent = DEPT_COLOR_HEX[n.line.color];
                // Line names read "Line 1 · T-shirt (knit)" — take the part
                // before the separator so the tag is the line, not a truncated
                // garment with a dangling middle dot.
                const code = n.line.name
                  .split('\u00b7')[0]
                  .trim()
                  .toUpperCase()
                  .replace(/\s+/g, '')
                  .slice(0, 6);
                const tagW = Math.max(22, Math.min(64, code.length * 5.4 + 10));
                return (
                  <g pointerEvents="none">
                    <title>{n.line.name}</title>
                    <rect
                      x={0}
                      y={-15}
                      width={tagW}
                      height={12}
                      rx={3}
                      fill={alpha(accent, 0.18)}
                      stroke={alpha(accent, 0.55)}
                      strokeWidth={1}
                    />
                    <text
                      x={5}
                      y={-6}
                      fontFamily={SW_FONTS.mono}
                      fontSize={8}
                      fontWeight={700}
                      fill={accent}
                    >
                      {code}
                    </text>
                  </g>
                );
              })()}
              {/* Symbol — a solid, category-coloured plate (AnyLogic-style).
                  `stationMark` decides what sits on it: a real machine shows
                  its own family mark and type code, exactly as it does on the
                  2D floor and in the STATIONS palette, so a DNLS is a DNLS in
                  every tab instead of a generic Service gear here and a seam
                  diagonal next door. PML fixtures resolve to no mark and fall
                  back to the kind's glyph. */}
              <PmlBlockFace
                category={n.block.spec.category}
                Icon={n.block.spec.Icon}
                mark={stationMark(n.ws.catalogId)}
                size={n.w}
              />
              {/* Name — centred beneath the symbol, the only text on the node. */}
              <text
                x={n.w / 2}
                y={n.h + 15}
                textAnchor="middle"
                fontFamily={SW_FONTS.body}
                fontSize={11}
                fontWeight={700}
                fill={SW_COLORS.ink}
              >
                {n.ws.name.length > 20 ? n.ws.name.slice(0, 19) + '…' : n.ws.name}
              </text>

              {/* Input port dots — left edge. Clickable in CONNECT mode
                  once a source has been picked. */}
              {n.block.inputs.map((p, i) => {
                const slot = (i + 1) / (n.block.inputs.length + 1);
                const py = n.h * slot;
                // Armed in two-click CONNECT mode (a source is already picked)
                // OR while dragging a kind-compatible rubber-band wire here.
                const wireArmed =
                  pendingWire != null &&
                  pendingWire.fromWsId !== n.ws.id &&
                  (pendingFromKind == null || p.kind === pendingFromKind);
                const clickArmed =
                  connect.on && connect.fromWsId !== null && connect.fromWsId !== n.ws.id;
                const armed = wireArmed || clickArmed;
                const isHover =
                  hoverPort?.wsId === n.ws.id && hoverPort?.portId === p.id;
                return (
                  <g
                    key={`in-${p.id}`}
                    transform={`translate(0, ${py})`}
                    style={{ cursor: armed ? 'crosshair' : 'default' }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      if (wireArmed) setHover({ wsId: n.ws.id, portId: p.id });
                    }}
                    onMouseLeave={() => {
                      if (isHover) setHover(null);
                    }}
                    onClick={(e) => {
                      if (!clickArmed) return;
                      e.stopPropagation();
                      onPickToPort(n.ws.id, p.id);
                    }}
                  >
                    {/* Larger transparent hit area so the click/hover target
                        is comfortable even though the visible dot is small. */}
                    <circle cx={0} cy={0} r={12} fill="transparent" />
                    <circle
                      cx={0}
                      cy={0}
                      r={isHover ? 7 : armed ? 6 : 5}
                      fill={SW_COLORS.paper}
                      stroke={armed ? SW_COLORS.brand : tint.stroke}
                      strokeWidth={armed ? 2.5 : 2}
                    />
                    <circle cx={0} cy={0} r={1.8} fill={armed ? SW_COLORS.brand : tint.stroke} />
                    {n.block.inputs.length > 1 && (
                      <text
                        x={9}
                        y={3}
                        fontFamily={SW_FONTS.mono}
                        fontSize={8}
                        fontWeight={700}
                        fill={SW_COLORS.muted}
                        pointerEvents="none"
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Output port dots — right edge. Clickable in CONNECT mode
                  to set the source `(wsId, portId)`. The currently-selected
                  fromPort is highlighted with a brand-coloured halo. */}
              {n.block.outputs.map((p, i) => {
                const slot = (i + 1) / (n.block.outputs.length + 1);
                const py = n.h * slot;
                const isFrom =
                  (connect.on &&
                    connect.fromWsId === n.ws.id &&
                    connect.fromPort === p.id) ||
                  (pendingWire?.fromWsId === n.ws.id && pendingWire?.fromPort === p.id);
                return (
                  <g
                    key={`out-${p.id}`}
                    transform={`translate(${n.w}, ${py})`}
                    style={{ cursor: 'crosshair' }}
                    onMouseDown={(e) => {
                      // Two-click CONNECT mode sets the source on click;
                      // otherwise press-drag starts a rubber-band wire.
                      if (connect.on) return;
                      beginWireDrag(n.ws.id, p.id, e);
                    }}
                    onClick={(e) => {
                      if (!connect.on) return;
                      e.stopPropagation();
                      onPickFromPort(n.ws.id, p.id);
                    }}
                  >
                    <circle cx={0} cy={0} r={12} fill="transparent" />
                    {isFrom && (
                      <circle
                        cx={0}
                        cy={0}
                        r={9}
                        fill="none"
                        stroke={SW_COLORS.brand}
                        strokeWidth={2}
                        strokeDasharray="2 2"
                      />
                    )}
                    <circle
                      cx={0}
                      cy={0}
                      r={isFrom ? 6 : 5}
                      fill={isFrom ? SW_COLORS.brand : tint.stroke}
                      stroke={isFrom ? SW_COLORS.brand : tint.stroke}
                      strokeWidth={2}
                    />
                    <circle cx={0} cy={0} r={1.8} fill="#fff" />
                    {n.block.outputs.length > 1 && (
                      <text
                        x={-9}
                        y={3}
                        textAnchor="end"
                        fontFamily={SW_FONTS.mono}
                        fontSize={8}
                        fontWeight={700}
                        fill={SW_COLORS.muted}
                        pointerEvents="none"
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Drop ghost — what an armed palette tile will place, drawn at the
            position it will actually land on. The floor canvas has had one of
            these (`HoverPreview`) all along; without it this canvas dropped
            blind. Rendered last so it sits over the diagram, and guarded at
            render rather than cleared in an effect — a stale hoverPos behind
            this guard is invisible, and the effect would trip
            react-hooks/set-state-in-effect for nothing. */}
        {drop.kind === 'ws' && hoverPos && (() => {
          const spec = PML_BLOCK_LIBRARY[resolveBlockKindForDrop(drop.catalogId)];
          return (
            <g transform={`translate(${hoverPos.x}, ${hoverPos.y})`} pointerEvents="none">
              <PmlBlockFace
                category={spec.category}
                Icon={spec.Icon}
                mark={stationMark(drop.catalogId)}
                size={BLOCK_W}
                ghost
              />
            </g>
          );
        })()}

        {/* Marquee — same treatment as the floor's, including the zoom-
            compensated stroke so the rectangle is 1px at every scale. */}
        {selectRect && (
          <rect
            x={Math.min(selectRect.sx0, selectRect.sx1)}
            y={Math.min(selectRect.sy0, selectRect.sy1)}
            width={Math.abs(selectRect.sx1 - selectRect.sx0)}
            height={Math.abs(selectRect.sy1 - selectRect.sy0)}
            fill={alpha(SW_COLORS.brand, 0.09)}
            stroke={SW_COLORS.brand}
            strokeWidth={1 / Math.max(0.001, cam.z)}
            strokeDasharray={`${4 / Math.max(0.001, cam.z)} ${3 / Math.max(0.001, cam.z)}`}
            style={{ pointerEvents: 'none' }}
          />
        )}

        </g>
      </svg>

      {/* No empty state here on purpose: the stage renders one for every view
          (see "Empty floor" below). This canvas used to draw its own, so the
          PROCESS view showed two overlapping messages on a blank floor. */}
    </div>
    {/* Auto-arrange — reflow every block into the flow-ordered serpentine
        seed. A clean way out of a tangled canvas.

        Two-stage, because this silently discarded every hand-placed position:
        the first click arms it and the label says so, a second click within
        4s commits. It commits immediately when nothing has been hand-placed,
        since there is nothing to lose. */}
    <button
      type="button"
      onClick={() => {
        const hasAuthored = twin.workstations.some((w) => w.block?.processPos);
        if (hasAuthored && !arrangeArmed) {
          setArrangeArmed(true);
          if (arrangeTimer.current) window.clearTimeout(arrangeTimer.current);
          arrangeTimer.current = window.setTimeout(() => setArrangeArmed(false), 4000);
          return;
        }
        if (arrangeTimer.current) window.clearTimeout(arrangeTimer.current);
        setArrangeArmed(false);
        const seeded = computeProcessSeedPositions(twin);
        const entries = twin.workstations
          .map((ws) => {
            const pos = seeded.get(ws.id);
            return pos ? { wsId: ws.id, pos } : null;
          })
          .filter(Boolean) as { wsId: string; pos: { x: number; y: number } }[];
        if (entries.length > 0) setProcessPositions(entries);
        setSelectedConnId(null);
        onFitRequest();
      }}
      onBlur={() => setArrangeArmed(false)}
      title={
        arrangeArmed
          ? 'Click again to overwrite every hand-placed position (undo with Cmd-Z)'
          : 'Reflow all blocks into the flow-ordered layout'
      }
      style={{
        position: 'absolute',
        bottom: 92,
        left: 14,
        zIndex: 5,
        padding: '6px 12px',
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: 6,
        cursor: 'pointer',
        fontFamily: SW_FONTS.mono,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.06em',
        color: arrangeArmed ? SW_COLORS.brandText : SW_COLORS.ink,
        boxShadow: SW_SHADOWS.hud,
      }}
    >
      {arrangeArmed ? '⤢ OVERWRITE ALL POSITIONS?' : '⤢ AUTO-ARRANGE'}
    </button>
    <ProcessCodeView twin={twin} />
    </>
  );
}

// ============================================================================
// INSPECTOR (right)
// ============================================================================

/**
 * Lens picker shown at the top of the Inspector. The chosen lens drives both
 * the iso canvas badge above each workstation and which group of fields the
 * Inspector highlights (Operations · Resources · KPI targets) — keeping the
 * toggle next to the highlighted section makes the wiring legible.
 */
/**
 * Show every operator currently assigned to a workstation, with their
 * role + shareFrac. Surfaces the data model that the Build-in-Builder seed
 * authors so the user can see at a glance whether a station is run by
 * one primary, by a rotation cell, or shared between two operators.
 *
 * Render-only for now — editing assignments (drag an operator onto a
 * station, change shareFrac, mark a worker as shared) is a follow-up.
 * When there are no assignments we render a short hint so the user knows
 * the station is currently uncovered.
 */
function WorkstationAssignmentsView({
  ws,
  operators,
  assignments,
  connectors,
}: {
  ws: Workstation;
  operators: Operator[];
  assignments: Assignment[];
  connectors: Connector[];
}) {
  const rows = assignments.filter((a) => a.wsId === ws.id);
  const operatorsById = new Map(operators.map((o) => [o.id, o]));

  // "Share with next station" is offered when:
  //   - this station has exactly one primary assignment (the typical
  //     fixed-station shape — sharing a rotation cell doesn't make sense),
  //   - that operator isn't already shared (shareFrac === 1),
  //   - a flow connector leaves this station to a downstream one,
  //   - and that downstream station also has a primary assignment whose
  //     operator differs from ours (otherwise they're already shared).
  // Gating like this keeps the button quiet when the gesture wouldn't
  // mean anything; users only see it when it's actually applicable.
  const myPrimary = rows.find((a) => a.role === 'primary');
  const nextEdge = connectors.find(
    (c) => c.kind === 'flow' && c.fromWsId === ws.id,
  );
  const nextPrimary = nextEdge
    ? assignments.find((a) => a.wsId === nextEdge.toWsId && a.role === 'primary')
    : undefined;
  const canShareWithNext =
    !!myPrimary &&
    (myPrimary.shareFrac ?? 1) === 1 &&
    !!nextPrimary &&
    nextPrimary.operatorId !== myPrimary.operatorId;

  // Summarise the assignment mix in one line — "6 rotators", "primary + 2 helpers",
  // "shared 50/50", etc. — so the user reads the staffing model before they
  // need to scan individual rows.
  const summary = (() => {
    if (rows.length === 0) return 'uncovered';
    const byRole = new Map<string, number>();
    for (const a of rows) byRole.set(a.role, (byRole.get(a.role) ?? 0) + 1);
    const sharedRows = rows.filter((a) => (a.shareFrac ?? 1) < 1 && a.role !== 'rotation_member');
    const parts: string[] = [];
    if (byRole.get('rotation_member')) {
      parts.push(`${byRole.get('rotation_member')} rotator${byRole.get('rotation_member') === 1 ? '' : 's'}`);
    }
    if (byRole.get('primary')) {
      parts.push(`${byRole.get('primary')}× primary`);
    }
    if (byRole.get('helper')) {
      parts.push(`${byRole.get('helper')}× helper`);
    }
    if (byRole.get('floater')) {
      parts.push(`${byRole.get('floater')}× floater`);
    }
    if (sharedRows.length > 0) {
      parts.push(`${sharedRows.length} shared`);
    }
    return parts.join(' · ') || 'uncovered';
  })();

  // Slowest non-rotation shareFrac wins — that's also what the engine reads
  // in pml-engine `buildShareFactorMap`. Engine multiplies the nominal cycle
  // by 1/shareFactor, so a shareFrac of 0.5 ≡ a 2× slowdown.
  const stationShareFrac = (() => {
    let min = 1;
    for (const a of rows) {
      if (a.role === 'rotation_member') continue;
      const sf = a.shareFrac ?? 1;
      if (sf >= 1) continue;
      if (sf < min) min = sf;
    }
    return min;
  })();
  const cycleMultiplier = stationShareFrac > 0 ? 1 / stationShareFrac : 1;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={sectionLabel}>Operators on this station</div>
        <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: rows.length === 0 ? SW_COLORS.muted : SW_COLORS.brand }}>
          {summary}
        </div>
      </div>
      {stationShareFrac < 1 && (
        <div
          title={`This station shares its operator with ${Math.round(cycleMultiplier) - 1} other station${Math.round(cycleMultiplier) - 1 === 1 ? '' : 's'}. The simulation engine multiplies this station's cycle time by ${cycleMultiplier.toFixed(2)}× because the operator is only present ${Math.round(stationShareFrac * 100)}% of the shift.`}
          style={{
            marginTop: 6,
            padding: '4px 8px',
            border: `1px dashed ${SW_COLORS.alarm}`,
            borderRadius: 4,
            background: SW_COLORS.paper,
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            color: SW_COLORS.alarm,
            letterSpacing: '0.04em',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>⚠ ENGINE CYCLE × {cycleMultiplier.toFixed(2)}</span>
          <span style={{ fontWeight: 600, color: SW_COLORS.muted }}>operator @ {Math.round(stationShareFrac * 100)}%</span>
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ fontSize: 11, color: SW_COLORS.muted, fontFamily: SW_FONTS.body, padding: '4px 0' }}>
          No operator is assigned to this workstation yet. Seeded twins
          assign operators automatically — manually-placed stations need
          an explicit Assignment row.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {rows.map((a) => {
            const op = operatorsById.get(a.operatorId);
            // Render shareFrac as a percentage so 0.5 ⇒ "50%". Defaults
            // surface differently depending on role so users don't see a
            // misleading "—" for the typical "primary @ 100%" case.
            const sharePct =
              a.shareFrac !== undefined
                ? Math.round(a.shareFrac * 100)
                : a.role === 'primary'
                  ? 100
                  : a.role === 'helper'
                    ? 30
                    : null;
            const roleColor =
              a.role === 'primary'
                ? SW_COLORS.brand
                : a.role === 'rotation_member'
                  ? SW_COLORS.bobbin
                  : a.role === 'helper'
                    ? SW_COLORS.thread
                    : SW_COLORS.muted;
            return (
              <div
                key={a.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: 8,
                  alignItems: 'center',
                  padding: '4px 6px',
                  border: `1px solid ${SW_COLORS.line}`,
                  borderLeft: `3px solid ${roleColor}`,
                  borderRadius: 4,
                  background: SW_COLORS.paper,
                  fontSize: 11,
                }}
                title={`Assignment ${a.id} · operator ${a.operatorId}`}
              >
                <div style={{ fontWeight: 700, color: SW_COLORS.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {op?.name ?? '—'}
                </div>
                <span
                  style={{
                    fontFamily: SW_FONTS.mono,
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: 0.6,
                    color: roleColor,
                    textTransform: 'uppercase',
                  }}
                >
                  {a.role.replace('_', ' ')}
                </span>
                <span
                  style={{
                    fontFamily: SW_FONTS.mono,
                    fontSize: 10,
                    fontWeight: 700,
                    color: sharePct !== null && sharePct < 100 ? SW_COLORS.alarm : SW_COLORS.muted,
                    minWidth: 36,
                    textAlign: 'right',
                  }}
                >
                  {sharePct !== null ? `${sharePct}%` : '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {canShareWithNext && nextEdge && myPrimary && (
        <button
          onClick={() =>
            useTwin
              .getState()
              .shareOperatorsBetweenStations(ws.id, nextEdge.toWsId)
          }
          title="Take this station's operator and assign them to the next station too. The next station's operator is removed; both stations now share one operator at a halved shareFrac."
          style={{
            marginTop: 6,
            padding: '5px 10px',
            background: 'transparent',
            border: `1px dashed ${SW_COLORS.brand}`,
            color: SW_COLORS.brand,
            fontFamily: SW_FONTS.display,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            borderRadius: 4,
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
          }}
        >
          🔀 SHARE WITH NEXT STATION
        </button>
      )}
      {/* Inverse gesture — visible only when this station's primary is
          already shared. Peels the station off the shared operator and
          grafts a fresh primary onto it. */}
      {myPrimary && (myPrimary.shareFrac ?? 1) < 1 && myPrimary.role !== 'rotation_member' && (
        <button
          onClick={() => useTwin.getState().unshareWorkstation(ws.id)}
          title="Restore a dedicated operator on this station. The shared operator now covers one fewer station, and the surviving assignments rebalance to 1 / (N - 1)."
          style={{
            marginTop: 6,
            padding: '5px 10px',
            background: 'transparent',
            border: `1px dashed ${SW_COLORS.line}`,
            color: SW_COLORS.muted,
            fontFamily: SW_FONTS.display,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            borderRadius: 4,
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
          }}
        >
          ⇆ RESTORE OWN OPERATOR
        </button>
      )}
    </div>
  );
}

/**
 * Per-line POLICY editor — exposes the system-aware behaviour knobs that
 * live on `SewingLine.policy`. Unset fields show their `defaultPolicyFor`
 * value as a placeholder so the user sees what the engine will fall back
 * to. Editing a field promotes it to a real override; clearing the input
 * sends `undefined` and the line goes back to using the system default.
 *
 * Rendered inline inside each sewing-line card in the Department inspector.
 * Collapsed by default to keep the line card compact.
 */
function LinePolicyEditor({
  line,
  onUpdateLine,
}: {
  line: SewingLine;
  onUpdateLine: (
    id: string,
    patch: Partial<Omit<SewingLine, 'id' | 'deptId'>>,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const defaults = defaultPolicyFor(line.productionSystem);
  const p: LinePolicy = line.policy ?? {};

  // Field is considered "overridden" if the user has set it explicitly.
  // `pieceFlow` is a boolean, so we test for `undefined` separately.
  const overrideCount =
    (p.bundleSize !== undefined ? 1 : 0) +
    (p.pieceFlow !== undefined ? 1 : 0) +
    (p.taktSec !== undefined ? 1 : 0) +
    (p.conveyorSpeed !== undefined ? 1 : 0) +
    (p.rotationGroupSize !== undefined ? 1 : 0) +
    (p.maxWipPerStation !== undefined ? 1 : 0) +
    (p.helperMode !== undefined ? 1 : 0);

  function patch(next: Partial<LinePolicy>) {
    const merged: LinePolicy = { ...p, ...next };
    // Strip keys whose value is undefined so a fully-cleared policy reverts
    // to `undefined` (no overrides) instead of an empty object stranded on
    // the line forever.
    const cleaned: LinePolicy = {};
    if (merged.bundleSize !== undefined) cleaned.bundleSize = merged.bundleSize;
    if (merged.pieceFlow !== undefined) cleaned.pieceFlow = merged.pieceFlow;
    if (merged.taktSec !== undefined) cleaned.taktSec = merged.taktSec;
    if (merged.conveyorSpeed !== undefined) cleaned.conveyorSpeed = merged.conveyorSpeed;
    if (merged.rotationGroupSize !== undefined) cleaned.rotationGroupSize = merged.rotationGroupSize;
    if (merged.maxWipPerStation !== undefined) cleaned.maxWipPerStation = merged.maxWipPerStation;
    if (merged.helperMode !== undefined) cleaned.helperMode = merged.helperMode;
    onUpdateLine(line.id, {
      policy: Object.keys(cleaned).length === 0 ? undefined : cleaned,
    });
  }

  // Show only the knobs that are meaningful for this system. Hiding the
  // dead fields keeps the editor honest — e.g. takt time has no role on a
  // PBS line, so showing the field would just confuse the user.
  const sys = line.productionSystem;
  const showBundle = !defaults.pieceFlow;          // PBS — bundle is THE primitive
  const showPieceFlow = true;                       // every system has a notion of this
  const showTakt = sys === 'synchro';
  const showConveyor = sys === 'synchro' || sys === 'UPS';
  const showRotation = sys === 'modular';
  const showWipCap = defaults.pieceFlow;            // piece-flow systems use WIP caps
  const showHelper = true;

  // Compact number-input renderer. Empty input ⇒ `undefined` so the field
  // falls back to the system default.
  function numField(
    label: string,
    value: number | undefined,
    placeholder: number,
    unit: string,
    onChange: (v: number | undefined) => void,
  ) {
    return (
      <div>
        <label style={{ ...fieldLabel, marginTop: 0 }}>{label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            value={value ?? ''}
            placeholder={String(placeholder)}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(raw === '' ? undefined : Number(raw));
            }}
            style={{ ...inputBase, padding: '3px 6px', fontSize: 11 }}
          />
          {unit && (
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted }}>
              {unit}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8, borderTop: `1px dashed ${SW_COLORS.line}`, paddingTop: 6 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          ...btnSec(),
          padding: '3px 8px',
          fontSize: 10,
          background: 'transparent',
          border: 'none',
          color: overrideCount > 0 ? SW_COLORS.brand : SW_COLORS.muted,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        title="System-specific behaviour knobs"
      >
        <Chevron open={open} />
        <span>POLICY</span>
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, color: SW_COLORS.muted }}>
          {overrideCount > 0
            ? `${overrideCount} override${overrideCount === 1 ? '' : 's'}`
            : `${line.productionSystem.toUpperCase()} defaults`}
        </span>
      </button>
      {open && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            marginTop: 6,
            paddingLeft: 14,
          }}
        >
          {showBundle &&
            numField(
              'Bundle size',
              p.bundleSize,
              defaults.bundleSize,
              'pcs',
              (v) => patch({ bundleSize: v }),
            )}
          {showPieceFlow && (
            <div>
              <label style={{ ...fieldLabel, marginTop: 0 }}>Piece flow</label>
              <select
                value={
                  p.pieceFlow === undefined
                    ? 'default'
                    : p.pieceFlow
                      ? 'yes'
                      : 'no'
                }
                onChange={(e) => {
                  const v = e.target.value;
                  patch({
                    pieceFlow:
                      v === 'default' ? undefined : v === 'yes' ? true : false,
                  });
                }}
                style={{ ...inputBase, appearance: 'auto', padding: '3px 6px', fontSize: 11 }}
              >
                <option value="default">
                  default · {defaults.pieceFlow ? 'piece' : 'bundle'}
                </option>
                <option value="yes">Piece-by-piece</option>
                <option value="no">Batched (bundle)</option>
              </select>
            </div>
          )}
          {showTakt &&
            numField('Takt time', p.taktSec, defaults.taktSec, 'sec', (v) =>
              patch({ taktSec: v }),
            )}
          {showConveyor &&
            numField(
              'Conveyor speed',
              p.conveyorSpeed,
              defaults.conveyorSpeed,
              'cells/min',
              (v) => patch({ conveyorSpeed: v }),
            )}
          {showRotation &&
            numField(
              'Rotation cell',
              p.rotationGroupSize,
              defaults.rotationGroupSize,
              'stations',
              (v) => patch({ rotationGroupSize: v }),
            )}
          {showWipCap &&
            numField(
              'Max WIP/stn',
              p.maxWipPerStation,
              defaults.maxWipPerStation,
              'pcs',
              (v) => patch({ maxWipPerStation: v }),
            )}
          {showHelper && (
            <div>
              <label style={{ ...fieldLabel, marginTop: 0 }}>Helpers</label>
              <select
                value={p.helperMode ?? 'default'}
                onChange={(e) => {
                  const v = e.target.value;
                  patch({
                    helperMode:
                      v === 'default'
                        ? undefined
                        : (v as NonNullable<LinePolicy['helperMode']>),
                  });
                }}
                style={{ ...inputBase, appearance: 'auto', padding: '3px 6px', fontSize: 11 }}
              >
                <option value="default">default · {defaults.helperMode}</option>
                <option value="none">none</option>
                <option value="adjacent">adjacent</option>
                <option value="pool">pool</option>
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface InspectorProps {
  twin: ReturnType<typeof selectActiveTwin>;
  selected: { kind: 'ws'; id: string } | null;
  lens: Lens;
  onUpdateWs: (id: string, patch: Partial<Workstation>) => void;
  onRemoveWs: (id: string) => void;
  onSetOperation: (wsId: string, patch: Partial<Workstation['operation']>) => void;
  onSetResources: (wsId: string, patch: Partial<Workstation['resources']>) => void;
  onSetKpiTargets: (wsId: string, patch: Partial<Workstation['kpiTargets']>) => void;
  /** Set or clear the workstation's PML block override. */
  onSetBlock: (wsId: string, block: PmlBlockOverride | null) => void;
  onRemoveConnector: (id: string) => void;
  /** Add a new sewing line to a department. */
  onAddLine: () => void;
  /** Remove a sewing line. */
  onRemoveLine: (id: string) => void;
  /** Rename / re-style a sewing line. */
  onUpdateLine: (id: string, patch: Partial<Omit<SewingLine, 'id'>>) => void;
  /** Assign / unassign a single workstation to a line. */
  onAssignLine: (wsId: string, lineId: string | null) => void;
  /** Collapse the pane to its rail. */
  onCollapse: () => void;
}

/**
 * Inspector column shell: owns the grid cell, the pane header (title +
 * collapse control, mirroring the palette's) and the scroll boundary. The
 * selection-dependent body renders inside it.
 */
function Inspector(props: InspectorProps) {
  return (
    <div
      style={{
        gridColumn: '5',
        gridRow: '2',
        borderLeft: `1px solid ${SW_COLORS.line}`,
        borderTop: `3px solid ${SW_COLORS.brand}`,
        background: SW_COLORS.steel,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          flex: '0 0 auto',
          height: 40,
          padding: '0 12px',
          borderBottom: `1px solid ${SW_COLORS.line}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ ...SW_TYPE.kicker, color: SW_COLORS.ink }}>Inspector</span>
        <PaneCollapseButton side="right" onClick={props.onCollapse} />
      </div>
      <InspectorBody {...props} />
    </div>
  );
}

function InspectorBody(props: InspectorProps) {
  const confirm = useConfirm();
  // Operation binding is picked from the garment's bulletin, not typed. An
  // unbound station falls back to its own line's garment, so a freshly
  // dropped station offers the right ops without the user picking one.
  const garments = useGarments();
  // Scroll boundary inside the shell — the shell owns the column, border and
  // header, so the body only styles its own padding + overflow.
  const wrapper: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 14,
  };

  // Nothing selected — the Inspector falls back to factory-level authoring.
  // Sewing lines live here because they are top-level now: the floor is free
  // space, so a line belongs to the factory rather than to any zone, and this
  // is the only place to create one before there is a station to select.
  if (!props.selected) {
    const lines = props.twin.lines ?? [];
    return (
      <div style={wrapper}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
          <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>Factory</div>
          <div style={{ ...SW_TYPE.title, color: SW_COLORS.ink }}>{props.twin.name}</div>
          <div style={{ display: 'flex', gap: 6, paddingTop: 2 }}>
            <InspectorChip edge={SW_COLORS.line}>{`${props.twin.workstations.length} STN`}</InspectorChip>
            <InspectorChip edge={SW_COLORS.line}>{`${lines.length} LINE${lines.length === 1 ? '' : 'S'}`}</InspectorChip>
          </div>
        </div>

        <div style={{ ...SW_TYPE.body, color: SW_COLORS.muted, marginBottom: 12 }}>
          Click a station to inspect it, or drop one from the palette anywhere
          on the floor.
        </div>

        <InspectorGroup
          id="factory.lines"
          title={`Sewing lines · ${lines.length}`}
          defaultOpen
          right={
            <button
              onClick={() => props.onAddLine()}
              style={{ ...btnSec(), padding: '3px 9px', fontSize: 10 }}
              title="Create a new production line"
            >
              + ADD LINE
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
            {lines.length === 0 && (
              <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted }}>
                No production lines yet. Stations placed without one draw from
                the factory-level operator pool.
              </div>
            )}
            {lines.map((line) => {
              const memberCount = props.twin.workstations.filter((w) => w.lineId === line.id).length;
              return (
                <div
                  key={line.id}
                  style={{
                    border: `1px solid ${SW_COLORS.line}`,
                    borderLeft: `4px solid ${DEPT_COLOR_HEX[line.color]}`,
                    borderRadius: SW_RADIUS.sm,
                    padding: 8,
                    background: SW_COLORS.paper,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={line.name}
                      onChange={(e) => props.onUpdateLine(line.id, { name: e.target.value })}
                      style={{ ...inputBase, flex: 1, height: 28, fontSize: 12 }}
                    />
                    <button
                      onClick={async () => {
                        if (
                          await confirm({
                            title: 'Delete line',
                            message: `Delete "${line.name}"? Its ${memberCount} station${memberCount === 1 ? '' : 's'} stay on the floor, unassigned.`,
                            confirmLabel: 'Delete',
                            variant: 'danger',
                          })
                        ) {
                          props.onRemoveLine(line.id);
                        }
                      }}
                      style={{ ...btnSec(), color: SW_COLORS.alarm, padding: '3px 8px' }}
                      title="Delete this line (its stations remain on the floor)"
                    >
                      ✕
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                    <InspectorChip edge={SW_COLORS.line}>{line.productionSystem}</InspectorChip>
                    <InspectorChip edge={SW_COLORS.line}>{`${memberCount} STN`}</InspectorChip>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <LinePolicyEditor line={line} onUpdateLine={props.onUpdateLine} />
                  </div>
                </div>
              );
            })}
          </div>
        </InspectorGroup>
      </div>
    );
  }


  // Workstation
  const ws = props.twin.workstations.find((w) => w.id === props.selected!.id);
  if (!ws) return <div style={wrapper}>Selection lost.</div>;
  const fixture = lookupFixture(ws.catalogId);
  // Every line in the factory is assignable — the floor is free space, so a
  // station's line membership is not constrained by where it physically sits.
  const allLines = props.twin.lines ?? [];
  const wsLine = ws.lineId ? allLines.find((l) => l.id === ws.lineId) ?? null : null;
  // Header chips + stat tiles — all authoring data (bulletin SMV, staffing),
  // never sim results; those stay in the Sim view.
  const machineCode = ISO_FIXTURE_TO_MACHINE_CODE[ws.catalogId];
  const opMeta = opMetaFor(ws, garments.byId);
  const boundOp =
    ws.operation.opId && ws.operation.garmentId
      ? garments.byId[ws.operation.garmentId]?.operations.find((o) => o.id === ws.operation.opId)
      : undefined;

  return (
    <div style={wrapper}>
      {/* Identity masthead — overline kicker, display name, chip row. The
          name is edited in the Identity group below; this is the read view. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <div style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>Workstation</div>
          <div style={{ ...SW_TYPE.title, color: SW_COLORS.ink, overflowWrap: 'anywhere' }}>
            {ws.name}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingTop: 2 }}>
            {ws.operation.opId && (
              <InspectorChip bg={SW_COLORS.brandLite} fg={SW_COLORS.brandText} edge={SW_COLORS.brandEdge}>
                {opMeta.code}
              </InspectorChip>
            )}
            {machineCode && <InspectorChip edge={SW_COLORS.line}>{machineCode}</InspectorChip>}
            {wsLine && (
              <InspectorChip edge={SW_COLORS.line} swatch={DEPT_COLOR_HEX[wsLine.color]}>
                {wsLine.name}
              </InspectorChip>
            )}
          </div>
        </div>
        <button onClick={() => props.onRemoveWs(ws.id)} style={{ ...btnSec(), color: SW_COLORS.alarm, padding: '3px 8px', flex: 'none' }}>
          ✕ DELETE
        </button>
      </div>

      {/* Stat tiles — bulletin SMV and required staffing, side by side. */}
      {(boundOp || ws.resources.workersRequired > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '12px 0 2px' }}>
          {/* SMV is the mean service time and OPR is the parallel-channel
              count, so both are Kendall–Lee quantities and carry their symbol. */}
          <InspectorStat
            label={<>SMV <Sym quantity="serviceTime" bracketed color={SW_COLORS.brandText} /></>}
            value={boundOp ? boundOp.smv.toFixed(2) : '—'}
            unit="min"
          />
          <InspectorStat
            label={<>OPR <Sym quantity="servers" bracketed color={SW_COLORS.brandText} /></>}
            value={String(ws.resources.workersRequired)}
            unit="required"
          />
        </div>
      )}
      <div style={{ height: 10 }} />

      <InspectorGroup id="ws.identity" title="Identity" defaultOpen>
      <label style={fieldLabel}>Name</label>
      <input
        value={ws.name}
        onChange={(e) => props.onUpdateWs(ws.id, { name: e.target.value })}
        style={inputBase}
      />
      <div style={{ marginTop: 4, fontSize: 11, color: SW_COLORS.muted }}>
        Fixture: <strong style={{ color: SW_COLORS.muted }}>{fixture?.label ?? ws.catalogId}</strong>
      </div>

      {/* SEWING LINE — the only grouping a station can belong to. */}
      {allLines.length > 0 && (
        <>
          <div style={{ height: 10 }} />
          <label style={fieldLabel}>Sewing line</label>
          <select
            value={ws.lineId ?? ''}
            onChange={(e) =>
              props.onAssignLine(ws.id, e.target.value === '' ? null : e.target.value)
            }
            style={{ ...inputBase, appearance: 'auto' }}
          >
            <option value="">— Unassigned (free-standing fixture) —</option>
            {allLines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {wsLine && (
            <div style={{ marginTop: 4, fontSize: 10, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: DEPT_COLOR_HEX[wsLine.color],
                  marginRight: 6,
                  verticalAlign: 'middle',
                }}
              />
              {wsLine.productionSystem.toUpperCase()}
              {wsLine.garmentId ? ` · ${wsLine.garmentId}` : ''}
            </div>
          )}
        </>
      )}

      </InspectorGroup>

      <InspectorGroup id="ws.placement" title="Placement" defaultOpen={false}>
      <div style={{ ...sectionLabel, marginBottom: 6 }}>Position (cells)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <NumField label="x" step={0.1} value={ws.position.x} onChange={(v) => props.onUpdateWs(ws.id, { position: { ...ws.position, x: v } })} />
        <NumField label="y" step={0.1} value={ws.position.y} onChange={(v) => props.onUpdateWs(ws.id, { position: { ...ws.position, y: v } })} />
      </div>

      {(() => {
        // Effective size = per-ws override ?? catalogue default. Inspector
        // edits always write the override so the workstation diverges from
        // the catalogue size. Decimal stepping (0.1) lets the user dial in
        // sub-cell dimensions.
        const eff = {
          w: ws.size?.w ?? fixture?.w ?? 1,
          d: ws.size?.d ?? fixture?.d ?? 1,
          h: ws.size?.h ?? fixture?.h ?? 1,
        };
        const writeSize = (patch: Partial<{ w: number; d: number; h: number }>) =>
          props.onUpdateWs(ws.id, { size: { ...eff, ...patch } });
        return (
          <>
            <div style={{ height: 12 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={sectionLabel}>Size (cells)</div>
              {ws.size && (
                <button
                  onClick={() => props.onUpdateWs(ws.id, { size: undefined })}
                  style={{ ...btnSec(), padding: '2px 7px', fontSize: 9 }}
                  title="Restore the catalogue's default size"
                >
                  RESET
                </button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              <NumField label="w" step={0.1} value={eff.w} onChange={(v) => writeSize({ w: v })} />
              <NumField label="d" step={0.1} value={eff.d} onChange={(v) => writeSize({ d: v })} />
              <NumField label="h" step={0.1} value={eff.h} onChange={(v) => writeSize({ h: v })} />
            </div>
          </>
        );
      })()}
      </InspectorGroup>

      <InspectorGroup
        id="ws.block"
        title="Process block"
        defaultOpen={false}
        forceOpen={getBlockSpec(ws).overridden}
      >
        <BlockSection
          ws={ws}
          onSetBlock={props.onSetBlock}
        />
      </InspectorGroup>

      <LensSection
        id="ws.operations"
        title="Operations"
        active={props.lens === 'operations'}
      >
        {(() => {
          const garmentId =
            ws.operation.garmentId ??
            props.twin.lines.find((l) => l.id === ws.lineId)?.garmentId ??
            garments.all[0]?.id;
          const garment = garmentId ? garments.byId[garmentId] : undefined;
          const ops = garment?.operations ?? [];
          // A station bound to an id the bulletin no longer lists (legacy
          // data, a hand-typed id, a since-edited garment) keeps its binding
          // as an extra option rather than silently losing it.
          const orphanOpId =
            ws.operation.opId && !ops.some((o) => o.id === ws.operation.opId)
              ? ws.operation.opId
              : null;
          return (
            <>
              <label style={fieldLabel}>Garment</label>
              <select
                value={garmentId}
                onChange={(e) =>
                  // Ops are garment-scoped, so switching garment invalidates
                  // whatever op was bound.
                  props.onSetOperation(ws.id, { garmentId: e.target.value, opId: null })
                }
                style={inputBase}
              >
                {garments.all.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
                {!garment && <option value={garmentId}>{garmentId} (unknown)</option>}
              </select>
              <div style={{ height: 8 }} />
              <label style={fieldLabel}>Operation</label>
              <select
                value={ws.operation.opId ?? ''}
                onChange={(e) =>
                  props.onSetOperation(ws.id, {
                    opId: e.target.value || null,
                    garmentId,
                  })
                }
                style={inputBase}
              >
                <option value="">— not bound —</option>
                {orphanOpId && <option value={orphanOpId}>{orphanOpId} (not in bulletin)</option>}
                {ops.map((o) => (
                  <option key={o.id} value={o.id}>
                    {(o.code ? o.code + ' · ' : '') + o.name + ' · ' + o.smv.toFixed(2)}
                  </option>
                ))}
              </select>
              <div style={{ height: 8 }} />
            </>
          );
        })()}
        <label style={fieldLabel}>Free text (storage racks, generic tables, …)</label>
        <input
          value={ws.operation.freeText ?? ''}
          onChange={(e) => props.onSetOperation(ws.id, { freeText: e.target.value || undefined })}
          placeholder="e.g. fabric rolls — knit cotton"
          style={inputBase}
        />
        <div style={{ height: 12 }} />
        <ServiceQueueParams ws={ws} />
      </LensSection>

      <LensSection id="ws.resources" title="Resources" active={props.lens === 'resources'}>
        <NumField
          label={<>Workers required <Sym quantity="servers" bracketed color={SW_COLORS.brandText} /></>}
          value={ws.resources.workersRequired}
          onChange={(v) => props.onSetResources(ws.id, { workersRequired: v })}
        />
        <div style={{ height: 12 }} />
        <WorkstationAssignmentsView
          ws={ws}
          operators={props.twin.operators ?? []}
          assignments={props.twin.assignments ?? []}
          connectors={props.twin.connectors ?? []}
        />
      </LensSection>

      <LensSection id="ws.targets" title="KPI targets" active={props.lens === 'kpis'}>
        <NumField
          label={<>Capacity / hr <Sym quantity="mu" bracketed color={SW_COLORS.brandText} /></>}
          value={ws.kpiTargets.capacityPerHr ?? 0}
          onChange={(v) => props.onSetKpiTargets(ws.id, { capacityPerHr: v })}
        />
        <div style={{ height: 8 }} />
        <NumField
          label="Efficiency %"
          value={ws.kpiTargets.efficiencyPct ?? 0}
          onChange={(v) => props.onSetKpiTargets(ws.id, { efficiencyPct: v })}
        />
        <div style={{ height: 8 }} />
        <NumField
          label={<>Utilisation % <Sym quantity="rho" bracketed color={SW_COLORS.brandText} /></>}
          value={ws.kpiTargets.utilizationPct ?? 0}
          onChange={(v) => props.onSetKpiTargets(ws.id, { utilizationPct: v })}
        />
        {ws.kpiObserved ? (
          <InspectorGroup id="ws.observed" title="Observed (last run)" defaultOpen={false}>
            <div style={{ padding: 10, background: SW_COLORS.paperDeep, borderRadius: 6, border: `1px solid ${SW_COLORS.line}` }}>
              <ObservedRow
                label={<>Capacity / hr <Sym quantity="mu" bracketed color={SW_COLORS.brandText} /></>}
                value={ws.kpiObserved.capacityPerHr.toFixed(0)}
              />
              <ObservedRow label="Efficiency %" value={ws.kpiObserved.efficiencyPct.toFixed(1)} />
              <ObservedRow
                label={<>Utilisation % <Sym quantity="rho" bracketed color={SW_COLORS.brandText} /></>}
                value={ws.kpiObserved.utilizationPct.toFixed(1)}
              />
              {ws.kpiObserved.bottleneck && (
                <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: SW_COLORS.alarm }}>
                  ◆ Bottleneck in last run
                </div>
              )}
            </div>
          </InspectorGroup>
        ) : (
          <div style={{ marginTop: 8, fontSize: 11, color: SW_COLORS.muted }}>
            No simulated values yet — run the sim to populate observed KPIs.
          </div>
        )}
      </LensSection>

      <InspectorGroup id="ws.flow" title="Flow connections" defaultOpen={false}>
        <FlowSection
          ws={ws}
          twin={props.twin}
          onRemoveConnector={props.onRemoveConnector}
        />
      </InspectorGroup>
    </div>
  );
}

/** PROCESS BLOCK panel — lets the user inspect and override the PML block
 *  kind for the selected workstation. The default is inferred from the
 *  fixture's `catalogId` (e.g. a sewing machine → Service, a buffer pad →
 *  Queue); the user can override per-station to model non-default
 *  semantics (a generic table tagged as a Hold or Match block). */
function BlockSection({
  ws,
  onSetBlock,
}: {
  ws: Workstation;
  onSetBlock: (wsId: string, block: PmlBlockOverride | null) => void;
}) {
  const block = getBlockSpec(ws);
  const defaultKind = inferBlockKindFromCatalog(ws.catalogId);
  const role = apparelRoleFor(ws);

  const onPickKind = (next: PmlBlockKind | 'auto') => {
    if (next === 'auto') {
      onSetBlock(ws.id, null);
      return;
    }
    if (next === defaultKind) {
      // Picking the catalog default explicitly = drop the override; same
      // outcome as 'auto', but the dropdown reflects the user's intent.
      onSetBlock(ws.id, null);
      return;
    }
    onSetBlock(ws.id, { kind: next });
  };

  // Tint to match the PROCESS view category palette so the section visually
  // ties to the canvas card style.
  const catTint = PML_CATEGORY_TINT[block.spec.category] ?? {
    fill: SW_COLORS.paper,
    stroke: SW_COLORS.line,
  };

  return (
    <div>
      {/* Section title comes from the wrapping InspectorGroup; only the
          override RESET action renders here. */}
      {block.overridden && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={() => onSetBlock(ws.id, null)}
            style={{ ...btnSec(), padding: '2px 7px', fontSize: 9 }}
            title="Drop the override and fall back to the catalog-default block kind"
          >
            RESET
          </button>
        </div>
      )}

      {/* Header chip: glyph · kind · role */}
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          background: catTint.fill,
          border: `1px solid ${catTint.stroke}`,
          borderLeft: `4px solid ${catTint.stroke}`,
          borderRadius: 6,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            display: 'grid',
            placeItems: 'center',
            background: catTint.stroke,
            color: SW_COLORS.paper,
            borderRadius: 4,
          }}
        >
          <block.spec.Icon size={16} color={contrastInk(catTint.stroke)} title={block.spec.label} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: '0.08em',
              color: SW_COLORS.ink,
            }}
          >
            {block.spec.label.toUpperCase()}
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                fontWeight: 700,
                color: block.overridden ? SW_COLORS.alarm : SW_COLORS.muted,
              }}
            >
              {block.overridden ? 'OVERRIDE' : 'AUTO'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: SW_COLORS.muted, fontWeight: 700 }}>
            {role}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.4 }}>
        {block.spec.blurb}
      </div>

      {/* Kind picker */}
      <div style={{ height: 8 }} />
      <label style={fieldLabel}>Kind</label>
      <HudSelect
        value={block.overridden ? block.kind : 'auto'}
        onChange={(v) => onPickKind(v as PmlBlockKind | 'auto')}
        variant="light"
        size="sm"
        mono
        width="100%"
        options={[
          {
            value: 'auto',
            label: `Auto · ${PML_BLOCK_LIBRARY[defaultKind].label} (catalog default)`,
            leading: (() => {
              const AutoIcon = PML_BLOCK_LIBRARY[defaultKind].Icon;
              return <AutoIcon size={14} color={SW_COLORS.muted} />;
            })(),
          },
          ...SELECTABLE_BLOCK_KINDS.map((k) => {
            const spec = PML_BLOCK_LIBRARY[k];
            const tint = PML_CATEGORY_TINT[spec.category] ?? { stroke: SW_COLORS.ink, fill: SW_COLORS.paper };
            return {
              value: k,
              label: spec.label,
              leading: <spec.Icon size={14} color={tint.stroke} />,
              tag: k === defaultKind ? 'DEFAULT' : undefined,
            };
          }),
        ]}
      />

      {/* Port summary */}
      <div style={{ height: 10 }} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        <PortList side="in"  label="Inputs"  ports={block.inputs}  tint={catTint} />
        <PortList side="out" label="Outputs" ports={block.outputs} tint={catTint} />
      </div>

      {/* Authored sim parameters — only shown when the block kind has any. */}
      <BlockParamFields ws={ws} block={block} onSetBlock={onSetBlock} />

      {block.spec.usesResources && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 8px',
            background: SW_COLORS.paperDeep,
            border: `1px dashed ${SW_COLORS.line}`,
            borderRadius: 4,
            fontSize: 11,
            color: SW_COLORS.muted,
          }}
        >
          ⚡ Draws on a ResourcePool · Seize → Delay → Release
        </div>
      )}
    </div>
  );
}

/** Per-kind authored simulation parameters editor. Renders the fields
 *  declared in `PARAM_FIELDS_BY_KIND` for the block's resolved kind.
 *  Inputs are seeded from the live resolved value (override → catalog →
 *  default) so the user can see what the engine will use even when no
 *  explicit override has been set. */
function BlockParamFields({
  ws,
  block,
  onSetBlock,
}: {
  ws: Workstation;
  block: PmlBlock;
  onSetBlock: (wsId: string, block: PmlBlockOverride | null) => void;
}) {
  const fields = PARAM_FIELDS_BY_KIND[block.kind];
  if (!fields || fields.length === 0) return null;

  const resolved = getBlockParams(ws);
  const authored = ws.block?.params ?? {};

  /** Persist a single param edit. Always materialises a `block` override
   *  (with the current kind) so simply setting a param implicitly opts
   *  into the override — the user doesn't need to flip the kind picker
   *  first. */
  const setParam = (id: ParamFieldSpec['id'], rawValue: number) => {
    // Pass% is shown as 0..100 in the UI but stored as 0..1.
    const stored = id === 'passProb' ? rawValue / 100 : rawValue;
    const nextParams: PmlBlockParams = { ...authored, [id]: stored };
    onSetBlock(ws.id, {
      kind: block.kind,
      inputs: ws.block?.inputs,
      outputs: ws.block?.outputs,
      params: nextParams,
    });
  };

  const clearParam = (id: ParamFieldSpec['id']) => {
    const next: PmlBlockParams = { ...authored };
    delete next[id];
    const hasAny = Object.keys(next).length > 0;
    // If no overrides remain AND the kind matches the catalog default,
    // drop the whole block override so the workstation goes back to AUTO.
    const isAuto = !block.overridden && !hasAny;
    onSetBlock(
      ws.id,
      isAuto
        ? null
        : {
            kind: block.kind,
            inputs: ws.block?.inputs,
            outputs: ws.block?.outputs,
            params: hasAny ? next : undefined,
          },
    );
  };

  return (
    <>
      <div style={{ height: 10 }} />
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 800,
          color: SW_COLORS.muted,
          letterSpacing: '0.12em',
          marginBottom: 4,
        }}
      >
        BLOCK PARAMETERS
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {fields.map((f) => (
          <BlockParamRow
            key={f.id}
            field={f}
            value={f.resolveDefault(resolved)}
            isAuthored={authored[f.id] !== undefined}
            onSet={(v) => setParam(f.id, v)}
            onClear={() => clearParam(f.id)}
          />
        ))}
      </div>
      <ArrivalProcessField ws={ws} block={block} onSetBlock={onSetBlock} />
      <KendallReadout ws={ws} kind={block.kind} />
    </>
  );
}

/**
 * Arrival process for a Source — the `a` field of Kendall–Lee.
 *
 * Every station's classification opens with M, which asserts Poisson arrivals.
 * The engine only delivers that when the Source carries an exponential
 * inter-arrival distribution; without one it emits on a fixed 60/λ interval,
 * which is a D process, and the closed-form numbers are then solved for a model
 * the run is not. The pre-flight check warns about it — this is the control that
 * lets the user act on the warning.
 */
function ArrivalProcessField({
  ws,
  block,
  onSetBlock,
}: {
  ws: Workstation;
  block: PmlBlock;
  onSetBlock: (wsId: string, block: PmlBlockOverride | null) => void;
}) {
  if (block.kind !== 'Source') return null;
  const params = getBlockParams(ws);
  const ratePerHr = Math.max(1e-6, params.sourceRatePerHr);
  const poisson = params.arrivalDist?.kind === 'exp';

  const setArrival = (next: 'M' | 'D') => {
    onSetBlock(ws.id, {
      kind: block.kind,
      inputs: ws.block?.inputs,
      outputs: ws.block?.outputs,
      params: {
        ...(ws.block?.params ?? {}),
        // Exponential gaps at mean 60/λ minutes IS the Poisson process; the
        // deterministic path is the engine's own fallback, so D clears it.
        arrivalDist: next === 'M' ? { kind: 'exp', mean: 60 / ratePerHr } : undefined,
      },
    });
  };

  return (
    <>
      <div style={{ height: 10 }} />
      {/* No symbol here: λ is the RATE, shown on the field above. This field
          sets the `a` slot of a/b/c:d/e — the shape of the gaps, not the rate —
          and repeating λ on both would read as two controls for one quantity. */}
      <label style={fieldLabel}>Arrival process · Kendall a</label>
      <HudSelect
        value={poisson ? 'M' : 'D'}
        onChange={(v) => setArrival(v as 'M' | 'D')}
        variant="light"
        size="sm"
        mono
        width="100%"
        options={[
          { value: 'M', label: 'Poisson · exponential gaps (M)', tag: 'TEXTBOOK' },
          { value: 'D', label: 'Fixed interval · every 60/λ min (D)' },
        ]}
      />
      <div style={{ marginTop: 4, fontSize: 10, color: SW_COLORS.muted, lineHeight: 1.4 }}>
        {poisson
          ? `Bundles arrive randomly at a mean ${ratePerHr.toFixed(0)}/hr — the M the queueing classification assumes.`
          : `Bundles arrive exactly every ${(60 / ratePerHr).toFixed(2)} min. That is a D arrival process, so the M in the classification is not accurate.`}
      </div>
    </>
  );
}

/**
 * The station's Kendall–Lee classification, live, under the c and N fields.
 *
 * The point is to make the queueing model tangible while authoring rather than
 * something the user only meets on an analysis page: type 2 into Servers and
 * watch `M/M/1 : ∞/FCFS` become `M/M/2 : ∞/FCFS`; cap the buffer at 8 and watch
 * it become `M/M/2 : 8/FCFS`. Resolved through the same `serversFor` /
 * `systemCapacityFor` the engine uses, so the label can't disagree with what
 * will actually be simulated.
 */
function KendallReadout({ ws, kind }: { ws: Workstation; kind: PmlBlockKind }) {
  if (kind !== 'Service' && kind !== 'Queue') return null;
  const servers = kind === 'Queue' ? 1 : serversFor(ws);
  const capacity = systemCapacityFor(ws);
  const smv = getBlockParams(ws).cycleS / 60;
  const notation = classify(defaultDist(Math.max(0.001, smv)), servers, capacity, 'FCFS');
  const finite = Number.isFinite(capacity);
  return (
    <div
      style={{
        marginTop: 8,
        padding: '6px 8px',
        borderRadius: SW_RADIUS.sm,
        border: `1px solid ${alpha(SW_COLORS.bobbin, 0.35)}`,
        background: alpha(SW_COLORS.bobbin, 0.08),
      }}
    >
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 800,
          color: SW_COLORS.muted,
          letterSpacing: '0.12em',
        }}
      >
        QUEUEING MODEL
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 13,
          fontWeight: 800,
          color: SW_COLORS.bobbin,
          marginTop: 2,
        }}
      >
        {notation.label}
      </div>
      <div style={{ fontSize: 10, color: SW_COLORS.muted, marginTop: 2 }}>
        {finite
          ? `Finite buffer — arrivals that find ${capacity} bundles here are turned away and counted as balks.`
          : 'Unbounded buffer — the queue can grow without limit if ρ reaches 1.'}
      </div>
    </div>
  );
}

/** Compact list of named ports — one chip per port. Used by BlockSection
 *  for the Inputs / Outputs preview. */
function PortList({
  side,
  label,
  ports,
  tint,
}: {
  side: 'in' | 'out';
  label: string;
  ports: PmlPort[];
  tint: { fill: string; stroke: string };
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 800,
          color: SW_COLORS.muted,
          letterSpacing: '0.12em',
          marginBottom: 4,
        }}
      >
        {label.toUpperCase()} · {ports.length}
      </div>
      {ports.length === 0 ? (
        <div
          style={{
            padding: '6px 8px',
            border: `1px dashed ${SW_COLORS.line}`,
            borderRadius: 4,
            fontSize: 10,
            color: SW_COLORS.muted,
            fontStyle: 'italic',
          }}
        >
          none
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ports.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                background: SW_COLORS.paper,
                border: `1px solid ${SW_COLORS.line}`,
                borderRadius: 3,
                fontSize: 11,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: side === 'in' ? SW_COLORS.paper : tint.stroke,
                  border: `2px solid ${tint.stroke}`,
                  flexShrink: 0,
                }}
              />
              <strong style={{ color: SW_COLORS.ink, fontFamily: SW_FONTS.mono }}>{p.label}</strong>
              {p.kind === 'resource' && (
                <span style={{ marginLeft: 'auto', fontSize: 9, color: SW_COLORS.muted, fontWeight: 700 }}>
                  RES
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Flow-connections panel — lists every connector touching the selected
 *  workstation (incoming + outgoing) and lets the user delete them inline. */
function FlowSection({
  ws,
  twin,
  onRemoveConnector,
}: {
  ws: Workstation;
  twin: ReturnType<typeof selectActiveTwin>;
  onRemoveConnector: (id: string) => void;
}) {
  const wsById = new Map(twin.workstations.map((w) => [w.id, w] as const));
  const all = twin.connectors ?? [];
  const incoming = all.filter((c) => c.toWsId === ws.id);
  const outgoing = all.filter((c) => c.fromWsId === ws.id);

  /** Render the port label for an endpoint. Falls back to the block's
   *  first port when the connector doesn't pin a specific port. */
  const portLabelFor = (
    targetWsId: string,
    portId: string | undefined,
    side: 'in' | 'out',
  ): string => {
    const target = wsById.get(targetWsId);
    if (!target) return portId ?? '?';
    const block = getBlockSpec(target);
    const list = side === 'in' ? block.inputs : block.outputs;
    if (portId) {
      return list.find((p) => p.id === portId)?.label ?? portId;
    }
    return list[0]?.label ?? (side === 'in' ? 'in' : 'out');
  };

  const row = (c: Connector, mode: 'in' | 'out') => {
    const otherId = mode === 'in' ? c.fromWsId : c.toWsId;
    const other = wsById.get(otherId);
    // For an INCOMING wire on `ws`: we are the target → our port is the
    // INPUT side, peer's port is the OUTPUT side. And vice-versa.
    const myPort =
      mode === 'in'
        ? portLabelFor(ws.id, c.toPort, 'in')
        : portLabelFor(ws.id, c.fromPort, 'out');
    const otherPort =
      mode === 'in'
        ? portLabelFor(otherId, c.fromPort, 'out')
        : portLabelFor(otherId, c.toPort, 'in');
    return (
      <div
        key={c.id}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 7px',
          marginTop: 4,
          background: SW_COLORS.paper,
          border: `1px solid ${SW_COLORS.line}`,
          borderLeft: `3px solid ${CONNECTOR_HEX[c.kind]}`,
          borderRadius: 4,
          fontSize: 11,
        }}
      >
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            fontWeight: 800,
            color: CONNECTOR_HEX[c.kind],
            letterSpacing: '0.06em',
            minWidth: 56,
          }}
        >
          {mode === 'in' ? '←' : '→'} {CONNECTOR_LABEL[c.kind]}
        </span>
        <span
          style={{
            flex: 1,
            color: SW_COLORS.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={`${mode === 'in' ? otherPort : myPort} → ${mode === 'in' ? myPort : otherPort}\n${other?.name ?? otherId}`}
        >
          <span
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 9,
              fontWeight: 800,
              color: SW_COLORS.muted,
              marginRight: 6,
            }}
          >
            {mode === 'in' ? `${otherPort}→${myPort}` : `${myPort}→${otherPort}`}
          </span>
          {other?.name ?? '— deleted'}
        </span>
        <button
          onClick={() => onRemoveConnector(c.id)}
          style={{
            ...btnSec(),
            padding: '2px 6px',
            fontSize: 9,
            color: SW_COLORS.alarm,
          }}
          title="Remove this connector"
        >
          ✕
        </button>
      </div>
    );
  };

  return (
    <div
      style={{
        padding: 10,
        background: SW_COLORS.paperDeep,
        borderRadius: 6,
        border: `1px solid ${SW_COLORS.line}`,
      }}
    >
      {incoming.length === 0 && outgoing.length === 0 && (
        <div style={{ fontSize: 11, color: SW_COLORS.muted, marginTop: 4 }}>
          No connectors yet — turn on{' '}
          <strong style={{ color: SW_COLORS.brand }}>➜ CONNECT</strong> in the
          toolbar, then click this station and another.
        </div>
      )}
      {incoming.length > 0 && (
        <>
          <div style={{ ...fieldLabel, marginTop: 6 }}>Incoming · {incoming.length}</div>
          {incoming.map((c) => row(c, 'in'))}
        </>
      )}
      {outgoing.length > 0 && (
        <>
          <div style={{ ...fieldLabel, marginTop: 8 }}>Outgoing · {outgoing.length}</div>
          {outgoing.map((c) => row(c, 'out'))}
        </>
      )}
    </div>
  );
}

/* ── Inspector disclosure ────────────────────────────────────────────
 * Open/closed state is a per-group preference (not per-entity), stored
 * as one JSON record so it survives reloads — same localStorage pattern
 * as builder.paletteW / builder.inspectorW above. */
const INSPECTOR_GROUPS_KEY = 'builder.inspectorGroups.v1';

function readGroupPrefs(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(INSPECTOR_GROUPS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeGroupPref(id: string, open: boolean, defaultOpen: boolean) {
  try {
    const prefs = readGroupPrefs();
    if (open === defaultOpen) delete prefs[id];
    else prefs[id] = open;
    if (Object.keys(prefs).length === 0) localStorage.removeItem(INSPECTOR_GROUPS_KEY);
    else localStorage.setItem(INSPECTOR_GROUPS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode) — state stays session-local */
  }
}

function useInspectorGroupPref(id: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => readGroupPrefs()[id] ?? defaultOpen);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      writeGroupPref(id, next, defaultOpen);
      return next;
    });
  }, [id, defaultOpen]);
  return [open, toggle];
}

/** Collapsible parameter group for the Inspector. Progressive disclosure:
 *  identity-level groups default open, secondary detail defaults closed.
 *  `forceOpen` pins the group open (e.g. an overridden process block must
 *  stay visible) and wins over a persisted closed preference. */
function InspectorGroup({
  id,
  title,
  defaultOpen,
  right,
  forceOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen: boolean;
  right?: ReactNode;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useInspectorGroupPref(id, defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <div style={{ marginTop: 12 }}>
      <div
        role="button"
        aria-expanded={isOpen}
        onClick={() => {
          if (!forceOpen) toggle();
        }}
        title={forceOpen ? 'Pinned open while this station carries an override' : isOpen ? 'Collapse' : 'Expand'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: forceOpen ? 'default' : 'pointer',
          userSelect: 'none',
        }}
      >
        <Chevron open={isOpen} />
        <span style={{ ...sectionLabel, marginBottom: 0, flex: 1 }}>{title}</span>
        {right && <span onClick={(e) => e.stopPropagation()}>{right}</span>}
      </div>
      {isOpen && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

/** One lens's section in the Inspector. The ACTIVE lens is always open —
 *  the lens toggle at the top of the panel is the primary disclosure
 *  control, so its section never shows a competing chevron. Inactive
 *  lens sections collapse (default closed) but stay user-expandable. */
function LensSection({ id, title, active, children }: { id: string; title: string; active: boolean; children: ReactNode }) {
  const [open, toggle] = useInspectorGroupPref(id, false);
  const isOpen = active || open;
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        background: active ? SW_COLORS.brandLite + '60' : SW_COLORS.paperDeep,
        borderRadius: 6,
        border: `1px solid ${active ? SW_COLORS.brand : SW_COLORS.line}`,
      }}
    >
      <div
        role={active ? undefined : 'button'}
        aria-expanded={active ? undefined : isOpen}
        onClick={() => {
          if (!active) toggle();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: active ? 'default' : 'pointer',
          userSelect: 'none',
          marginBottom: isOpen ? 8 : 0,
        }}
      >
        {!active && (
          <Chevron open={isOpen} />
        )}
        <span style={{ ...sectionLabel, color: active ? SW_COLORS.brandDeep : SW_COLORS.muted, marginBottom: 0 }}>
          {title}
          {active && ' · active lens'}
        </span>
      </div>
      {isOpen && children}
    </div>
  );
}

function NumField({ label, value, onChange, step }: { label: ReactNode; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <label style={fieldLabel}>{label}</label>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        style={inputBase}
      />
    </div>
  );
}

function ObservedRow({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', color: SW_COLORS.muted }}>
      <span>{label}</span>
      <strong style={{ fontFamily: SW_FONTS.mono, color: SW_COLORS.ink }}>{value}</strong>
    </div>
  );
}

/** Small uppercase-mono chip for the inspector masthead — op code, machine
 *  code, line membership. Optional 8px square swatch for hue-keyed chips. */
function InspectorChip({
  children,
  bg,
  fg,
  edge,
  swatch,
}: {
  children: ReactNode;
  bg?: string;
  fg?: string;
  edge?: string;
  swatch?: string;
}) {
  return (
    <span
      style={{
        ...SW_TYPE.micro,
        fontSize: 10,
        letterSpacing: '0.1em',
        padding: '3px 7px',
        borderRadius: 4,
        background: bg ?? SW_COLORS.paperDeep,
        color: fg ?? SW_COLORS.muted,
        border: `1px solid ${edge ?? 'transparent'}`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {swatch && (
        <span style={{ width: 8, height: 8, borderRadius: 2, background: swatch, flex: 'none' }} />
      )}
      {children}
    </span>
  );
}

/** Stat tile for the inspector masthead — micro label, display value, quiet
 *  unit. Authoring facts only (bulletin SMV, staffing); sim results live in
 *  the Sim view. */
function InspectorStat({ label, value, unit, tone }: { label: ReactNode; value: string; unit?: string; tone?: string }) {
  return (
    <div
      style={{
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm + 2,
        background: SW_COLORS.paperDeep,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <span style={{ ...SW_TYPE.micro, fontSize: 10, letterSpacing: '0.14em', color: SW_COLORS.muted }}>
        {label}
      </span>
      <span style={{ ...SW_TYPE.displaySm, color: tone ?? SW_COLORS.ink }}>{value}</span>
      {unit && (
        <span style={{ ...SW_TYPE.numeric, fontWeight: 400, color: SW_COLORS.muted }}>{unit}</span>
      )}
    </div>
  );
}

// ============================================================================
// SMALL UI BITS
// ============================================================================

/** Quiet square button for the zoom HUD — transparent at rest, steel on
 *  hover, numeric glyph. The HUD slab supplies the border and ground. */

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        background: alpha(SW_COLORS.steel, 0.95),
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm + 2,
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
      }}
    >
      <span style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>{label}</span>
      <strong style={{ ...SW_TYPE.numeric, color: SW_COLORS.ink }}>{value}</strong>
    </div>
  );
}

/**
 * Bottom-right reference panel on the iso canvas. Explains the connector
 * kinds (flow / operator / material), the carrier letter badges painted at
 * a flow connector's midpoint (B/P/H/T), and the per-lens header pill that
 * floats above each workstation. The row matching the active lens is
 * highlighted; the other lens rows are dimmed so the legend doubles as
 * "here's what the other lenses would show".
 *
 * Swatches mirror CONNECTOR_HEX, the dash rules in flowStyleFor(), and
 * CARRIER_STYLE exactly so a line on the canvas matches the corresponding
 * legend row without translation. Pointer events are off so the panel
 * never steals clicks from the canvas underneath.
 */
function IsoLegend({ lens, canvasMode }: { lens: Lens; canvasMode: CanvasMode }) {
  const lensRows: { key: Lens; bg: string; label: string; meaning: string }[] = [
    { key: 'operations', bg: SW_COLORS.ink,       label: 'op-code', meaning: 'operation' },
    { key: 'resources',  bg: SW_COLORS.bobbin,    label: '☻ × N',   meaning: 'workers' },
    { key: 'kpis',       bg: SW_COLORS.brandDeep, label: 'NN%',     meaning: 'utilisation' },
  ];
  return (
    <CanvasLegend label={canvasMode === 'process' ? 'PROCESS' : canvasMode === 'iso' ? 'ISO' : '2D'}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          color: SW_COLORS.muted,
          letterSpacing: '0.03em',
        }}
      >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <LegendLine color={SW_COLORS.brand}  width={2.4} label="flow" />
        <LegendLine color={SW_COLORS.bobbin} width={1.8} dash="6 4" label="operator" />
        <LegendLine color={SW_COLORS.thread} width={1.8} dash="6 4" label="material" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <CarrierChip letter="B" color={SW_COLORS.brand} width={2.6}            meaning="bundle" />
        <CarrierChip letter="P" color={SW_COLORS.steel} width={1.6}            meaning="piece" />
        <CarrierChip letter="H" color={SW_COLORS.brand} width={2.0} dash="1 4" meaning="hanger" />
        <CarrierChip letter="T" color={SW_COLORS.ink}   width={2.0} dash="8 4" meaning="takt" />
      </div>

      {/* Station-header pill — shows ONLY the overlay the active lens paints
       *  above each station sprite (op-code · worker count · utilisation), so
       *  the legend describes what's actually on the floor instead of listing
       *  all three at once. Floor views (2D · ISO) only: the PROCESS canvas
       *  draws no per-station pills, so this row is omitted there. */}
      {canvasMode !== 'process' && (() => {
        const row = lensRows.find((r) => r.key === lens)!;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                background: row.bg,
                color: SW_COLORS.paper,
                fontFamily: SW_FONTS.mono,
                fontSize: 8,
                fontWeight: 800,
                padding: '2px 6px',
                borderRadius: 3,
                letterSpacing: '0.04em',
              }}
            >
              {row.label}
            </span>
            <span style={{ color: SW_COLORS.muted, fontSize: 9 }}>
              {`station header · ${row.meaning}`}
            </span>
          </div>
        );
      })()}
      </div>
    </CanvasLegend>
  );
}

function LegendLine({
  color,
  width,
  dash,
  label,
}: {
  color: string;
  width: number;
  dash?: string;
  label: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <svg width={22} height={6} aria-hidden>
        <line
          x1={1}
          y1={3}
          x2={21}
          y2={3}
          stroke={color}
          strokeWidth={width}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}

function CarrierChip({
  letter,
  color,
  width,
  dash,
  meaning,
}: {
  letter: string;
  color: string;
  width: number;
  dash?: string;
  meaning: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <svg width={30} height={14} aria-hidden>
        <line
          x1={1}
          y1={7}
          x2={29}
          y2={7}
          stroke={color}
          strokeWidth={width}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
        <circle cx={15} cy={7} r={6} fill={SW_COLORS.paper} stroke={color} strokeWidth={1} />
        <text
          x={15}
          y={10}
          textAnchor="middle"
          fontFamily={SW_FONTS.mono}
          fontSize={8}
          fontWeight={800}
          fill={color}
        >
          {letter}
        </text>
      </svg>
      {meaning}
    </span>
  );
}

const CONTROL_ROWS: { keys: string; desc: string }[] = [
  { keys: 'DRAG',     desc: 'Move workstation' },
  { keys: 'R',        desc: 'Rotate' },
  { keys: 'Del',      desc: 'Remove' },
  { keys: '⌘D',       desc: 'Duplicate' },
  { keys: 'V',        desc: 'Select tool · marquee' },
  { keys: '⇧+CLICK',  desc: 'Add / remove from selection' },
  { keys: '⌘A',       desc: 'Select all stations' },
  { keys: '⌘C',       desc: 'Copy selection' },
  { keys: '⌘X',       desc: 'Cut selection' },
  { keys: '⌘V',       desc: 'Paste at cursor' },
  { keys: '⌘Z',       desc: 'Undo · ⇧⌘Z redo' },
  { keys: 'Esc',      desc: 'Cancel · clear selection' },
  { keys: 'SCROLL',   desc: 'Zoom' },
  { keys: 'SPACE',    desc: 'Pan' },
  { keys: '⌘0',       desc: 'Reset view' },
  { keys: '[  ·  ]',  desc: 'Collapse palette · inspector' },
];

function ControlsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 6,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          color: SW_COLORS.muted,
          letterSpacing: '0.12em',
          padding: '6px 10px',
          background: SW_COLORS.paper + 'cc',
          border: `1px solid ${open ? SW_COLORS.brand + '99' : SW_COLORS.line}`,
          borderRadius: 6,
          cursor: 'pointer',
          textTransform: 'uppercase',
          transition: 'border-color 120ms ease',
        }}
      >
        <span>Controls</span>
        <Caret open={open} />
      </button>
      <div
        role="listbox"
        style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          right: 0,
          // Wide enough that every description fits on a single line and the
          // key column doesn't squeeze them. The two-column grid below relies
          // on this so chips of different widths can't shove descriptions
          // around the way the old space-between flex layout did.
          minWidth: 280,
          background: SW_COLORS.steel,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: open ? `1px solid ${SW_COLORS.brand}66` : '1px solid transparent',
          borderRadius: 6,
          boxShadow: open ? SW_SHADOWS.hud : 'none',
          padding: open ? 4 : 0,
          maxHeight: open ? 480 : 0,
          overflow: 'hidden',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease',
        }}
      >
        {CONTROL_ROWS.map((row) => (
          <div
            key={row.keys}
            role="option"
            aria-selected={false}
            style={{
              // Fixed-width key column · flexible description column. Keeps
              // every chip in the same lane (no shifting) and every label
              // hanging from the same left edge regardless of chip width.
              display: 'grid',
              gridTemplateColumns: '92px 1fr',
              alignItems: 'center',
              gap: 12,
              padding: '6px 8px',
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              color: SW_COLORS.ink,
              borderRadius: 4,
            }}
          >
            <span
              style={{
                fontWeight: 800,
                color: SW_COLORS.ink,
                background: `${SW_COLORS.ink}0F`,
                border: `1px solid ${SW_COLORS.line}`,
                borderRadius: 4,
                padding: '2px 6px',
                letterSpacing: '0.04em',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                justifySelf: 'stretch',
              }}
            >
              {row.keys}
            </span>
            <span
              style={{
                color: SW_COLORS.muted,
                fontWeight: 600,
                letterSpacing: '0.02em',
                textAlign: 'left',
                whiteSpace: 'nowrap',
              }}
            >
              {row.desc}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
