/**
 * Twin store — owns the canonical Twin and its scenario forks.
 *
 * This store is intentionally PARALLEL to the legacy `project` store while
 * the rest of the app is wired over to the twin model. Keeping it isolated
 * means existing pages (FactoryTwin, IsoBuilder, LiveSim, …) keep working
 * against the old `factory: { floors, lines }` shape until each one is
 * migrated.
 *
 * Persistence:
 *   localStorage key `stitchworks.twin.v1` — separate from the project
 *   store so a stale legacy snapshot can't poison the new model.
 *
 * Mental model:
 *   • There is exactly one canonical Twin per project. It's what the user
 *     authors in Factory Builder.
 *   • A Scenario is a fork of the canonical twin: a deep clone with its
 *     own ids and its own run history. Scenarios diverge freely; the
 *     canonical twin does NOT propagate edits into existing forks.
 *   • The "active" twin (canonical or scenario) is what the Builder + the
 *     Simulation tab read from. Switching scenarios is the editing-context
 *     switch — no page-level state needed.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { indexedDbStorage } from './storage/indexedDbStorage';

import {
  type Twin,
  type Scenario,
  type SimRun,
  type Workstation,
  type EntityColorKey,
  type Vec2,
  type Rotation,
  type KpiObservedAttrs,
  type Connector,
  type ConnectorKind,
  type SewingLine,
  type ProductionSystemKey,
  type Order,
  type Assignment,
  type Operator,
  newAssignmentId,
  newOperatorId,
  emptyTwin,
  forkTwin,
  newLineId,
  newWorkstationId,
  newScenarioId,
  newTwinId,
  newRunId,
  newConnectorId,
  makeWorkstation,
  normalizeTwin,
  validateTwin,
} from '../domain/twin';
import type { PmlBlockOverride, PmlBlockParams } from '../domain/pml';
import { getBlockSpec } from '../domain/pml';

/**
 * v6 — the queueing pivot changed what `Workstation.kpiObserved.utilizationPct`
 * MEANS. It used to be `busyMin / (departmentPoolCapacity · duration)`, which
 * on a 20-operator line reported ~4 % for a station busy 83 % of the shift.
 * It is now the station's own ρ̂. Persisted values written under the old
 * definition are off by roughly the pool size, so the migration clears them
 * rather than letting a stale 4 % sit next to a fresh 83 % in the Inspector.
 * They are re-derived by the next run.
 */
export const TWIN_STORE_SCHEMA_VERSION = 7 as const;

/** Maximum number of pre-mutation snapshots kept in the undo stack.
 *  Each snapshot is a structural clone of the full twin tree, so the cap
 *  is a deliberate memory/UX tradeoff — 100 is plenty for an authoring
 *  session and keeps localStorage out of it (history is in-memory only). */
const MAX_HISTORY = 100;

/** Immutable snapshot of the editable twin universe. Action references
 *  are stored on the live state object — they don't belong in history. */
interface TwinSnapshot {
  canonical: Twin;
  scenarios: Scenario[];
  activeScenarioId: string | null;
}

// ============================================================================
// STATE SHAPE
// ============================================================================

export interface TwinState {
  schemaVersion: typeof TWIN_STORE_SCHEMA_VERSION;
  /** The master twin authored in Factory Builder. */
  canonical: Twin;
  /** Scenario forks of the canonical twin. */
  scenarios: Scenario[];
  /** Which twin is currently being viewed/edited.
   *  null = canonical; otherwise a scenario id. */
  activeScenarioId: string | null;
  /** Pre-mutation snapshots, oldest → newest. `undo` pops the tail. */
  past: TwinSnapshot[];
  /** Snapshots popped by `undo`, newest → oldest. `redo` pops the tail. */
  future: TwinSnapshot[];

  /** Restore the previous twin snapshot. Pushes the current state onto
   *  `future` so the move is reversible via `redo`. No-op when the history
   *  is empty. */
  undo: () => void;
  /** Reverse the most recent `undo`. No-op when nothing has been undone. */
  redo: () => void;

  // ── Twin-level mutators (operate on the *active* twin) ────────────────────
  renameActive: (name: string) => void;
  setActiveNotes: (notes: string) => void;
  /** Re-stamps `modifiedAt` on the active twin without changing any other
   *  field. Used by the Builder's explicit "Save" button so the user gets
   *  a clear commit moment even though edits auto-persist. Returns the
   *  new ISO timestamp. */
  touchActive: () => string;

  // ── Sewing-Line CRUD ─────────────────────────────────────────────────────
  /** Create a sewing line. Returns the new line's id. */
  addLine: (input: Omit<SewingLine, 'id'>) => string;
  /** Patch fields on a line. */
  updateLine: (id: string, patch: Partial<Omit<SewingLine, 'id' | 'deptId'>>) => void;
  /** Remove a line. Workstations that referenced it have their `lineId`
   *  cleared but stay placed on the canvas. */
  removeLine: (id: string) => void;
  /** Bulk-assign / unassign workstations to a line. Pass `null` to clear. */
  setLineForWorkstations: (wsIds: string[], lineId: string | null) => void;

