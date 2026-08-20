import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { Card, Button, Stat, SectionHeader, Progress, ToggleGroup, Yamazumi, autoAssign, HideableBox, HudSelect, LineScopePicker, LineSimEmpty, Tag, type OperatorAssignment } from '../components';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChartHeader,
  ChartInference,
  CumulativeOutputChart,
  DEPT_LINE_COLORS,
  KpiFormula,
  KpiTile,
  LittlesLawPanel,
  MultiLineHistoryChart,
  QueueParetoChart,
  ThroughputChart,
  UtilizationBarChart,
  WipChart,
} from '../components/charts';
import { ScenariosPanel } from './Scenarios';
import {
  smoothnessIndex,
  balanceLoss,
  lineBalanceRatio,
  lineBalanceEfficiency,
  optimumManning,
  lineEfficiency,
  bottleneckSmv,
  suggestBalanceActions,
  type BalanceSuggestion,
} from '../domain';
import {
  efficiencyFromSkillMatrix,
  runReplications,
  buildLinesFromTwin,
  aggregateFactoryKpis,
  scopedTwinForLine,
  type AggregateKpis,
  type LineBuild,
} from '../simulation';
import { useProject, useGarments } from '../store';
import { useTwin, selectActiveTwin } from '../store/twin';
import { useSimScope } from '../store/simScope';
import { lineSystemBadge, shareDebtForLine } from '../domain/twin';
import { runPmlOnTwin } from '../simulation/pml-runner';
import { buildGarmentTwin } from '../domain/reference-twin';
import { getBlockSpec, apparelRoleFor } from '../domain/pml';

const SHIFT_MIN = 480;
/** Base RNG seed for the page-level replications. Replication i uses
 *  `REPORT_BASE_SEED + i`. Kept as a constant so the seed strip in the
 *  page chrome can display the exact range without re-running the engine. */
const REPORT_BASE_SEED = 42;

/** Sum HistoryPoint series across multiple lines so the factory-scope
 *  OUTPUT OVER TIME chart shows the wired factory's combined cumulative
 *  output, not just one synthetic line's. Series are produced by the same
 *  engine with the same shift duration / 5-min sampling, so element-wise
 *  alignment is safe; the longest series wins on length and the shorter
 *  ones contribute zero past their end (no NaN edges). */
function sumHistories(
  series: { time: number; produced: number; wip: number; throughputPerHr: number }[][],
): { time: number; produced: number; wip: number; throughputPerHr: number }[] {
  const nonEmpty = series.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return [];
  const longest = nonEmpty.reduce((a, b) => (b.length > a.length ? b : a));
  return longest.map((point, i) => {
    let produced = 0;
    let wip = 0;
    let throughputPerHr = 0;
    for (const s of nonEmpty) {
      const p = s[i];
      if (!p) continue;
      produced += p.produced;
      wip += p.wip;
      throughputPerHr += p.throughputPerHr;
    }
    return { time: point.time, produced, wip, throughputPerHr };
  });
}

/** Empty-state aggregate — used before the first replication completes or
 *  when the chosen garment carries no operations. */
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
    totalChangeoverMin: zero,
    perOrderCompletionTime: {},
    bottleneckOpName: '—',
    bottleneckQueue: 0,
    replications: [],
    firstHistory: [],
    averagedHistory: [],
    firstStations: [],
  };
}

/**
 * Production KPIs page. Reads the user's selected garment + operator count
 * from the project store, runs a full shift through the DES engine on
 * mount, then renders KPIs from the resulting state. Yamazumi assignments
 * are user-overridable via drag; overrides are persisted in the project
 * store keyed by garment template id.
 *
 * `embedded` mode drops the outer scroll wrapper and the "Back to twin"
 * footer button so the same content can be mounted inside another page
 * (e.g. underneath the LiveSim view).
 */
