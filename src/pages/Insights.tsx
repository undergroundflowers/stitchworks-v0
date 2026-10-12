/**
 * INSIGHTS — what's wrong with this line, and one click to fix it.
 *
 * The rest of the app describes the line: the Sim screen shows it running, the
 * queueing tables quantify it. This surface is the only one that takes a
 * position on what the user should DO, which is the question they actually
 * arrived with.
 *
 * Applying a fix forks the twin into a scenario rather than editing in place.
 * That matters more than it sounds: it means every recommendation is safe to
 * try, the before/after comparison is a real one, and "undo" is just
 * re-selecting the parent.
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  LineScopePicker,
  LineSimEmpty,
  SectionHeader,
  Tag,
  ToggleGroup,
  useToast,
} from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { useLineSim } from '../simulation/useLineSim';
import { useTwin } from '../store/twin';
import {
  applyPatch,
  describePatch,
  diagnoseQueues,
  type FindingSeverity,
  type QueueFinding,
} from '../domain/queue-advisor';
import { UtilizationBarChart, QueueParetoChart } from '../components/charts';
import { QueueIndexPage } from './QueueIndex';
import { QueueAnalyticsPage } from './QueueAnalytics';
import { ReportsPage } from './Reports';

const SEVERITY_STYLE: Record<FindingSeverity, { color: string; label: string }> = {
  critical: { color: SW_COLORS.alarm, label: 'CRITICAL' },
  warn: { color: SW_COLORS.warn, label: 'FIX THIS' },
  opportunity: { color: SW_COLORS.fabric, label: 'OPPORTUNITY' },
  info: { color: SW_COLORS.muted, label: 'NOTE' },
};

/**
 * INSIGHTS is the single analysis surface, so the pages that used to be their
 * own top-level tabs are mounted here as panels. They already read the shared
 * session and the shared scope, so nothing about them changes — they simply
 * stop being separate destinations the user has to know about.
 */
type InsightTab = 'diagnosis' | 'stations' | 'queues' | 'timeline' | 'reports';

const INSIGHT_TABS: InsightTab[] = ['diagnosis', 'stations', 'queues', 'timeline', 'reports'];

/** Default tab, and the one that carries no `?tab=` so the plain URL stays clean. */
const DEFAULT_TAB: InsightTab = 'diagnosis';

export function InsightsPage() {
  const toast = useToast();
  const { state, lines, allLines, twin, emptyReason, unassignedStationCount } = useLineSim();
  const createScenarioFromTwin = useTwin((s) => s.createScenarioFromTwin);
  /**
   * The open tab lives in the URL, not in component state.
   *
   * Two of these tabs drill into `/workstation/:…`, and coming back from there
   * used to remount this page at Diagnosis — the user landed two tabs away
   * from the table they had clicked out of, with no sign of where they had
   * been. An addressable tab makes "back" mean something, and makes the view
   * linkable besides. `replace` so flipping tabs doesn't stack history entries
   * the browser back button then has to chew through.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as InsightTab | null;
  const tab: InsightTab = requested && INSIGHT_TABS.includes(requested) ? requested : DEFAULT_TAB;
  const setTab = (v: InsightTab) => {
    const next = new URLSearchParams(searchParams);
    if (v === DEFAULT_TAB) next.delete('tab');
    else next.set('tab', v);
    setSearchParams(next, { replace: true });
  };

  const findings = useMemo(
    () =>
      diagnoseQueues({
        stations: state.stations,
        line: lines.length === 1 ? lines[0] : null,
        shiftMin: 480,
        produced: state.producedPieces,
      }),
    [state.stations, state.producedPieces, lines],
  );

  const apply = (finding: QueueFinding) => {
    if (!finding.patch) return;
    if (finding.patch.kind === 'rebalance') {
      // Rebalancing is a change to the twin's own stations, and the Line
      // Balance tab is where that is done — with the bottleneck named, the
      // pitch line drawn, and a channel control on each station.
      //
      // This used to navigate to `/balance?tab=balance`. `/balance` is a
      // redirect to `/insights` and `<Navigate>` drops the query string, so
      // the button landed the user back on this very tab with nothing
      // changed. Insights owns `?tab=`; the Reports sub-tab is `?report=`.
      setSearchParams({ tab: 'reports', report: 'balance' }, { replace: true });
      return;
    }
    const label = describePatch(finding.patch, state.stations);
    const next = applyPatch(twin, finding.patch);
    createScenarioFromTwin({
      name: label,
      notes: `Applied from Insights: ${finding.title}`,
      twin: next,
      activate: true,
    });
    toast({
      kind: 'success',
      message: `${label} — applied as a new scenario. Every surface now reads it; switch back on the Reports → Scenarios tab.`,
      duration: 7000,
    });
  };

  if (emptyReason) {
    return (
      <div style={{ padding: 24, height: '100%' }}>
        <LineSimEmpty
          reason={emptyReason}
          unassignedStationCount={unassignedStationCount}
          what="Line diagnosis"
        />
      </div>
    );
  }

  const worst = findings[0];

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', background: SW_COLORS.paperDeep, padding: 24 }}>
      {/* A toolbar, not a page header. The kicker / title / sub that used to
          sit here ("Insights — What to fix on this line") named the surface
          the nav had already named and spent three lines doing it, so the
          controls now start at the top of the page: the tabs at the left
          edge, aligned with the cards they switch, and the scope picker at
          the far right. Wraps at narrow widths instead of crushing either. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 16,
        }}
      >
        <ToggleGroup
          value={tab}
          onChange={(v) => setTab(v as InsightTab)}
          options={[
            { value: 'diagnosis', label: `⚑ Diagnosis · ${findings.length}` },
            { value: 'stations', label: '▤ Where the load sits' },
            { value: 'queues', label: 'Σ Per-station queues' },
            { value: 'timeline', label: '∿ Over time' },
            { value: 'reports', label: '⌬ Reports' },
          ]}
        />
        <LineScopePicker lines={allLines} />
      </div>

      {tab === 'diagnosis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {worst && <Headline finding={worst} />}
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} onApply={() => apply(f)} stations={state.stations} />
          ))}
        </div>
      )}

      {tab === 'queues' && <QueueIndexPage embedded />}
      {tab === 'timeline' && <QueueAnalyticsPage embedded />}
      {tab === 'reports' && <ReportsPage embedded />}

      {/* Side by side, not stacked. Both charts draw through a 600-unit
          viewBox at `width: 100%`, so a full-width card blew them up ~2.5×:
          giant bars, giant labels, and each panel taller than the viewport.
          At half width they land near their intended scale, and the two
          readings of the same run — who is saturated, where WIP piles up —
          can be compared without scrolling between them. `alignItems:
          start` so the shorter chart doesn't stretch to match the taller. */}
      {tab === 'stations' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            alignItems: 'start',
            gap: 16,
          }}
        >
          <Card>
            <SectionHeader
              title="Operator saturation by station"
              sub="ρ̂ measured from the run. The bar furthest right is the constraint — it sets what the line can deliver."
            />
            <UtilizationBarChart stations={state.stations.map((s) => ({ ...s, lineName: '' }))} />
          </Card>
          <Card>
            <SectionHeader
              title="Where WIP collects"
              sub="Average bundles waiting per station, worst first, with the cumulative share. A short head means a few stations hold most of your work-in-progress."
            />
            <QueueParetoChart stations={state.stations.map((s) => ({ ...s, lineName: '' }))} />
          </Card>
        </div>
      )}
    </div>
  );
}

