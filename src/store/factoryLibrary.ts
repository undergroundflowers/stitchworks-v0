/**
 * Factory library — a registry of archived factories. Each entry is a frozen
 * snapshot of the project store + twin store at the moment it was saved.
 *
 * Why a separate store?
 *   The project + twin stores already own "the active factory". The library
 *   lives alongside them as an outer layer. Archiving and loading happen by
 *   exporting from / replaying into the two existing stores, so neither has
 *   to learn about multi-project concerns.
 *
 * Persistence:
 *   localStorage key `stitchworks.library.v1`. Independent of the two inner
 *   stores so the active factory can be wiped without losing archived ones.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import {
  useProject,
  PROJECT_SCHEMA_VERSION,
  type ProjectState,
} from './project';
import { useTwin, TWIN_STORE_SCHEMA_VERSION } from './twin';
import type { Twin, Scenario as TwinScenario } from '../domain/twin';
import { indexedDbStorage } from './storage/indexedDbStorage';

export const LIBRARY_SCHEMA_VERSION = 1 as const;

/** Slot cap surfaced in the menu UI ("SAVED FACTORIES · n / MAX"). */
export const FACTORY_LIBRARY_MAX = 5;

interface TwinSnapshot {
  schemaVersion: typeof TWIN_STORE_SCHEMA_VERSION;
  canonical: Twin;
  scenarios: TwinScenario[];
  activeScenarioId: string | null;
}

export interface SavedFactory {
  id: string;
  name: string;
  /** ISO timestamp captured at archive time. */
  savedAt: string;
  /** Cached for the slot tile so we don't have to deep-walk on render. */
  stationCount: number;
  project: ProjectState;
  twin: TwinSnapshot;
}

export interface FactoryLibraryState {
  schemaVersion: typeof LIBRARY_SCHEMA_VERSION;
  savedFactories: SavedFactory[];

  /** Snapshot the active project + twin into a new library entry. */
  archiveCurrent: (overrideName?: string) => SavedFactory;
  /** Replace active state with the given saved factory. If `archiveFirst`
   *  is true (default), the current active factory is snapshotted before
   *  the swap so the user never silently loses work. */
  loadFactory: (id: string, opts?: { archiveFirst?: boolean }) => boolean;
  /** Drop a saved factory by id. */
  deleteFactory: (id: string) => void;
  /** Rename a saved factory in place. */
  renameFactory: (id: string, name: string) => void;
  /** Sweep saved factories and suffix any whose names collide with the
   *  active project or an earlier entry. Idempotent — safe to call on
   *  every rehydrate. Returns the number of entries that were renamed. */
  dedupeSavedFactories: () => number;
}

