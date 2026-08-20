/**
 * Shared simulation scope + run parameters.
 *
 * Every surface that runs the engine — the Sim screen, the queueing tables,
 * the reports — has to agree on WHAT is being simulated and WITH WHAT
 * parameters, or they each derive a slightly different spec, mint a different
 * session key, and thrash one another's playback on every route change.
 *
 * Deliberately small and persisted: this is user intent ("I'm looking at Line
 * 2, over one shift, seed 42"), not derived state.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { indexedDbStorage } from './storage/indexedDbStorage';

/** What the engine is pointed at. The floor is free space, so the only
 *  meaningful groupings are the whole factory or one sewing line. */
export type SimScope =
  | { kind: 'factory' }
  | { kind: 'line'; id: string };

export interface SimScopeState {
  scope: SimScope;
  /** Run length in sim MINUTES. */
  durationMin: number;
  /** RNG seed. Same seed ⇒ same run. */
  seed: number;
  /**
   * Transient discarded from steady-state observables, in sim minutes.
   *
   * The live surfaces truncate by DIFFERENCING two samples rather than asking
   * the engine to zero its accumulators, because a chart needs the start-up
   * ramp to stay visible even while the KPI tiles quote post-warm-up numbers.
   */
  warmupMin: number;

  setScope: (s: SimScope) => void;
  setDuration: (m: number) => void;
  setSeed: (n: number) => void;
  setWarmup: (m: number) => void;
}

export const DEFAULT_SIM_DURATION_MIN = 480;
export const DEFAULT_SIM_SEED = 42;
export const DEFAULT_SIM_WARMUP_MIN = 60;

export const useSimScope = create<SimScopeState>()(
  persist(
    (set) => ({
      scope: { kind: 'factory' },
      durationMin: DEFAULT_SIM_DURATION_MIN,
      seed: DEFAULT_SIM_SEED,
      warmupMin: DEFAULT_SIM_WARMUP_MIN,

      setScope: (scope) => set({ scope }),
      setDuration: (durationMin) =>
        set({ durationMin: Math.max(1, Math.round(durationMin)) }),
      setSeed: (seed) => set({ seed: Math.round(seed) }),
      // Warm-up can never swallow the whole run, or every observable would be
      // measured over a zero-length window.
      setWarmup: (warmupMin) =>
        set((s) => ({
          warmupMin: Math.max(0, Math.min(Math.round(warmupMin), s.durationMin - 1)),
        })),
    }),
    {
      name: 'stitchworks.simscope.v1',
      storage: createJSONStorage(() => indexedDbStorage()),
    },
  ),
);

/** Stable string form of a scope — used inside the session key. */
export function scopeToKey(scope: SimScope): string {
  return scope.kind === 'factory' ? 'factory' : `${scope.kind}:${scope.id}`;
}
