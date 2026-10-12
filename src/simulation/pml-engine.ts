/**
 * PML simulation engine — discrete-event simulator for the Process Modeling
 * Library graph in a Stitchworks twin.
 *
 * Tier-1 block coverage (all the demo factory needs to run end-to-end):
 *   • Source         — generates agents at a constant per-hour rate
 *   • Sink           — destroys agents, captures lead time
 *   • Queue          — FIFO buffer between blocks
 *   • Service        — Seize → Delay → Release, draws from the dept's
 *                      ResourcePool sum (implicit binding for v1)
 *   • SelectOutput   — probabilistic pass / fail router (drives QC)
 *   • ResourcePool   — capacity contributor; not in the flow itself
 *   • Conveyor       — treated as a fixed-time Delay (v1)
 *
 * Other PML kinds (Delay, Hold, Wait, Batch, Unbatch, Combine, Match,
 * Assembler, Split, MoveTo, Seize/Release standalone, SelectOutput5)
 * fall through to a degenerate pass-through in v1: they accept an agent
 * and forward it on the first output port immediately. This keeps a
 * partial graph runnable while we extend coverage in follow-up turns.
 *
 * Architecture:
 *   • One MinHeap of timestamped events (priority queue keyed by sim time).
 *   • Push semantics — when an agent leaves a block, it is delivered
 *     immediately to the target block's `accept(...)`.
 *   • Each block has its own internal queue for back-pressure.
 *   • Time unit is **minutes** throughout (matches the legacy engine and
 *     the IE-friendly "/hr" KPIs the rest of the app speaks).
 *
 * No React, no DOM, no zustand — pure logic so it's testable and reusable
 * by any caller (the Builder runner, future LiveSim, future replication
 * harness, future export).
 */

import type { Twin, Workstation } from '../domain/twin';
import {
  getBlockSpec,
  getBlockParams,
  type PmlBlockKind,
} from '../domain/pml';
// Imported from the leaf module rather than the domain barrel on purpose:
// `domain/index.ts` re-exports the balance layer, which reads the engine's
// own `serversFor` so the chart and the run can never disagree about c.
// Going through the barrel would close that into an import cycle.
import { GARMENT_TEMPLATES, type GarmentTemplate } from '../domain/garments';
import { MinHeap, mulberry32 } from './priority-queue';
import {
  sample as sampleDist,
  scaleServiceDist,
  type ServiceDist,
} from './distributions';
import type { QueueDiscipline } from './queueing';

// ============================================================================
// PUBLIC API
// ============================================================================

export interface PmlIssue {
  level: 'error' | 'warn' | 'info';
  /** Optional Workstation.id this issue is attached to — lets the UI
   *  highlight the offending block when the user clicks the issue. */
  wsId?: string;
  message: string;
}

/**
 * Stateless pre-flight checker — runs the same validation the engine
 * runs internally, but without simulating. Useful for the toolbar
 * "graph health" chip so the user knows what to fix BEFORE clicking
 * RUN SIM. Returns an empty list when the graph is well-formed.
 *
 * Catches: no Source / no Sink, Service blocks without a ResourcePool
 * in their dept, blocks whose inputs/outputs are unwired, Service /
 * Delay blocks with cycle 0 or negative.
 */
export function validatePmlGraph(twin: Twin): PmlIssue[] {
  const issues: PmlIssue[] = [];
  const blockByKind = new Map<PmlBlockKind, Workstation[]>();
  const wsKind = new Map<string, PmlBlockKind>();
  for (const ws of twin.workstations) {
    const k = getBlockSpec(ws).kind;
    wsKind.set(ws.id, k);
    const list = blockByKind.get(k) ?? [];
    list.push(ws);
    blockByKind.set(k, list);
  }

  // Lifecycle presence
  if ((blockByKind.get('Source') ?? []).length === 0) {
    issues.push({
      level: 'error',
      message: 'No Source blocks. The sim has nothing to generate — drop a Source from the PROCESS palette.',
    });
  }
  if ((blockByKind.get('Sink') ?? []).length === 0) {
    issues.push({
      level: 'warn',
      message: 'No Sink blocks. Agents will pile up at the end of the line and lead-time stats will be empty.',
    });
  }

  // Kendall–Lee honesty: the `a` field of every station's classification says
  // M — Poisson arrivals — which holds only if the Source actually draws
  // exponential gaps. Without an inter-arrival distribution the engine emits
  // on a fixed 60/rate interval, which is a D arrival process, and every
  // downstream analytical number is then solved for a model the run is not.
  for (const ws of blockByKind.get('Source') ?? []) {
    // Absent dist is the engine's deterministic (D) fallback; any non-exp dist
    // is likewise not the M the downstream classification asserts.
    const arrivalDist = getBlockParams(ws).arrivalDist;
    if (!arrivalDist || arrivalDist.kind !== 'exp') {
      issues.push({
        level: 'warn',
        wsId: ws.id,
        message:
          `"${ws.name}" does not release bundles as a Poisson stream. `
          + 'The queueing classification assumes M (exponential gaps), so the '
          + 'closed-form numbers will not match the run. Give the Source an '
          + 'exponential inter-arrival distribution to make the M honest.',
      });
    }
  }

  // Service ↔ ResourcePool binding (implicit v1). Scoped to the sewing line,
  // which is the resource container now that the floor is free space; a
  // station with no line is served by any factory-level pool.
  const poolScopes = new Set<string>();
  for (const ws of blockByKind.get('ResourcePool') ?? []) {
    poolScopes.add(ws.lineId ?? FACTORY_POOL_KEY);
  }
  for (const ws of blockByKind.get('Service') ?? []) {
    const scope = ws.lineId ?? FACTORY_POOL_KEY;
    if (!poolScopes.has(scope)) {
      issues.push({
        level: 'warn',
        wsId: ws.id,
        message: `Service "${ws.name}" has no ResourcePool on its ${ws.lineId ? 'line' : 'factory floor'} — it will run without a resource constraint (effectively infinite capacity).`,
      });
    }
  }

  // Per-block parameter sanity + dangling-port checks
  const incomingByWs = new Map<string, number>();
  const outgoingByWs = new Map<string, number>();
  for (const c of twin.connectors) {
    incomingByWs.set(c.toWsId, (incomingByWs.get(c.toWsId) ?? 0) + 1);
    outgoingByWs.set(c.fromWsId, (outgoingByWs.get(c.fromWsId) ?? 0) + 1);
  }
  for (const ws of twin.workstations) {
    const kind = wsKind.get(ws.id)!;
    const spec = getBlockSpec(ws);
    const r = getBlockParams(ws);
    if (kind === 'Service' || kind === 'Delay' || kind === 'MoveTo' || kind === 'Conveyor') {
      if (r.cycleS <= 0) {
        issues.push({
          level: 'warn',
          wsId: ws.id,
          message: `${kind} "${ws.name}" has cycle ${r.cycleS}s — using 30s fallback.`,
        });
      }
    }
    if (kind === 'Source' && (outgoingByWs.get(ws.id) ?? 0) === 0) {
      issues.push({
        level: 'error',
        wsId: ws.id,
        message: `Source "${ws.name}" has no outgoing connector — its agents have nowhere to go.`,
      });
    }
    if (kind === 'Sink' && (incomingByWs.get(ws.id) ?? 0) === 0) {
      issues.push({
        level: 'warn',
        wsId: ws.id,
        message: `Sink "${ws.name}" has no incoming connector — it will count nothing.`,
      });
    }
    // Mid-flow blocks should be wired both ways
    const isMidFlow =
      spec.inputs.length > 0 && spec.outputs.length > 0 && kind !== 'ResourcePool';
    if (isMidFlow) {
      if ((incomingByWs.get(ws.id) ?? 0) === 0) {
        issues.push({
          level: 'info',
          wsId: ws.id,
          message: `${kind} "${ws.name}" has no incoming connector — no agents will reach it.`,
        });
      }
      if ((outgoingByWs.get(ws.id) ?? 0) === 0) {
        issues.push({
          level: 'info',
          wsId: ws.id,
          message: `${kind} "${ws.name}" has no outgoing connector — its output is dropped on the floor.`,
        });
      }
    }
  }

  // Static estimate of Source × Unbatch × Split blow-up. For each
  // Source, walk one hop downstream — if there's an Unbatch reachable,
  // multiply its emission rate by piecesPerAgent. If a Split is on the
  // path, multiply by the number of output ports. We only walk a
  // bounded depth (5 hops) to keep this O(n).
  const SHIFT_MIN = 480;
  const AGENT_BUDGET_THRESHOLD = 500_000;
  const adj = new Map<string, string[]>();
  for (const c of twin.connectors) {
    const list = adj.get(c.fromWsId) ?? [];
    list.push(c.toWsId);
    adj.set(c.fromWsId, list);
  }
  for (const ws of blockByKind.get('Source') ?? []) {
    const r = getBlockParams(ws);
    let estimatedAgents = (r.sourceRatePerHr * SHIFT_MIN) / 60;
    const multiplier = r.piecesPerAgent;
    // Walk a few hops looking for Unbatch / Split that would expand.
    const visited = new Set<string>([ws.id]);
    const stack: { id: string; depth: number; mult: number }[] = [
      { id: ws.id, depth: 0, mult: 1 },
    ];
    let worstMult = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.depth > 5) continue;
      const next = adj.get(cur.id) ?? [];
      for (const nxt of next) {
        if (visited.has(nxt)) continue;
        visited.add(nxt);
        const nxtKind = wsKind.get(nxt);
        let nxtMult = cur.mult;
        if (nxtKind === 'Unbatch') nxtMult *= multiplier;
        if (nxtKind === 'Split') nxtMult *= 2;
        worstMult = Math.max(worstMult, nxtMult);
        stack.push({ id: nxt, depth: cur.depth + 1, mult: nxtMult });
      }
    }
    estimatedAgents *= worstMult;
    if (estimatedAgents > AGENT_BUDGET_THRESHOLD) {
      issues.push({
        level: 'warn',
        wsId: ws.id,
        message: `Source "${ws.name}" with rate ${r.sourceRatePerHr}/hr × pieces ${r.piecesPerAgent} downstream of Unbatch/Split could create ~${Math.round(estimatedAgents).toLocaleString()} agents per shift — may hit the 2M agent cap.`,
      });
    }
  }

  return issues;
}

export interface PmlSimOpts {
  twin: Twin;
  /**
   * All known garment templates — the built-ins with the project's edits
   * applied on top (`useGarments().byId` / `effectiveGarments(...).byId`).
   *
   * The op-level resolvers (`serversFor`, `systemCapacityFor`,
   * `disciplineFor`) fall back to reading the operation off its garment. Left
   * to themselves they read the frozen built-in catalog, which means a
   * queueing parameter the user edited in the Inspector — c, N or the
   * discipline — was silently ignored by the run unless it had also been baked
   * into the workstation's block params. Passing the effective map closes that
   * gap. Omit it and the resolvers fall back to the built-ins, which is what
   * they did before.
   */
  garmentsById?: Record<string, GarmentTemplate>;
  /** Simulated duration in MINUTES. Tier-1 default: 480 (= one 8h shift). */
  durationMin: number;
  /** Seed for the RNG. Use the same seed for deterministic comparison. */
  seed: number;
  /** Sampling period in MINUTES — every N sim minutes the engine snapshots
   *  per-block running totals into `result.samples`. Default 1 min.
   *  Set to 0 to disable sampling (saves memory / time). */
  samplePeriodMin?: number;
  /** Per-op skill-efficiency multipliers keyed by Operation.id. Drives
   *  the cycle-time adjustment: effective cycle = nominal / efficiency.
   *  Computed by `efficiencyFromSkillMatrix(skillMatrix, ops)` upstream.
   *  Missing / 1.0 ⇒ engine runs at nominal speed (today's behaviour). */
  opEfficiency?: Record<string, number>;
  /** P2 — record an entity-level flow-event stream (`result.flow`). Off by
   *  default: recording is purely additive (it never touches sim state) but
   *  can be large, so callers opt in. Drives real bundle animation (replaces
   *  the synthetic `simTime × const` movement) and is the substrate the
   *  finite-buffer blocking work reads to attribute wait vs. block time. */
  recordFlow?: boolean;
  /** Hard cap on recorded flow events. Once hit, recording stops and a
   *  warning is emitted — the sim itself still runs to completion. Ignored
   *  unless `recordFlow` is set. Defaults to `MAX_FLOW_EVENTS_DEFAULT`. */
  maxFlowEvents?: number;
  /**
   * Steady-state warm-up in MINUTES. At `t = warmupMin` every queueing
   * accumulator (the time-integrals, the arrival / balk counters and the wait
   * sums) is ZEROED and the inflow/outflow totals are snapshotted, so the
   * end-of-run `BlockObserved` describes the post-transient regime only. The
   * event calendar and the in-flight agent population are untouched — this is
   * accumulator truncation, not a restart.
   *
   * 0 (the default) means no truncation, i.e. exactly today's numbers.
   *
   * Headless callers (replications, tests) want this. The live UI does NOT:
   * it truncates by DIFFERENCING two samples instead, because it needs the
   * transient to stay visible on the charts.
   */
  warmupMin?: number;
}

/**
 * One frozen frame of per-block metrics at a specific sim time. The
 * timeseries `result.samples` is the contiguous list of these — used by
 * LiveSim to play back a recorded run as an animation.
 *
 * Carries everything the LiveSim ISO / TOP / HEAT views and the queueing
 * analytics page need to render a frame, so the legacy `SimState` shape
 * can be reconstructed by an adapter without touching the engine again.
 */
