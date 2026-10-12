/**
 * Factory-level aggregation across multiple sewing lines. Each line runs its
 * own DES replication; this helper combines them into one AggregateKpis-shaped
 * object so the top "factory" KPI tiles and the FACTORY summary row in the
 * per-line table both show numerically consistent values.
 *
 * The rules below come from standard IE practice:
 *
 *   • Extensive quantities (counts that scale with the system) are summed.
 *       producedPieces, throughputPerHr, wipBundles
 *   • Intensive quantities (rates/ratios) are weighted, never simple-averaged.
 *       efficiencyPct → weighted by operator-minutes (Σ samConsumed ÷ Σ op·min)
 *       utilization   → weighted by operator count
 *       meanLeadTime  → weighted by pieces produced (Little's-law consistent)
 *
 *   • Replication std propagates assuming line runs are independent:
 *       var(sum)  = Σ var(line)            → std = √Σ std²
 *       var(wAvg) = Σ wᵢ² · varᵢ           → for weighted means
 *
 * This matches what an IE engineer expects from a "factory" row — taking a
 * simple arithmetic mean of two lines' efficiency percentages would only be
 * correct when both lines have identical operator-minute budgets, which is
 * almost never true in practice.
 */

import type { AggregateKpis } from './replications';

export interface FactoryLineInput {
  /** Run output for this line (replication-mean KPIs). */
  agg: AggregateKpis;
  /** Number of operators (parallel servers, summed across stations) on this line.
   *  This must match the operator count the per-line efficiency calc used so the
   *  weighted factory efficiency is internally consistent. */
  operators: number;
  /** Garment SAM per piece for this line. Drives the SAM-consumed weight in the
   *  factory efficiency calc. */
  totalSmv: number;
}

/**
 * Reduce per-line aggregates to a single factory-level AggregateKpis.
 * Returns an AggregateKpis with `replications: []` and empty history/stations —
 * those are per-engine artefacts that don't combine cleanly across lines.
 */
