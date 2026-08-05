/**
 * What's wrong with this line, and what to do about it.
 *
 * The existing `balance-advisor` reasons purely about the bulletin — takt, LBR,
 * smoothness — which is the right lens for dividing work across stations but
 * blind to what actually happened when the line ran. This module reads the run:
 * where WIP collected, which station was starved, which one blocked, which one
 * turned arrivals away.
 *
 * Every finding carries a typed `patch`, so the UI can apply it rather than
 * describing it and leaving the user to reproduce the edit by hand. A
 * recommendation you can't act on is just a complaint.
 */

import type { StationView } from '../simulation/sim-state';
import type { SewingLine, Twin } from './twin';

export type FindingSeverity = 'critical' | 'warn' | 'opportunity' | 'info';

/**
 * A change the user can apply with one click.
 *
 * Deliberately a small closed set of DOMAIN edits rather than a generic
 * "patch this field": each one has to be explainable in a sentence and
 * reversible by re-selecting the parent scenario.
 */
export type FindingPatch =
  | { kind: 'addServer'; wsId: string; from: number; to: number }
  | { kind: 'setBuffer'; wsId: string; n: number }
  | { kind: 'clearBuffer'; wsId: string }
  | { kind: 'setBundleSize'; lineId: string; from: number; to: number }
  | { kind: 'rebalance'; lineId: string };

export interface QueueFinding {
  /** Stable id so React keys and tests don't depend on the copy. */
  id: string;
  severity: FindingSeverity;
  /** What's wrong, in one line. */
  title: string;
  /** Why we think so — names the station and the number. */
  detail: string;
  /** What to do, verb first. */
  action: string;
  /** Expected effect if applied. Omitted when we can't honestly predict it. */
  expect?: string;
  /** Station this is about, when it's about one. */
  wsId?: string;
  /** Applyable change, when there is one. */
  patch?: FindingPatch;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  warn: 1,
  opportunity: 2,
  info: 3,
};

export interface QueueAdvisorInput {
  stations: StationView[];
  line: SewingLine | null;
  /** Shift length in minutes, for framing absolute losses. */
  shiftMin: number;
  /** Whether the run has actually produced anything yet. */
  produced: number;
}

/** ρ above this and the station is the constraint worth talking about. */
const HOT_RHO = 0.8;
/** ρ below this, on a line whose bottleneck is hot, means idle capacity. */
const COLD_RHO = 0.35;
/**
 * Bundles waiting AT ONE STATION, above which a queue is a pile rather than a
 * buffer.
 *
 * Per-station on purpose. Total line WIP scales with station count, so an
 * absolute line-wide threshold flags a perfectly healthy 27-station line for
 * holding half a bundle at each — which is exactly what a buffer is for.
 */
const PILE_PER_STATION = 1.0;

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

/**
 * Rank every problem the run exposes.
 *
 * Ordered by severity, then by how much of the line's WIP the station holds —
 * so the top of the list is where an hour of the user's attention buys the most.
 */
