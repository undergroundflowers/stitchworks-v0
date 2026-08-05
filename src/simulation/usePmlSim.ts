/**
 * React hook — PML simulation playback over time.
 *
 * Drop-in replacement for the legacy `useSim` hook. Returns the same
 * `UseSimResult` shape so existing LiveSim / Scenarios views
 * consume it unchanged.
 *
 * Mechanics:
 *   1. `runPmlSim(twin, …)` is invoked once when the active twin (or any
 *      explicit opts) change. The full sample timeseries is cached.
 *   2. A wall-clock loop advances a frame pointer into `samples[]` at the
 *      rate dictated by the project's `time.executionMode` and
 *      `time.realTimeScale`, multiplied by the user-controlled `speed`.
 *   3. `state` is the legacy-shape SimState reconstructed from
 *      `samples[frame]` by the adapter — so the UI sees the exact contract
 *      it expects (`state.stations[]`, `state.history[]`, etc.).
 *
 * The PML engine is record-then-replay: the entire run executes the
 * moment a new twin arrives, then playback scrubs through the recorded
 * timeseries. That mirrors the AnyLogic 'virtual time' contract — the
 * sim itself runs as fast as compute allows; the playback overlays a
 * cinematic rate on top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Twin } from '../domain/twin';
import type { GarmentTemplate } from '../domain';
import { runPmlSim, type PmlSimResult } from './pml-engine';
import {
  buildPmlTwinView,
  emptyPmlSimState,
  pmlSampleToSimState,
  type PmlTwinView,
} from './pml-to-sim-state';
import type { SimState } from './sim-state';
import { useProject } from '../store';

/** Tick interval for the wall-clock loop (real-time mode only). */
const TICK_MS = 200;

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
   *  REAL per-bundle movement instead of synthetic motion. Off by default —
   *  only LiveSim needs it; analytics/report consumers skip the memory cost. */
  recordFlow?: boolean;
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
  /** The completed PML run, or null until the first run finishes. Memoized
   *  by twin identity + opts — does not change frame-to-frame. */
  result: PmlSimResult | null;
  /** Static metadata about the twin's stations (opCode, machineCode, etc.).
   *  Useful for views that want to label cells before the run completes. */
  view: PmlTwinView;
}

export function usePmlSim(twin: Twin, opts?: UsePmlSimOpts): UsePmlSimResult {
  const durationMin = opts?.durationMin ?? DEFAULT_DURATION_MIN;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const garment = opts?.garment;
  const recordFlow = opts?.recordFlow ?? false;

  // Static twin view — opId/opCode/opName/machineCode/smv per station. Cheap
  // to compute; memoize by twin identity so the adapter doesn't redo the
  // catalog/bulletin lookups every render.
  const view = useMemo(() => buildPmlTwinView(twin, garment), [twin, garment]);

  // Run the PML engine once for this (twin, durationMin, seed). The result is
  // a record-then-replay artifact — every frame the playback shows came out
  // of this single call.
  const result = useMemo<PmlSimResult | null>(() => {
    if (twin.workstations.length === 0) return null;
    try {
      return runPmlSim({ twin, durationMin, seed, samplePeriodMin: 1, recordFlow });
    } catch (err) {
      // The engine throws on truly broken graphs (no Source, no Sink, etc.);
      // return null so the UI renders an empty-state shell instead of crashing.
      // The Builder's validation chip surfaces the same errors pre-flight.
      if (typeof console !== 'undefined') {
        console.error('[usePmlSim] runPmlSim failed:', err);
      }
      return null;
    }
  }, [twin, durationMin, seed, recordFlow]);

  const samples = result?.samples ?? [];
  const lastFrame = Math.max(0, samples.length - 1);

  // Frame pointer — the index in `samples[]` currently being displayed.
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // Reset frame when the underlying samples change (twin or opts changed).
  useEffect(() => {
    setFrame(0);
  }, [result]);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const mode = useProject((s) => s.time.executionMode);
  const realTimeScale = useProject((s) => s.time.realTimeScale);

  useEffect(() => {
    if (!playing || samples.length === 0) return;

    if (mode === 'virtual') {
      // Virtual time: jump to end-of-run on the next animation frame. The PML
      // run is already recorded — there's nothing to "compute faster"; just
      // settle on the final sample so the UI shows steady-state numbers.
      const id = requestAnimationFrame(() => {
        setFrame(lastFrame);
        setPlaying(false);
      });
      return () => cancelAnimationFrame(id);
    }

    // Real-time mode: advance frame at `effectiveScale × dt` sim-minutes per
    // real-second. With realTimeScale=1, speed=1 that's exactly 1 sim-minute
    // per wall-second (since samples are taken at 1-min cadence) — matching
    // the legacy engine cadence.
    //
    // A fractional accumulator preserves precision at low speeds: rounding
    // dt × scale up to 1 per tick (the previous approach) made the default
    // speed=1 case advance ~5 frames/sec instead of 1 frame/sec, because
    // each 200 ms tick contributed 0.2 sim-minutes that rounded up.
    let last = performance.now();
    let accum = frameRef.current; // start where the frame pointer is now
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const effectiveScale = Math.max(0, realTimeScale) * Math.max(0, speed);
      accum += dt * effectiveScale;
      const nextFrame = Math.min(lastFrame, Math.floor(accum));
      if (nextFrame === frameRef.current) return;
      setFrame(nextFrame);
      if (nextFrame >= lastFrame) {
        setPlaying(false);
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, samples.length, speed, mode, realTimeScale, lastFrame]);

  const reset = useCallback(() => {
    setFrame(0);
  }, []);

  const step = useCallback(
    (units: number) => {
      setFrame((f) => Math.max(0, Math.min(lastFrame, f + Math.round(units))));
    },
    [lastFrame],
  );

  // Build the SimState for the current frame. priorSamples slice keeps
  // `history` and `stationHistory` time-bounded to what's "happened so far"
  // — playback feels causal even though the run is pre-recorded.
  const state = useMemo<SimState>(() => {
    if (samples.length === 0 || !result) return emptyPmlSimState();
    const idx = Math.min(frame, lastFrame);
    const sample = samples[idx];
    if (!sample) return emptyPmlSimState();
    const prior = samples.slice(0, idx + 1);
    return pmlSampleToSimState(view, sample, result, prior);
  }, [samples, result, frame, lastFrame, view]);

  return {
    state,
    playing,
    speed,
    mode,
    setPlaying,
    setSpeed,
    reset,
    step,
    result,
    view,
  };
}
