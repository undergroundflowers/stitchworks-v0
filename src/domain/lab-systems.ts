/**
 * Seed content for the Queue Lab — the textbook's own worked problems, plus
 * the shapes a sewing floor actually makes.
 *
 * The Lab must not open empty. A blank canvas asks the user to already know
 * what a queueing system looks like, which is the thing they came to find out.
 * Every system below is either a problem Naidu works through in Unit 5 (with
 * the page it appears on, so the printed answer can be checked against what
 * the Lab computes) or a network shape the textbook names but never solves.
 *
 * These are STARTING POINTS, not fixtures. The store copies them on first run
 * and the user owns them from then on — editing one is the point.
 */

import type { QueueEdge, QueueNode } from '../simulation/network';
import type { ServiceDist } from '../simulation/distributions';

export interface LabSystem {
  id: string;
  name: string;
  /** One line on what this system is for. Shown under the name in the list. */
  blurb: string;
  nodes: QueueNode[];
  edges: QueueEdge[];
  /** Textbook page, when this is a transcribed problem. */
  source?: string;
}

/**
 * Is this one of the starters, and therefore resettable?
 *
 * Membership by id, which editing cannot change — so "put it back the way the
 * textbook had it" stays available after you have experimented, which is the
 * only time anyone wants it.
 */
export function isSeedSystem(id: string): boolean {
  return SEED_SYSTEMS.some((s) => s.id === id);
}

/** μ per hour → the exponential service distribution the node holds, in minutes. */
const expAt = (muPerHr: number): ServiceDist => ({ kind: 'exp', mean: 60 / muPerHr });

function n(
  id: string,
  name: string,
  muPerHr: number,
  extra: Partial<QueueNode> = {},
): QueueNode {
  return {
    id,
    name,
    externalArrivalPerHr: 0,
    serviceDist: expAt(muPerHr),
    servers: 1,
    capacity: Infinity,
    discipline: 'FCFS',
    ...extra,
  };
}

function chain(nodes: QueueNode[]): QueueEdge[] {
  return nodes.slice(0, -1).map((node, i) => ({
    id: `${node.id}->${nodes[i + 1].id}`,
    from: node.id,
    to: nodes[i + 1].id,
    probability: 1,
  }));
}

// ── Model I — the canonical single server ───────────────────────────────────
const BOOTH: LabSystem = (() => {
  const node = n('booth', 'Telephone booth', 15, { externalArrivalPerHr: 7.5 });
  return {
    id: 'seed-mm1-booth',
    name: 'M/M/1 · telephone booth',
    blurb:
      'One server, unbounded queue. Arrivals every 8 min on average, calls last 4 min. '
      + 'The textbook’s worked Model I — ρ = 0.5, Lq = 0.5, W = 0.133 hr.',
    source: 'Naidu Unit 5, p.7',
    nodes: [node],
    edges: [],
  };
})();

// ── Model VII — multiple servers ────────────────────────────────────────────
const BANK: LabSystem = (() => {
  // μ = 60/18 = 3.33/hr from an 18-minute mean service time.
  const node = n('tellers', 'Cash counter', 60 / 18, {
    externalArrivalPerHr: 6,
    servers: 3,
  });
  return {
    id: 'seed-mmk-bank',
    name: 'M/M/3 · bank counter',
    blurb:
      'Three tellers sharing one queue. The textbook’s Model VII — P₀ = 0.145, '
      + 'Lq = 0.532, L = 2.334. Drop c to 1 and watch it collapse.',
    source: 'Naidu Unit 5, p.34',
    nodes: [node],
    edges: [],
  };
})();

// ── Model II — finite capacity, so arrivals are turned away ─────────────────
const CAPPED: LabSystem = (() => {
  const node = n('rack', 'Inspection with a 5-slot rack', 10, {
    externalArrivalPerHr: 12,
    capacity: 5,
  });
  return {
    id: 'seed-mm1n-capped',
    name: 'M/M/1/5 · a queue that turns work away',
    blurb:
      'Offered more than it can serve (ρ = 1.2) but the buffer holds only five, so it '
      + 'stays stable by losing work. Watch λ_eff fall below λ and P_N rise.',
    nodes: [node],
    edges: [],
  };
})();

