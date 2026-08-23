/**
 * Closed-form queueing-theory analytics for sewing-line workstations.
 *
 * The sewing line is modelled as an open **tandem queueing network**: bundles
 * arrive at the first station from cutting, then flow station-by-station
 * through the bulletin. Each workstation has a fixed number of operators
 * (servers), an optional buffer cap (cart / hanger / conveyor space), and a
 * service-time distribution.
 *
 * By Burke's theorem, an M/M/c station with ρ < 1 has a Poisson departure
 * process at the same rate, so the network decomposes into per-station
 * analyses for the all-exponential case. For non-exponential service (M/D/1,
 * M/G/1, M/Ek/1) Burke does not strictly hold, but observed-λ + closed-form
 * per-station KPIs remain a useful approximation against which to validate
 * the simulator's output.
 *
 * Formulas transcribed from Naidu's Operations Research, Unit 5 (the PDF the
 * user attached). Page references appear next to each model.
 */

import {
  cvOf,
  kendallServiceCode,
  meanOf,
  type ServiceCode,
  type ServiceDist,
} from './distributions';

export type QueueDiscipline = 'FCFS' | 'SIRO' | 'Priority';

/**
 * The one place the closed form and the simulator genuinely model different
 * systems, stated rather than hidden.
 *
 * Models II and VIII assume an arrival that finds the system full is LOST —
 * it balks and never comes back. A sewing floor does not lose bundles: the
 * upstream operator simply stops and holds, which is what the engine does at
 * every interior station. Balking is real only where the feeder cannot hold,
 * which on this floor means the Source at the head of the line.
 *
 * Consequence: at an interior station the closed-form λ_eff and P_N describe
 * loss the run does not have, and the run has upstream blocking the closed form
 * does not model. The two agree at the head of the line and diverge behind it.
 */
const BALKING_VS_BLOCKING =
  'Note that the textbook model turns a blocked arrival AWAY (balking), while '
  + 'the simulator holds it upstream (blocking) at every station except the '
  + 'line head — a full cart stops the previous operator rather than losing the '
  + 'bundle. Expect the two to agree at the first station and to diverge behind it.';

/** Arrival-process code — the `a` field of a/b/c:d/e. */
export type ArrivalCode = 'M' | 'G';

export interface KendallNotation {
  /**
   * Arrival process. `M` is the textbook's assumption everywhere: Poisson
   * arrivals, exponential gaps, squared coefficient of variation 1.
   *
   * `G` appears when a station sits INSIDE a network behind a non-exponential
   * node. Burke's theorem keeps departures Poisson only for M/M/c, so once a
   * deterministic or general-service node is upstream, what reaches the next
   * station is a general renewal stream and calling it M would be a lie.
   */
  arrival: ArrivalCode;
  service: ServiceCode;
  /** c — number of parallel servers (operators) at this workstation. */
  servers: number;
  /** N — system capacity. `Infinity` means unbounded queue. */
  capacity: number;
  discipline: QueueDiscipline;
  /** Pretty label, e.g. "M/M/3 : ∞/FCFS" or "M/D/1 : 8/FCFS". */
  label: string;
}

export interface AnalyticalKpis {
  /** Traffic intensity. For c servers: ρ = λ/(cμ). */
  rho: number;
  /** Probability of zero units in the system. */
  P0: number;
  /** Probability of exactly n units in the system. */
  Pn: (n: number) => number;
  /** Expected queue length (excluding those in service). */
  Lq: number;
  /** Expected wait time in queue (same time-unit as 1/μ). */
  Wq: number;
  /** Expected units in system (queue + in service). */
  L: number;
  /** Expected time in system (queue wait + service). */
  W: number;
  /**
   * Formula 9 — expected queue length counted only over the moments the queue
   * is not empty: E[queue | queue non-empty] = Lq / P(n ≥ c+1).
   *
   * Available for the exponential models, where Pₙ is elementary (Models I,
   * II, VII, VIII). NaN for the M/G/1 family and the M/G/c approximation:
   * the textbook prints D = μ/(μ−λ), but that expression is the ratio above
   * only under exponential service, so reusing it elsewhere would report a
   * confidently wrong number rather than an honest blank.
   */
  D: number;
  /**
   * Formula 4 — probability that **n or more** units are in the system.
   * The textbook notes that "more than n" means evaluating at n+1.
   */
  pNOrMore: (n: number) => number;
  /** ρ < 1 for infinite-queue models; always true for finite-capacity. */
  isStable: boolean;
  /**
   * Formula 11 — probability that an arrival waits longer than `w` in the
   * **queue**. `w` is in hours, matching 1/μ. NaN where no closed form exists.
   */
  pWaitGreaterThan: (w: number) => number;
  /**
   * Formula 12 — probability that an arrival spends longer than `v` in the
   * **system** (queue + service). Distinct from `pWaitGreaterThan`: the
   * textbook works these as two separate questions. `v` is in hours.
   */
  pSystemGreaterThan: (v: number) => number;
  /** Formula 10 — probability an arrival finds every server busy and queues. */
  pWait: number;
  /** Formula 13 — probability an arrival goes straight into service. */
  pNoWait: number;
  /**
   * Probability the system is full, so an arrival balks. Zero for the
   * unbounded models; P_N for the finite-capacity ones.
   */
  pBalk: number;
  /** The offered arrival rate λ this result was solved at. Kept so a surface
   *  can show offered vs admitted without re-deriving one from the other. */
  lambdaOffered: number;
  /** Effective arrival rate after balking (= λ for infinite-queue models). */
  lambdaEff: number;
  /**
   * Queue discipline this result was computed under. FCFS and SIRO share
   * every mean here — the textbook's Model III differs from Model I only in
   * the *distribution* of the wait, not in L, Lq, W or Wq — so the field is
   * carried for provenance and for the caveat the UI shows.
   */
  discipline: QueueDiscipline;
  /** Optional caveat for the UI (e.g. "approximation — not Burke-exact"). */
  note?: string;
}