  // ── Operator / Assignment mutations ─────────────────────────────────────
  /** Merge the primary operators of two stations into a single shared
   *  operator. The operator currently on `keepWsId` survives; the
   *  operator on `dropWsId` is removed (along with all its assignments).
   *  The keep operator's existing assignments + the new wsId assignment
   *  are all rebalanced to `1 / N` shareFrac so the user can cascade
   *  ("share station 4 with 5", then "share 5 with 6" — operator now
   *  covers three stations at 33 % each). No-op when either station
   *  lacks a primary assignment or when the two stations already share
   *  the same operator. */
  shareOperatorsBetweenStations: (keepWsId: string, dropWsId: string) => void;
  /** Inverse of {@link shareOperatorsBetweenStations}: peel `wsId` off
   *  the shared operator that currently covers it, and graft a freshly
   *  minted primary operator onto it at `shareFrac: 1`. The remaining
   *  stations the shared operator covered get their shareFrac
   *  rebalanced to `1 / (N - 1)`. No-op when the station's primary
   *  isn't shared. */
  unshareWorkstation: (wsId: string) => void;

  // ── Workstation CRUD ─────────────────────────────────────────────────────
  addWorkstation: (input: {
    /** Optional line membership. The floor is free space, so a station
     *  dropped outside any line simply has no owner. */
    lineId?: string;
    catalogId: string;
    position: Vec2;
    rotation?: Rotation;
    name?: string;
    /** When set and `name` is not provided, the new workstation is auto-named
     *  `${presetLabel} N` where N is the next free integer suffix in the
     *  active twin. Drives the apparel-presets palette path so dropping three
     *  Bundle sources yields "Bundle source 1 / 2 / 3" out of the box. */
    presetLabel?: string;
    /** Authored PML block params stamped onto the new workstation. Used by
     *  the apparel presets to apply defaults at drop time (e.g. ratePerHr:30
     *  for Bundle source). Ignored when the catalogId doesn't resolve to a
     *  PML primitive. */
    blockParams?: Partial<PmlBlockParams>;
  }) => string;
  updateWorkstation: (id: string, patch: Partial<Omit<Workstation, 'id'>>) => void;
  removeWorkstation: (id: string) => void;
  /** Move a workstation to a new world position. */
  moveWorkstation: (id: string, position: Vec2) => void;
  /** Bulk-write freeform PROCESS-canvas positions (block.processPos) in a
   *  single undo step. Used by the process view for drag-commit and the
   *  "Auto-arrange" action. Ensures a block override exists (pinning the
   *  catalog-inferred kind) so the position has a home. */
  setProcessPositions: (entries: { wsId: string; pos: Vec2 }[]) => void;
  /** Rotate a workstation in 90° steps. dir = +1 turns CW, -1 turns CCW. */
  rotateWorkstation: (id: string, dir: 1 | -1) => void;
  /** Clone a workstation, offsetting the copy slightly. Returns the new id
   *  (or null if the source id doesn't resolve in the active twin). */
  duplicateWorkstation: (id: string) => string | null;
  /** Insert a cluster of workstation snapshots into the active twin with
   *  fresh ids and the per-snapshot `deptId` / `position` already resolved.
   *  Returned `idMap` maps each input snapshot's original id to its newly
   *  minted id, so callers can re-route copied connectors. Snapshots whose
   *  resolved `deptId` no longer exists in the active twin are skipped. */
  pasteWorkstations: (input: {
    snapshots: Array<Workstation & { _srcId: string }>;
    connectors: Array<Omit<Connector, 'id'>>;
  }) => { idMap: Record<string, string>; newWsIds: string[] };

  // ── Connector CRUD ───────────────────────────────────────────────────────
  /** Create a directed connector between two workstations. Returns the
   *  created id, or null if the source/target ids don't resolve in the
   *  active twin or if from === to. `fromPort` / `toPort` bind the wire
   *  to specific named PML ports — omit them to default to the first
   *  output / first input on the respective block. */
  addConnector: (input: {
    kind: ConnectorKind;
    fromWsId: string;
    toWsId: string;
    label?: string;
    fromPort?: string;
    toPort?: string;
  }) => string | null;
  /** Patch fields on a connector. */
  updateConnector: (id: string, patch: Partial<Omit<Connector, 'id'>>) => void;
  /** Remove a connector by id. */
  removeConnector: (id: string) => void;

  // ── Order CRUD (P4) ──────────────────────────────────────────────────────
  /** Append an Order to the active twin's `orders[]`. When `lineId` is
   *  given AND that line exists, also push the order id onto the line's
   *  `orderSequence` so the engine emits it. When `lineId` is missing the
   *  order is stored unassigned — the IE can wire it up later by editing
   *  `assignedLineId` / `orderSequence`. Returns the persisted order id. */
  addOrderToActiveTwin: (
    order: Omit<Order, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
    lineId?: string,
  ) => string;

  // ── Lens-attribute writes (sugar over updateWorkstation) ─────────────────
  setOperation: (wsId: string, patch: Partial<Workstation['operation']>) => void;
  setResources: (wsId: string, patch: Partial<Workstation['resources']>) => void;
  setKpiTargets: (wsId: string, patch: Partial<Workstation['kpiTargets']>) => void;
  /** Called by the simulation engine after a run; mirrors per-station
   *  observed values onto the twin for fast lens rendering. */
  setKpiObserved: (wsId: string, observed: KpiObservedAttrs | undefined) => void;
  /** Set or clear the workstation's PML block override. Pass `null` to
   *  drop the override and fall back to the catalog-default block kind. */
  setBlock: (wsId: string, block: PmlBlockOverride | null) => void;