export function ReportsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const project = useProject();
  const garments = useGarments();
  const setYamazumiOverride = project.setYamazumiOverride;
  const clearYamazumiOverride = project.clearYamazumiOverride;
  const location = useLocation();
  const [period, setPeriod] = useState<'SHIFT' | 'DAY' | 'WEEK' | 'MONTH'>('SHIFT');
  // In-page tab nav. Line balance is a part of performance, Scenarios is the
  // saved-run comparison surface — both live under the same Reports umbrella
  // rather than as their own routes.
  const [tab, setTab] = useState<'performance' | 'balance' | 'validation' | 'scenarios'>(() => {
    const qs = new URLSearchParams(location.search).get('tab');
    return qs === 'scenarios' || qs === 'balance' || qs === 'validation' || qs === 'performance'
      ? qs
      : 'performance';
  });
  // Honour ?tab= changes on subsequent navigations (e.g. clicking "Scenarios"
  // from elsewhere in the app after the page is already mounted).
  useEffect(() => {
    const qs = new URLSearchParams(location.search).get('tab');
    if (qs === 'scenarios' || qs === 'balance' || qs === 'validation' || qs === 'performance') {
      setTab(qs);
    }
  }, [location.search]);

  // Save-scenario modal state. We avoid `window.prompt()` because it's
  // suppressed inside many embedded preview / iframe contexts, which silently
  // killed the save flow before this — the button looked like it did nothing.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNotes, setSaveNotes] = useState('');

  // Yamazumi state — picks from store override if present, else LPT auto.
  const [yamGarment, setYamGarment] = useState<string>(() => {
    // Prefer a garment some line on this floor actually produces — that is
    // what the user came here to balance.
    const lines = selectActiveTwin(useTwin.getState()).lines ?? [];
    return lines.find((l) => l.garmentId)?.garmentId ?? garments.all[0]?.id ?? '';
  });
  // Seed the line-balance operator count from a line's authored
  // operatorTarget. It must reflect the line being balanced: balancing a 3-op
  // line onto a factory-wide 25 reads as ~90% balance loss and misleads.
  // Clamp matches the input's [4, 60] range.
  const [yamOperators, setYamOperators] = useState<number>(() => {
    const lines = selectActiveTwin(useTwin.getState()).lines ?? [];
    const target = lines.find((l) => l.operatorTarget)?.operatorTarget ?? 4;
    return Math.max(4, Math.min(60, target));
  });

  const yamTemplate = garments.byId[yamGarment] ?? garments.all[0];
  const storedOverride = project.yamazumiOverrides[yamGarment];

  const yamAssignments: OperatorAssignment[] = useMemo(() => {
    if (storedOverride && storedOverride.length === yamOperators) {
      // Reconstruct OperatorAssignment from stored opIds + the template's ops.
      const opById = new Map(yamTemplate.operations.map((o) => [o.id, o]));
      return storedOverride.map((s) => ({
        id: s.operatorId,
        operations: s.opIds.map((id) => opById.get(id)).filter((o): o is NonNullable<typeof o> => !!o),
      }));
    }
    return autoAssign(
      yamTemplate.operations,
      yamOperators,
      // Skill-aware balance: pass the matrix-derived efficiency so RPW
      // biases ops toward operators who can actually run them at speed.
      efficiencyFromSkillMatrix(project.skillMatrix, yamTemplate.operations),
    );
  }, [storedOverride, yamOperators, yamTemplate, project.skillMatrix]);

  function handleYamazumiChange(next: OperatorAssignment[]) {
    setYamazumiOverride(yamGarment, next.map((a) => ({ operatorId: a.id, opIds: a.operations.map((o) => o.id) })));
  }

  const stationSmvs = yamAssignments.map((a) =>
    a.operations.reduce((s, o) => s + o.smv, 0),
  );
  const yamTakt = yamTemplate.totalSmv / yamOperators;
  const yamBottleneck = bottleneckSmv(
    yamAssignments.map((a) => ({ smv: a.operations.reduce((s, o) => s + o.smv, 0), id: a.id, code: '', name: '', machineCode: 'MNL', skill: 'stitching', category: 'manual' })),
  );
  const yamBalance = balanceLoss(stationSmvs);
  const yamSmoothness = smoothnessIndex(stationSmvs, yamBottleneck);
  const yamEfficiency = lineEfficiency({
    producedPieces: Math.round((60 / yamBottleneck) * 8),
    sam: yamTemplate.totalSmv,
    operators: yamOperators,
    workMinutes: 60 * 8,
  });

  // ── Sempai 3-metric line-balance suite ──────────────────────────────────
  // Three metrics that the lean-manufacturing literature (e.g. Sempai's
  // line-balance calculator) treats as a single triad:
  //   1. Line Balance Ratio   — fairness across stations (sum / N × max).
  //   2. Line Balance Efficiency — capacity used vs takt (sum / N × takt).
  //   3. Optimum Manning      — theoretical headcount at takt (ΣSAM / takt).
  // LBR and Balance Loss are complements (LBR + BL ≈ 100). LBE only differs
  // from LBR when takt ≠ bottleneck, i.e. when demand actually drives the
  // pace rather than the slowest station. Optimum manning is the headcount
  // floor a perfect rebalance would land at; the gap to `yamOperators` is
  // the labour cost of the current imbalance.
  //
  // Takt source: the user's most recent committed order gives a concrete
  // demandPerShift = qty / deadlineDays, so takt = SHIFT_MIN / demand. When
  // no order is committed yet, fall back to the bottleneck SMV — that's
  // the cycle the line will naturally hold, and using it makes LBE collapse
  // to LBR (which is the honest answer in the absence of a demand signal).
  const latestOrder = project.orders[0];
  const orderDemandPerShift =
    latestOrder && latestOrder.deadlineDays > 0
      ? latestOrder.qty / latestOrder.deadlineDays
      : 0;
  const taktFromOrder =
    orderDemandPerShift > 0 ? SHIFT_MIN / orderDemandPerShift : 0;
  const yamTaktReal = taktFromOrder > 0 ? taktFromOrder : yamBottleneck;
  const taktSource: 'order' | 'bottleneck' =
    taktFromOrder > 0 ? 'order' : 'bottleneck';
  const yamLBR = lineBalanceRatio(stationSmvs);
  const yamLBE = lineBalanceEfficiency({
    stationSmvs,
    taktMin: yamTaktReal,
  });
  const yamOptManning = optimumManning({
    totalSam: yamTemplate.totalSmv,
    taktMin: yamTaktReal,
  });

  // Balance-advisor suggestions — computed from the same numbers the metric
  // tier shows, so the WHAT TO FIX list and the tiles can never disagree.
  // The advisor is pure; deriving via useMemo is overkill at this dataset
  // size (≤30 stations) and would just pin a stale array on garment swap.
  const balanceSuggestions: BalanceSuggestion[] = suggestBalanceActions({
    stations: yamAssignments.map((a) => ({
      id: a.id,
      operations: a.operations,
      effectiveLoadMin: a.operations.reduce((s, o) => s + o.smv, 0),
    })),
    totalSam: yamTemplate.totalSmv,
    operators: yamOperators,
    taktMin: yamTaktReal,
    taktSource,
    bottleneckSmv: yamBottleneck,
    lbr: yamLBR,
    lbe: yamLBE,
    optimumManning: yamOptManning,
    balanceLoss: yamBalance,
    smoothness: yamSmoothness,
    hasManualOverride: !!storedOverride,
    bulletinName: yamTemplate.name,
  });

  // ── Real run-driven KPIs from the sim engine ────────────────────────────
  // Per-op efficiency derived from the project's skill matrix — when the
  // user hand-tunes operator proficiency, the sim respects it.
  const opEfficiency = useMemo(
    () => efficiencyFromSkillMatrix(project.skillMatrix, yamTemplate.operations),
    [project.skillMatrix, yamTemplate],
  );
  const skillEntries = Object.keys(opEfficiency).length;
  // Default to 5 replications so the stochastic engine's variance is
  // visible on first render. A single-run report hides the ±std the
  // demo narrative depends on; 5 is a cheap-enough run count that the
  // page still paints under a second.
  const [runs, setRuns] = useState<number>(5);
  // Synthesise a single-line twin from the chosen garment so the PML engine
  // has a Source → ops → Sink graph to replicate. Falls back to a typed
  // single-station twin when the bulletin is empty (corner case — the page
  // shows zeros in that branch).
  const runTwin = useMemo(
    () => buildGarmentTwin(yamTemplate, yamOperators),
    [yamTemplate, yamOperators],
  );
  const [agg, setAgg] = useState<AggregateKpis>(() =>
    runTwin
      ? runReplications({
          twin: runTwin,
          replications: runs,
          simMinutes: SHIFT_MIN,
          garment: yamTemplate,
          operatorsOverride: yamOperators,
        })
      : emptyAgg(),
  );

  // Re-run when twin or replication count changes. Synchronous — typically
  // <100ms even at runs=10.
  useEffect(() => {
    if (!runTwin) {
      setAgg(emptyAgg());
      return;
    }
    setAgg(
      runReplications({
        twin: runTwin,
        replications: runs,
        simMinutes: SHIFT_MIN,
        garment: yamTemplate,
        operatorsOverride: yamOperators,
      }),
    );
  }, [runTwin, runs, yamTemplate, yamOperators]);

  // ── Per-line replication ─────────────────────────────────────────────────
  // When the active twin has more than one wired sewing line, the
  // single-garment KPIs above can't honestly speak for the factory (Line 1
  // is knit, Line 2 is woven, etc.). Run a separate replication on each
  // wired line's config so the Performance tab can show a per-line table
  // alongside the aggregate Yamazumi-driven tiles.
  const reportsTwin = useTwin(selectActiveTwin);
  const reportScope = useSimScope((s) => s.scope);
  const lineBuildsForReports: LineBuild[] = useMemo(() => {
    if ((reportsTwin.lines ?? []).length === 0) return [];
    return buildLinesFromTwin({
      twin: reportsTwin,
      garmentsById: garments.byId,
      defaultGarmentId: yamGarment,
      opEfficiency: efficiencyFromSkillMatrix(
        project.skillMatrix,
        (garments.byId[yamGarment] ?? garments.all[0]).operations,
      ),
      modelTimeUnit: project.time.modelTimeUnit,
    });
  }, [reportsTwin, garments.byId, garments.all, yamGarment, project.skillMatrix, project.time.modelTimeUnit]);
  const perLineAggs = useMemo(() => {
    return lineBuildsForReports
      .filter((lb) => lb.ok)
      // Honour the shared scope so the picker in the header actually narrows
      // the report, and so this page agrees with the Sim screen and the
      // queueing tables about what "the line" currently means.
      .filter((lb) => (reportScope.kind === 'line' ? lb.line.id === reportScope.id : true))
      .map((lb) => {
        // Scope the active twin to this line's workstations so PML treats
        // each sewing line as an independent run — different garments and
        // bundle sizes don't compose into one homogeneous simulation.
        const lineTwin = scopedTwinForLine(reportsTwin, lb.line.id);
        const operatorsForLine = lb.build.config.stationServers.reduce((s, c) => s + c, 0);
        return {
          line: lb.line,
          bundleSize: lb.build.config.bundleSize,
          // Operators = sum of parallel servers across stations. Matches the
          // efficiency denominator below so the factory-weighted aggregate
          // stays internally consistent.
          operators: operatorsForLine,
          // SAM per piece for this line's garment. Drives the SAM-consumed
          // weight in the factory efficiency aggregation.
          totalSmv: lb.build.config.operations.reduce((s, o) => s + o.smv, 0),
          agg: runReplications({
            twin: lineTwin,
            replications: runs,
            simMinutes: SHIFT_MIN,
            garment: lb.build.meta.garment,
            operatorsOverride: operatorsForLine,
          }),
        };
      });
  }, [lineBuildsForReports, reportsTwin, runs, reportScope]);

  // ── Factory-level aggregate across wired lines ──────────────────────────
  // When the twin has ≥1 wired line, the top KPI tiles (and the FACTORY
  // summary row in the per-line table) describe the whole factory, computed
  // with proper IE weighting (operator-minutes for efficiency, operators for
  // utilisation, pieces for lead time). Without this, the tiles would either
  // (a) show a synthetic Yamazumi-target line that disagreed with the per-
  // line table below, or (b) report a simple arithmetic mean of percentages,
  // which silently misrepresents lines of different sizes.
  const factoryAgg = useMemo<AggregateKpis | null>(() => {
    if (perLineAggs.length === 0) return null;
    return aggregateFactoryKpis(perLineAggs, SHIFT_MIN);
  }, [perLineAggs]);

  // Top KPI tiles read from the factory aggregate when wired lines exist,
  // otherwise from the single-config Yamazumi run. This is the same data that
  // populates the FACTORY summary row in the per-line table, so the two views
  // stay numerically consistent.
  const kpiSource: AggregateKpis = factoryAgg ?? agg;
  const efficiency = kpiSource.efficiencyPct.mean;
  const throughputPerHr = kpiSource.throughputPerHr.mean;
  const producedPieces = kpiSource.producedPieces.mean;
  const meanLeadTime = kpiSource.meanLeadTime.mean;
  const utilization = kpiSource.utilization.mean;
  const wipBundles = kpiSource.wipBundles.mean;

  // ── PML run section data ────────────────────────────────────────────────
  const pmlTwin = useTwin(selectActiveTwin);
  const setKpiObserved = useTwin((s) => s.setKpiObserved);
  /** Force re-render after RUN — selectActiveTwin returns the same Twin
   *  reference on observed-only edits so we need a tick. */
  const [pmlRunBump, setPmlRunBump] = useState(0);

  const pmlBlocks = useMemo(() => {
    void pmlRunBump; // trigger memo on run
    return pmlTwin.workstations
      .filter((w) => w.kpiObserved && w.kpiObserved.capacityPerHr > 0)
      .map((w) => {
        const spec = getBlockSpec(w);
        return {
          ws: w,
          kind: spec.kind,
          role: apparelRoleFor(w),
          throughput: w.kpiObserved!.capacityPerHr,
          util: w.kpiObserved!.utilizationPct,
          bottleneck: w.kpiObserved!.bottleneck,
        };
      })
      .sort((a, b) => b.throughput - a.throughput);
  }, [pmlTwin, pmlRunBump]);

  const pmlSinkThroughput = useMemo(
    () =>
      pmlTwin.workstations
        .filter((w) => getBlockSpec(w).kind === 'Sink')
        .reduce((s, w) => s + (w.kpiObserved?.capacityPerHr ?? 0), 0),
    [pmlTwin, pmlRunBump],
  );
  const pmlBottleneck = pmlBlocks.find((b) => b.bottleneck) ?? null;
  const pmlAnyObserved = pmlBlocks.length > 0;

  // Period scaling for cumulative KPIs. Throughput is a rate and percentages
  // (efficiency, utilization) are intensive — they don't scale. Only OUTPUT
  // and other tally-style numbers multiply by working-day count. Sri Lankan
  // apparel convention: 1 shift/day, 6 working days/week, ~26 working days/month.
  const periodMultiplier = period === 'WEEK' ? 6 : period === 'MONTH' ? 26 : 1;
  const periodLabel = period === 'SHIFT' ? 'SHIFT' : period === 'DAY' ? 'DAY' : period === 'WEEK' ? 'WEEK' : 'MONTH';
  const scaledProducedMean = producedPieces * periodMultiplier;
  const scaledProducedStd = (runs > 1 ? kpiSource.producedPieces.std : 0) * periodMultiplier;
  // True when the headline tiles describe the wired factory rather than the
  // single-config Yamazumi run. Drives the sub-line copy below.
  const factoryScope = factoryAgg !== null;
  const factoryLineCount = perLineAggs.length;

  return (
    <div style={embedded
      ? { width:'100%', background: SW_COLORS.paperDeep, padding: 24 }
      : { width:'100%', height:'100%', overflow:'auto', background: SW_COLORS.paperDeep, padding: 24 }}>
      <SectionHeader
        kicker="Reports"
        title={tab === 'balance' ? 'Line balance' : tab === 'validation' ? 'Engine report' : tab === 'scenarios' ? 'Saved scenarios' : 'Production performance'}
        sub={`${runs > 1 ? `${runs}-replication mean` : 'Single seed'} · 480-min shift${periodMultiplier > 1 ? ` × ${periodMultiplier} (${periodLabel.toLowerCase()})` : ''} · ${factoryScope ? `Factory of ${factoryLineCount} wired ${factoryLineCount === 1 ? 'line' : 'lines'}` : `${yamTemplate.name} · ${yamOperators} operators`} · ${skillEntries > 0 ? `${skillEntries} operations respect skill matrix` : 'baseline (no skill overrides)'} · seed ${REPORT_BASE_SEED}${runs > 1 ? `..${REPORT_BASE_SEED + runs - 1}` : ''}`}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Bound to the shared scope, so picking a line here also moves the
                Sim screen and the queueing pages. */}
            <LineScopePicker lines={reportsTwin.lines ?? []} />
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ ...SW_TYPE.kicker, color: SW_COLORS.muted, letterSpacing:'0.5px' }}>RUNS</span>
              <ToggleGroup value={String(runs)} onChange={(v) => setRuns(parseInt(v))} options={[
                { value: '1',  label: '1' },
                { value: '3',  label: '3' },
                { value: '5',  label: '5' },
                { value: '10', label: '10' },
              ]}/>
            </div>
            <Button variant="secondary" size="sm" icon="↻" onClick={() => runTwin && setAgg(runReplications({ twin: runTwin, replications: runs, simMinutes: SHIFT_MIN, garment: yamTemplate, operatorsOverride: yamOperators }))}>
              Re-run
            </Button>
            <Button variant="primary" size="sm" icon="✦"
              onClick={() => {
                // Append device wall-clock so the user can recognise this
                // save later; the "(device)" suffix calls out that the
                // timestamp is wall time, not sim/calendar time.
                const wallStamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const scopeLabel = factoryAgg !== null
                  ? `Factory · ${perLineAggs.length} ${perLineAggs.length === 1 ? 'line' : 'lines'} · ${perLineAggs.reduce((sum, l) => sum + l.operators, 0)} ops`
                  : `${yamTemplate.name} · ${yamOperators} ops`;
                const defaultName = `${scopeLabel} · ${runs > 1 ? `${runs}× ` : ''}${wallStamp} (device)`;
                setSaveName(defaultName);
                setSaveNotes('');
                setSaveOpen(true);
              }}
            >
              Save scenario
            </Button>
            <ToggleGroup value={period} onChange={setPeriod} options={[
              { value:'SHIFT', label:'Shift' },
              { value:'DAY',   label:'Day' },
              { value:'WEEK',  label:'Week' },
              { value:'MONTH', label:'Month' },
            ]}/>
          </div>
        }
      />

      {/* ── Active systems strip ─────────────────────────────────────────
          One chip per sewing line on the active twin, showing the
          production system and its single most-characteristic policy knob
          (bundle size for PBS, rotator count for modular, takt for
          synchro). The user sees at a glance which systems are driving
          the numbers below — useful when a single twin runs PBS + TSS in
          parallel and the KPIs blend the two. */}
      {(reportsTwin.lines ?? []).length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            margin: '12px 0 4px',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              ...SW_TYPE.overline,
              color: SW_COLORS.muted,
              letterSpacing: '1.5px',
            }}
          >
            Active systems
          </span>
          {(reportsTwin.lines ?? []).map((l) => (
            <span
              key={l.id}
              title={`${l.name} — ${l.productionSystem}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 9px',
                borderRadius: 4,
                border: `1px solid ${SW_COLORS.line}`,
                background: SW_COLORS.paper,
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 700,
                color: SW_COLORS.ink,
                letterSpacing: '0.05em',
              }}
            >
              <span style={{ color: SW_COLORS.brand }}>◆</span>
              <span>{lineSystemBadge(l, reportsTwin)}</span>
              <span style={{ color: SW_COLORS.muted, fontWeight: 600 }}>·</span>
              <span style={{ color: SW_COLORS.muted }}>{l.name}</span>
            </span>
          ))}
        </div>
      )}

      {/* ── In-page tabs ─────────────────────────────────────────────────
          Reports is the umbrella. Performance gives the headline KPIs;
          Line Balance gives the Yamazumi authoring surface; Validation
          shows how the model lines up with the reference paper / wired
          block graph. */}
      <ReportTabBar value={tab} onChange={setTab} hasPml={pmlAnyObserved} />

      {/* ── Reference paper validation ───────────────────────────────────
          Visible only when the user has loaded a published case study into
          the active twin from the Simulation tab. Side-by-side paper KPIs
          vs. Stitchworks observed, with delta% and pass/fail badges. */}
      {/* ── PML simulation report ───────────────────────────────────────
          Reads observed KPIs that the Builder's PML runner wrote onto
          each workstation. Lets the user re-run from this page so they
          don't have to bounce back to Builder for a quick check. */}
      {tab === 'validation' && (
      <HideableBox style={{ marginBottom: 20 }}>
      <Card padding={20} style={{ borderLeft: `4px solid ${SW_COLORS.brand}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: 12, flexWrap: 'wrap', paddingRight: 36 }}>
          <div>
            <div style={{ ...SW_TYPE.heading }}>
              ⚙ PML SIMULATION
            </div>
            <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 2 }}>
              Block-graph DES over the active twin · {pmlTwin.workstations.length} blocks · {pmlTwin.connectors.length} connectors
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="primary"
              size="sm"
              icon="▶"
              onClick={() => {
                runPmlOnTwin(pmlTwin, { writeKpiObserved: setKpiObserved });
                setPmlRunBump((n) => n + 1);
              }}
            >
              Run PML
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/line')}>
              Open Builder
            </Button>
          </div>
        </div>

        {!pmlAnyObserved ? (
          <div
            style={{
              padding: '14px 16px',
              border: `1px dashed ${SW_COLORS.line}`,
              borderRadius: 6,
              fontSize: 12,
              color: SW_COLORS.muted,
            }}
          >
            No PML run on this twin yet. Click <strong style={{ color: SW_COLORS.brand }}>▶ Run PML</strong> to simulate the wired graph and populate per-block KPIs.
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
              <Stat label="SINK THROUGHPUT" value={Math.round(pmlSinkThroughput).toLocaleString()} unit="pcs/hr" color={SW_COLORS.brand} />
              <Stat label="ACTIVE BLOCKS"   value={String(pmlBlocks.length)}                                  unit="" color={SW_COLORS.fabric} />
              <Stat label="BOTTLENECK"       value={pmlBottleneck ? (() => { const n = pmlBottleneck.ws.name.replace(/^\d+\.\s*/, ''); return n.length > 16 ? n.slice(0, 15) + '…' : n; })() : '—'}  unit=""        color={pmlBottleneck ? SW_COLORS.alarm : SW_COLORS.muted} />
              <Stat label="MAX UTIL"         value={Math.max(0, ...pmlBlocks.map((b) => b.util)).toFixed(0)}    unit="%"       color={SW_COLORS.thread} />
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontFamily: SW_FONTS.mono,
                  fontSize: 11,
                }}
              >
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: `1px solid ${SW_COLORS.line}` }}>
                    <th style={{ padding: '6px 8px', fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.08em' }}>BLOCK</th>
                    <th style={{ padding: '6px 8px', fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.08em' }}>KIND</th>
                    <th style={{ padding: '6px 8px', fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.08em' }}>ROLE</th>
                    <th style={{ padding: '6px 8px', fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.08em', textAlign: 'right' }}>PCS/HR</th>
                    <th style={{ padding: '6px 8px', fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.08em', textAlign: 'right' }}>UTIL</th>
                  </tr>
                </thead>
                <tbody>
                  {pmlBlocks.slice(0, 20).map((b) => (
                    <tr
                      key={b.ws.id}
                      style={{
                        borderBottom: `1px solid ${SW_COLORS.line}`,
                        background: b.bottleneck ? `${SW_COLORS.alarm}24` : 'transparent',
                      }}
                    >
                      <td style={{ padding: '6px 8px', color: SW_COLORS.ink, fontWeight: 700 }}>
                        {b.bottleneck && '◆ '}
                        {b.ws.name}
                      </td>
                      <td style={{ padding: '6px 8px', color: SW_COLORS.muted }}>{b.kind}</td>
                      <td style={{ padding: '6px 8px', color: SW_COLORS.muted }}>{b.role}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 800, color: SW_COLORS.ink }}>
                        {Math.round(b.throughput).toLocaleString()}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: SW_COLORS.muted }}>
                        {b.util > 0 ? `${b.util.toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pmlBlocks.length > 20 && (
                <div style={{ marginTop: 6, fontSize: 11, color: SW_COLORS.muted, fontStyle: 'italic' }}>
                  +{pmlBlocks.length - 20} more blocks not shown
                </div>
              )}
            </div>
          </>
        )}
      </Card>
      </HideableBox>
      )}

      {tab === 'performance' && (
      <>
      {/* OB-vs-SIM validation panel — surfaces the gap between the IE-
          declared output (operation bulletin header) and the digital
          twin's simulated mean. Hidden when the active twin has no
          wired lines with a pinned garment. */}
      {perLineAggs.length > 0 && (
        <HideableBox>
          <Card padding={20} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <div style={{ ...SW_TYPE.heading }}>
                OB DECLARED vs SIM OBSERVED
              </div>
              <div style={{ ...SW_TYPE.kicker, color: SW_COLORS.muted, letterSpacing: '0.06em' }}>
                {runs} REPLICATION{runs === 1 ? '' : 'S'} · 480 MIN SHIFT
              </div>
            </div>
            <div style={{ fontSize: 12, color: SW_COLORS.muted, marginBottom: 12, lineHeight: 1.45 }}>
              Each row compares the operation bulletin's IE-declared output (per the Modelama xlsx header) against the stochastic sim mean. Green ✓ = within ±15%; amber △ = within ±30%; red ✗ = significantly off. A red row means the operator headcount, machine balance or skill model needs adjustment.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: `1px solid ${SW_COLORS.line}`, ...SW_TYPE.kicker, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '0.06em' }}>
                    <th style={{ padding: '6px 8px' }}>LINE</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>OB @100%</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>OB @PLAN 60%</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>SIM MEAN</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>±STD</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>SIM / OB@100%</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center' }}>MATCH</th>
                  </tr>
                </thead>
                <tbody>
                  {perLineAggs.map((r) => {
                    const declaredHourly = r.agg.firstStations.length > 0
                      ? Math.round(60 / Math.max(0.01, Math.max(...r.agg.firstStations.map((s) => s.smv))))
                      : 0;
                    const garment = r.line.garmentId ? garments.byId[r.line.garmentId] : undefined;
                    const ob100 = (garment?.hourlyTarget100 ?? declaredHourly) * 8;
                    const obPlan = Math.round(ob100 * 0.6);
                    const simMean = r.agg.producedPieces.mean;
                    const simStd = r.agg.producedPieces.std;
                    const ratio = ob100 > 0 ? simMean / ob100 : 0;
                    // Sim usually lands between OB @ Plan and OB @100% because
                    // the engine applies stochastic variance but no operator
                    // fatigue or absenteeism. The "match" indicator measures
                    // distance to the OB @ Plan (60%) figure, which is the
                    // realistic factory target.
                    // The "expected" zone is OB @ Plan ≤ sim ≤ OB @ 100%.
                    // Sim that lands inside this zone is operating exactly
                    // as the IE modelled, with stochastic variance + no
                    // fatigue. Outside the zone, measure the gap to the
                    // nearer end of the zone.
                    const inZone = simMean >= obPlan * 0.95 && simMean <= ob100 * 1.05;
                    const nearestZoneEdge = simMean < obPlan ? obPlan : (simMean > ob100 ? ob100 : simMean);
                    const expectGap = inZone ? 0 : Math.abs(simMean - nearestZoneEdge) / Math.max(1, nearestZoneEdge);
                    const verdict = inZone || expectGap < 0.15 ? '✓' : expectGap < 0.30 ? '△' : '✗';
                    const verdictColor =
                      verdict === '✓' ? SW_COLORS.ok : verdict === '△' ? SW_COLORS.warn : SW_COLORS.alarm;
                    return (
                      <tr key={r.line.id} style={{ borderBottom: `1px solid ${SW_COLORS.line}` }}>
                        <td style={{ padding: '8px', fontWeight: 700 }}>{r.line.name}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: SW_FONTS.mono }}>{Math.round(ob100).toLocaleString()}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>{obPlan.toLocaleString()}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: SW_FONTS.mono, fontWeight: 800, color: SW_COLORS.brand }}>{Math.round(simMean).toLocaleString()}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>±{simStd.toFixed(0)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: SW_FONTS.mono }}>{(ratio * 100).toFixed(0)}%</td>
                        <td style={{ padding: '8px', textAlign: 'center', fontWeight: 900, color: verdictColor }}>{verdict}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.5 }}>
              Read this row: <strong>OB @100%</strong> is the IE's theoretical ceiling (bottleneck SMV × shift); <strong>OB @ Plan 60%</strong> is what the IE actually expects a real operator to deliver. The simulator usually lands between the two because it models stochastic service variance but doesn't yet model operator fatigue or breakdowns.
            </div>
          </Card>
        </HideableBox>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap: 10, marginBottom: 20 }}>
        <HideableBox toggleSize={22} toggleOffset={6}>
          <KpiTile
            label={`OUTPUT / ${periodLabel}`}
            mean={scaledProducedMean}
            std={scaledProducedStd}
            unit="pcs"
            formatter={(v) => Math.round(v).toLocaleString()}
            color={SW_COLORS.brand}
            info={
              <KpiFormula
                formula="output = pieces produced in one 480-min shift × period multiplier"
                where={[
                  ['pieces produced', 'finished pieces that exited the last station of the line during the shift'],
                  ['period multiplier', `${periodLabel} → ×${periodMultiplier} (SHIFT ×1 · DAY ×1 · WEEK ×6 · MONTH ×26)`],
                ]}
                replication={runs > 1 ? `Mean across ${runs} replications (seeds ${REPORT_BASE_SEED}..${REPORT_BASE_SEED + runs - 1}); ± shows std of that mean.` : undefined}
              />
            }
          />
        </HideableBox>
        <HideableBox toggleSize={22} toggleOffset={6}>
          <KpiTile
            label="THROUGHPUT"
            mean={throughputPerHr}
            std={runs > 1 ? kpiSource.throughputPerHr.std : 0}
            unit="pcs/hr"
            formatter={(v) => Math.round(v).toLocaleString()}
            color={SW_COLORS.ok}
            info={
              <KpiFormula
                formula="throughput = pieces produced ÷ shift hours"
                where={[
                  ['shift hours', '480 simulated minutes ÷ 60 = 8 h'],
                  ['pieces produced', 'pieces exiting the line during the shift (post-warm-up)'],
                ]}
                replication={runs > 1 ? `Mean across ${runs} replications; ± shows std across runs.` : undefined}
              />
            }
          />
        </HideableBox>
        <HideableBox toggleSize={22} toggleOffset={6}>
          <KpiTile
            label="EFFICIENCY"
            mean={efficiency}
            std={runs > 1 ? kpiSource.efficiencyPct.std : 0}
            unit="%"
            formatter={(v) => v.toFixed(1)}
            color={efficiency >= 75 ? SW_COLORS.fabric : SW_COLORS.thread}
            info={
              <KpiFormula
                formula="efficiency = (Σ SAM earned ÷ Σ paid operator-minutes) × 100"
                where={[
                  ['SAM earned', 'pieces produced × per-operation SAM, summed over operations'],
                  ['paid operator-minutes', 'operators × shift minutes (480)'],
                ]}
                replication={runs > 1 ? `Mean across ${runs} replications; ± shows std across runs.` : undefined}
              />
            }
          />
        </HideableBox>
        <HideableBox toggleSize={22} toggleOffset={6}>
          <KpiTile
            label="MEAN LEAD"
            mean={meanLeadTime}
            std={runs > 1 ? kpiSource.meanLeadTime.std : 0}
            unit="min"
            formatter={(v) => v.toFixed(1)}
            color={SW_COLORS.bobbin}
            info={
              <KpiFormula
                formula="mean lead = average (exit-time − release-time) across finished bundles"
                where={[
                  ['release-time', 'sim-clock minute the bundle enters the first station'],
                  ['exit-time', 'sim-clock minute the bundle leaves the last station'],
                ]}
                note="Equivalent to Little's Law check: WIP ≈ throughput × lead-time."
                replication={runs > 1 ? `Mean across ${runs} replications; ± shows std across runs.` : undefined}
              />
            }
          />
        </HideableBox>
        <HideableBox toggleSize={22} toggleOffset={6}>
          <KpiTile
            label="WIP"
            mean={wipBundles}
            std={runs > 1 ? kpiSource.wipBundles.std : 0}
            unit="bundles"
            formatter={(v) => Math.round(v).toLocaleString()}
            color={SW_COLORS.warn}
            info={
              <KpiFormula
                formula="WIP = time-averaged number of bundles on the line"
                where={[
                  ['time-averaged', '∫ N(t) dt ÷ shift minutes, with N(t) = bundles released − bundles exited at sim-minute t'],
                ]}
                note="Counted in bundles, not pieces — multiply by bundle size for piece-WIP."
                replication={runs > 1 ? `Mean across ${runs} replications; ± shows std across runs.` : undefined}
              />
            }
          />
        </HideableBox>
        <HideableBox toggleSize={22} toggleOffset={6}>
          <KpiTile
            label="UTIL"
            mean={utilization * 100}
            std={runs > 1 ? kpiSource.utilization.std * 100 : 0}
            unit="%"
            formatter={(v) => v.toFixed(0)}
            color={SW_COLORS.thread}
            info={
              <KpiFormula
                formula="util = (Σ busy operator-minutes ÷ Σ paid operator-minutes) × 100"
                where={[
                  ['busy', 'operator processing a bundle (not idle, not blocked, not starved)'],
                  ['paid', 'operators × shift minutes (480)'],
                ]}
                note="Mean across stations — single bottleneck stations may sit near 100% while the line average is lower."
                replication={runs > 1 ? `Mean across ${runs} replications; ± shows std across runs.` : undefined}
              />
            }
          />
        </HideableBox>
      </div>

      {perLineAggs.length > 1 && factoryAgg && (
        <>
          <PerLineKpiTable rows={perLineAggs} factoryAgg={factoryAgg} periodLabel={periodLabel} periodMultiplier={periodMultiplier} />
          <HideableBox style={{ marginBottom: 20 }}>
            <Card padding={20}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, paddingRight: 36, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ ...SW_TYPE.heading }}>PER-LINE OUTPUT OVER TIME</div>
                  <div style={{ fontSize: 12, color: SW_COLORS.muted }}>
                    Cumulative pieces produced per line, sampled every 5 sim-minutes and averaged across all {runs} replication{runs === 1 ? '' : 's'}.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 11, fontFamily: SW_FONTS.mono, fontWeight: 700, flexWrap: 'wrap' }}>
                  {perLineAggs.map((r) => (
                    <span key={r.line.id}>
                      <span style={{ color: DEPT_LINE_COLORS[r.line.color] ?? SW_COLORS.brand }}>■</span> {r.line.name}
                    </span>
                  ))}
                </div>
              </div>
              <MultiLineHistoryChart rows={perLineAggs} />
            </Card>
          </HideableBox>
        </>
      )}
      </>
      )}

      {/* Yamazumi — drag operations between operators to rebalance */}
      {tab === 'balance' && (
      <HideableBox style={{ marginBottom: 14 }}>
        <Card padding={20}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10, gap: 14, flexWrap: 'wrap', paddingRight: 36 }}>
            <div>
              <div style={{ ...SW_TYPE.heading }}>YAMAZUMI · LINE BALANCE</div>
              <div style={{ fontSize:12, color: SW_COLORS.muted }}>
                Operator-by-operation SMV stack with takt-line overlay. Drag any segment onto another operator's bar to rebalance manually. Bars over the takt line are bottlenecks.
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap: 14, flexWrap: 'wrap' }}>
              {/* Line presets — quick-load a wired line's garment + operator
                  target so the Yamazumi reflects the bulletin that line is
                  actually running. Without this the user has to re-derive
                  Line 2's setup from the LiveSim picker and type it in. */}
              {lineBuildsForReports.filter((lb) => lb.ok && lb.line.garmentId).length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ ...SW_TYPE.kicker, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>LOAD LINE</span>
                  {lineBuildsForReports.filter((lb) => lb.ok && lb.line.garmentId).map((lb) => {
                    const accent = DEPT_LINE_COLORS[lb.line.color] ?? SW_COLORS.brand;
                    const lineGarmentId = lb.line.garmentId!;
                    const isActive = yamGarment === lineGarmentId
                      && yamOperators === (lb.line.operatorTarget ?? yamOperators);
                    return (
                      <button
                        key={lb.line.id}
                        onClick={() => {
                          setYamGarment(lineGarmentId);
                          if (lb.line.operatorTarget) setYamOperators(lb.line.operatorTarget);
                        }}
                        title={`Set Yamazumi to ${lb.line.name}: garment "${garments.byId[lineGarmentId]?.name ?? lineGarmentId}"${lb.line.operatorTarget ? ` · ${lb.line.operatorTarget} operators` : ''}`}
                        style={{
                          padding: '4px 10px',
                          border: `1px solid ${isActive ? accent : SW_COLORS.line}`,
                          borderLeft: `4px solid ${accent}`,
                          background: isActive ? `${accent}22` : 'transparent',
                          borderRadius: SW_RADIUS.sm,
                          fontFamily: SW_FONTS.mono,
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: '0.05em',
                          color: isActive ? '#fff' : SW_COLORS.ink,
                          cursor: 'pointer',
                        }}
                      >
                        {lb.line.name.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              )}
              <ToggleGroup value={yamGarment} onChange={setYamGarment} options={garments.all.map(g => ({ value: g.id, label: g.name.replace(/\s*\(.*\)/, '') }))}/>
              <div style={{ display:'flex', alignItems:'center', gap: 8 }}>
                <span style={{ ...SW_TYPE.kicker, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>OPERATORS</span>
                <input type="number" min={4} max={60} value={yamOperators}
                  onChange={e => setYamOperators(Math.max(4, Math.min(60, parseInt(e.target.value) || 4)))}
                  style={{ width: 56, padding: '4px 8px', border: `1px solid ${SW_COLORS.line}`, borderRadius: SW_RADIUS.sm, fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 13 }}/>
              </div>
              {storedOverride && (
                <Button variant="ghost" size="sm" onClick={() => clearYamazumiOverride(yamGarment)}>Reset to auto</Button>
              )}
            </div>
          </div>
          <Yamazumi assignments={yamAssignments} taktMin={yamTakt} height={300} onChange={handleYamazumiChange}/>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginTop: 8 }}>
            <Stat label="GARMENT SAM" value={yamTemplate.totalSmv.toFixed(2)} unit="min"/>
            <Stat label="TAKT" value={yamTakt.toFixed(3)} unit="min" color={SW_COLORS.brand}/>
            <Stat label="BOTTLENECK" value={yamBottleneck.toFixed(3)} unit="min" color={SW_COLORS.alarm}/>
            <Stat label="BALANCE LOSS" value={yamBalance.toFixed(1)} unit="%" color={yamBalance > 25 ? SW_COLORS.alarm : SW_COLORS.thread}/>
            <Stat label="LINE EFF" value={yamEfficiency.toFixed(1)} unit="%" color={yamEfficiency >= 80 ? SW_COLORS.ok : SW_COLORS.thread}/>
          </div>
          {/* Sempai's 3 line-balance metrics, surfaced as their own tier so
              the user can read them as a related triad rather than mixed in
              with the engine-scope KPIs above. LBR = fairness across the
              line as built; LBE = capacity used vs takt; Opt manning =
              theoretical minimum headcount at takt. */}
          <div style={{ marginTop: 10, padding: '6px 10px 4px', border: `1px dashed ${SW_COLORS.line}`, borderRadius: SW_RADIUS.sm, background: '#fafaf6' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, justifyContent: 'space-between' }}>
              <div style={{ ...SW_TYPE.kicker, fontWeight: 800, letterSpacing: '0.08em', color: SW_COLORS.muted }}>
                3-METRIC LINE BALANCE  ·  FAIRNESS · TAKT-EFFICIENCY · MANNING
              </div>
              <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted }}>
                Takt {yamTaktReal.toFixed(3)} min · source: {taktSource === 'order'
                  ? `Order ${latestOrder?.po ?? '—'} (${latestOrder?.qty ?? 0} pcs / ${latestOrder?.deadlineDays ?? 0} d)`
                  : 'bottleneck SMV (no committed order — commit one for demand-driven takt)'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <div>
                <Stat
                  label="LINE BALANCE RATIO"
                  value={yamLBR.toFixed(1)}
                  unit="%"
                  color={yamLBR >= 85 ? SW_COLORS.ok : yamLBR >= 75 ? SW_COLORS.thread : SW_COLORS.alarm}
                  info={<><b>Fairness</b> across stations.<br/>LBR = Σ stationSMV ÷ (N × longest station) × 100.<br/>Complement of Balance Loss. 100 % = every station as loaded as the bottleneck.</>}
                />
                <div style={{ marginTop: 4, fontFamily: SW_FONTS.mono, fontSize: 9, color: SW_COLORS.muted }}>
                  Fairness across stations · complement of Balance Loss
                </div>
              </div>
              <div>
                <Stat
                  label="LINE BALANCE EFF"
                  value={yamLBE.toFixed(1)}
                  unit="%"
                  color={
                    yamLBE > 100 ? SW_COLORS.alarm
                    : yamLBE >= 85 ? SW_COLORS.ok
                    : yamLBE >= 70 ? SW_COLORS.thread
                    : SW_COLORS.alarm
                  }
                  info={<><b>Capacity used vs takt.</b><br/>LBE = Σ stationSMV ÷ (N × takt) × 100.<br/>&lt;100 = spare capacity vs demand; &gt;100 = infeasible at current manning.</>}
                />
                <div style={{ marginTop: 4, fontFamily: SW_FONTS.mono, fontSize: 9, color: SW_COLORS.muted }}>
                  {yamLBE > 100 ? 'Infeasible — bottleneck slower than takt' : 'Capacity used vs takt'}
                </div>
              </div>
              <div>
                <Stat
                  label="OPTIMUM MANNING"
                  value={yamOptManning.toFixed(0)}
                  unit={`/ ${yamOperators} now`}
                  color={
                    yamOptManning > yamOperators ? SW_COLORS.alarm
                    : yamOptManning === yamOperators ? SW_COLORS.ok
                    : SW_COLORS.thread
                  }
                  info={<><b>Theoretical headcount</b> at takt.<br/>Manning = ⌈ Garment SAM ÷ takt ⌉.<br/>The minimum operators a perfectly balanced line would need to hit takt — gap to actual = labour cost of imbalance.</>}
                />
                <div style={{ marginTop: 4, fontFamily: SW_FONTS.mono, fontSize: 9, color: SW_COLORS.muted }}>
                  {yamOptManning > yamOperators
                    ? `Need ${yamOptManning - yamOperators} more to hit takt`
                    : yamOptManning < yamOperators
                      ? `${yamOperators - yamOptManning} above theoretical floor`
                      : 'At theoretical floor'}
                </div>
              </div>
            </div>
          </div>
          {/* WHAT TO FIX — actionable suggestions derived from the live
              metrics. Severity-coloured rows so the user can scan to the
              red items first. Empty state shows a "healthy" info row. */}
          <div style={{ marginTop: 12, border: `1px solid ${SW_COLORS.line}`, borderRadius: SW_RADIUS.sm, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: SW_COLORS.ink, color: SW_COLORS.paper, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 900, letterSpacing: '0.08em' }}>
                WHAT TO FIX  ·  {balanceSuggestions.length} {balanceSuggestions.length === 1 ? 'item' : 'items'}
              </div>
              <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: '#dcd6c6' }}>
                Updates live as you change garment, operators, or drag the Yamazumi
              </div>
            </div>
            <div>
              {balanceSuggestions.map((s, i) => {
                const colourBySeverity: Record<typeof s.severity, { bar: string; chip: string; chipText: string; label: string }> = {
                  critical:    { bar: SW_COLORS.alarm,  chip: SW_COLORS.alarm,  chipText: '#fff',         label: 'CRITICAL' },
                  warn:        { bar: '#d49a2a',        chip: '#d49a2a',        chipText: '#fff',         label: 'WARN' },
                  opportunity: { bar: SW_COLORS.brand,  chip: SW_COLORS.brand,  chipText: '#fff',         label: 'OPPORTUNITY' },
                  info:        { bar: SW_COLORS.line,   chip: '#eee9d8',        chipText: SW_COLORS.ink,  label: 'INFO' },
                };
                const c = colourBySeverity[s.severity];
                return (
                  <div
                    key={s.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gap: 12,
                      padding: '10px 12px',
                      borderTop: i === 0 ? 'none' : `1px solid ${SW_COLORS.line}`,
                      borderLeft: `4px solid ${c.bar}`,
                      background: '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', paddingTop: 1 }}>
                      <span
                        style={{
                          padding: '2px 6px',
                          ...SW_TYPE.overline,
                          fontWeight: 900,
                          background: c.chip,
                          color: c.chipText,
                          borderRadius: 3,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.label}
                      </span>
                    </div>
                    <div>
                      <div style={{ fontFamily: SW_FONTS.display, fontSize: 13, fontWeight: 800, color: SW_COLORS.ink, marginBottom: 2 }}>
                        {s.title}
                      </div>
                      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.45, marginBottom: 4 }}>
                        {s.detail}
                      </div>
                      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.ink, fontWeight: 600, lineHeight: 1.45 }}>
                        <span style={{ color: SW_COLORS.muted, fontWeight: 700 }}>→ </span>
                        {s.action}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ marginTop: 8, fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted }}>
            Smoothness index {yamSmoothness.toFixed(3)} (lower = smoother) · {storedOverride ? `Manual override (${storedOverride.length} operators)` : 'LPT auto-assignment'} · Source bulletin: {yamTemplate.operations.length} operations from {yamTemplate.name}
          </div>
        </Card>
      </HideableBox>
      )}

      {tab === 'performance' && !factoryScope && (
        // No wired line means there is nothing real to report on. This used to
        // fall back to `agg` — a replication of a line synthesised from the
        // selected garment template — so the Performance tab showed confident
        // KPIs for a factory the user had never built. An empty state that says
        // what to do is worth more than a plausible number about nothing.
        <LineSimEmpty
          reason={
            reportsTwin.workstations.length === 0 ? 'no-stations' : 'stations-not-in-a-line'
          }
          unassignedStationCount={
            reportsTwin.workstations.filter((ws) => !ws.lineId).length
          }
          what="Performance reporting"
        />
      )}

      {tab === 'performance' && factoryScope && (() => {
        // Time-series + station data, built once so the whole chart grid shares
        // one dataset. Sums every wired line in the factory.
        const history = sumHistories(perLineAggs.map((r) => r.agg.firstHistory));
        const stations = perLineAggs.flatMap((r) =>
          r.agg.firstStations.map((s) => ({ ...s, lineName: r.line.name })),
        );

        // Theoretical max throughput (pcs/hr) at the line's bottleneck SMV.
        // For factory scope, sum across each line's own ceiling. This is
        // the steady-state ceiling the engine is asymptotically approaching
        // and serves as the dashed reference line on the throughput chart.
        const targetThroughputPerHr = factoryScope
          ? perLineAggs.reduce((sum, r) => {
              const garmentOps = r.agg.firstStations.length > 0
                ? r.agg.firstStations
                : [];
              const maxSmv = garmentOps.reduce(
                (m, s) => Math.max(m, s.smv * (s.serversTotal || 1) > 0 ? s.smv / (s.serversTotal || 1) : s.smv),
                0,
              );
              return sum + (maxSmv > 0 ? 60 / maxSmv : 0);
            }, 0)
          : (() => {
              const maxSmv = yamTemplate.operations.reduce(
                (m, o) => Math.max(m, o.smv),
                0,
              );
              return maxSmv > 0 ? 60 / maxSmv : 0;
            })();

        // Approximate warm-up: time for the first bundle to traverse the
        // line, ≈ Σ SMV × bundleSize. We pick the *longest* line in
        // factory scope so the shaded region covers everyone. Empty in
        // edge cases — the chart degrades gracefully.
        const warmupMin = factoryScope
          ? Math.max(
              0,
              ...perLineAggs.map((r) => {
                const totalSmv = r.agg.firstStations.reduce((s, st) => s + st.smv, 0);
                return totalSmv * r.bundleSize;
              }),
            )
          : yamTemplate.totalSmv * 1; // bundle size factor unknown at this scope

        return (
          <>
            {/* ── Output & throughput trends ──────────────────────────── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
              <HideableBox>
                <Card padding={20}>
                  <ChartHeader
                    title="CUMULATIVE OUTPUT"
                    sub={
                      factoryScope
                        ? `Factory cumulative — sum across all ${factoryLineCount} wired ${factoryLineCount === 1 ? 'line' : 'lines'}, sampled every 5 sim-minutes.`
                        : `Bundles → pieces produced over the 480-min shift. ${runs > 1 ? `Mean of ${runs} replications shown; shaded band = ±1 std.` : 'Single seed.'}`
                    }
                    legend={[
                      { color: SW_COLORS.brand, label: 'Cumulative produced' },
                      { color: SW_COLORS.faint, label: 'Theoretical ceiling', dashed: true },
                      { color: `${SW_COLORS.ink}0F`, label: 'Warm-up region' },
                    ]}
                  />
                  <CumulativeOutputChart
                    history={history}
                    targetPerHr={targetThroughputPerHr}
                    warmupMin={warmupMin}
                  />
                  {history.length >= 2 && (() => {
                    const finalProduced = history[history.length - 1]?.produced ?? 0;
                    const ceiling = (targetThroughputPerHr * (history[history.length - 1]?.time ?? 480)) / 60;
                    const gap = ceiling > 0 ? Math.max(0, 100 - (finalProduced / ceiling) * 100) : 0;
                    return (
                      <ChartInference
                        observation={`The orange curve reaches ${Math.round(finalProduced).toLocaleString()} pieces by the end of the shift, sitting ${gap.toFixed(0)}% below the dashed theoretical ceiling of ${Math.round(ceiling).toLocaleString()} pieces.`}
                        inference={
                          gap < 8
                            ? `The line is well-balanced — bundles traverse the floor almost as fast as the bottleneck SMV allows. Warm-up loss accounts for most of the residual gap.`
                            : gap < 20
                              ? `The gap signals normal bottleneck loss + warm-up: the first bundle takes time to reach the sink, and stations downstream of the slowest op sit idle until WIP fills. Expected for a freshly-started shift.`
                              : `A gap this large means real blockage or starvation: either the bottleneck SMV is much slower than the rest of the line (re-balance needed) or a station is starved (check upstream WIP).`
                        }
                        action={
                          gap >= 20
                            ? 'Open the Station Utilization chart below to find the choked op, then split or re-balance it.'
                            : undefined
                        }
                      />
                    );
                  })()}
                </Card>
              </HideableBox>

              <HideableBox>
                <Card padding={20}>
                  <ChartHeader
                    title="THROUGHPUT vs TIME"
                    sub={`Instantaneous pcs/hr from the engine. Dashed reference = ${Math.round(targetThroughputPerHr).toLocaleString()} pcs/hr — the bottleneck-SMV ceiling.`}
                    legend={[
                      { color: SW_COLORS.ok, label: 'Observed pcs/hr' },
                      { color: SW_COLORS.faint, label: 'Theoretical max', dashed: true },
                    ]}
                  />
                  <ThroughputChart
                    history={history}
                    targetPerHr={targetThroughputPerHr}
                    warmupMin={warmupMin}
                  />
                  {history.length >= 2 && (() => {
                    const tail = history.slice(-Math.max(3, Math.floor(history.length / 4)));
                    const steadyMean = tail.reduce((s, h) => s + h.throughputPerHr, 0) / Math.max(1, tail.length);
                    const peak = Math.max(...history.map((h) => h.throughputPerHr));
                    return (
                      <ChartInference
                        observation={`Steady-state throughput averages ${steadyMean.toFixed(0)} pcs/hr in the final quarter of the shift; the run's peak rate was ${peak.toFixed(0)} pcs/hr.`}
                        inference={
                          steadyMean / Math.max(1, targetThroughputPerHr) > 0.92
                            ? `Steady-state is within 8% of the theoretical ceiling — service-time variance (the stochastic part) is the only meaningful loss. Predictable production.`
                            : steadyMean / Math.max(1, targetThroughputPerHr) > 0.75
                              ? `Steady-state runs at ${((steadyMean / Math.max(1, targetThroughputPerHr)) * 100).toFixed(0)}% of the ceiling. Normal range for a real factory; the gap is variance + small starvation events.`
                              : `The line is leaking throughput at steady state. Look at the lowest utilization stations — those are starving downstream because something earlier is bottlenecking.`
                        }
                      />
                    );
                  })()}
                </Card>
              </HideableBox>
            </div>

            {/* ── WIP & Little's Law ──────────────────────────────────── */}
            <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:14, marginBottom:14 }}>
              <HideableBox>
                <Card padding={20}>
                  <ChartHeader
                    title="WIP vs TIME"
                    sub="Bundles in flight at each sample. Rising = buffers filling; flat plateau = steady-state; drop = drain-down. Spikes flag transient blocking."
                    legend={[
                      { color: SW_COLORS.bobbin, label: 'WIP (bundles)' },
                      { color: SW_COLORS.warn, label: 'Mean WIP', dashed: true },
                    ]}
                  />
                  <WipChart history={history} meanWip={wipBundles} />
                  {history.length >= 2 && (() => {
                    const peak = Math.max(...history.map((h) => h.wip));
                    const tail = history.slice(-Math.max(3, Math.floor(history.length / 4)));
                    const tailMean = tail.reduce((s, h) => s + h.wip, 0) / Math.max(1, tail.length);
                    const startWip = history[0].wip;
                    const drift = tailMean - startWip;
                    return (
                      <ChartInference
                        observation={`WIP peaks at ${peak.toFixed(1)} bundles and settles around ${tailMean.toFixed(1)} bundles in the back half of the shift. Net drift from start to steady state: ${(drift >= 0 ? '+' : '') + drift.toFixed(1)} bundles.`}
                        inference={
                          Math.abs(drift) < 2
                            ? `WIP is stable — what enters the line leaves the line. Inventory at every buffer is in equilibrium, so the operator-pool sizing is appropriate for the demand.`
                            : drift > 0
                              ? `WIP is climbing — arrivals exceed service capacity. Either the source is over-feeding the line or a downstream bottleneck is back-pressuring upstream stations. Lead time will keep growing if this continues.`
                              : `WIP is bleeding off — pieces are leaving faster than the source replaces them. The line will starve when the residual WIP drains.`
                        }
                        action={
                          Math.abs(drift) >= 5
                            ? 'Use Little\'s Law (right panel) to compare actual mean lead time against L/λ and confirm the imbalance is real, not warm-up.'
                            : undefined
                        }
                      />
                    );
                  })()}
                </Card>
              </HideableBox>

              <HideableBox>
                <Card padding={20}>
                  <LittlesLawPanel
                    wipBundles={wipBundles}
                    throughputPerHr={throughputPerHr}
                    meanLeadTime={meanLeadTime}
                    bundleSize={
                      factoryScope && perLineAggs.length > 0
                        ? perLineAggs.reduce((s, r) => s + r.bundleSize, 0) / perLineAggs.length
                        : 1
                    }
                  />
                </Card>
              </HideableBox>
            </div>

            {/* ── Station-level diagnostics ───────────────────────────── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
              <HideableBox>
                <Card padding={20}>
                  <ChartHeader
                    title="STATION UTILIZATION"
                    sub={
                      stations.length === 0
                        ? 'Run a shift to populate.'
                        : `${stations.length} stations · zones: ≤70 % healthy · 70–90 % busy · >90 % bottleneck risk.`
                    }
                  />
                  <UtilizationBarChart stations={stations} />
                  {stations.length > 0 && (() => {
                    const utils = stations.map((st) => st.utilization * 100);
                    const high = utils.filter((u) => u > 90).length;
                    const low = utils.filter((u) => u < 50).length;
                    const max = Math.max(...utils);
                    const spread = max - Math.min(...utils);
                    return (
                      <ChartInference
                        observation={`${high} of ${stations.length} stations run hot (>90% utilization), ${low} run cool (<50%). Utilization spread across the line is ${spread.toFixed(0)} percentage points.`}
                        inference={
                          spread > 50
                            ? `The line is unbalanced — some operators are saturated while others have idle minutes every cycle. The hot stations are the binding constraint on throughput; the cool ones are wasted capacity.`
                            : spread > 25
                              ? `Mild imbalance. The hot stations limit throughput; cool stations could absorb a faster takt if the bottleneck were relieved.`
                              : `The line is tightly balanced — every station runs at a similar pace. This is the IE goal: minimum bottleneck loss + minimum idle time.`
                        }
                        action={
                          spread > 25 && high > 0
                            ? `Add a parallel server (operator + machine) at the highest-utilization op, or transfer a sub-task to a cool station to flatten the bar chart.`
                            : undefined
                        }
                      />
                    );
                  })()}
                </Card>
              </HideableBox>

              <HideableBox>
                <Card padding={20}>
                  <ChartHeader
                    title="QUEUE DEPTH · PARETO"
                    sub="Where bundles pile up. Bars = mean queue length per station; line = cumulative share of total queueing — the Pareto 80/20 of WIP."
                  />
                  <QueueParetoChart stations={stations} />
                  {stations.length > 0 && (() => {
                    const sortedQ = stations.map((st) => st.queueLen).sort((a, b) => b - a);
                    const total = sortedQ.reduce((s, q) => s + q, 0);
                    if (total <= 0) {
                      return (
                        <ChartInference
                          observation="No station carries a meaningful queue at end of shift."
                          inference="The line is over-served relative to demand — operators wait for bundles rather than the other way round. Throughput is source-limited, not capacity-limited."
                          action="Raise the source arrival rate or load orders into the line via the Orders panel to test the line's real capacity."
                        />
                      );
                    }
                    let cumulative = 0;
                    let topN = 0;
                    for (const q of sortedQ) {
                      cumulative += q;
                      topN += 1;
                      if (cumulative / total >= 0.8) break;
                    }
                    const topShare = ((sortedQ[0] / total) * 100).toFixed(0);
                    return (
                      <ChartInference
                        observation={`${topN} of ${stations.length} stations hold 80% of the total queue. The top station alone holds ${topShare}% of all bundles waiting in queue.`}
                        inference={
                          topN <= 2
                            ? `Classic Pareto bottleneck — almost all WIP collects in front of one or two ops. Those are the constraints; everything else is downstream slack.`
                            : `WIP is spread across multiple stations, suggesting the line has several near-bottlenecks competing rather than one dominant constraint. Hard to fix with a single intervention.`
                        }
                        action={
                          topN <= 2
                            ? `Click into the bar with the largest queue — that's the single op to add capacity to for the biggest throughput gain.`
                            : `Use Yamazumi (LineBalance tab) to find the broader pacing problem; spot-fixes won't help here.`
                        }
                      />
                    );
                  })()}
                </Card>
              </HideableBox>
            </div>
          </>
        );
      })()}

      {tab === 'performance' && perLineAggs.length > 0 && (
      <div style={{ marginBottom:14 }}>
        <HideableBox>
          <Card padding={20}>
            <div style={{ ...SW_TYPE.heading, marginBottom:6, paddingRight: 36 }}>BY SYSTEM</div>
            <div style={{ fontSize: 12, color: SW_COLORS.muted, marginBottom: 14 }}>
              Efficiency = SAM-earned ÷ operator-minutes, weighted across the lines on each system. Pieces are summed across those lines{periodMultiplier > 1 ? ` × ${periodMultiplier} (${periodLabel.toLowerCase()})` : ''}.
            </div>
            {(() => {
              const SYSTEM_META: Record<string, { label: string; color: string }> = {
                PBS:      { label: 'PBS',      color: SW_COLORS.brand },
                modular:  { label: 'Modular',  color: SW_COLORS.fabric },
                UPS:      { label: 'UPS',      color: SW_COLORS.bobbin },
                synchro:  { label: 'Synchro',  color: SW_COLORS.ok },
                straight: { label: 'Straight', color: SW_COLORS.thread },
              };
              type Bucket = { key: string; label: string; color: string; lines: number; produced: number; opMinutes: number; samEarned: number; sharedStations: number; sharedSavings: number };
              // Per-line shared-station rollup via the shared helper, so this
              // card and SewingLineBand can't drift on the math.
              const byKey: Record<string, Bucket> = {};
              for (const r of perLineAggs) {
                const key = r.line.productionSystem;
                const meta = SYSTEM_META[key] ?? { label: key, color: SW_COLORS.muted };
                const b = byKey[key] ?? { key, label: meta.label, color: meta.color, lines: 0, produced: 0, opMinutes: 0, samEarned: 0, sharedStations: 0, sharedSavings: 0 };
                b.lines += 1;
                b.produced += r.agg.producedPieces.mean;
                b.opMinutes += r.operators * SHIFT_MIN;
                b.samEarned += r.agg.producedPieces.mean * r.totalSmv;
                const sh = shareDebtForLine(reportsTwin, r.line.id);
                b.sharedStations += sh.stations;
                b.sharedSavings += sh.savings;
                byKey[key] = b;
              }
              const buckets = Object.values(byKey).sort((a, b) => b.produced - a.produced);
              if (buckets.length === 0) return null;
              return buckets.map((b) => {
                const efficiency = b.opMinutes > 0 ? (b.samEarned / b.opMinutes) * 100 : 0;
                return (
                  <div key={b.key} style={{ marginBottom: 12 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:4 }}>
                      <span style={{ fontWeight:700, fontSize:13 }}>
                        {b.label}
                        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 600, color: SW_COLORS.muted, marginLeft: 6 }}>
                          · {b.lines} {b.lines === 1 ? 'line' : 'lines'}
                        </span>
                        {b.sharedStations > 0 && (
                          <span
                            title={`${b.sharedStations} station${b.sharedStations === 1 ? '' : 's'} share an operator · ${b.sharedSavings.toFixed(1)} operator-equivalent${b.sharedSavings >= 1.05 ? 's' : ''} saved (each ⇄ slows that station's cycle 1/shareFrac×)`}
                            style={{
                              ...SW_TYPE.kicker,
                              color: SW_COLORS.bobbin,
                              marginLeft: 8,
                              padding: '1px 6px',
                              border: `1px solid ${SW_COLORS.bobbin}`,
                              borderRadius: 3,
                              letterSpacing: '0.05em',
                            }}
                          >
                            ⇄ {b.sharedStations} SHARED · −{b.sharedSavings.toFixed(1)} OPR
                          </span>
                        )}
                      </span>
                      <span style={{ fontFamily: SW_FONTS.mono, fontSize:12, fontWeight:700, color: b.color }}>{efficiency.toFixed(1)}%</span>
                    </div>
                    <Progress value={Math.min(100, efficiency)} color={b.color} height={8}/>
                    <div style={{ fontSize:10, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono, marginTop:2 }}>
                      {Math.round(b.produced * periodMultiplier).toLocaleString()} pcs
                    </div>
                  </div>
                );
              });
            })()}
          </Card>
        </HideableBox>
      </div>
      )}

      {tab === 'scenarios' && (
        <ScenariosPanel embedded />
      )}

      <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop: 18 }}>
        <Button variant="secondary" icon="↓">Export PDF</Button>
        {!embedded && (
          <Button variant="dark" icon="✓" onClick={() => navigate('/line')}>Back to builder</Button>
        )}
      </div>

      {saveOpen && (
        <SaveScenarioModal
          name={saveName}
          notes={saveNotes}
          onNameChange={setSaveName}
          onNotesChange={setSaveNotes}
          summary={{
            template: factoryScope ? `Factory · ${factoryLineCount} wired ${factoryLineCount === 1 ? 'line' : 'lines'}` : yamTemplate.name,
            operators: factoryScope
              ? perLineAggs.reduce((sum, l) => sum + l.operators, 0)
              : yamOperators,
            runs: kpiSource.n,
            throughputPerHr: kpiSource.throughputPerHr.mean,
            efficiencyPct: kpiSource.efficiencyPct.mean,
          }}
          onCancel={() => setSaveOpen(false)}
          onConfirm={() => {
            const trimmed = saveName.trim();
            if (!trimmed) return;
            project.saveScenario({
              name: trimmed,
              notes: saveNotes.trim() || undefined,
              twin: reportsTwin,
              garmentTemplateId: yamGarment,
              operators:
                perLineAggs.length > 0
                  ? perLineAggs.reduce((sum, l) => sum + l.operators, 0)
                  : yamOperators,
              kpis: {
                producedPieces: kpiSource.producedPieces.mean,
                throughputPerHr: kpiSource.throughputPerHr.mean,
                efficiencyPct: kpiSource.efficiencyPct.mean,
                meanLeadTime: kpiSource.meanLeadTime.mean,
                utilization: kpiSource.utilization.mean,
                wipBundles: kpiSource.wipBundles.mean,
                bottleneckOpName: kpiSource.bottleneckOpName,
                bottleneckQueue: kpiSource.bottleneckQueue,
                replicationCount: kpiSource.n,
                std: kpiSource.n > 1 ? {
                  producedPieces: kpiSource.producedPieces.std,
                  throughputPerHr: kpiSource.throughputPerHr.std,
                  efficiencyPct: kpiSource.efficiencyPct.std,
                  meanLeadTime: kpiSource.meanLeadTime.std,
                  utilization: kpiSource.utilization.std,
                  wipBundles: kpiSource.wipBundles.std,
                } : undefined,
              },
            });
            setSaveOpen(false);
            setTab('scenarios');
          }}
        />
      )}
    </div>
  );
}

type ReportTab = 'performance' | 'balance' | 'validation' | 'scenarios';

interface ReportTabBarProps {
  value: ReportTab;
  onChange: (next: ReportTab) => void;
  hasPml: boolean;
}

/** Underline-style segmented tabs sitting under the Reports SectionHeader.
 *  The badge on the Validation tab tells the user when there's something
 *  to look at — a loaded reference paper, or observed PML KPIs. */
function ReportTabBar({ value, onChange, hasPml }: ReportTabBarProps) {
  const tabs: { id: ReportTab; label: string; hint: string; badge?: string }[] = [
    { id: 'performance', label: 'Performance', hint: 'KPIs · output · efficiency' },
    { id: 'balance',     label: 'Line Balance', hint: 'Yamazumi · takt · efficiency' },
    {
      id: 'validation',
      label: 'Validation',
      hint: 'Reference paper · PML run',
      badge: hasPml ? 'PML' : undefined,
    },
    { id: 'scenarios',   label: 'Scenarios',   hint: 'Saved runs · compare KPIs' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        marginBottom: 18,
        borderBottom: `1px solid ${SW_COLORS.line}`,
      }}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.color = SW_COLORS.ink;
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.color = SW_COLORS.muted;
            }}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '10px 18px 12px',
              color: active ? SW_COLORS.ink : SW_COLORS.muted,
              ...SW_TYPE.body,
              fontWeight: active ? 800 : 600,
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              position: 'relative',
              transition: 'color 100ms',
            }}
          >
            <span>{t.label}</span>
            <span
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 600,
                color: active ? SW_COLORS.muted : SW_COLORS.faint,
                letterSpacing: '0.04em',
              }}
            >
              {t.hint}
            </span>
            {t.badge && (
              <span
                style={{
                  ...SW_TYPE.overline,
                  fontWeight: 800,
                  background: SW_COLORS.brandLite,
                  color: SW_COLORS.brandDeep,
                  padding: '2px 5px',
                  borderRadius: 3,
                }}
              >
                {t.badge}
              </span>
            )}
            {active && (
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: -1,
                  height: 2,
                  background: SW_COLORS.brand,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Save-as-scenario dialog. Replaces the legacy `window.prompt()` call so the
 *  flow works inside embedded preview / iframe contexts that suppress native
 *  prompts. Lets the user edit the auto-generated name and add free-form notes
 *  before committing. */
interface SaveScenarioModalProps {
  name: string;
  notes: string;
  summary: {
    template: string;
    operators: number;
    runs: number;
    throughputPerHr: number;
    efficiencyPct: number;
  };
  onNameChange: (s: string) => void;
  onNotesChange: (s: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function SaveScenarioModal({
  name,
  notes,
  summary,
  onNameChange,
  onNotesChange,
  onCancel,
  onConfirm,
}: SaveScenarioModalProps) {
  const canSave = name.trim().length > 0;
  return (
    <div
      role="dialog"
      aria-label="Save scenario"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: SW_COLORS.overlay,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(460px, 92%)',
          background: SW_COLORS.paper,
          borderRadius: 8,
          border: `1px solid ${SW_COLORS.line}`,
          boxShadow: '0 18px 50px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
          }}
        >
          <div style={{ ...SW_TYPE.heading, letterSpacing: '0.1em' }}>
            ✦ SAVE SCENARIO
          </div>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
            {summary.template} · {summary.operators} ops · {summary.runs > 1 ? `${summary.runs}× replications` : 'single seed'}
          </div>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...SW_TYPE.kicker, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '1px' }}>
              NAME
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) onConfirm();
                if (e.key === 'Escape') onCancel();
              }}
              style={{
                padding: '8px 10px',
                border: `1px solid ${SW_COLORS.line}`,
                borderRadius: SW_RADIUS.sm,
                background: '#fff',
                fontFamily: SW_FONTS.body,
                fontSize: 13,
                color: SW_COLORS.ink,
              }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '1px' }}>
              NOTES <span style={{ fontWeight: 500, opacity: 0.6 }}>(optional)</span>
            </span>
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              rows={3}
              placeholder="What did you change vs. baseline? Any caveats worth remembering."
              style={{
                padding: '8px 10px',
                border: `1px solid ${SW_COLORS.line}`,
                borderRadius: SW_RADIUS.sm,
                background: '#fff',
                fontFamily: SW_FONTS.body,
                fontSize: 13,
                color: SW_COLORS.ink,
                resize: 'vertical',
              }}
            />
          </label>

          <div style={{ display: 'flex', gap: 14, fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
            <span><b style={{ color: SW_COLORS.ink }}>{Math.round(summary.throughputPerHr).toLocaleString()}</b> pcs/hr</span>
            <span><b style={{ color: SW_COLORS.ink }}>{summary.efficiencyPct.toFixed(1)}%</b> efficiency</span>
          </div>
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="✦"
            onClick={onConfirm}
            disabled={!canSave}
          >
            Save scenario
          </Button>
        </div>
      </div>
    </div>
  );
}


