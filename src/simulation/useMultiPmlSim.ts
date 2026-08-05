/**
 * Parallel-engine sibling of `usePmlSim` — one PML run per sewing line, all
 * driven from the shared clock so play / pause / speed / reset act on them
 * together. `states[]` is parallel to the `lineTwins[]` argument.
 *
 * Per-line isolation is deliberate rather than a limitation: Line 1 might be
 * running a knit T-shirt at bundle 30 while Line 2 runs a woven shirt at bundle
 * 10, and modelling those as one homogeneous flow would be dishonest about
 * both. Each line is its own tandem network with its own operator pool.
 *
 * Like `usePmlSim`, this is now a thin adapter over `useSimSession`; see that
 * module for why the run is keyed structurally and the clock is global.
 */

import { useEffect, useMemo } from 'react';
import type { Twin } from '../domain/twin';
import type { GarmentTemplate } from '../domain';
import type { PmlSimResult } from './pml-engine';
import { emptyPmlSimState, type PmlTwinView } from './pml-to-sim-state';
import type { SimState, StationView } from './sim-state';
import type { BuildFromTwinMeta } from './model-from-twin';
import { useProject } from '../store/project';
import { useSimScope } from '../store/simScope';
import { simSpecKey, type SimSpec } from './sim-spec';
import { useSimSession } from './useSimSession';
import type { UseSimResult } from './usePmlSim';

const DEFAULT_DURATION_MIN = 480;
const DEFAULT_SEED = 42;

export interface PmlLineInput {
  /** Stable line id — the React key and the namespace for opId merging. */
  lineId: string;
  /** Twin scoped to this line's workstations + connectors. */
  twin: Twin;
  /** Optional bulletin carrying opCode / opName / serviceDist hints. */
  garment?: GarmentTemplate;
}

export interface UseMultiPmlSimResult extends Omit<UseSimResult, 'state'> {
  /** Parallel to the `lineTwins` argument. Same shape as `usePmlSim().state`. */
  states: SimState[];
  /** Per-line PmlTwinView, parallel to `lineTwins`. */
  views: PmlTwinView[];
  /** Per-line PML run report, parallel to `lineTwins`. Null until it runs. */
  results: (PmlSimResult | null)[];
}

export function useMultiPmlSim(
  lineTwins: PmlLineInput[],
  opts?: { durationMin?: number; seed?: number; recordFlow?: boolean; warmupMin?: number },
): UseMultiPmlSimResult {
  const scopeWarmup = useSimScope((s) => s.warmupMin);
  const durationMin = opts?.durationMin ?? DEFAULT_DURATION_MIN;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const recordFlow = opts?.recordFlow ?? false;
  const warmupMin = opts?.warmupMin ?? scopeWarmup;

  const spec = useMemo<SimSpec>(
    () => ({
      lines: lineTwins.map((lt) => ({
        lineId: lt.lineId,
        lineName: lt.lineId,
        twin: lt.twin,
        garment: lt.garment,
      })),
      durationMin,
      seed,
      samplePeriodMin: 1,
      recordFlow,
      warmupMin: Math.max(0, Math.min(warmupMin, durationMin - 1)),
    }),
    [lineTwins, durationMin, seed, recordFlow, warmupMin],
  );

  // Empty input ⇒ no key, no session, no interference. LiveSim renders this
  // hook unconditionally even in single-line scope, so it has to stay inert.
  const key = useMemo(() => (spec.lines.length > 0 ? simSpecKey(spec) : ''), [spec]);

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
  const reset = useSimSession((s) => s.reset);
  const step = useSimSession((s) => s.step);
  const mode = useProject((s) => s.time.executionMode);

  const states = useMemo<SimState[]>(
    () => lineTwins.map((_, i) => session?.runs[i]?.state ?? emptyPmlSimState()),
    [session, lineTwins],
  );
  const views = useMemo<PmlTwinView[]>(
    () =>
      lineTwins.map(
        (_, i) =>
          session?.runs[i]?.view ?? {
            stations: [],
            infrastructure: [],
            meta: null as unknown as BuildFromTwinMeta,
            nonFifoStations: [],
          },
      ),
    [session, lineTwins],
  );
  const results = useMemo<(PmlSimResult | null)[]>(
    () => lineTwins.map((_, i) => session?.runs[i]?.result ?? null),
    [session, lineTwins],
  );

  return { states, views, results, playing, speed, mode, setPlaying, setSpeed, reset, step };
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
