/**
 * Balance advisor — turns one line's balance reading into a prioritised list
 * of things the user can actually do about it.
 *
 * It takes the `LineBalance` object whole rather than a hand-copied bag of
 * numbers, so the WHAT-TO-FIX rows and the metric tiles are reading the same
 * arithmetic by construction. The previous version accepted eleven loose
 * scalars and the caller passed a *different* takt to the advisor than the one
 * it printed on the tiles.
 *
 * ── Rules that used to be here and no longer are ──────────────────────────
 * Three of the old rules could not fire, and one fired with wrong advice:
 *
 *   • "Line is infeasible at takt" gated on LBE > 100. The caller defined takt
 *     AS the bottleneck, which makes LBE ≡ LBR ≤ 100 — unreachable.
 *   • "Need N more operators to meet takt" gated on ⌈ΣSAM ÷ bottleneck⌉ >
 *     operators. The max of a set is never below its mean, so that is also
 *     unreachable. Both now hang off a real takt and return nothing without
 *     one.
 *   • "N operators above theoretical floor → redeploy them" fired on pure
 *     imbalance, and redeploying operators off an unbalanced line makes the
 *     bottleneck worse, not better. It now says what is actually true: the
 *     imbalance is *costing* those channels, and a rebalance is what frees
 *     them.
 *   • Two actions told the user to "try COMSOAL or GA from the balancer
 *     picker". There has never been a balancer picker in the UI.
 *
 * Pure logic. Safe to call from React render or a test.
 */

import type { BalanceStation, LineBalance, TaktReading } from './line-balance';

export type SuggestionSeverity = 'critical' | 'warn' | 'opportunity' | 'info';

export interface BalanceSuggestion {
  /** Stable id so React keys are predictable and rules can be referenced in
   *  tests without depending on the user-visible title string. */
  id: string;
  severity: SuggestionSeverity;
  title: string;
  /** The diagnostic numbers behind the title. */
  detail: string;
  /** Verb-led next step, naming a control that exists. */
  action: string;
  /** Workstation the row is about, when it is about one. Lets the UI
   *  highlight the offending bar instead of making the user find it. */
  wsId?: string;
}

/** Severity rank for sorting — critical first, info last. */
const SEVERITY_RANK: Record<SuggestionSeverity, number> = {
  critical: 0,
  warn: 1,
  opportunity: 2,
  info: 3,
};

/** Balance loss above this is the textbook "poor balance" threshold. */
const POOR_BALANCE_PCT = 25;
/** Smoothness above this reads as a visibly bumpy chart. */
const BUMPY_SI = 0.2;

const min3 = (v: number) => v.toFixed(3);

/** "OPR-04 · Side seam" — enough for the reader to find the bar. */
function label(st: BalanceStation): string {
  return `${st.name} (${st.op.code ?? st.op.name})`;
}

export interface BalanceAdvisorInput {
  balance: LineBalance;
  /** Present only once the user has stated what the line must ship. */
  takt?: TaktReading | null;
}

/**
 * Run every rule and return the survivors sorted critical → info.
 *
 * Non-prescriptive on purpose: where more than one fix is available the row
 * lists them and lets the IE choose. What it will not do is name a control
 * that does not exist, or fire a rule whose condition is unreachable.
 */
