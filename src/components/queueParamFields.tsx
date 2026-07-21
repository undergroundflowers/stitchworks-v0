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
 * Keeping the widgets here means a change to, say, the capacity control shows
 * up identically wherever queueing params are edited.
 */

import { type CSSProperties, type ReactNode } from 'react';
import { HudSelect } from './HudSelect';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { meanOf, type ServiceDist, type QueueDiscipline } from '../simulation';

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
          label="Mean (min)"
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
          label="Value (min)"
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
          label="Mean (min)"
          value={dist.mean}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ mean: v })}
        />,
        <NumberField
          key="v"
          label="Variance (±%)"
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
          label="Shape k"
          value={dist.k}
          min={1}
          step={1}
          editable={editable}
          onChange={(v) => onChange({ k: Math.max(1, Math.round(v)) })}
        />,
        <NumberField
          key="m"
          label="Mean (min)"
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
          label="Mean (min)"
          value={dist.mean}
          min={0.01}
          step={0.05}
          editable={editable}
          onChange={(v) => onChange({ mean: v })}
        />,
        <NumberField
          key="s"
          label="Std σ (min)"
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
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)`, gap: 10 }}>
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
  label: string;
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
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        disabled={!editable}
        onChange={(e) => onChange(Number(e.target.value))}
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
        Capacity (N)
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="number"
          value={finite ? capacity : ''}
          placeholder={finite ? '' : '∞'}
          min={1}
          step={1}
          disabled={!editable}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) onChange(v);
          }}
          style={{ ...inputStyle(editable), flex: 1 }}
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
  label: string;
  value: T;
  options: { value: T; label: string }[];
  editable: boolean;
  onChange: (v: T) => void;
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
