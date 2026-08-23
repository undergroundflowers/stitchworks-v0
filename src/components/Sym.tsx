/**
 * Mathematical-symbol renderers for queueing fields.
 *
 * Field labels across the app are uppercased in CSS. That transform is not
 * safe for this vocabulary — the browser turns λ into Λ, μ into Μ, ρ into Ρ
 * and Lq into LQ. So every symbol renders through `<Sym>`, which resets
 * `textTransform` and draws the subscript as a real subscript rather than
 * relying on the ₙ/q lookalike codepoints (the mono face has gaps there).
 *
 * `<FieldLabel>` is the standard pairing used beside inputs and table rows:
 * the plain-English name, then the symbol in brackets, e.g.
 *
 *     QUEUE LENGTH (L_q)
 *
 * which is exactly how the textbook names the quantity.
 */

import { type CSSProperties } from 'react';
import { SW_COLORS, SW_FONTS } from '../design/tokens';
import { QUANTITY, glossOf, type QuantityId } from '../simulation/notation';

export interface SymProps {
  quantity: QuantityId;
  /** Wrap in brackets — the form used inside a field label. */
  bracketed?: boolean;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export function Sym({ quantity, bracketed = false, size, color, style }: SymProps) {
  const q = QUANTITY[quantity];
  return (
    <span
      style={{
        // The whole point: opt out of any inherited uppercase transform.
        textTransform: 'none',
        fontFamily: SW_FONTS.mono,
        fontStyle: 'italic',
        letterSpacing: 0,
        whiteSpace: 'nowrap',
        fontSize: size,
        color,
        ...style,
      }}
    >
      {bracketed && '('}
      {q.symbol}
      {q.sub && (
        <sub style={{ fontSize: '0.75em', fontStyle: 'normal', lineHeight: 0 }}>{q.sub}</sub>
      )}
      {bracketed && ')'}
    </span>
  );
}

export interface FieldLabelProps {
  quantity: QuantityId;
  /** Override the plain-English name; the symbol still comes from the vocabulary. */
  name?: string;
  /** Append the unit after the symbol, e.g. "QUEUE WAIT (W_q) min". */
  showUnit?: boolean;
  style?: CSSProperties;
}

/**
 * `NAME (symbol)` — the labelling convention for every queueing field.
 * Carries the textbook gloss as a tooltip so the symbol teaches itself.
 */
export function FieldLabel({ quantity, name, showUnit = true, style }: FieldLabelProps) {
  const q = QUANTITY[quantity];
  return (
    <span title={glossOf(quantity)} style={{ cursor: 'help', ...style }}>
      {name ?? q.name}{' '}
      <Sym quantity={quantity} bracketed color={SW_COLORS.brandText} />
      {showUnit && q.unit ? (
        <span style={{ textTransform: 'none', opacity: 0.7 }}> {q.unit}</span>
      ) : null}
    </span>
  );
}

/**
 * Floor-language name plus its symbol, for the four station observables the
 * charts let you switch between. The sewing floor says "wait"; the textbook
 * says Wq. Showing both is the whole point of the bracket convention.
 */
export function MetricLabel({ name, quantity }: { name: string; quantity: QuantityId }) {
  return (
    <span title={glossOf(quantity)} style={{ whiteSpace: 'nowrap' }}>
      {name} <Sym quantity={quantity} bracketed />
    </span>
  );
}