export function suggestBalanceActions(input: BalanceAdvisorInput): BalanceSuggestion[] {
  const bal = input.balance;
  const takt = input.takt ?? null;
  const out: BalanceSuggestion[] = [];

  if (bal.stations.length === 0) {
    return [
      {
        id: 'no-stations',
        severity: 'info',
        title: 'Nothing to balance on this line yet',
        detail:
          bal.excluded.length > 0
            ? `${bal.excluded.length} workstation${bal.excluded.length === 1 ? '' : 's'} sit on this line but none of them carry an operation.`
            : 'This line has no workstations on it.',
        action:
          'Open BUILD, drop stations onto the line, and bind each one to an operation from the bulletin.',
      },
    ];
  }

  const bottleneck = bal.bottleneck!;
  const avgCycle =
    bal.stations.reduce((s, st) => s + st.cycleMin, 0) / bal.stations.length;

  // ── 1. CRITICAL — cannot hit the stated target, and no repack will help ──
  // Σ work content already exceeds what the crew can deliver in a shift, so
  // this is a headcount problem, not a distribution problem.
  if (takt && takt.requiredChannels > bal.servers) {
    const gap = takt.requiredChannels - bal.servers;
    out.push({
      id: 'takt-understaffed',
      severity: 'critical',
      title: `${gap} more operator${gap === 1 ? '' : 's'} needed to hit ${takt.targetPieces} pcs`,
      detail:
        `Takt is ${min3(takt.taktMin)} min/pc (${takt.shiftMin} min ÷ ${takt.targetPieces} pcs). ` +
        `One piece costs the crew ${min3(bal.workContentMin)} operator-minutes, so even a perfectly ` +
        `flat line needs ⌈${min3(bal.workContentMin)} ÷ ${min3(takt.taktMin)}⌉ = ${takt.requiredChannels} channels; ` +
        `this line runs ${bal.servers}. At its current pace it ships ${takt.achievablePieces} pcs.`,
      action: `Add ${gap} operator${gap === 1 ? '' : 's'}, OR run overtime, OR agree a target at or below ${takt.achievablePieces} pcs.`,
    });
  }

  // ── 2. CRITICAL — target is reachable, but the pile-up blocks it ─────────
  // The crew is big enough; the work is in the wrong place. This is the case
  // rebalancing genuinely solves, so it gets its own row and its own copy.
  if (takt && !takt.feasible && takt.requiredChannels <= bal.servers) {
    const over = bal.bottleneckMin - takt.taktMin;
    out.push({
      id: 'takt-bottleneck-blocks',
      severity: 'critical',
      title: `${label(bottleneck)} is ${min3(over)} min/pc slower than takt`,
      detail:
        `Takt ${min3(takt.taktMin)} min/pc, bottleneck ${min3(bal.bottleneckMin)} min/pc. ` +
        `The crew is large enough — ${takt.requiredChannels} channels would do it and you have ${bal.servers} — ` +
        `so this is a distribution problem, not a headcount one. The line ships ${takt.achievablePieces} of ${takt.targetPieces} pcs.`,
      action: `Add a channel at ${label(bottleneck)} until its cycle drops under ${min3(takt.taktMin)} min, OR split "${bottleneck.op.name}" across two stations.`,
      wsId: bottleneck.wsId,
    });
  }

  // ── 3. CRITICAL — the bottleneck is a shared operator ───────────────────
  // A station whose operator is only there part of the shift runs at 1/share
  // speed. When that station is also the pacer, the whole line is being held
  // back by a staffing decision, and the Builder has a one-click reverse.
  if (bottleneck.shareFrac < 1) {
    const mult = 1 / bottleneck.shareFrac;
    out.push({
      id: 'bottleneck-shared-operator',
      severity: 'critical',
      title: `The pacing station only has its operator ${Math.round(bottleneck.shareFrac * 100)} % of the shift`,
      detail:
        `${label(bottleneck)} has a nominal SMV of ${min3(bottleneck.nominalMin)} min, but a shared operator ` +
        `multiplies its cycle by ${mult.toFixed(2)}× to ${min3(bottleneck.cycleMin)} min/pc. ` +
        `That single decision is what caps the line at ${bal.capacityPerHr.toFixed(0)} pcs/hr.`,
      action: `Open BUILD, select ${bottleneck.name}, and use RESTORE OWN OPERATOR — or share a slack station instead of the pacer.`,
      wsId: bottleneck.wsId,
    });
  }

  // ── 4. WARN — poor balance ──────────────────────────────────────────────
  if (bal.balanceLossPct > POOR_BALANCE_PCT) {
    const idlePerPiece = (bal.balanceLossPct / 100) * bal.servers * bal.bottleneckMin;
    out.push({
      id: 'balance-loss-high',
      severity: 'warn',
      title: `${bal.balanceLossPct.toFixed(1)} % of paid channel-minutes are idle`,
      detail:
        `Every piece occupies ${bal.servers} channels for ${min3(bal.bottleneckMin)} min ` +
        `(= ${min3(bal.servers * bal.bottleneckMin)} channel-minutes) but only consumes ` +
        `${min3(bal.workContentMin)} of them, so ${min3(idlePerPiece)} min per piece is waiting. ` +
        `Smoothness index ${bal.smoothness.toFixed(3)} — lower is flatter.`,
      action: `Pull the tallest bars down: add a channel at ${label(bottleneck)}, or move work to a station under the ${min3(bal.pitchMin)} min pitch line.`,
      wsId: bottleneck.wsId,
    });
  }

  // ── 5. WARN — one station towers over the rest ──────────────────────────
  if (avgCycle > 0 && bottleneck.cycleMin > avgCycle * 1.3) {
    const overshoot = ((bottleneck.cycleMin - avgCycle) / avgCycle) * 100;
    out.push({
      id: 'bottleneck-domination',
      severity: 'warn',
      title: `${label(bottleneck)} runs ${overshoot.toFixed(0)} % above the line average`,
      detail:
        `${min3(bottleneck.cycleMin)} min/pc against an average of ${min3(avgCycle)} min/pc across ${bal.stations.length} stations. ` +
        `A second channel here would take it to ${min3(bottleneck.workContentMin / (bottleneck.servers + 1))} min/pc.`,
      action: `Double up on ${bottleneck.name} (c = ${bottleneck.servers} → ${bottleneck.servers + 1}), OR split "${bottleneck.op.name}" (${min3(bottleneck.nominalMin)} min) across two stations.`,
      wsId: bottleneck.wsId,
    });
  }

  // ── 6. WARN — uneven without being badly balanced ───────────────────────
  // Skipped when rule 4 already fired: same diagnosis from another angle.
  if (bal.smoothness > BUMPY_SI && bal.balanceLossPct <= POOR_BALANCE_PCT) {
    out.push({
      id: 'smoothness-high',
      severity: 'warn',
      title: `Station loads are uneven (SI ${bal.smoothness.toFixed(3)})`,
      detail:
        `Balance loss is an acceptable ${bal.balanceLossPct.toFixed(1)} %, but the spread behind it is wide — ` +
        `some stations sit well under the ${min3(bal.pitchMin)} min pitch while others crowd the ` +
        `${min3(bal.bottleneckMin)} min bottleneck.`,
      action: 'Level the tallest two or three bars first — smoothness responds to the extremes, not the middle.',
    });
  }

  // ── 7. OPPORTUNITY — channels the imbalance is costing ──────────────────
  // Deliberately NOT "you are over-staffed, redeploy them". Taking operators
  // off an unbalanced line moves the bottleneck up. The surplus is real only
  // AFTER the repack, and the copy has to say so in that order.
  const surplus = bal.servers - bal.channelsToHoldPace;
  if (surplus >= 2 && bal.channelsToHoldPace > 0) {
    out.push({
      id: 'imbalance-channel-cost',
      severity: 'opportunity',
      title: `Imbalance is costing ${surplus} channel${surplus === 1 ? '' : 's'}`,
      detail:
        `A perfectly flat line would hold the same ${bal.capacityPerHr.toFixed(0)} pcs/hr with ` +
        `⌈${min3(bal.workContentMin)} ÷ ${min3(bal.bottleneckMin)}⌉ = ${bal.channelsToHoldPace} channels; this one uses ${bal.servers}. ` +
        `The difference is idle time, not spare capacity.`,
      action: `Rebalance first, then redeploy the ${surplus} channel${surplus === 1 ? '' : 's'} the repack frees. Pulling them out now would slow the line.`,
    });
  }

  // ── 8. WARN — Builder staffing disagrees with what the engine runs ──────
  // `workersRequired` / assignment rows are what Builder shows on the tile;
  // Kendall's c is what the engine parallelises on. When they disagree the
  // user is reading a headcount the run never used.
  const mismatched = bal.stations.filter((st) => st.staffed !== st.servers);
  if (mismatched.length > 0) {
    const worst = mismatched[0];
    out.push({
      id: 'staffing-vs-channels',
      severity: 'warn',
      title: `${mismatched.length} station${mismatched.length === 1 ? '' : 's'} staffed differently from the channels the run uses`,
      detail:
        `${label(worst)} is staffed for ${worst.staffed} operator${worst.staffed === 1 ? '' : 's'} in BUILD but runs ${worst.servers} parallel channel${worst.servers === 1 ? '' : 's'} in the engine` +
        (mismatched.length > 1 ? `, and ${mismatched.length - 1} other station${mismatched.length === 2 ? ' does' : 's do'} the same.` : '.') +
        ' Every bar on this chart is drawn from the channel count, because that is what paces the line.',
      action: 'Set the channel count on the station itself (the ± control below the bar) so the roster and the run agree.',
      wsId: worst.wsId,
    });
  }

  // ── 9. INFO — stations on the line that carry no pace ───────────────────
  const unbound = bal.excluded.filter((e) => e.reason !== 'infrastructure');
  if (unbound.length > 0) {
    out.push({
      id: 'stations-excluded',
      severity: 'warn',
      title: `${unbound.length} station${unbound.length === 1 ? '' : 's'} on this line are not in the balance`,
      detail:
        unbound
          .slice(0, 4)
          .map((e) =>
            e.reason === 'no-operation'
              ? `${e.name} — no operation bound`
              : e.reason === 'unknown-operation'
                ? `${e.name} — op "${e.detail}" is not in this bulletin`
                : `${e.name} — the line has no garment`,
          )
          .join(' · ') + (unbound.length > 4 ? ` · +${unbound.length - 4} more` : ''),
      action: 'Bind each one to an operation in BUILD, or move it off this line — an unbound station occupies floor space and contributes no capacity.',
      wsId: unbound[0].wsId,
    });
  }

  // ── 10. INFO — nothing else fired ───────────────────────────────────────
  if (out.length === 0) {
    out.push({
      id: 'healthy',
      severity: 'info',
      title: 'Balance is healthy',
      detail:
        `Balance loss ${bal.balanceLossPct.toFixed(1)} %, smoothness ${bal.smoothness.toFixed(3)}, ` +
        `${bal.servers} channels holding ${bal.capacityPerHr.toFixed(0)} pcs/hr` +
        (takt ? ` against a takt of ${min3(takt.taktMin)} min/pc.` : '.'),
      action: 'Keep this layout. Save it as a scenario so a later change has something to be compared against.',
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
