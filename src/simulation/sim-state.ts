/**
 * Engine-shape contract types — what consumers of a sim render against.
 *
 * Originally lived in `engine.ts` next to the legacy `SimEngine`. Extracted
 * so the PML hooks (and any future engine) can produce the same shape
 * without depending on the legacy engine module, which has been retired.
 *
 * Everything here is data — no runtime, no React. Both the PML adapter
 * (`pml-to-sim-state.ts`) and the legacy data-builders (`model.ts`,
 * `model-from-twin.ts`) read these definitions.
 */

import type { Operation } from '../domain';
import type { ServiceDist } from './distributions';
import type {
  AnalyticalKpis,
  KendallNotation,
  QueueDiscipline,
} from './queueing';
import type { ModelTimeUnit } from './timeUnit';

/**
 * Per-line metadata bag — originally consumed by the legacy `SimEngine` as
 * its input config, now retained for two consumers:
 *   1. The data builders (`model.ts`, `model-from-twin.ts`) emit it so
 *      downstream views (Reports, LiveSim per-line strip, Scenarios) can
 *      read `bundleSize`, `stationServers`, `operations`, `garmentTemplateId`.
 *   2. Scenario blobs persisted by older sessions carry it verbatim.
 *
 * Nothing in this codebase runs the legacy engine anymore; the type is
 * data-only documentation of the per-line bulletin shape.
 */
export interface SimConfig {
  garmentTemplateId: string;
  operations: Operation[];
  /** Number of parallel operators on each operation, indexed identically. */
  stationServers: number[];
  /** Pieces per bundle — affects throughput per arrival but not SMV. */
  bundleSize: number;
  /** Bundle arrivals per hour. Tune to keep the line loaded. */
  arrivalRatePerHour: number;
  /** Coefficient of variation around the SMV mean for the legacy uniform
   *  default. Per-station distributions in `serviceDistributions` override
   *  this for any station that supplies one. */
  smvVariance: number;
  randomSeed: number;
  /** Optional per-operation efficiency multiplier (e.g. 0.85 for an
   *  operator running at 85 % of standard). */
  opEfficiency?: Record<string, number>;
  /** Per-station service-time distribution. Parallel to `stationServers`. */
  serviceDistributions?: (ServiceDist | undefined)[];
  /** Per-station system capacity (queue + in-service). */
  stationCapacities?: (number | undefined)[];
  /** Per-station queue discipline. Missing entry or undefined ⇒ FCFS. */
  queueDisciplines?: (QueueDiscipline | undefined)[];
  /** Engine time unit. Default `'minute'`. */
  modelTimeUnit?: ModelTimeUnit;
}

export interface StationView {
  /**
   * Workstation id this row renders.
   *
   * Stable across frames and UNIQUE even when two stations on the same line
   * run the same operation — which is what happens on any balanced line, and
   * which made `key={s.opId}` produce duplicate React keys. Also the correct
   * thing to address a drill-down by.
   */
  wsId: string;
  /** Operation id this station runs. */
  opId: string;
  opCode?: string;
  opName: string;
  /** Machine type — the canonical asset key. Drives the visual sprite/colour
   *  in the ISO/TOP/LOGIC views via `MACHINE_CATALOG[machineCode]`. */
  machineCode: string;
  smv: number;
  serversTotal: number;
  /** Servers currently busy. */
  busy: number;
  /** Bundles waiting in queue. */
  queueLen: number;
  /** Bundles blocked-after-service here right now: service finished but the
   *  piece can't advance because the downstream buffer is full. 0 under
   *  unbounded buffers. Distinct from `busy` (productive service) — drives the
   *  "blocked station" tint in the sim views. */
  blocked: number;
  /** Bundles completed at this station so far. */
  produced: number;
  /** Cumulative busy minutes across all servers. */
  totalBusyTime: number;
  /** 0..1, derived from totalBusyTime / (serversTotal · time). */
  utilization: number;
  // ── Queueing-theory layer ────────────────────────────────────────────────
  /** Kendall–Lee classification of this station. */
  notation: KendallNotation;
  /** Effective service distribution. */
  serviceDist: ServiceDist;
  /** System capacity for this station (Infinity if unbounded). */
  capacity: number;
  /** Bundles OFFERED to this station: admitted + balked. A real engine
   *  counter now, not the `produced + queueLen + busy` proxy it used to be. */
  arrivals: number;
  /** Bundles rejected because the system was full. 0 for infinite-buffer. */
  balked: number;
  /** OFFERED arrival rate λ (per hour) = (admitted + balked) / elapsed hours.
   *  Previously this was the DEPARTURE rate (produced / elapsed), which at a
   *  saturated bottleneck drives λ → μ, hence ρ → 1 by construction and an
   *  analytical Lq understated at exactly the station that matters. */
  lambda: number;
  /** Analytical KPIs against the observed λ and the station's μ. */
  analytical: AnalyticalKpis;
  /** ρ < 1 (infinite buffer) or always-true (finite buffer). */
  isStable: boolean;