/**
 * Per-block metrics frozen at one sample time.
 *
 * The `area*` / `arrivals` / `balked` / `waitSum*` fields are CUMULATIVE from
 * t=0 (or from `warmupMin` when engine truncation is on) and are never
 * pre-divided. That is deliberate: a caller recovers a WINDOW average by
 * differencing two samples —
 *
 *     L̄q[t0,t1] = (s1.areaLq − s0.areaLq) / (s1.time − s0.time)
 *     ρ̂[t0,t1]  = (s1.areaBusy − s0.areaBusy) / (c · (s1.time − s0.time))
 *
 * — which is what makes warm-up truncation exact on the live surface without
 * the engine having to know where the warm-up boundary is.
 */
export interface PmlBlockSample {
  /** Cumulative outflow in pieces (or inflow for Sinks). */
  producedPieces: number;
  /** Current queue depth (FIFO + per-input-port FIFOs combined). */
  queueLen: number;
  /** Agents currently being serviced at this block. Equivalent to
   *  the legacy `StationView.busy` — count of occupied server slots. */
  inService: number;
  /** Alias of `inService` matching the legacy `StationView.busy` field
   *  name. Kept as a separate field so the adapter can read it without
   *  a rename per call site. */
  busy: number;
  /** Parallel servers at this block (machine count). Static; mirrors
   *  the legacy `StationView.serversTotal`. */
  serversTotal: number;
  /** P2/P3 — bundles blocked-after-service here at sample time (finished
   *  but can't advance because the downstream buffer is full). 0 under
   *  unbounded buffers. Drives the LiveSim "blocked station" tint. */
  blocked: number;

  // ── Queueing observables (cumulative) ─────────────────────────────────────
  /** Agents ADMITTED here so far. Offered = `arrivals + balked`. */
  arrivals: number;
  /** Agents REJECTED here so far because the system was full — a true balk
   *  in the M/M/c/N sense. Always 0 under unbounded buffers. */
  balked: number;
  /** ∫Lq dt in agent-minutes — WAITING only (excludes in-service). */
  areaLq: number;
  /** ∫L dt in agent-minutes — waiting + in service. */
  areaL: number;
  /** ∫(inService − blocked) dt in server-minutes. PRODUCTIVE occupancy, so
   *  ρ̂ = areaBusy / (c · t) is comparable to the analytical ρ, which has no
   *  notion of blocking. */
  areaBusy: number;
  /** ∫blocked dt in server-minutes. The c>1-correct companion to the
   *  interval-based `blockedMin`. */
  areaBlocked: number;
  /** Σ of MEASURED per-agent queue waits, in minutes: Ŵq = waitSumMin /
   *  waitStarts. A real measurement, not Lq/λ rearranged — which is what
   *  makes Little's law a testable invariant here rather than a definition. */
  waitSumMin: number;
  /** Denominator for the above — agents that have STARTED service. */
  waitStarts: number;
}

export interface PmlSimSample {
  /** Sim time in minutes when this snapshot was taken. */
  time: number;
  /**
   * Per-block running totals, keyed by Workstation.id.
   *
   * A plain Record, NOT a Map: a sample array has to survive
   * `JSON.stringify` so a completed run can be persisted into a scenario
   * blob and replayed without re-running the engine, and so the engine can
   * move to a Web Worker (structured clone) without a serialisation shim.
   */
  blocks: Record<string, PmlBlockSample>;
  /** Cumulative agents that have reached any Sink. */
  totalSunkPieces: number;
  /** Cumulative pieces produced — alias of `totalSunkPieces` exposed under
   *  the legacy field name so consumers can read either. */
  produced: number;
  /** Piece-weighted mean lead time across all sunk agents up to `time`,
   *  in minutes. 0 until the first agent sinks. */
  meanLeadTimeMin: number;
  /** Workstation id with the largest live queue at sample time, or null
   *  when nothing is queued. Live — recomputed each sample. */
  bottleneckWsId: string | null;
  /** Rotation cell markers — keyed by the canonical wsId-join of the cell,
   *  value is the wsId where the rotation marker currently sits. Empty
   *  when the twin has no rotation cells. Drives the canvas rotation
   *  overlay (`RotationTether`) so the marker hops between cells in time
   *  with service completions. */
  rotationPointers: Record<string, string>;
}

export interface BlockObserved {
  wsId: string;
  kind: PmlBlockKind;
  /** Agents that LEFT this block on any output port. */
  produced: number;
  /** Agents currently held inside the block at end of run (queue + in-service). */
  finalQueueLen: number;
  /** Cumulative busy minutes (Service blocks only — 0 for everyone else). */
  busyMin: number;
  /** Cumulative seized resource-units across the run (Service / Assembler). */
  resourceBusyUnitMin: number;
  /** Per-output-port agent count. e.g. SelectOutput sees `pass` vs `fail` here. */
  perPortOut: Record<string, number>;
  /** Final throughput in agents-per-hour. */
  throughputPerHr: number;
  /**
   * ρ̂ — PER-STATION operator saturation, 0..1, measured as
   * `areaBusy / (serversTotal · observedMin)`.
   *
   * This used to divide by the DEPARTMENT-WIDE ResourcePool capacity, so a
   * station busy 400 of 480 minutes on a 20-operator line reported 4.2 %
   * instead of 83 % — and that figure is what `pml-runner` writes into
   * `ws.kpiObserved.utilizationPct`, i.e. what the Builder Inspector shows.
   * The dept-wide number still has a use (see `poolUtilization`) but it is
   * not this station's utilisation.
   */
  utilization: number;
  /**
   * The old dept/line-pool figure under an honest name:
   * `resourceBusyUnitMin / (poolCapacity · observedMin)`. Answers "how hard
   * is this line's whole operator pool working", not "how busy is this one
   * station". 0 when the block has no pool.
   */
  poolUtilization: number;
  /** True if this block had the longest queue at end-of-run — heuristic
   *  bottleneck detection that callers can refine. */
  bottleneck: boolean;
  /** P2 — cumulative minutes this block spent BLOCKED: service finished but
   *  the completed piece couldn't advance because the downstream buffer was
   *  full. 0 under unbounded buffers (the default). A high value flags a
   *  downstream bottleneck starving this station of somewhere to put its
   *  output — distinct from `utilization`, which counts productive service. */
  blockedMin: number;

  // ── P5 measured queueing observables ──────────────────────────────────────
  /** Minutes the observables below cover: `durationMin − warmupMin`. */
  observedMin: number;
  /** Parallel servers c — the ρ̂ denominator. Static for the run. */
  serversTotal: number;
  /** System capacity N (waiting + in service). `Infinity` = unbounded.
   *  Mirrors exactly what the DES enforced, so the analytical layer can be
   *  handed the same N without re-resolving it from the workstation. */
  systemCapacity: number;
  /** Agents admitted during the observation window. */
  arrivals: number;
  /** Agents turned away at a full buffer during the window. */
  balked: number;
  /** Offered arrival rate λ in agents/hr = (arrivals + balked)·60 / observedMin. */
  lambdaOfferedPerHr: number;
  /** Admitted arrival rate λ_eff in agents/hr = arrivals·60 / observedMin. */
  lambdaEffPerHr: number;
  /** Time-average L̄q = areaLq / observedMin. */
  LqObserved: number;
  /** Time-average L̄ = areaL / observedMin. */
  LObserved: number;
  /** MEASURED mean queue wait in MINUTES = waitSumMin / waitStarts. */
  WqObservedMin: number;
  /** Raw integrals, so a caller can re-window or cross-check. */
  areaLq: number;
  areaL: number;
  areaBusy: number;
  areaBlocked: number;
}

/** One entity-level transition in the recorded flow stream. Coarse enough
 *  to stay cheap, rich enough to (a) animate a bundle moving station→station
 *  and (b) reconstruct per-agent wait / service / block spans downstream.
 *
 *   • `spawn`        — a Source created the agent (`wsId` = Source).
 *   • `move`         — the agent traversed an edge; `fromWsId` → `wsId`.
 *   • `startService` — the agent seized a server at `wsId` (service begins).
 *   • `endService`   — the agent released a server at `wsId` (service ends).
 *   • `block`        — service finished but the agent can't advance (the
 *                      downstream buffer is full); the server is now blocked.
 *   • `unblock`      — a previously blocked agent finally advanced; its
 *                      server is freed. Pairs 1:1 with an earlier `block`.
 *   • `sink`         — the agent reached a Sink (`wsId` = Sink).
 */
export type FlowEventKind =
  | 'spawn'
  | 'move'
  | 'startService'
  | 'endService'
  | 'block'
  | 'unblock'
  | 'sink';

export interface FlowEvent {
  /** Sim time in MINUTES. Events are pushed in non-decreasing `t` order. */
  t: number;
  kind: FlowEventKind;
  /** The flowing agent's id. Stable across its whole lifetime. */
  agentId: number;
  /** Block where the event occurred. For `move` this is the DESTINATION. */
  wsId: string;
  /** `move` only — the source block the agent left. */
  fromWsId?: string;
  /** Pieces carried by the agent at this moment (bundles collapse/expand). */
  pieces: number;
}

