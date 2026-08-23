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

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

export function InsightsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { state, lines, allLines, twin, emptyReason, unassignedStationCount } = useLineSim();
  const createScenarioFromTwin = useTwin((s) => s.createScenarioFromTwin);
  const [tab, setTab] = useState<InsightTab>('diagnosis');

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
      // Reassigning operations across stations is a topology change, and the
      // Yamazumi chart already owns drag-to-reassign — sending the user there
      // beats a second, worse implementation of it here.
      navigate('/balance?tab=balance');
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
      <SectionHeader
        kicker="Insights"
        title="What to fix on this line"
        sub={
          `Read from the run, ranked by what an hour of your attention buys. `
          + `${state.stations.length} stations · ${state.producedPieces.toLocaleString()} pcs produced.`
        }
        right={<LineScopePicker lines={allLines} />}
      />

      <div style={{ marginTop: 12, marginBottom: 16 }}>
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

      {tab === 'stations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
