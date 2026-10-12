/**
 * Shared queueing-parameter field widgets.
 *
 * Extracted from QueueAnalysisPanel so two surfaces draw their input controls
 * from one source of truth:
 *
 *  - QueueAnalysisPanel (params + the sim-vs-analytical results table) — used
 *    on the Workstation Detail route and, read-only, in the Sim station drawer.
 *  - ServiceQueueParams — the Builder's sim-free authoring group, where these
 *    same fields edit the operation's queueing parameters with no simulation.
 *
 *  - BlockParamRow — one row of a PML block's authored parameters, rendered
 *    from `PARAM_FIELDS_BY_KIND`. Used by the Builder Inspector on a selected
 *    station and by the station-type dialog when authoring the defaults a new
 *    type drops with, so both read identically.
 *
 * Keeping the widgets here means a change to, say, the capacity control shows
 * up identically wherever queueing params are edited.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { HudSelect } from './HudSelect';
import { NumberInput } from './NumberInput';
import { FieldLabel, Sym } from './Sym';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { meanOf, type ServiceDist, type QueueDiscipline } from '../simulation';
import type { ParamFieldSpec } from '../domain/pml';

export type DistKind = ServiceDist['kind'];

export type DistParams = {
  mean: number;
  value: number;
  variance: number;
  k: number;
  std: number;
};

/** Patch emitted when the user edits any queueing field. */
export interface QueueAnalysisChange {
  serviceDistribution?: ServiceDist;
  queueCapacity?: number;
  queueDiscipline?: QueueDiscipline;
  servers?: number;
}

export const DIST_OPTIONS: { value: DistKind; label: string }[] = [
  { value: 'exp', label: 'Exp (M)' },
  { value: 'det', label: 'Det (D)' },
  { value: 'uniform', label: 'Uniform (G)' },
  { value: 'erlang', label: 'Erlang (Eₖ)' },
  { value: 'normal', label: 'Normal (G)' },
];

export const DISCIPLINE_OPTIONS: { value: QueueDiscipline; label: string }[] = [
  { value: 'FCFS', label: 'FCFS' },
  { value: 'SIRO', label: 'SIRO' },
  { value: 'Priority', label: 'Priority' },
];