/** Build a Kendall–Lee notation object from station configuration. */
export function classify(
  serviceDist: ServiceDist,
  servers: number,
  capacity: number,
  discipline: QueueDiscipline = 'FCFS',
  arrival: ArrivalCode = 'M',
): KendallNotation {
  const service = kendallServiceCode(serviceDist);
  const c = Math.max(1, Math.floor(servers));
  const cap = Number.isFinite(capacity) ? Math.max(c, Math.floor(capacity)) : Infinity;
  return {
    arrival,
    service,
    servers: c,
    capacity: cap,
    discipline,
    label: formatLabel(arrival, service, c, cap, discipline),
  };
}

function formatLabel(
  a: ArrivalCode,
  b: ServiceCode,
  c: number,
  cap: number,
  disc: QueueDiscipline,
): string {
  const capStr = Number.isFinite(cap) ? String(cap) : '∞';
  return `${a}/${b}/${c} : ${capStr}/${disc}`;
}

/**
 * Compute the full set of analytical KPIs for the classified station.
 * `lambda` is the *observed* arrival rate (bundles per hour) and is taken
 * from the sim's per-station arrival counter — that way the analytical
 * layer is fed real data, not the user-input value, which makes the
 * tandem-network case work correctly.
 */
export interface AnalyticalOpts {
  /**
   * Squared coefficient of variation of the ARRIVAL process, ca².
   *
   * 1 (the default) is Poisson — the textbook's assumption everywhere, and the
   * only case it states formulas for. Anything else means the arrivals are a
   * general renewal stream, which happens to a station sitting downstream of a
   * non-exponential node in a network, and switches the solver to the
   * Allen–Cunneen G/G/c approximation. Leaving it unset reproduces the previous
   * behaviour exactly.
   */
  arrivalCv2?: number;
}

export function analyticalKpis(
  notation: KendallNotation,
  lambda: number,
  serviceDist: ServiceDist,
  opts: AnalyticalOpts = {},
): AnalyticalKpis {
  const solved = solve(notation, lambda, serviceDist, opts);
  const kpis: AnalyticalKpis = { ...solved, lambdaOffered: lambda };
  // Stamp the discipline the caller classified under. Model III (SIRO) shares
  // every mean with Model I — random order changes who waits, not how long the
  // average wait is — so the same solution is correct under either, and the
  // note tells the user which of the two questions the numbers answer.
  if (notation.discipline === 'FCFS') return { ...kpis, discipline: 'FCFS' };
  return {
    ...kpis,
    discipline: notation.discipline,
    note: [kpis.note, disciplineNote(notation.discipline)].filter(Boolean).join(' '),
  };
}

/**
 * The textbook's caveat, made explicit: a non-FCFS discipline leaves the
 * averages untouched but changes the spread of individual waits, so the
 * waiting-time *probabilities* (formulas 11 and 12) no longer apply as printed.
 */
function disciplineNote(d: QueueDiscipline): string {
  if (d === 'SIRO') {
    return 'SIRO (Model III): random order gives the same ρ, L, Lq, W and Wq as FCFS — only the spread of individual waits differs, so P(Wq>w) and P(W>v) are FCFS values.';
  }
  return 'Priority discipline: means shown are the FCFS values. Priority redistributes waiting between classes without changing the pooled averages.';
}

