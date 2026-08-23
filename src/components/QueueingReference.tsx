/**
 * Queueing-theory reference — the textbook's own contents, rendered from the
 * same vocabulary the fields use.
 *
 * Two parts:
 *  1. **Models.** Kendall–Lee a/b/c:d/e and the eight classes the textbook
 *     enumerates, each marked with how this app handles it. A class is
 *     "exact" when a closed form is implemented, "approximate" when the
 *     textbook gives no formula and we fall back to a standard extension.
 *  2. **Quantities.** Every symbol the Inspector can show, with its formula.
 *     Generated from `QUANTITY`, so a symbol can never drift between the
 *     field label and the reference that explains it.
 */

import { Card } from './Card';
import { SectionHeader } from './SectionHeader';
import { Sym } from './Sym';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { QUANTITY, type QuantityId } from '../simulation/notation';

type Support = 'exact' | 'approx';

interface ModelRow {
  numeral: string;
  kendall: string;
  name: string;
  support: Support;
  /** How the app resolves this class. */
  how: string;
}

/** The eight classes the textbook names, in its own order. */
const MODELS: ModelRow[] = [
  {
    numeral: 'I',
    kendall: 'M/M/1 : ∞/FCFS',
    name: 'Single server, unbounded queue',
    support: 'exact',
    how: 'All thirteen formulas implemented, including both waiting-time tails.',
  },
  {
    numeral: 'II',
    kendall: 'M/M/1 : N/FCFS',
    name: 'Single server, finite capacity',
    support: 'exact',
    how: 'Truncated geometric. Reports the balking probability and λ_eff.',
  },
  {
    numeral: 'III',
    kendall: 'M/M/1 : ∞/SIRO',
    name: 'Service in random order',
    support: 'exact',
    how: 'Shares every mean with Model I; only the spread of individual waits differs.',
  },
  {
    numeral: 'IV',
    kendall: 'M/D/1 : ∞/FCFS',
    name: 'Constant service time',
    support: 'exact',
    how: 'Pollaczek–Khinchine at Cs = 0, so Lq is exactly half the M/M/1 value.',
  },
  {
    numeral: 'V',
    kendall: 'M/G/1 : ∞/FCFS',
    name: 'General service time',
    support: 'exact',
    how: 'Pollaczek–Khinchine using the coefficient of variation of the fitted distribution.',
  },
  {
    numeral: 'VI',
    kendall: 'M/Eₖ/1 : ∞/FCFS',
    name: 'Erlang-k service',
    support: 'exact',
    how: 'Pollaczek–Khinchine at Cs² = 1/k. As k grows it converges on M/D/1.',
  },
  {
    numeral: 'VII',
    kendall: 'M/M/K : ∞/FCFS',
    name: 'Multiple servers',
    support: 'exact',
    how: 'Erlang-B normalisation for P₀ and Erlang-C for the probability of waiting.',
  },
  {
    numeral: 'VIII',
    kendall: 'M/M/K : N/FCFS',
    name: 'Multiple servers, finite capacity',
    support: 'exact',
    how: 'Truncated at N, with Lq summed over the waiting states.',
  },
];

/** Non-textbook classes the app still has to answer for, stated honestly. */
const EXTENSIONS: ModelRow[] = [
  {
    numeral: '—',
    kendall: 'M/G/K : ∞/FCFS',
    name: 'General service, multiple servers',
    support: 'approx',
    how: 'The textbook gives no formula. Allen–Cunneen approximation; the simulation is authoritative.',
  },
];

const PARAM_IDS: QuantityId[] = [
  'lambda',
  'mu',
  'serviceTime',
  'servers',
  'capacity',
  'discipline',
  'erlangK',
  'cs',
];

const MEASURE_IDS: QuantityId[] = [
  'rho',
  'P0',
  'Pn',
  'PnOrMore',
  'Lq',
  'L',
  'Wq',
  'W',
  'D',
  'pWait',
  'pNoWait',
  'pWqGt',
  'pWGt',
  'lambdaEff',
  'pBalk',
];

