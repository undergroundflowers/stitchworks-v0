/**
 * Adapter — PML sample → legacy `SimState` shape.
 *
 * The PML discrete-event engine (`pml-engine.ts`) is the only engine going
 * forward, but every consumer of the legacy `SimEngine` (LiveSim, Scenarios,
 * QueueAnalytics, etc.) reads the legacy `SimState`
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
import {
  analyticalKpis,
  classify,
  type AnalyticalKpis,
  type KendallNotation,
  type QueueDiscipline,
} from './queueing';
import type {
  HistoryPoint,
  SimState,
  StationHistoryPoint,
  StationView,
} from './sim-state';
import {
  serversFor,
  systemCapacityFor,
  type PmlSimResult,
  type PmlSimSample,
} from './pml-engine';
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
  /**
   * Names of stations whose authored queue discipline is NOT FCFS. The engine
   * dequeues strictly FIFO (`queue.shift()`), so SIRO / Priority change the
   * Kendall label and nothing else. Surfaced so the UI can badge them "not
   * simulated" rather than implying the discipline was honoured.
   *
   * Worth noting for the user: Lq, L and ρ are discipline-invariant for
   * M/M/c, so the analytical values stay valid — it is the wait-time
   * DISTRIBUTION that differs, not its mean.
   */
  nonFifoStations: string[];
}

export interface StationStatic {
  wsId: string;
  ws: Workstation;
  /** opId from `ws.operation.opId` or a synthesized fallback (`ws-${id}`). */
  opId: string;
  opCode?: string;
  opName: string;
  machineCode: string;
  smv: number;
  serviceDist: ServiceDist;
  /** System capacity N (queue + in-service). Infinity when unbounded.
   *  Resolved through the engine's own `systemCapacityFor`. */
  capacity: number;
  /** Parallel servers c. Resolved through the engine's own `serversFor`. */
  servers: number;
  /** Authored queue discipline. The engine dequeues FIFO regardless — see
   *  the warning raised in `buildPmlTwinView`. */
  discipline: QueueDiscipline;
  /**
   * Kendall–Lee notation. STATIC for the whole run, so it is resolved once
   * here instead of per-frame-per-station: `classify` builds a label string
   * and the M/M/c path runs factorials, neither of which should be in the
   * playback hot loop.
   */
  notation: KendallNotation;
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

  /** Stations whose authored discipline the engine can't honour — collected
   *  so the UI can badge them instead of silently implying SIRO/Priority was
   *  simulated. */
  const nonFifoStations: string[] = [];

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
    // c and N come from the ENGINE's own resolvers. This used to read
    // `ws.block?.params?.capacity` — the ResourcePool unit count, not the
    // system capacity K. The engine reads `queueCapacity` via
    // `systemCapacityFor`, so an authored finite buffer correctly
    // back-pressured the DES while the analytical layer still classified the
    // station M/M/c with N = ∞: the M/M/c/N branch of `analyticalKpis` could
    // never fire, and Lq/Wq were reported for the wrong model. Sharing one
    // resolver is what makes that class of drift impossible.
    const capacity = systemCapacityFor(ws);
    const servers = serversFor(ws);
    const discipline = op?.queueDiscipline ?? 'FCFS';
    if (discipline !== 'FCFS') nonFifoStations.push(opName);

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
      servers,
      discipline,
      notation: classify(serviceDist, servers, capacity, discipline),
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

  return { stations, infrastructure, meta, nonFifoStations };
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
    warnings: [],
  };
}

/** Neutral analytical result for a station whose λ/μ combination the
 *  closed-form layer refuses (ρ ≥ 1 on an unbounded queue, μ = 0, …). */
