/**
 * Keeps the domain-layer fixture registry pointed at the active project's
 * station types.
 *
 * The registry is a plain module (`domain/fixture-registry`) because its
 * readers include pure functions that cannot hold React state — but the
 * types themselves are project data, and the project is a zustand store.
 * This module is the one seam between the two: it is imported for its side
 * effect from `store/index.ts`, seeds the registry with whatever hydrated,
 * and re-pushes on every change.
 *
 * Components do not read through this. They read `stationTypes` from the
 * store like any other slice, so they re-render on change as usual; the
 * registry only exists so a non-React caller can resolve a catalog id.
 */

import { setStationTypes } from '../domain/fixture-registry';
import { useProject } from './project';

setStationTypes(useProject.getState().stationTypes);

useProject.subscribe((state, prev) => {
  if (state.stationTypes !== prev.stationTypes) setStationTypes(state.stationTypes);
});

// Rehydration replaces the slice wholesale after the async IndexedDB read
// resolves, and that happens without going through `subscribe`'s change
// path on some zustand versions — so re-seed explicitly when it finishes.
useProject.persist?.onFinishHydration?.(() => {
  setStationTypes(useProject.getState().stationTypes);
});
