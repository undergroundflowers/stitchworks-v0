/**
 * Line balance, read off the line the user actually built.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * The Reports "Line Balance" tab used to balance a *garment template*: pick
 * one of the five built-in bulletins, type an operator count, and a heuristic
 * invented N stations out of thin air. None of that touched the twin. The
 * numbers on screen described a line nobody had built and the engine had
 * never run, next to a Performance tab that did read the twin — so the two
 * halves of the same page disagreed by construction, and there was no way for
 * the reader to tell which one was about their factory.
 *
 * Everything here is derived from the twin instead, resolved through the SAME
 * functions the PML engine uses (`serversFor`, the assignment share-factor
 * rule) so a bar on the chart is the pace the engine will actually hold at
 * that station. When this module and the engine disagree it is a bug in one
 * of them, not a modelling choice.
 *
 * ── Units ─────────────────────────────────────────────────────────────────
 * Every minute figure in here is MINUTES PER PIECE. The engine's own cycle is
 * minutes per *agent* (a bundle), which is `smv × bundleSize`; dividing back
 * out by the station's bundle size gives the per-piece pace, and per-piece is
 * the only unit in which two stations carrying different bundle sizes are
 * comparable. Bundle size still matters — it drives lead time and WIP — but
 * it does not change which station paces the line.
 *
 * Pure data + pure logic. No React, no DOM, no zustand.
 */

import type { GarmentTemplate } from './garments';
import type { Operation } from './operations';
import type { Twin, Workstation } from './twin';
import { serversFor } from '../simulation/pml-engine';
import { balance, DEFAULT_BALANCER } from './balancers';
import {
  balanceLoss,
  lineBalanceEfficiency,
  lineBalanceRatio,
  optimumManning,
  smoothnessIndex,
} from './kpi';

// ============================================================================
// TYPES
// ============================================================================

/** One bar on the balance chart — one workstation of the built line. */
export interface BalanceStation {
  wsId: string;
  /** Workstation name as authored in Builder. */
  name: string;
  opId: string;
  op: Operation;
  /** Bulletin SMV, min/piece, exactly as authored. The bar's base height. */
  nominalMin: number;
  /**
   * Skill-matrix multiplier for this op (1 = on standard, >1 faster).
   * Clamped to [0.5, 1.5] — the same clamp `cycleMinFor` applies, so the
   * chart cannot claim a speed the engine will not run.
   */
  skillEff: number;
  /**
   * Operator attendance at this station, 0..1. Summed `Assignment.shareFrac`
   * capped at 1, matching the engine's `buildShareFactorMap`. 1 = the station
   * has its operator all shift; 0.5 = the operator covers it half the time,
   * so its cycle doubles.
   */
  shareFrac: number;
  /** Parallel channels the engine will run here (Kendall's c). */
  servers: number;
  /**
   * Headcount the twin staffs here — distinct non-floater assignments, else
   * `resources.workersRequired`. This is what Builder shows on the tile.
   */
  staffed: number;
  /** Operator minutes this station burns per piece = nominal ÷ skill ÷ share. */
  workContentMin: number;
  /** The pace this station can hold, min/piece = workContent ÷ servers. */
  cycleMin: number;
  /** Pieces/hour this station alone could deliver. */
  capacityPerHr: number;
  /** Bundle size in force at this station (lead-time driver, not a pacer). */
  bundleSize: number;
}

/** A workstation on the line that could not be read as a balanceable station. */
export interface UnbalancedStation {
  wsId: string;
  name: string;
  reason:
    | 'no-operation'
    | 'unknown-operation'
    | 'no-garment'
    /** Source / Sink / Queue / pool — engine wiring, never a pacing station. */
    | 'infrastructure';
  /** Human-readable detail for the reason, e.g. the unresolved op id. */
  detail?: string;
}

