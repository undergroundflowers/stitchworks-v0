/**
 * Adapter — PML sample → legacy `SimState` shape.
 *
 * The PML discrete-event engine (`pml-engine.ts`) is the only engine going
 * forward, but every consumer of the legacy `SimEngine` (LiveSim, LiveFloor,
 * Scenarios, QueueAnalytics, etc.) reads the legacy `SimState`
 * shape — `state.stations[]`, `state.history[]`, `state.bottleneckOpIndex`,
 * `state.events[]`. Rather than rewrite every view to read PML samples
 * directly, we map each `PmlSimSample` into the legacy shape here.
 *
 * One workstation = one `StationView`. The legacy adapter collapsed
 * multiple workstations on the same opId into a multi-server station, but
 * PML treats each block as its own node — that's closer to what the user
 * authored in the Builder and what the ISO view should render. The
 * `BuildFromTwinMeta.workstations` list is built one-per-Service-block so
 * the ISO/TOP/HEAT layout uses the authored positions.
 *
 * Non-Service blocks (Source, Sink, ResourcePool, Queue, Hold, Wait,
 * Seize, Release, SelectOutput, SelectOutput*) are wired into the engine
 * but are not "stations" in the apparel sense — they're filtered out of
 * `stations[]` and surfaced as `infrastructure` on the meta object.
 */

import type { GarmentTemplate, Operation } from '../domain';
import { TWIN_SCHEMA_VERSION, type Twin, type Workstation } from '../domain/twin';
import {
  getBlockSpec,
  getBlockParams,
  type PmlBlockKind,
} from '../domain/pml';
import { defaultDist, distFromOpNotes, scaleServiceDist } from './distributions';
import type { ServiceDist } from './distributions';
import { analyticalKpis, classify, type AnalyticalKpis } from './queueing';
import type {
  HistoryPoint,
  SimState,
  StationHistoryPoint,
  StationView,
} from './sim-state';
import type { PmlSimResult, PmlSimSample } from './pml-engine';
import type {
  BuildFromTwinMeta,
  InfraWorkstation,
  TwinStationMeta,
  TwinWorkstationCell,
} from './model-from-twin';

/** PML block kinds that are infrastructure, not "stations" with operators. */
const NON_STATION_KINDS = new Set<PmlBlockKind>([
  'Source',
  'Sink',
  'ResourcePool',
  'Queue',
  'Hold',
  'Wait',
  'Seize',
  'Release',
  'SelectOutput',
  'SelectOutput5',
  'Batch',
  'Unbatch',
  'Combine',
  'Match',
  'Assembler',
  'Conveyor',
  'MoveTo',
  'Delay',
]);

/**
 * Pre-computed view of the twin's Service blocks, in canvas-position order.
 * Built once per (twin, garment) and reused across every sample render.
 * Holds the static metadata each `StationView` needs that isn't in a
 * PML sample (opId, opCode, opName, smv, machineCode, capacity, etc.).
 */
export interface PmlTwinView {
  /** Service-kind workstations in render order — one StationView per cell. */
  stations: StationStatic[];
  /** Non-Service blocks surfaced for the meta object. */
  infrastructure: InfraWorkstation[];
  /** Cached `BuildFromTwinMeta` for the ISO/TOP/HEAT layout. */
  meta: BuildFromTwinMeta;
}

interface StationStatic {
  wsId: string;
  ws: Workstation;
  /** opId from `ws.operation.opId` or a synthesized fallback (`ws-${id}`). */
  opId: string;
  opCode?: string;
  opName: string;
  machineCode: string;
  smv: number;
  serviceDist: ServiceDist;
  /** System capacity (queue + in-service). Infinity when unbounded. */
  capacity: number;
}

/**
 * Resolve static per-station metadata from the twin. Pure function — call
 * once when the twin changes and reuse across sample renders. The result
 * also doubles as the layout meta for the legacy ISO/TOP/HEAT views.
 */