export function diagnoseQueues(input: QueueAdvisorInput): QueueFinding[] {
  const { stations, line, produced } = input;
  const out: QueueFinding[] = [];
  if (stations.length === 0) return out;

  const byRho = [...stations].sort((a, b) => b.utilization - a.utilization);
  const byLq = [...stations].sort((a, b) => b.LqObserved - a.LqObserved);
  const bottleneck = byRho[0];
  const runnerUp = byRho[1];
  const totalLq = stations.reduce((s, st) => s + st.LqObserved, 0);
  const deepestLq = byLq[0]?.LqObserved ?? 0;

  // ── 1. Nothing ran ────────────────────────────────────────────────────────
  if (produced === 0) {
    out.push({
      id: 'no-output',
      severity: 'critical',
      title: 'The line produced nothing',
      detail:
        'No piece reached the end of the line during the run. Usually the graph is broken '
        + 'rather than the parameters: a missing connector, or no Sink.',
      action: 'Open BUILD and check the line is connected end to end.',
    });
    return out;
  }

  // ── 2. Unstable stations ──────────────────────────────────────────────────
  // ρ ≥ 1 on an unbounded queue is not "very busy", it is divergent: the queue
  // grows for as long as the line runs and no steady state exists.
  for (const st of stations) {
    if (st.utilization < 0.995 && st.isStable) continue;
    if (Number.isFinite(st.capacity)) continue; // a finite buffer bounds it
    out.push({
      id: `unstable-${st.wsId}`,
      severity: 'critical',
      title: `${st.opName} cannot keep up`,
      detail:
        `Operator saturation is ${pct(st.utilization)} — the station is offered more work than `
        + `it can finish, so its queue grows for as long as the line runs. There is no steady `
        + `state to converge to and no output target this line can hold.`,
      action: `Add a second operator at ${st.opName}, or move work off it.`,
      expect: `ρ roughly halves to ${pct(st.utilization / 2)}, and the queue stops growing.`,
      wsId: st.wsId,
      patch: { kind: 'addServer', wsId: st.wsId, from: st.serversTotal, to: st.serversTotal + 1 },
    });
  }

  // ── 3. The bottleneck ─────────────────────────────────────────────────────
  if (bottleneck && bottleneck.utilization >= HOT_RHO && bottleneck.isStable) {
    const gap = runnerUp ? bottleneck.utilization - runnerUp.utilization : bottleneck.utilization;
    // A bottleneck a few points above its neighbour is a balancing problem; one
    // far above them is a capacity problem at a single station. Different fix.
    const isolated = gap > 0.15;
    out.push({
      id: `bottleneck-${bottleneck.wsId}`,
      severity: 'warn',
      title: `${bottleneck.opName} is the constraint`,
      detail:
        `Highest saturation on the line at ${pct(bottleneck.utilization)}`
        + (runnerUp ? `, ${(gap * 100).toFixed(0)} points above ${runnerUp.opName}` : '')
        + `. It holds ${bottleneck.LqObserved.toFixed(2)} bundles waiting on average and caps `
        + `what the whole line can deliver — every other station is idle waiting on it.`,
      action: isolated
        ? `Add a second operator at ${bottleneck.opName} — it is far enough above the rest that rebalancing won't reach it.`
        : `Rebalance the line: the load is close enough across stations that moving one operation should level it.`,
      expect: isolated
        ? `ρ drops to about ${pct(bottleneck.utilization / 2)} and the line's ceiling rises.`
        : 'Levelling the slowest station raises the whole line\'s output ceiling.',
      wsId: bottleneck.wsId,
      patch: isolated
        ? {
            kind: 'addServer',
            wsId: bottleneck.wsId,
            from: bottleneck.serversTotal,
            to: bottleneck.serversTotal + 1,
          }
        : line
          ? { kind: 'rebalance', lineId: line.id }
          : undefined,
    });
  }

  // ── 4. WIP concentration ──────────────────────────────────────────────────
  // Pareto framing, because "some stations have queues" is not actionable but
  // "two stations hold 61 % of your WIP" tells you where to stand.
  if (deepestLq >= PILE_PER_STATION) {
    let cum = 0;
    let n = 0;
    for (const st of byLq) {
      if (cum / totalLq >= 0.6) break;
      cum += st.LqObserved;
      n += 1;
    }
    if (n > 0 && n <= Math.max(1, Math.ceil(stations.length / 3))) {
      const names = byLq.slice(0, n).map((s) => s.opName).join(', ');
      out.push({
        id: 'wip-concentration',
        severity: 'warn',
        title: `${n === 1 ? '1 station holds' : `${n} stations hold`} ${pct(cum / totalLq)} of the line's WIP`,
        detail:
          `Average bundles waiting across the line is ${totalLq.toFixed(1)}, and ${names} `
          + `${n === 1 ? 'accounts' : 'account'} for ${cum.toFixed(1)} of it. WIP sitting in front of a station is cash and `
          + `floor space, and it is where a quality problem hides longest before anyone sees it.`,
        action: `Attack ${byLq[0].opName} first — it is the deepest queue on the line.`,
        wsId: byLq[0].wsId,
      });
    }
  }

  // ── 5. Starvation ─────────────────────────────────────────────────────────
  // Only worth raising when the line HAS a constraint: on an under-fed line
  // every station is idle and saying so twenty-seven times is noise.
  if (bottleneck && bottleneck.utilization >= HOT_RHO) {
    const idle = stations.filter(
      (st) => st.utilization < COLD_RHO && st.LqObserved < 0.1 && st.wsId !== bottleneck.wsId,
    );
    if (idle.length >= 2) {
      out.push({
        id: 'starved-stations',
        severity: 'opportunity',
        title: `${idle.length} stations are idle more than ${pct(1 - COLD_RHO)} of the shift`,
        detail:
          `${idle.slice(0, 4).map((s) => s.opName).join(', ')}`
          + `${idle.length > 4 ? `, +${idle.length - 4} more` : ''} sit below `
          + `${pct(COLD_RHO)} saturation with nothing queued. They are not slow — they are `
          + `starved, waiting on ${bottleneck.opName} upstream. Paying an operator to wait is `
          + `the most expensive kind of idle.`,
        action: 'Rebalance so this idle capacity absorbs work from the constraint.',
        expect: 'Fewer operators for the same output, or the same operators for more output.',
        patch: line ? { kind: 'rebalance', lineId: line.id } : undefined,
      });
    }
  }

  // ── 6. Blocking ───────────────────────────────────────────────────────────
  for (const st of stations) {
    if (st.blocked <= 0) continue;
    out.push({
      id: `blocked-${st.wsId}`,
      severity: 'warn',
      title: `${st.opName} is blocked, not busy`,
      detail:
        `${st.blocked} finished bundle${st.blocked === 1 ? '' : 's'} cannot leave this station `
        + `because the buffer downstream is full. The operator has done the work and is now `
        + `holding it — that time counts against the line but produces nothing.`,
      action: 'Raise the downstream buffer, or relieve the station that is full.',
      wsId: st.wsId,
    });
  }

  // ── 7. Balking ────────────────────────────────────────────────────────────
  for (const st of stations) {
    if (st.balked <= 0) continue;
    const frac = st.balkFraction;
    out.push({
      id: `balking-${st.wsId}`,
      severity: frac > 0.05 ? 'warn' : 'info',
      title: `${st.opName} turned away ${pct(frac)} of arrivals`,
      detail:
        `Its buffer is capped at ${st.capacity} bundles, and ${st.balked} arrivals found it full. `
        + `A finite cart or rack is realistic, but every rejected bundle is work that had to go `
        + `somewhere else or wait upstream.`,
      action: `Raise the buffer at ${st.opName}, or reduce what is being fed to it.`,
      wsId: st.wsId,
      patch: { kind: 'setBuffer', wsId: st.wsId, n: Math.max(2, st.capacity * 2) },
    });
  }

  // ── 8. Bundle size ────────────────────────────────────────────────────────
  // Bundle size pulls in two directions at once: bigger bundles mean fewer
  // arrivals but a longer service time per arrival, so the queue can get worse
  // even as handling gets cheaper. Only raise it when there is a queue to fix.
  // Gated on the DEEPEST station, not the line total: shrinking bundles is a
  // trade (more handling trips) and is only worth proposing when some station
  // actually has a queue that bigger bundles are making worse.
  if (line?.policy?.bundleSize && line.policy.bundleSize > 10 && deepestLq >= PILE_PER_STATION) {
    const current = line.policy.bundleSize;
    const proposed = Math.max(5, Math.round(current / 2));
    out.push({
      id: 'bundle-size',
      severity: 'opportunity',
      title: `Bundles of ${current} are making the queues deeper than they need to be`,
      detail:
        `Every station serves a whole bundle before releasing it, so a bundle of ${current} `
        + `means the next station waits for all ${current} pieces before it can start. Smaller `
        + `bundles flow sooner at the cost of more handling trips.`,
      action: `Try bundles of ${proposed} and compare WIP and lead time.`,
      expect: 'Lead time and WIP fall; material-handling moves roughly double.',
      patch: { kind: 'setBundleSize', lineId: line.id, from: current, to: proposed },
    });
  }

  // ── 9. Healthy ────────────────────────────────────────────────────────────
  if (out.length === 0) {
    out.push({
      id: 'healthy',
      severity: 'info',
      title: 'Nothing is obviously wrong with this line',
      detail:
        `Busiest station is ${bottleneck.opName} at ${pct(bottleneck.utilization)}, no station is `
        + `unstable, and average WIP is ${totalLq.toFixed(1)} bundles. To push further, raise the `
        + `arrival rate until a constraint appears — a line that never queues is a line with `
        + `capacity you are paying for and not using.`,
      action: 'Raise the Source rate in BUILD and re-run to find the real ceiling.',
    });
  }

  return out.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const aLq = stations.find((x) => x.wsId === a.wsId)?.LqObserved ?? 0;
    const bLq = stations.find((x) => x.wsId === b.wsId)?.LqObserved ?? 0;
    return bLq - aLq;
  });
}