function unstableAnalytical(lambda: number): AnalyticalKpis {
  return {
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

function safeAnalytical(
  notation: KendallNotation,
  lambda: number,
  dist: ServiceDist,
): AnalyticalKpis {
  try {
    return analyticalKpis(notation, lambda, dist);
  } catch {
    return unstableAnalytical(lambda);
  }
}

/** Zero row for a station the sample doesn't carry (defensive — only happens
 *  if a twin and a run disagree about their workstation set). */
function emptyStationView(st: StationStatic): StationView {
  return {
    wsId: st.wsId,
    opId: st.opId,
    opCode: st.opCode,
    opName: st.opName,
    machineCode: st.machineCode,
    smv: st.smv,
    serversTotal: st.servers,
    busy: 0,
    queueLen: 0,
    blocked: 0,
    produced: 0,
    totalBusyTime: 0,
    utilization: 0,
    notation: st.notation,
    serviceDist: st.serviceDist,
    capacity: st.capacity,
    arrivals: 0,
    balked: 0,
    lambda: 0,
    analytical: unstableAnalytical(0),
    isStable: false,
    lambdaEff: 0,
    LqObserved: 0,
    LObserved: 0,
    WqObservedMin: 0,
    balkFraction: 0,
    disciplineNotSimulated: st.discipline !== 'FCFS',
  };
}

/**
 * One line-level history point from ONE sample. O(stations), no history walk.
 */
export function historyPointFrom(view: PmlTwinView, sample: PmlSimSample): HistoryPoint {
  const hr = sample.time / 60;
  let wip = 0;
  for (const st of view.stations) {
    const snap = sample.blocks[st.wsId];
    if (snap) wip += snap.queueLen + snap.busy;
  }
  return {
    time: sample.time,
    produced: sample.produced,
    wip,
    throughputPerHr: hr > 0 ? sample.produced / hr : 0,
  };
}

/**
 * One per-station history point. O(1).
 *
 * Every time-average is computed by DIFFERENCING the cumulative integrals
 * against `warmupSample`, so the plotted curve is the post-transient estimate
 * when a warm-up is in play and the whole-run estimate when it isn't.
 */
export function stationHistoryPointFrom(
  st: StationStatic,
  sample: PmlSimSample,
  warmupSample?: PmlSimSample,
): StationHistoryPoint {
  const snap = sample.blocks[st.wsId];
  const base = warmupSample?.blocks[st.wsId];
  const t0 = warmupSample?.time ?? 0;
  const win = Math.max(1e-9, sample.time - t0);
  if (!snap) {
    return {
      time: sample.time,
      utilization: 0,
      inSystem: 0,
      queueLen: 0,
      meanWqMin: 0,
      inSystemNow: 0,
      queueLenNow: 0,
    };
  }
  const dBusy = snap.areaBusy - (base?.areaBusy ?? 0);
  const dAreaL = snap.areaL - (base?.areaL ?? 0);
  const dAreaLq = snap.areaLq - (base?.areaLq ?? 0);
  const dWaitSum = snap.waitSumMin - (base?.waitSumMin ?? 0);
  const dWaitN = snap.waitStarts - (base?.waitStarts ?? 0);
  const c = Math.max(1, snap.serversTotal);
  return {
    time: sample.time,
    utilization: dBusy / (c * win),
    inSystem: dAreaL / win,
    queueLen: dAreaLq / win,
    meanWqMin: dWaitN > 0 ? dWaitSum / dWaitN : 0,
    inSystemNow: snap.queueLen + snap.busy,
    queueLenNow: snap.queueLen,
  };
}

/** Derive an event feed from what changed between two samples. */
function eventsBetween(
  view: PmlTwinView,
  prev: PmlSimSample | undefined,
  cur: PmlSimSample,
): SimState['events'] {
  const out: SimState['events'] = [];
  if (!prev) return out;
  const dProduced = cur.produced - prev.produced;
  if (dProduced > 0) {
    out.push({ time: cur.time, tag: 'OUT', msg: `${dProduced} pcs sunk` });
  }
  for (const st of view.stations) {
    const a = prev.blocks[st.wsId];
    const b = cur.blocks[st.wsId];
    if (!a || !b) continue;
    if (b.blocked > 0 && a.blocked === 0) {
      out.push({ time: cur.time, tag: 'BLOCK', msg: `${st.opName} blocked — downstream buffer full` });
    }
    if (b.balked > a.balked) {
      out.push({
        time: cur.time,
        tag: 'IN',
        msg: `${st.opName} turned away ${b.balked - a.balked} arrival(s) — buffer full`,
      });
    }
    if (b.busy === 0 && b.queueLen === 0 && a.busy > 0) {
      out.push({ time: cur.time, tag: 'STARVE', msg: `${st.opName} starved — nothing to work on` });
    }
  }
  return out.slice(0, 60);
}

export interface SampleToStateOpts {
  /**
   * Sample at the warm-up boundary. When supplied, every time-averaged
   * observable is computed by differencing (`sample − warmupSample`), so the
   * displayed ρ̂ / L̄q / Ŵq describe the post-transient regime only. Omit for
   * whole-run figures.
   */
  warmupSample?: PmlSimSample;
}

/**
 * Convert one PML sample into a legacy `SimState`. The caller is expected
 * to memoize a `PmlTwinView` for the active twin and pass it in — it carries
 * everything that doesn't change frame-to-frame (opId / opName / smv, and now
 * the Kendall classification too).
 *
 * `history` and `stationHistory` are still rebuilt from `priorSamples` here.
 * That is O(frames × stations) per rendered frame and is replaced by an
 * incremental append in the shared sim session; the pure per-point builders
 * above (`historyPointFrom`, `stationHistoryPointFrom`) are what that will
 * call, and are used below so both paths produce identical points.
 */
export function pmlSampleToSimState(
  view: PmlTwinView,
  sample: PmlSimSample,
  result: PmlSimResult | null,
  priorSamples: PmlSimSample[],
  opts?: SampleToStateOpts,
): SimState {
  const t = sample.time;
  const warm = opts?.warmupSample;
  const t0 = warm?.time ?? 0;
  // The observation window. Everything below is measured across it, so a
  // caller can discard the start-up transient without the engine or the
  // charts having to know where the boundary is.
  const win = Math.max(1e-9, t - t0);
  const winHr = win / 60;

  const stations: StationView[] = view.stations.map((st) => {
    const snap = sample.blocks[st.wsId];
    if (!snap) return emptyStationView(st);
    const base = warm?.blocks[st.wsId];

    // Windowed deltas. With no warm-up these equal the raw cumulative values,
    // so behaviour is unchanged for callers that don't pass one.
    const dArr = snap.arrivals - (base?.arrivals ?? 0);
    const dBalk = snap.balked - (base?.balked ?? 0);
    const dAreaLq = snap.areaLq - (base?.areaLq ?? 0);
    const dAreaL = snap.areaL - (base?.areaL ?? 0);
    const dBusy = snap.areaBusy - (base?.areaBusy ?? 0);
    const dWaitSum = snap.waitSumMin - (base?.waitSumMin ?? 0);
    const dWaitN = snap.waitStarts - (base?.waitStarts ?? 0);

    const serversTotal = Math.max(1, snap.serversTotal);
    const offered = dArr + dBalk;
    // λ is the OFFERED ARRIVAL rate. Feeding the departure rate here made
    // ρ → 1 by construction at any saturated station.
    const lambda = offered / winHr;
    // Cumulative ρ̂ over the window, from the productive-service integral.
    const utilization = dBusy / (serversTotal * win);
    const analytical = safeAnalytical(st.notation, lambda, st.serviceDist);

    return {
      wsId: st.wsId,
      opId: st.opId,
      opCode: st.opCode,
      opName: st.opName,
      machineCode: st.machineCode,
      smv: st.smv,
      serversTotal,
      busy: snap.busy,
      queueLen: snap.queueLen,
      blocked: snap.blocked,
      produced: snap.producedPieces,
      totalBusyTime: dBusy,
      utilization,
      notation: st.notation,
      serviceDist: st.serviceDist,
      capacity: st.capacity,
      arrivals: offered,
      balked: dBalk,
      lambda,
      analytical,
      isStable: analytical.isStable,
      lambdaEff: dArr / winHr,
      LqObserved: dAreaLq / win,
      LObserved: dAreaL / win,
      WqObservedMin: dWaitN > 0 ? dWaitSum / dWaitN : 0,
      balkFraction: offered > 0 ? dBalk / offered : 0,
      disciplineNotSimulated: st.discipline !== 'FCFS',
    };
  });

  // `bottleneckOpIndex` is the index into `stations[]` of the workstation
  // with the live bottleneck. Map the wsId carried on the sample back to
  // a stations[] index — view.stations preserves the same ordering.
  const bottleneckOpIndex = sample.bottleneckWsId
    ? view.stations.findIndex((s) => s.wsId === sample.bottleneckWsId)
    : -1;

  // History: rebuild from priorSamples, downsampled to one point per 5 sim
  // minutes so the chart cadence matches what existing consumers expect.
  const history: HistoryPoint[] = [];
  const stationHistory: StationHistoryPoint[][] = view.stations.map(() => []);
  let lastHistTime = -Infinity;
  for (const s of priorSamples) {
    if (s.time - lastHistTime < 5 && s.time !== t) continue;
    lastHistTime = s.time;
    history.push(historyPointFrom(view, s));
    view.stations.forEach((st, i) => {
      stationHistory[i].push(stationHistoryPointFrom(st, s, warm));
    });
  }

  // Line-level utilisation, weighted by servers rather than an unweighted mean
  // of per-station percentages — a 3-server station at 90 % and a 1-server
  // station at 30 % is not "60 % utilised".
  let busyNumer = 0;
  let busyDenom = 0;
  for (const st of stations) {
    busyNumer += st.totalBusyTime;
    busyDenom += st.serversTotal * win;
  }
  const utilization = busyDenom > 0 ? busyNumer / busyDenom : 0;

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
    // Real events derived from what changed since the previous sample. This
    // used to be `result.warnings` re-tagged as BLOCK and stamped with the
    // current frame time, so a configuration diagnostic read as a floor event.
    events: eventsBetween(
      view,
      priorSamples.length >= 2 ? priorSamples[priorSamples.length - 2] : undefined,
      sample,
    ),
    warnings: result?.warnings ?? [],
  };
}