function solve(
  notation: KendallNotation,
  lambda: number,
  serviceDist: ServiceDist,
  opts: AnalyticalOpts = {},
): AnalyticalKpis {
  const meanSvc = meanOf(serviceDist);
  const mu = meanSvc > 0 ? 60 / meanSvc : 0; // per-hour
  const c = notation.servers;
  const cap = notation.capacity;
  const ca2 = opts.arrivalCv2 ?? 1;

  // Guard against degenerate inputs.
  if (mu <= 0 || lambda < 0) {
    return zeroKpis(0);
  }

  // Non-Poisson arrivals put us outside every model the textbook states. Rather
  // than run an M/… formula on a stream that is not M, take the G/G/c branch,
  // which reduces to exactly the textbook answer at ca² = 1 and is honest about
  // what it cannot tell you.
  if (Math.abs(ca2 - 1) > 1e-9 && !Number.isFinite(cap)) {
    return ggc(lambda, mu, c, cvOf(serviceDist), ca2);
  }

  // Branch on (service-code, server count, capacity).
  //
  // The finite-capacity branch deliberately ignores the service code: the
  // textbook names only M/M/1:N (Model II) and M/M/K:N (Model VIII), and there
  // is no closed form for M/D/1:N or M/G/1:N to switch to. Rather than solve a
  // different model than the label claims, we solve the exponential one and
  // say plainly that we did.
  if (Number.isFinite(cap) && cap < Infinity) {
    const finite = c === 1 ? mm1n(lambda, mu, cap) : mmcN(lambda, mu, c, cap);
    if (notation.service === 'M') return finite;
    return {
      ...finite,
      note: [
        finite.note,
        `Service is ${notation.service}, but the textbook gives no finite-capacity`
        + ` formula for it — these numbers solve the exponential M/M/${c}/${cap}`
        + ' at the same mean. Treat the simulation as authoritative.',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  // Infinite-queue branch.
  if (c === 1) {
    switch (notation.service) {
      case 'M':  return mm1(lambda, mu);
      case 'D':  return md1(lambda, mu);
      case 'Ek': return mEk1(lambda, mu, erlangShape(serviceDist));
      case 'G':  return mg1(lambda, mu, cvOf(serviceDist));
    }
  }
  // Multi-server, infinite queue. We have closed-forms for M/M/c only;
  // for M/D/c, M/Ek/c, M/G/c we fall back to an M/G/c approximation.
  if (notation.service === 'M') return mmc(lambda, mu, c);
  return mgcApprox(lambda, mu, c, cvOf(serviceDist));
}

/**
 * The subset every model computes directly. `complete()` derives the rest —
 * the probability questions the textbook asks as separate sub-problems — so
 * a model only has to supply a closed form where it actually has one.
 */
type KpiCore = Omit<
  AnalyticalKpis,
  | 'pNOrMore'
  | 'pSystemGreaterThan'
  | 'pWait'
  | 'pNoWait'
  | 'pBalk'
  | 'discipline'
  // Stamped once by `analyticalKpis`, which is the only place that knows the
  // offered λ; individual models only ever see it as a parameter.
  | 'lambdaOffered'
>;

type KpiExtras = Partial<
  Pick<AnalyticalKpis, 'pNOrMore' | 'pSystemGreaterThan' | 'pWait' | 'pNoWait' | 'pBalk' | 'discipline'>
>;

/**
 * Fill in formulas 4, 10, 12 and 13 from what the model already knows.
 *
 * - **Formula 10, P(wait).** The textbook works this two ways: `1 − P₀` for
 *   the single server (Model I), and `1 − P₀ − P₁ − …` up to K−1 for the
 *   multi-server (its telephone-exchange problem with K=2). Both are the same
 *   statement — an arrival waits exactly when every server is busy — so the
 *   general form below covers each. Single-server takes the `1 − P₀` path
 *   because M/G/1 has no elementary Pₙ to sum.
 * - **Formula 13** is the complement, so it is never computed twice.
 * - **Formula 4, P(≥n).** Defaults to summing the tail of Pₙ; models with a
 *   closed form (M/M/1's `(λ/μ)ⁿ`) pass it in and skip the sum.
 */
function complete(core: KpiCore, servers: number, extras: KpiExtras = {}): AnalyticalKpis {
  const pWait =
    extras.pWait ??
    (servers === 1 ? 1 - core.P0 : 1 - sumPn(core.Pn, 0, servers - 1));
  return {
    ...core,
    // Overwritten with the true offered rate by `analyticalKpis`; the fallback
    // is correct for every unbounded model, where nothing balks.
    lambdaOffered: core.lambdaEff,
    pNOrMore: extras.pNOrMore ?? ((n) => tailSum(core.Pn, n)),
    pSystemGreaterThan: extras.pSystemGreaterThan ?? (() => NaN),
    pWait,
    pNoWait: extras.pNoWait ?? 1 - pWait,
    pBalk: extras.pBalk ?? 0,
    discipline: extras.discipline ?? 'FCFS',
  };
}

/** Σ Pₙ over [from, to]. Returns NaN if the model has no elementary Pₙ. */
function sumPn(Pn: (n: number) => number, from: number, to: number): number {
  let acc = 0;
  for (let n = from; n <= to; n++) {
    const p = Pn(n);
    if (!Number.isFinite(p)) return NaN;
    acc += p;
  }
  return acc;
}

/**
 * P(≥n) as 1 − Σ_{i<n} Pᵢ. Computed from the head rather than the tail so it
 * terminates on the unbounded models, where the tail is infinite.
 */
function tailSum(Pn: (n: number) => number, n: number): number {
  if (n <= 0) return 1;
  const head = sumPn(Pn, 0, n - 1);
  if (!Number.isFinite(head)) return NaN;
  return Math.max(0, Math.min(1, 1 - head));
}

function zeroKpis(rho: number): AnalyticalKpis {
  return complete({
    rho,
    P0: 1,
    Pn: () => 0,
    Lq: 0,
    Wq: 0,
    L: 0,
    W: 0,
    D: NaN,
    isStable: false,
    pWaitGreaterThan: () => 0,
    lambdaEff: 0,
  }, 1, { pWait: 0, pNoWait: 1, pNOrMore: (n) => (n <= 0 ? 1 : 0) });
}

function erlangShape(d: ServiceDist): number {
  return d.kind === 'erlang' ? Math.max(1, Math.floor(d.k)) : 1;
}

// ── Model I — M/M/1 : ∞ / FCFS (Naidu page 4–6) ───────────────────────────
function mm1(lambda: number, mu: number): AnalyticalKpis {
  const rho = lambda / mu;
  const stable = rho < 1;
  if (!stable) {
    // System explodes; surface infinities so the UI flags it.
    return complete({
      rho,
      P0: 0,
      Pn: () => 0,
      Lq: Infinity,
      Wq: Infinity,
      L: Infinity,
      W: Infinity,
      D: Infinity,
      isStable: false,
      pWaitGreaterThan: () => 1,
      lambdaEff: lambda,
      note: 'Unstable: ρ ≥ 1 means the queue grows without bound.',
    }, 1, { pWait: 1, pNoWait: 0, pNOrMore: () => 1, pSystemGreaterThan: () => 1 });
  }
  const P0 = 1 - rho;
  const Lq = (lambda * lambda) / (mu * (mu - lambda));
  // λ = 0 is a real state, not an error: a station upstream of any arrivals,
  // or one inspected before the run starts. Little's law gives Wq = Lq/λ = 0/0
  // there; the limit is 0 (nothing waits because nothing arrives), and taking
  // the division literally propagated NaN through W and blanked the panel.
  const Wq = lambda > 0 ? Lq / lambda : 0;
  const L = Lq + rho;
  const W = Wq + 1 / mu;
  return complete(
    {
      rho,
      P0,
      // Formula 3.
      Pn: (n) => (n < 0 ? 0 : P0 * Math.pow(rho, n)),
      Lq,
      Wq,
      L,
      W,
      // Formula 9 — expected size of the queue counted only while non-empty.
      D: mu / (mu - lambda),
      isStable: true,
      // Formula 11 — wait in the QUEUE exceeds w.
      pWaitGreaterThan: (w) => (w <= 0 ? rho : rho * Math.exp((lambda - mu) * w)),
      lambdaEff: lambda,
    },
    1,
    {
      // Formula 4 — closed form, so no summation.
      pNOrMore: (n) => (n <= 0 ? 1 : Math.pow(rho, n)),
      // Formula 12 — time in the SYSTEM exceeds v. Note the missing λ/μ
      // factor relative to formula 11: an arrival always spends *some* time
      // in the system, so the system-time tail starts from 1, not from ρ.
      pSystemGreaterThan: (v) => (v <= 0 ? 1 : Math.exp((lambda - mu) * v)),
      // Formulas 10 and 13.
      pWait: rho,
      pNoWait: P0,
    },
  );
}

// ── Model II — M/M/1/N (Naidu page 4, finite-capacity) ────────────────────
function mm1n(lambda: number, mu: number, N: number): AnalyticalKpis {
  const rho = lambda / mu;
  let P0: number;
  let PN: number;
  const Pn = (n: number): number => {
    if (n < 0 || n > N) return 0;
    if (rho === 1) return 1 / (N + 1);
    return ((1 - rho) * Math.pow(rho, n)) / (1 - Math.pow(rho, N + 1));
  };
  if (rho === 1) {
    P0 = 1 / (N + 1);
    PN = 1 / (N + 1);
  } else {
    P0 = (1 - rho) / (1 - Math.pow(rho, N + 1));
    PN = P0 * Math.pow(rho, N);
  }
  const lambdaEff = lambda * (1 - PN);
  let L: number;
  if (rho === 1) {
    L = N / 2;
  } else {
    const num = rho * (1 - (N + 1) * Math.pow(rho, N) + N * Math.pow(rho, N + 1));
    const den = (1 - rho) * (1 - Math.pow(rho, N + 1));
    L = num / den;
  }
  const Lq = L - (1 - P0);
  const Wq = lambdaEff > 0 ? Lq / lambdaEff : 0;
  const W = lambdaEff > 0 ? L / lambdaEff : 0;
  return complete(
    {
      rho,
      P0,
      Pn,
      Lq,
      Wq,
      L,
      W,
      // Formula 9 is a Model I result: D = μ/(μ−λ) comes from the untruncated
      // geometric chain and diverges at ρ ≥ 1, which a finite buffer makes
      // perfectly stable. Compute the definition directly instead —
      // D = E[queue | queue non-empty] = Lq / P(queue non-empty).
      D: nonEmptyQueueSize(Lq, Pn, N, 1),
      isStable: true,
      pWaitGreaterThan: () => NaN,
      lambdaEff,
      note:
        `Finite buffer N=${N} (Model II). Balking probability ${(PN * 100).toFixed(2)}%. `
        + 'The waiting-time formulas 11 and 12 are stated for the unbounded '
        + 'queue only, so they are not reported here. '
        + BALKING_VS_BLOCKING,
    },
    1,
    {
      pBalk: PN,
      // Formula 10 conditioned on actually joining: an arrival that finds the
      // system full balks, so it never waits. Renormalising by (1 − P_N) keeps
      // P(wait) + P(no wait) = 1 over *admitted* arrivals, which is the
      // population Wq describes.
      pWait: PN < 1 ? Math.min(1, (1 - P0 - PN) / (1 - PN)) : 0,
    },
  );
}

/**
 * Expected queue length counted only over the moments the queue is not empty —
 * the textbook's formula 9, evaluated from its definition rather than from the
 * M/M/1 closed form.
 *
 * D = Lq / P(at least one unit waiting) = Lq / P(n ≥ c + 1).
 * Returns NaN when the model has no elementary Pₙ to sum.
 */
function nonEmptyQueueSize(
  Lq: number,
  Pn: (n: number) => number,
  N: number,
  c: number,
): number {
  let idle = 0;
  for (let n = 0; n <= Math.min(N, c); n++) {
    const p = Pn(n);
    if (!Number.isFinite(p)) return NaN;
    idle += p;
  }
  const busyQueue = 1 - idle;
  // Epsilon, not `> 0`: at N = c the queue can never form, and both Lq and
  // busyQueue degenerate to ~5e-17 of OPPOSITE sign, which would otherwise
  // yield a negative expected queue length.
  if (busyQueue <= 1e-12) return 0;
  return Math.max(0, Lq) / busyQueue;
}

// ── Model IV — M/D/1 : ∞ / FCFS (Pollaczek-Khinchine, Cs=0) ───────────────
function md1(lambda: number, mu: number): AnalyticalKpis {
  const rho = lambda / mu;
  if (rho >= 1) return unstableSingle(rho, lambda);
  const Lq = (rho * rho) / (2 * (1 - rho));
  return finalizeSingle(rho, lambda, mu, Lq, {
    note: 'M/D/1 — deterministic service. Lq is exactly half of the M/M/1 value at the same ρ.',
  });
}

// ── Model V — M/G/1 : ∞ / FCFS (Pollaczek-Khinchine, general Cs) ──────────
function mg1(lambda: number, mu: number, cs: number): AnalyticalKpis {
  const rho = lambda / mu;
  if (rho >= 1) return unstableSingle(rho, lambda);
  const Lq = (rho * rho * (1 + cs * cs)) / (2 * (1 - rho));
  return finalizeSingle(rho, lambda, mu, Lq, {
    note: `M/G/1 — general service with Cs=${cs.toFixed(2)}. Uses the Pollaczek-Khinchine formula.`,
  });
}

// ── Model VI — M/Ek/1 : ∞ / FCFS (Erlang-k service) ───────────────────────
function mEk1(lambda: number, mu: number, k: number): AnalyticalKpis {
  const rho = lambda / mu;
  if (rho >= 1) return unstableSingle(rho, lambda);
  // Erlang-k has Cs² = 1/k. P-K reduces to:
  const Lq = (rho * rho * (1 + 1 / k)) / (2 * (1 - rho));
  return finalizeSingle(rho, lambda, mu, Lq, {
    note: `M/E_${k}/1 — Erlang-${k} service. As k → ∞, behaviour approaches M/D/1.`,
  });
}

/**
 * Kraemer–Langenbach-Belz correction to Allen–Cunneen.
 *
 * Plain Allen–Cunneen is badly biased at light load when the arrivals are
 * steadier than Poisson — exactly the tandem case this app cares about, where
 * a deterministic station feeds the next one. Measured against the exact
 * GI/M/1 for D/M/1:
 *
 *     ρ      exact Lq     A–C        A–C error     with KLB
 *     0.20    0.00141     0.02500     +1679%        +23.6%
 *     0.50    0.12750     0.25000       +96%         +0.7%
 *     0.80    1.35418     1.60000       +18%         +0.0%
 *
 * Without it `network.ts` would still overstate the queue by 2× on the
 * deterministic-feed tandem while its own comment claims to have fixed that.
 *
 * g is identically 1 at ca² = 1 in both branches, so every Poisson-arrival
 * result — which is every model the textbook states — is untouched.
 */
function klbFactor(rho: number, ca2: number, cs2: number): number {
  if (ca2 < 1) {
    const denom = ca2 + cs2;
    if (denom <= 0 || rho <= 0) return 1;
    return Math.exp((-2 * (1 - rho) * Math.pow(1 - ca2, 2)) / (3 * rho * denom));
  }
  const denom = ca2 + 4 * cs2;
  if (denom <= 0) return 1;
  return Math.exp((-(1 - rho) * (ca2 - 1)) / denom);
}

/**
 * G/G/c — general arrivals AND general service, via Allen–Cunneen.
 *
 *     Lq(G/G/c) ≈ Lq(M/M/c) · (ca² + cs²) / 2
 *
 * The textbook states nothing for this class: every one of its eight models
 * opens with M. It is reached only from the network solver, where a station
 * behind a deterministic or general-service node genuinely stops seeing
 * Poisson arrivals and pretending otherwise would understate its queue.
 *
 * At ca² = cs² = 1 the factor is exactly 1 and this reproduces M/M/c, which is
 * why the network solver can route every node through the same call without
 * special-casing the all-exponential network.
 *
 * Only the MEANS are approximated. The state probabilities and the waiting-time
 * tails have no counterpart here, so they are blank rather than borrowed from
 * M/M/c — the same rule the M/G/c branch follows.
 */
function ggc(
  lambda: number,
  mu: number,
  c: number,
  cs: number,
  ca2: number,
): AnalyticalKpis {
  const base = mmc(lambda, mu, c);
  if (!base.isStable) return base;
  const cs2 = cs * cs;
  const Lq = base.Lq * ((ca2 + cs2) / 2) * klbFactor(base.rho, ca2, cs2);
  const L = Lq + lambda / mu;
  const Wq = lambda > 0 ? Lq / lambda : 0;
  const W = Wq + 1 / mu;
  const ca = Math.sqrt(Math.max(0, ca2));
  return {
    ...base,
    Lq,
    L,
    Wq,
    W,
    Pn: () => NaN,
    pNOrMore: () => NaN,
    pWaitGreaterThan: () => NaN,
    pSystemGreaterThan: () => NaN,
    // NOT Lq/ρ. That is E[queue | server busy], which equals D only for
    // M/M/1, so printing it here made D jump 2× the instant ca² moved off 1
    // by 1e-6. No elementary Pₙ exists in this class, so there is no honest
    // denominator — same refusal as finalizeSingle.
    D: NaN,
    note:
      `G/G/${c} — arrivals are not Poisson (Ca=${ca.toFixed(2)}), so this is outside every `
      + 'model the textbook states. Means come from Allen–Cunneen with the '
      + 'Kraemer–Langenbach-Belz correction; the state probabilities and waiting-time '
      + 'tails have no closed form here.',
  };
}

// ── Model VII — M/M/c : ∞ / FCFS (Erlang-C / multi-server) ────────────────
function mmc(lambda: number, mu: number, c: number): AnalyticalKpis {
  const a = lambda / mu; // offered load (in Erlangs)
  const rho = a / c;
  if (rho >= 1) return unstableMulti(rho, lambda, c);

  // P0 = 1 / [Σ_{n=0..c-1} a^n/n!   +   a^c/c! · 1/(1-ρ)]
  let sumLow = 0;
  for (let n = 0; n < c; n++) sumLow += Math.pow(a, n) / factorial(n);
  const tailTerm = (Math.pow(a, c) / factorial(c)) * (1 / (1 - rho));
  const P0 = 1 / (sumLow + tailTerm);

  // Lq = (P0 · a^c · ρ) / (c! · (1-ρ)²)
  const Lq = (P0 * Math.pow(a, c) * rho) / (factorial(c) * Math.pow(1 - rho, 2));
  const L = Lq + a;
  const Wq = lambda > 0 ? Lq / lambda : 0; // see the λ = 0 note in mm1()
  const W = Wq + 1 / mu;

  const Pn = (n: number): number => {
    if (n < 0) return 0;
    if (n <= c) return (P0 * Math.pow(a, n)) / factorial(n);
    return (P0 * Math.pow(a, c) / factorial(c)) * Math.pow(rho, n - c);
  };

  // Erlang-C: probability all c servers are busy, so an arrival queues. This
  // is the textbook's `1 − P₀ − P₁ − … − P_{K−1}` written in closed form, and
  // it also gives the waiting-time tail (formulas 11 and 12) for c > 1, which
  // the PDF states only for the single server.
  const erlangC = (P0 * Math.pow(a, c)) / (factorial(c) * (1 - rho));

  return complete(
    {
      rho,
      P0,
      Pn,
      Lq,
      Wq,
      L,
      W,
      D: NaN,
      isStable: true,
      pWaitGreaterThan: (w) =>
        w <= 0 ? erlangC : erlangC * Math.exp(-(c * mu - lambda) * w),
      lambdaEff: lambda,
      note: `M/M/${c} — ${c} parallel servers. ρ = λ/(cμ) = ${rho.toFixed(2)}.`,
    },
    c,
    {
      pWait: erlangC,
      pNoWait: 1 - erlangC,
      pSystemGreaterThan: (v) => {
        if (v <= 0) return 1;
        // Standard M/M/c system-time tail. Reduces to the PDF's formula 12,
        // e^((λ−μ)v), at c = 1.
        const denom = c * mu - lambda - mu;
        if (Math.abs(denom) < 1e-9) {
          return Math.exp(-mu * v) * (1 + erlangC * mu * v);
        }
        return (
          Math.exp(-mu * v) *
          (1 + (erlangC * (1 - Math.exp(-denom * v)) * mu) / denom)
        );
      },
    },
  );
}

// ── Model VIII — M/M/c/N : finite-capacity multi-server ───────────────────
function mmcN(lambda: number, mu: number, c: number, N: number): AnalyticalKpis {
  const a = lambda / mu;
  const rho = a / c;

  // P0 normalization: Σ_{n=0..c-1} a^n/n!   +   (a^c/c!) · Σ_{n=c..N} ρ^(n-c)
  let sumLow = 0;
  for (let n = 0; n < c; n++) sumLow += Math.pow(a, n) / factorial(n);
  let tailSum: number;
  if (Math.abs(rho - 1) < 1e-9) {
    tailSum = N - c + 1;
  } else {
    tailSum = (1 - Math.pow(rho, N - c + 1)) / (1 - rho);
  }
  const tailTerm = (Math.pow(a, c) / factorial(c)) * tailSum;
  const P0 = 1 / (sumLow + tailTerm);

  const Pn = (n: number): number => {
    if (n < 0 || n > N) return 0;
    if (n <= c) return (P0 * Math.pow(a, n)) / factorial(n);
    return (P0 * Math.pow(a, c) / factorial(c)) * Math.pow(rho, n - c);
  };

  // Lq = Σ_{n=c+1..N} (n-c)·Pn
  let Lq = 0;
  for (let n = c + 1; n <= N; n++) Lq += (n - c) * Pn(n);

  // Expected idle servers = Σ_{n=0..c-1} (c-n)·Pn  → busy = c - idle  → L = Lq + busy
  let idle = 0;
  for (let n = 0; n < c; n++) idle += (c - n) * Pn(n);
  const busy = c - idle;
  const L = Lq + busy;

  const PN = Pn(N);
  const lambdaEff = lambda * (1 - PN);
  const Wq = lambdaEff > 0 ? Lq / lambdaEff : 0;
  const W = lambdaEff > 0 ? L / lambdaEff : 0;

  return complete(
    {
      rho,
      P0,
      Pn,
      Lq,
      Wq,
      L,
      W,
      D: nonEmptyQueueSize(Lq, Pn, N, c),
      isStable: true,
      pWaitGreaterThan: () => NaN,
      lambdaEff,
      note:
        `M/M/${c}/${N} (Model VIII) — finite buffer. Balking probability `
        + `${(PN * 100).toFixed(2)}%. The waiting-time formulas 11 and 12 are `
        + 'stated for the unbounded queue only, so they are not reported here. '
        + BALKING_VS_BLOCKING,
    },
    c,
    {
      pBalk: PN,
      // See the note in mm1n: condition on being admitted.
      pWait: PN < 1 ? Math.min(1, (1 - sumPn(Pn, 0, c - 1) - PN) / (1 - PN)) : 0,
    },
  );
}

// ── M/G/c approximation (no closed form in Naidu) ─────────────────────────
function mgcApprox(lambda: number, mu: number, c: number, cs: number): AnalyticalKpis {
  // Allen-Cunneen approximation: Lq(M/G/c) ≈ Lq(M/M/c) · (1 + Cs²)/2
  const mm = mmc(lambda, mu, c);
  if (!mm.isStable) return mm;
  const factor = (1 + cs * cs) / 2;
  const Lq = mm.Lq * factor;
  const L = Lq + lambda / mu;
  const Wq = lambda > 0 ? Lq / lambda : 0; // see the λ = 0 note in mm1()
  const W = Wq + 1 / mu;
  return {
    ...mm,
    Lq,
    L,
    Wq,
    W,
    // Allen–Cunneen scales the MEANS. It says nothing about the state
    // probabilities or the waiting-time tails, and the textbook gives no
    // formula for this class at all, so reporting the M/M/c values for them
    // would be inventing numbers. P0 / P(wait) / P(no wait) are kept: the
    // approximation is *defined* on the Erlang-C busy probability, which is
    // exactly those quantities.
    Pn: () => NaN,
    pNOrMore: () => NaN,
    pWaitGreaterThan: () => NaN,
    pSystemGreaterThan: () => NaN,
    // See the note in ggc(): Lq/ρ is a different conditional expectation.
    D: NaN,
    note:
      `M/G/${c} — approximation (Allen–Cunneen), Cs=${cs.toFixed(2)}. The `
      + 'textbook states no multi-server formula for general service, so only '
      + 'the means are reported here; the simulation is the authoritative value.',
  };
}

// ── Helpers shared by single-server M/G/1-family models ───────────────────
function finalizeSingle(
  rho: number,
  lambda: number,
  mu: number,
  Lq: number,
  extras: { note?: string; D?: number } = {},
): AnalyticalKpis {
  const Wq = lambda > 0 ? Lq / lambda : 0; // see the λ = 0 note in mm1()
  const L = Lq + rho;
  const W = Wq + 1 / mu;
  return complete(
    {
      rho,
      P0: 1 - rho,
      Pn: () => NaN, // closed-form Pₙ depends on the service distribution — not generic for M/G/1
      Lq,
      Wq,
      L,
      W,
      // Formula 9 is a Model I result. D means E[queue | queue non-empty] =
      // Lq / P(n ≥ 2), and μ/(μ−λ) equals that ratio only because M/M/1
      // happens to pair Lq = ρ²/(1−ρ) with P(n ≥ 2) = ρ². M/D/1 and M/Ek/1
      // have a different Lq AND a different P(n ≥ 2), and no elementary Pₙ to
      // compute the denominator from, so there is no honest number to print:
      // reusing the M/M/1 expression reported D = 5.00 for an M/D/1 station
      // whose Lq was half the M/M/1 value. NaN renders as "—".
      D: extras.D ?? NaN,
      isStable: true,
      pWaitGreaterThan: () => NaN,
      lambdaEff: lambda,
      note: extras.note,
    },
    1,
    // P(wait) is still exact for any M/G/1: an arrival waits exactly when the
    // single server is busy, which is ρ regardless of the service shape. Only
    // the *distribution* questions (formulas 4, 11, 12) need an elementary Pₙ,
    // and those stay NaN here rather than being faked.
    { pWait: rho, pNoWait: 1 - rho, pNOrMore: () => NaN },
  );
}

function unstableSingle(rho: number, lambda: number): AnalyticalKpis {
  return complete({
    rho,
    P0: 0,
    Pn: () => 0,
    Lq: Infinity,
    Wq: Infinity,
    L: Infinity,
    W: Infinity,
    D: Infinity,
    isStable: false,
    pWaitGreaterThan: () => 1,
    lambdaEff: lambda,
    note: 'Unstable: ρ ≥ 1 in an infinite-buffer model means the queue grows without bound.',
  }, 1, { pWait: 1, pNoWait: 0, pNOrMore: () => 1, pSystemGreaterThan: () => 1 });
}

function unstableMulti(rho: number, lambda: number, c: number): AnalyticalKpis {
  return complete({
    rho,
    P0: 0,
    Pn: () => 0,
    Lq: Infinity,
    Wq: Infinity,
    L: Infinity,
    W: Infinity,
    D: NaN,
    isStable: false,
    pWaitGreaterThan: () => 1,
    lambdaEff: lambda,
    note: `Unstable: ρ = λ/(${c}μ) ≥ 1. Add more servers or reduce arrival rate.`,
  }, c, { pWait: 1, pNoWait: 0, pNOrMore: () => 1, pSystemGreaterThan: () => 1 });
}

// ── Factorial for the multi-server formulas. c is small (rarely > 20), so
// caching a small lookup table is enough; no need for Stirling. ───────────
const FACT_CACHE: number[] = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
function factorial(n: number): number {
  if (n < 0) return NaN;
  if (n < FACT_CACHE.length) return FACT_CACHE[n];
  let v = FACT_CACHE[FACT_CACHE.length - 1];
  for (let i = FACT_CACHE.length; i <= n; i++) {
    v *= i;
    FACT_CACHE[i] = v;
  }
  return v;
}