// ============================================================================
// APPLYING A FINDING
// ============================================================================

/** Human-readable label for a patch, for the confirm step and the scenario name. */
export function describePatch(patch: FindingPatch, stations: StationView[]): string {
  const name = (wsId: string) => stations.find((s) => s.wsId === wsId)?.opName ?? wsId;
  switch (patch.kind) {
    case 'addServer':
      return `${name(patch.wsId)}: ${patch.from} → ${patch.to} operators`;
    case 'setBuffer':
      return `${name(patch.wsId)}: buffer → ${patch.n}`;
    case 'clearBuffer':
      return `${name(patch.wsId)}: buffer → unbounded`;
    case 'setBundleSize':
      return `Bundle size ${patch.from} → ${patch.to}`;
    case 'rebalance':
      return 'Rebalance the line';
  }
}

/**
 * Return a NEW twin with the patch applied. Pure — the caller decides whether
 * to fork it into a scenario or write it back, so nothing is committed by
 * merely previewing a fix.
 *
 * `rebalance` is intentionally not handled here: reassigning operations across
 * stations changes the line's topology, not one field, and it belongs with the
 * Yamazumi surface that already owns drag-to-reassign.
 */
export function applyPatch(twin: Twin, patch: FindingPatch): Twin {
  switch (patch.kind) {
    case 'addServer':
      return patchWsParams(twin, patch.wsId, { servers: patch.to });
    case 'setBuffer':
      return patchWsParams(twin, patch.wsId, { queueCapacity: patch.n });
    case 'clearBuffer':
      // 0 is how PmlBlockParams spells "unbounded".
      return patchWsParams(twin, patch.wsId, { queueCapacity: 0 });
    case 'setBundleSize':
      return {
        ...twin,
        lines: twin.lines.map((l) =>
          l.id === patch.lineId
            ? { ...l, policy: { ...(l.policy ?? {}), bundleSize: patch.to } }
            : l,
        ),
        workstations: twin.workstations.map((ws) =>
          ws.lineId === patch.lineId && ws.operation?.opId
            ? { ...ws, operation: { ...ws.operation, bundleSize: patch.to } }
            : ws,
        ),
      };
    case 'rebalance':
      return twin;
  }
}

function patchWsParams(
  twin: Twin,
  wsId: string,
  params: Record<string, number>,
): Twin {
  return {
    ...twin,
    workstations: twin.workstations.map((ws) =>
      ws.id === wsId
        ? {
            ...ws,
            block: {
              ...(ws.block ?? {}),
              // The kind has to be carried or the override would reset the
              // block to its catalog default.
              kind: ws.block?.kind ?? 'Service',
              params: { ...(ws.block?.params ?? {}), ...params },
            } as typeof ws.block,
          }
        : ws,
    ),
  };
}