export function buildPmlTwinView(twin: Twin, garment?: GarmentTemplate): PmlTwinView {
  const stations: StationStatic[] = [];
  const infrastructure: InfraWorkstation[] = [];
  const twinMetaStations: TwinStationMeta[] = [];
  const twinMetaCells: TwinWorkstationCell[] = [];

  // Resolve the garment template if one is provided so we can carry opCode /
  // opName from the bulletin when the workstation only pins an opId. Falls
  // back to ws.operation fields when no garment is supplied.
  const opById = new Map<string, Operation>();
  if (garment) {
    for (const op of garment.operations) opById.set(op.id, op);
  }

  // Per-station share factor — mirrors pml-engine's buildShareFactorMap.
  // Sum all assignments' shareFracs per ws, cap at 1 (single-server cell).
  // Rotation members participate in the sum because each rotating operator
  // contributes their time-fraction of presence; the cell-wide capacity
  // = total operators / total rotation stations.
  const shareFactorByWs = new Map<string, number>();
  const wsSums = new Map<string, number>();
  for (const a of twin.assignments ?? []) {
    const sf = a.shareFrac ?? (a.role === 'primary' ? 1 : a.role === 'helper' ? 0.3 : 0);
    if (sf <= 0) continue;
    wsSums.set(a.wsId, (wsSums.get(a.wsId) ?? 0) + sf);
  }
  for (const [wsId, total] of wsSums) {
    const capped = Math.min(1, total);
    if (capped < 1) shareFactorByWs.set(wsId, capped);
  }

  for (const ws of twin.workstations) {
    const spec = getBlockSpec(ws);
    if (NON_STATION_KINDS.has(spec.kind)) {
      infrastructure.push({
        wsId: ws.id,
        name: ws.name,
        role: spec.kind as InfraWorkstation['role'],
      });
      continue;
    }
    // It's a Service-kind block — surface it as a station.
    const opId = ws.operation.opId || `ws-${ws.id}`;
    const op = ws.operation.opId ? opById.get(ws.operation.opId) : undefined;
    const opCode = op?.code;
    const opName = op?.name ?? ws.name;
    const machineCode = op?.machineCode ?? 'GENERIC';
    const params = getBlockParams(ws);
    const smv = op?.smv ?? params.cycleS / 60;
    // ServiceDist resolves in priority order: explicit op.serviceDistribution →
    // op.notes StatFit string → workstation cycle distribution → uniform around smv.
    const opDist = op?.serviceDistribution;
    const notesDist = distFromOpNotes(op?.notes) ?? undefined;
    const nominalDist = opDist ?? notesDist ?? params.cycleDist ?? defaultDist(smv);
    // Inflate the nominal service mean by 1/shareFactor so analytical KPIs
    // see the same effective rate the engine cycles at when an operator is
    // shared. shareFactor=1 ⇒ identity, no allocation churn.
    const shareFactor = shareFactorByWs.get(ws.id) ?? 1;
    const serviceDist = shareFactor < 1 ? scaleServiceDist(nominalDist, 1 / shareFactor) : nominalDist;
    const capacity = ws.block?.params?.capacity ?? Infinity;

    stations.push({
      wsId: ws.id,
      ws,
      opId,
      opCode,
      opName,
      machineCode,
      smv: shareFactor < 1 ? smv / shareFactor : smv,
      serviceDist,
      capacity,
    });
    twinMetaStations.push({
      opId,
      wsIds: [ws.id],
      gx: ws.position.x,
      gy: ws.position.y,
      workersRequested: ws.resources?.workersRequired ?? 1,
    });
    twinMetaCells.push({
      wsId: ws.id,
      opId,
      gx: ws.position.x,
      gy: ws.position.y,
      rotation: ws.rotation ?? 0,
      lineId: ws.lineId,
      name: ws.name,
    });
  }

  // Seed operators — prefer the assignment count (distinct operators) when
  // the twin carries assignments, otherwise fall back to the legacy
  // `workersRequired` sum so older saves without operator/assignment
  // records still simulate. This keeps the pool size honest after a
  // SHARE gesture, where workersRequired stays 1 per station but the
  // operator count goes down.
  const distinctAssignedOps = (() => {
    const wsSet = new Set(stations.map((s) => s.wsId));
    const ops = new Set<string>();
    for (const a of twin.assignments ?? []) {
      if (wsSet.has(a.wsId)) ops.add(a.operatorId);
    }
    return ops.size;
  })();
  const seedOperators = distinctAssignedOps > 0
    ? distinctAssignedOps
    : stations.reduce((s, st) => s + (st.ws.resources?.workersRequired ?? 1), 0);

  const meta: BuildFromTwinMeta = {
    simulatedWsIds: stations.map((s) => s.wsId),
    skipped: [],
    infrastructure,
    seedOperators,
    seedBundleSize: 1,
    topologySource: 'connectors',
    stations: twinMetaStations,
    workstations: twinMetaCells,
    // `garment` is required on the meta interface — feed in the supplied one
    // or a minimal stand-in so the renderer doesn't crash when no garment
    // is pinned (PML doesn't care which garment flows through it).
    garment: garment ?? ({
      id: 'pml-twin',
      name: twin.name,
      defaultBundleSize: 1,
      operations: [],
    } as unknown as GarmentTemplate),
    garmentPinned: !!garment,
  };

  return { stations, infrastructure, meta };
}

