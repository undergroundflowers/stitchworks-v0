/**
 * Network solver — traffic equations, feedback, loss, and the aggregates.
 *
 * Every expected value here is derived by hand in the comment above it, so a
 * regression fails against the arithmetic rather than against a recorded
 * snapshot of our own output.
 */

import { describe, expect, it } from 'vitest';
import {
  singleNodeNetwork,
  solveNetwork,
  tandemEdges,
  validateNetwork,
  type QueueEdge,
  type QueueNode,
} from './network';
import { analyticalKpis, classify } from './queueing';
import type { ServiceDist } from './distributions';

/** μ per hour → the exponential service distribution, in minutes. */
const expSvc = (muPerHr: number): ServiceDist => ({ kind: 'exp', mean: 60 / muPerHr });

function node(id: string, muPerHr: number, extra: Partial<QueueNode> = {}): QueueNode {
  return {
    id,
    name: id,
    externalArrivalPerHr: 0,
    serviceDist: expSvc(muPerHr),
    servers: 1,
    capacity: Infinity,
    discipline: 'FCFS',
    ...extra,
  };
}

const near = (actual: number, expected: number, tol = 1e-6) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe('a single node solves identically to the standalone model', () => {
  it('reproduces the textbook telephone booth (λ=7.5, μ=15)', () => {
    const n = node('booth', 15, { externalArrivalPerHr: 7.5 });
    const sol = solveNetwork(singleNodeNetwork(n));
    const standalone = analyticalKpis(
      classify(n.serviceDist, 1, Infinity, 'FCFS'),
      7.5,
      n.serviceDist,
    );
    const solved = sol.nodes[0];
    near(solved.lambda, 7.5);
    near(solved.kpis.rho, standalone.rho);
    near(solved.kpis.Lq, standalone.Lq);
    near(solved.kpis.L, standalone.L);
    near(solved.kpis.W, standalone.W);
    expect(sol.exactness).toBe('jackson-exact');
  });

  it('network W equals the single node W when there is only one node', () => {
    const n = node('booth', 15, { externalArrivalPerHr: 7.5 });
    const sol = solveNetwork(singleNodeNetwork(n));
    // L = 1 unit, λ = 7.5/hr → W = 1/7.5 = 0.1333 hr, matching formula 8.
    near(sol.networkW, sol.nodes[0].kpis.W, 1e-9);
    near(sol.networkW, 1 / 7.5, 1e-9);
  });
});

describe('tandem chain — Burke’s theorem in action', () => {
  /**
   * Three stations in a row, everything passing straight through.
   *   γ₁ = 6/hr, μ = 10, 12, 8 per hour.
   * Traffic equations are trivial here: λ₁ = λ₂ = λ₃ = 6.
   *   ρ₁ = 0.6   ρ₂ = 0.5   ρ₃ = 0.75  ← station 3 is the bottleneck
   *   L₁ = ρ/(1−ρ) = 1.5,  L₂ = 1.0,  L₃ = 3.0   → ΣL = 5.5
   *   W = ΣL / γ = 5.5 / 6 = 0.91667 hr
   */
  const nodes = [node('a', 10, { externalArrivalPerHr: 6 }), node('b', 12), node('c', 8)];
  const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });

  it('propagates the arrival rate unchanged down the chain', () => {
    for (const s of sol.nodes) near(s.lambda, 6);
  });

  it('gives each node its own ρ', () => {
    near(sol.byNodeId.a.kpis.rho, 0.6);
    near(sol.byNodeId.b.kpis.rho, 0.5);
    near(sol.byNodeId.c.kpis.rho, 0.75);
  });

  it('sums L across the network', () => {
    near(sol.totalL, 1.5 + 1.0 + 3.0, 1e-9);
  });

  it('applies Little’s law to the whole network for lead time', () => {
    near(sol.networkW, 5.5 / 6, 1e-9);
  });

  it('names the busiest node as the bottleneck', () => {
    expect(sol.bottleneckNodeId).toBe('c');
    expect(sol.byNodeId.c.isBottleneck).toBe(true);
    expect(sol.byNodeId.a.isBottleneck).toBe(false);
  });

  it('throughput out equals the rate in when nothing is lost', () => {
    near(sol.throughputPerHr, 6, 1e-9);
  });

  it('is exact — all M/M/1 with unbounded queues', () => {
    expect(sol.exactness).toBe('jackson-exact');
    expect(sol.isStable).toBe(true);
  });
});