// ── Model IV vs Model I — the same load, two service shapes ────────────────
const DETERMINISTIC: LabSystem = (() => {
  const node: QueueNode = {
    ...n('press', 'Fusing press', 10, { externalArrivalPerHr: 8 }),
    serviceDist: { kind: 'det', value: 6 },
  };
  return {
    id: 'seed-md1-press',
    name: 'M/D/1 · a machine with no variation',
    blurb:
      'A press takes exactly 6 min every time. Same ρ as the M/M/1 at the same load, '
      + 'but exactly half the queue — variability, not utilisation, is what builds Lq.',
    nodes: [node],
    edges: [],
  };
})();

// ── A tandem line — the shape the textbook names but never solves ──────────
const LINE: LabSystem = (() => {
  const nodes = [
    n('join', 'Shoulder join', 90, { externalArrivalPerHr: 60 }),
    n('sleeve', 'Sleeve attach', 72),
    n('side', 'Side seam', 66),
    n('hem', 'Body hem', 84),
  ];
  return {
    id: 'seed-tandem-line',
    name: 'Sewing line · four stations in sequence',
    blurb:
      'Bundles pass through every station in order. Each is solved at the rate it '
      + 'actually sees, and the network lead time is the whole path.',
    nodes,
    edges: chain(nodes),
  };
})();

// ── A rework loop — where visit ratios start to matter ─────────────────────
const REWORK: LabSystem = (() => {
  const sew = n('sew', 'Sew', 80, { externalArrivalPerHr: 50 });
  const check = n('check', 'Inspect', 200);
  return {
    id: 'seed-rework-loop',
    name: 'Rework loop · 15% sent back',
    blurb:
      'Inspection returns 15% of pieces to the sewing station. That is not a 15% '
      + 'problem: it raises the load on Sew by 17.6%, and the visit ratio says why.',
    nodes: [sew, check],
    edges: [
      { id: 'sew->check', from: 'sew', to: 'check', probability: 1 },
      { id: 'check->sew', from: 'check', to: 'sew', probability: 0.15 },
    ],
  };
})();

// ── A branch — two routes with different service ───────────────────────────
const BRANCH: LabSystem = (() => {
  const cut = n('cut', 'Cutting', 120, { externalArrivalPerHr: 90 });
  const heavy = n('heavy', 'Heavy seam', 40, { servers: 2 });
  const light = n('light', 'Light seam', 70);
  return {
    id: 'seed-branch',
    name: 'Branch · one feed, two routes',
    blurb:
      'Cutting splits 40/60 into a slow doubled-up station and a fast single one. '
      + 'The busier node is not the one with more work sent to it.',
    nodes: [cut, heavy, light],
    edges: [
      { id: 'cut->heavy', from: 'cut', to: 'heavy', probability: 0.4 },
      { id: 'cut->light', from: 'cut', to: 'light', probability: 0.6 },
    ],
  };
})();

/**
 * Bump when a system is ADDED to (or corrected in) the list below.
 *
 * The store persists the user's collection, and zustand replaces the
 * initialiser's array with the persisted one on hydration — so without a
 * version to compare against, anyone who has opened the Lab once would never
 * receive a starter system added later. Bumping this makes the store top up
 * the collection exactly once, while still respecting a seed the user deleted.
 */
export const SEED_VERSION = 1;

/** The systems the Lab opens with, in the order they are listed. */
export const SEED_SYSTEMS: LabSystem[] = [
  BOOTH,
  BANK,
  CAPPED,
  DETERMINISTIC,
  LINE,
  REWORK,
  BRANCH,
];

/** A blank single-node system, for "new system". */
export function blankSystem(id: string, name = 'New system'): LabSystem {
  return {
    id,
    name,
    blurb: '',
    nodes: [
      {
        id: `${id}-n1`,
        name: 'Station 1',
        externalArrivalPerHr: 6,
        serviceDist: { kind: 'exp', mean: 6 },
        servers: 1,
        capacity: Infinity,
        discipline: 'FCFS',
      },
    ],
    edges: [],
  };
}
