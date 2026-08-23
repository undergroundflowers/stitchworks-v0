import { useEffect, useState } from 'react';
import { useProject } from '../project';
import { useTwin } from '../twin';
import { useFactoryLibrary } from '../factoryLibrary';
import { useLab } from '../lab';

/**
 * True once every IndexedDB-backed store has finished async rehydration.
 *
 * IndexedDB reads are asynchronous, so on boot the stores briefly hold their
 * default (empty) state until persist finishes loading. The app gates its
 * first render on this so the UI never flashes an empty factory, and so the
 * demo-seed effect doesn't fire against not-yet-loaded data and clobber it.
 *
 * The `reference` store stays on synchronous localStorage (it's <1 KB) and so
 * isn't part of the gate.
 */
export function useStoresHydrated(): boolean {
  const [hydrated, setHydrated] = useState(
    () =>
      useProject.persist.hasHydrated() &&
      useTwin.persist.hasHydrated() &&
      useFactoryLibrary.persist.hasHydrated() &&
      useLab.persist.hasHydrated(),
  );

  useEffect(() => {
    const check = () => {
      if (
        useProject.persist.hasHydrated() &&
        useTwin.persist.hasHydrated() &&
        useFactoryLibrary.persist.hasHydrated() &&
        useLab.persist.hasHydrated()
      ) {
        setHydrated(true);
      }
    };
    const unsubs = [
      useProject.persist.onFinishHydration(check),
      useTwin.persist.onFinishHydration(check),
      useFactoryLibrary.persist.onFinishHydration(check),
      useLab.persist.onFinishHydration(check),
    ];
    // Cover the race where a store hydrated between initial state and effect.
    check();
    return () => unsubs.forEach((u) => u());
  }, []);

  return hydrated;
}