export interface PmlSimResult {
  /** Run duration in minutes (mirrors opts). */
  durationMin: number;
  /** Total agents (pieces) that hit any Sink — good output. Includes pieces
   *  that needed rework as long as they ultimately passed. */
  totalProduced: number;
  /** Of `totalProduced`, the count that exited with reworkCount === 0 —
   *  i.e. first-pass-right. Drives `firstPassYield`. */
  piecesProducedFTR: number;
  /** Pieces scrapped after exceeding maxReworkAttempts. Counted in the
   *  yield denominator but NOT in `totalProduced`. */
  piecesScrapped: number;
  /** Quality fraction for OEE: piecesProducedFTR / (totalProduced + piecesScrapped).
   *  1.0 when no rework / scrap occurred. */
  firstPassYield: number;
  /** P2 — pieces DROPPED at a saturated finite buffer on a path that can't
   *  exert back-pressure (a branch/merge/pass-through block emitting into a
   *  full downstream, or any non-holding emitter). 0 under unbounded buffers
   *  and on the pure linear Service/Queue/Delay/Conveyor path (which blocks
   *  instead of dropping). A non-zero value means capacity was set somewhere
   *  a v1 block kind can't hold — surfaced as a warning too. */
  piecesLost: number;
  /** Mean lead time across sunk agents, in minutes. */
  meanLeadTimeMin: number;
  /** Aggregate throughput across all sinks (agents/hr). */
  throughputPerHr: number;
  /** Per-block observed metrics, keyed by Workstation.id. */
  blocks: Map<string, BlockObserved>;
  /** Bottleneck workstation id (largest queue) or null when nothing queued. */
  bottleneckWsId: string | null;
  /** Diagnostic warnings — e.g. "no Source blocks", "Service has no
   *  ResourcePool in its dept". The UI surfaces these as hints. */
  warnings: string[];
  /** Recorded timeseries — one sample per `samplePeriodMin` of sim time,
   *  plus a final sample at `durationMin`. Empty when sampling is
   *  disabled. LiveSim plays these back to animate the run. */
  samples: PmlSimSample[];
  /** P2 — entity-level flow stream. Empty unless `opts.recordFlow` was set.
   *  Non-decreasing in `t`. Truncated (with a warning) at `maxFlowEvents`. */
  flow: FlowEvent[];
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

/** A flowing agent — bundle / piece / unit / order. We stay schema-light:
 *  the engine doesn't care what an agent represents, only when it was
 *  born and how many sub-pieces it carries (for Batch/Unbatch later). */
interface Agent {
  id: number;
  bornAt: number; // sim minutes
  pieces: number;
  /** Cycle time drawn when the agent entered service at the current block.
   *  Set by `drawCycle` and read by `serviceEnd` so the busy accounting
   *  matches the actual scheduled duration. Stays undefined for agents
   *  that never entered a time-based block. */
  cycleMin?: number;
  /** Number of times this agent has been routed back upstream by a
   *  reworkRate-driven Service block. 0 = first-pass. Incremented on each
   *  rework decision; scrapped when it exceeds the op's maxReworkAttempts. */
  reworkCount?: number;
  /** Priority class this bundle carries, stamped at spawn from its Source's
   *  `sourcePriority`. 1 = highest. Read only by stations whose discipline
   *  is `Priority`. */
  priority: number;
  /** Sim time this agent entered the CURRENT block's WAITING buffer. Written
   *  on every push into `queue` / `queueByInputPort`, read once at the
   *  matching shift to credit `waitSumMin`. Deliberately overwritten per
   *  block — it is always read at the same block that wrote it, so there is
   *  no cross-block aliasing. */
  queuedAt?: number;
  /** Sim time this agent entered the CURRENT block in any sub-state (waiting,
   *  in service, or blocked). Same per-block overwrite semantics as
   *  `queuedAt`. Credits `sojournSumMin` when the agent leaves. */
  enteredBlockAt?: number;
}

/** All the precomputed routing for a block — output port → list of next
 *  (block, input port) tuples. A typical block has one output going to
 *  one downstream input; SelectOutput has two. */
interface Routing {
  /** Map<outputPortId, [{ targetWsId, targetInPort }]> */
  outputs: Map<string, { targetWsId: string; targetInPort: string }[]>;
}

/**
 * Operator pool — sum of capacities of every 'ResourcePool' block sharing a
 * pool key. Service blocks Seize/Release against their pool implicitly.
 *
 * Keyed PER SEWING LINE (`poolKeyFor`), not per department. A sewing floor's
 * operators belong to a line: they don't float between Line A and Line B
 * mid-shift. Keying by department made every line on one floor draw from a
 * single shared budget, so adding a second line silently throttled the first
 * — and once departments collapse to one hidden "Sewing Floor" that pool
 * would have become factory-wide.
 */
interface OperatorPool {
  /** `line:<lineId>` when the station belongs to a line, else the shared
   *  factory pool key. */
  key: string;
  capacity: number;
  /** Currently-busy units. */
  busy: number;
  /** Stations queued on this pool, FCFS by the instant they first found every
   *  unit taken. A Service that loses the race for an operator parks its id
   *  here so the next release can wake it — without this the seize path was
   *  write-only and the starved station sat idle behind a non-empty queue. */
  waiting: string[];
  /** Cumulative busy-unit-minutes for utilization calc. */
  cumBusyUnitMin: number;
  lastChangeAt: number;
}

/**
 * Which operator pool a workstation draws from. The sewing line is the
 * resource-scoping container: a line's operators are billed against that
 * line and no other. The floor itself is free space, so a station with no
 * line draws from a single factory-wide pool rather than from a zone.
 */
export const FACTORY_POOL_KEY = 'factory';

function poolKeyFor(ws: Workstation): string {
  return ws.lineId ? `line:${ws.lineId}` : FACTORY_POOL_KEY;
}

/** Engine event types — coarse-grained, just enough for Tier-1 coverage. */
type Event =
  | { time: number; kind: 'sourceTick'; wsId: string }
  | { time: number; kind: 'serviceEnd'; wsId: string; agentId: number }
  // P2 — a downstream buffer freed a slot; re-attempt the forward that a
  // blocked holder (Service/Delay/Conveyor) or a stalled Queue was waiting on.
  // Zero-delay (fires at the same sim time) so back-pressure relief cascades
  // upstream without recursion. De-duplicated via `retryScheduled`.
  | { time: number; kind: 'retryForward'; wsId: string }
  // P6 — an operator pool handed back a unit; re-attempt the SEIZE at the
  // stations queued on that pool. Zero-delay (fires at the same sim time) so a
  // freed operator is picked up at the instant of release rather than whenever
  // the starved station next happens to be poked. De-duplicated via
  // `poolRetryScheduled`.
  | { time: number; kind: 'poolRelease'; poolKey: string }
  // P5 — zero every queueing accumulator so the end-of-run rollup describes
  // the post-transient regime. Fires once, at `warmupMin`.
  | { time: number; kind: 'warmupReset' }
  | { time: number; kind: 'sample' };

/** Per-block runtime state. */
interface BlockState {
  ws: Workstation;
  kind: PmlBlockKind;
  /** Queue discipline — decides WHICH waiting agent is picked next, not how
   *  many. Means (L, Lq, W, Wq) are identical across disciplines; what changes
   *  is the spread of individual waits, which is exactly what the sim is for. */
  discipline: QueueDiscipline;
  /** Internal FIFO queue. Used by Queue, Service (when all units busy),
   *  Batch (accumulator), Hold (when blocked), SelectOutput, and the
   *  pass-through fallback — i.e. single-input blocks. */
  queue: Agent[];
  /** Per-INPUT-port FIFO queues. Multi-input blocks (Combine, Match,
   *  Assembler) need to wait until each input has at least one agent
   *  before firing — the single `queue` field above can't represent
   *  that without losing port identity. Keyed by input port id. */
  queueByInputPort: Map<string, Agent[]>;
  /** Cumulative outflow per output port (agent count, not pieces). */
  outflowByPort: Map<string, number>;
  /** Cumulative pieces emitted on the primary output. Drives the badge
   *  throughput so Batch / Unbatch read sensibly to the user — pieces
   *  are conserved across batching, agents are not. */
  outflowPieces: number;
  /** Total agents accepted (entered) at this block. */
  inflow: number;
  /** Total pieces accepted (sum of agent.pieces across inflow). */
  inflowPieces: number;
  /** Service-only: cumulative busy minutes (sum across resource units). */
  busyMin: number;
  /** Count of in-service agents at any moment (Service / Delay / MoveTo /
   *  Conveyor — anything that holds an agent for a cycle). */
  inService: number;
  /** Service-only: deterministic cycle in MINUTES per agent. Used as a
   *  fallback when `cycleDist` is undefined. Cached at build. */
  cycleMin: number;
  /** Service / Delay / Hold / Conveyor / MoveTo — optional cycle-time
   *  distribution. When set, the engine samples per agent instead of
   *  using `cycleMin`. AnyLogic-style stochastic service time. */
  cycleDist: ServiceDist | undefined;
  /** Source-only: deterministic interval in MINUTES used as a fallback. */
  arrivalIntervalMin: number;
  /** Source-only: optional inter-arrival distribution. When set, the engine
   *  draws each gap from this distribution. Matches AnyLogic's
   *  exponential-by-default Source semantics. */
  arrivalDist: ServiceDist | undefined;
  /** SelectOutput-only: pass probability 0..1. */
  passProb: number;
  /** Batch-only: target batch size (agent count). */
  batchSize: number;
  /** Service-only: number of parallel servers (machines) at this station.
   *  Caps `inService` even when the dept's ResourcePool has spare units;
   *  matches the real-world "one machine = one server" semantics. Default 1. */
  servers: number;
  /** Source-only: pieces carried by each emitted agent. Cached at build so
   *  the sourceTick handler doesn't re-read getBlockParams per tick. Falls
   *  back to the downstream Service's `bundleSize` when the Source itself
   *  doesn't pin a value — keeps pilot-factory `buf_in` workstations
   *  emitting full bundles instead of single pieces. */
  piecesPerAgent: number;
  /** Source-only: priority class stamped on every bundle this Source emits.
   *  1 = highest. */
  sourcePriority: number;
  /** P2 — SYSTEM capacity K (agents allowed in this block = waiting + in
   *  service), matching the analytical M/M/c/K model so DES and theory agree.
   *  `Infinity` ⇒ unbounded (the default, and today's behaviour). Service:
   *  accepts while `queue.length + inService < sysCapacity`. Queue: accepts
   *  while `queue.length < sysCapacity` (no servers). Other kinds ignore it. */
  sysCapacity: number;
  /** P2 — agents that FINISHED service here but can't advance yet because the
   *  downstream buffer is full. Each still occupies a server slot (counted in
   *  `inService`) so no new service starts — this is blocking-after-service.
   *  Drained by `retryForward` when the downstream frees a slot. Only Service
   *  / Delay / MoveTo / Conveyor ever populate this. */
  blocked: Agent[];
  /** P2 — cumulative minutes this block held ≥1 blocked agent. */
  blockedMin: number;
  /** P2 — sim time the current blocked interval began, or null when not
   *  blocked. Closed into `blockedMin` when `blocked` empties (and at end of
   *  run). Interval-based: concurrent blocked servers count as one interval. */
  blockedSince: number | null;

  // ── P5 queueing observables ───────────────────────────────────────────────
  // Raw integrals and raw counts only — nothing is pre-divided, so a consumer
  // can window by differencing two samples. See `advanceAreas`.
  /** Sim time the area accumulators have been advanced to. */
  lastAccumAt: number;
  /** ∫Lq dt — agent-minutes WAITING (excludes in-service and blocked). */
  areaLq: number;
  /** ∫L dt — agent-minutes IN SYSTEM. Blocked agents count: a blocked piece
   *  is still physically sitting at this station. */
  areaL: number;
  /** ∫(inService − blocked) dt — PRODUCTIVE server-minutes summed over
   *  servers. Excluding blocking is what keeps ρ̂ comparable to the analytical
   *  ρ, which has no notion of a downstream buffer being full. */
  areaBusyServers: number;
  /** ∫blocked dt — blocked server-minutes. */
  areaBlockedServers: number;
  /** Agents REJECTED here because the system was full. A deferred offer (an
   *  upstream Service that BLOCKS and retries) is NOT a balk — it arrives
   *  later and is counted once, as inflow. */
  balked: number;
  balkedPieces: number;
  /** Σ (serviceStart − queuedAt) over agents that have STARTED service. */
  waitSumMin: number;
  /** Denominator for the above: Ŵq = waitSumMin / waitStarts. */
  waitStarts: number;
  /** Σ (blockExit − enteredBlockAt) over agents that have LEFT this block. */
  sojournSumMin: number;
  sojournExits: number;
  /** Snapshots taken at `warmupMin` so end-of-run rollups can report the
   *  post-transient regime. All zero when no warm-up was requested. */
  warmupAt: number;
  warmupInflow: number;
  warmupOutflowPieces: number;
}

// ============================================================================
// PARAMETER EXTRACTION
// ============================================================================
//
// All sim-relevant parameters route through `getBlockParams()` from
// domain/pml.ts. That helper resolves authored overrides → fixture
// catalog props → hard-coded defaults in one place; here we just
// translate the resolved record into the engine's preferred units
// (minutes for time, capacity counts).

/** Service cycle time in MINUTES per agent (deterministic fallback).
 *
 *  Priority order:
 *    1. Authored override on `ws.block.params.cycleS`.
 *    2. Op-bulletin SMV × bundleSize — when the workstation is bound to a
 *       garment operation (typical for pilot-factory lines). Each engine
 *       "agent" carries one bundle, so the cycle is `smv × bundleSize`
 *       minutes per agent. Without this lookup, every sewing workstation
 *       falls back to the catalog's generic `cycle_s` (35s for any sewing
 *       machine), which makes Line 1 and Line 2 run at identical tempo
 *       regardless of which garment they're stitching.
 *    3. Catalog `cycle_s` / `capacity_per_hr` / 30s hard default.
 *
 *  Finally we apply `shareFactor` — when one operator is shared across N
 *  stations, each station only sees the operator (1/N)·shift, so its
 *  effective cycle time is multiplied by N (i.e. divided by shareFactor).
 *  A station with no shared assignment gets shareFactor=1, no-op.
 */
function cycleMinFor(
  ws: Workstation,
  opEfficiency?: Record<string, number>,
  shareFactor: number = 1,
): number {
  // P2: skill efficiency applies at every cycle source, not just the
  // op-derived path. Pilot factories author block.params.cycleS directly
  // from op.smv × bundleSize, so if skill effi is only applied to the
  // op-derived branch the multiplier silently no-ops on pilot lines.
  const opId = ws.operation?.opId;
  const raw = opId ? opEfficiency?.[opId] : undefined;
  const eff = clampSkillEfficiency(raw);
  const share = clampShareFactor(shareFactor);
  const overrideCycleS = ws.block?.params?.cycleS;
  if (overrideCycleS != null && overrideCycleS > 0) {
    return (overrideCycleS / 60) / eff / share;
  }
  const opCycleMin = opCycleMinFor(ws);
  if (opCycleMin != null) {
    return opCycleMin / eff / share;
  }
  const r = getBlockParams(ws);
  return Math.max(0, r.cycleS) / 60 / eff / share;
}

/** Clamp the share-factor to (0, 1]. A station that hasn't been shared
 *  reports 1 (full attention). 0 would mean the operator is never there —
 *  treat as a no-op rather than dividing by zero. */
function clampShareFactor(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(1, raw);
}

/**
 * Per-workstation share factor derived from `twin.assignments[]`.
 *
 * For each ws we look at non-rotation assignments (primary / helper —
 * rotation_member rotates by piece so its long-run station capacity is
 * driven by group size, not shareFrac). If any of them carry shareFrac < 1,
 * we take the **minimum** — i.e. the worst-attended slot wins, because
 * service rate is bounded by the most absent operator. No assignment ⇒
 * shareFactor = 1 (engine matches today's behaviour for un-staffed twins).
 */
function buildShareFactorMap(twin: Twin): Map<string, number> {
  // Sum shareFracs across all assignments at each ws, then cap at 1
  // because the station's max throughput is bounded by "one operator
  // serving one piece at a time" on a single-server cell. For a station
  // with one operator at 50%, capacity = 0.5 → engine cycle 2×. For a
  // modular cell where 6 operators each spend 1/27 of time here,
  // capacity = 6/27 → engine cycle 27/6 ≈ 4.5×.
  const sums = new Map<string, number>();
  for (const a of twin.assignments ?? []) {
    const sf = a.shareFrac ?? (a.role === 'primary' ? 1 : a.role === 'helper' ? 0.3 : 0);
    if (sf <= 0) continue;
    sums.set(a.wsId, (sums.get(a.wsId) ?? 0) + sf);
  }
  const out = new Map<string, number>();
  for (const [wsId, total] of sums) {
    const capped = Math.min(1, total);
    if (capped < 1) out.set(wsId, capped);
  }
  return out;
}

/**
 * A rotation cell — a group of stations all served by the same pool of
 * rotating operators. Models modular / TSS cells: N operators, M
 * stations, operators hop one station forward after completing each
 * piece. Tokens (count per station index) track where each operator
 * currently is; tryStartService decrements the count when work begins,
 * serviceEnd increments the count at the next station.
 *
 * Operators are fungible within a cell — we don't track per-operator
 * pointers because the long-run KPIs are identical and the count form is
 * simpler. Initial token placement is staggered (one operator per
 * floor(M/N) stations) so the cell doesn't bunch up at station 0 on
 * sim start.
 */
interface RotationCell {
  /** Workstation ids in rotation order. */
  wsIds: string[];
  /** Index map: wsId → position in `wsIds`. Precomputed for O(1) lookup. */
  wsIndex: Map<string, number>;
  /** Operator-count per station index, retained for diagnostics / a future
   *  per-piece rotation mode. Not consulted by the time-fraction engine. */
  free: number[];
  /** Visual pointer used by `PmlSimSample.rotationPointers` to animate
   *  the rotation marker on the canvas. Advances each time a station in
   *  this cell completes a service. */
  pointerIdx: number;
}

/**
 * Build rotation cells from `twin.assignments`. Operators with ≥2
 * `rotation_member` assignments and a shared ws-id set form one cell with
 * a shared free-operator pool. Single-station rotation members are
 * treated as fixed (no rotation effect).
 */
function buildRotationCells(twin: Twin): {
  cells: RotationCell[];
  byWsId: Map<string, RotationCell>;
} {
  const byOp = new Map<string, { wsId: string; rotationOrder: number }[]>();
  for (const a of twin.assignments ?? []) {
    if (a.role !== 'rotation_member') continue;
    const arr = byOp.get(a.operatorId) ?? [];
    arr.push({ wsId: a.wsId, rotationOrder: a.rotationOrder ?? arr.length });
    byOp.set(a.operatorId, arr);
  }
  const opsByCellKey = new Map<string, { wsIds: string[]; opIds: string[] }>();
  for (const [operatorId, members] of byOp) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.rotationOrder - b.rotationOrder);
    const wsIds = members.map((m) => m.wsId);
    const key = wsIds.join('|');
    const entry = opsByCellKey.get(key) ?? { wsIds, opIds: [] };
    entry.opIds.push(operatorId);
    opsByCellKey.set(key, entry);
  }
  const cells: RotationCell[] = [];
  const byWsId = new Map<string, RotationCell>();
  for (const { wsIds, opIds } of opsByCellKey.values()) {
    const n = wsIds.length;
    const opCount = opIds.length;
    // Distribute opCount operators across n station slots — stagger so
    // each station starts with floor(opCount/n) operators (plus 1 for the
    // first opCount % n stations).
    const free = new Array<number>(n).fill(0);
    for (let i = 0; i < opCount; i++) {
      const slot = Math.floor((i * n) / opCount);
      free[slot] += 1;
    }
    const cell: RotationCell = {
      wsIds,
      wsIndex: new Map(wsIds.map((id, i) => [id, i])),
      free,
      pointerIdx: 0,
    };
    cells.push(cell);
    for (const wsId of wsIds) byWsId.set(wsId, cell);
  }
  return { cells, byWsId };
}