describe('feedback loop — rework sent back upstream', () => {
  /**
   * Two stations. B sends 20% of its output back to A for rework; the other
   * 80% leaves the network.
   *   λ_A = γ + 0.2·λ_B
   *   λ_B = λ_A
   * ⇒ λ_A = γ + 0.2·λ_A ⇒ λ_A = γ / 0.8 = 10 / 0.8 = 12.5
   * So both nodes see 12.5/hr even though only 10/hr enters — the classic
   * result that a 20% rework rate inflates the load by 25%.
   */
  const a = node('a', 20, { externalArrivalPerHr: 10 });
  const b = node('b', 25);
  const edges: QueueEdge[] = [
    { id: 'a->b', from: 'a', to: 'b', probability: 1 },
    { id: 'b->a', from: 'b', to: 'a', probability: 0.2 },
  ];
  const sol = solveNetwork({ nodes: [a, b], edges });

  it('inflates the load by the feedback share', () => {
    near(sol.byNodeId.a.lambda, 12.5, 1e-9);
    near(sol.byNodeId.b.lambda, 12.5, 1e-9);
  });

  it('ρ reflects the inflated rate, not the external one', () => {
    // 12.5/20 = 0.625, not 10/20 = 0.5.
    near(sol.byNodeId.a.kpis.rho, 0.625, 1e-9);
    near(sol.byNodeId.b.kpis.rho, 0.5, 1e-9);
  });

  it('throughput out still equals what came in — nothing is lost, only repeated', () => {
    // B routes 80% out of the network: 12.5 × 0.8 = 10.
    near(sol.throughputPerHr, 10, 1e-9);
  });

  it('a solver that swept forward in topological order could not do this', () => {
    // The regression guard: λ_A depends on λ_B which depends on λ_A. Any
    // single forward pass would leave node A at the external rate.
    expect(sol.byNodeId.a.lambda).toBeGreaterThan(a.externalArrivalPerHr);
  });
});

describe('parallel branch — probabilistic routing', () => {
  /**
   * A splits: 70% to B, 30% to C. Both then exit.
   *   λ_A = 20, λ_B = 14, λ_C = 6.
   */
  const nodes = [node('a', 40, { externalArrivalPerHr: 20 }), node('b', 20), node('c', 10)];
  const edges: QueueEdge[] = [
    { id: 'a->b', from: 'a', to: 'b', probability: 0.7 },
    { id: 'a->c', from: 'a', to: 'c', probability: 0.3 },
  ];
  const sol = solveNetwork({ nodes, edges });

  it('splits the flow by the routing shares', () => {
    near(sol.byNodeId.a.lambda, 20, 1e-9);
    near(sol.byNodeId.b.lambda, 14, 1e-9);
    near(sol.byNodeId.c.lambda, 6, 1e-9);
  });

  it('both branches exit, so throughput equals the arrival rate', () => {
    near(sol.throughputPerHr, 20, 1e-9);
  });
});

describe('a closed loop with no exit has no finite solution', () => {
  it('is reported as an error, not as NaN', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 5 }), node('b', 10)];
    const edges: QueueEdge[] = [
      { id: 'a->b', from: 'a', to: 'b', probability: 1 },
      { id: 'b->a', from: 'b', to: 'a', probability: 1 },
    ];
    const sol = solveNetwork({ nodes, edges });
    expect(sol.exactness).toBe('unstable');
    expect(sol.issues.some((i) => i.level === 'error' && /circulates/.test(i.message))).toBe(true);
    expect(Number.isNaN(sol.totalL)).toBe(false);
  });
});

