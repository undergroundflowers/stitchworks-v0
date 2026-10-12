import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { Card, Button, SectionHeader, ToggleGroup, HideableBox, HudSelect, LineBalancePanel, LineScopePicker, LineSimEmpty, Tag } from '../components';
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
import { lineSystemBadge } from '../domain/twin';

const SHIFT_MIN = 480;
/** Base RNG seed for the page-level replications. Replication i uses
 *  `REPORT_BASE_SEED + i`. Kept as a constant so the seed strip in the
 *  page chrome can display the exact range without re-running the engine. */
const REPORT_BASE_SEED = 42;

/**
 * All-zero aggregate. Structurally required so `kpiSource` has a type, never
 * rendered: every consumer sits behind `factoryScope`, which is exactly the
 * test for `factoryAgg !== null`.
 */
const EMPTY_AGGREGATE: AggregateKpis = (() => {
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
})();

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

/**
 * Production KPIs page. Every tab reads the active twin — the factory the
 * user built and the engine runs. There is no garment picker and no operator
 * slider here any more: both existed to configure a *synthetic* line, and the
 * page reported that line's numbers next to the real one's.
 *
 *   Performance   per-line and factory KPIs from `runReplications`
 *   Line Balance  one `LineBalancePanel` per in-scope sewing line
 *   Scenarios     saved runs to compare against
 *
 * `embedded` mode drops the outer scroll wrapper and the "Back to twin"
 * footer button so the same content can be mounted inside another page
 * (e.g. underneath the LiveSim view).
 */
