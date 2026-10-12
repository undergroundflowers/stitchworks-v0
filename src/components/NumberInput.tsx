/**
 * NumberInput — the one numeric text field the app types into.
 *
 * Every numeric input in the app used to be a bare `<input type="number">`
 * wired straight to a number prop, which has two defects the user hits within
 * seconds of editing anything:
 *
 *  1. THE LAST DIGIT CANNOT BE DELETED. The handlers all read
 *     `Number(e.target.value)` and commit whatever comes back. `Number('')` is
 *     `0`, not `NaN`, so clearing the box committed 0, which re-rendered the
 *     box as "0", which is now one character the user has to delete again —
 *     forever. Selecting-all and typing worked; backspacing did not, and
 *     backspacing is what people do.
 *
 *  2. THE SPINNERS. Nobody wants to nudge an SMV by 1.00 with a 9px arrow, and
 *     a mis-aimed scroll over a focused number input silently changes the
 *     value. They also eat ~18px of a 198px inspector field.
 *
 * The fix for (1) is a DRAFT: while the field is focused it owns its own text,
 * so "" is a legal thing to be looking at and the model simply doesn't move
 * until there is a number to move it to. On blur the draft is dropped and the
 * committed value is redisplayed, so an abandoned edit can never leave the box
 * showing something the model doesn't hold.
 *
 * The fix for (2) is `type="text"` with `inputMode="decimal"`. Setting
 * `appearance: none` is the usual advice, but the WebKit spinner is a
 * pseudo-element and inline styles cannot reach it; a text input has no
 * spinner to hide in any engine, still raises the numeric keypad on touch, and
 * — unlike `type="number"` — lets us decide for ourselves what counts as
 * typeable. (`src/index.css` also carries the pseudo-element rule, for any
 * stray `type="number"` that outlives this component.)
 *
 * CLAMPING IS DEFERRED TO BLUR on purpose. Clamping per keystroke makes a
 * `min={10}` field impossible to type into: the "1" of "12" is below the
 * minimum, so it snaps to 10 and the next keystroke appends to that.
 */

import { useState, type CSSProperties } from 'react';

export interface NumberInputProps {
  /** Committed value. `undefined` renders as empty (see `allowEmpty`). */
  value: number | undefined;
  /**
   * Called with the parsed number, or with `undefined` when the user clears
   * the field and `allowEmpty` is set.
   */
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  /** Increment for the arrow keys. Also decides whether decimals are typeable. */
  step?: number;
  /**
   * Whether empty is a value the model can hold (`undefined` = "unset",
   * usually falling back to a default). When false, clearing the box is still
   * allowed while typing — it just doesn't commit anything, and blurring an
   * empty field puts the previous value back.
   */
  allowEmpty?: boolean;
  placeholder?: string;
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
  'aria-label'?: string;
}

/** Digits, one leading minus, one dot — anything else never reaches the draft. */
const NUMERIC = /^-?\d*\.?\d*$/;

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  allowEmpty = false,
  placeholder,
  disabled = false,
  style,
  title,
  'aria-label': ariaLabel,
}: NumberInputProps) {
  // `null` ⇒ not editing; show the committed value. A string ⇒ the user is
  // typing and owns what is on screen, empty string included.
  const [draft, setDraft] = useState<string | null>(null);

  const shown = draft ?? (value === undefined ? '' : String(value));

  const clamp = (n: number) => {
    let out = n;
    if (min !== undefined && out < min) out = min;
    if (max !== undefined && out > max) out = max;
    return out;
  };

  const commitDraft = (raw: string) => {
    if (raw === '' || raw === '-' || raw === '.') {
      // Nothing to commit yet. `allowEmpty` fields treat a cleared box as a
      // real edit (back to the default); the rest just wait.
      if (raw === '' && allowEmpty) onChange(undefined);
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(n);
  };

  return (
    <input
      type="text"
      inputMode={step < 1 ? 'decimal' : 'numeric'}
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        // Reject the keystroke rather than the value: a rejected character
        // never enters the draft, so the caret doesn't jump.
        if (!NUMERIC.test(raw)) return;
        setDraft(raw);
        commitDraft(raw);
      }}
      onFocus={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const raw = draft;
        setDraft(null);
        if (raw === null) return;
        if (raw === '' || raw === '-' || raw === '.') {
          // An empty box on a field that cannot hold empty reverts to whatever
          // the model still has — dropping the draft is enough to redisplay it.
          if (allowEmpty) onChange(undefined);
          return;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        const clamped = clamp(n);
        if (clamped !== value) onChange(clamped);
      }}
      onKeyDown={(e) => {
        // The arrow keys are the half of `type="number"` worth keeping.
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const base = Number(shown);
        const from = Number.isFinite(base) ? base : (value ?? 0);
        const next = clamp(from + (e.key === 'ArrowUp' ? step : -step));
        // Re-round to the step's own precision: 0.1 + 0.2 must not surface as
        // 0.30000000000000004 in a field the user is reading.
        const decimals = (String(step).split('.')[1] ?? '').length;
        const rounded = Number(next.toFixed(decimals));
        setDraft(String(rounded));
        onChange(rounded);
      }}
      style={style}
    />
  );
}