export function SubHeader({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: 10,
        color: SW_COLORS.muted,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        fontWeight: 700,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function DistParamInputs({
  dist,
  editable,
  onChange,
}: {
  dist: ServiceDist;
  editable: boolean;
  onChange: (patch: Partial<DistParams>) => void;
}) {
  const cols: ReactNode[] = [];
  switch (dist.kind) {
    case 'exp':
      cols.push(
        <NumberField
          key="m"
          label={<FieldLabel quantity="serviceTime" name="Mean service" />}
          value={dist.mean}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ mean: v })}
        />,
      );
      break;
    case 'det':
      cols.push(
        <NumberField
          key="v"
          label={<FieldLabel quantity="serviceTime" name="Constant service" />}
          value={dist.value}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ value: v })}
        />,
      );
      break;
    case 'uniform':
      cols.push(
        <NumberField
          key="m"
          label={<FieldLabel quantity="serviceTime" name="Mean service" />}
          value={dist.mean}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ mean: v })}
        />,
        <NumberField
          key="v"
          label={<FieldLabel quantity="cs" name="Spread ±" showUnit={false} />}
          value={dist.variance * 100}
          min={0}
          max={100}
          step={1}
          editable={editable}
          onChange={(v) => onChange({ variance: v / 100 })}
        />,
      );
      break;
    case 'erlang':
      cols.push(
        <NumberField
          key="k"
          label={<FieldLabel quantity="erlangK" name="Phases" />}
          value={dist.k}
          min={1}
          step={1}
          editable={editable}
          onChange={(v) => onChange({ k: Math.max(1, Math.round(v)) })}
        />,
        <NumberField
          key="m"
          label={<FieldLabel quantity="serviceTime" name="Mean service" />}
          value={dist.mean}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ mean: v })}
        />,
      );
      break;
    case 'normal':
      cols.push(
        <NumberField
          key="m"
          label={<FieldLabel quantity="serviceTime" name="Mean service" />}
          value={dist.mean}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ mean: v })}
        />,
        <NumberField
          key="s"
          label={<FieldLabel quantity="sigma" name="Std deviation" />}
          value={dist.std}
          min={0}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ std: v })}
        />,
      );
      break;
  }
  return (
    // auto-fit rather than a fixed column count: the Inspector is resizable
    // down to 260px, and a symbol-bearing label needs more room than the bare
    // one did. Below the 96px floor the fields stack instead of clipping.
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(96px, 1fr))`,
        gap: 10,
      }}
    >
      {cols}
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  editable,
  onChange,
}: {
  /** ReactNode so a caller can pass `<FieldLabel quantity="servers" />` and get
   *  the textbook symbol beside the name without the CSS uppercase mangling it. */
  label: ReactNode;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  editable: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: SW_COLORS.muted,
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <NumberInput
        value={Number.isFinite(value) ? value : undefined}
        min={min}
        max={max}
        step={step}
        disabled={!editable}
        onChange={(v) => { if (v !== undefined) onChange(v); }}
        style={inputStyle(editable)}
      />
    </label>
  );
}

export function CapacityField({
  capacity,
  editable,
  onChange,
}: {
  capacity: number;
  editable: boolean;
  onChange: (v: number | 'inf') => void;
}) {
  const finite = Number.isFinite(capacity);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: SW_COLORS.muted,
          fontWeight: 700,
        }}
      >
        <FieldLabel quantity="capacity" />
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        <NumberInput
          value={finite ? capacity : undefined}
          placeholder={finite ? '' : '∞'}
          min={1}
          step={1}
          disabled={!editable}
          onChange={(v) => { if (v !== undefined && v > 0) onChange(v); }}
          style={{ ...inputStyle(editable), flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          disabled={!editable}
          onClick={() => onChange('inf')}
          title="Unbounded buffer (M/M/c with no balking)"
          style={{
            ...inputStyle(editable),
            cursor: editable ? 'pointer' : 'default',
            background: finite ? SW_COLORS.paper : SW_COLORS.paperEdge,
            fontFamily: SW_FONTS.mono,
            fontWeight: 700,
            width: 32,
          }}
        >
          ∞
        </button>
      </div>
    </label>
  );
}

export function DropdownField<T extends string>({
  label,
  value,
  options,
  editable,
  onChange,
}: {
  label: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  editable: boolean;
  onChange: (v: T) => void;
}) {
  return (
    // minWidth:0 so the select can shrink to its grid column instead of
    // pushing past the card edge.
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: SW_COLORS.muted,
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <HudSelect
        value={value}
        disabled={!editable}
        onChange={(v) => onChange(v as T)}
        variant="light"
        size="sm"
        width="100%"
        options={options}
      />
    </label>
  );
}

export function inputStyle(editable: boolean): CSSProperties {
  return {
    border: `1px solid ${SW_COLORS.line}`,
    background: editable ? SW_COLORS.paper : SW_COLORS.paperDeep,
    borderRadius: SW_RADIUS.sm,
    padding: '6px 8px',
    fontFamily: SW_FONTS.body,
    fontSize: 13,
    color: SW_COLORS.ink,
    outline: 'none',
    width: '100%',
  };
}

export function morphDist(current: ServiceDist, kind: DistKind, smv: number): ServiceDist {
  const m = meanOf(current) || smv || 1;
  switch (kind) {
    case 'exp':     return { kind: 'exp', mean: m };
    case 'det':     return { kind: 'det', value: m };
    case 'uniform': return { kind: 'uniform', mean: m, variance: 0.15 };
    case 'erlang':  return { kind: 'erlang', k: 2, mean: m };
    case 'normal':  return { kind: 'normal', mean: m, std: m * 0.2 };
    default: throw new Error(`morphDist: unsupported kind ${kind}`);
  }
}

export function patchDist(d: ServiceDist, p: Partial<DistParams>): ServiceDist {
  switch (d.kind) {
    case 'exp':     return { kind: 'exp', mean: p.mean ?? d.mean };
    case 'det':     return { kind: 'det', value: p.value ?? d.value };
    case 'uniform': return { kind: 'uniform', mean: p.mean ?? d.mean, variance: p.variance ?? d.variance };
    case 'erlang':  return { kind: 'erlang', k: p.k ?? d.k, mean: p.mean ?? d.mean };
    case 'normal':  return { kind: 'normal', mean: p.mean ?? d.mean, std: p.std ?? d.std };
    default: throw new Error(`patchDist: unsupported kind ${d.kind}`);
  }
}


// ============================================================================
// BLOCK PARAM ROW
// ============================================================================

const blockFieldLabel: CSSProperties = {
  fontFamily: SW_FONTS.body,
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: '0.005em',
  color: SW_COLORS.muted,
  display: 'block',
};

const blockInput: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 12px',
  fontSize: 13,
  fontFamily: SW_FONTS.mono,
  fontWeight: 700,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
  background: SW_COLORS.paper,
  color: SW_COLORS.ink,
};

const helpDot = (open: boolean): CSSProperties => ({
  background: SW_COLORS.paper,
  border: `1px solid ${open ? SW_COLORS.brandText : SW_COLORS.line}`,
  color: open ? SW_COLORS.brandText : SW_COLORS.muted,
  padding: 0,
  width: 16,
  height: 16,
  borderRadius: 8,
  fontFamily: SW_FONTS.display,
  fontSize: 10,
  fontWeight: 900,
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

/**
 * One authored parameter: label, value, and a `?` toggle that reveals the
 * explanation.
 *
 * The prose used to sit permanently under every input, which turned a list of
 * four numbers into a wall of text — so it is behind the toggle now.
 *
 * WHAT THE `?` SAYS. One plain sentence: what this number does on the floor.
 * It used to also append `glossOf(quantity)` — the textbook wording plus the
 * formula — which is how a four-word question got a five-line answer full of
 * phrases like "the fifth field of Kendall–Lee a/b/c:d/e" and
 * "Pollaczek–Khinchine". That vocabulary is worth having, but not here: the
 * `?` is read mid-edit by someone who wants to know what to type. The textbook
 * gloss is still one hover away on the `<Sym>` beside the label, and in full
 * on the Queueing reference sheet.
 *
 * The row used to carry a SET/auto badge and a ✕ that dropped the override
 * back to the catalog default. It is gone: the row shows the number the engine
 * will use, and typing a different one is the whole interaction. Where that
 * value came from is bookkeeping the user was being asked to track on the
 * app's behalf.
 */
export function BlockParamRow({
  field: f,
  value,
  onSet,
}: {
  field: ParamFieldSpec;
  value: number;
  onSet: (v: number) => void;
}) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...blockFieldLabel, flex: 1 }}>
          {f.label}{' '}
          {f.quantity && <Sym quantity={f.quantity} bracketed color={SW_COLORS.brandText} />}{' '}
          <span style={{ color: SW_COLORS.muted, fontWeight: 500 }}>{f.unit.trim()}</span>
        </span>
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          aria-expanded={showHelp}
          aria-label={`What is ${f.label}?`}
          title={`What is ${f.label}?`}
          style={helpDot(showHelp)}
        >
          ?
        </button>
      </div>
      <NumberInput
        value={value}
        step={f.step}
        onChange={(v) => { if (v !== undefined) onSet(v); }}
        style={blockInput}
      />
      {showHelp && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            lineHeight: 1.45,
            color: SW_COLORS.muted,
            whiteSpace: 'pre-line',
          }}
        >
          {f.hint}
        </div>
      )}
    </div>
  );
}