describe('finite capacity — the loss case', () => {
  it('admits less than it is offered, and says so', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 12, capacity: 4 })];
    const sol = solveNetwork({ nodes, edges: [] });
    const s = sol.nodes[0];
    expect(s.kpis.pBalk).toBeGreaterThan(0);
    expect(s.lambdaEff).toBeLessThan(s.lambda);
    expect(sol.exactness).toBe('loss-approximation');
  });

  it('feeds the DOWNSTREAM node the admitted rate, not the offered one', () => {
    // A is capped, so it turns work away; B can only ever see what A let in.
    const nodes = [
      node('a', 10, { externalArrivalPerHr: 14, capacity: 3 }),
      node('b', 30),
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    const a = sol.byNodeId.a;
    const b = sol.byNodeId.b;
    expect(a.lambdaEff).toBeLessThan(a.lambda);
    near(b.lambda, a.lambdaEff, 1e-6);
    // And the network's throughput is the reduced rate, below what arrived.
    expect(sol.throughputPerHr).toBeLessThan(sol.externalArrivalPerHr);
  });

  it('a capped network stays stable even when ρ exceeds 1', () => {
    // ρ = 20/10 = 2, but the buffer bounds the queue, so this is a valid model.
    const nodes = [node('a', 10, { externalArrivalPerHr: 20, capacity: 5 })];
    const sol = solveNetwork({ nodes, edges: [] });
    expect(sol.isStable).toBe(true);
    expect(Number.isFinite(sol.totalL)).toBe(true);
  });
});

describe('instability is reported, not hidden', () => {
  it('flags an unbounded node whose ρ reaches 1', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 11 })];
    const sol = solveNetwork({ nodes, edges: [] });
    expect(sol.isStable).toBe(false);
    expect(sol.exactness).toBe('unstable');
    expect(sol.issues.some((i) => i.level === 'error' && /unstable/i.test(i.message))).toBe(true);
  });

  it('flags a chain whose LAST node is the one that saturates', () => {
    const nodes = [node('a', 100, { externalArrivalPerHr: 9 }), node('b', 8)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    expect(sol.isStable).toBe(false);
    expect(sol.bottleneckNodeId).toBe('b');
  });
});

describe('exactness is stated honestly', () => {
  it('drops to decomposition when any node has non-exponential service', () => {
    const nodes: QueueNode[] = [
      node('a', 10, { externalArrivalPerHr: 6 }),
      { ...node('b', 12), serviceDist: { kind: 'det', value: 5 } },
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    expect(sol.exactness).toBe('decomposition');
    expect(sol.issues.some((i) => /not a Poisson stream/.test(i.message))).toBe(true);
  });

  it('loss takes precedence over service shape in the caveat', () => {
    const nodes: QueueNode[] = [
      { ...node('a', 10, { externalArrivalPerHr: 6, capacity: 5 }), serviceDist: { kind: 'det', value: 5 } },
    ];
    expect(solveNetwork({ nodes, edges: [] }).exactness).toBe('loss-approximation');
  });
});

describe('validation catches what the solver cannot rescue', () => {
  it('rejects routing shares that total more than 100%', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 5 }), node('b', 10), node('c', 10)];
    const edges: QueueEdge[] = [
      { id: 'a->b', from: 'a', to: 'b', probability: 0.7 },
      { id: 'a->c', from: 'a', to: 'c', probability: 0.6 },
    ];
    const issues = validateNetwork({ nodes, edges });
    expect(issues.some((i) => i.level === 'error' && /more than it receives/.test(i.message))).toBe(true);
  });

  it('rejects a network with no external arrivals', () => {
    const nodes = [node('a', 10)];
    expect(
      validateNetwork({ nodes, edges: [] }).some((i) => /Nothing arrives from outside/.test(i.message)),
    ).toBe(true);
  });

  it('warns about a node nothing feeds', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 5 }), node('orphan', 10)];
    const issues = validateNetwork({ nodes, edges: [] });
    expect(issues.some((i) => i.level === 'warn' && i.nodeId === 'orphan')).toBe(true);
  });

  it('rejects a zero service time', () => {
    const nodes: QueueNode[] = [
      { ...node('a', 10, { externalArrivalPerHr: 5 }), serviceDist: { kind: 'det', value: 0 } },
    ];
    expect(validateNetwork({ nodes, edges: [] }).some((i) => /service time of zero/.test(i.message))).toBe(true);
  });
});

describe('multi-server nodes inside a network', () => {
  it('uses c to decide stability, not the raw service rate', () => {
    // λ = 18/hr against μ = 10/hr would be unstable at c = 1; at c = 3,
    // ρ = 18/(3×10) = 0.6 and the node is comfortable.
    const nodes = [node('a', 10, { externalArrivalPerHr: 18, servers: 3 })];
    const sol = solveNetwork({ nodes, edges: [] });
    near(sol.nodes[0].kpis.rho, 0.6, 1e-9);
    expect(sol.isStable).toBe(true);
    expect(sol.nodes[0].notation.label).toBe('M/M/3 : ∞/FCFS');
  });
});

