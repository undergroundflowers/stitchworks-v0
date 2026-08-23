/**
 * Kendall–Lee symbol vocabulary — one source of truth for the mathematical
 * notation the UI shows beside its fields.
 *
 * Every queueing quantity the app surfaces has exactly one symbol here, taken
 * from Naidu's *Operations Research* Unit 5 (the textbook this model follows).
 * Surfaces import the symbol rather than hard-coding a Greek letter, so the
 * Builder Inspector, the Sim station drawer, the Queue Analytics tables and
 * the report all name the same quantity the same way.
 *
 * ── Why symbols are data and not just text in a label ──────────────────────
 * Field labels across the app render through `textTransform: 'uppercase'`.
 * CSS uppercasing is not a no-op on this vocabulary: it turns λ into Λ, μ into
 * Μ, ρ into Ρ, and Lq into LQ — all of which are either a different symbol or
 * nonsense. So a symbol must never be baked into a label string; it is carried
 * separately and rendered by `<Sym>` (see components/Sym.tsx), which opts out
 * of the inherited transform.
 */

/** Every quantity in the textbook that the app can show. */
export type QuantityId =
  // ── Kendall–Lee parameters (the things a user authors) ──
  | 'lambda'
  | 'mu'
  | 'servers'
  | 'capacity'
  | 'discipline'
  | 'serviceTime'
  | 'erlangK'
  | 'cs'
  | 'sigma'
  // ── Derived steady-state measures (the things the model reports) ──
  | 'rho'
  | 'P0'
  | 'Pn'
  | 'PnOrMore'
  | 'Lq'
  | 'L'
  | 'Wq'
  | 'W'
  | 'D'
  | 'pWait'
  | 'pNoWait'
  | 'pWqGt'
  | 'pWGt'
  | 'lambdaEff'
  | 'pBalk'
  | 'n';

export interface Quantity {
  /** The symbol as the textbook prints it, e.g. 'λ' or 'Lq'. */
  symbol: string;
  /**
   * Trailing subscript, split out so `<Sym>` can render it as a real
   * subscript instead of relying on the ₙ/q lookalike codepoints, which are
   * missing from the mono face at small sizes.
   */
  sub?: string;
  /** Plain-English name used as the field label itself. */
  name: string;
  /** Unit suffix for the value, where the quantity has one. */
  unit?: string;
  /** The textbook's own wording — shown on hover so the symbol is teachable. */
  gloss: string;
  /** Formula as the PDF prints it, where the PDF gives one. */
  formula?: string;
}

