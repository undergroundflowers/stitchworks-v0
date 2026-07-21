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

import type { Twin, Workstation, Order } from '../domain/twin';
import {
  getBlockSpec,
  getBlockParams,
  type PmlBlockKind,
} from '../domain/pml';
import { GARMENT_TEMPLATES } from '../domain';
import { PRODUCTION_SYSTEMS } from '../domain/routings';
import { changeoverDurationMin } from '../domain/changeover';
import { MinHeap, mulberry32 } from './priority-queue';
import { sample as sampleDist, type ServiceDist } from './distributions';

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

  // Service ↔ ResourcePool dept binding (implicit v1)
  const deptHasPool = new Set<string>();
  for (const ws of blockByKind.get('ResourcePool') ?? []) deptHasPool.add(ws.deptId);
  for (const ws of blockByKind.get('Service') ?? []) {
    if (!deptHasPool.has(ws.deptId)) {
      issues.push({
        level: 'warn',
        wsId: ws.id,
        message: `Service "${ws.name}" has no ResourcePool in its department — it will run without a resource constraint (effectively infinite capacity).`,
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

/**
 * Changeover injection — schedules a CHANGEOVER_BEGIN / CHANGEOVER_END
 * pair on a specific line. In P2 these are passed manually so the IE can
 * model an interrupted shift; P4 will generate them automatically from
 * an OrderSequence.
 */
export interface ChangeoverSpec {
  /** When the changeover begins, in sim MINUTES from t=0. */
  atMin: number;
  /** SewingLine.id the changeover applies to — all workstations carrying
   *  this lineId are blocked for the duration. */
  lineId: string;
  /** Duration in minutes the line is frozen. The caller is responsible
   *  for computing this from `changeoverDurationMin({ base, from, to })`
   *  (or any other rule); the engine treats it as a black-box freeze. */
  durationMin: number;
}

/**
 * Per-machine breakdown sampling. When set on a machine code, every
 * workstation using that machine samples MTBF / MTTR exponentials and
 * goes offline for the sampled MTTR period whenever a breakdown lands.
 *
 * Both values are in MINUTES. Omitting either disables breakdowns for
 * that machine. Use this to model "the SNL bench at op 3 fails on
 * average every 4 hours and takes 12 min to restart."
 */
export interface MachineBreakdownSpec {
  /** Mean time between failures (minutes). */
  mtbfMin: number;
  /** Mean time to repair (minutes). */
  mttrMin: number;
}

export interface PmlSimOpts {
  twin: Twin;
  /** Simulated duration in MINUTES. Tier-1 default: 480 (= one 8h shift). */
  durationMin: number;
  /** Seed for the RNG. Use the same seed for deterministic comparison. */
  seed: number;
  /** Sampling period in MINUTES — every N sim minutes the engine snapshots
   *  per-block running totals into `result.samples`. Default 1 min.
   *  Set to 0 to disable sampling (saves memory / time). */
  samplePeriodMin?: number;
  /** Manual changeover injections. Each entry freezes the named line for
   *  the stated duration. Omit / empty array ⇒ no changeovers (today's
   *  behaviour). */
  changeovers?: ChangeoverSpec[];
  /** Optional per-machine MTBF / MTTR — keyed by MachineCode (e.g. 'SNL'
   *  → { mtbfMin: 240, mttrMin: 12 }). Sampling is exponential. Empty
   *  / omitted ⇒ no breakdowns. */
  machineBreakdowns?: Record<string, MachineBreakdownSpec>;
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
export interface PmlSimSample {
  /** Sim time in minutes when this snapshot was taken. */
  time: number;
  /** Per-block running totals: keyed by Workstation.id. */
  blocks: Map<
    string,
    {
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
    }
  >;
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
  /** 0..1, busy / capacity-time. Service-only; 0 for non-resource blocks. */
  utilization: number;
  /** True if this block had the longest queue at end-of-run — heuristic
   *  bottleneck detection that callers can refine. */
  bottleneck: boolean;
  /** P2 — cumulative minutes this block spent BLOCKED: service finished but
   *  the completed piece couldn't advance because the downstream buffer was
   *  full. 0 under unbounded buffers (the default). A high value flags a
   *  downstream bottleneck starving this station of somewhere to put its
   *  output — distinct from `utilization`, which counts productive service. */
  blockedMin: number;
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
  /** Cumulative minutes lost to changeover events during the run. P2 default 0. */
  changeoverMin: number;
  /** Cumulative minutes lost to machine downtime (MTBF/MTTR) during the run. P2 default 0. */
  downtimeMin: number;
  /** Per-order completion time keyed by Order.id (minutes from the first
   *  piece emitted by the Source to the last piece reaching the Sink).
   *  Populated when a Source ran an OrderSequence. Empty otherwise. */
  perOrderCompletionTime: Record<string, number>;
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
  /** Order id this piece belongs to — populated when the Source is
   *  running an OrderSequence. Lets the Sink credit completion times
   *  per order. Undefined for legacy single-garment Sources. */
  orderId?: string;
}

/** All the precomputed routing for a block — output port → list of next
 *  (block, input port) tuples. A typical block has one output going to
 *  one downstream input; SelectOutput has two. */
interface Routing {
  /** Map<outputPortId, [{ targetWsId, targetInPort }]> */
  outputs: Map<string, { targetWsId: string; targetInPort: string }[]>;
}

/** Resource pool for a department — sum of capacities of every block of
 *  kind 'ResourcePool' inside that dept. Service blocks Seize/Release
 *  against this pool implicitly. */
interface DeptPool {
  deptId: string;
  capacity: number;
  /** Currently-busy units. */
  busy: number;
  /** Cumulative busy-unit-minutes for utilization calc. */
  cumBusyUnitMin: number;
  lastChangeAt: number;
}

/** Engine event types — coarse-grained, just enough for Tier-1 coverage. */
type Event =
  | { time: number; kind: 'sourceTick'; wsId: string }
  | { time: number; kind: 'serviceEnd'; wsId: string; agentId: number }
  | { time: number; kind: 'changeoverBegin'; lineId: string; durationMin: number }
  | { time: number; kind: 'changeoverEnd'; lineId: string }
  | { time: number; kind: 'breakdownBegin'; wsId: string }
  | { time: number; kind: 'breakdownEnd'; wsId: string; mtbfMin: number; mttrMin: number }
  // P2 — a downstream buffer freed a slot; re-attempt the forward that a
  // blocked holder (Service/Delay/Conveyor) or a stalled Queue was waiting on.
  // Zero-delay (fires at the same sim time) so back-pressure relief cascades
  // upstream without recursion. De-duplicated via `retryScheduled`.
  | { time: number; kind: 'retryForward'; wsId: string }
  | { time: number; kind: 'sample' };

/** Per-block runtime state. */
interface BlockState {
  ws: Workstation;
  kind: PmlBlockKind;
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
  /** Source-only: position in the bound line's `orderSequence`. -1 ⇒ no
   *  sequence (legacy infinite Source). */
  orderSeqIndex: number;
  /** Source-only: pieces emitted for the *current* order. Resets to 0
   *  whenever orderSeqIndex advances. */
  orderEmittedSoFar: number;
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
function cycleDistFor(ws: Workstation): ServiceDist | undefined {
  return getBlockParams(ws).cycleDist;
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
function resolveOpQueueCapacity(ws: Workstation): number | null {
  const opId = ws.operation?.opId;
  const garmentId = ws.operation?.garmentId;
  if (!opId || !garmentId) return null;
  const garment = GARMENT_TEMPLATES[garmentId];
  if (!garment) return null;
  const op = garment.operations.find((o) => o.id === opId);
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
function systemCapacityFor(ws: Workstation): number {
  const blockCap = getBlockParams(ws).queueCapacity; // 0 = unbounded
  if (blockCap > 0) return blockCap;
  const opCap = resolveOpQueueCapacity(ws);
  if (opCap != null) return opCap;
  return Infinity;
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
      cycleDist: cycleDistFor(ws),
      arrivalIntervalMin: arrivalIntervalFor(ws),
      arrivalDist: arrivalDistFor(ws),
      passProb: passProbFor(ws),
      batchSize: batchSizeFor(ws),
      servers: Math.max(1, Math.round(getBlockParams(ws).servers)),
      piecesPerAgent: Math.max(1, Math.round(getBlockParams(ws).piecesPerAgent)),
      // P4 — order sequence tracking is enabled at engine-init time below,
      // once we know which lines have a non-empty orderSequence.
      orderSeqIndex: -1,
      orderEmittedSoFar: 0,
      // P2 — finite-buffer state. Unbounded by default → identical to the
      // pre-P2 push-semantics engine.
      sysCapacity: systemCapacityFor(ws),
      blocked: [],
      blockedMin: 0,
      blockedSince: null,
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

  // ── Build dept resource pools (implicit binding for v1) ───────────────────
  const deptPools = new Map<string, DeptPool>();
  for (const ws of twin.workstations) {
    const kind = getBlockSpec(ws).kind;
    if (kind !== 'ResourcePool') continue;
    const dept = ws.deptId;
    const pool = deptPools.get(dept) ?? {
      deptId: dept,
      capacity: 0,
      busy: 0,
      cumBusyUnitMin: 0,
      lastChangeAt: 0,
    };
    pool.capacity += poolUnitsFor(ws);
    deptPools.set(dept, pool);
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
  // P2 — line-blocking accumulators. Updated when CHANGEOVER_BEGIN /
  // CHANGEOVER_END / BREAKDOWN_BEGIN / BREAKDOWN_END events fire.
  let changeoverMinAccum = 0;
  let downtimeMinAccum = 0;
  /** Lines currently frozen for changeover — tryStartService refuses to
   *  start new service for workstations whose lineId is in this set. */
  const frozenLines = new Set<string>();
  /** Workstations currently down for repair — tryStartService refuses
   *  service while the ws id is in this set. */
  const frozenWorkstations = new Set<string>();

  // ── P4 order-sequence state ──────────────────────────────────────────────
  /** Per-order completion tracking. Populated as agents flow through:
   *  firstEmittedAt = first sourceTick that emitted a piece for this order;
   *  lastSunkAt     = last sim time a piece of this order reached a Sink. */
  const orderStats = new Map<
    string,
    { firstEmittedAt: number; lastSunkAt: number; sunkPieces: number }
  >();
  /** Order id → Order record, indexed once for hot-path lookup. */
  const orderById = new Map<string, Order>();
  for (const o of twin.orders ?? []) orderById.set(o.id, o);
  /** Line id → orderSequence (ids), copied so we don't read the twin in
   *  the hot path. */
  const lineOrderSeq = new Map<string, string[]>();
  for (const line of twin.lines ?? []) {
    if (line.orderSequence && line.orderSequence.length > 0) {
      lineOrderSeq.set(line.id, [...line.orderSequence]);
    }
  }
  /** Line id → production-system base changeoverMin, used for the dynamic
   *  CHANGEOVER_BEGIN events the Source raises between orders. */
  const lineChangeoverBase = new Map<string, number>();
  for (const line of twin.lines ?? []) {
    const sys = PRODUCTION_SYSTEMS[line.productionSystem];
    lineChangeoverBase.set(line.id, sys?.changeoverMin ?? 30);
  }
  // Tag each Source whose line has a non-empty orderSequence so its
  // sourceTick handler enters the order-aware path instead of the
  // legacy infinite-stream path.
  for (const src of sources) {
    const lineId = src.ws.lineId;
    if (lineId && (lineOrderSeq.get(lineId)?.length ?? 0) > 0) {
      src.orderSeqIndex = 0;
      src.orderEmittedSoFar = 0;
    }
  }

  // ── Event queue ────────────────────────────────────────────────────────────
  const pq = new MinHeap<Event>((a, b) => a.time - b.time);

  // Schedule first arrival at every Source. When the Source has an
  // `arrivalDist` set (e.g. exponential), draw the first gap from it so
  // the run isn't biased by a deterministic warm-up. This matches AnyLogic's
  // default behaviour for a stochastic Source.
  for (const src of sources) {
    pq.push({ time: drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
  }

  // P2: enqueue caller-supplied changeover injections. Each one freezes the
  // named line for `durationMin` starting at `atMin`. Out-of-range / null
  // entries are dropped silently.
  for (const co of opts.changeovers ?? []) {
    if (!(co.durationMin > 0) || !(co.atMin >= 0) || co.atMin > durationMin) continue;
    pq.push({
      time: co.atMin,
      kind: 'changeoverBegin',
      lineId: co.lineId,
      durationMin: co.durationMin,
    });
  }

  // P2: schedule first breakdown for every workstation that maps to a
  // machine code with an MTBF/MTTR entry. Exponential sampling matches the
  // typical OEE assumption (memoryless failures); the BREAKDOWN_END
  // handler reschedules the next BREAKDOWN_BEGIN, so this only seeds one
  // event per workstation.
  const breakdownByMachine = opts.machineBreakdowns ?? {};
  /** Resolve the apparel `MachineCode` for a workstation by looking up the
   *  bound op in its garment bulletin. Returns null when the workstation
   *  isn't bound to an op (e.g. Source / Sink / buffer). */
  const machineCodeFor = (ws: Workstation): string | null => {
    const opId = ws.operation?.opId;
    const garmentId = ws.operation?.garmentId;
    if (!opId || !garmentId) return null;
    const garment = GARMENT_TEMPLATES[garmentId];
    if (!garment) return null;
    const op = garment.operations.find((o) => o.id === opId);
    return op?.machineCode ?? null;
  };
  if (Object.keys(breakdownByMachine).length > 0) {
    for (const ws of twin.workstations) {
      const code = machineCodeFor(ws);
      if (!code) continue;
      const spec = breakdownByMachine[code];
      if (!spec || !(spec.mtbfMin > 0) || !(spec.mttrMin > 0)) continue;
      // Exponential draw with mean = mtbf, using the engine's RNG so seeds
      // remain reproducible.
      const u = Math.max(1e-9, rng());
      const firstFailAt = -Math.log(u) * spec.mtbfMin;
      if (firstFailAt < durationMin) {
        pq.push({ time: firstFailAt, kind: 'breakdownBegin', wsId: ws.id });
      }
    }
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

  /** Capture a frozen snapshot of every block's running totals at sim
   *  time `t`. O(blocks) — cheap, runs once per `samplePeriodMin`.
   *
   *  Computes a live bottleneck (block with the largest queue at this
   *  instant) and a running piece-mean lead time so LiveSim can show the
   *  same numbers the legacy engine surfaces frame-by-frame. */
  function takeSample(t: number): void {
    const m = new Map<
      string,
      {
        producedPieces: number;
        queueLen: number;
        inService: number;
        busy: number;
        serversTotal: number;
      }
    >();
    let liveBottleneckWsId: string | null = null;
    let liveBottleneckQ = 0;
    for (const b of blocks.values()) {
      const portQ = [...b.queueByInputPort.values()].reduce((s, q) => s + q.length, 0);
      const queueLen = b.queue.length + portQ;
      if (queueLen > liveBottleneckQ) {
        liveBottleneckQ = queueLen;
        liveBottleneckWsId = b.ws.id;
      }
      // Sinks have no output ports — their "produced" is what flowed IN.
      m.set(b.ws.id, {
        producedPieces: b.kind === 'Sink' ? b.inflowPieces : b.outflowPieces,
        queueLen,
        inService: b.inService,
        // `busy` mirrors `inService` — both expose occupied service slots.
        // Kept as separate fields so the legacy-shape adapter can read the
        // legacy field name without an alias map.
        busy: b.inService,
        serversTotal: b.servers,
      });
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

  /** Update a dept-pool's busy-unit-minute accumulator before mutating busy. */
  function bumpPoolAccum(pool: DeptPool, now: number): void {
    pool.cumBusyUnitMin += pool.busy * (now - pool.lastChangeAt);
    pool.lastChangeAt = now;
  }

  /**
   * Try to start service for the next agent waiting on a Service block,
   * if any. Returns true if a service was started. Called whenever (a) a
   * new agent arrives at a Service or (b) a serviceEnd frees a unit.
   */
  function tryStartService(b: BlockState, now: number): boolean {
    if (b.kind !== 'Service') return false;
    if (b.queue.length === 0) return false;
    // P2: don't start service while the workstation is down or its line
    // is in changeover. Pieces already in service complete normally;
    // only new starts are blocked, which matches a real floor (operators
    // finish the current bundle before the changeover begins).
    if (frozenWorkstations.has(b.ws.id)) return false;
    if (b.ws.lineId && frozenLines.has(b.ws.lineId)) return false;
    // Per-station server cap: cannot exceed the configured `servers` count
    // even when the dept's pool has spare units. Matches "one machine =
    // one server" semantics — without this, the pool acts as a shared
    // pool of mobile operators that float between stations.
    if (b.inService >= b.servers) return false;
    // Rotation cells are accounted for via shareFactor (1/cellSize) so
    // long-run KPIs are stable. The visual rotation pointer is advanced
    // separately for the canvas overlay — see `rotationCells` /
    // `advanceRotationPointer` below.
    const pool = deptPools.get(b.ws.deptId);
    if (pool) {
      if (pool.busy >= pool.capacity) return false; // no free unit
      bumpPoolAccum(pool, now);
      pool.busy += 1;
    }
    const a = b.queue.shift()!;
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

  /** Release one occupied server slot (and, for a Service, its dept-pool
   *  unit). The inverse of the seize in `tryStartService`. */
  function freeServer(b: BlockState, now: number): void {
    b.inService = Math.max(0, b.inService - 1);
    if (b.kind === 'Service') {
      const pool = deptPools.get(b.ws.deptId);
      if (pool) {
        bumpPoolAccum(pool, now);
        pool.busy = Math.max(0, pool.busy - 1);
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
    b.inflow += 1;
    b.inflowPieces += agent.pieces;
    switch (b.kind) {
      case 'Sink':
        emitFlow('sink', agent, b.ws.id);
        totalProduced += agent.pieces;
        if ((agent.reworkCount ?? 0) === 0) piecesProducedFTR += agent.pieces;
        leadTimeAccum += (now - agent.bornAt) * agent.pieces;
        // P4 order tracking: credit the order this piece belongs to.
        if (agent.orderId) {
          const stat = orderStats.get(agent.orderId);
          if (stat) {
            stat.sunkPieces += agent.pieces;
            stat.lastSunkAt = now;
          }
        }
        return;
      case 'Source':
      case 'ResourcePool':
        // Sources have no inputs; ResourcePools are referenced, not flowed.
        return;
      case 'Queue':
        // Push semantics — downstream blocks have internal buffers, so
        // forward immediately. Back-pressure (queueCapacity) lands in a
        // future turn.
        b.queue.push(agent);
        drainQueue(b, now);
        return;
      case 'Service':
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
        b.queue.push(agent);
        if (b.queue.length >= b.batchSize) {
          const totalPieces = b.queue.reduce((s, a) => s + a.pieces, 0);
          const oldestBornAt = b.queue[0].bornAt;
          b.queue.length = 0;
          const bundle: Agent = {
            id: nextAgentId++,
            bornAt: oldestBornAt,
            pieces: totalPieces,
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
          const piece: Agent = { id: nextAgentId++, bornAt: agent.bornAt, pieces: 1 };
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
          const dup: Agent = { id: nextAgentId++, bornAt: agent.bornAt, pieces: agent.pieces };
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
      const popped: Agent[] = spec.inputs.map(
        (p) => b.queueByInputPort.get(p.id)!.shift()!,
      );
      if (emitMerged) {
        const totalPieces = popped.reduce((s, a) => s + a.pieces, 0);
        const oldestBornAt = popped.reduce((m, a) => Math.min(m, a.bornAt), popped[0].bornAt);
        const merged: Agent = {
          id: nextAgentId++,
          bornAt: oldestBornAt,
          pieces: totalPieces,
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

  /** Drain a Queue block — forward head-of-line agents while the downstream
   *  target will accept. Stops when the target's buffer is full (back-pressure);
   *  the remaining agents stay in this Queue's own bounded buffer. Under the
   *  default unbounded buffers `tryForwardFirstOutput` never blocks, so this
   *  forwards everything immediately, exactly as before. */
  function drainQueue(b: BlockState, now: number): void {
    if (b.kind !== 'Queue') return;
    while (b.queue.length > 0) {
      if (!tryForwardFirstOutput(b, b.queue[0], now)) break; // downstream full
      b.queue.shift();
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
        warnLossOnce(b);
        continue;
      }
      emitFlow('move', agent, t.targetWsId, b.ws.id);
      accept(t.targetWsId, t.targetInPort, agent, now);
    }
    return true;
  }

  /** True when a Source can't emit because its single downstream target is
   *  full — the Source then reschedules its next tick without emitting or
   *  advancing its order state (back-pressure instead of dropping WIP). */
  function sourceBlocked(src: BlockState): boolean {
    const spec = getBlockSpec(src.ws);
    const portId = spec.outputs[0]?.id;
    if (!portId) return false;
    const targets = routing.get(src.ws.id)?.outputs.get(portId) ?? [];
    if (targets.length !== 1) return false; // fan-out / no target — don't stall
    return !canAcceptAt(targets[0].targetWsId);
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
      const moved = b.blocked.shift()!;
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

    if (e.kind === 'sourceTick') {
      const src = blocks.get(e.wsId);
      if (!src) continue;

      // ── Order-aware path (P4) ──────────────────────────────────────────
      // When the Source's line carries a non-empty orderSequence we emit
      // one order at a time, raise CHANGEOVER_BEGIN between orders whose
      // garment differs, and stop scheduling ticks when the sequence is
      // exhausted. Legacy infinite-source behaviour is preserved by the
      // `orderSeqIndex < 0` branch below.
      if (src.orderSeqIndex >= 0 && src.ws.lineId) {
        const seq = lineOrderSeq.get(src.ws.lineId) ?? [];
        if (src.orderSeqIndex >= seq.length) continue; // sequence done

        const orderId = seq[src.orderSeqIndex];
        const order = orderById.get(orderId);
        if (!order) {
          // Stale id — skip and advance, no rescheduling penalty.
          src.orderSeqIndex += 1;
          src.orderEmittedSoFar = 0;
          pq.push({ time: now + 1e-3, kind: 'sourceTick', wsId: src.ws.id });
          continue;
        }

        // P2 back-pressure: if the line's entry buffer is full, don't emit
        // (and don't advance order state / stamp firstEmittedAt) — retry at
        // the next arrival beat. The WIP waits in staging rather than dropping.
        if (sourceBlocked(src)) {
          pq.push({ time: now + drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
          continue;
        }

        // First-emission timestamp for completion tracking.
        let stat = orderStats.get(orderId);
        if (!stat) {
          stat = { firstEmittedAt: now, lastSunkAt: 0, sunkPieces: 0 };
          orderStats.set(orderId, stat);
        }

        // Emit one bundle (or one piece) tagged with the order id.
        const pieces = Math.min(
          src.piecesPerAgent,
          Math.max(1, order.quantity - src.orderEmittedSoFar),
        );
        const agent: Agent = {
          id: nextAgentId++,
          bornAt: now,
          pieces,
          orderId,
        };
        emitFlow('spawn', agent, src.ws.id);
        emitOnPort(src, 'out', agent, now);
        src.orderEmittedSoFar += pieces;

        // Order satisfied — advance and possibly fire a changeover.
        if (src.orderEmittedSoFar >= order.quantity) {
          src.orderSeqIndex += 1;
          src.orderEmittedSoFar = 0;
          const nextOrderId = seq[src.orderSeqIndex];
          const nextOrder = nextOrderId ? orderById.get(nextOrderId) : undefined;
          if (
            nextOrder &&
            nextOrder.garmentId !== order.garmentId &&
            src.ws.lineId
          ) {
            const base = lineChangeoverBase.get(src.ws.lineId) ?? 30;
            const dur = changeoverDurationMin({
              baseChangeoverMin: base,
              fromGarmentId: order.garmentId,
              toGarmentId: nextOrder.garmentId,
            });
            if (dur > 0) {
              pq.push({
                time: now,
                kind: 'changeoverBegin',
                lineId: src.ws.lineId,
                durationMin: dur,
              });
              // Resume emissions after the changeover completes — staging
              // can still hold pieces but the line is paced by OPRs which
              // are frozen by changeoverBegin.
              pq.push({ time: now + dur, kind: 'sourceTick', wsId: src.ws.id });
              continue;
            }
          }
        }
        // Schedule next tick at the normal arrival cadence.
        pq.push({ time: now + drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
        continue;
      }

      // ── Legacy infinite-source path ───────────────────────────────────
      // P2 back-pressure: reschedule without emitting when the downstream
      // entry buffer is full (unbounded default ⇒ never blocks).
      if (sourceBlocked(src)) {
        pq.push({ time: now + drawArrivalGap(src), kind: 'sourceTick', wsId: src.ws.id });
        continue;
      }
      const pieces = src.piecesPerAgent;
      const agent: Agent = { id: nextAgentId++, bornAt: now, pieces };
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
        freeServer(b, now);
        tryStartService(b, now);
      } else {
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

    // ── P2 changeover events ──────────────────────────────────────────────
    if (e.kind === 'changeoverBegin') {
      frozenLines.add(e.lineId);
      pq.push({
        time: now + e.durationMin,
        kind: 'changeoverEnd',
        lineId: e.lineId,
      });
      // Attribute the wall-clock duration to the changeover accumulator.
      // Multi-line parallel changeovers sum here — call sites can divide
      // by the active-line count when they need a per-line figure.
      changeoverMinAccum += e.durationMin;
      continue;
    }
    if (e.kind === 'changeoverEnd') {
      frozenLines.delete(e.lineId);
      // Unfreezing might let queued agents resume — try to start service at
      // every Service block on the line. Cheap loop; lines are small.
      for (const b of blocks.values()) {
        if (b.kind === 'Service' && b.ws.lineId === e.lineId) {
          tryStartService(b, now);
        }
      }
      continue;
    }

    // ── P2 breakdown events ───────────────────────────────────────────────
    if (e.kind === 'breakdownBegin') {
      const ws = twin.workstations.find((w) => w.id === e.wsId);
      if (!ws) continue;
      const code = machineCodeFor(ws);
      const spec = code ? breakdownByMachine[code] : undefined;
      if (!spec) continue;
      frozenWorkstations.add(e.wsId);
      // Sample MTTR (repair time) from an exponential with mean = mttrMin.
      const u = Math.max(1e-9, rng());
      const repair = -Math.log(u) * spec.mttrMin;
      downtimeMinAccum += repair;
      pq.push({
        time: now + repair,
        kind: 'breakdownEnd',
        wsId: e.wsId,
        mtbfMin: spec.mtbfMin,
        mttrMin: spec.mttrMin,
      });
      continue;
    }
    if (e.kind === 'breakdownEnd') {
      frozenWorkstations.delete(e.wsId);
      // Resume any queued service at this workstation.
      const b = blocks.get(e.wsId);
      if (b && b.kind === 'Service') tryStartService(b, now);
      // Sample next time-to-failure for this workstation.
      const u = Math.max(1e-9, rng());
      const gap = -Math.log(u) * e.mtbfMin;
      const nextFail = now + gap;
      if (nextFail < durationMin) {
        pq.push({ time: nextFail, kind: 'breakdownBegin', wsId: e.wsId });
      }
      continue;
    }
  }

  // ── Final pool-utilisation flush ──────────────────────────────────────────
  for (const pool of deptPools.values()) {
    bumpPoolAccum(pool, durationMin);
  }

  // ── Close any still-open blocking intervals at end-of-run ──────────────────
  for (const b of blocks.values()) endBlockInterval(b, durationMin);

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
    let resourceBusy = 0;
    let utilization = 0;
    if (b.kind === 'Service') {
      const pool = deptPools.get(b.ws.deptId);
      // Per-block utilization is approximated by service busyMin / capacity
      // available across the whole run. This is fine for a single Service
      // in a dept; for shared pools the dept-level utilisation is more
      // informative (rendered in the runner).
      resourceBusy = b.busyMin;
      utilization =
        pool && pool.capacity > 0
          ? Math.min(1, resourceBusy / (pool.capacity * durationMin))
          : 0;
    }
    blockObs.set(b.ws.id, {
      wsId: b.ws.id,
      kind: b.kind,
      produced: totalOut,
      finalQueueLen: finalQ,
      busyMin: b.busyMin,
      resourceBusyUnitMin: resourceBusy,
      perPortOut: Object.fromEntries(b.outflowByPort),
      throughputPerHr: durationMin > 0 ? (totalOut * 60) / durationMin : 0,
      utilization,
      bottleneck: false,
      blockedMin: b.blockedMin,
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

  // P4 — flatten orderStats into a Record. Only orders that emitted AND
  // had at least one piece reach a Sink land here; orders still in
  // progress at end-of-run are reported via `sunkPieces < quantity` —
  // for the result KPI we emit the time-to-last-sink even if partial,
  // since the IE wants to see "where did this order get to by the
  // shift bell."
  const perOrderCompletionTime: Record<string, number> = {};
  for (const [orderId, stat] of orderStats) {
    if (stat.firstEmittedAt >= 0 && stat.lastSunkAt > stat.firstEmittedAt) {
      perOrderCompletionTime[orderId] = stat.lastSunkAt - stat.firstEmittedAt;
    }
  }

  return {
    durationMin,
    totalProduced,
    piecesProducedFTR,
    piecesScrapped,
    piecesLost,
    firstPassYield,
    changeoverMin: changeoverMinAccum,
    downtimeMin: downtimeMinAccum,
    perOrderCompletionTime,
    meanLeadTimeMin: totalProduced > 0 ? leadTimeAccum / totalProduced : 0,
    throughputPerHr: durationMin > 0 ? (totalProduced * 60) / durationMin : 0,
    blocks: blockObs,
    bottleneckWsId,
    warnings,
    samples,
    flow: flowEvents,
  };
}