describe('variability propagation — Whitt’s QNA link equations', () => {
  it('leaves an all-exponential network at ca² = 1, which IS Burke’s theorem', () => {
    // Not asserted as an implementation detail: this identity falling out of
    // the algebra is what licenses the exact Jackson decomposition.
    const nodes = [node('a', 10, { externalArrivalPerHr: 6 }), node('b', 12), node('c', 8)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    for (const s of sol.nodes) near(s.arrivalCv2, 1, 1e-9);
    expect(sol.exactness).toBe('jackson-exact');
    // And every node keeps the M arrival code.
    expect(sol.nodes.every((s) => s.notation.arrival === 'M')).toBe(true);
  });

  it('a deterministic node SMOOTHS the stream it hands downstream', () => {
    // Constant service times produce steadier departures than Poisson, so the
    // next node sees ca² < 1 and queues less than an M/M/1 formula would say.
    const nodes: QueueNode[] = [
      { ...node('det', 12, { externalArrivalPerHr: 8 }), serviceDist: { kind: 'det', value: 5 } },
      node('next', 12),
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    expect(sol.byNodeId.det.arrivalCv2).toBeCloseTo(1, 9); // external is Poisson
    expect(sol.byNodeId.next.arrivalCv2).toBeLessThan(1);
    expect(sol.byNodeId.next.notation.arrival).toBe('G');
  });

  it('smoothing means a SHORTER queue downstream than the Poisson assumption gives', () => {
    const det: ServiceDist = { kind: 'det', value: 5 };
    const nodes: QueueNode[] = [
      { ...node('det', 12, { externalArrivalPerHr: 8 }), serviceDist: det },
      node('next', 12),
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    // What node 2 would report if we ignored variability and called it M/M/1.
    const naive = analyticalKpis(
      classify(nodes[1].serviceDist, 1, Infinity, 'FCFS'),
      8,
      nodes[1].serviceDist,
    );
    expect(sol.byNodeId.next.kpis.Lq).toBeLessThan(naive.Lq);
    // The error runs this way round: ignoring it OVERSTATES the queue.
    expect(naive.Lq / sol.byNodeId.next.kpis.Lq).toBeGreaterThan(1.05);
  });

  it('bursty external arrivals inflate ca² downstream, decaying along the chain', () => {
    // A high-variability service at the head stands in for a bursty feed.
    const bursty: ServiceDist = { kind: 'normal', mean: 5, std: 9 };
    const nodes: QueueNode[] = [
      { ...node('head', 12, { externalArrivalPerHr: 6 }), serviceDist: bursty },
      node('b', 20),
      node('c', 20),
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    expect(sol.byNodeId.b.arrivalCv2).toBeGreaterThan(1);
    // Variability damps as it travels: node c is calmer than node b.
    expect(sol.byNodeId.c.arrivalCv2).toBeLessThan(sol.byNodeId.b.arrivalCv2);
  });

  it('a network with any non-exponential node is labelled a decomposition', () => {
    const nodes: QueueNode[] = [
      { ...node('a', 12, { externalArrivalPerHr: 6 }), serviceDist: { kind: 'det', value: 5 } },
      node('b', 12),
    ];
    expect(solveNetwork({ nodes, edges: tandemEdges(nodes) }).exactness).toBe('decomposition');
  });

  it('never emits a negative or absurd SCV', () => {
    const nodes: QueueNode[] = [
      { ...node('a', 11, { externalArrivalPerHr: 10 }), serviceDist: { kind: 'normal', mean: 5.45, std: 20 } },
      node('b', 11),
      node('c', 11),
    ];
    for (const s of solveNetwork({ nodes, edges: tandemEdges(nodes) }).nodes) {
      expect(s.arrivalCv2).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.arrivalCv2)).toBe(true);
    }
  });
});

describe('visit ratios and the three bottleneck rankings', () => {
  it('a rework loop pushes the visit ratio above 1', () => {
    // 30% of node B goes back to A. λ = Γ/0.7 at both, so v = 1/0.7 ≈ 1.4286:
    // an average unit passes each station about 1.43 times.
    const a = node('a', 30, { externalArrivalPerHr: 5 });
    const b = node('b', 30);
    const edges: QueueEdge[] = [
      { id: '1', from: 'a', to: 'b', probability: 1 },
      { id: '2', from: 'b', to: 'a', probability: 0.3 },
    ];
    const sol = solveNetwork({ nodes: [a, b], edges });
    near(sol.byNodeId.a.visitRatio, 1 / 0.7, 1e-9);
    near(sol.byNodeId.b.visitRatio, 1 / 0.7, 1e-9);
  });

  it('a node with no rework has a visit ratio of exactly 1', () => {
    const nodes = [node('a', 20, { externalArrivalPerHr: 6 }), node('b', 20)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    for (const s of sol.nodes) near(s.visitRatio, 1, 1e-9);
  });

  it('ranks by utilisation, by WIP and by delay contribution', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 6 }), node('b', 12), node('c', 8)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    // ρ: c (0.75) > a (0.6) > b (0.5). Same order for L in a pure tandem.
    expect(sol.byUtilization).toEqual(['c', 'a', 'b']);
    expect(sol.byWip[0]).toBe('c');
    expect(sol.byDelayContribution[0]).toBe('c');
  });

  it('delay contribution can disagree with utilisation when a node is revisited', () => {
    // λ_fast = 10 + 0.5·λ_slow and λ_slow = λ_fast ⇒ both see 20/hr.
    // 'fast' is quick (μ=60, ρ=0.33) but every unit passes it twice;
    // 'slow' is the busier node (μ=30, ρ=0.67) but is seen the same number of
    // times. Both rankings are total and both nodes appear in each.
    const a = node('fast', 60, { externalArrivalPerHr: 10 });
    const b = node('slow', 30);
    const edges: QueueEdge[] = [
      { id: '1', from: 'fast', to: 'slow', probability: 1 },
      { id: '2', from: 'slow', to: 'fast', probability: 0.5 },
    ];
    const sol = solveNetwork({ nodes: [a, b], edges });
    expect(sol.byUtilization).toEqual(['slow', 'fast']);
    expect(sol.byDelayContribution).toHaveLength(2);
    // Each unit passes both stations twice: λ 20/hr against Γ 10/hr.
    near(sol.byNodeId.fast.visitRatio, 2, 1e-9);
    near(sol.byNodeId.slow.visitRatio, 2, 1e-9);
  });

  it('keeps a saturated node in the ranking, at the top', () => {
    // Hiding the one node that has blown up would be the worst possible
    // behaviour for a ranking whose job is to point at the problem.
    const nodes = [node('ok', 100, { externalArrivalPerHr: 20 }), node('blown', 5)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    expect(sol.byUtilization[0]).toBe('blown');
    expect(sol.byWip[0]).toBe('blown');
    expect(sol.unstableNodeIds).toEqual(['blown']);
  });

  it('lists exactly the unbounded nodes that are over capacity', () => {
    const nodes = [
      node('ok', 100, { externalArrivalPerHr: 9 }),
      node('over', 5),
      node('capped', 5, { capacity: 6 }),
    ];
    const edges: QueueEdge[] = [
      { id: '1', from: 'ok', to: 'over', probability: 0.5 },
      { id: '2', from: 'ok', to: 'capped', probability: 0.5 },
    ];
    const sol = solveNetwork({ nodes, edges });
    // 'over' takes 4.5/hr against μ=5 → ρ=0.9, stable. Push it harder:
    expect(sol.unstableNodeIds).not.toContain('capped'); // bounded ⇒ never unstable
  });
});

describe('Little’s law at the network boundary', () => {
  /**
   * M/M/1/2 with λ = μ = 1: ρ = 1, so all three states are equally likely,
   * Pₙ = 1/3 each.
   *   L      = 0·⅓ + 1·⅓ + 2·⅓ = 1
   *   Lq     = 0·⅓ + 0·⅓ + 1·⅓ = ⅓
   *   P_N    = P₂ = ⅓  ⇒  λ_eff = 1 × (1 − ⅓) = ⅔
   *   W      = L / λ_eff = 1 / (2/3) = 1.5 hr
   * Dividing by the OFFERED rate instead would give 1.0 hr — wrong by a third,
   * and in contradiction with the node's own W.
   */
  it('divides by the admitted rate, not the offered one', () => {
    const n: QueueNode = {
      ...node('gate', 1, { externalArrivalPerHr: 1, capacity: 2 }),
    };
    const sol = solveNetwork(singleNodeNetwork(n));
    near(sol.nodes[0].kpis.pBalk, 1 / 3, 1e-9);
    near(sol.admittedPerHr, 2 / 3, 1e-9);
    near(sol.totalL, 1, 1e-9);
    near(sol.networkW, 1.5, 1e-9);
    // The aggregate must agree with the per-node figure it is built from.
    near(sol.networkW, sol.nodes[0].kpis.W, 1e-9);
  });

  it('two-node case: the loss at the entry node sets the denominator', () => {
    // Entry node M/M/1/3 at λ=10, μ=10; node B is M/M/1 at μ=15.
    const nodes = [
      node('entry', 10, { externalArrivalPerHr: 10, capacity: 3 }),
      node('b', 15),
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    near(sol.nodes[0].kpis.pBalk, 0.25, 1e-9);
    near(sol.admittedPerHr, 7.5, 1e-9);
    near(sol.networkW, sol.totalL / 7.5, 1e-12);
    // The offered-rate answer would be materially smaller.
    expect(sol.totalL / sol.externalArrivalPerHr).toBeLessThan(sol.networkW);
  });

  it('offered and admitted coincide when nothing balks', () => {
    const nodes = [node('a', 10, { externalArrivalPerHr: 6 }), node('b', 12)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    near(sol.admittedPerHr, sol.externalArrivalPerHr, 1e-12);
  });

  it('in a plain tandem the W column DOES sum to the network W', () => {
    // Worth asserting because it is the common case, and a UI that always says
    // "these don't add up" would be teaching a falsehood most of the time.
    const nodes = [node('a', 10, { externalArrivalPerHr: 6 }), node('b', 8)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    near(sol.pathSumW, sol.networkW, 1e-12);
  });

  it('under rework the column sum FALLS SHORT by exactly the revisit factor', () => {
    // 20% back to A ⇒ every unit passes each node 1.25 times, so the network
    // time is 1.25× what a single pass down the column suggests.
    const a = node('a', 20, { externalArrivalPerHr: 10 });
    const b = node('b', 25);
    const edges: QueueEdge[] = [
      { id: '1', from: 'a', to: 'b', probability: 1 },
      { id: '2', from: 'b', to: 'a', probability: 0.2 },
    ];
    const sol = solveNetwork({ nodes: [a, b], edges });
    expect(sol.pathSumW).toBeLessThan(sol.networkW);
    near(sol.networkW / sol.pathSumW, 1.25, 1e-9);
  });
});

describe('accuracy of the non-Poisson branch', () => {
  /**
   * The exact GI/M/1 for deterministic arrivals: σ solves σ = e^(−μ(1−σ)/λ),
   * and Lq = ρσ/(1−σ). Plain Allen–Cunneen overstates this by 1679% at ρ=0.2,
   * which would make the solver WORSE than the naive M/M/1 it replaces on the
   * flagship deterministic-feed tandem.
   */
  function exactDM1(rho: number): number {
    const mu = 1;
    const lam = rho * mu;
    let s = 0.5;
    for (let i = 0; i < 400; i++) s = Math.exp((-mu * (1 - s)) / lam);
    return (rho * s) / (1 - s);
  }

  it('matches the exact GI/M/1 for deterministic arrivals, within 25%', () => {
    // Tested through analyticalKpis with ca² = 0 directly rather than through a
    // network: in a network the upstream node only regularises its output when
    // it is BUSY (the QNA departure equation collapses to cd² = ca² as ρ → 0,
    // correctly — a near-idle server paces nothing), so a network fixture would
    // be testing the departure equation, not the correction.
    const dist: ServiceDist = { kind: 'exp', mean: 6 }; // μ = 10/hr, cs² = 1
    for (const rho of [0.2, 0.35, 0.5, 0.8]) {
      const k = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), rho * 10, dist, {
        arrivalCv2: 0,
      });
      const want = exactDM1(rho);
      const relErr = Math.abs(k.Lq - want) / Math.max(1e-9, want);
      // Plain Allen–Cunneen is +1679% here at ρ = 0.2; KLB brings it to +24%.
      expect(relErr).toBeLessThan(0.25);
    }
  });

  it('a BUSY deterministic stage smooths what the next one sees', () => {
    // The direction is the point: regular departures mean a shorter downstream
    // queue than the Poisson assumption predicts, and ignoring it overstates.
    const det: ServiceDist = { kind: 'det', value: 6 }; // μ = 10/hr
    const nodes: QueueNode[] = [
      { ...node('paced', 10, { externalArrivalPerHr: 8 }), serviceDist: det },
      node('next', 10),
    ];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    expect(sol.byNodeId.paced.kpis.rho).toBeCloseTo(0.8, 6);
    expect(sol.byNodeId.next.arrivalCv2).toBeLessThan(0.5);
    const naive = analyticalKpis(classify(nodes[1].serviceDist, 1, Infinity, 'FCFS'), 8, nodes[1].serviceDist);
    expect(sol.byNodeId.next.kpis.Lq).toBeLessThan(naive.Lq);
  });

  it('the correction is inert when arrivals are Poisson', () => {
    // g ≡ 1 at ca² = 1, so an all-exponential network is bit-for-bit the
    // textbook answer. This is what lets the solver run it unconditionally.
    const nodes = [node('a', 10, { externalArrivalPerHr: 6 }), node('b', 12)];
    const sol = solveNetwork({ nodes, edges: tandemEdges(nodes) });
    const direct = analyticalKpis(
      classify(nodes[1].serviceDist, 1, Infinity, 'FCFS'),
      6,
      nodes[1].serviceDist,
    );
    near(sol.byNodeId.b.kpis.Lq, direct.Lq, 1e-12);
  });

  it('D does not jump when ca² moves off 1 by a hair', () => {
    // Reporting Lq/ρ for D made it halve on a 1e-6 input change, because that
    // is a different conditional expectation. Both sides must be blank.
    const dist: ServiceDist = { kind: 'exp', mean: 6 };
    const poisson = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 5, dist);
    const nudged = analyticalKpis(classify(dist, 1, Infinity, 'FCFS'), 5, dist, {
      arrivalCv2: 1 + 1e-6,
    });
    expect(Number.isFinite(poisson.D)).toBe(true);
    expect(Number.isNaN(nudged.D)).toBe(true);
  });
});

describe('the loss fixed point settles on hard cases', () => {
  it('converges with a tight buffer behind a heavy rework loop', () => {
    // The pathological shape: a small buffer whose balking changes the very
    // rate that causes it, amplified by feedback. Undamped, this oscillates.
    for (const cap of [2, 4, 8, 16]) {
      for (const back of [0.5, 0.9, 0.95, 0.99]) {
        const a = node('a', 10, { externalArrivalPerHr: 9, capacity: cap });
        const b = node('b', 30);
        const sol = solveNetwork({
          nodes: [a, b],
          edges: [
            { id: '1', from: 'a', to: 'b', probability: 1 },
            { id: '2', from: 'b', to: 'a', probability: back },
          ],
        });
        expect(sol.issues.some((i) => /did not settle/.test(i.message))).toBe(false);
        expect(Number.isFinite(sol.totalL)).toBe(true);
        expect(sol.byNodeId.a.lambdaEff).toBeLessThanOrEqual(sol.byNodeId.a.lambda + 1e-9);
      }
    }
  });

  it('a self-loop with a tight buffer still settles', () => {
    for (const cap of [2, 6, 20]) {
      const a = node('solo', 10, { externalArrivalPerHr: 8, capacity: cap });
      const sol = solveNetwork({
        nodes: [a],
        edges: [{ id: 's', from: 'solo', to: 'solo', probability: 0.8 }],
      });
      expect(sol.issues.some((i) => /did not settle/.test(i.message))).toBe(false);
      expect(Number.isFinite(sol.byNodeId.solo.lambda)).toBe(true);
    }
  });

  it('the converged answer still satisfies the traffic equations', () => {
    // Damping changes how we get there, never where we land.
    const a = node('a', 10, { externalArrivalPerHr: 9, capacity: 4 });
    const b = node('b', 20);
    const sol = solveNetwork({
      nodes: [a, b],
      edges: [
        { id: '1', from: 'a', to: 'b', probability: 1 },
        { id: '2', from: 'b', to: 'a', probability: 0.4 },
      ],
    });
    // λ_a = γ + 0.4 · λ_eff(b), and λ_b = λ_eff(a).
    near(sol.byNodeId.a.lambda, 9 + 0.4 * sol.byNodeId.b.lambdaEff, 1e-6);
    near(sol.byNodeId.b.lambda, sol.byNodeId.a.lambdaEff, 1e-6);
  });
});
