/**
 * Open queueing NETWORKS — the step up from one station to a whole line.
 *
 * The textbook (Naidu, Unit 5 §1c) allows a unit to be served by "a sequence of
 * service channels", but states formulas only for a single facility. This
 * module supplies the missing half: given a graph of nodes and the routing
 * probabilities between them, work out the arrival rate each node actually
 * sees, then hand each one to the existing single-node solver.
 *
 * ── The traffic equations ────────────────────────────────────────────────
 * Every node's arrival rate is what comes from outside plus what the other
 * nodes send it:
 *
 *     λⱼ = γⱼ + Σᵢ λᵢ · pᵢⱼ
 *
 * γⱼ is the external (outside-the-network) arrival rate at node j, and pᵢⱼ is
 * the fraction of node i's output routed to j. In matrix form that is
 * λ = γ + Pᵀλ, i.e. (I − Pᵀ)λ = γ, which we solve exactly by Gaussian
 * elimination with partial pivoting. Feedback loops — a rework line sending
 * work back upstream — need no special handling: they are just non-zero
 * entries below the diagonal, and the direct solve deals with them, which an
 * iterative sweep in topological order could not.
 *
 * ── Why the loss case needs a second loop ────────────────────────────────
 * A node with a finite buffer turns arrivals away, so what LEAVES it is λ_eff
 * = λ(1 − P_N), not λ. Downstream nodes must be fed the admitted rate. But
 * P_N itself depends on λ, which depends on the upstream λ_eff — the system is
 * no longer linear. So when any node is capacity-bounded we wrap the linear
 * solve in a fixed-point iteration: solve, compute each node's loss, re-solve
 * with the losses folded into the routing, repeat until the rates stop moving.
 *
 * ── What is exact and what is not ────────────────────────────────────────
 * Jackson's theorem makes the per-node decomposition EXACT when every node is
 * M/M/c with an unbounded queue and routing is probabilistic: each node then
 * behaves as an independent M/M/c fed by a Poisson stream at rate λⱼ. Outside
 * those conditions it is an approximation, and `NetworkSolution.exactness`
 * says which case you are in rather than leaving the caller to guess.
 */

import {
  analyticalKpis,
  classify,
  type AnalyticalKpis,
  type KendallNotation,
  type QueueDiscipline,
} from './queueing';
import { cvOf, meanOf, type ServiceDist } from './distributions';

// ============================================================================
// TYPES
// ============================================================================

/** One service facility in the network. */
export interface QueueNode {
  id: string;
  name: string;
  /**
   * External arrival rate γ in units per hour — work entering this node from
   * OUTSIDE the network. For a sewing line this is the cutting room feeding
   * the first station; interior stations have γ = 0 and are fed by routing.
   */
  externalArrivalPerHr: number;
  serviceDist: ServiceDist;
  /** Parallel service channels c. */
  servers: number;
  /** System capacity N (waiting + in service). `Infinity` = unbounded. */
  capacity: number;
  discipline: QueueDiscipline;
}

/** A routed connection. `probability` is pᵢⱼ — the share of `from`'s output. */
export interface QueueEdge {
  id: string;
  from: string;
  to: string;
  /** 0..1. The shares leaving one node may sum to less than 1; the remainder
   *  exits the network (a Sink). More than 1 is a validation error. */
  probability: number;
}

export interface QueueNetwork {
  nodes: QueueNode[];
  edges: QueueEdge[];
}

/** How much of the result is exact and how much is approximation. */
export type NetworkExactness =
  /** Jackson's conditions hold — per-node results are exact. */
  | 'jackson-exact'
  /** Non-exponential service somewhere: per-node closed forms at the solved λ. */
  | 'decomposition'
  /** Finite capacity somewhere: product form is lost, rates solved by fixed point. */
  | 'loss-approximation'
  /** Traffic equations have no finite solution. */
  | 'unstable';