export const QUANTITY: Record<QuantityId, Quantity> = {
  // ── Parameters ───────────────────────────────────────────────────────────
  lambda: {
    symbol: 'λ',
    name: 'Arrival rate',
    unit: '/hr',
    gloss: 'Mean arrival rate. Bundles reaching this station per hour. Arrivals are Poisson, so inter-arrival times are exponential.',
  },
  mu: {
    symbol: 'μ',
    name: 'Service rate',
    unit: '/hr',
    gloss: 'Mean service rate — bundles one server can finish per hour. μ = 60 / SMV.',
    formula: 'μ = 60 / SMV',
  },
  servers: {
    symbol: 'c',
    name: 'Servers',
    gloss: 'Parallel service channels at this facility — the operators working the station side by side. Written K in the textbook’s multi-server model.',
  },
  capacity: {
    symbol: 'N',
    name: 'Capacity',
    gloss: 'Maximum units the system holds, in service plus waiting. A full buffer turns arrivals away (balking). ∞ means an unbounded buffer.',
  },
  discipline: {
    symbol: 'e',
    name: 'Discipline',
    gloss: 'Order in which waiting units are picked for service — the fifth field of Kendall–Lee a/b/c:d/e.',
  },
  serviceTime: {
    // Written as the fraction the textbook prints, not as a subscript: the
    // quantity is one over the service rate.
    symbol: '1/μ',
    name: 'Service time',
    unit: 'min',
    gloss: 'Mean time one server takes on one bundle — the reciprocal of the service rate.',
  },
  erlangK: {
    symbol: 'k',
    name: 'Erlang phases',
    gloss: 'Number of exponential phases in Erlang-k service. k = 1 is exponential; k → ∞ approaches deterministic.',
  },
  cs: {
    symbol: 'C',
    sub: 's',
    name: 'Service variability',
    gloss: 'Coefficient of variation of service time (std ÷ mean). 0 for deterministic, 1 for exponential. Drives the Pollaczek–Khinchine queue length.',
  },
  sigma: {
    symbol: 'σ',
    name: 'Std deviation',
    unit: 'min',
    gloss: 'Standard deviation of the service time.',
  },

  // ── Derived measures ─────────────────────────────────────────────────────
  rho: {
    symbol: 'ρ',
    name: 'Utilisation',
    gloss: 'Traffic intensity / busy-period fraction. Must stay below 1 for an unbounded queue to be stable.',
    formula: 'ρ = λ / (cμ)',
  },
  P0: {
    symbol: 'P',
    sub: '0',
    name: 'Idle probability',
    gloss: 'Probability of exactly zero units in the system — also the probability an arrival need not wait.',
    formula: 'P₀ = 1 − λ/μ',
  },
  Pn: {
    symbol: 'P',
    sub: 'n',
    name: 'Probability of n in system',
    gloss: 'Probability that exactly n units are in the system.',
    formula: 'Pₙ = P₀ (λ/μ)ⁿ',
  },
  PnOrMore: {
    symbol: 'P',
    sub: '≥n',
    name: 'Probability of n or more',
    gloss: 'Probability that n or more units are in the system. For “more than n”, use n + 1.',
    formula: 'P(≥n) = (λ/μ)ⁿ',
  },
  Lq: {
    symbol: 'L',
    sub: 'q',
    name: 'Queue length',
    unit: 'bundles',
    gloss: 'Expected number of units waiting in the queue, excluding those being served.',
    formula: 'Lq = λ² / μ(μ−λ)',
  },
  L: {
    symbol: 'L',
    name: 'In system',
    unit: 'bundles',
    gloss: 'Expected number of units in the system — waiting plus in service. This is the station’s WIP.',
    formula: 'L = Lq + λ/μ',
  },
  Wq: {
    symbol: 'W',
    sub: 'q',
    name: 'Queue wait',
    unit: 'min',
    gloss: 'Expected time a unit spends waiting before service starts.',
    formula: 'Wq = Lq / λ',
  },
  W: {
    symbol: 'W',
    name: 'Time in system',
    unit: 'min',
    gloss: 'Expected total time in the system — queue wait plus service.',
    formula: 'W = Wq + 1/μ',
  },
  D: {
    symbol: 'D',
    name: 'Non-empty queue size',
    unit: 'bundles',
    gloss:
      'Expected queue length counted only over the moments the queue is not empty. '
      + 'Reported for exponential service, where the state probabilities are elementary.',
    // The general definition, not the M/M/1 shortcut the textbook prints —
    // μ/(μ−λ) equals this ratio only under exponential service.
    formula: 'D = Lq / P(n ≥ c+1)',
  },
  pWait: {
    symbol: 'P',
    sub: 'wait',
    name: 'Arrival must wait',
    gloss: 'Probability that an arriving bundle finds every server busy and has to queue.',
    formula: 'P(wait) = 1 − P₀',
  },
  pNoWait: {
    symbol: 'P',
    sub: 'free',
    name: 'Arrival served at once',
    gloss: 'Probability that an arriving bundle goes straight into service.',
    formula: 'P(no wait) = P₀',
  },
  pWqGt: {
    symbol: 'P',
    sub: '(Wq>w)',
    name: 'Wait in queue exceeds w',
    gloss: 'Probability that a bundle waits longer than w in the queue.',
    formula: 'P(Wq>w) = (λ/μ) e^((λ−μ)w)',
  },
  pWGt: {
    symbol: 'P',
    sub: '(W>v)',
    name: 'Time in system exceeds v',
    gloss: 'Probability that a bundle spends longer than v in the system.',
    formula: 'P(W>v) = e^((λ−μ)v)',
  },
  lambdaEff: {
    symbol: 'λ',
    sub: 'eff',
    name: 'Effective arrival rate',
    unit: '/hr',
    gloss: 'Arrival rate actually admitted after balking. Equals λ when the buffer is unbounded.',
    formula: 'λ_eff = λ (1 − P_N)',
  },
  pBalk: {
    symbol: 'P',
    sub: 'N',
    name: 'Balking probability',
    gloss: 'Probability the system is full, so an arriving bundle is turned away.',
    formula: 'P_N = probability of N in system',
  },
  n: {
    symbol: 'n',
    name: 'Units in system',
    gloss: 'Number of units in the system — the index the probability formulas are evaluated at.',
  },
};

/**
 * Label + symbol for a quantity, as one string.
 *
 * Only for places that cannot render a React node (a `title` attribute, an
 * exported CSV header, a chart axis). Anywhere that renders JSX should use
 * `<FieldLabel quantity=… />` so the symbol escapes the uppercase transform.
 */
export function labelWithSymbol(id: QuantityId): string {
  const q = QUANTITY[id];
  return `${q.name} (${q.symbol}${q.sub ?? ''})`;
}

/** Bare symbol including its subscript, e.g. 'Lq' or 'λ_eff' → 'λeff'. */
export function symbolOf(id: QuantityId): string {
  const q = QUANTITY[id];
  return `${q.symbol}${q.sub ?? ''}`;
}

/** Hover text: the textbook gloss, with the formula appended when there is one. */
export function glossOf(id: QuantityId): string {
  const q = QUANTITY[id];
  return q.formula ? `${q.gloss}\n\n${q.formula}` : q.gloss;
}
