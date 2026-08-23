/**
 * React hook — PML simulation playback over time.
 *
 * Now a thin adapter over `useSimSession`. The return shape is unchanged, so
 * existing consumers read it exactly as before, but the run itself lives in the
 * shared session: the engine is invoked once per STRUCTURALLY distinct spec
 * rather than once per twin object, the playback clock is global, and two
 * surfaces that describe the same run share it instead of each simulating the
 * factory separately.
 *
 * What this fixes for callers, without their changing a line:
 *   • The engine no longer re-runs because an unrelated store write minted a
 *     new twin object. It ran three times on a cold boot before the user
 *     touched anything.
 *   • The frame pointer no longer resets to zero on those re-runs. That reset,
 *     racing a mount-only warm-up effect, is why changing the garment or the
 *     operator count left every metric reading zero permanently.
 *   • `state.history` / `state.stationHistory` are grown incrementally instead
 *     of rebuilt from the whole sample array on every rendered frame.
 */

import { useEffect, useMemo } from 'react';
import type { Twin } from '../domain/twin';
import type { GarmentTemplate } from '../domain';
import type { PmlSimResult } from './pml-engine';
import { emptyPmlSimState, type PmlTwinView } from './pml-to-sim-state';
import type { SimState } from './sim-state';
import { useProject } from '../store/project';
import { useSimScope } from '../store/simScope';
import { useGarments } from '../store/garments';
import { simSpecKey, type SimSpec } from './sim-spec';
import { useSimSession } from './useSimSession';

/** Default sim duration when the caller doesn't override it. One 8h shift. */
const DEFAULT_DURATION_MIN = 480;

/** Default RNG seed — keep deterministic so two devs see the same numbers. */
const DEFAULT_SEED = 42;

export interface UsePmlSimOpts {
  /** Simulation duration in MINUTES. Default 480 (one 8h shift). */
  durationMin?: number;
  /** RNG seed — same seed = same run. Default 42. */
  seed?: number;
  /** Optional garment template; carries opCode / opName / serviceDist hints
   *  the adapter uses when the workstation's `operation.opId` resolves in
   *  the bulletin. Falls back to `ws.operation.*` fields otherwise. */
  garment?: GarmentTemplate;
  /** Record the entity-flow stream (`result.flow`) so the view can play back
   *  REAL per-bundle movement instead of synthetic motion. */
  recordFlow?: boolean;
  /** Steady-state warm-up in sim MINUTES. Defaults to the shared scope's
   *  setting; pass 0 to measure across the whole run. */
  warmupMin?: number;
}

export interface UseSimResult {
  state: SimState;
  playing: boolean;
  speed: number;
  mode: 'virtual' | 'realtime';
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  reset: () => void;
  step: (units: number) => void;
}

/** Hook return for PML — same shape as legacy `useSim` PLUS the underlying
 *  run report so summary KPI cards can read aggregate numbers (lead time,
 *  throughput, warnings) without re-running the sim. */
export interface UsePmlSimResult extends UseSimResult {
  /** The completed PML run, or null until the first run finishes. */
  result: PmlSimResult | null;
  /** Static metadata about the twin's stations (opCode, machineCode, etc.). */
  view: PmlTwinView;
}

/**
 * Wrap a single already-scoped twin as a one-line spec.
 *
 * Callers hand this hook a twin that is either the whole factory or one line's
 * slice of it; either way the engine treats it as a single tandem network, so
 * a one-entry spec is the faithful description. The synthetic line id is
 * derived from the twin so two structurally identical twins land on the same
 * session.
 */
function useSingleLineSpec(twin: Twin, opts: UsePmlSimOpts | undefined): SimSpec {
  const scopeWarmup = useSimScope((s) => s.warmupMin);
  // Effective catalog (built-ins + project edits) — see the note on
  // `SimSpec.garmentsById`.
  const garmentsById = useGarments().byId;
  const durationMin = opts?.durationMin ?? DEFAULT_DURATION_MIN;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const garment = opts?.garment;
  const recordFlow = opts?.recordFlow ?? false;
  const warmupMin = opts?.warmupMin ?? scopeWarmup;

  return useMemo<SimSpec>(
    () => ({
      lines: [
        {
          lineId: twin.lines?.[0]?.id ?? twin.id,
          lineName: twin.lines?.[0]?.name ?? twin.name,
          twin,
          garment,
        },
      ],
      garmentsById,
      durationMin,
      seed,
      samplePeriodMin: 1,
      recordFlow,
      warmupMin: Math.max(0, Math.min(warmupMin, durationMin - 1)),
    }),
    [twin, garment, garmentsById, durationMin, seed, recordFlow, warmupMin],
  );
}

export function usePmlSim(twin: Twin, opts?: UsePmlSimOpts): UsePmlSimResult {
  const spec = useSingleLineSpec(twin, opts);
  // The key is what the effect depends on, NOT the spec object. That is the
  // whole trick: a re-derived but structurally identical spec produces the
  // same key, so nothing re-runs.
  const key = useMemo(() => (spec.lines[0].twin.workstations.length > 0 ? simSpecKey(spec) : ''), [spec]);

  const ensure = useSimSession((s) => s.ensure);
  useEffect(() => {
    // 'start': these hooks drive the animated floor, where opening the screen
    // to an already-finished shift would be useless. The analysis surfaces go
    // through `useLineSim`, which parks at the settled end instead.
    if (key) ensure(spec, { parkAt: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const session = useSimSession((s) => (key ? s.sessions[key] : undefined));
  const playing = useSimSession((s) => s.playing);
  const speed = useSimSession((s) => s.speed);
  const setPlaying = useSimSession((s) => s.setPlaying);
  const setSpeed = useSimSession((s) => s.setSpeed);
  const sessionReset = useSimSession((s) => s.reset);
  const sessionStep = useSimSession((s) => s.step);
  const mode = useProject((s) => s.time.executionMode);

  const slot = session?.runs[0];
  const fallbackView = useMemo<PmlTwinView>(
    () => ({ stations: [], infrastructure: [], meta: emptyMeta(twin), nonFifoStations: [] }),
    [twin],
  );

  return {
    state: slot?.state ?? emptyPmlSimState(),
    playing,
    speed,
    mode,
    setPlaying,
    setSpeed,
    reset: sessionReset,
    step: sessionStep,
    result: slot?.result ?? null,
    view: slot?.view ?? fallbackView,
  };
}

/** Minimal meta stand-in for the pre-run render. Mirrors what
 *  `buildPmlTwinView` produces for an empty twin without paying for the
 *  catalog lookups. */
function emptyMeta(twin: Twin): PmlTwinView['meta'] {
  return {
    simulatedWsIds: [],
    skipped: [],
    infrastructure: [],
    seedOperators: 0,
    seedBundleSize: 1,
    topologySource: 'connectors',
    stations: [],
    workstations: [],
    garment: {
      id: 'pml-twin',
      name: twin.name,
      defaultBundleSize: 1,
      operations: [],
    } as unknown as PmlTwinView['meta']['garment'],
    garmentPinned: false,
  };
}