  // ── Scenario forking ─────────────────────────────────────────────────────
  /** Fork the canonical twin into a new scenario, optionally switching to
   *  it. Returns the created scenario id. */
  createScenarioFromCanonical: (input: {
    name: string;
    notes?: string;
    activate?: boolean;
  }) => string;
  /** Fork an *existing* scenario (canonical → scenarioA → scenarioA') —
   *  useful for "what if I tweak this scenario further" branches. */
  forkScenario: (
    fromScenarioId: string,
    input: { name: string; notes?: string; activate?: boolean },
  ) => string | null;
  /** Push a fully-built twin as a new scenario without touching the canonical.
   *  Used by the Orders / Simulation "Build / Edit in Builder" buttons to
   *  open a side-by-side blank draft (seeded with a single line) in a new tab
   *  while leaving the originating tab's view untouched. The new scenario is
   *  NOT activated by default — set activate=true to switch the active twin. */
  createScenarioFromTwin: (input: {
    name: string;
    notes?: string;
    twin: Twin;
    activate?: boolean;
  }) => string;
  renameScenario: (id: string, name: string) => void;
  deleteScenario: (id: string) => void;
  setActiveScenario: (id: string | null) => void;
  /** Promote a scenario into the canonical twin (replaces canonical with a
   *  copy of the scenario's twin, kept as canonical=true). The previous
   *  canonical is discarded — caller should confirm first. */
  promoteScenarioToCanonical: (id: string) => void;

  // ── Run history ──────────────────────────────────────────────────────────
  recordRun: (
    scenarioId: string | null,
    run: Omit<SimRun, 'id' | 'scenarioId'>,
  ) => SimRun;
  clearRunsFor: (scenarioId: string) => void;