export function aggregateFactoryKpis(
  lines: FactoryLineInput[],
  shiftMin: number,
): AggregateKpis {
  if (lines.length === 0) {
    return emptyAgg();
  }

  // Extensive — sums and √Σ std² for std.
  const sumMean = (sel: (l: FactoryLineInput) => { mean: number; std: number }) =>
    lines.reduce((s, l) => s + sel(l).mean, 0);
  const sumStd = (sel: (l: FactoryLineInput) => { mean: number; std: number }) =>
    Math.sqrt(lines.reduce((s, l) => s + sel(l).std ** 2, 0));

  const producedPieces = { mean: sumMean((l) => l.agg.producedPieces), std: sumStd((l) => l.agg.producedPieces) };
  const throughputPerHr = { mean: sumMean((l) => l.agg.throughputPerHr), std: sumStd((l) => l.agg.throughputPerHr) };
  const wipBundles = { mean: sumMean((l) => l.agg.wipBundles), std: sumStd((l) => l.agg.wipBundles) };

  // Intensive — weighted means.
  const totalOperatorMin = lines.reduce((s, l) => s + l.operators * shiftMin, 0);
  const totalSamConsumed = lines.reduce((s, l) => s + l.agg.producedPieces.mean * l.totalSmv, 0);
  const efficiencyMean = totalOperatorMin > 0 ? (totalSamConsumed / totalOperatorMin) * 100 : 0;
  // var(efficiency) ≈ Σ (sam_i / totalOperatorMin × 100)² · var(produced_i)
  const efficiencyVar = lines.reduce((s, l) => {
    const w = totalOperatorMin > 0 ? (l.totalSmv / totalOperatorMin) * 100 : 0;
    return s + (w ** 2) * (l.agg.producedPieces.std ** 2);
  }, 0);
  const efficiencyPct = { mean: efficiencyMean, std: Math.sqrt(efficiencyVar) };

  const totalOperators = lines.reduce((s, l) => s + l.operators, 0);
  const utilizationMean = totalOperators > 0
    ? lines.reduce((s, l) => s + l.agg.utilization.mean * l.operators, 0) / totalOperators
    : 0;
  const utilizationVar = totalOperators > 0
    ? lines.reduce((s, l) => s + ((l.operators / totalOperators) ** 2) * (l.agg.utilization.std ** 2), 0)
    : 0;
  const utilization = { mean: utilizationMean, std: Math.sqrt(utilizationVar) };

  // Lead time weighted by pieces produced. If nothing was produced, fall back
  // to a simple mean so the cell renders a number rather than NaN/0.
  const totalProduced = lines.reduce((s, l) => s + l.agg.producedPieces.mean, 0);
  const meanLeadMean = totalProduced > 0
    ? lines.reduce((s, l) => s + l.agg.meanLeadTime.mean * l.agg.producedPieces.mean, 0) / totalProduced
    : lines.reduce((s, l) => s + l.agg.meanLeadTime.mean, 0) / lines.length;
  const meanLeadVar = totalProduced > 0
    ? lines.reduce((s, l) => {
        const w = l.agg.producedPieces.mean / totalProduced;
        return s + (w ** 2) * (l.agg.meanLeadTime.std ** 2);
      }, 0)
    : 0;
  const meanLeadTime = { mean: meanLeadMean, std: Math.sqrt(meanLeadVar) };

  // Pick the bottleneck label from the line with the slowest throughput — the
  // one that's actually pacing the factory.
  const slowest = [...lines].sort((a, b) => a.agg.throughputPerHr.mean - b.agg.throughputPerHr.mean)[0];

  // ── New KPIs (P1) ───────────────────────────────────────────────────────
  // Intensive KPIs weighted by operator-share, propagating std with the same
  // wᵢ² · varᵢ rule used for utilization above.
  const wIntensive = (sel: (l: FactoryLineInput) => { mean: number; std: number }) => {
    if (totalOperators === 0) return { mean: 0, std: 0 };
    const mean = lines.reduce((s, l) => s + sel(l).mean * l.operators, 0) / totalOperators;
    const variance = lines.reduce((s, l) => {
      const w = l.operators / totalOperators;
      return s + (w ** 2) * (sel(l).std ** 2);
    }, 0);
    return { mean, std: Math.sqrt(variance) };
  };
  const oee              = wIntensive((l) => l.agg.oee);
  const oeePerformance   = wIntensive((l) => l.agg.oeePerformance);
  const oeeQuality       = wIntensive((l) => l.agg.oeeQuality);
  const onStandardPct    = wIntensive((l) => l.agg.onStandardPct);
  const offStandardLossPct = wIntensive((l) => l.agg.offStandardLossPct);

  // Labour productivity factory-wide = Σ produced ÷ Σ operator-hours.
  const totalOperatorHours = lines.reduce((s, l) => s + l.operators * (shiftMin / 60), 0);
  const labourProductivity = totalOperatorHours > 0
    ? {
        mean: totalProduced / totalOperatorHours,
        std: Math.sqrt(lines.reduce((s, l) => {
          const w = totalOperatorHours > 0 ? 1 / totalOperatorHours : 0;
          return s + (w ** 2) * (l.agg.producedPieces.std ** 2);
        }, 0)),
      }
    : { mean: 0, std: 0 };

  // Demand-takt gap is a flow rate (pph) → extensive, sum of per-line gaps.
  const demandTaktGap = {
    mean: sumMean((l) => l.agg.demandTaktGap),
    std: sumStd((l) => l.agg.demandTaktGap),
  };
  return {
    n: Math.min(...lines.map((l) => l.agg.n)),
    producedPieces,
    throughputPerHr,
    efficiencyPct,
    meanLeadTime,
    utilization,
    wipBundles,
    oee,
    oeePerformance,
    oeeQuality,
    onStandardPct,
    offStandardLossPct,
    labourProductivity,
    demandTaktGap,
    bottleneckOpName: slowest?.agg.bottleneckOpName ?? '—',
    bottleneckQueue: slowest?.agg.bottleneckQueue ?? 0,
    replications: [],
    firstHistory: [],
    averagedHistory: [],
    firstStations: [],
  };
}

function emptyAgg(): AggregateKpis {
  const zero = { mean: 0, std: 0 };
  return {
    n: 0,
    producedPieces: zero,
    throughputPerHr: zero,
    efficiencyPct: zero,
    meanLeadTime: zero,
    utilization: zero,
    wipBundles: zero,
    oee: zero,
    oeePerformance: zero,
    oeeQuality: zero,
    onStandardPct: zero,
    offStandardLossPct: zero,
    labourProductivity: zero,
    demandTaktGap: zero,
    bottleneckOpName: '—',
    bottleneckQueue: 0,
    replications: [],
    firstHistory: [],
    averagedHistory: [],
    firstStations: [],
  };
}
