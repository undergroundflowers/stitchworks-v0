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
  /** Bundles offered to this station (queue + service + balked). */
  arrivals: number;
  /** Bundles rejected because system was full. 0 for infinite-buffer. */
  balked: number;
  /** Observed arrival rate λ (per hour). */
  lambda: number;
  /** Analytical KPIs against the observed λ and the station's μ. */
  analytical: AnalyticalKpis;
  /** ρ < 1 (infinite buffer) or always-true (finite buffer). */
  isStable: boolean;
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
  utilization: number; // cumulative ρ̂
  inSystem: number;    // L̂ = busy + queue.length
  queueLen: number;    // L̂q = queue.length
  meanWqMin: number;   // Ŵq running average, minutes
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
}
