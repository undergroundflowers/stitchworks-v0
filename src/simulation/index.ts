/**
 * PML discrete-event simulation — the single engine driving every number on
 * every page.
 *
 *   runPmlSim({ twin, durationMin, seed })      ↦ batch run, returns
 *                                                 timeseries + per-block KPIs
 *   usePmlSim(twin, opts)                       ↦ React hook with
 *                                                 play / pause / speed / reset
 *   useMultiPmlSim(lineTwins, opts)             ↦ same hook, one run per
 *                                                 sewing line in parallel
 *   pmlSampleToSimState(view, sample, …)        ↦ adapter from a PML sample
 *                                                 to the legacy SimState
 *                                                 shape the iso / top / heat
 *                                                 views render against
 *
 * Everything in this folder is pure TypeScript; React-aware modules are the
 * three hook files. The data-builder helpers (`model.ts`, `model-from-twin.ts`)
 * produce per-line metadata (`SimConfig` as a documentation type, no longer
 * an engine input) that views consume for layout, labels, and bundle sizes.
 */

export type {
  SimConfig,
  SimState,
  StationView,
  HistoryPoint,
  StationHistoryPoint,
} from './sim-state';

export { buildSimConfig, efficiencyFromSkillMatrix, type BuildModelOptions } from './model';

export {
  buildSimConfigFromTwin,
  buildLinesFromTwin,
  type BuildFromTwinOptions,
  type BuildFromTwinResult,
  type BuildFromTwinMeta,
  type LineBuild,
  type SkippedWorkstation,
  type TwinStationMeta,
} from './model-from-twin';

// PML engine + adapter + React hooks.
export {
  runPmlSim,
  validatePmlGraph,
  type PmlSimOpts,
  type PmlSimResult,
  type PmlSimSample,
  type BlockObserved,
  type PmlIssue,
  type FlowEvent,
  type FlowEventKind,
} from './pml-engine';
export {
  buildFlowPlayback,
  type FlowPlayback,
  type BundleFrame,
  type BundleState,
} from './flow-playback';
export { runPmlOnTwin, type RunReport } from './pml-runner';
export {
  buildPmlTwinView,
  pmlSampleToSimState,
  emptyPmlSimState,
  EMPTY_TWIN,
  type PmlTwinView,
} from './pml-to-sim-state';
export {
  usePmlSim,
  type UsePmlSimResult,
  type UsePmlSimOpts,
  type UseSimResult,
} from './usePmlSim';
export {
  useMultiPmlSim,
  mergePmlSimStates,
  mergePmlTwinMetas,
  scopedTwinForLine,
  type UseMultiPmlSimResult,
  type PmlLineInput,
} from './useMultiPmlSim';

export { MinHeap, mulberry32 } from './priority-queue';
export { runReplications, type ReplicationResult, type AggregateKpis, type RunReplicationsOpts } from './replications';
export { aggregateFactoryKpis, type FactoryLineInput } from './factory-aggregate';
export {
  sample,
  meanOf,
  varOf,
  cvOf,
  kendallServiceCode,
  describeDist,
  defaultDist,
  scaleDist,
  type ServiceDist,
  type ServiceCode,
} from './distributions';
export {
  classify,
  analyticalKpis,
  type KendallNotation,
  type AnalyticalKpis,
  type QueueDiscipline,
} from './queueing';