export function QueueingReference() {
  return (
    <Card>
      <SectionHeader
        title="Queueing-theory reference"
        sub="Kendall–Lee a/b/c:d/e — arrival distribution / service distribution / servers / system capacity / discipline."
      />

      <SubTitle>Models</SubTitle>
      <div style={tableWrap}>
        <ModelHeader />
        {MODELS.map((m, i) => (
          <ModelRowView key={m.kendall} row={m} alt={i % 2 === 1} />
        ))}
      </div>

      <SubTitle style={{ marginTop: 16 }}>Beyond the textbook</SubTitle>
      <div style={tableWrap}>
        {EXTENSIONS.map((m) => (
          <ModelRowView key={m.kendall} row={m} alt={false} />
        ))}
      </div>

      <SubTitle style={{ marginTop: 16 }}>Parameters you author</SubTitle>
      <QuantityTable ids={PARAM_IDS} />

      <SubTitle style={{ marginTop: 16 }}>Measures the model reports</SubTitle>
      <QuantityTable ids={MEASURE_IDS} />

      <p style={{ ...SW_TYPE.caption, color: SW_COLORS.muted, marginTop: 14, marginBottom: 0 }}>
        A sewing line is a <strong>tandem</strong> network: the textbook’s own service mechanism
        allows a unit to pass through a sequence of facilities. Each station is solved on its own
        using the arrival rate observed at it, which Burke’s theorem justifies exactly for the
        all-exponential case and approximately otherwise.
      </p>
    </Card>
  );
}

function QuantityTable({ ids }: { ids: QuantityId[] }) {
  return (
    <div style={tableWrap}>
      {ids.map((id, i) => {
        const q = QUANTITY[id];
        return (
          <div
            key={id}
            style={{
              display: 'grid',
              gridTemplateColumns: '56px 1.1fr 1.6fr',
              gap: 10,
              padding: '8px 12px',
              alignItems: 'baseline',
              background: i % 2 === 1 ? SW_COLORS.paperDeep : SW_COLORS.paper,
            }}
          >
            <Sym quantity={id} size={14} color={SW_COLORS.brandText} />
            <span style={{ fontSize: 12, fontWeight: 600, color: SW_COLORS.ink }}>
              {q.name}
              {q.unit && (
                <span style={{ color: SW_COLORS.muted, fontWeight: 400 }}> · {q.unit}</span>
              )}
            </span>
            <span style={{ fontSize: 12, color: SW_COLORS.muted, lineHeight: 1.45 }}>
              {q.gloss}
              {q.formula && (
                <span
                  style={{
                    display: 'block',
                    fontFamily: SW_FONTS.mono,
                    fontSize: 11,
                    color: SW_COLORS.ink,
                    marginTop: 3,
                  }}
                >
                  {q.formula}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ModelHeader() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 1.2fr 1.1fr 1.6fr',
        gap: 10,
        padding: '8px 12px',
        background: SW_COLORS.paperDeep,
        borderBottom: `1px solid ${SW_COLORS.line}`,
        fontFamily: SW_FONTS.mono,
        fontSize: 10,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        color: SW_COLORS.muted,
        fontWeight: 700,
      }}
    >
      <span>#</span>
      <span>Kendall–Lee</span>
      <span>Model</span>
      <span>How it is solved</span>
    </div>
  );
}

function ModelRowView({ row, alt }: { row: ModelRow; alt: boolean }) {
  const exact = row.support === 'exact';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 1.2fr 1.1fr 1.6fr',
        gap: 10,
        padding: '8px 12px',
        alignItems: 'baseline',
        background: alt ? SW_COLORS.paperDeep : SW_COLORS.paper,
      }}
    >
      <span style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
        {row.numeral}
      </span>
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 12,
          fontWeight: 700,
          color: SW_COLORS.ink,
        }}
      >
        {row.kendall}
      </span>
      <span style={{ fontSize: 12, color: SW_COLORS.ink }}>{row.name}</span>
      <span style={{ fontSize: 12, color: SW_COLORS.muted, lineHeight: 1.45 }}>
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.08em',
            color: exact ? SW_COLORS.ok : SW_COLORS.warn,
            marginRight: 6,
          }}
        >
          {exact ? 'EXACT' : 'APPROX'}
        </span>
        {row.how}
      </span>
    </div>
  );
}

function SubTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: 10,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        color: SW_COLORS.muted,
        fontWeight: 700,
        marginBottom: 6,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

const tableWrap: React.CSSProperties = {
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
  overflow: 'hidden',
};
