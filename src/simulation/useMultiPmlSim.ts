/**
 * Parallel-engine sibling of `usePmlSim` — runs one PML sim per sewing line
 * and drives them from a single wall-clock tick so play/pause/speed/reset
 * operate on all of them together. Returned `states[]` is parallel to the
 * `lineTwins[]` argument.
 *
 * Justification: PML can in principle simulate the whole multi-line twin in
 * one call, but per-line isolation matters for two reasons —
 *   1. Per-line garment / bundle-size differs (Line 1 = knit T-shirt, Line 2
 *      = woven shirt); modelling them as independent flows is honest.
 *   2. The legacy `useMultiSim` exposed this exact shape; keeping it lets
 *      LiveSim swap hooks without restructuring its multi-line branch.
 *
 * Tick semantics match `usePmlSim` 1:1 so the same transport bar drives
 * either hook without drift.
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
import type { SimState, StationView } from './sim-state';
import type { BuildFromTwinMeta } from './model-from-twin';
import { useProject } from '../store';
import type { UseSimResult } from './usePmlSim';

const TICK_MS = 200;
const DEFAULT_DURATION_MIN = 480;
const DEFAULT_SEED = 42;

export interface PmlLineInput {
  /** Stable line id — used as the React key and the namespace for opId merging. */
  lineId: string;
  /** Twin scoped to this line's workstations + connectors. */
  twin: Twin;
  /** Optional bulletin to carry opCode / opName / serviceDist hints into the adapter. */
  garment?: GarmentTemplate;
}

export interface UseMultiPmlSimResult extends Omit<UseSimResult, 'state'> {
  /** Parallel to the `lineTwins` argument. Same shape as `usePmlSim().state`. */
  states: SimState[];
  /** Per-line PmlTwinView, parallel to `lineTwins`. Useful for the merged meta. */
  views: PmlTwinView[];
  /** Per-line PML run report, parallel to `lineTwins`. Null until the run completes. */
  results: (PmlSimResult | null)[];
}

export function useMultiPmlSim(
  lineTwins: PmlLineInput[],
  opts?: { durationMin?: number; seed?: number; recordFlow?: boolean },
): UseMultiPmlSimResult {
  const durationMin = opts?.durationMin ?? DEFAULT_DURATION_MIN;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const recordFlow = opts?.recordFlow ?? false;

  const views = useMemo(
    () => lineTwins.map((lt) => buildPmlTwinView(lt.twin, lt.garment)),
    [lineTwins],
  );
  const results = useMemo<(PmlSimResult | null)[]>(
    () =>
      lineTwins.map((lt) => {
        if (lt.twin.workstations.length === 0) return null;
        try {
          return runPmlSim({ twin: lt.twin, durationMin, seed, samplePeriodMin: 1, recordFlow });
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.error(`[useMultiPmlSim] runPmlSim failed for line ${lt.lineId}:`, err);
          }
          return null;
        }
      }),
    [lineTwins, durationMin, seed, recordFlow],
  );

  // Total frame count — the shorter line settles at its last sample while
  // longer lines continue advancing. Playback ends when every line has hit
  // its end (so the user can compare ramp-up across lines honestly).
  const maxFrames = useMemo(
    () =>
      results.reduce(
        (m, r) => Math.max(m, (r?.samples.length ?? 1) - 1),
        0,
      ),
    [results],
  );

  const [frame, setFrame] = useState(0);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // Reset frame when any line's samples change.
  useEffect(() => {
    setFrame(0);
  }, [results]);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const mode = useProject((s) => s.time.executionMode);
  const realTimeScale = useProject((s) => s.time.realTimeScale);

  useEffect(() => {
    if (!playing || maxFrames === 0) return;
    if (mode === 'virtual') {
      const id = requestAnimationFrame(() => {
        setFrame(maxFrames);
        setPlaying(false);
      });
      return () => cancelAnimationFrame(id);
    }
    // Fractional accumulator preserves precision at low speeds. See
    // usePmlSim for the longer note on why a per-tick integer round was
    // 5× too fast at the default speed.
    let last = performance.now();
    let accum = frameRef.current;
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const effectiveScale = Math.max(0, realTimeScale) * Math.max(0, speed);
      accum += dt * effectiveScale;
      const nextFrame = Math.min(maxFrames, Math.floor(accum));
      if (nextFrame === frameRef.current) return;
      setFrame(nextFrame);
      if (nextFrame >= maxFrames) {
        setPlaying(false);
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, speed, mode, realTimeScale, maxFrames]);

  const reset = useCallback(() => setFrame(0), []);
  const step = useCallback(
    (units: number) => setFrame((f) => Math.max(0, Math.min(maxFrames, f + Math.round(units)))),
    [maxFrames],
  );

  const states = useMemo<SimState[]>(
    () =>
      views.map((view, i) => {
        const result = results[i];
        if (!result || result.samples.length === 0) return emptyPmlSimState();
        const idx = Math.min(frame, result.samples.length - 1);
        const sample = result.samples[idx];
        const prior = result.samples.slice(0, idx + 1);
        return pmlSampleToSimState(view, sample, result, prior);
      }),
    [views, results, frame],
  );

  return {
    states,
    views,
    results,
    playing,
    speed,
    mode,
    setPlaying,
    setSpeed,
    reset,
    step,
  };
}

// ============================================================================
// Twin scoping — narrow a multi-line twin to one line's workstations so PML
// can run a per-line simulation honestly (different garments / bundle sizes /
// operator pools don't compose into one homogeneous run).
// ============================================================================