/** Skill efficiency multiplier — clamp to [0.5, 1.5] so a stale or wild
 *  matrix entry can't drive cycles to absurd values. 1.0 = nominal speed. */
function clampSkillEfficiency(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 1;
  return Math.min(1.5, Math.max(0.5, raw));
}

/** If the workstation is bound to a garment operation, return the cycle
 *  time per agent (in MINUTES) derived from the bulletin's SMV times the
 *  bundle size. Returns null when the binding is incomplete or the op
 *  lookup misses — caller falls back to the catalog default. */
function opCycleMinFor(ws: Workstation): number | null {
  const opId = ws.operation?.opId;
  const garmentId = ws.operation?.garmentId;
  if (!opId || !garmentId) return null;
  const garment = GARMENT_TEMPLATES[garmentId];
  if (!garment) return null;
  const op = garment.operations.find((o) => o.id === opId);
  if (!op || !(op.smv > 0)) return null;
  const bundleSize = Math.max(1, Math.round(ws.operation?.bundleSize ?? 1));
  return op.smv * bundleSize;
}

/** Service / Delay cycle distribution if set; undefined ⇒ engine falls
 *  back to the deterministic `cycleMin`. */
/**
 * Per-agent service-time distribution — the `b` field of Kendall–Lee.
 *
 * Precedence mirrors `serversFor` / `systemCapacityFor`: the station's own
 * block param wins (it is the per-station override the twin builders bake),
 * then the bound operation's authored `serviceDistribution`.
 *
 * The op-level tier is what makes the textbook's Models IV, V and VI runnable.
 * The Builder Inspector writes the service distribution onto the operation,
 * but the engine read only `block.params.cycleDist` — so choosing Det (D) or
 * Erlang (Eₖ) relabelled the station M/D/1 or M/E_k/1 while the run kept
 * sampling whatever had been baked at build time. The classification was
 * honest about the intent and dishonest about the run.
 */
function cycleDistFor(
  ws: Workstation,
  catalog: GarmentCatalog | undefined,
  opEfficiency: Record<string, number> | undefined,
  shareFactor: number,
): ServiceDist | undefined {
  const base = getBlockParams(ws).cycleDist ?? resolveOp(ws, catalog)?.serviceDistribution;
  if (!base) return undefined;
  // `cycleMinFor` divides the deterministic cycle by efficiency and by the
  // operator's share factor. The sampled path has to take the same two
  // adjustments or a station with a shared operator (or a skill multiplier)
  // runs at nominal speed the moment the user picks any distribution —
  // silently faster than the identical station on the deterministic path.
  // scaleServiceDist moves location and scale together, so Cs is preserved and
  // the Kendall service code does not change.
  const opId = ws.operation?.opId;
  const eff = clampSkillEfficiency(opId ? opEfficiency?.[opId] : undefined);
  const share = clampShareFactor(shareFactor);
  const factor = 1 / (eff * share);
  return factor === 1 ? base : scaleServiceDist(base, factor);
}

/** Source arrival interval in MINUTES per agent (deterministic fallback). */
function arrivalIntervalFor(ws: Workstation): number {
  const r = getBlockParams(ws);
  if (!r.sourceRatePerHr || r.sourceRatePerHr <= 0) return 1;
  return 60 / r.sourceRatePerHr;
}

/** Source inter-arrival distribution if set; undefined ⇒ engine uses the
 *  deterministic interval. */
function arrivalDistFor(ws: Workstation): ServiceDist | undefined {
  return getBlockParams(ws).arrivalDist;
}

/** SelectOutput pass probability 0..1. */
function passProbFor(ws: Workstation): number {
  return getBlockParams(ws).passProb;
}

/** ResourcePool capacity contribution from a single workstation. */
function poolUnitsFor(ws: Workstation): number {
  return getBlockParams(ws).capacity;
}

/** Batch threshold — the agent count before emission. */
function batchSizeFor(ws: Workstation): number {
  return getBlockParams(ws).batchSize;
}

/** Operation-level system capacity (K = queue + in-service), or null when the
 *  workstation isn't bound to an op that pins one. This is the SAME field the
 *  analytical M/M/c/K model reads (`Operation.queueCapacity`), so a Service
 *  authored with a finite buffer behaves consistently in DES and theory. */
function resolveOpQueueCapacity(ws: Workstation, catalog?: GarmentCatalog): number | null {
  const op = resolveOp(ws, catalog);
  if (!op || op.queueCapacity == null || op.queueCapacity <= 0) return null;
  return op.queueCapacity;
}

/** Resolve a block's system capacity K. Precedence: block-param `queueCapacity`
 *  (0 ⇒ unbounded) → op-level `queueCapacity` → `Infinity` (unbounded default,
 *  preserving pre-P2 push-semantics exactly).
 *
 *  Block-param wins because the twin builders BAKE the live authored
 *  `op.queueCapacity` into `block.params` (like `cycleS`/`servers`), so the
 *  DES reads the same value the analytical M/M/c/K model reads off the live
 *  operation. The op-level lookup is a fallback for twins built without baking
 *  (imports, hand-built) and reads the static garment seed. */
export function systemCapacityFor(ws: Workstation, catalog?: GarmentCatalog): number {
  const blockCap = getBlockParams(ws).queueCapacity; // 0 = unbounded
  if (blockCap > 0) return blockCap;
  const opCap = resolveOpQueueCapacity(ws, catalog);
  if (opCap != null) return opCap;
  return Infinity;
}

/** Operation-level parallel-server count c, or null when the workstation
 *  isn't bound to an op that pins one. Mirrors `resolveOpQueueCapacity`. */
function resolveOpServers(ws: Workstation, catalog?: GarmentCatalog): number | null {
  const op = resolveOp(ws, catalog);
  if (!op || op.servers == null || op.servers <= 0) return null;
  return Math.max(1, Math.round(op.servers));
}

/** Effective garment catalog: built-ins with project edits applied. */
type GarmentCatalog = Record<string, GarmentTemplate>;

/**
 * The operation a workstation is bound to, resolved through the supplied
 * catalog when there is one and the frozen built-ins otherwise. Single place
 * so c, N and the discipline can never resolve against different catalogs.
 */
function resolveOp(ws: Workstation, catalog?: GarmentCatalog) {
  const opId = ws.operation?.opId;
  const garmentId = ws.operation?.garmentId;
  if (!opId || !garmentId) return null;
  const garment = (catalog ?? GARMENT_TEMPLATES)[garmentId] ?? GARMENT_TEMPLATES[garmentId];
  if (!garment) return null;
  return garment.operations.find((o) => o.id === opId) ?? null;
}

/**
 * Resolve a block's parallel-server count c. Precedence mirrors
 * `systemCapacityFor` exactly: block-param `servers` → op-level
 * `Operation.servers` → catalog prop → 1.
 *
 * Exported so the analytical adapter resolves c and N through the SAME code
 * path the DES uses. The wrong-capacity-field defect existed precisely
 * because the two layers each resolved these independently.
 *
 * The op-level tier also fixes a quieter bug: the engine used to read only
 * `getBlockParams(ws).servers`, so an operation authored with c = 3 was
 * silently simulated as c = 1 unless the value had been baked into the block.
 */
export function serversFor(ws: Workstation, catalog?: GarmentCatalog): number {
  const p = ws.block?.params?.servers;
  if (p != null && p > 0) return Math.max(1, Math.round(p));
  const opServers = resolveOpServers(ws, catalog);
  if (opServers != null) return opServers;
  return Math.max(1, Math.round(getBlockParams(ws).servers));
}

/**
 * Resolve a station's queue discipline — the fifth field of Kendall–Lee.
 *
 * Same precedence idea as `serversFor` / `systemCapacityFor`: read it off the
 * bound operation, default to FCFS. Until this existed the discipline was
 * authored, stored and shown in the classification label but the engine always
 * popped the head of the buffer, so Model III (M/M/1 : ∞/SIRO) was a label with
 * no behaviour behind it.
 */
export function disciplineFor(ws: Workstation, catalog?: GarmentCatalog): QueueDiscipline {
  // Same precedence as `serversFor` / `systemCapacityFor`: the per-station
  // block override wins, then the shared operation, then the default.
  return (
    ws.block?.params?.queueDiscipline ?? resolveOp(ws, catalog)?.queueDiscipline ?? 'FCFS'
  );
}

// ============================================================================
// CORE ENGINE
// ============================================================================

/** Maximum pieces an Unbatch will explode in a single call. Prevents a
 *  badly-configured Source piecesPerAgent of 50 000 from creating agents
 *  faster than the event loop can drain them. */
const UNBATCH_MAX_PIECES = 5000;

/** Hard ceiling on the total agents that can be created during a run.
 *  Anything past this aborts with a warning so a runaway graph doesn't
 *  freeze the browser. */
const MAX_AGENTS_PER_RUN = 2_000_000;

/** Default ceiling for the recorded flow stream. A busy multi-line shift can
 *  emit a handful of events per agent; 500k keeps a full run's animation data
 *  bounded to a few MB. Past this we stop recording and warn — the sim's KPIs
 *  are unaffected. */
const MAX_FLOW_EVENTS_DEFAULT = 500_000;

