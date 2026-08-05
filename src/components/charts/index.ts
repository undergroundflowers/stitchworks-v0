/**
 * Chart primitives, shared by the Reports surface and the Sim screen.
 *
 * These lived inside `Reports.tsx` as module-private functions, which is why
 * the sim had no charts at all: the components existed, but nothing outside
 * that one 2,800-line file could reach them.
 */

export {
  MultiLineHistoryChart,
  KpiFormula,
  KpiTile,
  ChartHeader,
  ChartInference,
  ChartEmpty,
  CumulativeOutputChart,
  ThroughputChart,
  WipChart,
  LittlesLawPanel,
  UtilizationBarChart,
  QueueParetoChart,
  DEPT_LINE_COLORS,
  type KpiTileProps,
  type HistorySeries,
} from './report-charts';

export {
  ConvergenceChart,
  BalkRatePanel,
  LittlesLawCheck,
  type ConvergenceChartProps,
} from './ConvergenceCharts';