export interface SolvedNode {
  nodeId: string;
  /** Total OFFERED arrival rate λⱼ solved from the traffic equations, per hour. */
  lambda: number;
  /**
   * Visit ratio vⱼ = λⱼ / Γ — how many times an average unit passes through
   * this node on its way through the network. Above 1 means rework: the unit
   * comes back. This is what makes a 20% rework loop show up as a 25% load
   * increase rather than as a footnote.
   */
  visitRatio: number;
  /**
   * Squared coefficient of variation of the arrival stream reaching this node.
   * 1 is Poisson. Below 1 means a steadier stream than Poisson (a deterministic
   * node upstream has smoothed it); above 1 means burstier.
   */
  arrivalCv2: number;
  /** Rate actually admitted — differs from λ only where the node balks. */
  lambdaEff: number;
  /** Share of λⱼ that came from outside the network rather than from a peer. */
  externalShare: number;
  notation: KendallNotation;
  kpis: AnalyticalKpis;
  /** Σ of outgoing probabilities. 1 − this leaves the network here. */
  routedOut: number;
  /** True when this node has the highest ρ in the network. */
  isBottleneck: boolean;
}

export interface NetworkIssue {
  level: 'error' | 'warn' | 'info';
  nodeId?: string;
  message: string;
}

export interface NetworkSolution {
  nodes: SolvedNode[];
  byNodeId: Record<string, SolvedNode>;
  exactness: NetworkExactness;
  /** Every node stable (ρ < 1 where the queue is unbounded). */
  isStable: boolean;
  /** Σ Lⱼ — total work in the whole network, waiting plus in service. */
  totalL: number;
  /** Σ Lqⱼ — total waiting. */
  totalLq: number;
  /** Σ γⱼ — the rate work is OFFERED to the network, per hour. */
  externalArrivalPerHr: number;
  /**
   * Σ γⱼ(1 − P_Nⱼ) — the rate work actually GETS IN, per hour.
   *
   * Equal to the offered rate whenever no entry node has a bounded buffer.
   * Below it when one does: an arrival that finds its entry node full is turned
   * away and never becomes work in the network at all. This is the denominator
   * Little's law needs at the boundary.
   */
  admittedPerHr: number;
  /** Rate work LEAVES the network, per hour. Equals the external arrival rate
   *  when nothing balks; less when a bounded buffer turns work away. */
  throughputPerHr: number;
  /**
   * Mean time a unit spends in the whole network, in hours.
   *
   * Little's law applied to the network as one system: W = L / λ, over the
   * total L across every node and the rate work ACTUALLY ENTERS — the admitted
   * rate, not the offered one. Dividing by the offered rate is a real error and
   * not a small one: an entry node that turns away a third of its arrivals
   * makes the two answers differ by 33%, and it would contradict the per-node W
   * printed in the row above, which `queueing.ts` already computes at λ_eff.
   *
   * Deriving it from L rather than summing per-node W is what makes it right
   * for a unit that visits a node twice: in a plain tandem the two agree
   * exactly, but under rework the column sum misses the repeat visit and under
   * branching it counts nodes the unit never reached.
   */
  networkW: number;
  /** Mean waiting (non-service) time across the network, in hours. */
  networkWq: number;
  /**
   * Σ Wⱼ down the node list — what the W column adds up to.
   *
   * Carried alongside `networkW` because the two agreeing and the two
   * disagreeing are both worth seeing. They agree exactly for a simple path;
   * they diverge under rework (the sum misses repeat visits) and under
   * branching (the sum counts nodes a unit skipped), and the gap is the
   * revisit factor.
   */
  pathSumW: number;
  /**
   * Node ids ranked by traffic intensity ρ — who saturates first as load grows.
   * This is the classic bottleneck answer.
   */
  byUtilization: string[];
  /**
   * Node ids ranked by L — who is physically holding the work right now. On a
   * floor walk this is the pile you actually see.
   */
  byWip: string[];
  /**
   * Node ids ranked by vⱼ · Wqⱼ — minutes each node adds to one unit's journey
   * through the whole network, counting repeat visits. This is the ranking that
   * answers "where is the lead time going", and it is the one that most often
   * disagrees with ρ: a fast node visited three times can cost more than a slow
   * node visited once.
   */
  byDelayContribution: string[];
  /** Unbounded nodes with ρ ≥ 1 — the ones that make the network unstable. */
  unstableNodeIds: string[];
  bottleneckNodeId: string | null;
  issues: NetworkIssue[];
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Structural problems a user can fix, checked before solving so the surface
 * can explain a nonsensical result instead of rendering NaN.
 */
export function validateNetwork(net: QueueNetwork): NetworkIssue[] {
  const issues: NetworkIssue[] = [];
  const ids = new Set(net.nodes.map((n) => n.id));

  if (net.nodes.length === 0) {
    issues.push({ level: 'error', message: 'The network has no nodes.' });
    return issues;
  }

  for (const e of net.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({
        level: 'error',
        message: `A connection points at a node that no longer exists (${e.from} → ${e.to}).`,
      });
    }
    if (e.probability < 0 || e.probability > 1) {
      issues.push({
        level: 'error',
        nodeId: e.from,
        message: `Routing share ${e.probability} is outside 0–1.`,
      });
    }
  }

