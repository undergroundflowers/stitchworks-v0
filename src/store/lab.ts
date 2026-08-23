/**
 * Queue Lab store — the user's own collection of queueing systems.
 *
 * Deliberately separate from the factory stores. A Lab system is not part of
 * anyone's twin: it is a model the user built to study, which may correspond to
 * nothing on the floor at all (a textbook problem, a hypothetical, a shape they
 * are trying to understand). Keeping it in its own IndexedDB key means
 * exporting a project doesn't drag a scratchpad along, and clearing the Lab
 * cannot touch a factory.
 *
 * A single system and a network are the same type throughout: a single system
 * is a network with one node and no edges. There is no mode switch in the data,
 * only in how the surface chooses to draw it, which is what lets a user add a
 * second station to a textbook problem without converting anything.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { indexedDbStorage } from './storage/indexedDbStorage';
import {
  SEED_SYSTEMS,
  SEED_VERSION,
  blankSystem,
  type LabSystem,
} from '../domain/lab-systems';
import type { QueueEdge, QueueNode } from '../simulation/network';

/**
 * Bumped when the persisted SHAPE changes in a way old data cannot satisfy.
 *
 * Passed to `persist` as its `version`, which is the mechanism that actually
 * runs `migrate` on a mismatch. It used to sit in the state object instead,
 * where it was written to storage on every save and read by nothing — a field
 * that looked like a migration guarantee while providing none.
 */
const LAB_SCHEMA_VERSION = 1;

export interface LabState {
  systems: LabSystem[];
  /**
   * Which generation of the starter collection this user has received. Lets a
   * later release add a starter system without either missing existing users
   * or resurrecting one they deleted.
   */
  seedVersion: number;
  /** Which system the surface is showing. Null before the first render. */
  activeId: string | null;
  /** Which node inside the active system is selected, if any. */
  selectedNodeId: string | null;
  /** Systems pinned into the comparison strip, by id. */
  comparedIds: string[];

  // ── System-level ──────────────────────────────────────────────────────────
  selectSystem: (id: string) => void;
  createSystem: (name?: string) => string;
  duplicateSystem: (id: string, name?: string) => string;
  renameSystem: (id: string, name: string) => void;
  deleteSystem: (id: string) => void;
  /** Add a whole system built elsewhere — the import-from-station path. */
  addSystem: (system: LabSystem) => string;
  /**
   * Restore a starter system to the version it shipped with.
   *
   * Deliberately available AFTER edits, not before: the whole point of a study
   * tool is to change a textbook problem and see what happens, so the way back
   * has to survive having done that. Eligibility is decided by the system's id
   * matching a starter, which editing cannot change — an earlier version
   * cleared a `seeded` flag on every edit and so made this action reachable
   * only on a system nobody had touched.
   */
  resetSeeded: (id: string) => void;

  // ── Node-level ────────────────────────────────────────────────────────────
  selectNode: (nodeId: string | null) => void;
  addNode: (systemId: string, node?: Partial<QueueNode>) => string;
  patchNode: (systemId: string, nodeId: string, patch: Partial<QueueNode>) => void;
  removeNode: (systemId: string, nodeId: string) => void;

  // ── Edge-level ────────────────────────────────────────────────────────────
  connect: (systemId: string, from: string, to: string, probability?: number) => void;
  disconnect: (systemId: string, edgeId: string) => void;
  patchEdge: (systemId: string, edgeId: string, patch: Partial<QueueEdge>) => void;

  // ── Comparison ────────────────────────────────────────────────────────────
  toggleCompared: (id: string) => void;
  clearCompared: () => void;
}

/** Short unique-enough id. Collisions here cost a duplicate key, not data. */
function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Keep a node's outgoing shares summing to at most 1.
 *
 * The share of a node's output that leaves the network is 1 − Σp, so Σp above
 * 1 means it emits more than it takes in — which `validateNetwork` rejects
 * outright, blanking every measure in the whole system, not just that node's.
 *
 * The Lab's topology verbs make this easy to hit: adding a 15% rework arc to a
 * mid-chain stage whose forward arc is already 1.0 would take the total to
 * 1.15. Rather than let the user build that and then explain the error, the
 * arc just added keeps the share it was given and the OTHERS are scaled down
 * to fit — which is what "15% goes back, the rest carries on" means anyway.
 */