function newId(): string {
  return `fac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Comparison key: trimmed and case-insensitive. "Brandix" and "brandix " collide. */
function nameKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * True if `name` is already in use by either a saved factory or the currently
 * active project. Pass `excludeSavedId` to ignore one saved entry (used when
 * renaming an existing slot to its own current name). Pass `includeActive`
 * = false when the caller knows the active factory is being replaced and its
 * name should not block the check.
 */
export function isFactoryNameTaken(
  name: string,
  opts: { excludeSavedId?: string; includeActive?: boolean } = {},
): boolean {
  const { excludeSavedId, includeActive = true } = opts;
  const key = nameKey(name);
  if (!key) return false;
  if (includeActive) {
    const activeName = useProject.getState().meta.name;
    if (nameKey(activeName) === key) return true;
  }
  const saved = useFactoryLibrary.getState().savedFactories;
  return saved.some((f) => f.id !== excludeSavedId && nameKey(f.name) === key);
}

/**
 * Returns `name` if it's free, otherwise appends ` (2)`, ` (3)`, … until
 * unique. Used by archive paths where the user did not pick the name, so
 * collisions should be resolved silently rather than rejected.
 */
function uniquifyFactoryName(
  name: string,
  opts: { excludeSavedId?: string; includeActive?: boolean } = {},
): string {
  const base = name.trim() || 'Untitled Factory';
  if (!isFactoryNameTaken(base, opts)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!isFactoryNameTaken(candidate, opts)) return candidate;
  }
  // Pathological fallback — append a short random suffix.
  return `${base} (${Math.random().toString(36).slice(2, 6)})`;
}

function captureProject(): ProjectState {
  // exportProject already returns a serialisable data-only shape.
  // Deep-clone via JSON so subsequent edits to the live store can't
  // mutate the archived snapshot through shared refs.
  const data = useProject.getState().exportProject();
  return JSON.parse(JSON.stringify(data)) as ProjectState;
}

function captureTwin(): TwinSnapshot {
  const data = useTwin.getState().exportTwin();
  return JSON.parse(JSON.stringify(data)) as TwinSnapshot;
}

function applyProject(snap: ProjectState): void {
  const result = useProject.getState().loadProject(snap);
  if (!result.ok) {
    console.warn('[factoryLibrary] project load failed:', result.reason);
  }
}

function applyTwin(snap: TwinSnapshot): void {
  // Twin store has no full-snapshot import. Splice the data fields directly
  // — zustand setState shallow-merges, so the action references are kept.
  useTwin.setState({
    schemaVersion: TWIN_STORE_SCHEMA_VERSION,
    canonical: snap.canonical,
    scenarios: snap.scenarios,
    activeScenarioId: snap.activeScenarioId,
  });
}

export const useFactoryLibrary = create<FactoryLibraryState>()(
  persist(
    (set, get) => ({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      savedFactories: [],

      archiveCurrent: (overrideName) => {
        const project = captureProject();
        const twin = captureTwin();
        // The active project is becoming an archived snapshot — its name is
        // free to collide with itself, so excludeActive. Dedupe against
        // existing saved entries so the slot list never shows duplicates.
        const requested = (overrideName ?? project.meta.name ?? 'Untitled Factory').trim() || 'Untitled Factory';
        const name = uniquifyFactoryName(requested, { includeActive: false });
        const entry: SavedFactory = {
          id: newId(),
          name,
          savedAt: new Date().toISOString(),
          stationCount: twin.canonical.workstations.length,
          project,
          twin,
        };
        // Enforce FACTORY_LIBRARY_MAX so repeated Load-Bundle clicks can't
        // grow the library unbounded. Each entry holds a full project+twin
        // snapshot (~hundreds of KB), and zustand/persist silently swallows
        // QuotaExceededError when the combined localStorage budget blows —
        // so without this cap the twin-store persist (the biggest write)
        // is the one that gets dropped on the next click, leaving the
        // Builder's FACTORY dropdown empty while Reports still shows the
        // project-store scenarios. Drop oldest first so the most recent
        // factories stay closest to hand.
        set((s) => {
          const next = [entry, ...s.savedFactories];
          return { savedFactories: next.slice(0, FACTORY_LIBRARY_MAX) };
        });
        return entry;
      },

      loadFactory: (id, opts) => {
        const archiveFirst = opts?.archiveFirst ?? true;
        const target = get().savedFactories.find((f) => f.id === id);
        if (!target) return false;
        if (archiveFirst) get().archiveCurrent();
        applyProject(target.project);
        applyTwin(target.twin);
        // The just-loaded factory is now live; drop the slot to avoid
        // a duplicate (active + archived copy with the same content).
        set((s) => ({ savedFactories: s.savedFactories.filter((f) => f.id !== id) }));
        return true;
      },

      deleteFactory: (id) =>
        set((s) => ({ savedFactories: s.savedFactories.filter((f) => f.id !== id) })),

      renameFactory: (id, name) => {
        // Dedupe against the active project and other saved entries. The
        // entry being renamed is excluded so renaming to its own current
        // name is a no-op rather than an auto-suffix.
        const safe = uniquifyFactoryName(name, { excludeSavedId: id, includeActive: true });
        set((s) => ({
          savedFactories: s.savedFactories.map((f) => (f.id === id ? { ...f, name: safe } : f)),
        }));
      },

      dedupeSavedFactories: () => {
        // Walk the saved list in its current order (newest-first as kept
        // by archiveCurrent). The first entry with a given name key wins;
        // later collisions get suffixed. The active project's name takes
        // precedence over any saved entry — if a saved entry shares the
        // active name, the saved one gets suffixed.
        const activeKey = nameKey(useProject.getState().meta.name);
        const taken = new Set<string>();
        if (activeKey) taken.add(activeKey);
        let renamed = 0;
        const next = get().savedFactories.map((f) => {
          const key = nameKey(f.name);
          if (!taken.has(key)) {
            taken.add(key);
            return f;
          }
          // Collision — generate a unique suffix not in `taken`.
          const base = (f.name.trim() || 'Untitled Factory');
          let candidate = base;
          for (let i = 2; i < 1000; i++) {
            candidate = `${base} (${i})`;
            if (!taken.has(nameKey(candidate))) break;
          }
          taken.add(nameKey(candidate));
          renamed++;
          return { ...f, name: candidate };
        });
        if (renamed > 0) set({ savedFactories: next });
        return renamed;
      },
    }),
    {
      name: 'stitchworks.library.v1',
      version: LIBRARY_SCHEMA_VERSION,
      // Quota-aware storage: when a library write blows past the budget,
      // the recovery hook drops the OLDEST saved factory in place and the
      // wrapper retries the write once. This mirrors the cap enforcement
      // in archiveCurrent for the case where the budget is exhausted by
      // sibling stores (twin / project) rather than library growth.
      storage: createJSONStorage(() =>
        indexedDbStorage({
          onQuotaError: () => {
            const s = useFactoryLibrary.getState();
            if (s.savedFactories.length <= 1) return false;
            // Drop the oldest entry (savedFactories is newest-first).
            useFactoryLibrary.setState({
              savedFactories: s.savedFactories.slice(0, s.savedFactories.length - 1),
            });
            // eslint-disable-next-line no-console
            console.warn(
              `[factoryLibrary] quota hit — dropped oldest saved factory to make room. ` +
                `Library now holds ${s.savedFactories.length - 1} entries.`,
            );
            return true;
          },
        }),
      ),
      partialize: (state) => ({
        schemaVersion: state.schemaVersion,
        savedFactories: state.savedFactories,
      }),
      // After persisted state is rehydrated, repair any name collisions
      // that pre-date the uniqueness rule. Defer to a microtask so the
      // project store has finished its own rehydrate and getState() can
      // read the user's true active-factory name.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        queueMicrotask(() => {
          const n = state.dedupeSavedFactories();
          if (n > 0) console.info(`[factoryLibrary] deduped ${n} saved factor${n === 1 ? 'y' : 'ies'}`);
        });
      },
    },
  ),
);

/**
 * Convenience: archive the active factory and then reset both stores to a
 * blank starter. Used by the Menu's "Create New Factory" flow. The new
 * name is applied after reset so the fresh factory shows up under the
 * label the user typed.
 */
export function archiveAndStartFresh(newName: string): void {
  const lib = useFactoryLibrary.getState();
  lib.archiveCurrent();
  useProject.getState().resetProject();
  useTwin.getState().resetTwin();
  const trimmed = newName.trim();
  if (trimmed) {
    // Dedupe against saved entries (the just-archived snapshot counts)
    // before naming the fresh active factory. The UI already validates,
    // so this is belt-and-braces — programmatic callers can't accidentally
    // produce a duplicate.
    const safe = uniquifyFactoryName(trimmed, { includeActive: false });
    // Keep the project meta and twin canonical names in sync so every
    // surface that reads either (TopBar reads project.meta.name; Builder
    // picker reads twin.canonical.name) shows the same label.
    useProject.getState().rename(safe);
    useTwin.getState().renameActive(safe);
  }
}

void PROJECT_SCHEMA_VERSION; // re-export only for type narrowing if needed