  // Outgoing shares may sum to ≤ 1; the remainder exits the network. Over 1
  // means the node emits more than it receives, which no amount of solving
  // can rescue.
  for (const n of net.nodes) {
    const out = net.edges.filter((e) => e.from === n.id);
    const sum = out.reduce((a, e) => a + e.probability, 0);
    if (sum > 1 + 1e-9) {
      issues.push({
        level: 'error',
        nodeId: n.id,
        message:
          `"${n.name}" routes ${(sum * 100).toFixed(0)}% of its output — more than it receives. `
          + 'Shares leaving one node must total 100% or less; whatever is left over exits the network.',
      });
    }
    if (meanOf(n.serviceDist) <= 0) {
      issues.push({
        level: 'error',
        nodeId: n.id,
        message: `"${n.name}" has a service time of zero, so its service rate μ is undefined.`,
      });
    }
  }

  const totalExternal = net.nodes.reduce((a, n) => a + Math.max(0, n.externalArrivalPerHr), 0);
  if (totalExternal <= 0) {
    issues.push({
      level: 'error',
      message:
        'Nothing arrives from outside. Give at least one node an external arrival rate λ, '
        + 'or the network has no work to do.',
    });
  }

  // A node that neither receives external work nor sits downstream of anything
  // will solve to λ = 0. That is not wrong, but it is almost never intended.
  const hasIncoming = new Set(net.edges.map((e) => e.to));
  for (const n of net.nodes) {
    if (n.externalArrivalPerHr <= 0 && !hasIncoming.has(n.id)) {
      issues.push({
        level: 'warn',
        nodeId: n.id,
        message: `"${n.name}" has no external arrivals and nothing feeds it, so it will sit idle.`,
      });
    }
  }

  return issues;
}

// ============================================================================
// TRAFFIC EQUATIONS
// ============================================================================

/**
 * Solve λ = γ + Pᵀλ for the offered rate at every node.
 *
 * `retention[i]` is the fraction of node i's arrivals that survive to be
 * routed onward — 1 for an unbounded node, (1 − P_N) for one that balks. It
 * enters as a scaling on i's outgoing shares, which is what makes the loss
 * case expressible in the same linear form.
 *
 * Returns null when the system is singular, which means the routing describes
 * a closed loop with no exit and no finite solution.
 */
function solveTrafficEquations(
  net: QueueNetwork,
  retention: number[],
): number[] | null {
  const n = net.nodes.length;
  const index = new Map(net.nodes.map((node, i) => [node.id, i]));

  // A = I − Pᵀ (scaled by retention), b = γ. Row j is node j's equation.
  const A: number[][] = Array.from({ length: n }, (_, j) =>
    Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
  );
  const b = net.nodes.map((node) => Math.max(0, node.externalArrivalPerHr));

  for (const e of net.edges) {
    const i = index.get(e.from);
    const j = index.get(e.to);
    if (i == null || j == null) continue;
    // λⱼ −= retentionᵢ · pᵢⱼ · λᵢ
    A[j][i] -= retention[i] * e.probability;
  }

  return gaussianSolve(A, b);
}

/**
 * Gaussian elimination with partial pivoting.
 *
 * Direct rather than iterative on purpose: a rework loop makes the routing
 * matrix non-triangular, so no ordering of the nodes lets a single forward
 * sweep converge, and a Jacobi/Gauss–Seidel iteration slows to a crawl exactly
 * where the network is near saturation — the case the user most wants a
 * trustworthy answer for. n is small (a floor is tens of nodes, not thousands),
 * so the cubic cost is irrelevant.
 */
function gaussianSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Work on copies; the caller reuses its inputs across fixed-point rounds.
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null; // singular
    if (pivot !== col) {
      const tmp = m[pivot];
      m[pivot] = m[col];
      m[col] = tmp;
    }
    const p = m[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = m[r][col] / p;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = m[r][n];
    for (let c = r + 1; c < n; c++) acc -= m[r][c] * x[c];
    x[r] = acc / m[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

// ============================================================================
// VARIABILITY PROPAGATION (Whitt's QNA)
// ============================================================================

/**
 * Squared coefficient of variation of the arrival stream at every node.
 *
 * Burke's theorem says an M/M/c station's departures are Poisson, which is why
 * a chain of exponential stations decomposes exactly. Put a deterministic
 * station in the chain and that stops being true: its departures are steadier
 * than Poisson, so the next station's queue is SHORTER than an M/M/1 formula
 * would say. Ignoring that is the single biggest error in naive tandem
 * analysis, and it runs the wrong way — it overstates the queue.
 *
 * Whitt's Queueing Network Analyzer tracks the effect with three link
 * equations. Writing ca² for an arrival stream's SCV and cs² for a service
 * time's:
 *
 *   departure from i      cd²ᵢ = 1 + (1 − ρᵢ²)(ca²ᵢ − 1) + (ρᵢ²/√cᵢ)(cs²ᵢ − 1)
 *   split i → j at pᵢⱼ    c²ᵢⱼ = pᵢⱼ·cd²ᵢ + (1 − pᵢⱼ)
 *   merge into j          ca²ⱼ = Σₖ (flowₖ→ⱼ / λⱼ)·c²ₖⱼ
 *
 * The useful property, once λ is already known: every one of those is AFFINE
 * in the SCVs, so composing them gives ca² = M·ca² + b — an ordinary linear
 * system, solved exactly by the same Gaussian elimination the traffic
 * equations use. No iteration, no convergence criterion, no tolerance to tune.
 *
 * It also self-checks: feed it an all-exponential network and b works out such
 * that ca² = 1 at every node, which is precisely Burke's theorem falling out of
 * the algebra. That is why the solver runs this unconditionally instead of
 * branching on whether the network happens to be exponential.
 *
 * Only these three equations are used. The QNA literature carries several
 * ρ-dependent refinements; every one of them destroys the linearity above and
 * would force an iterative solve, so they are deliberately not implemented.
 */
function solveArrivalVariability(
  net: QueueNetwork,
  lambda: number[],
  retention: number[],
): number[] {
  const n = net.nodes.length;
  const index = new Map(net.nodes.map((node, i) => [node.id, i]));

  // Per-node departure coefficients: cd²ᵢ = Aᵢ·ca²ᵢ + Bᵢ.
  const A = new Array<number>(n).fill(0);
  const B = new Array<number>(n).fill(1);
  for (let i = 0; i < n; i++) {
    const node = net.nodes[i];
    const mu = serviceRatePerHr(node);
    const c = Math.max(1, Math.floor(node.servers));
    const rho = mu > 0 ? Math.min(1, lambda[i] / (c * mu)) : 0;
    const cs2 = Math.pow(cvOf(node.serviceDist), 2);
    A[i] = 1 - rho * rho;
    B[i] = rho * rho + ((rho * rho) / Math.sqrt(c)) * (cs2 - 1);
  }

  // ca² = M·ca² + b  ⇒  (I − M)·ca² = b
  const M: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(1);

  for (let j = 0; j < n; j++) {
    const lamJ = lambda[j];
    if (lamJ <= 0) {
      // Nothing arrives, so there is no stream to characterise. Poisson is the
      // neutral answer and keeps the row of the matrix well-formed.
      b[j] = 1;
      continue;
    }
    // External stream: assumed Poisson, which is the textbook's premise.
    const gamma = Math.max(0, net.nodes[j].externalArrivalPerHr);
    b[j] = gamma / lamJ;
  }

  for (const e of net.edges) {
    const i = index.get(e.from);
    const j = index.get(e.to);
    if (i == null || j == null) continue;
    const lamJ = lambda[j];
    if (lamJ <= 0) continue;
    const p = e.probability;
    // Flow on this arc, after any loss at the source node.
    const w = (lambda[i] * retention[i] * p) / lamJ;
    M[j][i] += w * p * A[i];
    b[j] += w * (p * B[i] + 1 - p);
  }

  const system: number[][] = Array.from({ length: n }, (_, j) =>
    Array.from({ length: n }, (_, i) => (i === j ? 1 : 0) - M[j][i]),
  );
  const solved = gaussianSolve(system, b);
  // Singular only if the routing itself was, which the traffic solve already
  // rejected. Fall back to Poisson rather than propagating NaN.
  if (!solved) return new Array<number>(n).fill(1);
  // An SCV is a variance ratio: negative is meaningless, and a huge value is a
  // sign the network is pathological rather than a number worth reporting.
  return solved.map((v) => (Number.isFinite(v) ? Math.min(MAX_CV2, Math.max(0, v)) : 1));
}

/** Ceiling on a propagated SCV. Well above anything physical; a runaway guard. */
const MAX_CV2 = 1000;

// ============================================================================
// SOLVER
// ============================================================================

/** Fixed-point settings for the loss case. */
const LOSS_MAX_ROUNDS = 200;
const LOSS_TOLERANCE = 1e-9;
/**
 * Under-relaxation on the retention estimate.
 *
 * The loss loop chases itself: more arrivals raise the balk probability, which
 * cuts the arrivals, which lowers the balk probability. Taking each new
 * estimate whole makes that oscillate and never settle on the hard cases — a
 * tight buffer behind a heavy rework loop. Stepping only part of the way each
 * round damps the oscillation; 0.25 was measured to converge on cases where
 * 0.5 and 1.0 both hit the round cap.
 */
const LOSS_DAMPING = 0.25;

/**
 * Solve a whole network: arrival rate per node, then the full single-node
 * measure set at each, then the network aggregates.
 */
export function solveNetwork(net: QueueNetwork): NetworkSolution {
  const issues = validateNetwork(net);
  const fatal = issues.some((i) => i.level === 'error');
  if (fatal || net.nodes.length === 0) {
    return emptySolution(net, issues, 'unstable');
  }

  const hasFiniteCapacity = net.nodes.some((n) => Number.isFinite(n.capacity));

  // ── Round 0: assume nothing is lost, so the system is linear. ────────────
  let retention = net.nodes.map(() => 1);
  let lambda = solveTrafficEquations(net, retention);
  if (!lambda) {
    issues.push({
      level: 'error',
      message:
        'The routing has no finite solution — work circulates without an exit. '
        + 'Give at least one node on the loop a share that leaves the network.',
    });
    return emptySolution(net, issues, 'unstable');
  }

  // ── Loss case: iterate until the admitted rates stop moving. ─────────────
  if (hasFiniteCapacity) {
    let converged = false;
    for (let round = 0; round < LOSS_MAX_ROUNDS; round++) {
      const nextRetention = net.nodes.map((node, i) => {
        if (!Number.isFinite(node.capacity)) return 1;
        const k = solveOne(node, Math.max(0, lambda![i]));
        // Fraction admitted. A node offered nothing loses nothing.
        const target = lambda![i] > 0 ? k.lambdaEff / lambda![i] : 1;
        // Step partway toward the new estimate rather than jumping to it.
        return retention[i] + LOSS_DAMPING * (target - retention[i]);
      });
      const next = solveTrafficEquations(net, nextRetention);
      if (!next) break;
      const delta = Math.max(...next.map((v, i) => Math.abs(v - lambda![i])));
      lambda = next;
      retention = nextRetention;
      if (delta < LOSS_TOLERANCE) {
        converged = true;
        break;
      }
    }
    if (!converged) {
      issues.push({
        level: 'warn',
        message:
          'Arrival rates did not settle. Loss at a bounded buffer feeds back into '
          + 'the rates that cause it, and this network keeps chasing itself — read the '
          + 'per-node numbers as indicative and trust the simulation instead.',
      });
    }
  }

  // A tiny negative rate is elimination round-off, not a real quantity; a
  // genuinely negative one would mean a solver defect, and `analyticalKpis`
  // would quietly zero everything rather than surface it. Clamp the dust and
  // let anything larger fall through to the instability check below.
  lambda = lambda.map((v) => (v < 0 && v > -1e-9 ? 0 : v));

  // ── Variability, then per-node measures at the solved rates. ─────────────
  const arrivalCv2 = solveArrivalVariability(net, lambda, retention);

  const outShare = new Map<string, number>();
  for (const e of net.edges) {
    outShare.set(e.from, (outShare.get(e.from) ?? 0) + e.probability);
  }

  const totalExternal = net.nodes.reduce((a, n) => a + Math.max(0, n.externalArrivalPerHr), 0);

  const solved: SolvedNode[] = net.nodes.map((node, i) => {
    const lam = Math.max(0, lambda![i]);
    const ca2 = arrivalCv2[i];
    const kpis = solveOne(node, lam, ca2);
    // The arrival code follows the variability, not the wish: a station fed a
    // non-Poisson stream is G/·/c and the label has to say so.
    const arrival = Math.abs(ca2 - 1) > 1e-6 ? 'G' : 'M';
    const notation = classify(
      node.serviceDist,
      node.servers,
      node.capacity,
      node.discipline,
      arrival,
    );
    const external = Math.max(0, node.externalArrivalPerHr);
    return {
      nodeId: node.id,
      lambda: lam,
      visitRatio: totalExternal > 0 ? lam / totalExternal : 0,
      arrivalCv2: ca2,
      lambdaEff: kpis.lambdaEff,
      externalShare: lam > 0 ? Math.min(1, external / lam) : 0,
      notation,
      kpis,
      routedOut: outShare.get(node.id) ?? 0,
      isBottleneck: false,
    };
  });

  // Bottleneck = highest traffic intensity. Ties go to the earlier node, which
  // on a line is the one upstream work piles up behind first.
  let bottleneck: SolvedNode | null = null;
  for (const s of solved) {
    if (!Number.isFinite(s.kpis.rho)) continue;
    if (!bottleneck || s.kpis.rho > bottleneck.kpis.rho) bottleneck = s;
  }
  if (bottleneck) bottleneck.isBottleneck = true;

  // ── Aggregates. ──────────────────────────────────────────────────────────
  const isStable = solved.every((s) => s.kpis.isStable || Number.isFinite(s.notation.capacity));
  const totalL = sumFinite(solved.map((s) => s.kpis.L));
  const totalLq = sumFinite(solved.map((s) => s.kpis.Lq));
  const externalArrivalPerHr = net.nodes.reduce(
    (a, n) => a + Math.max(0, n.externalArrivalPerHr),
    0,
  );
  // What leaves the network: every node's admitted rate times the share of its
  // output that exits rather than being routed onward.
  const throughputPerHr = solved.reduce(
    (a, s) => a + s.lambdaEff * (1 - Math.min(1, s.routedOut)),
    0,
  );

  // Little's law at the network boundary needs the rate that GETS IN. An
  // arrival turned away at its entry node never becomes work in the network,
  // so counting it in the denominator understates the time everything else
  // spends there.
  const admittedPerHr = solved.reduce((acc, s2, i) => {
    const gamma = Math.max(0, net.nodes[i].externalArrivalPerHr);
    return acc + gamma * (1 - s2.kpis.pBalk);
  }, 0);
  const networkW = admittedPerHr > 0 ? totalL / admittedPerHr : 0;
  const networkWq = admittedPerHr > 0 ? totalLq / admittedPerHr : 0;
  const pathSumW = sumFinite(solved.map((s2) => s2.kpis.W));

  if (!isStable) {
    const worst = bottleneck ? net.nodes.find((n) => n.id === bottleneck!.nodeId) : null;
    issues.push({
      level: 'error',
      nodeId: bottleneck?.nodeId,
      message:
        `The network is unstable${worst ? ` at "${worst.name}"` : ''}: work arrives faster than it can `
        + 'be served, so the queue grows without bound. Add a server, cut the arrival rate, '
        + 'or cap the buffer to make the loss explicit.',
    });
  }

  const exactness = classifyExactness(net, hasFiniteCapacity, isStable, arrivalCv2);
  const exactnessNote = EXACTNESS_NOTE[exactness];
  if (exactnessNote) issues.push({ level: 'info', message: exactnessNote });

  // Three rankings, because "the bottleneck" is three different questions and
  // the useful moment is when they disagree.
  // Infinity is kept and sorts FIRST: a saturated node has an unbounded queue,
  // which makes it the most important entry in the ranking, not one to hide.
  // Only NaN is dropped — that means the model has no answer for this node.
  const rank = (score: (s: SolvedNode) => number): string[] =>
    [...solved]
      .filter((s) => !Number.isNaN(score(s)))
      .sort((a, b) => {
        const x = score(a);
        const y = score(b);
        if (x === y) return 0;
        return y > x ? 1 : -1;
      })
      .map((s) => s.nodeId);

  return {
    nodes: solved,
    byNodeId: Object.fromEntries(solved.map((s) => [s.nodeId, s])),
    exactness,
    isStable,
    totalL,
    totalLq,
    externalArrivalPerHr,
    admittedPerHr,
    throughputPerHr,
    networkW,
    networkWq,
    pathSumW,
    byUtilization: rank((s) => s.kpis.rho),
    byWip: rank((s) => s.kpis.L),
    // vⱼ · Wqⱼ — minutes this node adds to one unit's whole journey, counting
    // repeat visits. Wq is in hours; ×60 keeps it in the floor's units.
    byDelayContribution: rank((s) => s.visitRatio * s.kpis.Wq * 60),
    unstableNodeIds: solved
      .filter((s) => !Number.isFinite(s.notation.capacity) && !s.kpis.isStable)
      .map((s) => s.nodeId),
    bottleneckNodeId: bottleneck?.nodeId ?? null,
    issues,
  };
}

/** One node's full measure set, through the same solver a standalone system uses. */
function solveOne(node: QueueNode, lambda: number, arrivalCv2 = 1): AnalyticalKpis {
  const notation = classify(node.serviceDist, node.servers, node.capacity, node.discipline);
  return analyticalKpis(notation, lambda, node.serviceDist, { arrivalCv2 });
}

function classifyExactness(
  net: QueueNetwork,
  hasFiniteCapacity: boolean,
  isStable: boolean,
  arrivalCv2: number[],
): NetworkExactness {
  if (!isStable) return 'unstable';
  if (hasFiniteCapacity) return 'loss-approximation';
  // Exact when Jackson's conditions hold: exponential service everywhere AND
  // every stream still Poisson, which the variability solve confirms rather
  // than assumes.
  const allExponential = net.nodes.every((n) => cvOf(n.serviceDist) === 1);
  const allPoisson = arrivalCv2.every((v) => Math.abs(v - 1) < 1e-6);
  return allExponential && allPoisson ? 'jackson-exact' : 'decomposition';
}

const EXACTNESS_NOTE: Record<NetworkExactness, string | null> = {
  'jackson-exact':
    'Every node is M/M/c with an unbounded queue, so Jackson’s theorem applies: each node '
    + 'behaves exactly as an independent M/M/c fed at the rate solved above. These numbers are exact.',
  decomposition:
    'At least one node has non-exponential service, so its departures are not a Poisson stream '
    + 'and the nodes are not strictly independent. Each is solved by its own closed form at the '
    + 'arrival rate the traffic equations give — accurate in the mean, less so in the tails. '
    + 'The simulation is the authority where they disagree.',
  'loss-approximation':
    'At least one node has a bounded buffer. Turning work away breaks the product form Jackson’s '
    + 'theorem relies on, so the arrival rates here are a fixed point rather than an exact '
    + 'solution. They are also a loss model: the textbook balks, while a real floor blocks the '
    + 'operator upstream.',
  unstable: null,
};

function sumFinite(values: number[]): number {
  let acc = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return Infinity;
    acc += v;
  }
  return acc;
}

function emptySolution(
  net: QueueNetwork,
  issues: NetworkIssue[],
  exactness: NetworkExactness,
): NetworkSolution {
  return {
    nodes: [],
    byNodeId: {},
    exactness,
    isStable: false,
    totalL: 0,
    totalLq: 0,
    externalArrivalPerHr: net.nodes.reduce((a, n) => a + Math.max(0, n.externalArrivalPerHr), 0),
    admittedPerHr: 0,
    throughputPerHr: 0,
    networkW: 0,
    networkWq: 0,
    pathSumW: 0,
    byUtilization: [],
    byWip: [],
    byDelayContribution: [],
    unstableNodeIds: [],
    bottleneckNodeId: null,
    issues,
  };
}

// ============================================================================
// CONVENIENCE
// ============================================================================

/**
 * Build a straight tandem chain — the sewing-line shape — from a list of
 * nodes. Node 0 takes the external arrivals; each node passes everything to
 * the next; the last one's output leaves the network.
 */
export function tandemEdges(nodes: QueueNode[]): QueueEdge[] {
  const edges: QueueEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      id: `${nodes[i].id}->${nodes[i + 1].id}`,
      from: nodes[i].id,
      to: nodes[i + 1].id,
      probability: 1,
    });
  }
  return edges;
}

/** μ in units per hour for a node, from its mean service time in minutes. */
export function serviceRatePerHr(node: QueueNode): number {
  const mean = meanOf(node.serviceDist);
  return mean > 0 ? 60 / mean : 0;
}

/** A single-node "network" — the common case, expressed in the same type. */
export function singleNodeNetwork(node: QueueNode): QueueNetwork {
  return { nodes: [node], edges: [] };
}

export type { ServiceDist };