/**
 * Empty twin stand-in for consumers that need to call `usePmlSim` before a
 * real twin is available — keeps the hook call unconditional (React hook
 * order rule). `runPmlSim` short-circuits when `workstations.length === 0`
 * so this never actually runs the engine.
 */
export const EMPTY_TWIN: Twin = {
  schemaVersion: TWIN_SCHEMA_VERSION,
  id: 'empty',
  name: 'empty',
  parentTwinId: null,
  isCanonical: false,
  createdAt: new Date(0).toISOString(),
  modifiedAt: new Date(0).toISOString(),
  gridW: 1,
  gridH: 1,
  departments: [],
  lines: [],
  workstations: [],
  connectors: [],
};

/**
 * Empty `SimState` — used before the first PML run completes, so consumers
 * can render an empty-state shell instead of crashing on `state.stations[]`.
 */
export function emptyPmlSimState(): SimState {
  return {
    time: 0,
    produced: 0,
    producedPieces: 0,
    totalArrivals: 0,
    meanLeadTime: 0,
    utilization: 0,
    bottleneckOpIndex: -1,
    stations: [],
    history: [],
    stationHistory: [],
    events: [],
  };
}

/**
 * Convert one PML sample into a legacy `SimState`. The caller is expected
 * to memoize a `PmlTwinView` for the active twin and pass it in — it carries
 * everything that doesn't change frame-to-frame (opId / opName / smv etc.).
 *
 * `history` and `stationHistory` are built incrementally from `priorSamples`,
 * sampled at 5-minute intervals to match the legacy engine's cadence so
 * existing chart consumers (QueueAnalytics, KPI cards) work unchanged.
 */