/** The one-line verdict, so the user doesn't have to read a list to get it. */
function Headline({ finding }: { finding: QueueFinding }) {
  const sev = SEVERITY_STYLE[finding.severity];
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: SW_RADIUS.md,
        border: `1px solid ${alpha(sev.color, 0.5)}`,
        background: alpha(sev.color, 0.1),
        borderLeft: `4px solid ${sev.color}`,
      }}
    >
      <div style={{ ...SW_TYPE.overline, color: sev.color }}>BIGGEST WIN RIGHT NOW</div>
      <div style={{ ...SW_TYPE.subhead, color: SW_COLORS.ink, marginTop: 2 }}>{finding.title}</div>
      <div style={{ ...SW_TYPE.body, color: SW_COLORS.muted, marginTop: 4 }}>{finding.action}</div>
    </div>
  );
}

function FindingCard({
  finding,
  onApply,
  stations,
}: {
  finding: QueueFinding;
  onApply: () => void;
  stations: Parameters<typeof describePatch>[1];
}) {
  const sev = SEVERITY_STYLE[finding.severity];
  return (
    <Card accent={sev.color}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <Tag color={sev.color}>{sev.label}</Tag>
            <span style={{ ...SW_TYPE.heading, color: SW_COLORS.ink }}>{finding.title}</span>
          </div>
          <p style={{ ...SW_TYPE.body, color: SW_COLORS.muted, margin: '0 0 8px' }}>
            {finding.detail}
          </p>
          <div
            style={{
              ...SW_TYPE.body,
              color: SW_COLORS.ink,
              fontWeight: 600,
              display: 'flex',
              gap: 6,
              alignItems: 'baseline',
            }}
          >
            <span style={{ color: sev.color, fontFamily: SW_FONTS.mono }}>→</span>
            <span>{finding.action}</span>
          </div>
          {finding.expect && (
            <div style={{ ...SW_TYPE.caption, color: SW_COLORS.faint, marginTop: 4 }}>
              Expect: {finding.expect}
            </div>
          )}
        </div>
        {finding.patch && (
          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            <Button variant="primary" size="sm" onClick={onApply}>
              {finding.patch.kind === 'rebalance' ? 'Open balancer' : 'Apply'}
            </Button>
            <div style={{ ...SW_TYPE.overline, color: SW_COLORS.faint, marginTop: 4, maxWidth: 160 }}>
              {describePatch(finding.patch, stations)}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
