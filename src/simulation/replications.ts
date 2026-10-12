/**
 * Replication runner — runs the PML engine N times on the same twin with
 * different RNG seeds and returns mean + standard deviation for each KPI.
 *
 * Each replication is a deterministic full-shift run, executed synchronously.
 * With N = 10 and a 480-min shift, total wall-clock is usually well under
 * a second on the bulletins this app ships.
 *
 * History timeseries in the result are downsampled to 5-minute bins so the
 * existing charts (which were originally driven by the legacy engine's
 * fixed 5-min cadence) keep their visual shape.
 */

import type { Twin } from '../domain/twin';
import type { GarmentTemplate } from '../domain';
import {
  hourlyTarget,
  oee as oeeKpi,
  performanceFromThroughput,
  qualityFromYield,
  onStandardPerformance,
  offStandardLossPct as offStandardLossKpi,
  labourProductivity as labourProductivityKpi,
  demandTaktGap as demandTaktGapKpi,
  totalSam,
} from '../domain/kpi';
import { runPmlSim, type PmlSimResult } from './pml-engine';
import { buildPmlTwinView, pmlSampleToSimState } from './pml-to-sim-state';
import type { HistoryPoint, StationView } from './sim-state';

export interface ReplicationResult {
  seed: number;
  producedPieces: number;
  throughputPerHr: number;
  efficiencyPct: number;
  meanLeadTime: number;
  utilization: number;
  wipBundles: number;
  bottleneckOpName: string;
  bottleneckQueue: number;
  /** OEE = performance × quality, 0..1. Machine-availability is out of
   *  scope for this simulator, so the classic Availability factor is omitted. */
  oee: number;
  oeePerformance: number;
  oeeQuality: number;
  /** Earned-minutes / clocked-minutes × 100. Identical to BSI; named for
   *  the lean-vocabulary reader. */
  onStandardPct: number;
  offStandardLossPct: number;
  /** Pieces ÷ operator-hours. */
  labourProductivity: number;
  /** Actual pph − demand pph; 0 when no demand was supplied. */
  demandTaktGap: number;
}

export interface AggregateKpis {
  /** Number of replications. */
  n: number;
  producedPieces:    { mean: number; std: number };
  throughputPerHr:   { mean: number; std: number };
  efficiencyPct:     { mean: number; std: number };
  meanLeadTime:      { mean: number; std: number };
  utilization:       { mean: number; std: number };
  wipBundles:        { mean: number; std: number };
  oee:               { mean: number; std: number };
  oeePerformance:    { mean: number; std: number };
  oeeQuality:        { mean: number; std: number };
  onStandardPct:     { mean: number; std: number };
  offStandardLossPct:{ mean: number; std: number };
  labourProductivity:{ mean: number; std: number };
  demandTaktGap:     { mean: number; std: number };
  /** Bottleneck name + queue from the run that produced the median throughput. */
  bottleneckOpName: string;
  bottleneckQueue: number;
  /** Raw per-replication results, kept for charts and CSV export. */
  replications: ReplicationResult[];
  /** History from the first replication so the page can still chart output-over-time. */
  firstHistory: HistoryPoint[];
  /** Replication-averaged history — same length as firstHistory, with each
   *  field averaged across all N runs at the matching sample index. */
  averagedHistory: HistoryPoint[];
  /** Stations from the first replication. */
  firstStations: StationView[];
}