  // ── Project-level actions ────────────────────────────────────────────────
  /** Replace canonical with a fresh empty twin and drop all scenarios.
   *  Caller should confirm. */
  resetTwin: () => void;
  /** Replace canonical with a known good twin (used by importers + the
   *  legacy migration). Drops scenarios. Validates the input first. */
  loadCanonical: (twin: Twin) => { ok: true } | { ok: false; reason: string };
  /** Snapshot the whole twin store for export to `.swproj`. */
  exportTwin: () => {
    schemaVersion: typeof TWIN_STORE_SCHEMA_VERSION;
    canonical: Twin;
    scenarios: Scenario[];
    activeScenarioId: string | null;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Capture the current twin tree as an undo snapshot — strips action
 *  references so only data lands in history. */
function snapshotOf(s: TwinState): TwinSnapshot {
  return {
    canonical: s.canonical,
    scenarios: s.scenarios,
    activeScenarioId: s.activeScenarioId,
  };
}

/** Apply a pure update to the active twin (canonical or scenario fork)
 *  *without* touching the undo history. Used by sim-side writes that
 *  shouldn't pile onto the editor's undo stack (e.g. `setKpiObserved`). */
function applyActive<S extends TwinState>(s: S, fn: (twin: Twin) => Twin): S {
  const now = new Date().toISOString();
  if (s.activeScenarioId === null) {
    const next = fn(s.canonical);
    return { ...s, canonical: { ...next, modifiedAt: now } };
  }
  const scenarios = s.scenarios.map((scn) =>
    scn.id === s.activeScenarioId
      ? { ...scn, twin: { ...fn(scn.twin), modifiedAt: now }, modifiedAt: now }
      : scn,
  );
  return { ...s, scenarios };
}

/** Update the currently-active twin (canonical or scenario fork) via a
 *  pure mapper. Bumps `modifiedAt` automatically and pushes the
 *  pre-mutation state onto the undo stack (clearing the redo stack). */
function updateActive<S extends TwinState>(s: S, fn: (twin: Twin) => Twin): S {
  const snap = snapshotOf(s);
  const next = applyActive(s, fn);
  const past = [...s.past, snap];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { ...next, past, future: [] };
}

/** Mutate one workstation in the active twin, identified by id. No-op if
 *  the id doesn't resolve. */
function patchWorkstation<S extends TwinState>(
  s: S,
  wsId: string,
  fn: (w: Workstation) => Workstation,
): S {
  return updateActive(s, (twin) => ({
    ...twin,
    workstations: twin.workstations.map((w) => (w.id === wsId ? fn(w) : w)),
  }));
}

// ============================================================================
// STORE
// ============================================================================

export const useTwin = create<TwinState>()(
  persist(
    (set, get) => ({
      schemaVersion: TWIN_STORE_SCHEMA_VERSION,
      canonical: emptyTwin('My factory'),
      scenarios: [],
      activeScenarioId: null,
      past: [],
      future: [],

      undo: () =>
        set((s) => {
          if (s.past.length === 0) return s;
          const prev = s.past[s.past.length - 1];
          const past = s.past.slice(0, -1);
          const future = [...s.future, snapshotOf(s)];
          if (future.length > MAX_HISTORY) future.splice(0, future.length - MAX_HISTORY);
          return {
            ...s,
            canonical: prev.canonical,
            scenarios: prev.scenarios,
            activeScenarioId: prev.activeScenarioId,
            past,
            future,
          };
        }),

      redo: () =>
        set((s) => {
          if (s.future.length === 0) return s;
          const next = s.future[s.future.length - 1];
          const future = s.future.slice(0, -1);
          const past = [...s.past, snapshotOf(s)];
          if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
          return {
            ...s,
            canonical: next.canonical,
            scenarios: next.scenarios,
            activeScenarioId: next.activeScenarioId,
            past,
            future,
          };
        }),

      renameActive: (name) =>
        set((s) => updateActive(s, (twin) => ({ ...twin, name }))),

      setActiveNotes: (notes) =>
        set((s) => updateActive(s, (twin) => ({ ...twin, notes }))),

      touchActive: () => {
        const now = new Date().toISOString();
        set((s) => updateActive(s, (twin) => twin));
        return now;
      },

      // ── Sewing-Line CRUD ───────────────────────────────────────────────────
      addLine: (input) => {
        const id = newLineId();
        const line: SewingLine = { id, ...input };
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            lines: [...(twin.lines ?? []), line],
          })),
        );
        return id;
      },

      updateLine: (id, patch) =>
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            lines: (twin.lines ?? []).map((l) =>
              l.id === id ? { ...l, ...patch } : l,
            ),
          })),
        ),

      removeLine: (id) =>
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            lines: (twin.lines ?? []).filter((l) => l.id !== id),
            // Don't delete the member workstations — just orphan their lineId
            // so the user keeps the physical layout and can re-assign later.
            workstations: twin.workstations.map((w) =>
              w.lineId === id ? { ...w, lineId: undefined } : w,
            ),
          })),
        ),

      setLineForWorkstations: (wsIds, lineId) => {
        const wanted = new Set(wsIds);
        const next = lineId ?? undefined;
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            workstations: twin.workstations.map((w) =>
              wanted.has(w.id) ? { ...w, lineId: next } : w,
            ),
          })),
        );
      },

      shareOperatorsBetweenStations: (keepWsId, dropWsId) => {
        set((s) =>
          updateActive(s, (twin) => {
            const assignments = twin.assignments ?? [];
            const operators = twin.operators ?? [];
            const keepAsgn = assignments.find(
              (a) => a.wsId === keepWsId && a.role === 'primary',
            );
            const dropAsgn = assignments.find(
              (a) => a.wsId === dropWsId && a.role === 'primary',
            );
            // No-op when either station lacks a primary, or the two
            // stations are already covered by the same operator.
            if (!keepAsgn || !dropAsgn) return twin;
            if (keepAsgn.operatorId === dropAsgn.operatorId) return twin;
            const keepOpId = keepAsgn.operatorId;
            const dropOpId = dropAsgn.operatorId;

            // Drop the second operator entirely + all its assignments,
            // then graft the dropWsId onto the keep operator. Recompute
            // shareFrac as 1/N across every assignment the keep operator
            // now holds so a cascading merge (share 4-5, then 5-6) yields
            // 33 / 33 / 33 instead of stale 50 / 50 / 50 values.
            const nextOperators = operators.filter((o) => o.id !== dropOpId);
            const filtered = assignments.filter((a) => a.operatorId !== dropOpId);
            const grafted: Assignment[] = [
              ...filtered,
              {
                id: newAssignmentId(),
                operatorId: keepOpId,
                wsId: dropWsId,
                role: 'primary',
                shareFrac: 1,
              },
            ];
            const myCount = grafted.filter((a) => a.operatorId === keepOpId).length;
            const share = 1 / myCount;
            const nextAssignments: Assignment[] = grafted.map((a) =>
              a.operatorId === keepOpId ? { ...a, shareFrac: share } : a,
            );

            return {
              ...twin,
              operators: nextOperators,
              assignments: nextAssignments,
            };
          }),
        );
      },

      unshareWorkstation: (wsId) => {
        set((s) =>
          updateActive(s, (twin) => {
            const assignments = twin.assignments ?? [];
            const operators = twin.operators ?? [];
            const myAsgn = assignments.find(
              (a) => a.wsId === wsId && a.role === 'primary',
            );
            // No-op when the station has no primary assignment, or when
            // that primary isn't actually shared.
            if (!myAsgn || (myAsgn.shareFrac ?? 1) >= 1) return twin;
            const sharedOpId = myAsgn.operatorId;
            // Where else does the shared operator cover? After the peel,
            // those siblings should rebalance to 1 / (N - 1) share each.
            const otherAsgns = assignments.filter(
              (a) => a.operatorId === sharedOpId && a.wsId !== wsId,
            );
            const remainingCount = otherAsgns.length;

            // Mint a fresh primary operator for the peeled station. It
            // inherits the shared operator's line + archetype so the canvas
            // continues to render the same person tile category, but with a
            // new id (and a clean shareFrac = 1).
            const sharedOp = operators.find((o) => o.id === sharedOpId);
            const freshOp: Operator = {
              id: newOperatorId(),
              lineId: sharedOp?.lineId ?? twin.workstations.find((w) => w.id === wsId)?.lineId,
              name: `OPR-${operators.length + 1}`,
              archetypeId: sharedOp?.archetypeId ?? 'sew_op',
              // Skills are inherited so the new primary can actually run
              // the op without a "no skill" warning. The user can prune
              // them later in the (forthcoming) Resources editor.
              skills: sharedOp?.skills.map((sk) => ({ ...sk })) ?? [],
              multiplicity: 1,
            };

            const nextAssignments = assignments
              // Drop the peeled station's old (shared) assignment.
              .filter((a) => !(a.wsId === wsId && a.operatorId === sharedOpId))
              // Rebalance the remaining shared assignments to 1 / (N - 1).
              .map((a) =>
                a.operatorId === sharedOpId
                  ? {
                      ...a,
                      shareFrac: remainingCount > 0 ? 1 / remainingCount : 1,
                    }
                  : a,
              )
              // Add the fresh primary on the peeled station.
              .concat({
                id: newAssignmentId(),
                operatorId: freshOp.id,
                wsId,
                role: 'primary',
                shareFrac: 1,
              });

            return {
              ...twin,
              operators: [...operators, freshOp],
              assignments: nextAssignments,
            };
          }),
        );
      },

      // ── Workstations ───────────────────────────────────────────────────────
      addWorkstation: (input) => {
        // Auto-name based on preset label when the caller didn't supply one.
        // Counts every workstation whose name starts with the same preset
        // label so dropping multiple "Bundle source" blocks yields a clean
        // 1, 2, 3, … sequence within the active twin.
        let resolvedName = input.name;
        if (!resolvedName && input.presetLabel) {
          const active = selectActiveTwin(get());
          const re = new RegExp(`^${input.presetLabel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+(\\d+)$`, 'i');
          let max = 0;
          for (const w of active.workstations) {
            const m = re.exec(w.name);
            if (m) max = Math.max(max, parseInt(m[1], 10));
          }
          resolvedName = `${input.presetLabel} ${max + 1}`;
        }
        const ws = makeWorkstation({
          lineId: input.lineId,
          catalogId: input.catalogId,
          position: input.position,
          rotation: input.rotation,
          name: resolvedName,
          blockParams: input.blockParams,
        });
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            workstations: [...twin.workstations, ws],
          })),
        );
        return ws.id;
      },

      updateWorkstation: (id, patch) =>
        set((s) => patchWorkstation(s, id, (w) => ({ ...w, ...patch }))),

      removeWorkstation: (id) =>
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            workstations: twin.workstations.filter((w) => w.id !== id),
            // Cascade: drop connectors that touch the removed workstation.
            connectors: (twin.connectors ?? []).filter(
              (c) => c.fromWsId !== id && c.toWsId !== id,
            ),
          })),
        ),

      moveWorkstation: (id, position) =>
        set((s) =>
          patchWorkstation(s, id, (w) => ({ ...w, position: { ...position } })),
        ),

      setProcessPositions: (entries) =>
        set((s) =>
          updateActive(s, (twin) => {
            if (entries.length === 0) return twin;
            const byId = new Map(entries.map((e) => [e.wsId, e.pos]));
            return {
              ...twin,
              workstations: twin.workstations.map((w) => {
                const pos = byId.get(w.id);
                if (!pos) return w;
                // processPos lives on the block override, so ensure one
                // exists — pin the catalog-inferred kind when the ws has no
                // authored block yet. Idempotent w.r.t. sim behaviour.
                const kind = w.block?.kind ?? getBlockSpec(w).kind;
                return {
                  ...w,
                  block: { ...(w.block ?? { kind }), processPos: { x: pos.x, y: pos.y } },
                };
              }),
            };
          }),
        ),

      rotateWorkstation: (id, dir) =>
        set((s) =>
          patchWorkstation(s, id, (w) => {
            const next = ((w.rotation + dir * 90 + 360) % 360) as 0 | 90 | 180 | 270;
            return { ...w, rotation: next };
          }),
        ),

      duplicateWorkstation: (id) => {
        const active = selectActiveTwin(get());
        const src = active.workstations.find((w) => w.id === id);
        if (!src) return null;
        const newId = newWorkstationId();
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            workstations: [
              ...twin.workstations,
              {
                ...src,
                id: newId,
                position: { x: src.position.x + 1, y: src.position.y + 1 },
                props: { ...src.props },
                operation: { ...src.operation },
                resources: {
                  ...src.resources,
                  materialsPerCycle: { ...src.resources.materialsPerCycle },
                },
                kpiTargets: { ...src.kpiTargets },
                kpiObserved: undefined,
              },
            ],
          })),
        );
        return newId;
      },

      pasteWorkstations: (input) => {
        const active = selectActiveTwin(get());
        // A pasted station only needs its line to still exist; the floor
        // itself is free space, so there is no containing zone to validate
        // against. An orphaned lineId is dropped rather than rejecting the
        // paste — the station lands unlined.
        const lineIds = new Set((active.lines ?? []).map((l) => l.id));
        const idMap: Record<string, string> = {};
        const cloned: Workstation[] = [];
        for (const snap of input.snapshots) {
          const newId = newWorkstationId();
          idMap[snap._srcId] = newId;
          // Strip the transient `_srcId` from the clone before it joins
          // the twin — it's only here to thread the source→clone mapping
          // through to connector cloning, never persisted.
          const { _srcId: _srcId, ...rest } = snap;
          void _srcId;
          cloned.push({
            ...rest,
            id: newId,
            lineId: snap.lineId && lineIds.has(snap.lineId) ? snap.lineId : undefined,
            position: { ...snap.position },
            props: { ...snap.props },
            operation: { ...snap.operation },
            resources: {
              ...snap.resources,
              materialsPerCycle: { ...snap.resources.materialsPerCycle },
            },
            kpiTargets: { ...snap.kpiTargets },
            kpiObserved: undefined,
            size: snap.size ? { ...snap.size } : undefined,
            block: snap.block ? { ...snap.block, params: { ...snap.block.params } } : undefined,
          });
        }
        const newConnectors: Connector[] = [];
        for (const c of input.connectors) {
          const fromNew = idMap[c.fromWsId];
          const toNew = idMap[c.toWsId];
          if (!fromNew || !toNew) continue;
          newConnectors.push({
            id: newConnectorId(),
            kind: c.kind,
            fromWsId: fromNew,
            toWsId: toNew,
            label: c.label,
            fromPort: c.fromPort,
            toPort: c.toPort,
          });
        }
        if (cloned.length === 0) {
          return { idMap, newWsIds: [] };
        }
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            workstations: [...twin.workstations, ...cloned],
            connectors: [...(twin.connectors ?? []), ...newConnectors],
          })),
        );
        return { idMap, newWsIds: cloned.map((w) => w.id) };
      },

      // ── Connector CRUD ─────────────────────────────────────────────────────
      addConnector: (input) => {
        if (input.fromWsId === input.toWsId) return null;
        const active = selectActiveTwin(get());
        const wsIds = new Set(active.workstations.map((w) => w.id));
        if (!wsIds.has(input.fromWsId) || !wsIds.has(input.toWsId)) return null;
        // Reject an exact-duplicate edge (same endpoints AND same ports) so
        // the freeform canvas can't accumulate stacked identical wires when a
        // user drags the same output→input twice. A second wire between the
        // same blocks on *different* ports is still allowed (branch/merge).
        const isDup = (active.connectors ?? []).some(
          (c) =>
            c.fromWsId === input.fromWsId &&
            c.toWsId === input.toWsId &&
            (c.fromPort ?? null) === (input.fromPort ?? null) &&
            (c.toPort ?? null) === (input.toPort ?? null),
        );
        if (isDup) return null;
        const id = newConnectorId();
        const conn: Connector = {
          id,
          kind: input.kind,
          fromWsId: input.fromWsId,
          toWsId: input.toWsId,
          label: input.label,
          fromPort: input.fromPort,
          toPort: input.toPort,
        };
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            connectors: [...(twin.connectors ?? []), conn],
          })),
        );
        return id;
      },

      updateConnector: (id, patch) =>
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            connectors: (twin.connectors ?? []).map((c) =>
              c.id === id ? { ...c, ...patch } : c,
            ),
          })),
        ),

      removeConnector: (id) =>
        set((s) =>
          updateActive(s, (twin) => ({
            ...twin,
            connectors: (twin.connectors ?? []).filter((c) => c.id !== id),
          })),
        ),

      // ── Order CRUD (P4) ─────────────────────────────────────────────────
      addOrderToActiveTwin: (input, lineId) => {
        const orderId =
          input.id
          ?? `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
        const order: Order = {
          ...input,
          id: orderId,
          createdAt: input.createdAt ?? new Date().toISOString(),
          assignedLineId: lineId ?? input.assignedLineId,
        };
        set((s) =>
          updateActive(s, (twin) => {
            const orders = [...(twin.orders ?? []), order];
            const lines = lineId
              ? (twin.lines ?? []).map((l) =>
                  l.id === lineId
                    ? { ...l, orderSequence: [...(l.orderSequence ?? []), orderId] }
                    : l,
                )
              : twin.lines;
            return { ...twin, orders, lines };
          }),
        );
        return orderId;
      },

      // ── Lens-attribute sugar ───────────────────────────────────────────────
      setOperation: (wsId, patch) =>
        set((s) =>
          patchWorkstation(s, wsId, (w) => ({
            ...w,
            operation: { ...w.operation, ...patch },
          })),
        ),

      setResources: (wsId, patch) =>
        set((s) =>
          patchWorkstation(s, wsId, (w) => ({
            ...w,
            resources: {
              ...w.resources,
              ...patch,
              materialsPerCycle:
                patch.materialsPerCycle !== undefined
                  ? { ...patch.materialsPerCycle }
                  : w.resources.materialsPerCycle,
            },
          })),
        ),

      setKpiTargets: (wsId, patch) =>
        set((s) =>
          patchWorkstation(s, wsId, (w) => ({
            ...w,
            kpiTargets: { ...w.kpiTargets, ...patch },
          })),
        ),

      setKpiObserved: (wsId, observed) =>
        // Sim-side write — bypasses undo history so a run-summary import
        // doesn't bury the user's last edit behind 100 station updates.
        set((s) =>
          applyActive(s, (twin) => ({
            ...twin,
            workstations: twin.workstations.map((w) =>
              w.id === wsId ? { ...w, kpiObserved: observed } : w,
            ),
          })),
        ),

      setBlock: (wsId, block) =>
        set((s) =>
          patchWorkstation(s, wsId, (w) => ({
            ...w,
            block: block
              ? {
                  kind: block.kind,
                  inputs: block.inputs ? block.inputs.map((p) => ({ ...p })) : undefined,
                  outputs: block.outputs ? block.outputs.map((p) => ({ ...p })) : undefined,
                  params: block.params ? { ...block.params } : undefined,
                  // Preserve the freeform PROCESS-canvas position across a
                  // block-kind edit — without this, editing a block in the
                  // Inspector would snap it back to the swim-lane seed.
                  processPos: block.processPos ? { ...block.processPos } : undefined,
                }
              : undefined,
          })),
        ),

      // ── Scenarios ──────────────────────────────────────────────────────────
      // Scenario-tree mutations clear undo/redo: history is a single-twin
      // concept, and mixing snapshots of different active twins makes
      // undo behave unpredictably across context switches.
      createScenarioFromCanonical: ({ name, notes, activate }) => {
        const id = newScenarioId();
        const now = new Date().toISOString();
        set((s) => {
          const twin = forkTwin(s.canonical, { name, notes });
          const scenario: Scenario = {
            id,
            name,
            notes,
            createdAt: now,
            modifiedAt: now,
            twin,
            runs: [],
          };
          return {
            ...s,
            scenarios: [scenario, ...s.scenarios],
            activeScenarioId: activate ? id : s.activeScenarioId,
            past: [],
            future: [],
          };
        });
        return id;
      },

      forkScenario: (fromScenarioId, { name, notes, activate }) => {
        const source = get().scenarios.find((x) => x.id === fromScenarioId);
        if (!source) return null;
        const id = newScenarioId();
        const now = new Date().toISOString();
        set((s) => {
          const twin = forkTwin(source.twin, { name, notes });
          const scenario: Scenario = {
            id,
            name,
            notes,
            createdAt: now,
            modifiedAt: now,
            twin,
            runs: [],
          };
          return {
            ...s,
            scenarios: [scenario, ...s.scenarios],
            activeScenarioId: activate ? id : s.activeScenarioId,
            past: [],
            future: [],
          };
        });
        return id;
      },

      createScenarioFromTwin: ({ name, notes, twin, activate }) => {
        const id = newScenarioId();
        const now = new Date().toISOString();
        // Stamp the caller-supplied twin with a fresh id + scenario name so it
        // can't collide with another scenario's parent twin id. The twin is
        // marked non-canonical because it lives inside a scenario, not at the
        // top of the tree.
        const scenarioTwin: Twin = {
          ...twin,
          id: newTwinId(),
          name,
          isCanonical: false,
          createdAt: now,
          modifiedAt: now,
        };
        set((s) => {
          const scenario: Scenario = {
            id,
            name,
            notes,
            createdAt: now,
            modifiedAt: now,
            twin: scenarioTwin,
            runs: [],
          };
          return {
            ...s,
            scenarios: [scenario, ...s.scenarios],
            activeScenarioId: activate ? id : s.activeScenarioId,
            past: activate ? [] : s.past,
            future: activate ? [] : s.future,
          };
        });
        return id;
      },

      renameScenario: (id, name) =>
        set((s) => ({
          ...s,
          scenarios: s.scenarios.map((scn) =>
            scn.id === id
              ? {
                  ...scn,
                  name,
                  twin: { ...scn.twin, name },
                  modifiedAt: new Date().toISOString(),
                }
              : scn,
          ),
        })),

      deleteScenario: (id) =>
        set((s) => ({
          ...s,
          scenarios: s.scenarios.filter((scn) => scn.id !== id),
          activeScenarioId: s.activeScenarioId === id ? null : s.activeScenarioId,
          past: [],
          future: [],
        })),

      setActiveScenario: (id) =>
        set((s) => {
          if (id === null) return { ...s, activeScenarioId: null, past: [], future: [] };
          if (!s.scenarios.some((scn) => scn.id === id)) return s;
          return { ...s, activeScenarioId: id, past: [], future: [] };
        }),

      promoteScenarioToCanonical: (id) =>
        set((s) => {
          const scn = s.scenarios.find((x) => x.id === id);
          if (!scn) return s;
          const now = new Date().toISOString();
          const promoted: Twin = {
            ...scn.twin,
            isCanonical: true,
            parentTwinId: null,
            modifiedAt: now,
          };
          return {
            ...s,
            canonical: promoted,
            // Preserve other scenarios but drop the one we promoted.
            scenarios: s.scenarios.filter((x) => x.id !== id),
            activeScenarioId: null,
            past: [],
            future: [],
          };
        }),

      // ── Run history ────────────────────────────────────────────────────────
      recordRun: (scenarioId, runInput) => {
        const id = newRunId();
        const run: SimRun = { ...runInput, id, scenarioId: scenarioId ?? '' };
        set((s) => {
          if (scenarioId === null) {
            // Runs against the canonical twin are not persisted on a Scenario;
            // they ride along on the canonical twin's stations via
            // setKpiObserved. Aggregate run history for canonical lives in
            // the simulation layer for now.
            return s;
          }
          return {
            ...s,
            scenarios: s.scenarios.map((scn) =>
              scn.id === scenarioId ? { ...scn, runs: [run, ...scn.runs] } : scn,
            ),
          };
        });
        return run;
      },

      clearRunsFor: (scenarioId) =>
        set((s) => ({
          ...s,
          scenarios: s.scenarios.map((scn) =>
            scn.id === scenarioId ? { ...scn, runs: [] } : scn,
          ),
        })),

      // ── Project-level ──────────────────────────────────────────────────────
      resetTwin: () =>
        set(() => ({
          schemaVersion: TWIN_STORE_SCHEMA_VERSION,
          canonical: emptyTwin('My factory'),
          scenarios: [],
          activeScenarioId: null,
          past: [],
          future: [],
          // Preserve action references so the store's identity holds.
          undo: get().undo,
          redo: get().redo,
          renameActive: get().renameActive,
          setActiveNotes: get().setActiveNotes,
          touchActive: get().touchActive,
          addLine: get().addLine,
          updateLine: get().updateLine,
          removeLine: get().removeLine,
          setLineForWorkstations: get().setLineForWorkstations,
          addWorkstation: get().addWorkstation,
          updateWorkstation: get().updateWorkstation,
          removeWorkstation: get().removeWorkstation,
          moveWorkstation: get().moveWorkstation,
          setProcessPositions: get().setProcessPositions,
          rotateWorkstation: get().rotateWorkstation,
          duplicateWorkstation: get().duplicateWorkstation,
          pasteWorkstations: get().pasteWorkstations,
          addConnector: get().addConnector,
          updateConnector: get().updateConnector,
          removeConnector: get().removeConnector,
          setOperation: get().setOperation,
          setResources: get().setResources,
          setKpiTargets: get().setKpiTargets,
          setKpiObserved: get().setKpiObserved,
          setBlock: get().setBlock,
          createScenarioFromCanonical: get().createScenarioFromCanonical,
          forkScenario: get().forkScenario,
          createScenarioFromTwin: get().createScenarioFromTwin,
          renameScenario: get().renameScenario,
          deleteScenario: get().deleteScenario,
          setActiveScenario: get().setActiveScenario,
          promoteScenarioToCanonical: get().promoteScenarioToCanonical,
          recordRun: get().recordRun,
          clearRunsFor: get().clearRunsFor,
          resetTwin: get().resetTwin,
          loadCanonical: get().loadCanonical,
          exportTwin: get().exportTwin,
        })),

      loadCanonical: (twin) => {
        const errs = validateTwin(twin);
        if (errs.length > 0) {
          return { ok: false, reason: errs.join('; ') };
        }
        set((s) => ({
          ...s,
          canonical: { ...twin, isCanonical: true, parentTwinId: null },
          scenarios: [],
          activeScenarioId: null,
          past: [],
          future: [],
        }));
        return { ok: true };
      },

      exportTwin: () => {
        const s = get();
        return {
          schemaVersion: TWIN_STORE_SCHEMA_VERSION,
          canonical: s.canonical,
          scenarios: s.scenarios,
          activeScenarioId: s.activeScenarioId,
        };
      },
    }),
    {
      name: 'stitchworks.twin.v1',
      version: TWIN_STORE_SCHEMA_VERSION,
      // Quota-aware storage so a silent QuotaExceededError on the twin
      // write (the biggest of the three persisted stores — canonical +
      // every scenario's full twin) becomes a visible console.error +
      // window event instead of an empty Builder dropdown after refresh.
      storage: createJSONStorage(() => indexedDbStorage()),
      partialize: (state) => ({
        schemaVersion: state.schemaVersion,
        canonical: state.canonical,
        scenarios: state.scenarios,
        activeScenarioId: state.activeScenarioId,
      }),
      // v1 → v2: add `connectors: []` to canonical and every scenario's twin.
      // v2 → v4: drop the now-removed CAD underlay field (handled by
      // normalizeTwin, which simply ignores it on load).
      // v5 → v6: clear `kpiObserved` — its utilizationPct changed meaning.
      // v6 → v7: retire departments. The bump exists purely to force every
      // already-persisted twin back through `normalizeTwin`, which strips the
      // dead `departments` array and every `deptId`. Without it a saved
      // factory keeps carrying zone data the app can no longer read — the
      // fields are invisible to the types but still on disk, and still
      // reloaded on every boot. Station geometry is untouched.
      migrate: (persisted, fromVersion) => {
        const s = (persisted ?? {}) as {
          canonical?: unknown;
          scenarios?: Array<{ twin?: unknown; runs?: unknown[] } & Record<string, unknown>>;
          activeScenarioId?: string | null;
        };
        if (fromVersion < TWIN_STORE_SCHEMA_VERSION) {
          const clearStaleKpis = (t: Twin): Twin =>
            fromVersion >= 6
              ? t
              : {
                  ...t,
                  workstations: t.workstations.map((ws) =>
                    ws.kpiObserved ? { ...ws, kpiObserved: undefined } : ws,
                  ),
                };
          return {
            schemaVersion: TWIN_STORE_SCHEMA_VERSION,
            canonical: clearStaleKpis(normalizeTwin(s.canonical)),
            scenarios: (s.scenarios ?? []).map((scn) => ({
              ...scn,
              twin: clearStaleKpis(normalizeTwin(scn.twin)),
              runs: scn.runs ?? [],
            })),
            activeScenarioId: s.activeScenarioId ?? null,
          };
        }
        return persisted;
      },
    },
  ),
);

// ============================================================================
// SELECTORS — small, composable readers for components
// ============================================================================

/** The twin currently being authored / simulated. */
export function selectActiveTwin(s: TwinState): Twin {
  if (s.activeScenarioId === null) return s.canonical;
  return s.scenarios.find((scn) => scn.id === s.activeScenarioId)?.twin ?? s.canonical;
}

/** Resolve a workstation id in the active twin. */
export function selectWorkstation(
  s: TwinState,
  wsId: string,
): Workstation | undefined {
  return selectActiveTwin(s).workstations.find((w) => w.id === wsId);
}

/** All workstations attributed to a specific sewing line. */
export function selectWorkstationsInLine(
  s: TwinState,
  lineId: string,
): Workstation[] {
  return selectActiveTwin(s).workstations.filter((w) => w.lineId === lineId);
}

/** Resolve a sewing line id in the active twin. */
export function selectLine(s: TwinState, lineId: string): SewingLine | undefined {
  return (selectActiveTwin(s).lines ?? []).find((l) => l.id === lineId);
}

// Re-export the colour-key + line types so callers don't have to dig into domain/twin.
export type { EntityColorKey, SewingLine, ProductionSystemKey };