/**
 * Return a Twin containing only the workstations that belong to `lineId`,
 * plus the connectors whose endpoints both live inside that line. Other
 * twin fields (departments, lines, schema) are carried over as-is —
 * downstream code reads them but doesn't index them by lineId.
 *
 * Pure function: shares Workstation references with the original twin
 * (PML only reads from them).
 */
export function scopedTwinForLine(twin: Twin, lineId: string): Twin {
  const workstations = twin.workstations.filter((w) => w.lineId === lineId);
  const wsIds = new Set(workstations.map((w) => w.id));
  const connectors = twin.connectors.filter(
    (c) => wsIds.has(c.fromWsId) && wsIds.has(c.toWsId),
  );
  return {
    ...twin,
    workstations,
    connectors,
  };
}

// ============================================================================
// Merge helpers — fold per-line PML outputs into one shape the existing iso /
// top / heat / logic views already understand. opIds get namespaced by lineId
// so React keys and opId-based layout lookups don't collide across garments.
// ============================================================================

function namespacedOpId(lineId: string, opId: string): string {
  return `${lineId}::${opId}`;
}

/**
 * Concatenate per-line `SimState`s into one factory-wide shape. Same contract
 * as the legacy `mergeSimStates` — kept here so consumers can swap the import
 * source when the legacy file gets deleted.
 *
 * Bottleneck is recomputed as the station with the highest live utilisation
 * across all lines, so the iso/top views can still highlight one "hot" cell
 * factory-wide.
 */
export function mergePmlSimStates(states: SimState[], lineIds: string[]): SimState {
  if (states.length === 0) return emptyPmlSimState();

  const stations: StationView[] = [];
  const stationHistory: SimState['stationHistory'] = [];
  let bottleneckIdx = -1;
  let bottleneckUtil = -Infinity;
  let produced = 0;
  let producedPieces = 0;
  let totalArrivals = 0;
  let totalBusy = 0;
  let totalCapacity = 0;
  const events: SimState['events'] = [];

  for (let li = 0; li < states.length; li++) {
    const s = states[li];
    const lineId = lineIds[li] ?? `line-${li}`;
    for (let i = 0; i < s.stations.length; i++) {
      const st = s.stations[i];
      const idx = stations.length;
      stations.push({ ...st, opId: namespacedOpId(lineId, st.opId) });
      stationHistory.push(s.stationHistory[i] ?? []);
      if (st.utilization > bottleneckUtil) {
        bottleneckUtil = st.utilization;
        bottleneckIdx = idx;
      }
      totalBusy += st.totalBusyTime;
      totalCapacity += st.serversTotal * Math.max(1e-9, s.time);
    }
    produced += s.produced;
    producedPieces += s.producedPieces;
    totalArrivals += s.totalArrivals;
    for (const ev of s.events) events.push(ev);
  }

  let leadNum = 0;
  let leadDen = 0;
  for (const s of states) {
    if (s.produced > 0) {
      leadNum += s.meanLeadTime * s.produced;
      leadDen += s.produced;
    }
  }
  const meanLeadTime = leadDen > 0 ? leadNum / leadDen : states[0].meanLeadTime;

  events.sort((a, b) => b.time - a.time);
  if (events.length > 60) events.length = 60;

  return {
    time: states[0].time,
    produced,
    producedPieces,
    totalArrivals,
    meanLeadTime,
    utilization: totalCapacity > 0 ? totalBusy / totalCapacity : 0,
    bottleneckOpIndex: bottleneckIdx,
    stations,
    history: states[0].history,
    stationHistory,
    events,
    // Model diagnostics are per-line but the user sees one factory — dedupe so
    // "no Sink on this line" doesn't appear six times.
    warnings: [...new Set(states.flatMap((s) => s.warnings))],
  };
}

/**
 * Concatenate per-line PML twin views into one `BuildFromTwinMeta` so the
 * legacy ISO/TOP/HEAT layout functions see every authored Builder coord.
 * Returns null when no line built ok — caller falls back to non-twin layout.
 */
export function mergePmlTwinMetas(
  views: PmlTwinView[],
  lineIds: string[],
  lineNames: string[],
): BuildFromTwinMeta | null {
  const ok = views.filter((v) => v.stations.length > 0);
  if (ok.length === 0) return null;

  const stations: BuildFromTwinMeta['stations'] = [];
  const workstations: BuildFromTwinMeta['workstations'] = [];
  const simulatedWsIds: string[] = [];
  const infrastructure: BuildFromTwinMeta['infrastructure'] = [];
  let seedOperators = 0;

  for (let li = 0; li < views.length; li++) {
    const v = views[li];
    const lineId = lineIds[li] ?? `line-${li}`;
    for (const ts of v.meta.stations) {
      stations.push({ ...ts, opId: namespacedOpId(lineId, ts.opId) });
    }
    for (const wc of v.meta.workstations) {
      workstations.push({ ...wc, opId: namespacedOpId(lineId, wc.opId), lineId });
    }
    for (const id of v.meta.simulatedWsIds) simulatedWsIds.push(id);
    for (const inf of v.meta.infrastructure) infrastructure.push(inf);
    seedOperators += v.meta.seedOperators;
  }

  // First non-empty view supplies the fallback garment / bundle size for the
  // header label; the iso view's caption gets overridden in multi-line mode.
  const first = ok[0].meta;
  // Tag with the combined line names so the page chrome can title appropriately.
  void lineNames;
  return {
    simulatedWsIds,
    skipped: [],
    infrastructure,
    seedOperators,
    seedBundleSize: first.seedBundleSize,
    topologySource: 'connectors',
    stations,
    workstations,
    garment: first.garment,
    garmentPinned: false,
  };
}