export function runPmlSim(opts: PmlSimOpts): PmlSimResult {
  const { twin, durationMin, seed } = opts;
  const samplePeriodMin = opts.samplePeriodMin ?? 1;
  const rng = mulberry32(seed);
  /**
   * Separate stream for the queue-discipline draw.
   *
   * SIRO needs a random number per dequeue. Taking it from `rng` would shift
   * every subsequent service-time and routing draw, so an FCFS run and a SIRO
   * run at the same seed would differ for two reasons at once — the discipline
   * AND a completely different random stream — and neither could be attributed.
   * Its own stream keeps common random numbers intact: change only the
   * discipline and only the discipline's effect shows up.
   */
  const disciplineRng = mulberry32(seed ^ 0x9e3779b9);
  const warnings: string[] = [];
  const samples: PmlSimSample[] = [];
  let hitUnbatchCap = false;
  let hitAgentCap = false;

  // ── P2 flow-event recording (opt-in, purely additive) ─────────────────────
  // `emitFlow` is a no-op unless the caller passed `recordFlow`. It never
  // reads or mutates sim state, so a run with recording on is byte-identical
  // in KPIs to the same run with it off. Bounded by `maxFlow`; on overflow we
  // stop recording and warn once, leaving the sim to finish normally.
  const recordFlow = opts.recordFlow ?? false;
  const maxFlow = Math.max(0, opts.maxFlowEvents ?? MAX_FLOW_EVENTS_DEFAULT);
  const flowEvents: FlowEvent[] = [];
  let hitFlowCap = false;
  function emitFlow(
    kind: FlowEventKind,
    agent: Agent,
    wsId: string,
    fromWsId?: string,
  ): void {
    if (!recordFlow) return;
    if (flowEvents.length >= maxFlow) {
      if (!hitFlowCap) {
        warnings.push(
          `Flow recording hit ${maxFlow.toLocaleString()} events — animation stream truncated. KPIs are unaffected; raise maxFlowEvents or shorten the run for a complete stream.`,
        );
        hitFlowCap = true;
      }
      return;
    }
    flowEvents.push({ t: now, kind, agentId: agent.id, wsId, fromWsId, pieces: agent.pieces });
  }

  // ── Build block states ─────────────────────────────────────────────────────
  // shareFactorMap captures the engine-visible slowdown for each shared
  // workstation. Computed once up front so cycleMinFor can be a pure
  // function of (ws, efficiency, shareFactor) without re-scanning assignments.
  const shareFactorMap = buildShareFactorMap(twin);
  // Rotation cells — modular/TSS cells where N operators time-share
  // across M stations. KPIs are derived from the time-fraction model via
  // shareFactor; this structure drives the visual rotation pointer in
  // `PmlSimSample.rotationPointers` so the canvas can animate the marker.
  const { cells: rotationCells, byWsId: rotationCellByWsId } = buildRotationCells(twin);
  const blocks = new Map<string, BlockState>();
  for (const ws of twin.workstations) {
    const spec = getBlockSpec(ws);
    const shareFactor = shareFactorMap.get(ws.id) ?? 1;
    blocks.set(ws.id, {
      ws,
      kind: spec.kind,
      queue: [],
      queueByInputPort: new Map(spec.inputs.map((p) => [p.id, []])),
      outflowByPort: new Map(),
      outflowPieces: 0,
      inflow: 0,
      inflowPieces: 0,
      busyMin: 0,
      inService: 0,
      cycleMin: cycleMinFor(ws, opts.opEfficiency, shareFactor),
      cycleDist: cycleDistFor(ws, opts.garmentsById, opts.opEfficiency, shareFactor),
      arrivalIntervalMin: arrivalIntervalFor(ws),
      arrivalDist: arrivalDistFor(ws),
      passProb: passProbFor(ws),
      batchSize: batchSizeFor(ws),
      servers: serversFor(ws, opts.garmentsById),
      discipline: disciplineFor(ws, opts.garmentsById),
      piecesPerAgent: Math.max(1, Math.round(getBlockParams(ws).piecesPerAgent)),
      sourcePriority: Math.max(1, Math.round(getBlockParams(ws).sourcePriority)),
      // P2 — finite-buffer state. Unbounded by default → identical to the
      // pre-P2 push-semantics engine.
      sysCapacity: systemCapacityFor(ws, opts.garmentsById),
      blocked: [],
      blockedMin: 0,
      blockedSince: null,
      // P5 queueing observables — all raw, all start empty.
      lastAccumAt: 0,
      areaLq: 0,
      areaL: 0,
      areaBusyServers: 0,
      areaBlockedServers: 0,
      balked: 0,
      balkedPieces: 0,
      waitSumMin: 0,
      waitStarts: 0,
      sojournSumMin: 0,
      sojournExits: 0,
      warmupAt: 0,
      warmupInflow: 0,
      warmupOutflowPieces: 0,
    });
  }

  // ── Smart Source defaults from downstream bundleSize ─────────────────────
  // When a Source (typically a `buf_in` workstation) hasn't pinned an
  // explicit `piecesPerAgent`, look at the first downstream Service block
  // it feeds. If that block carries a `bundleSize` from the garment bulletin,
  // emit full bundles instead of single pieces. Without this, every line
  // bottoms out at the 60 agents/hr × 1 piece default — making the Source
  // the true bottleneck regardless of which garment is on the line.
  for (const ws of twin.workstations) {
    const b = blocks.get(ws.id);
    if (!b || b.kind !== 'Source') continue;
    // Skip when the user has explicitly pinned piecesPerAgent on the block.
    if (ws.block?.params?.piecesPerAgent != null) continue;
    // Find the first downstream Service with a bundleSize.
    let bundleSize: number | null = null;
    for (const c of twin.connectors) {
      if (c.fromWsId !== ws.id) continue;
      const down = blocks.get(c.toWsId);
      if (!down) continue;
      const bs = down.ws.operation?.bundleSize;
      if (bs && bs > 0) {
        bundleSize = bs;
        break;
      }
      // One more hop in case the immediate downstream is a Queue/Buffer.
      for (const c2 of twin.connectors) {
        if (c2.fromWsId !== down.ws.id) continue;
        const down2 = blocks.get(c2.toWsId);
        const bs2 = down2?.ws.operation?.bundleSize;
        if (bs2 && bs2 > 0) {
          bundleSize = bs2;
          break;
        }
      }
      if (bundleSize) break;
    }
    if (bundleSize) b.piecesPerAgent = bundleSize;
  }

  // ── Build operator pools (implicit binding, keyed per sewing line) ────────
  const operatorPools = new Map<string, OperatorPool>();
  for (const ws of twin.workstations) {
    const kind = getBlockSpec(ws).kind;
    if (kind !== 'ResourcePool') continue;
    const key = poolKeyFor(ws);
    const pool = operatorPools.get(key) ?? {
      key,
      capacity: 0,
      busy: 0,
      waiting: [],
      cumBusyUnitMin: 0,
      lastChangeAt: 0,
    };
    pool.capacity += poolUnitsFor(ws);
    operatorPools.set(key, pool);
  }

  // ── Build routing (precompute output → target lookup) ─────────────────────
  const routing = new Map<string, Routing>();
  for (const ws of twin.workstations) routing.set(ws.id, { outputs: new Map() });
  for (const c of twin.connectors) {
    const fromBlock = blocks.get(c.fromWsId);
    const toBlock = blocks.get(c.toWsId);
    if (!fromBlock || !toBlock) continue;
    const fromSpec = getBlockSpec(fromBlock.ws);
    const toSpec = getBlockSpec(toBlock.ws);
    const fromPortId = c.fromPort ?? fromSpec.outputs[0]?.id;
    const toPortId = c.toPort ?? toSpec.inputs[0]?.id;
    if (!fromPortId || !toPortId) continue;
    const r = routing.get(c.fromWsId)!;
    const list = r.outputs.get(fromPortId) ?? [];
    list.push({ targetWsId: c.toWsId, targetInPort: toPortId });
    r.outputs.set(fromPortId, list);
  }

  // ── Reverse routing (P2 back-pressure) ────────────────────────────────────
  // Who feeds each block? When a block frees a buffer slot we schedule a
  // retryForward for its feeders so a blocked upstream can advance.
  const feedersOf = new Map<string, string[]>();
  for (const c of twin.connectors) {
    if (!blocks.has(c.fromWsId) || !blocks.has(c.toWsId)) continue;
    const list = feedersOf.get(c.toWsId) ?? [];
    if (!list.includes(c.fromWsId)) list.push(c.fromWsId);
    feedersOf.set(c.toWsId, list);
  }
  /** Blocks with a retryForward already queued (de-dups the cascade so at most
   *  one pending retry exists per block per instant). Cleared when it fires. */
  const retryScheduled = new Set<string>();
  /** Pools with a poolRelease already queued (collapses several releases at one
   *  instant into a single sweep). Cleared when it fires. */
  const poolRetryScheduled = new Set<string>();

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Reuse the same validator the toolbar's pre-flight chip uses, so the
  // user sees identical messaging before vs. after the run. Drop info-
  // level entries from the engine warnings (they're hints, not run-time
  // problems).
  for (const issue of validatePmlGraph(twin)) {
    if (issue.level === 'info') continue;
    warnings.push(issue.message);
  }
  const sources = [...blocks.values()].filter((b) => b.kind === 'Source');

  // ── Sink stats ─────────────────────────────────────────────────────────────
  let totalProduced = 0;
  let piecesProducedFTR = 0;
  let piecesScrapped = 0;
  let piecesLost = 0;
  let leadTimeAccum = 0;
  let nextAgentId = 1;
  // ── Event queue ────────────────────────────────────────────────────────────
  const pq = new MinHeap<Event>((a, b) => a.time - b.time);

  // Schedule first arrival at every Source. When the Source has an
  // `arrivalDist` set (e.g. exponential), draw the first gap from it so
  // the run isn't biased by a deterministic warm-up. This matches AnyLogic's
  // default behaviour for a stochastic Source.
  for (const src of sources) {
    pq.push({ time: drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
  }

  // Schedule periodic snapshot events so we can hand LiveSim a timeseries
  // it can play back. Sampling at t=0 is recorded synchronously below.
  if (samplePeriodMin > 0) {
    let t = samplePeriodMin;
    while (t <= durationMin) {
      pq.push({ time: t, kind: 'sample' });
      t += samplePeriodMin;
    }
  }

  // P5 — steady-state warm-up truncation. One event, fired once.
  const warmupMin = Math.max(0, Math.min(opts.warmupMin ?? 0, durationMin));
  if (warmupMin > 0) pq.push({ time: warmupMin, kind: 'warmupReset' });

  /** Capture a frozen snapshot of every block's running totals at sim
   *  time `t`. O(blocks) — cheap, runs once per `samplePeriodMin`.
   *
   *  Computes a live bottleneck (block with the largest queue at this
   *  instant) and a running piece-mean lead time so LiveSim can show the
   *  same numbers the legacy engine surfaces frame-by-frame. */
  function takeSample(t: number): void {
    const m: Record<string, PmlBlockSample> = {};
    let liveBottleneckWsId: string | null = null;
    let liveBottleneckQ = 0;
    for (const b of blocks.values()) {
      // Bring the time-integrals up to the sample instant BEFORE reading them,
      // otherwise every area lags by one inter-event gap — which is what made
      // the plotted ρ̂ a step function that could never converge onto the flat
      // analytical line drawn beside it.
      advanceAreas(b, t);
      const portQ = [...b.queueByInputPort.values()].reduce((s, q) => s + q.length, 0);
      const queueLen = b.queue.length + portQ;
      if (queueLen > liveBottleneckQ) {
        liveBottleneckQ = queueLen;
        liveBottleneckWsId = b.ws.id;
      }
      // Sinks have no output ports — their "produced" is what flowed IN.
      m[b.ws.id] = {
        producedPieces: b.kind === 'Sink' ? b.inflowPieces : b.outflowPieces,
        queueLen,
        inService: b.inService,
        // `busy` mirrors `inService` — both expose occupied service slots.
        // Kept as separate fields so the legacy-shape adapter can read the
        // legacy field name without an alias map.
        busy: b.inService,
        serversTotal: b.servers,
        blocked: b.blocked.length,
        arrivals: b.inflow,
        balked: b.balked,
        areaLq: b.areaLq,
        areaL: b.areaL,
        areaBusy: b.areaBusyServers,
        areaBlocked: b.areaBlockedServers,
        waitSumMin: b.waitSumMin,
        waitStarts: b.waitStarts,
      };
    }
    // Snapshot rotation pointers for the canvas overlay. Key by the cell's
    // canonical wsId-join so two cells with the same ws-set (rare — same
    // operator twin-loaded twice) don't collide. Value is the ws where
    // the pointer currently sits.
    const rotationPointers: Record<string, string> = {};
    for (const cell of rotationCells) {
      const key = cell.wsIds.join('|');
      rotationPointers[key] = cell.wsIds[cell.pointerIdx];
    }
    samples.push({
      time: t,
      blocks: m,
      totalSunkPieces: totalProduced,
      produced: totalProduced,
      meanLeadTimeMin: totalProduced > 0 ? leadTimeAccum / totalProduced : 0,
      bottleneckWsId: liveBottleneckWsId,
      rotationPointers,
    });
  }
  // Initial sample at t=0 so the timeline doesn't start empty.
  if (samplePeriodMin > 0) takeSample(0);

  /**
   * Draw a per-agent cycle time for a Service / Delay / Hold / Conveyor /
   * MoveTo block. Uses the authored `cycleDist` when set, otherwise the
   * deterministic `cycleMin`. AnyLogic-equivalent Service block sampling.
   */
  function drawCycle(b: BlockState): number {
    if (b.cycleDist) return Math.max(1e-6, sampleDist(b.cycleDist, rng));
    return Math.max(0, b.cycleMin);
  }

  /**
   * Draw a per-arrival inter-arrival time for a Source block. Uses the
   * authored `arrivalDist` when set, otherwise the deterministic
   * `arrivalIntervalMin`. Matches AnyLogic Source's "Arrivals defined by"
   * Rate / Interarrival time switch.
   */
  function drawArrivalGap(b: BlockState): number {
    if (b.arrivalDist) return Math.max(1e-6, sampleDist(b.arrivalDist, rng));
    return Math.max(0, b.arrivalIntervalMin);
  }

  /** Update a pool's busy-unit-minute accumulator before mutating busy. */
  function bumpPoolAccum(pool: OperatorPool, now: number): void {
    pool.cumBusyUnitMin += pool.busy * (now - pool.lastChangeAt);
    pool.lastChangeAt = now;
  }

  /**
   * Advance this block's time-integral accumulators to `now`.
   *
   * MUST be called immediately BEFORE any mutation of `queue`,
   * `queueByInputPort`, `inService` or `blocked`. The areas are rectangles
   * under piecewise-constant counts, so it is the PRE-change level that earns
   * credit for the elapsed span — calling it after the mutation attributes the
   * span to the wrong level and silently biases every derived ρ̂ / L̄q / L̄.
   *
   * Idempotent in time: a second call at the same `now` credits nothing.
   */
  function advanceAreas(b: BlockState, now: number): void {
    const dt = now - b.lastAccumAt;
    if (dt > 0) {
      let waiting = b.queue.length;
      if (b.queueByInputPort.size > 0) {
        for (const q of b.queueByInputPort.values()) waiting += q.length;
      }
      const blocked = b.blocked.length;
      const busy = Math.max(0, b.inService - blocked);
      b.areaLq += waiting * dt;
      b.areaL += (waiting + b.inService) * dt;
      b.areaBusyServers += busy * dt;
      b.areaBlockedServers += blocked * dt;
    }
    b.lastAccumAt = now;
  }

  /**
   * Record an offer REJECTED at a saturated finite buffer — a true balk in the
   * M/M/c/N sense: the arrival found the system full and was turned away.
   *
   * Note what is NOT a balk: an upstream Service that finishes, finds the
   * downstream full, and HOLDS the piece (blocking-after-service). That piece
   * is not lost, it arrives later, and it is counted once as inflow then.
   */
  function recordBalk(targetWsId: string, pieces: number): void {
    const b = blocks.get(targetWsId);
    if (!b) return;
    b.balked += 1;
    b.balkedPieces += pieces;
  }

  /**
   * Try to start service for the next agent waiting on a Service block,
   * if any. Returns true if a service was started. Called whenever (a) a
   * new agent arrives at a Service or (b) a serviceEnd frees a unit.
   */
  function tryStartService(b: BlockState, now: number): boolean {
    if (b.kind !== 'Service') return false;
    if (b.queue.length === 0) return false;
    // Per-station server cap: cannot exceed the configured `servers` count
    // even when the dept's pool has spare units. Matches "one machine =
    // one server" semantics — without this, the pool acts as a shared
    // pool of mobile operators that float between stations.
    if (b.inService >= b.servers) return false;
    // Rotation cells are accounted for via shareFactor (1/cellSize) so
    // long-run KPIs are stable. The visual rotation pointer is advanced
    // separately for the canvas overlay — see `rotationCells` /
    // `advanceRotationPointer` below.
    const pool = operatorPools.get(poolKeyFor(b.ws));
    if (pool) {
      if (pool.busy >= pool.capacity) {
        // No free unit. Park this station on the pool's wait list so the next
        // release wakes it — returning bare `false` here is what let a station
        // that lost the race idle behind a non-empty queue.
        joinPoolQueue(pool, b.ws.id);
        return false;
      }
      bumpPoolAccum(pool, now);
      pool.busy += 1;
    }
    // Areas must be credited at the PRE-shift levels (one more waiting, one
    // fewer in service) before the mutations below.
    advanceAreas(b, now);
    const a = dequeue(b)!;
    // Measured queue wait: the span this agent actually spent in the buffer.
    // This is the number Ŵq is built from — not Lq/λ rearranged, which is
    // what made Little's law untestable here before.
    b.waitSumMin += Math.max(0, now - (a.queuedAt ?? now));
    b.waitStarts += 1;
    // Pulling from the buffer freed a slot — let any blocked upstream retry.
    notifyFeeders(b, now);
    b.inService += 1;
    // Sample a per-agent cycle so the busy-time accounting at `serviceEnd`
    // sees the same draw that scheduled this completion. Stash on the agent
    // record so it survives the heap round-trip.
    const cycle = drawCycle(b);
    a.cycleMin = cycle;
    pq.push({ time: now + cycle, kind: 'serviceEnd', wsId: b.ws.id, agentId: a.id });
    // Track in-flight agent so serviceEnd can release it. We stuff the
    // agent into a side-table keyed by id; for v1 we just keep its bornAt
    // on the agent record itself which we still have here.
    inFlightAgents.set(a.id, a);
    emitFlow('startService', a, b.ws.id);
    return true;
  }

  /** Side-table for in-flight Service agents (id → Agent). */
  const inFlightAgents = new Map<number, Agent>();

  // ── P2 finite-buffer / blocking helpers ───────────────────────────────────

  /** Can this block accept one more agent into its buffer right now? Only
   *  Service (system = queue + in-service) and Queue (system = queue) enforce
   *  a finite capacity; every other kind has unbounded intake in v1. With the
   *  default `sysCapacity === Infinity` this is always true, so the whole
   *  blocking path is inert unless the user authored a finite buffer. */
  function canAcceptAt(wsId: string): boolean {
    const b = blocks.get(wsId);
    if (!b) return true;
    if (b.kind === 'Service') return b.queue.length + b.inService < b.sysCapacity;
    if (b.kind === 'Queue') return b.queue.length < b.sysCapacity;
    return true;
  }

  /** A block just freed a buffer slot — schedule a zero-delay retry for each
   *  feeder that is currently holding agents (a blocked Service/Delay/Conveyor,
   *  or a Queue that couldn't drain). De-duplicated so the cascade can't
   *  schedule the same block twice at one instant. */
  function notifyFeeders(b: BlockState, now: number): void {
    const feeders = feedersOf.get(b.ws.id);
    if (!feeders) return;
    for (const fId of feeders) {
      if (retryScheduled.has(fId)) continue;
      const f = blocks.get(fId);
      if (!f) continue;
      const holding = f.blocked.length > 0 || (f.kind === 'Queue' && f.queue.length > 0);
      if (!holding) continue;
      retryScheduled.add(fId);
      pq.push({ time: now, kind: 'retryForward', wsId: fId });
    }
  }

  /** Is this Service ready to work and held up ONLY by the operator pool?
   *  Mirrors every non-pool guard in `tryStartService`, so `true` means a free
   *  unit would put it to work immediately. */
  function starvedOnPool(b: BlockState): boolean {
    if (b.kind !== 'Service') return false;
    if (b.queue.length === 0) return false;
    return b.inService < b.servers;
  }

  /** Park a station at the BACK of a pool's wait list (idempotent). Station
   *  counts are small, so the linear membership check is cheaper than carrying
   *  a parallel Set. */
  function joinPoolQueue(pool: OperatorPool, wsId: string): void {
    if (!pool.waiting.includes(wsId)) pool.waiting.push(wsId);
  }

  /** A pool just took a unit back — schedule a zero-delay sweep if anyone is
   *  queued on it. The releasing station keeps first refusal: its own call site
   *  runs `tryStartService` synchronously, before this event can pop. A pool
   *  nobody ever queued on schedules nothing, so uncontended runs are
   *  untouched.
   *
   *  `retryForward` cannot stand in here: it clears DOWNSTREAM buffer space and
   *  skips a pool-starved Service entirely, because such a station never got an
   *  agent into service and so has an empty `blocked` list. */
  function notifyPoolWaiters(pool: OperatorPool, now: number): void {
    if (pool.waiting.length === 0) return;
    if (poolRetryScheduled.has(pool.key)) return;
    poolRetryScheduled.add(pool.key);
    pq.push({ time: now, kind: 'poolRelease', poolKey: pool.key });
  }

  /** Hand a pool's free units to the stations queued on it, longest-waiting
   *  first (FCFS on the resource). A station that starts and still has work
   *  re-joins at the BACK, so one busy station cannot monopolise a pool that
   *  several stations are waiting on — the property that keeps a serial line
   *  flowing instead of piling every operator onto its first station.
   *
   *  Deterministic: the wait list is ordered by seize-failure time and mutated
   *  only here and in `joinPoolQueue`, never by an event-heap tie-break — so a
   *  given seed always resolves contention the same way.
   *
   *  Terminates: each pass either consumes a unit (bounded by `capacity`) or
   *  drops a waiter (bounded by the list length). */
  function wakePool(pool: OperatorPool, now: number): void {
    let guard = pool.waiting.length + pool.capacity + 1;
    while (pool.busy < pool.capacity && pool.waiting.length > 0 && guard-- > 0) {
      const wsId = pool.waiting.shift()!;
      const b = blocks.get(wsId);
      if (!b) continue;
      // A start consumes the unit we just freed; if this station still has
      // work queued it goes to the back of the line rather than taking more.
      // A station no longer startable is simply dropped — it re-registers on
      // its next seize attempt.
      if (tryStartService(b, now) && starvedOnPool(b)) joinPoolQueue(pool, wsId);
    }
  }

  /** Release one occupied server slot (and, for a Service, its dept-pool
   *  unit). The inverse of the seize in `tryStartService`. */
  function freeServer(b: BlockState, now: number): void {
    advanceAreas(b, now);
    b.inService = Math.max(0, b.inService - 1);
    if (b.kind === 'Service') {
      const pool = operatorPools.get(poolKeyFor(b.ws));
      if (pool) {
        bumpPoolAccum(pool, now);
        pool.busy = Math.max(0, pool.busy - 1);
        // The returned unit is free — wake whoever is queued on it.
        notifyPoolWaiters(pool, now);
      }
    }
  }

  /** Close an open blocking interval into the cumulative accumulator. */
  function endBlockInterval(b: BlockState, now: number): void {
    if (b.blockedSince !== null) {
      b.blockedMin += now - b.blockedSince;
      b.blockedSince = null;
    }
  }

  /** Advance the visual rotation pointer for a Service completion (canvas
   *  overlay only — KPIs use the shareFactor approximation). */
  function advanceRotation(b: BlockState): void {
    const rotCell = rotationCellByWsId.get(b.ws.id);
    if (rotCell) {
      rotCell.pointerIdx = ((rotCell.pointerIdx ?? 0) + 1) % rotCell.wsIds.length;
    }
  }

  /** One-time warning when a block kind that can't hold under back-pressure
   *  drops a piece into a saturated downstream buffer. */
  const lossWarned = new Set<string>();
  function warnLossOnce(b: BlockState): void {
    if (lossWarned.has(b.ws.id)) return;
    lossWarned.add(b.ws.id);
    warnings.push(
      `"${b.ws.name}" (${b.kind}) dropped a piece into a full downstream buffer. v1 back-pressure only blocks on the linear Service/Queue/Delay/Conveyor path; branch/merge blocks drop when saturated. Raise the downstream capacity or insert a Queue.`,
    );
  }

  /**
   * Deliver one agent to the target block's input. Called by route() after
   * a routing decision is made. Encapsulates the per-kind accept logic.
   */
  function accept(
    targetWsId: string,
    targetInPort: string,
    agent: Agent,
    now: number,
  ): void {
    const b = blocks.get(targetWsId);
    if (!b) return;
    // Credit the areas at the PRE-arrival levels. This single call covers
    // every push below (Service, Queue, Batch, Combine/Match/Assembler) and
    // the `inService += 1` in the Delay/MoveTo/Conveyor branch, because all of
    // them mutate after this point at the same `now`.
    advanceAreas(b, now);
    b.inflow += 1;
    b.inflowPieces += agent.pieces;
    switch (b.kind) {
      case 'Sink':
        emitFlow('sink', agent, b.ws.id);
        totalProduced += agent.pieces;
        if ((agent.reworkCount ?? 0) === 0) piecesProducedFTR += agent.pieces;
        leadTimeAccum += (now - agent.bornAt) * agent.pieces;
        return;
      case 'Source':
      case 'ResourcePool':
        // Sources have no inputs; ResourcePools are referenced, not flowed.
        return;
      case 'Queue':
        // Push semantics — downstream blocks have internal buffers, so
        // forward immediately. Back-pressure (queueCapacity) lands in a
        // future turn.
        agent.queuedAt = now;
        agent.enteredBlockAt = now;
        b.queue.push(agent);
        drainQueue(b, now);
        return;
      case 'Service':
        agent.queuedAt = now;
        agent.enteredBlockAt = now;
        b.queue.push(agent);
        tryStartService(b, now);
        return;
      case 'SelectOutput':
      case 'SelectOutput5': {
        const goesPass = rng() < b.passProb;
        const portId = goesPass ? 'pass' : 'fail';
        if (b.kind === 'SelectOutput5') {
          const spec = getBlockSpec(b.ws);
          const pid = goesPass ? spec.outputs[0]?.id : spec.outputs[spec.outputs.length - 1]?.id;
          emitOnPort(b, pid ?? portId, agent, now);
          return;
        }
        emitOnPort(b, portId, agent, now);
        return;
      }
      case 'Delay':
      case 'MoveTo':
      case 'Conveyor': {
        // Time-based pass-through — hold the agent for one cycle, then
        // forward. No resource binding (use Service if you need one).
        // A Delay has no queue, so the agent's wait is zero — credit the
        // denominator anyway so Ŵq stays a well-defined mean over arrivals
        // rather than dividing by a count that skipped these blocks.
        agent.enteredBlockAt = now;
        b.waitStarts += 1;
        b.inService += 1;
        const cycle = drawCycle(b);
        agent.cycleMin = cycle;
        inFlightAgents.set(agent.id, agent);
        pq.push({ time: now + cycle, kind: 'serviceEnd', wsId: b.ws.id, agentId: agent.id });
        return;
      }
      case 'Hold':
        // v1: static — agent passes straight through. Hold acts as a
        // pass-through marker; turn-3 polish will add a real on/off
        // toggle that buffers agents while closed.
        emitOnFirstOutput(b, agent, now);
        return;
      case 'Batch': {
        // Accumulate until we hit batchSize, then emit one batched agent
        // whose pieces = sum of input pieces. The batched agent inherits
        // the bornAt of the OLDEST collected piece so lead-time remains
        // sensible at the Sink.
        agent.queuedAt = now;
        agent.enteredBlockAt = now;
        b.queue.push(agent);
        if (b.queue.length >= b.batchSize) {
          const totalPieces = b.queue.reduce((s, a) => s + a.pieces, 0);
          const oldestBornAt = b.queue[0].bornAt;
          // A batch is as urgent as its most urgent member — batching a rush
          // bundle in with routine ones must not quietly demote it.
          const topPriority = b.queue.reduce((m, a) => Math.min(m, a.priority), b.queue[0].priority);
          b.queue.length = 0;
          const bundle: Agent = {
            id: nextAgentId++,
            bornAt: oldestBornAt,
            pieces: totalPieces,
            priority: topPriority,
          };
          emitOnFirstOutput(b, bundle, now);
        }
        return;
      }
      case 'Unbatch': {
        // Explode a multi-piece agent into individual single-piece agents.
        // No-op when pieces === 1 (just forwards as-is). Hard-capped at
        // UNBATCH_MAX_PIECES to keep a misconfigured Source × Combine ×
        // Unbatch chain from blowing up the event loop.
        if (agent.pieces <= 1) {
          emitOnFirstOutput(b, agent, now);
          return;
        }
        if (agent.pieces > UNBATCH_MAX_PIECES) {
          if (!hitUnbatchCap) {
            warnings.push(
              `Unbatch "${b.ws.name}" received ${agent.pieces} pieces (> ${UNBATCH_MAX_PIECES}) — emitting as a single agent to avoid runaway agent counts. Reduce upstream Source piecesPerAgent or Batch size.`,
            );
            hitUnbatchCap = true;
          }
          emitOnFirstOutput(b, agent, now);
          return;
        }
        for (let i = 0; i < agent.pieces; i++) {
          const piece: Agent = {
            id: nextAgentId++,
            bornAt: agent.bornAt,
            pieces: 1,
            priority: agent.priority,
          };
          emitOnFirstOutput(b, piece, now);
        }
        return;
      }
      case 'Combine':
      case 'Assembler': {
        // Multi-input synchronization. Buffer the agent on its arrival
        // port, then fire only when every input port has at least one
        // queued agent. Combine: 2 inputs → 1 merged agent. Assembler:
        // N inputs → 1 merged agent (sums pieces). Implicit recipe in
        // v1 is "one agent on every input port".
        agent.queuedAt = now;
        agent.enteredBlockAt = now;
        const list = b.queueByInputPort.get(targetInPort) ?? [];
        list.push(agent);
        b.queueByInputPort.set(targetInPort, list);
        tryFireSync(b, now, /*emitMerged*/ true);
        return;
      }
      case 'Match': {
        // Like Combine but emits each agent on its own paired output
        // (pass-through pairing — Match's purpose is synchronization,
        // not merging). With ports `in1`/`in2` → `out1`/`out2`.
        agent.queuedAt = now;
        agent.enteredBlockAt = now;
        const list = b.queueByInputPort.get(targetInPort) ?? [];
        list.push(agent);
        b.queueByInputPort.set(targetInPort, list);
        tryFireSync(b, now, /*emitMerged*/ false);
        return;
      }
      case 'Split': {
        // Duplicate the agent on every output port (`orig` + `copy`).
        // Pieces are duplicated, NOT split — Split is logical fan-out,
        // not physical division. (Use Unbatch for physical division.)
        const spec = getBlockSpec(b.ws);
        for (const out of spec.outputs) {
          const dup: Agent = {
            id: nextAgentId++,
            bornAt: agent.bornAt,
            pieces: agent.pieces,
            priority: agent.priority,
          };
          emitOnPort(b, out.id, dup, now);
        }
        return;
      }
      default:
        // Pass-through fallback for kinds we don't model yet.
        emitOnFirstOutput(b, agent, now);
        return;
    }
  }

  /**
   * Fire a multi-input sync block as long as every input port has at
   * least one queued agent. Pops one head from each port per fire.
   *
   *   `emitMerged = true`  — Combine / Assembler: emit ONE agent on the
   *                          first output port whose pieces equal the
   *                          sum of the popped agents. The output
   *                          agent's bornAt is the OLDEST popped bornAt
   *                          so lead-time at the Sink reflects the
   *                          slowest constituent.
   *
   *   `emitMerged = false` — Match: emit each popped agent on the
   *                          correspondingly-positioned output port
   *                          (input[i] → output[i]). Pieces NOT merged.
   */
  function tryFireSync(b: BlockState, now: number, emitMerged: boolean): void {
    const spec = getBlockSpec(b.ws);
    if (spec.inputs.length === 0 || spec.outputs.length === 0) return;
    // While every input port has an agent, pop one from each and fire.
    while (spec.inputs.every((p) => (b.queueByInputPort.get(p.id)?.length ?? 0) > 0)) {
      advanceAreas(b, now);
      const popped: Agent[] = spec.inputs.map(
        (p) => b.queueByInputPort.get(p.id)!.shift()!,
      );
      // Each popped agent's port wait ends here.
      for (const a of popped) {
        b.waitSumMin += Math.max(0, now - (a.queuedAt ?? now));
        b.waitStarts += 1;
        b.sojournSumMin += Math.max(0, now - (a.enteredBlockAt ?? now));
        b.sojournExits += 1;
      }
      if (emitMerged) {
        const totalPieces = popped.reduce((s, a) => s + a.pieces, 0);
        const oldestBornAt = popped.reduce((m, a) => Math.min(m, a.bornAt), popped[0].bornAt);
        const topPriority = popped.reduce((m, a) => Math.min(m, a.priority), popped[0].priority);
        const merged: Agent = {
          id: nextAgentId++,
          bornAt: oldestBornAt,
          pieces: totalPieces,
          priority: topPriority,
        };
        emitOnFirstOutput(b, merged, now);
      } else {
        // Match — emit each on its own paired output port. The library
        // gives Match `out1` / `out2` so the i-th popped goes to the
        // i-th output.
        popped.forEach((a, i) => {
          const portId = spec.outputs[i]?.id ?? spec.outputs[0]?.id;
          if (portId) emitOnPort(b, portId, a, now);
        });
      }
    }
  }

  /**
   * Index of the agent this block serves next, per its queue discipline.
   *
   *  - **FCFS** — the head. The textbook's default and the sewing-floor norm:
   *    the first bundle on the cart is the first one sewn.
   *  - **SIRO** — a uniform pick over everything waiting (Model III). Drawn
   *    from the run's seeded RNG so a replay reproduces exactly.
   *  - **Priority** — the bundle whose order has the lowest `priority` number
   *    (1 = highest), FIFO within a priority class. A rush order jumps the
   *    cart. Agents with no order fall to the back of the ordering.
   *
   * Every discipline is work-conserving and none of them idles a free server,
   * so the long-run means are unchanged — which is precisely the textbook's
   * claim, and what `queueing.ts` relies on when it returns the same L, Lq, W
   * and Wq for Model I and Model III.
   */
  function nextIndex(b: BlockState): number {
    if (b.queue.length <= 1) return 0;
    switch (b.discipline) {
      case 'SIRO':
        return Math.min(
          b.queue.length - 1,
          Math.floor(disciplineRng() * b.queue.length),
        );
      case 'Priority': {
        let best = 0;
        let bestRank = priorityRank(b.queue[0]);
        for (let i = 1; i < b.queue.length; i++) {
          const rank = priorityRank(b.queue[i]);
          // Strictly-less keeps FIFO order inside a priority class.
          if (rank < bestRank) {
            best = i;
            bestRank = rank;
          }
        }
        return best;
      }
      case 'FCFS':
      default:
        return 0;
    }
  }

  /** Lower sorts first — the bundle's own priority class, stamped at spawn
   *  from its Source's `sourcePriority`. */
  function priorityRank(a: Agent): number {
    return a.priority;
  }

  /** Remove and return the next agent under this block's discipline. */
  function dequeue(b: BlockState): Agent | undefined {
    if (b.queue.length === 0) return undefined;
    const idx = nextIndex(b);
    return idx === 0 ? b.queue.shift() : b.queue.splice(idx, 1)[0];
  }

  /** Drain a Queue block — forward head-of-line agents while the downstream
   *  target will accept. Stops when the target's buffer is full (back-pressure);
   *  the remaining agents stay in this Queue's own bounded buffer. Under the
   *  default unbounded buffers `tryForwardFirstOutput` never blocks, so this
   *  forwards everything immediately, exactly as before. */
  function drainQueue(b: BlockState, now: number): void {
    if (b.kind !== 'Queue') return;
    while (b.queue.length > 0) {
      // Under a non-FCFS discipline the agent that leaves next is not
      // necessarily the head, so pick first and then test THAT one against
      // downstream capacity.
      const idx = nextIndex(b);
      if (!tryForwardFirstOutput(b, b.queue[idx], now)) break; // downstream full
      advanceAreas(b, now);
      const moved = b.queue.splice(idx, 1)[0];
      // A Queue block has no servers, so "leaving the queue" IS leaving the
      // block: credit both the wait and the sojourn from the same instant.
      b.waitSumMin += Math.max(0, now - (moved.queuedAt ?? now));
      b.waitStarts += 1;
      b.sojournSumMin += Math.max(0, now - (moved.enteredBlockAt ?? now));
      b.sojournExits += 1;
      // Freed a slot in this Queue — a blocked upstream may now advance.
      notifyFeeders(b, now);
    }
  }

  function emitOnFirstOutput(b: BlockState, agent: Agent, now: number): void {
    const spec = getBlockSpec(b.ws);
    const portId = spec.outputs[0]?.id;
    if (!portId) return;
    emitOnPort(b, portId, agent, now);
  }

  /**
   * Look up rework parameters for the operation bound to a workstation.
   * Returns null when the workstation has no op binding, no garment, or
   * the op carries no reworkRate. Centralises the resolution so the
   * serviceEnd hot-path stays tight.
   */
  function reworkParamsFor(ws: Workstation): {
    rate: number;
    routeToOpId: string | undefined;
    maxAttempts: number;
  } | null {
    const opId = ws.operation?.opId;
    const garmentId = ws.operation?.garmentId;
    if (!opId || !garmentId) return null;
    const garment = GARMENT_TEMPLATES[garmentId];
    if (!garment) return null;
    const op = garment.operations.find((o) => o.id === opId);
    if (!op || !(op.reworkRate && op.reworkRate > 0)) return null;
    return {
      rate: Math.min(1, Math.max(0, op.reworkRate)),
      routeToOpId: op.reworkRouteToOpId,
      maxAttempts: Math.max(1, op.maxReworkAttempts ?? 1),
    };
  }

  /**
   * Find the workstation in the same line as `fromWs` whose bound op id
   * matches `opId`. Used to resolve a rework loop's re-entry point.
   * Falls back to any workstation in the twin with that op id if the
   * line-scoped lookup misses.
   */
  function findReworkTarget(fromWs: Workstation, opId: string): Workstation | null {
    const lineId = fromWs.lineId;
    let lineMatch: Workstation | null = null;
    let anyMatch: Workstation | null = null;
    for (const ws of twin.workstations) {
      if (ws.operation?.opId === opId) {
        if (ws.lineId === lineId) lineMatch = ws;
        else if (!anyMatch) anyMatch = ws;
      }
    }
    return lineMatch ?? anyMatch;
  }

  /**
   * Decide whether a service-completed agent should be sent back upstream
   * for rework. Returns true when the agent was consumed (scrapped or
   * routed to rework); the caller must NOT forward it to the next op in
   * that case. Returns false when the agent should follow the normal
   * forward path.
   */
  function maybeRework(b: BlockState, agent: Agent, now: number): boolean {
    const params = reworkParamsFor(b.ws);
    if (!params) return false;
    if (rng() >= params.rate) return false;
    const attempts = (agent.reworkCount ?? 0) + 1;
    if (attempts > params.maxAttempts) {
      // Scrap — the piece is consumed without ever reaching a Sink.
      piecesScrapped += agent.pieces;
      return true;
    }
    agent.reworkCount = attempts;
    // Find the rework re-entry point. Default to in-place rework when
    // the op didn't pin a route — re-queues onto this same Service block.
    const routeToOpId = params.routeToOpId;
    if (!routeToOpId) {
      advanceAreas(b, now);
      agent.queuedAt = now;
      agent.enteredBlockAt = now;
      b.queue.push(agent);
      tryStartService(b, now);
      return true;
    }
    const target = findReworkTarget(b.ws, routeToOpId);
    if (!target) {
      // Configured route missing — fall back to in-place rework rather
      // than silently scrapping. Warn once so the user can fix the bulletin.
      if (!warnedReworkMissing.has(routeToOpId)) {
        warnings.push(
          `Rework route for op "${routeToOpId}" not found in twin — looping in-place at "${b.ws.name}".`,
        );
        warnedReworkMissing.add(routeToOpId);
      }
      advanceAreas(b, now);
      agent.queuedAt = now;
      agent.enteredBlockAt = now;
      b.queue.push(agent);
      tryStartService(b, now);
      return true;
    }
    accept(target.id, '__rework__', agent, now);
    return true;
  }

  const warnedReworkMissing = new Set<string>();

  function emitOnPort(b: BlockState, portId: string, agent: Agent, now: number): void {
    b.outflowByPort.set(portId, (b.outflowByPort.get(portId) ?? 0) + 1);
    b.outflowPieces += agent.pieces;
    const targets = routing.get(b.ws.id)?.outputs.get(portId) ?? [];
    if (targets.length === 0) return; // dangling output — silently drop
    for (const t of targets) {
      // Non-holding emit: this block kind can't exert back-pressure, so a
      // saturated finite downstream buffer means the piece is DROPPED (and
      // counted). Under the default unbounded buffers `canAcceptAt` is always
      // true, so this is exactly the old push behaviour.
      if (!canAcceptAt(t.targetWsId)) {
        piecesLost += agent.pieces;
        recordBalk(t.targetWsId, agent.pieces);
        warnLossOnce(b);
        continue;
      }
      // One edge traversal per target. Emitted BEFORE accept so a fan-out
      // (Split) or a merge (Combine) shows each constituent hop; the arriving
      // agent's id is the one that just left `b` — new ids minted inside
      // accept get their own moves when they in turn emit.
      emitFlow('move', agent, t.targetWsId, b.ws.id);
      accept(t.targetWsId, t.targetInPort, agent, now);
    }
  }

  /**
   * Forward a completed agent on the block's FIRST output port with
   * blocking-after-service. Returns:
   *   • `true`  — the agent left (delivered, or dropped on a fan-out edge, or
   *               a dangling/absent output). The caller frees the server.
   *   • `false` — the single downstream target's buffer is full; the caller
   *               must HOLD the agent (block) and keep the server occupied.
   * Only the single-target case can block — fan-out falls back to the
   * non-holding drop-on-full path (a documented v1 limitation).
   */
  function tryForwardFirstOutput(b: BlockState, agent: Agent, now: number): boolean {
    const spec = getBlockSpec(b.ws);
    const portId = spec.outputs[0]?.id;
    if (!portId) return true; // no output — agent leaves (nothing to count)
    const targets = routing.get(b.ws.id)?.outputs.get(portId) ?? [];
    // Single downstream that's full → block (nothing counted; agent stays).
    if (targets.length === 1 && !canAcceptAt(targets[0].targetWsId)) return false;
    // Committed to emit.
    b.outflowByPort.set(portId, (b.outflowByPort.get(portId) ?? 0) + 1);
    b.outflowPieces += agent.pieces;
    if (targets.length === 0) return true; // dangling
    for (const t of targets) {
      if (!canAcceptAt(t.targetWsId)) {
        piecesLost += agent.pieces;
        recordBalk(t.targetWsId, agent.pieces);
        warnLossOnce(b);
        continue;
      }
      emitFlow('move', agent, t.targetWsId, b.ws.id);
      accept(t.targetWsId, t.targetInPort, agent, now);
    }
    return true;
  }

  /**
   * The single downstream target that is currently full, or null when the
   * Source can emit. The Source then reschedules its next tick without
   * emitting or advancing its order state (back-pressure instead of dropping
   * WIP).
   *
   * Returning the id rather than a boolean is what lets the caller credit a
   * BALK against that target. A non-null result at an arrival epoch is exactly
   * the textbook event "an arrival found the system full and was turned away":
   * under exponential inter-arrivals, retrying at the next drawn gap is
   * memoryless, so the ADMITTED process is identical to classical balking —
   * only the bookkeeping was missing.
   */
  function blockedSourceTarget(src: BlockState): string | null {
    const spec = getBlockSpec(src.ws);
    const portId = spec.outputs[0]?.id;
    if (!portId) return null;
    const targets = routing.get(src.ws.id)?.outputs.get(portId) ?? [];
    if (targets.length !== 1) return null; // fan-out / no target — don't stall
    return canAcceptAt(targets[0].targetWsId) ? null : targets[0].targetWsId;
  }

  /** Re-attempt the forward a block was blocked on (fired by a retryForward
   *  event once a downstream freed a slot). */
  function retryForward(b: BlockState, now: number): void {
    if (b.kind === 'Queue') {
      drainQueue(b, now);
      return;
    }
    // Service / Delay / MoveTo / Conveyor holders: flush blocked agents FIFO.
    let freed = false;
    while (b.blocked.length > 0) {
      if (!tryForwardFirstOutput(b, b.blocked[0], now)) break;
      advanceAreas(b, now);
      const moved = b.blocked.shift()!;
      b.sojournSumMin += Math.max(0, now - (moved.enteredBlockAt ?? now));
      b.sojournExits += 1;
      emitFlow('unblock', moved, b.ws.id);
      freeServer(b, now);
      freed = true;
    }
    if (b.blocked.length === 0) endBlockInterval(b, now);
    if (freed) {
      if (b.kind === 'Service') {
        // Freed server(s) can now pull waiting agents into service.
        while (tryStartService(b, now)) {
          /* fill every freed slot */
        }
      }
    }
  }

  // ── Event loop ─────────────────────────────────────────────────────────────
  let now = 0;
  const safety = 1_000_000;
  let stepCount = 0;
  while (!pq.isEmpty()) {
    const e = pq.peek()!;
    if (e.time > durationMin) break;
    pq.pop();
    now = e.time;
    if (++stepCount > safety) {
      warnings.push('Sim aborted at safety limit (1M events) — likely infinite loop in routing.');
      break;
    }
    if (nextAgentId > MAX_AGENTS_PER_RUN) {
      if (!hitAgentCap) {
        warnings.push(
          `Sim aborted: created ${MAX_AGENTS_PER_RUN.toLocaleString()} agents. Likely a Source piecesPerAgent × Unbatch × Split combination is exploding agent counts — drop a Batch upstream or reduce piecesPerAgent.`,
        );
        hitAgentCap = true;
      }
      break;
    }

    if (e.kind === 'sample') {
      takeSample(now);
      continue;
    }

    if (e.kind === 'warmupReset') {
      // Discard the transient. The event calendar and the agent population are
      // untouched — only the ACCOUNTING restarts, so the queues the run has
      // built up so far stay in place and steady state is not re-approached.
      for (const b of blocks.values()) {
        advanceAreas(b, now);
        b.areaLq = 0;
        b.areaL = 0;
        b.areaBusyServers = 0;
        b.areaBlockedServers = 0;
        b.balked = 0;
        b.balkedPieces = 0;
        b.waitSumMin = 0;
        b.waitStarts = 0;
        b.sojournSumMin = 0;
        b.sojournExits = 0;
        b.blockedMin = 0;
        if (b.blockedSince !== null) b.blockedSince = now;
        b.warmupAt = now;
        b.warmupInflow = b.inflow;
        b.warmupOutflowPieces = b.kind === 'Sink' ? b.inflowPieces : b.outflowPieces;
      }
      continue;
    }

    if (e.kind === 'sourceTick') {
      const src = blocks.get(e.wsId);
      if (!src) continue;

      // P2 back-pressure: reschedule without emitting when the downstream
      // entry buffer is full (unbounded default ⇒ never blocks).
      const fullTarget = blockedSourceTarget(src);
      if (fullTarget) {
        recordBalk(fullTarget, src.piecesPerAgent);
        pq.push({ time: now + drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
        continue;
      }
      const pieces = src.piecesPerAgent;
      const agent: Agent = {
        id: nextAgentId++,
        bornAt: now,
        pieces,
        priority: src.sourcePriority,
      };
      emitFlow('spawn', agent, src.ws.id);
      emitOnPort(src, 'out', agent, now);
      pq.push({ time: now + drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
      continue;
    }

    if (e.kind === 'serviceEnd') {
      const b = blocks.get(e.wsId);
      if (!b) continue;
      const isTimeBlock =
        b.kind === 'Service' ||
        b.kind === 'Delay' ||
        b.kind === 'MoveTo' ||
        b.kind === 'Conveyor';
      if (!isTimeBlock) continue; // defensive — only time-based blocks schedule serviceEnd
      const a = inFlightAgents.get(e.agentId);
      inFlightAgents.delete(e.agentId);
      // Credit the SAMPLED cycle (stashed on the agent) when stochastic, the
      // deterministic `b.cycleMin` otherwise. `busyMin` is PRODUCTIVE service
      // only — any subsequent blocking time is tracked separately in blockedMin.
      const elapsed = a?.cycleMin ?? b.cycleMin;
      b.busyMin += elapsed;
      if (a) emitFlow('endService', a, b.ws.id);
      // Rotation pointer hops on each Service completion (canvas overlay only).
      if (b.kind === 'Service') advanceRotation(b);

      // P2 rework (Service only): a fraction of completed pieces routes back
      // upstream / scraps instead of forwarding. Rework is EXEMPT from finite
      // buffers (it re-queues via `accept` directly) to avoid rework-induced
      // deadlock — a documented v1 simplification. maybeRework consumes the
      // agent when it returns true.
      if (b.kind === 'Service' && a && maybeRework(b, a, now)) {
        freeServer(b, now);
        tryStartService(b, now);
        continue;
      }

      if (!a) {
        freeServer(b, now);
        tryStartService(b, now);
        continue;
      }

      // Blocking-after-service: try to advance the finished piece. If the
      // single downstream buffer is full, HOLD it — the server stays occupied
      // (counted in inService) so no new service starts here until a
      // retryForward clears the block.
      if (tryForwardFirstOutput(b, a, now)) {
        b.sojournSumMin += Math.max(0, now - (a.enteredBlockAt ?? now));
        b.sojournExits += 1;
        freeServer(b, now);
        tryStartService(b, now);
      } else {
        // Becoming blocked moves a server from PRODUCTIVE to BLOCKED, and the
        // two areas are tracked separately — credit the pre-transition split
        // before the push.
        advanceAreas(b, now);
        b.blocked.push(a);
        if (b.blockedSince === null) b.blockedSince = now;
        emitFlow('block', a, b.ws.id);
      }
      continue;
    }

    if (e.kind === 'retryForward') {
      retryScheduled.delete(e.wsId);
      const b = blocks.get(e.wsId);
      if (!b) continue;
      retryForward(b, now);
      continue;
    }

    if (e.kind === 'poolRelease') {
      poolRetryScheduled.delete(e.poolKey);
      const pool = operatorPools.get(e.poolKey);
      if (!pool) continue;
      wakePool(pool, now);
      continue;
    }

  }

  // ── Final pool-utilisation flush ──────────────────────────────────────────
  for (const pool of operatorPools.values()) {
    bumpPoolAccum(pool, durationMin);
  }

  // ── Close any still-open blocking intervals at end-of-run ──────────────────
  // Flush the time-integrals to the shift bell first, so the final span
  // between the last event and `durationMin` is credited.
  for (const b of blocks.values()) {
    advanceAreas(b, durationMin);
    endBlockInterval(b, durationMin);
  }

  // ── Build per-block observed metrics ──────────────────────────────────────
  const blockObs = new Map<string, BlockObserved>();
  let bottleneckWsId: string | null = null;
  let bottleneckQ = 0;
  for (const b of blocks.values()) {
    const portQueueTotal = [...b.queueByInputPort.values()].reduce((s, q) => s + q.length, 0);
    const finalQ = b.queue.length + b.inService + portQueueTotal;
    if (finalQ > bottleneckQ) {
      bottleneckQ = finalQ;
      bottleneckWsId = b.ws.id;
    }
    // Sinks have no output ports — report inflow as throughput instead so
    // the canvas badge shows a meaningful number. Throughput is tracked
    // in PIECES (not agents) so Batch / Unbatch read sensibly: pieces
    // are conserved across the chain even when agent counts collapse
    // (Batch) or expand (Unbatch).
    const totalOut = b.kind === 'Sink' ? b.inflowPieces : b.outflowPieces;
    // The observation window: post-warm-up when truncation was requested,
    // otherwise the whole run.
    const observedMin = Math.max(1e-9, durationMin - b.warmupAt);
    const observedOut = totalOut - b.warmupOutflowPieces;
    const arrivals = b.inflow - b.warmupInflow;
    const offered = arrivals + b.balked;

    let resourceBusy = 0;
    let poolUtilization = 0;
    if (b.kind === 'Service') {
      resourceBusy = b.busyMin;
      const pool = operatorPools.get(poolKeyFor(b.ws));
      poolUtilization =
        pool && pool.capacity > 0
          ? Math.min(1, resourceBusy / (pool.capacity * observedMin))
          : 0;
    }
    // ρ̂ for THIS station: productive server-minutes over available
    // server-minutes. Previously this divided by the department-wide pool
    // capacity, so a station busy 400/480 min on a 20-operator line reported
    // 4.2 % instead of 83 % — and that number is what gets persisted onto the
    // workstation as `kpiObserved.utilizationPct`.
    const utilization =
      b.servers > 0 ? Math.min(1, b.areaBusyServers / (b.servers * observedMin)) : 0;

    blockObs.set(b.ws.id, {
      wsId: b.ws.id,
      kind: b.kind,
      produced: totalOut,
      finalQueueLen: finalQ,
      busyMin: b.busyMin,
      resourceBusyUnitMin: resourceBusy,
      perPortOut: Object.fromEntries(b.outflowByPort),
      throughputPerHr: observedMin > 0 ? (observedOut * 60) / observedMin : 0,
      utilization,
      poolUtilization,
      bottleneck: false,
      blockedMin: b.blockedMin,
      // ── P5 measured queueing observables ──────────────────────────────────
      observedMin,
      serversTotal: b.servers,
      systemCapacity: b.sysCapacity,
      arrivals,
      balked: b.balked,
      lambdaOfferedPerHr: (offered * 60) / observedMin,
      lambdaEffPerHr: (arrivals * 60) / observedMin,
      LqObserved: b.areaLq / observedMin,
      LObserved: b.areaL / observedMin,
      WqObservedMin: b.waitStarts > 0 ? b.waitSumMin / b.waitStarts : 0,
      areaLq: b.areaLq,
      areaL: b.areaL,
      areaBusy: b.areaBusyServers,
      areaBlocked: b.areaBlockedServers,
    });
  }
  if (bottleneckWsId) {
    const obs = blockObs.get(bottleneckWsId);
    if (obs) obs.bottleneck = true;
  }

  // Lead time is piece-weighted (we summed `(now - bornAt) * pieces`),
  // so divide by total pieces to recover a piece-mean lead time.
  // Final snapshot at end-of-run so the timeline always reaches durationMin
  // even when the last scheduled `sample` event sat slightly past the end.
  if (samplePeriodMin > 0) {
    const lastT = samples[samples.length - 1]?.time ?? -1;
    if (lastT < durationMin) takeSample(durationMin);
  }

  // OEE-quality denominator = pieces that *finished* a path (good + scrap).
  // FTR-quality = first-pass-good ÷ finished. 1.0 when nothing finished
  // (avoids divide-by-zero on idle runs).
  const finishedPieces = totalProduced + piecesScrapped;
  const firstPassYield = finishedPieces > 0 ? piecesProducedFTR / finishedPieces : 1;


  return {
    durationMin,
    totalProduced,
    piecesProducedFTR,
    piecesScrapped,
    piecesLost,
    firstPassYield,
    meanLeadTimeMin: totalProduced > 0 ? leadTimeAccum / totalProduced : 0,
    throughputPerHr: durationMin > 0 ? (totalProduced * 60) / durationMin : 0,
    blocks: blockObs,
    bottleneckWsId,
    warnings,
    samples,
    flow: flowEvents,
  };
}