/**
 * Per-line KPI table — surfaces a row per wired sewing line in twins that
 * carry more than one line. Lets the user see who's contributing what when
 * the aggregate tiles average across heterogeneous garments (e.g. Line 1
 * knit T-shirt + Line 2 woven shirt produce wildly different rates and a
 * single mean would hide that).
 */
function PerLineKpiTable({
  rows,
  factoryAgg,
  periodLabel,
  periodMultiplier,
}: {
  rows: Array<{ line: { id: string; name: string; color: string }; bundleSize: number; agg: AggregateKpis }>;
  /** Pre-computed factory aggregate (extensive sums + IE-weighted intensives).
   *  Sourced from the same helper that feeds the top KPI tiles so the FACTORY
   *  row never disagrees with the headline numbers. */
  factoryAgg: AggregateKpis;
  periodLabel: string;
  periodMultiplier: number;
}) {
  // Reading posture, not a preference — ephemeral, resets with the page.
  const [sortBy, setSortBy] = useState<'line' | 'eff' | 'wip' | 'output'>('line');
  const sortedRows = useMemo(() => {
    if (sortBy === 'line') return rows;
    const sorted = [...rows];
    if (sortBy === 'eff') sorted.sort((a, b) => a.agg.efficiencyPct.mean - b.agg.efficiencyPct.mean);
    else if (sortBy === 'wip') sorted.sort((a, b) => b.agg.wipBundles.mean - a.agg.wipBundles.mean);
    else sorted.sort((a, b) => b.agg.producedPieces.mean - a.agg.producedPieces.mean);
    return sorted;
  }, [rows, sortBy]);
  // Constraint line: lowest mean efficiency, ties broken by highest WIP.
  const bottleneckLineId = useMemo(() => {
    if (rows.length < 2) return null;
    let worst = rows[0];
    for (const r of rows.slice(1)) {
      const d = r.agg.efficiencyPct.mean - worst.agg.efficiencyPct.mean;
      if (d < 0 || (d === 0 && r.agg.wipBundles.mean > worst.agg.wipBundles.mean)) worst = r;
    }
    return worst.line.id;
  }, [rows]);
  return (
    <Card padding={16} style={{ marginBottom: 20 }}>
      <SectionHeader
        title="PER LINE"
        sub="Replication-mean KPIs run independently on each wired sewing line. FACTORY row sums extensive KPIs (output, throughput, WIP) and weights intensives (efficiency by operator-minutes, util by operator count, lead time by pieces)."
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ ...SW_TYPE.kicker, letterSpacing: '1px', color: SW_COLORS.muted }}>SORT</span>
            <HudSelect
              value={sortBy}
              onChange={(v) => setSortBy(v as typeof sortBy)}
              variant="light"
              size="sm"
              options={[
                { value: 'line', label: 'Line order' },
                { value: 'eff', label: 'Lowest efficiency first' },
                { value: 'wip', label: 'Highest WIP first' },
                { value: 'output', label: 'Highest output first' },
              ]}
            />
          </div>
        }
      />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: SW_FONTS.mono, fontSize: 12 }}>
          <thead>
            <tr style={{ color: SW_COLORS.muted, fontSize: 10, letterSpacing: '0.1em', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>LINE</th>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>{`OUTPUT / ${periodLabel}`}</th>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>THROUGHPUT</th>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>EFFICIENCY</th>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>MEAN LEAD</th>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>WIP</th>
              <th style={{ padding: '6px 8px', fontWeight: 700 }}>UTIL</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const accent = DEPT_LINE_COLORS[r.line.color] ?? SW_COLORS.brand;
              const isBottleneck = r.line.id === bottleneckLineId;
              return (
                <tr
                  key={r.line.id}
                  style={{
                    borderTop: `1px solid ${SW_COLORS.line}`,
                    borderLeft: isBottleneck ? `3px solid ${SW_COLORS.alarm}` : '3px solid transparent',
                  }}
                >
                  <td style={{ padding: '8px', textAlign: 'left' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 1, background: accent }} />
                      <span style={{ fontWeight: 800 }}>{r.line.name}</span>
                      {isBottleneck && (
                        <span
                          title={`Constraint line — lowest efficiency (${r.agg.efficiencyPct.mean.toFixed(1)}%). Slowest OP inside line: ${r.agg.bottleneckOpName} (Q=${Math.round(r.agg.bottleneckQueue)}).`}
                        >
                          <Tag color={SW_COLORS.alarm} soft>◆ BOTTLENECK</Tag>
                        </span>
                      )}
                    </span>
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', color: SW_COLORS.brand, fontWeight: 800 }}>
                    {Math.round(r.agg.producedPieces.mean * periodMultiplier).toLocaleString()}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', color: SW_COLORS.ok, fontWeight: 800 }}>
                    {Math.round(r.agg.throughputPerHr.mean).toLocaleString()}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{r.agg.efficiencyPct.mean.toFixed(1)}%</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{r.agg.meanLeadTime.mean.toFixed(1)} min</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{Math.round(r.agg.wipBundles.mean).toLocaleString()}</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: SW_COLORS.thread, fontWeight: 800 }}>
                    {Math.round(r.agg.utilization.mean * 100)}%
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: `2px solid ${SW_COLORS.line}`, background: '#ffffff04' }}>
              <td style={{ padding: '8px', textAlign: 'left', fontWeight: 900, letterSpacing: '0.08em' }}>FACTORY</td>
              <td style={{ padding: '8px', textAlign: 'right', color: SW_COLORS.brand, fontWeight: 900 }}>
                {Math.round(factoryAgg.producedPieces.mean * periodMultiplier).toLocaleString()}
              </td>
              <td style={{ padding: '8px', textAlign: 'right', color: SW_COLORS.ok, fontWeight: 900 }}>
                {Math.round(factoryAgg.throughputPerHr.mean).toLocaleString()}
              </td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{factoryAgg.efficiencyPct.mean.toFixed(1)}%</td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{factoryAgg.meanLeadTime.mean > 0 ? `${factoryAgg.meanLeadTime.mean.toFixed(1)} min` : '—'}</td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{Math.round(factoryAgg.wipBundles.mean).toLocaleString()}</td>
              <td style={{ padding: '8px', textAlign: 'right', color: SW_COLORS.thread, fontWeight: 900 }}>
                {Math.round(factoryAgg.utilization.mean * 100)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}
