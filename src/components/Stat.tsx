import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS, SW_TYPE } from '../design/tokens';

interface StatProps {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: number;
  icon?: ReactNode;
  color?: string;
  big?: boolean;
  /** When provided, renders an ⓘ button next to the label that opens a click-popover explaining how the metric is calculated. */
  info?: ReactNode;
}

export function Stat({
  label,
  value,
  unit,
  delta,
  icon,
  color = SW_COLORS.ink,
  big,
  info,
}: StatProps) {
  return (
    <div
      style={{
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.md,
        padding: big ? 18 : 14,
        position: 'relative',
        overflow: 'visible',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            ...SW_TYPE.kicker,
            letterSpacing: '0.6px',
            color: SW_COLORS.muted,
          }}
        >
          {label}
          {info && <InfoButton label={label}>{info}</InfoButton>}
        </span>
        {icon && <span style={{ fontSize: 14, color }}>{icon}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span
          style={{
            ...(big ? SW_TYPE.display : SW_TYPE.displaySm),
            color,
          }}
        >
          {value}
        </span>
        {unit && (
          <span style={{ fontSize: 12, color: SW_COLORS.muted, fontWeight: 600 }}>
            {unit}
          </span>
        )}
      </div>
      {delta != null && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            fontWeight: 700,
            color: delta > 0 ? SW_COLORS.ok : SW_COLORS.alarm,
          }}
        >
          {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}
        </div>
      )}
    </div>
  );
}

function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label={`How is ${label} calculated?`}
        aria-expanded={open}
        title={`How is ${label} calculated?`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={{
          width: 14,
          height: 14,
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: open ? SW_COLORS.ink : 'transparent',
          color: open ? '#fff' : SW_COLORS.muted,
          border: `1px solid ${open ? SW_COLORS.ink : SW_COLORS.line}`,
          borderRadius: 999,
          fontSize: 9,
          fontWeight: 900,
          fontFamily: SW_FONTS.mono,
          lineHeight: 1,
          cursor: 'pointer',
        }}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} — calculation`}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            minWidth: 240,
            maxWidth: 320,
            padding: '10px 12px 11px',
            background: SW_COLORS.paper,
            color: SW_COLORS.ink,
            border: `1px solid ${SW_COLORS.line}`,
            borderRadius: 8,
            boxShadow: SW_SHADOWS.float,
            fontFamily: SW_FONTS.mono,
            fontSize: 11,
            fontWeight: 500,
            lineHeight: 1.5,
            letterSpacing: 0,
            textTransform: 'none',
            whiteSpace: 'normal',
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}
