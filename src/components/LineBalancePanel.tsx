/**
 * LINE BALANCE — one sewing line, as built and as simulated.
 *
 * Every number on this panel is derived from the twin by `buildLineBalance`,
 * which resolves each station through the same functions the PML engine uses.
 * Nothing here is seeded from a picker, a template, or a typed-in headcount.
 *
 * What it replaced: a Yamazumi over one of the five built-in garment
 * bulletins, packed onto an operator count the user typed by hand. That
 * surface never read the twin, so it reported a balance for a line that did
 * not exist, sitting one tab away from a Performance view that DID read the
 * twin. It also printed the same quantity under four different names —
 * TAKT was Σ SAM ÷ operators (which is pitch, not takt), and LINE EFF, LINE
 * BALANCE RATIO, LINE BALANCE EFFICIENCY and 100 − BALANCE LOSS were
 * algebraically identical once takt had been defined as the bottleneck.
 *
 * The tiles here are chosen so that no two of them can be derived from each
 * other, and every one carries the substituted arithmetic behind its ⓘ.
 */

import { useMemo, useState } from 'react';
import { Card } from './Card';
import { Stat } from './Stat';
import { NumberInput } from './NumberInput';
import { Tag } from './Tag';
import { Yamazumi } from './Yamazumi';
import { SW_BORDER, SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import {
  bestAchievableBottleneckMin,
  buildLineBalance,
  readTakt,
  suggestBalanceActions,
  type BalanceSuggestion,
  type SuggestionSeverity,
} from '../domain';
import { efficiencyFromSkillMatrix } from '../simulation';
import { getBlockKind } from '../domain/pml';
import { useProject } from '../store/project';
import { useGarments } from '../store/garments';
import { useTwin, selectActiveTwin } from '../store/twin';

const min3 = (v: number) => v.toFixed(3);

export interface LineBalancePanelProps {
  lineId: string;
}

export function LineBalancePanel({ lineId }: LineBalancePanelProps) {
  const twin = useTwin(selectActiveTwin);
  const setBlock = useTwin((s) => s.setBlock);
  const garments = useGarments();
  const skillMatrix = useProject((s) => s.skillMatrix);
  const shiftMin = useProject((s) => s.time.shiftDurationMin);

  /**
   * The demand target, in pieces per shift.
   *
   * Deliberately NOT persisted and deliberately empty by default. Takt only
   * exists once someone says what the line has to ship; the previous surface
   * manufactured one by calling the bottleneck "takt", which made its
   * takt-based tiles restatements of its bottleneck-based ones and its
   * "infeasible at takt" warning unreachable. An empty box that says so is
   * more use than a number nobody chose.
   */
  const [targetPieces, setTargetPieces] = useState<number | undefined>(undefined);
  const [focusWsId, setFocusWsId] = useState<string | null>(null);

  const opEfficiency = useMemo(() => {
    const line = (twin.lines ?? []).find((l) => l.id === lineId);
    const gid =
      line?.garmentId
      ?? twin.workstations.find((w) => w.lineId === lineId && w.operation.garmentId)?.operation
        .garmentId;
    const ops = (gid ? garments.byId[gid] : undefined)?.operations ?? [];
    return efficiencyFromSkillMatrix(skillMatrix, ops);
  }, [twin, lineId, garments.byId, skillMatrix]);

  const bal = useMemo(
    () => buildLineBalance({ twin, lineId, garmentsById: garments.byId, opEfficiency }),
    [twin, lineId, garments.byId, opEfficiency],
  );

  const takt = readTakt(bal, { targetPieces: targetPieces ?? 0, shiftMin });
  const best = bestAchievableBottleneckMin(bal);
  const suggestions = suggestBalanceActions({ balance: bal, takt });

  /**
   * Write the parallel-channel count onto the station itself.
   *
   * `block.params.servers` is the first thing `serversFor` reads, so this is
   * the one staffing knob that both the chart and the engine honour. The
   * station's `resources.workersRequired` is NOT that knob — the Builder
   * labels it with Kendall's c but no engine path reads it, which is why the
   * advisor calls out any station where the two disagree.
   */
  const setServers = (wsId: string, next: number) => {
    const ws = twin.workstations.find((w) => w.id === wsId);
    if (!ws) return;
    setBlock(wsId, {
      ...(ws.block ?? {}),
      kind: getBlockKind(ws),
      params: { ...(ws.block?.params ?? {}), servers: Math.max(1, Math.round(next)) },
    });
  };

  const headroom = best != null ? bal.bottleneckMin - best : null;
  const skillTouched = Object.keys(opEfficiency).length;

  return (
    <Card padding={20} style={{ marginBottom: 14 }}>
      {/* ── Header: what this panel is about, stated as fact ─────────────── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ ...SW_TYPE.subhead, color: SW_COLORS.ink }}>
            {bal.lineName}
          </div>
          <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted, marginTop: 2 }}>
            {bal.garment
              ? `${bal.garment.name} · ${bal.stations.length} station${bal.stations.length === 1 ? '' : 's'} · ${bal.servers} channel${bal.servers === 1 ? '' : 's'}`
              : 'No garment bound to this line yet'}
            {skillTouched > 0
              ? ` · ${skillTouched} operation${skillTouched === 1 ? '' : 's'} carry a skill rating`
              : ' · no skill overrides'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {bal.excluded.filter((e) => e.reason !== 'infrastructure').length > 0 && (
            <Tag color={SW_COLORS.warn}>
              {bal.excluded.filter((e) => e.reason !== 'infrastructure').length} not in balance
            </Tag>
          )}
          {bal.stations.some((s) => s.shareFrac < 1) && (
            <Tag color={SW_COLORS.alarm}>
              {bal.stations.filter((s) => s.shareFrac < 1).length} shared operator
            </Tag>
          )}
        </div>
      </div>

      {/* A line with nothing balanceable on it gets the header, the reason
          list, and nothing else. Rendering the tiles here would divide by a
          zero bottleneck and print confident nonsense — which is the class of
          bug this whole panel exists to stop. */}
      {bal.stations.length === 0 ? (
        <SuggestionList suggestions={suggestions} focusWsId={null} onFocus={() => {}} />
      ) : (
      <>
      <Yamazumi
        stations={bal.stations}
        pitchMin={bal.pitchMin}
        taktMin={takt?.taktMin ?? null}
        height={280}
        highlightWsId={focusWsId}
        onServersChange={setServers}
      />

      {/* ── Tier 1: the readings that cannot be derived from one another ─── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 8,
          marginTop: 14,
        }}
      >
        <Stat
          label="WORK CONTENT"
          value={min3(bal.workContentMin)}
          unit="min/pc"
          info={
            <>
              What one piece costs the crew, summed over the stations this line
              actually places.
              <br />
              <br />
              Σ (SMV ÷ skill ÷ operator share) over {bal.stations.length} stations
              = <b>{min3(bal.workContentMin)}</b> min.
              <br />
              <br />
              The bulletin's own ΣSMV is {min3(bal.bulletinSamMin)} min. A gap
              means the line does not place every operation, or that skill and
              operator sharing are bending what the work costs here.
            </>
          }
        />
        <Stat
          label="PITCH"
          value={min3(bal.pitchMin)}
          unit="min/pc"
          color={SW_COLORS.brand}
          info={
            <>
              The height every bar would have if the work were perfectly spread
              — the target line on the chart.
              <br />
              <br />
              {min3(bal.workContentMin)} ÷ {bal.servers} channels ={' '}
              <b>{min3(bal.pitchMin)}</b> min.
              <br />
              <br />
              This is <b>not</b> takt. Takt comes from demand and is shown below
              only once you state a target. The old surface printed this number
              under the label TAKT.
            </>
          }
        />
        <Stat
          label="BOTTLENECK"
          value={min3(bal.bottleneckMin)}
          unit="min/pc"
          color={SW_COLORS.alarm}
          title={bal.bottleneck?.name}
          info={
            <>
              The slowest station — it sets the pace nothing downstream can beat.
              <br />
              <br />
              {bal.bottleneck
                ? (
                  <>
                    <b>{bal.bottleneck.name}</b> · {bal.bottleneck.op.name}
                    <br />
                    {min3(bal.bottleneck.nominalMin)} min SMV
                    {bal.bottleneck.skillEff !== 1 && ` ÷ ${bal.bottleneck.skillEff.toFixed(2)} skill`}
                    {bal.bottleneck.shareFrac < 1 && ` ÷ ${bal.bottleneck.shareFrac.toFixed(2)} share`}
                    {bal.bottleneck.servers > 1 && ` ÷ ${bal.bottleneck.servers} channels`}
                    {' = '}
                    <b>{min3(bal.bottleneckMin)}</b> min.
                  </>
                )
                : 'No station carries an operation.'}
            </>
          }
        />
        <Stat
          label="LINE CAPACITY"
          value={bal.capacityPerHr.toFixed(0)}
          unit="pcs/hr"
          color={SW_COLORS.thread}
          info={
            <>
              What this layout can deliver in steady state, before losses.
              <br />
              <br />
              60 ÷ {min3(bal.bottleneckMin)} = <b>{bal.capacityPerHr.toFixed(1)}</b> pcs/hr.
              <br />
              Over a {shiftMin}-min shift that is{' '}
              {Math.floor((shiftMin / Math.max(1e-9, bal.bottleneckMin)))} pcs.
              <br />
              <br />
              The Performance tab's simulated mean sits below this: the engine
              pays for variability, blocking and warm-up, which this ceiling
              ignores.
            </>
          }
        />
        <Stat
          label="BALANCE LOSS"
          value={bal.balanceLossPct.toFixed(1)}
          unit="%"
          color={bal.balanceLossPct > 25 ? SW_COLORS.alarm : SW_COLORS.ok}
          info={
            <>
              The share of paid channel-minutes spent waiting because the bars
              are uneven.
              <br />
              <br />
              1 − ({min3(bal.workContentMin)} ÷ ({bal.servers} × {min3(bal.bottleneckMin)}))
              = <b>{bal.balanceLossPct.toFixed(1)} %</b>.
              <br />
              <br />
              Line balance ratio is its exact complement,{' '}
              {bal.lbrPct.toFixed(1)} % — the same fact stated the other way up,
              which is why only one of the two is shown. Above 25 % is the
              textbook "poor balance" threshold.
            </>
          }
        />
        <Stat
          label="SMOOTHNESS"
          value={bal.smoothness.toFixed(3)}
          unit="SI"
          color={bal.smoothness > 0.2 ? SW_COLORS.warn : SW_COLORS.ok}
          info={
            <>
              How spread out the bars are, independent of how much total slack
              there is.
              <br />
              <br />
              √(Σ (bottleneck − cycle)²) ÷ (bottleneck × channels) ={' '}
              <b>{bal.smoothness.toFixed(3)}</b>.
              <br />
              <br />
              Balance loss can look acceptable while a few stations sit far off
              the pitch line; smoothness is the number that catches that. Above
              ~0.20 the chart reads visibly bumpy.
            </>
          }
        />
      </div>

      {/* ── Tier 2: how much of the imbalance is actually recoverable ────── */}
      <div
        style={{
          marginTop: 10,
          padding: '8px 10px 6px',
          border: `1px dashed ${SW_COLORS.faint}`,
          borderRadius: SW_RADIUS.sm,
          background: SW_COLORS.paperDeep,
        }}
      >
        <div
          style={{
            ...SW_TYPE.overline,
            color: SW_COLORS.muted,
            marginBottom: 8,
          }}
        >
          How much of this is fixable
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
          <Stat
            label="CHANNELS TO HOLD PACE"
            value={String(bal.channelsToHoldPace)}
            unit={`/ ${bal.servers} now`}
            color={
              bal.servers - bal.channelsToHoldPace >= 2 ? SW_COLORS.warn : SW_COLORS.ok
            }
            info={
              <>
                The crew a perfectly flat line would need to hold{' '}
                <b>this same {bal.capacityPerHr.toFixed(0)} pcs/hr</b>.
                <br />
                <br />
                ⌈{min3(bal.workContentMin)} ÷ {min3(bal.bottleneckMin)}⌉ ={' '}
                <b>{bal.channelsToHoldPace}</b> against {bal.servers} today.
                <br />
                <br />
                The gap is what the imbalance costs. It is not spare capacity —
                pulling those operators off the line now would move the
                bottleneck up, not free anything. Rebalance first.
              </>
            }
          />
          <Stat
            label="BEST ACHIEVABLE"
            value={best != null ? min3(best) : '—'}
            unit="min/pc"
            color={
              headroom != null && headroom > 0.01 ? SW_COLORS.warn : SW_COLORS.ok
            }
            info={
              <>
                The bottleneck a perfect repack of <i>these</i> operations onto{' '}
                <i>these</i> {bal.servers} channels would reach, from the RPW
                heuristic.
                <br />
                <br />
                {best != null ? (
                  <>
                    Best <b>{min3(best)}</b> vs actual{' '}
                    <b>{min3(bal.bottleneckMin)}</b> —{' '}
                    {headroom != null && headroom > 0.001
                      ? `${min3(headroom)} min/pc of recoverable headroom, worth ${(60 / best - bal.capacityPerHr).toFixed(0)} pcs/hr.`
                      : 'this line is already as flat as its bulletin allows.'}
                  </>
                ) : (
                  'Nothing to pack.'
                )}
                <br />
                <br />
                It can never beat the pitch line: operations are indivisible, so
                some slack is intrinsic to the bulletin rather than a mistake in
                the layout.
              </>
            }
          />
          <Stat
            label="ROSTERED"
            value={String(bal.staffed)}
            unit={`vs ${bal.servers} channels`}
            color={bal.staffed === bal.servers ? SW_COLORS.ok : SW_COLORS.warn}
            info={
              <>
                Operators the twin rosters onto these stations (assignment rows,
                falling back to each station's <i>workers required</i>) against
                the parallel channels the engine runs.
                <br />
                <br />
                When they disagree, the chart follows the <b>channels</b>,
                because that is what paces the line. The Builder's "workers
                required" field is labelled with Kendall's c but no engine path
                reads it — use the ± control under each bar to move the number
                that counts.
              </>
            }
          />
        </div>
      </div>

      {/* ── Takt: only exists once the user states a target ──────────────── */}
      <TaktStrip
        shiftMin={shiftMin}
        targetPieces={targetPieces}
        onTargetChange={setTargetPieces}
        takt={takt}
        servers={bal.servers}
        capacityPerHr={bal.capacityPerHr}
      />

      {/* ── What to fix ─────────────────────────────────────────────────── */}
      <SuggestionList
        suggestions={suggestions}
        focusWsId={focusWsId}
        onFocus={setFocusWsId}
      />
      </>
      )}
    </Card>
  );
}

/**
 * The demand-driven half of the reading, gated behind an explicit target.
 *
 * Empty is a legitimate, common state — plenty of balancing happens with no
 * order in hand — so the strip says what is missing rather than inventing a
 * takt and reporting confident feasibility against it.
 */
function TaktStrip({
  shiftMin,
  targetPieces,
  onTargetChange,
  takt,
  servers,
  capacityPerHr,
}: {
  shiftMin: number;
  targetPieces: number | undefined;
  onTargetChange: (v: number | undefined) => void;
  takt: ReturnType<typeof readTakt>;
  servers: number;
  capacityPerHr: number;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 10px',
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        background: SW_COLORS.paperDeep,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: takt ? 8 : 0,
        }}
      >
        <span style={{ ...SW_TYPE.overline, color: SW_COLORS.muted }}>
          Against demand
        </span>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            ...SW_TYPE.caption,
            color: SW_COLORS.muted,
          }}
        >
          Target
          <NumberInput
            value={targetPieces}
            onChange={onTargetChange}
            allowEmpty
            min={1}
            max={1_000_000}
            placeholder="pcs"
            style={{
              width: 78,
              padding: '4px 8px',
              border: `1px solid ${SW_COLORS.line}`,
              borderRadius: SW_RADIUS.sm,
              background: SW_COLORS.paper,
              color: SW_COLORS.ink,
              fontFamily: SW_FONTS.mono,
              fontWeight: 700,
              fontSize: 13,
            }}
          />
          pcs per {shiftMin}-min shift
        </label>
        {!takt && (
          <span style={{ ...SW_TYPE.caption, color: SW_COLORS.faint }}>
            Takt, line-balance efficiency and required manning need a target.
            Without one they can only restate the bottleneck — which is what the
            old tiles did. This line currently ships{' '}
            {Math.floor((shiftMin * capacityPerHr) / 60)} pcs a shift.
          </span>
        )}
      </div>

      {takt && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <Stat
            label="TAKT"
            value={min3(takt.taktMin)}
            unit="min/pc"
            color={takt.feasible ? SW_COLORS.ok : SW_COLORS.alarm}
            info={
              <>
                The pace demand requires.
                <br />
                <br />
                {takt.shiftMin} min ÷ {takt.targetPieces} pcs ={' '}
                <b>{min3(takt.taktMin)}</b> min/pc.
              </>
            }
          />
          <Stat
            label="LINE BALANCE EFF"
            value={takt.lbePct.toFixed(1)}
            unit="%"
            color={
              takt.lbePct > 100 ? SW_COLORS.alarm : takt.lbePct >= 85 ? SW_COLORS.ok : SW_COLORS.warn
            }
            info={
              <>
                How much of the capacity you have staffed to meet demand is
                actually earning SAM.
                <br />
                <br />
                Σ work content ÷ (channels × takt) ={' '}
                <b>{takt.lbePct.toFixed(1)} %</b>.
                <br />
                <br />
                Below 100 % there is slack against demand; above 100 % the
                bulletin cannot be delivered by {servers} channels at this takt
                no matter how it is arranged.
              </>
            }
          />
          <Stat
            label="CHANNELS FOR TAKT"
            value={String(takt.requiredChannels)}
            unit={`/ ${servers} now`}
            color={takt.requiredChannels > servers ? SW_COLORS.alarm : SW_COLORS.ok}
            info={
              <>
                The crew a perfectly flat line needs to hit <i>demand</i> — a
                different question from CHANNELS TO HOLD PACE above, which asks
                what it takes to hold the pace you already have.
                <br />
                <br />
                ⌈work content ÷ {min3(takt.taktMin)}⌉ ={' '}
                <b>{takt.requiredChannels}</b>.
              </>
            }
          />
          <Stat
            label="WILL SHIP"
            value={String(takt.achievablePieces)}
            unit={`/ ${takt.targetPieces} pcs`}
            color={takt.feasible ? SW_COLORS.ok : SW_COLORS.alarm}
            info={
              <>
                What this layout delivers in the shift at its current pace,
                against what was asked for.
                <br />
                <br />
                ⌊{takt.shiftMin} ÷ bottleneck⌋ ={' '}
                <b>{takt.achievablePieces}</b> pcs.
                <br />
                <br />
                A ceiling, not a forecast — the simulated mean on the
                Performance tab pays for variability this number ignores.
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

const SEVERITY_STYLE: Record<
  SuggestionSeverity,
  { bar: string; chip: string; chipText: string; label: string }
> = {
  critical:    { bar: SW_COLORS.alarm, chip: SW_COLORS.alarm,     chipText: SW_COLORS.paper, label: 'CRITICAL' },
  warn:        { bar: SW_COLORS.warn,  chip: SW_COLORS.warn,      chipText: SW_COLORS.paper, label: 'WARN' },
  opportunity: { bar: SW_COLORS.brand, chip: SW_COLORS.brand,     chipText: SW_COLORS.paper, label: 'OPPORTUNITY' },
  info:        { bar: SW_COLORS.faint, chip: SW_COLORS.paperEdge, chipText: SW_COLORS.muted, label: 'INFO' },
};

function SuggestionList({
  suggestions,
  focusWsId,
  onFocus,
}: {
  suggestions: BalanceSuggestion[];
  focusWsId: string | null;
  onFocus: (wsId: string | null) => void;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          background: SW_COLORS.paperEdge,
          borderBottom: `1px solid ${SW_COLORS.line}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ ...SW_TYPE.overline, color: SW_COLORS.ink, letterSpacing: '0.12em' }}>
          What to fix · {suggestions.length} {suggestions.length === 1 ? 'item' : 'items'}
        </div>
        <div style={{ ...SW_TYPE.caption, color: SW_COLORS.muted }}>
          Recomputed from the twin on every edit — including yours in Builder
        </div>
      </div>
      {suggestions.map((s, i) => {
        const c = SEVERITY_STYLE[s.severity];
        const focused = !!s.wsId && s.wsId === focusWsId;
        return (
          <div
            key={s.id}
            onMouseEnter={() => s.wsId && onFocus(s.wsId)}
            onMouseLeave={() => s.wsId && onFocus(null)}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 12,
              padding: '10px 12px',
              borderTop: i === 0 ? 'none' : `1px solid ${SW_COLORS.line}`,
              borderLeft: `${SW_BORDER.accent}px solid ${c.bar}`,
              background: focused ? alpha(SW_COLORS.brand, 0.08) : SW_COLORS.paperDeep,
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
              <div
                style={{
                  fontFamily: SW_FONTS.display,
                  fontSize: 13,
                  fontWeight: 800,
                  color: SW_COLORS.ink,
                  marginBottom: 2,
                }}
              >
                {s.title}
              </div>
              <div
                style={{
                  fontFamily: SW_FONTS.mono,
                  fontSize: 11,
                  color: SW_COLORS.muted,
                  lineHeight: 1.45,
                  marginBottom: 4,
                }}
              >
                {s.detail}
              </div>
              <div
                style={{
                  fontFamily: SW_FONTS.mono,
                  fontSize: 11,
                  color: SW_COLORS.ink,
                  fontWeight: 600,
                  lineHeight: 1.45,
                }}
              >
                <span style={{ color: SW_COLORS.muted, fontWeight: 700 }}>→ </span>
                {s.action}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