export interface RunReplicationsOpts {
  /** Twin to simulate. Each replication runs the PML engine on this twin
   *  with `seed + i`. Use `scopedTwinForLine(activeTwin, lineId)` to run
   *  one sewing line at a time when comparing per-line KPIs. */
  twin: Twin;
  /** Number of independent replications. Clamped to >= 1. */
  replications: number;
  /** Sim duration per replication in MINUTES. Default 480 (one 8h shift). */
  simMinutes: number;
  /** Base RNG seed; replication i uses `seed + i`. Default 42. */
  seed?: number;
  /** Optional bulletin — passed through to the adapter so per-station
   *  labels (opName, opCode, machineCode) survive into the result. */
  garment?: GarmentTemplate;
  /** Operators across the line. Used only for the efficiency calc; if
   *  omitted, the sum of `serversTotal` across the first run's stations
   *  is used. Set this when running a synthetic garment twin so the
   *  efficiency denominator matches the user's slider. */
  operatorsOverride?: number;
  /** Demand target (pieces/hour). When set, demandTaktGap is computed as
   *  actualPph − demandPph per replication. When omitted, gap defaults to 0. */
  demandPerHr?: number;
  /** Per-op skill-efficiency multipliers (from `efficiencyFromSkillMatrix`).
   *  Passed through to the engine — drives per-station cycle scaling. */
  opEfficiency?: Record<string, number>;
  /**
   * Effective garment catalog — built-ins with the project's edits applied.
   *
   * The engine resolves each station's parallel servers, system capacity,
   * queue discipline and service distribution off the bound OPERATION, and
   * without a catalog it falls back to the frozen built-ins. That made an
   * edited or imported bulletin invisible to every replication run through
   * here, while the live Sim screen — which passes `garmentsById` — honoured
   * it. Two surfaces, one twin, different numbers.
   */
  garmentsById?: Record<string, GarmentTemplate>;
}

/**
 * Run `replications` independent shifts of `twin` for `simMinutes` minutes
 * each. Wraps `runPmlSim` per replication and aggregates KPIs.
 */