  // ── Measured counterparts to `analytical` ─────────────────────────────────
  // Same quantities the closed-form layer predicts, but observed from the run,
  // so a chart can plot one against the other and a test can assert they
  // converge. All windowed to the post-warm-up span when one is supplied.
  /** Admitted arrival rate λ_eff (per hour) — excludes balks. */
  lambdaEff: number;
  /** Time-average L̄q = ∫Lq dt / window. */
  LqObserved: number;
  /** Time-average L̄ = ∫L dt / window. */
  LObserved: number;
  /** MEASURED mean queue wait in MINUTES — a real mean of per-agent waits,
   *  not Lq/λ rearranged. This is what makes Little's law a testable
   *  invariant here rather than a restatement of a definition. */
  WqObservedMin: number;
  /** Fraction of offered arrivals turned away, 0..1. Compare against the
   *  analytical P_N for a finite-buffer station. */
  balkFraction: number;
  /**
   * True when the engine could not honour the authored discipline.
   *
   * Now always false for Service and Queue blocks: the engine picks the next
   * agent per discipline (FCFS head, SIRO uniform draw, Priority by order
   * rank). Kept on the view because the analytical layer still reports
   * discipline-invariant means — L, Lq, W and Wq are the same under all three,
   * exactly as the textbook's Model III states — so a surface that wants to
   * caveat the wait *distribution* has somewhere to read it from.
   */
  disciplineNotSimulated: boolean;
}

export interface HistoryPoint {
  time: number;        // sim minutes
  produced: number;    // bundles sunk
  wip: number;         // bundles in flight
  throughputPerHr: number;
}

/**
 * Per-station time-series sample. Parallel to `HistoryPoint` but emitted for
 * each station every 5 sim-minutes.
 */
export interface StationHistoryPoint {
  time: number;
  /** Cumulative ρ̂ = ∫busy dt / (c · t). Genuinely cumulative now: this used
   *  to be the INSTANTANEOUS `busy / servers`, i.e. a 0/1 square wave at
   *  c = 1, which is why the plotted line could never settle onto the flat
   *  analytical ρ drawn beside it. */
  utilization: number;
  /** Time-average L̄ = ∫L dt / t. */
  inSystem: number;
  /** Time-average L̄q = ∫Lq dt / t. */
  queueLen: number;
  /** MEASURED mean queue wait Ŵq in minutes = Σ waits / count. */
  meanWqMin: number;
  /** Instantaneous in-system count at this instant. Kept alongside the
   *  time-average because the animated floor wants "how many are standing
   *  here right now", not a running mean. */
  inSystemNow: number;
  /** Instantaneous queue depth at this instant. */
  queueLenNow: number;
}

export interface SimState {
  time: number;
  produced: number;
  producedPieces: number;
  totalArrivals: number;
  meanLeadTime: number;
  utilization: number;
  bottleneckOpIndex: number;
  stations: StationView[];
  history: HistoryPoint[];
  /** Per-station time-series, parallel to `stations`. */
  stationHistory: StationHistoryPoint[][];
  /** Rolling event log for the LiveSim feed. Newest first. Capped at 60. */
  events: { time: number; tag: 'OUT' | 'IN' | 'STARVE' | 'BLOCK'; msg: string }[];
  /**
   * Engine diagnostics about the MODEL (missing Sink, dropped pieces on a
   * fan-out, a rework route that doesn't resolve, …). Deliberately separate
   * from `events`: these used to be poured into the event feed tagged BLOCK
   * and stamped with the current frame time, which made a configuration
   * problem look like something that just happened on the floor.
   */
  warnings: string[];
}
