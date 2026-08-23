/**
 * "Show the working" — each measure written out the way the textbook prints it,
 * with the numbers substituted in.
 *
 * The point of the Lab is to be studied, and a bare "Lq = 0.53" teaches
 * nothing. What teaches is the line under it:
 *
 *     Lq = λ² / μ(μ − λ)  =  7.5² / 15(15 − 7.5)  =  0.500
 *
 * ── Why this is not string replacement ─────────────────────────────────────
 * The obvious implementation — take `QUANTITY[q].formula` and replace 'λ' with
 * the value — is quietly broken on this vocabulary:
 *
 *   'Lq = λ² / μ(μ−λ)'      the λ inside λ² must become (7.5)², not 7.5²
 *   'P(Wq>w) = (λ/μ)e^…'    the 'w' occurs inside 'Wq' as well as alone
 *   'L = Lq + λ/μ'          replacing 'L' first destroys 'Lq'
 *
 * Every one of those produces a plausible-looking but wrong derivation, which
 * is worse than showing none. So each formula is BUILT from its inputs here
 * rather than edited as text, and the symbolic and substituted forms are
 * generated from the same expression so they cannot drift apart.
 */

import type { AnalyticalKpis, KendallNotation } from '../simulation/queueing';
import type { QuantityId } from '../simulation/notation';

export interface Working {
  /** The formula in symbols, e.g. 'Lq = λ² / μ(μ − λ)'. */
  symbolic: string;
  /**
   * The RIGHT-HAND SIDE with each symbol replaced by its value. The left-hand
   * side is deliberately not repeated: the renderer prefixes '= ', and
   * carrying the LHS here printed 'Lq = ' twice on the same line.
   */
  substituted: string;
  /** The answer, formatted with its unit. */
  result: string;
  /** Which symbols were used, so the surface can list what they stand for. */
  uses: QuantityId[];
  /**
   * Set when this measure has no closed form in the active Kendall class —
   * the surface shows the reason instead of a derivation.
   */
  unavailable?: string;
}

/** Round for display without pretending to more precision than we have. */
function num(v: number, dp = 3): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '—';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  return Number(v.toFixed(dp)).toString();
}

export interface WorkingInput {
  notation: KendallNotation;
  kpis: AnalyticalKpis;
  /** Arrival rate per hour. */
  lambda: number;
  /** Service rate per hour, per server. */
  mu: number;
}

/**
 * Derivations for the measures the textbook gives a formula for.
 *
 * Multi-server and finite-capacity classes get a shortened treatment: the
 * textbook's own multi-server working runs to half a page of factorials, and
 * reproducing it inline would bury the answer. Those say which model produced
 * the number and leave the algebra to the reference panel.
 */