export function ReportsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const project = useProject();
  const garments = useGarments();
  const location = useLocation();
  const [period, setPeriod] = useState<'SHIFT' | 'DAY' | 'WEEK' | 'MONTH'>('SHIFT');
  // In-page tab nav. Line balance is a part of performance, Scenarios is the
  // saved-run comparison surface — both live under the same Reports umbrella
  // rather than as their own routes.
  //
  // Addressed by `?report=`, not `?tab=`. This page is almost always mounted
  // INSIDE Insights, whose own tab strip already owns `?tab=` — so a deep
  // link that wanted the balance tab had to spend the same parameter twice
  // and lost. `?tab=` is still honoured for the standalone case; `?report=`
  // wins when both are present.
  const [tab, setTab] = useState<ReportTab>(() => readReportTab(location.search) ?? 'performance');
  // Honour changes on subsequent navigations (e.g. clicking through from the
  // Insights diagnosis list after the page is already mounted).
  useEffect(() => {
    const next = readReportTab(location.search);
    if (next) setTab(next);
  }, [location.search]);

  // Save-scenario modal state. We avoid `window.prompt()` because it's
  // suppressed inside many embedded preview / iframe contexts, which silently
  // killed the save flow before this — the button looked like it did nothing.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNotes, setSaveNotes] = useState('');

  // The active twin. Everything on this page reads it; nothing on this page
  // configures a line of its own any more.
  const reportsTwin = useTwin(selectActiveTwin);

  /**
   * The garment the reports fall back to for a workstation that has not
   * pinned one — voted for by the twin's own lines and stations.
   *
   * This used to be a picker: five built-in bulletins in a ToggleGroup, seeded
   * from whichever line happened to declare a garment first. Picking one
   * re-pointed the whole balance surface at a bulletin the factory might not
   * run, which is the defect this page existed to demonstrate.
   */
  const defaultGarmentId = useMemo(() => {
    const votes = new Map<string, number>();
    for (const l of reportsTwin.lines ?? []) {
      if (l.garmentId && garments.byId[l.garmentId]) {
        votes.set(l.garmentId, (votes.get(l.garmentId) ?? 0) + 1);
      }
    }
    for (const w of reportsTwin.workstations) {
      const gid = w.operation.garmentId;
      if (gid && garments.byId[gid]) votes.set(gid, (votes.get(gid) ?? 0) + 1);
    }
    let bestId = garments.all[0]?.id ?? '';
    let bestN = 0;
    for (const [gid, n] of votes) {
      if (n > bestN) {
        bestN = n;
        bestId = gid;
      }
    }
    return bestId;
  }, [reportsTwin, garments.byId, garments.all]);

  // ── Real run-driven KPIs from the sim engine ────────────────────────────
  // Per-op efficiency derived from the project's skill matrix.
  //
  // Built over EVERY garment's operations, not just one. The map is keyed by
  // op id, so building it from a single bulletin silently dropped the skill
  // ratings of every line running a different garment — on a two-product
  // factory the second line ran at nominal speed while the header claimed the
  // matrix was in force.
  const opEfficiency = useMemo(
    () => efficiencyFromSkillMatrix(project.skillMatrix, garments.all.flatMap((g) => g.operations)),
    [project.skillMatrix, garments.all],
  );
  const skillEntries = Object.keys(opEfficiency).length;
  // Default to 5 replications so the stochastic engine's variance is
  // visible on first render. A single-run report hides the ±std the
  // demo narrative depends on; 5 is a cheap-enough run count that the
  // page still paints under a second.
  const [runs, setRuns] = useState<number>(5);
  // Bumped by the Re-run button. Part of the replication memo key, which is
  // the only thing that decides when the engine runs on this page.
  const [rerunNonce, setRerunNonce] = useState(0);

  // ── Per-line replication ─────────────────────────────────────────────────
  // When the active twin has more than one wired sewing line, the
  // single-garment KPIs above can't honestly speak for the factory (Line 1
  // is knit, Line 2 is woven, etc.). Run a separate replication on each
  // wired line's config so the Performance tab can show a per-line table
  // alongside the factory-weighted aggregate.
  const reportScope = useSimScope((s) => s.scope);
  const lineBuildsForReports: LineBuild[] = useMemo(() => {
    if ((reportsTwin.lines ?? []).length === 0) return [];
    return buildLinesFromTwin({
      twin: reportsTwin,
      garmentsById: garments.byId,
      defaultGarmentId,
      opEfficiency,
      modelTimeUnit: project.time.modelTimeUnit,
    });
  }, [reportsTwin, garments.byId, defaultGarmentId, opEfficiency, project.time.modelTimeUnit]);
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
            // Both of these were computed on this page and then dropped on the
            // floor. Without `opEfficiency` the header advertised "N operations
            // respect skill matrix" over a run that used nominal SMVs; without
            // `garmentsById` the engine resolved every station's c, K,
            // discipline and service distribution against the frozen built-in
            // catalog, so an edited or imported bulletin was invisible to the
            // Reports numbers while LiveSim — which does pass it — showed
            // something else.
            opEfficiency,
            garmentsById: garments.byId,
          }),
        };
      });
  }, [lineBuildsForReports, reportsTwin, runs, reportScope, opEfficiency, garments.byId, rerunNonce]);

  /**
   * The lines the Line Balance tab draws, honouring the shared scope picker.
   *
   * Balance is a per-line reading — two lines running different garments have
   * two unrelated bottlenecks — so factory scope means "one panel each", not
   * "one blended chart". The old tab had a single card and resolved which
   * line it was about by picking the first one that declared a garment,
   * silently, on mount.
   */
  const balanceLineIds = useMemo(
    () =>
      (reportsTwin.lines ?? [])
        .filter((l) => (reportScope.kind === 'line' ? l.id === reportScope.id : true))
        .map((l) => l.id),
    [reportsTwin.lines, reportScope],
  );

  // ── Factory-level aggregate across wired lines ──────────────────────────
  // When the twin has ≥1 wired line, the top KPI tiles (and the FACTORY
  // summary row in the per-line table) describe the whole factory, computed
  // with proper IE weighting (operator-minutes for efficiency, operators for
  // utilisation, pieces for lead time). Without this, the tiles would either
  // (a) show a synthetic garment-template line that disagreed with the per-
  // line table below, or (b) report a simple arithmetic mean of percentages,
  // which silently misrepresents lines of different sizes.
  const factoryAgg = useMemo<AggregateKpis | null>(() => {
    if (perLineAggs.length === 0) return null;
    return aggregateFactoryKpis(perLineAggs, SHIFT_MIN);
  }, [perLineAggs]);

  /**
   * Top KPI tiles, and the numbers a saved scenario captures.
   *
   * `factoryAgg` is null exactly when no line is wired, and every consumer
   * below sits behind `factoryScope`, which is that same test — so the tiles
   * are never rendered from this fallback. It used to fall back to a
   * replication of a line SYNTHESISED from the garment picker: five
   * stochastic shifts, re-run on every garment or operator change, whose
   * result no pixel on the page ever displayed. Deleting it removed the last
   * thing on this page that simulated a factory the user had not built.
   */
  const kpiSource: AggregateKpis = factoryAgg ?? EMPTY_AGGREGATE;
  const efficiency = kpiSource.efficiencyPct.mean;
  const throughputPerHr = kpiSource.throughputPerHr.mean;
  const producedPieces = kpiSource.producedPieces.mean;
  const meanLeadTime = kpiSource.meanLeadTime.mean;
  const utilization = kpiSource.utilization.mean;
  const wipBundles = kpiSource.wipBundles.mean;

  // Period scaling for cumulative KPIs. Throughput is a rate and percentages
  // (efficiency, utilization) are intensive — they don't scale. Only OUTPUT
  // and other tally-style numbers multiply by working-day count. Sri Lankan
  // apparel convention: 1 shift/day, 6 working days/week, ~26 working days/month.
  const periodMultiplier = period === 'WEEK' ? 6 : period === 'MONTH' ? 26 : 1;
  const periodLabel = period === 'SHIFT' ? 'SHIFT' : period === 'DAY' ? 'DAY' : period === 'WEEK' ? 'WEEK' : 'MONTH';
  const scaledProducedMean = producedPieces * periodMultiplier;
  const scaledProducedStd = (runs > 1 ? kpiSource.producedPieces.std : 0) * periodMultiplier;
  // True when there is a wired factory to report on at all. Everything on the
  // Performance tab sits behind it; without it the tab shows an empty state.
  const factoryScope = factoryAgg !== null;
  const factoryLineCount = perLineAggs.length;

  return (
    <div style={embedded
      ? { width:'100%', background: SW_COLORS.paperDeep, padding: 24 }
      : { width:'100%', height:'100%', overflow:'auto', background: SW_COLORS.paperDeep, padding: 24 }}>
      <SectionHeader
        kicker="Reports"
        title={tab === 'balance' ? 'Line balance' : tab === 'scenarios' ? 'Saved scenarios' : 'Production performance'}
        sub={
          tab === 'balance'
            ? `Read from the twin · ${(reportsTwin.lines ?? []).length} sewing ${(reportsTwin.lines ?? []).length === 1 ? 'line' : 'lines'} · ${skillEntries > 0 ? `${skillEntries} operations carry a skill rating` : 'no skill overrides'}`
            : `${runs > 1 ? `${runs}-replication mean` : 'Single seed'} · ${SHIFT_MIN}-min shift${periodMultiplier > 1 ? ` × ${periodMultiplier} (${periodLabel.toLowerCase()})` : ''} · ${factoryScope ? `Factory of ${factoryLineCount} wired ${factoryLineCount === 1 ? 'line' : 'lines'}` : 'No wired line'} · ${skillEntries > 0 ? `${skillEntries} operations respect skill matrix` : 'baseline (no skill overrides)'} · seed ${REPORT_BASE_SEED}${runs > 1 ? `..${REPORT_BASE_SEED + runs - 1}` : ''}`
        }
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
            {/* The per-line replications are keyed on (twin, runs, scope,
                skill matrix, garments), so re-running is a matter of busting
                that key rather than calling the engine here. The button used
                to re-run a synthetic single-garment twin whose result nothing
                on the page displayed. */}
            <Button
              variant="secondary"
              size="sm"
              icon="↻"
              onClick={() => setRerunNonce((n) => n + 1)}
            >
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
                  : 'No wired line';
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
            Lines
          </span>
          {(reportsTwin.lines ?? []).map((l) => (
            <span
              key={l.id}
              title={`${l.name} — ${lineSystemBadge(l, reportsTwin)}`}
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
          Reports is the umbrella. Performance gives the headline KPIs,
          Line Balance the per-line Yamazumi read off the twin, Scenarios the
          saved runs to compare them against. */}
      <ReportTabBar value={tab} onChange={setTab} />


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

      {/* ── LINE BALANCE ──────────────────────────────────────────────────
          One panel per sewing line IN SCOPE, read straight off the twin.

          What stood here: a single card driven by a five-option garment
          ToggleGroup and an OPERATORS number field, packing the chosen
          bulletin onto that many synthetic operators with the RPW heuristic.
          It had a "LOAD LINE" row that copied a real line's garment and
          headcount into those two controls — an admission that the surface
          was meant to describe a line, without ever reading one. The stations
          on the chart, the SMVs behind them and the operator count under them
          were all invented here, so nothing the user built in BUILD and
          nothing the engine ran on RUN could move a single bar. */}
      {tab === 'balance' && (
        balanceLineIds.length === 0 ? (
          <LineSimEmpty
            reason={reportsTwin.workstations.length === 0 ? 'no-stations' : 'stations-not-in-a-line'}
            unassignedStationCount={reportsTwin.workstations.filter((ws) => !ws.lineId).length}
            what="Line balance"
          />
        ) : (
          <>
            {balanceLineIds.map((id) => (
              <LineBalancePanel key={id} lineId={id} />
            ))}
          </>
        )
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
        // `factoryScope` is already true here — this whole block is gated on
        // it — so the old `: (…)` fallbacks over the garment template were
        // dead branches describing a line the page no longer synthesises.
        const targetThroughputPerHr = perLineAggs.reduce((sum, r) => {
              const garmentOps = r.agg.firstStations.length > 0
                ? r.agg.firstStations
                : [];
              const maxSmv = garmentOps.reduce(
                (m, s) => Math.max(m, s.smv * (s.serversTotal || 1) > 0 ? s.smv / (s.serversTotal || 1) : s.smv),
                0,
              );
              return sum + (maxSmv > 0 ? 60 / maxSmv : 0);
            }, 0);

        // Approximate warm-up: time for the first bundle to traverse the
        // line, ≈ Σ SMV × bundleSize. We pick the *longest* line in
        // factory scope so the shaded region covers everyone. Empty in
        // edge cases — the chart degrades gracefully.
        const warmupMin = Math.max(
          0,
          ...perLineAggs.map((r) => {
            const totalSmv = r.agg.firstStations.reduce((s, st) => s + st.smv, 0);
            return totalSmv * r.bundleSize;
          }),
        );

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
                            : `Open the Line Balance tab: several stations are near the pace, so the fix is levelling the whole chart, not adding capacity at one bar.`
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

      {/* "BY SYSTEM" lived here — one efficiency bar per production system,
          bucketing the wired lines by PBS / Modular / UPS / Synchro /
          Straight. The card existed only to compare production systems, and
          with systems out of scope there is nothing left for it to bucket on:
          every line would fall into one unlabelled group. The per-line
          efficiency it rolled up is still on the per-line table above, which
          is where it was read from in the first place. */}

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
            template: factoryScope
              ? `Factory · ${factoryLineCount} wired ${factoryLineCount === 1 ? 'line' : 'lines'}`
              : 'No wired line',
            operators: perLineAggs.reduce((sum, l) => sum + l.operators, 0),
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
              garmentTemplateId: defaultGarmentId,
              operators: perLineAggs.reduce((sum, l) => sum + l.operators, 0),
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

type ReportTab = 'performance' | 'balance' | 'scenarios';

const REPORT_TABS: ReportTab[] = ['performance', 'balance', 'scenarios'];

/** Resolve the Reports sub-tab from a query string. `?report=` wins over
 *  `?tab=` because Insights, which hosts this page, owns `?tab=` itself. */
function readReportTab(search: string): ReportTab | null {
  const qs = new URLSearchParams(search);
  for (const key of ['report', 'tab']) {
    const v = qs.get(key);
    if (v && (REPORT_TABS as string[]).includes(v)) return v as ReportTab;
  }
  return null;
}

interface ReportTabBarProps {
  value: ReportTab;
  onChange: (next: ReportTab) => void;
}

/** Underline-style segmented tabs sitting under the Reports SectionHeader. */
function ReportTabBar({ value, onChange }: ReportTabBarProps) {
  const tabs: { id: ReportTab; label: string; hint: string; badge?: string }[] = [
    { id: 'performance', label: 'Performance', hint: 'KPIs · output · efficiency' },
    { id: 'balance',     label: 'Line Balance', hint: 'Per line · pitch · bottleneck' },
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
                background: SW_COLORS.paperDeep,
                colorScheme: 'dark',
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
                background: SW_COLORS.paperDeep,
                colorScheme: 'dark',
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