function normaliseOut(edges: QueueEdge[], from: string, keepEdgeId: string): QueueEdge[] {
  const outgoing = edges.filter((e) => e.from === from);
  const total = outgoing.reduce((a, e) => a + e.probability, 0);
  if (total <= 1 + 1e-9) return edges;

  const kept = outgoing.find((e) => e.id === keepEdgeId);
  const keptShare = Math.min(1, kept?.probability ?? 0);
  const others = outgoing.filter((e) => e.id !== keepEdgeId);
  const othersTotal = others.reduce((a, e) => a + e.probability, 0);
  // Whatever room the new arc leaves is divided among the rest in proportion.
  const room = Math.max(0, 1 - keptShare);
  const scale = othersTotal > 0 ? room / othersTotal : 0;

  return edges.map((e) => {
    if (e.from !== from || e.id === keepEdgeId) return e;
    return { ...e, probability: Number((e.probability * scale).toFixed(6)) };
  });
}

/** Replace one system in the list, leaving the rest untouched. */
function mapSystem(
  systems: LabSystem[],
  id: string,
  fn: (s: LabSystem) => LabSystem,
): LabSystem[] {
  return systems.map((s) => (s.id === id ? fn(s) : s));
}

export const useLab = create<LabState>()(
  persist(
    (set, get) => ({
      systems: SEED_SYSTEMS,
      seedVersion: SEED_VERSION,
      activeId: SEED_SYSTEMS[0]?.id ?? null,
      selectedNodeId: null,
      comparedIds: [],

      selectSystem: (id) =>
        set((s) => ({
          activeId: id,
          // Selection is per-system; carrying a node id across would point at
          // a node that isn't in the new system.
          selectedNodeId: s.systems.find((x) => x.id === id)?.nodes[0]?.id ?? null,
        })),

      createSystem: (name) => {
        const id = newId('sys');
        const system = blankSystem(id, name ?? 'New system');
        set((s) => ({
          systems: [...s.systems, system],
          activeId: id,
          selectedNodeId: system.nodes[0]?.id ?? null,
        }));
        return id;
      },

      duplicateSystem: (id, name) => {
        const src = get().systems.find((s) => s.id === id);
        if (!src) return id;
        const newSysId = newId('sys');
        // Node ids have to be rewritten, and the edges rewritten to match, or
        // the copy and the original would share node identity and editing one
        // would silently move the other's selection.
        const idMap = new Map(src.nodes.map((nd) => [nd.id, `${newSysId}-${newId('n')}`]));
        const copy: LabSystem = {
          id: newSysId,
          name: name ?? `${src.name} (copy)`,
          blurb: src.blurb,
          source: src.source,
          nodes: src.nodes.map((nd) => ({ ...nd, id: idMap.get(nd.id)! })),
          edges: src.edges.map((e) => ({
            ...e,
            id: newId('e'),
            from: idMap.get(e.from)!,
            to: idMap.get(e.to)!,
          })),
        };
        set((s) => ({
          systems: [...s.systems, copy],
          activeId: newSysId,
          selectedNodeId: copy.nodes[0]?.id ?? null,
        }));
        return newSysId;
      },

      renameSystem: (id, name) =>
        set((s) => ({ systems: mapSystem(s.systems, id, (sys) => ({ ...sys, name })) })),

      deleteSystem: (id) =>
        set((s) => {
          const systems = s.systems.filter((x) => x.id !== id);
          const activeId = s.activeId === id ? (systems[0]?.id ?? null) : s.activeId;
          return {
            systems,
            activeId,
            selectedNodeId:
              activeId === s.activeId
                ? s.selectedNodeId
                : (systems.find((x) => x.id === activeId)?.nodes[0]?.id ?? null),
            comparedIds: s.comparedIds.filter((c) => c !== id),
          };
        }),

      addSystem: (system) => {
        set((s) => ({
          systems: [...s.systems, system],
          activeId: system.id,
          selectedNodeId: system.nodes[0]?.id ?? null,
        }));
        return system.id;
      },

      resetSeeded: (id) =>
        set((s) => {
          const seed = SEED_SYSTEMS.find((x) => x.id === id);
          if (!seed) return s;
          return {
            systems: mapSystem(s.systems, id, () => seed),
            selectedNodeId: seed.nodes[0]?.id ?? null,
          };
        }),

      selectNode: (selectedNodeId) => set({ selectedNodeId }),

      addNode: (systemId, patch) => {
        const nodeId = newId('n');
        set((s) =>
          ({
            systems: mapSystem(s.systems, systemId, (sys) => ({
              ...sys,
              nodes: [
                ...sys.nodes,
                {
                  id: nodeId,
                  name: `Station ${sys.nodes.length + 1}`,
                  externalArrivalPerHr: 0,
                  serviceDist: { kind: 'exp', mean: 6 },
                  servers: 1,
                  capacity: Infinity,
                  discipline: 'FCFS',
                  ...patch,
                },
              ],
            })),
            selectedNodeId: nodeId,
          }),
        );
        return nodeId;
      },

      patchNode: (systemId, nodeId, patch) =>
        set((s) => ({
          systems: mapSystem(s.systems, systemId, (sys) => ({
            ...sys,
            nodes: sys.nodes.map((nd) => (nd.id === nodeId ? { ...nd, ...patch } : nd)),
          })),
        })),

      removeNode: (systemId, nodeId) =>
        set((s) => ({
          systems: mapSystem(s.systems, systemId, (sys) => ({
            ...sys,
            nodes: sys.nodes.filter((nd) => nd.id !== nodeId),
            // Edges touching a removed node would point at nothing.
            edges: sys.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
          })),
          selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
        })),

      connect: (systemId, from, to, probability = 1) =>
        set((s) => ({
          systems: mapSystem(s.systems, systemId, (sys) => {
            // A duplicate arc is the user drawing the same connection twice;
            // treat it as an edit of the existing one rather than stacking two.
            const existing = sys.edges.find((e) => e.from === from && e.to === to);
            const next = existing
              ? sys.edges.map((e) => (e === existing ? { ...e, probability } : e))
              : [...sys.edges, { id: newId('e'), from, to, probability }];
            return {
              ...sys,
                edges: normaliseOut(next, from, existing?.id ?? next[next.length - 1].id),
            };
          }),
        })),

      disconnect: (systemId, edgeId) =>
        set((s) => ({
          systems: mapSystem(s.systems, systemId, (sys) => ({
            ...sys,
            edges: sys.edges.filter((e) => e.id !== edgeId),
          })),
        })),

      patchEdge: (systemId, edgeId, patch) =>
        set((s) => ({
          systems: mapSystem(s.systems, systemId, (sys) => ({
            ...sys,
            edges: sys.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)),
          })),
        })),

      toggleCompared: (id) =>
        set((s) => ({
          comparedIds: s.comparedIds.includes(id)
            ? s.comparedIds.filter((c) => c !== id)
            : [...s.comparedIds, id],
        })),

      clearCompared: () => set({ comparedIds: [] }),
    }),
    {
      name: 'stitchworks.lab.v1',
      /**
       * The replacer/reviver pair exists for one value: `Infinity`.
       *
       * An unbounded buffer is `capacity: Infinity`, and JSON has no literal
       * for it — `JSON.stringify(Infinity)` produces `null`. Without this, a
       * CAPPED system would survive a reload intact while an UNBOUNDED one
       * came back as `capacity: null`, which reads as 0 and silently converts
       * every open queue in the Lab into a closed one on refresh.
       */
      storage: createJSONStorage(() => indexedDbStorage(), {
        replacer: (_key, value) => (value === Infinity ? INFINITY_TOKEN : value),
        reviver: (_key, value) => (value === INFINITY_TOKEN ? Infinity : value),
      }),
      version: LAB_SCHEMA_VERSION,
      /**
       * Carry pre-versioned saves forward instead of throwing them away.
       *
       * `persist` treats a stored blob with no matching version as
       * unmigratable and DISCARDS it unless a migrate function exists — so
       * adding `version` without this would silently wipe the collection of
       * anyone who had used the Lab before the field existed. The shape did not
       * change (the old build kept its version counter inside the state object
       * rather than here), so passing the payload through is the whole
       * migration; `merge` below then tops up any starters it predates.
       */
      migrate: (persisted) => persisted as LabState,
      /**
       * Top up the starter collection, once, when a release adds one.
       *
       * The default merge replaces `systems` wholesale with what was stored, so
       * a user who has opened the Lab even once would be frozen on the seed set
       * they first saw. Naively re-adding every missing seed instead is worse:
       * it resurrects the ones they deliberately deleted, on every reload.
       * Comparing the stored `seedVersion` against the current one distinguishes
       * "never had it" from "had it and threw it away".
       */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<LabState>;
        const merged: LabState = { ...current, ...stored };
        if ((stored.seedVersion ?? 0) >= SEED_VERSION) return merged;
        const have = new Set(merged.systems.map((sys) => sys.id));
        return {
          ...merged,
          systems: [...merged.systems, ...SEED_SYSTEMS.filter((sys) => !have.has(sys.id))],
          seedVersion: SEED_VERSION,
        };
      },
    },
  ),
);

/** Sentinel standing in for `Infinity` across the JSON boundary. */
const INFINITY_TOKEN = '__Infinity__';

/** The system currently being studied, or null. */
export function useActiveSystem(): LabSystem | null {
  return useLab((s) => s.systems.find((x) => x.id === s.activeId) ?? s.systems[0] ?? null);
}