export function workingFor(id: QuantityId, input: WorkingInput): Working | null {
  const { notation, kpis, lambda, mu } = input;
  const c = notation.servers;
  const single = c === 1;
  const unbounded = !Number.isFinite(notation.capacity);
  const exponential = notation.service === 'M' && notation.arrival === 'M';
  const L = num(lambda);
  const M = num(mu);

  switch (id) {
    case 'rho': {
      if (single) {
        return {
          symbolic: 'ρ = λ / μ',
          substituted: `${L} / ${M}`,
          result: num(kpis.rho),
          uses: ['lambda', 'mu'],
        };
      }
      return {
        symbolic: 'ρ = λ / (cμ)',
        substituted: `${L} / (${c} × ${M})`,
        result: num(kpis.rho),
        uses: ['lambda', 'servers', 'mu'],
      };
    }

    case 'P0': {
      if (single && unbounded && exponential) {
        return {
          symbolic: 'P₀ = 1 − λ/μ',
          substituted: `1 − ${L}/${M}`,
          result: num(kpis.P0),
          uses: ['lambda', 'mu'],
        };
      }
      return {
        symbolic: 'P₀ = 1 / [ Σₙ₌₀ᶜ⁻¹ (1/n!)(λ/μ)ⁿ + (1/c!)(λ/μ)ᶜ · cμ/(cμ−λ) ]',
        substituted: `evaluated at λ=${L}, μ=${M}, c=${c}`,
        result: num(kpis.P0),
        uses: ['lambda', 'mu', 'servers'],
      };
    }

    case 'Lq': {
      if (single && unbounded && exponential) {
        return {
          symbolic: 'Lq = λ² / μ(μ − λ)',
          substituted: `${L}² / ${M}(${M} − ${L})`,
          result: num(kpis.Lq),
          uses: ['lambda', 'mu'],
        };
      }
      if (single && unbounded && notation.service === 'D') {
        return {
          symbolic: 'Lq = ρ² / 2(1 − ρ)',
          substituted: `${num(kpis.rho)}² / 2(1 − ${num(kpis.rho)})`,
          result: num(kpis.Lq),
          uses: ['rho'],
        };
      }
      if (single && unbounded) {
        return {
          symbolic: 'Lq = ρ²(1 + Cs²) / 2(1 − ρ)',
          substituted: `Pollaczek–Khinchine at ρ = ${num(kpis.rho)}`,
          result: num(kpis.Lq),
          uses: ['rho', 'cs'],
        };
      }
      return {
        symbolic: unbounded
          ? 'Lq = P₀ (λ/μ)ᶜ ρ / c!(1 − ρ)²'
          : 'Lq = Σₙ₌ᶜ₊₁ᴺ (n − c) Pₙ',
        substituted: `evaluated at λ=${L}, μ=${M}, c=${c}${unbounded ? '' : `, N=${notation.capacity}`}`,
        result: num(kpis.Lq),
        uses: ['lambda', 'mu', 'servers'],
      };
    }

    case 'Wq':
      return {
        symbolic: 'Wq = Lq / λ',
        substituted: unbounded
          ? `${num(kpis.Lq)} / ${L}`
          : `${num(kpis.Lq)} / ${num(kpis.lambdaEff)}   (λ_eff, after balking)`,
        result: `${num(kpis.Wq * 60, 2)} min`,
        uses: ['Lq', 'lambda'],
      };

    case 'L':
      return {
        symbolic: 'L = Lq + λ/μ',
        substituted: `${num(kpis.Lq)} + ${L}/${M}`,
        result: num(kpis.L),
        uses: ['Lq', 'lambda', 'mu'],
      };

    case 'W':
      return {
        symbolic: 'W = Wq + 1/μ',
        substituted: `${num(kpis.Wq * 60, 2)} min + ${num(60 / mu, 2)} min`,
        result: `${num(kpis.W * 60, 2)} min`,
        uses: ['Wq', 'mu'],
      };

    case 'D': {
      if (!Number.isFinite(kpis.D)) {
        return {
          symbolic: 'D = Lq / P(n ≥ c+1)',
          substituted: '',
          result: '—',
          uses: ['Lq'],
          unavailable:
            'The textbook prints D = μ/(μ−λ), which is that ratio only under exponential '
            + 'service. This class has no elementary Pₙ to form the denominator from.',
        };
      }
      if (single && unbounded && exponential) {
        return {
          symbolic: 'D = μ / (μ − λ)',
          substituted: `${M} / (${M} − ${L})`,
          result: num(kpis.D),
          uses: ['mu', 'lambda'],
        };
      }
      return {
        symbolic: 'D = Lq / P(n ≥ c+1)',
        substituted: `${num(kpis.Lq)} / ${num(1 - sumHead(kpis, c))}`,
        result: num(kpis.D),
        uses: ['Lq'],
      };
    }

    case 'pWait': {
      if (single) {
        return {
          symbolic: 'P(wait) = 1 − P₀',
          substituted: `1 − ${num(kpis.P0)}`,
          result: pct(kpis.pWait),
          uses: ['P0'],
        };
      }
      return {
        symbolic: 'P(wait) = 1 − P₀ − P₁ − … − P_{c−1}',
        substituted: `all ${c} servers busy`,
        result: pct(kpis.pWait),
        uses: ['P0', 'servers'],
      };
    }

    case 'pNoWait':
      return {
        symbolic: single ? 'P(no wait) = P₀' : 'P(no wait) = Σₙ₌₀ᶜ⁻¹ Pₙ',
        substituted: `1 − ${pct(kpis.pWait)}`,
        result: pct(kpis.pNoWait),
        uses: ['P0'],
      };

    case 'lambdaEff':
      return {
        symbolic: 'λ_eff = λ (1 − P_N)',
        substituted: unbounded
          ? 'nothing balks, so λ_eff = λ'
          : `${L} × (1 − ${num(kpis.pBalk)})`,
        result: `${num(kpis.lambdaEff)} /hr`,
        uses: ['lambda', 'pBalk'],
      };

    case 'pBalk':
      return {
        symbolic: 'P_N = probability the system holds N',
        substituted: unbounded ? 'unbounded buffer — nothing is turned away' : `N = ${notation.capacity}`,
        result: pct(kpis.pBalk),
        uses: ['capacity'],
      };

    default:
      return null;
  }
}

/** Σ Pₙ for n = 0..c, the "not queueing" states. NaN-safe. */
function sumHead(kpis: AnalyticalKpis, c: number): number {
  let acc = 0;
  for (let n = 0; n <= c; n++) {
    const p = kpis.Pn(n);
    if (!Number.isFinite(p)) return NaN;
    acc += p;
  }
  return acc;
}

function pct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * The traffic equation for one node, written out.
 *
 * This is the only genuinely new algebra the network layer introduces, and it
 * is the step that explains why a rework loop costs more than its percentage:
 * seeing `λ = 50 + 0.15 × 58.8` next to the answer makes the circularity
 * visible in a way the solved number alone does not.
 */
export function trafficEquationFor(
  nodeName: string,
  gamma: number,
  contributions: { fromName: string; lambda: number; probability: number }[],
  lambda: number,
): Working {
  const terms = contributions.map(
    (t) => `${num(t.probability)}×${num(t.lambda)}`,
  );
  const rhs = [num(gamma), ...terms].filter((t) => t !== '0').join(' + ');
  return {
    symbolic: 'λⱼ = γⱼ + Σᵢ λᵢ pᵢⱼ',
    substituted: `λ(${nodeName}) = ${rhs || '0'}`,
    result: `${num(lambda)} /hr`,
    uses: ['lambda'],
  };
}