export function runReplications(opts: RunReplicationsOpts): AggregateKpis {
  const { twin, replications, simMinutes, seed = 42, garment } = opts;
  const n = Math.max(1, Math.floor(replications));
  const samples: ReplicationResult[] = [];
  let firstHistory: HistoryPoint[] = [];
  let firstStations: StationView[] = [];
  const allHistories: HistoryPoint[][] = [];

  // Static twin view memoised across replications — block metadata is
  // identical across seeds, only the sample timeseries varies.
  const view = buildPmlTwinView(twin, garment);

  for (let i = 0; i < n; i++) {
    const result: PmlSimResult = runPmlSim({
      twin,
      durationMin: simMinutes,
      seed: seed + i,
      samplePeriodMin: 5,
      opEfficiency: opts.opEfficiency,
      garmentsById: opts.garmentsById,
    });
    const lastSample = result.samples[result.samples.length - 1];
    // Map the final sample to a SimState so the page can still read
    // history[], stations[], bottleneckOpIndex without per-engine branches.
    const state = lastSample
      ? pmlSampleToSimState(view, lastSample, result, result.samples)
      : null;
    if (state) {
      if (i === 0) {
        firstHistory = state.history;
        firstStations = state.stations;
      }
      allHistories.push(state.history);
    }
    const operators =
      opts.operatorsOverride
      ?? (state?.stations.reduce((s, st) => s + st.serversTotal, 0) ?? 1);
    // Efficiency = SAM consumed / available operator minutes. SAM consumed
    // is approximated by Σ(producedPieces · smv) across stations — accurate
    // for linear bulletins where every piece traverses every op once.
    const samConsumed = state
      ? state.stations.reduce((s, st) => s + st.produced * st.smv, 0)
      : 0;
    const efficiencyPct = operators > 0 ? (samConsumed / (operators * simMinutes)) * 100 : 0;
    const throughputPerHr = simMinutes > 0 ? (result.totalProduced / simMinutes) * 60 : 0;
    const wipBundles = state ? state.totalArrivals - state.produced : 0;
    const bottleneck = state?.stations[state.bottleneckOpIndex];

    // ── New KPI block (P1) ──────────────────────────────────────────────
    // OEE: Performance × Quality. (Machine-availability is out of scope for
    // this sewing-floor simulator, so the classic Availability factor is
    // omitted.) Quality = 1 until rework / scrap occurs.
    const clockedMin = operators * simMinutes;
    const sam = garment ? totalSam(garment.operations) : 0;
    const bottleneckSmv = bottleneck?.smv ?? 0;
    const theoreticalPph = bottleneckSmv > 0 ? hourlyTarget(bottleneckSmv) : 0;

    const oeePerformance = performanceFromThroughput({
      actualPph: throughputPerHr,
      theoreticalPph,
    });
    // OEE-quality uses the engine's first-pass yield: pieces that completed
    // every op without ever entering rework, divided by pieces that finished
    // a full path (sunk or scrapped). 1.0 when no rework / scrap occurred.
    const oeeQuality = qualityFromYield({
      goodPieces: result.piecesProducedFTR,
      totalPieces: result.totalProduced + result.piecesScrapped,
    });
    const oee = oeeKpi({
      performance: oeePerformance,
      quality: oeeQuality,
    });

    const onStandardPct = sam > 0
      ? onStandardPerformance({
          producedPieces: result.totalProduced,
          sam,
          clockedMinutes: clockedMin,
        })
      : 0;
    const earnedMin = result.totalProduced * sam;
    const offStdLoss = offStandardLossKpi({
      clockedMinutes: clockedMin,
      earnedMinutes: earnedMin,
    });
    const labourProd = labourProductivityKpi({
      producedPieces: result.totalProduced,
      operators,
      hours: simMinutes / 60,
    });
    const taktGap = opts.demandPerHr !== undefined
      ? demandTaktGapKpi({ actualPph: throughputPerHr, demandPph: opts.demandPerHr })
      : 0;

    samples.push({
      seed: seed + i,
      producedPieces: result.totalProduced,
      throughputPerHr,
      efficiencyPct,
      meanLeadTime: result.meanLeadTimeMin,
      utilization: state?.utilization ?? 0,
      wipBundles,
      bottleneckOpName: bottleneck?.opName ?? '—',
      bottleneckQueue: bottleneck?.queueLen ?? 0,
      oee,
      oeePerformance,
      oeeQuality,
      onStandardPct,
      offStandardLossPct: offStdLoss,
      labourProductivity: labourProd,
      demandTaktGap: taktGap,
    });
  }

  const sortedByThroughput = [...samples].sort(
    (a, b) => a.throughputPerHr - b.throughputPerHr,
  );
  const median = sortedByThroughput[Math.floor(sortedByThroughput.length / 2)];

  return {
    n,
    producedPieces:     meanStd(samples.map((s) => s.producedPieces)),
    throughputPerHr:    meanStd(samples.map((s) => s.throughputPerHr)),
    efficiencyPct:      meanStd(samples.map((s) => s.efficiencyPct)),
    meanLeadTime:       meanStd(samples.map((s) => s.meanLeadTime)),
    utilization:        meanStd(samples.map((s) => s.utilization)),
    wipBundles:         meanStd(samples.map((s) => s.wipBundles)),
    oee:                meanStd(samples.map((s) => s.oee)),
    oeePerformance:     meanStd(samples.map((s) => s.oeePerformance)),
    oeeQuality:         meanStd(samples.map((s) => s.oeeQuality)),
    onStandardPct:      meanStd(samples.map((s) => s.onStandardPct)),
    offStandardLossPct: meanStd(samples.map((s) => s.offStandardLossPct)),
    labourProductivity: meanStd(samples.map((s) => s.labourProductivity)),
    demandTaktGap:      meanStd(samples.map((s) => s.demandTaktGap)),
    bottleneckOpName: median?.bottleneckOpName ?? '—',
    bottleneckQueue:  median?.bottleneckQueue ?? 0,
    replications: samples,
    firstHistory,
    averagedHistory: averageHistories(allHistories),
    firstStations,
  };
}

/**
 * Pointwise average across N replication history series. All replications
 * sample at the same cadence (5 sim-min), so we align by index up to the
 * shortest series' length.
 */
function averageHistories(histories: HistoryPoint[][]): HistoryPoint[] {
  if (histories.length === 0) return [];
  if (histories.length === 1) return histories[0];
  const minLen = histories.reduce((m, h) => Math.min(m, h.length), histories[0].length);
  const out: HistoryPoint[] = [];
  for (let i = 0; i < minLen; i++) {
    let prod = 0, wip = 0, tput = 0;
    for (const h of histories) {
      prod += h[i].produced;
      wip += h[i].wip;
      tput += h[i].throughputPerHr;
    }
    out.push({
      time: histories[0][i].time,
      produced: prod / histories.length,
      wip: wip / histories.length,
      throughputPerHr: tput / histories.length,
    });
  }
  return out;
}

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}