export function pmlSampleToSimState(
  view: PmlTwinView,
  sample: PmlSimSample,
  result: PmlSimResult | null,
  priorSamples: PmlSimSample[],
): SimState {
  const t = sample.time;
  const elapsedHr = t / 60;
  const stations: StationView[] = view.stations.map((st) => {
    const snap = sample.blocks.get(st.wsId);
    const busy = snap?.busy ?? 0;
    const queueLen = snap?.queueLen ?? 0;
    const produced = snap?.producedPieces ?? 0;
    const serversTotal = snap?.serversTotal ?? 1;
    // Utilization shape matches the legacy engine's contract:
    //   utilization = totalBusyTime / (serversTotal · time)
    //
    // When the PML run has finished, `result.blocks` carries the cumulative
    // `busyMin` per Service block — use that directly, which matches the
    // legacy "cumulative ρ̂" Reports / KPI tiles expect. Mid-run (no result
    // yet) we approximate from the live `busy` slot count; both shapes
    // overlap when the line is at steady state.
    const observed = result?.blocks.get(st.wsId);
    const cumulativeBusyMin = observed?.busyMin ?? 0;
    const totalBusyTime = result ? cumulativeBusyMin : busy * t;
    const utilization =
      serversTotal > 0 && t > 0
        ? totalBusyTime / (serversTotal * t)
        : 0;
    const lambda = elapsedHr > 0 ? produced / elapsedHr : 0;
    const notation = classify(st.serviceDist, serversTotal, st.capacity, 'FCFS');
    let analytical: AnalyticalKpis;
    try {
      analytical = analyticalKpis(notation, lambda, st.serviceDist);
    } catch {
      analytical = {
        rho: 0,
        P0: 1,
        Pn: () => 0,
        Lq: 0,
        Wq: 0,
        L: 0,
        W: 0,
        D: NaN,
        isStable: false,
        pWaitGreaterThan: () => 0,
        lambdaEff: lambda,
      };
    }
    return {
      opId: st.opId,
      opCode: st.opCode,
      opName: st.opName,
      machineCode: st.machineCode,
      smv: st.smv,
      serversTotal,
      busy,
      queueLen,
      produced,
      totalBusyTime,
      utilization,
      notation,
      serviceDist: st.serviceDist,
      capacity: st.capacity,
      // Without per-station arrival accounting in PML samples, the best
      // proxy is the cumulative pieces processed plus what's currently
      // queued or in service — the offered count to this block over the run.
      arrivals: produced + queueLen + busy,
      balked: 0,
      lambda,
      analytical,
      isStable: analytical.isStable,
    };
  });

  // `bottleneckOpIndex` is the index into `stations[]` of the workstation
  // with the live bottleneck. Map the wsId carried on the sample back to
  // a stations[] index — view.stations preserves the same ordering.
  const bottleneckOpIndex = sample.bottleneckWsId
    ? view.stations.findIndex((s) => s.wsId === sample.bottleneckWsId)
    : -1;

  // History: rebuild incrementally from priorSamples, downsampled to one
  // point per 5 sim-minutes so the chart cadence matches legacy.
  const history: HistoryPoint[] = [];
  const stationHistory: StationHistoryPoint[][] = view.stations.map(() => []);
  let lastHistTime = -Infinity;
  for (const s of priorSamples) {
    if (s.time - lastHistTime < 5 && s.time !== t) continue;
    lastHistTime = s.time;
    const hr = s.time / 60;
    const tputPerHr = hr > 0 ? s.produced / hr : 0;
    // WIP = sum of (queueLen + inService) across stations at this sample.
    let wip = 0;
    for (const st of view.stations) {
      const snap = s.blocks.get(st.wsId);
      if (snap) wip += snap.queueLen + snap.busy;
    }
    history.push({
      time: s.time,
      produced: s.produced,
      wip,
      throughputPerHr: tputPerHr,
    });
    view.stations.forEach((st, i) => {
      const snap = s.blocks.get(st.wsId);
      const busy = snap?.busy ?? 0;
      const qL = snap?.queueLen ?? 0;
      const sv = snap?.serversTotal ?? 1;
      stationHistory[i].push({
        time: s.time,
        utilization: sv > 0 ? busy / sv : 0,
        inSystem: busy + qL,
        queueLen: qL,
        // Running Wq is approximated by Little's law on the current snapshot:
        // Wq ≈ Lq / λ. Approximate because we lack the per-bundle wait sum
        // in PML samples — accurate over the long run for stable stations.
        meanWqMin: (() => {
          const elapsedH = s.time / 60;
          const produced = snap?.producedPieces ?? 0;
          const lam = elapsedH > 0 ? produced / elapsedH : 0;
          return lam > 0 ? (qL / lam) * 60 : 0;
        })(),
      });
    });
  }

  // Aggregate utilization across all stations — average ρ̂ at this moment.
  const utilization =
    stations.length > 0
      ? stations.reduce((s, st) => s + st.utilization, 0) / stations.length
      : 0;

  // Total arrivals across the line: every Source block's outflow up to `t`.
  // Approximated by max(produced + WIP) across the line — the bound is
  // tight when there are no losses, which PML guarantees today.
  const wipNow = stations.reduce((s, st) => s + st.queueLen + st.busy, 0);

  return {
    time: t,
    produced: sample.produced,
    producedPieces: sample.produced,
    totalArrivals: sample.produced + wipNow,
    meanLeadTime: sample.meanLeadTimeMin,
    utilization,
    bottleneckOpIndex,
    stations,
    history,
    stationHistory,
    // Event log is not yet emitted from PML samples — keep empty so consumers
    // that read `state.events[]` don't crash. Follow-up ticket: stream sink
    // / starve / block events from the engine into the sample.
    events: result?.warnings.slice(0, 60).map((msg, i) => ({
      time: t,
      tag: 'BLOCK' as const,
      msg: `${i + 1}. ${msg}`,
    })) ?? [],
  };
}