export interface LineBalance {
  lineId: string;
  lineName: string;
  /** Garment the line's stations are bound to, when they agree on one. */
  garment: GarmentTemplate | null;
  /** Stations in flow order, one per balanceable workstation. */
  stations: BalanceStation[];
  /** Workstations on this line that carry no pace. Reported, never dropped. */
  excluded: UnbalancedStation[];

  /** Σ servers across stations — the parallel channels the engine runs. */
  servers: number;
  /** Σ staffed across stations — the headcount Builder shows. */
  staffed: number;
  /** Σ workContentMin — what one piece costs the crew, as built. */
  workContentMin: number;
  /** The bulletin's own ΣSMV. Differs from `workContentMin` when the line
   *  does not place every operation, or when skill / sharing bend the cost. */
  bulletinSamMin: number;

  /** Slowest station — the one that sets the line's pace. */
  bottleneck: BalanceStation | null;
  /** Its cycle, min/piece. 0 when the line has no stations. */
  bottleneckMin: number;
  /** Line capacity at the bottleneck, pieces/hour. */
  capacityPerHr: number;

  /**
   * Pitch — Σ workContent ÷ servers. The height every bar would have if the
   * work were divisible and perfectly spread. This is the Yamazumi's target
   * line. It is NOT takt: takt comes from demand, and a line with no demand
   * target has no takt. Conflating the two was the old tab's headline number.
   */
  pitchMin: number;

  /** % of paid channel-minutes idle because bars are uneven. 0 = flat. */
  balanceLossPct: number;
  /** 100 − balanceLoss. Fairness against the bottleneck. */
  lbrPct: number;
  /** √(Σ(bottleneck − cycle)²) ÷ (bottleneck × N). Lower = flatter. */
  smoothness: number;

  /**
   * Channels a perfectly balanced line would need to hold THIS pace —
   * ⌈workContent ÷ bottleneck⌉. The gap to `servers` is the headcount the
   * current imbalance costs. Distinct from the takt-based manning below,
   * which asks a different question (what demand needs).
   */
  channelsToHoldPace: number;
}

/** Takt-dependent reading. Only meaningful once the user states a target. */
export interface TaktReading {
  /** Pieces the line must ship this shift. */
  targetPieces: number;
  /** Shift length used for the takt divide, in minutes. */
  shiftMin: number;
  /** shiftMin ÷ targetPieces, min/piece. */
  taktMin: number;
  /** Σ workContent ÷ (servers × takt) × 100. >100 = infeasible at this crew. */
  lbePct: number;
  /** ⌈workContent ÷ takt⌉ — the crew a perfect line needs to hit demand. */
  requiredChannels: number;
  /** False when the bottleneck alone is already slower than takt. */
  feasible: boolean;
  /** Pieces the line will actually ship this shift at its current pace. */
  achievablePieces: number;
}

// ============================================================================
// RESOLUTION — mirrors the engine, deliberately
// ============================================================================

/** The engine's skill clamp. Duplicated rather than exported from the engine
 *  so this module states the rule it relies on out loud. */
function clampSkill(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(1.5, Math.max(0.5, raw));
}

/**
 * Per-workstation attendance, 0..1. Sum every assignment's `shareFrac` at the
 * station and cap at 1 — one operator serving one piece at a time bounds a
 * single-channel cell no matter how many part-timers are rostered on it.
 * Identical to `buildShareFactorMap` in the engine.
 */
function shareFracMap(twin: Twin): Map<string, number> {
  const sums = new Map<string, number>();
  for (const a of twin.assignments ?? []) {
    const sf = a.shareFrac ?? (a.role === 'primary' ? 1 : a.role === 'helper' ? 0.3 : 0);
    if (sf <= 0) continue;
    sums.set(a.wsId, (sums.get(a.wsId) ?? 0) + sf);
  }
  const out = new Map<string, number>();
  for (const [wsId, total] of sums) out.set(wsId, Math.min(1, total));
  return out;
}

/** Distinct non-floater operators rostered at each station. */
function staffedMap(twin: Twin): Map<string, number> {
  const byWs = new Map<string, Set<string>>();
  for (const a of twin.assignments ?? []) {
    if (a.role === 'floater') continue;
    const set = byWs.get(a.wsId) ?? new Set<string>();
    set.add(a.operatorId);
    byWs.set(a.wsId, set);
  }
  const out = new Map<string, number>();
  for (const [wsId, set] of byWs) out.set(wsId, set.size);
  return out;
}

/** Block kinds that are engine wiring rather than pacing stations. Same set
 *  `buildSimConfigFromTwin` treats as infrastructure. */
const INFRASTRUCTURE_KINDS = new Set([
  'Source',
  'Sink',
  'ResourcePool',
  'Queue',
  'Hold',
  'Wait',
  'Seize',
  'Release',
  'SelectOutput',
  'SelectOutput5',
]);

/**
 * Order the line's workstations the way material moves through them: follow
 * the flow connectors when the twin has any, otherwise fall back to the
 * bulletin's own operation order. Same two-tier rule as the sim's topology
 * resolution, so the chart reads left-to-right in run order.
 */
function orderStations(
  ws: Workstation[],
  twin: Twin,
  garment: GarmentTemplate | null,
): Workstation[] {
  const ids = new Set(ws.map((w) => w.id));
  const edges = (twin.connectors ?? []).filter(
    (c) => c.kind === 'flow' && ids.has(c.fromWsId) && ids.has(c.toWsId),
  );

  if (edges.length > 0) {
    const adj = new Map<string, string[]>();
    const inDeg = new Map<string, number>();
    for (const w of ws) {
      adj.set(w.id, []);
      inDeg.set(w.id, 0);
    }
    for (const e of edges) {
      if (e.fromWsId === e.toWsId) continue;
      adj.get(e.fromWsId)!.push(e.toWsId);
      inDeg.set(e.toWsId, (inDeg.get(e.toWsId) ?? 0) + 1);
    }
    const byId = new Map(ws.map((w) => [w.id, w]));
    const queue = ws.filter((w) => (inDeg.get(w.id) ?? 0) === 0).map((w) => w.id);
    const ordered: Workstation[] = [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(byId.get(id)!);
      for (const next of adj.get(id) ?? []) {
        const d = (inDeg.get(next) ?? 0) - 1;
        inDeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    // A cycle leaves stations unvisited — append them rather than lose them.
    for (const w of ws) if (!seen.has(w.id)) ordered.push(w);
    return ordered;
  }

  if (!garment) return ws;
  const rank = new Map(garment.operations.map((o, i) => [o.id, i]));
  return [...ws].sort(
    (a, b) =>
      (rank.get(a.operation.opId ?? '') ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.operation.opId ?? '') ?? Number.MAX_SAFE_INTEGER),
  );
}

// ============================================================================
// BUILD
// ============================================================================

export interface BuildLineBalanceOptions {
  twin: Twin;
  lineId: string;
  /** Effective garments — built-ins with the project's edits applied. Passing
   *  the raw built-ins here is the bug that made imported bulletins invisible. */
  garmentsById: Record<string, GarmentTemplate>;
  /** Per-op skill multipliers from `efficiencyFromSkillMatrix`. */
  opEfficiency?: Record<string, number>;
}

/**
 * Read one sewing line's balance out of the twin.
 *
 * Never throws: a line with nothing on it returns an empty station list and
 * zeroed metrics, and every workstation that could not be read appears in
 * `excluded` with a reason. Silence about a dropped station is what let the
 * old surface report a confident balance for a line half of which was not in
 * the run.
 */
export function buildLineBalance(opts: BuildLineBalanceOptions): LineBalance {
  const { twin, lineId, garmentsById, opEfficiency } = opts;
  const line = (twin.lines ?? []).find((l) => l.id === lineId);
  const members = twin.workstations.filter((w) => w.lineId === lineId);

  // ── Which garment is this line running? ─────────────────────────────────
  // The stations vote; the line's authored `garmentId` breaks a tie and
  // covers a skeleton line whose stations aren't bound yet. Same rule the
  // sim's `buildSimConfigFromTwin` uses, so both name the same product.
  const votes = new Map<string, number>();
  if (line?.garmentId && garmentsById[line.garmentId]) votes.set(line.garmentId, 1);
  for (const w of members) {
    const gid = w.operation.garmentId;
    if (gid && garmentsById[gid]) votes.set(gid, (votes.get(gid) ?? 0) + 1);
  }
  let garmentId: string | null = null;
  let best = 0;
  for (const [gid, n] of votes) {
    if (n > best) {
      best = n;
      garmentId = gid;
    }
  }
  const garment = garmentId ? (garmentsById[garmentId] ?? null) : null;
  const opById = new Map<string, Operation>(
    (garment?.operations ?? []).map((o) => [o.id, o]),
  );

  const shares = shareFracMap(twin);
  const staff = staffedMap(twin);

  const stations: BalanceStation[] = [];
  const excluded: UnbalancedStation[] = [];

  for (const ws of orderStations(members, twin, garment)) {
    const kind = ws.block?.kind;
    if (kind && INFRASTRUCTURE_KINDS.has(kind)) {
      excluded.push({ wsId: ws.id, name: ws.name, reason: 'infrastructure', detail: kind });
      continue;
    }
    const opId = ws.operation.opId;
    if (!opId) {
      excluded.push({ wsId: ws.id, name: ws.name, reason: 'no-operation' });
      continue;
    }
    if (!garment) {
      excluded.push({ wsId: ws.id, name: ws.name, reason: 'no-garment' });
      continue;
    }
    const op = opById.get(opId);
    if (!op) {
      excluded.push({
        wsId: ws.id,
        name: ws.name,
        reason: 'unknown-operation',
        detail: opId,
      });
      continue;
    }

    const skillEff = clampSkill(opEfficiency?.[opId]);
    const shareFrac = shares.get(ws.id) ?? 1;
    const servers = Math.max(1, serversFor(ws, garmentsById));
    const staffed = staff.get(ws.id) ?? Math.max(0, ws.resources.workersRequired ?? 0);
    const workContentMin = op.smv / skillEff / (shareFrac > 0 ? shareFrac : 1);
    const cycleMin = workContentMin / servers;

    stations.push({
      wsId: ws.id,
      name: ws.name,
      opId,
      op,
      nominalMin: op.smv,
      skillEff,
      shareFrac,
      servers,
      staffed,
      workContentMin,
      cycleMin,
      capacityPerHr: cycleMin > 0 ? 60 / cycleMin : 0,
      bundleSize: Math.max(1, Math.round(ws.operation.bundleSize ?? garment.defaultBundleSize)),
    });
  }

  const serversTotal = stations.reduce((s, st) => s + st.servers, 0);
  const staffedTotal = stations.reduce((s, st) => s + st.staffed, 0);
  const workContentMin = stations.reduce((s, st) => s + st.workContentMin, 0);
  const cycles = stations.map((st) => st.cycleMin);
  // Balance is measured per CHANNEL, not per station — a station doubled up
  // to two operators is two paid channels, and both of them idle when the bar
  // sits under the bottleneck. Expanding here lets the tested `kpi.ts`
  // formulas do the weighting: their `effs.length` denominator becomes the
  // channel count, so LBR collapses to Σ workContent ÷ (Σ servers ×
  // bottleneck) — the form an IE would write by hand. With one operator per
  // station the expansion is a no-op and the numbers match the textbook.
  const channelCycles = stations.flatMap((st) =>
    Array.from({ length: st.servers }, () => st.cycleMin),
  );
  const bottleneckMin = cycles.length > 0 ? Math.max(...cycles) : 0;
  const bottleneck =
    stations.length > 0
      ? stations.reduce((a, b) => (b.cycleMin > a.cycleMin ? b : a))
      : null;

  return {
    lineId,
    lineName: line?.name ?? lineId,
    garment,
    stations,
    excluded,
    servers: serversTotal,
    staffed: staffedTotal,
    workContentMin,
    bulletinSamMin: garment?.totalSmv ?? 0,
    bottleneck,
    bottleneckMin,
    capacityPerHr: bottleneckMin > 0 ? 60 / bottleneckMin : 0,
    // Pitch divides by CHANNELS, not stations: two operators sharing an op
    // halve that station's cycle, so they have to halve the target too or a
    // doubled-up bottleneck reads as balanced against a target it beat by
    // construction.
    pitchMin: serversTotal > 0 ? workContentMin / serversTotal : 0,
    balanceLossPct: balanceLoss(channelCycles),
    lbrPct: lineBalanceRatio(channelCycles),
    smoothness: smoothnessIndex(channelCycles, bottleneckMin),
    channelsToHoldPace: optimumManning({
      totalSam: workContentMin,
      taktMin: bottleneckMin,
    }),
  };
}

/**
 * The takt-dependent half of the reading, which only exists once the user
 * states what the line has to ship.
 *
 * The old tab computed takt as "the bottleneck SMV" and then reported Line
 * Balance Efficiency against it. Since LBE = Σ ÷ (N × takt) and LBR = Σ ÷ (N ×
 * bottleneck), that made LBE identical to LBR to the last decimal — two tiles,
 * one number — and made the "infeasible at takt" warning unreachable, because
 * a line can never be slower than its own bottleneck. Returning null when
 * there is no target is the honest version of that.
 */
export function readTakt(
  bal: LineBalance,
  opts: { targetPieces: number; shiftMin: number },
): TaktReading | null {
  const { targetPieces, shiftMin } = opts;
  if (!(targetPieces > 0) || !(shiftMin > 0)) return null;
  const taktMin = shiftMin / targetPieces;
  return {
    targetPieces,
    shiftMin,
    taktMin,
    lbePct: lineBalanceEfficiency({
      // Per channel, matching `balanceLossPct` — see the note in
      // `buildLineBalance`. Reduces to Σ workContent ÷ (Σ servers × takt).
      stationSmvs: bal.stations.flatMap((s) =>
        Array.from({ length: s.servers }, () => s.cycleMin),
      ),
      taktMin,
    }),
    requiredChannels: optimumManning({ totalSam: bal.workContentMin, taktMin }),
    feasible: bal.bottleneckMin > 0 && bal.bottleneckMin <= taktMin,
    achievablePieces:
      bal.bottleneckMin > 0 ? Math.floor(shiftMin / bal.bottleneckMin) : 0,
  };
}

/**
 * The bottleneck a perfect repack of THIS line's own operations onto THIS
 * line's own channels would reach — the SALBP-2 optimum, approximated by the
 * project's default heuristic (RPW).
 *
 * This is the number that tells the user whether their imbalance is worth
 * chasing. A line whose actual bottleneck already sits on the heuristic's
 * answer is as flat as its bulletin allows: the remaining loss is intrinsic
 * to indivisible operations, not something a rebalance can recover. A line
 * well above it has real headroom.
 *
 * Operations are fed in at their *work content* (SMV inflated by skill and
 * by operator sharing), not at nominal SMV, so the comparison is like for
 * like with `LineBalance.bottleneckMin`.
 *
 * Returns null when there is nothing to pack.
 */
export function bestAchievableBottleneckMin(bal: LineBalance): number | null {
  if (bal.stations.length === 0 || bal.servers <= 0) return null;
  const ops: Operation[] = bal.stations.map((st) => ({
    ...st.op,
    smv: st.workContentMin,
  }));
  const result = balance(DEFAULT_BALANCER, { ops, operatorCount: bal.servers });
  return result.bottleneckSmv > 0 ? result.bottleneckSmv : null;
}
