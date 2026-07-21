import { useState, type CSSProperties, type ReactNode } from 'react';
import { SW_COLORS, SW_RADIUS, SW_TYPE } from '../design/tokens';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'dark'
  | 'success'
  | 'danger';

export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  full?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}

/**
 * Built fresh on every call so SW_COLORS is read at render time — the vibe
 * system mutates SW_COLORS in place, and a module-level const would capture
 * the pre-vibe values forever (the stale-capture bug this replaced).
 */
function variantColors(
  variant: ButtonVariant,
): { bg: string; fg: string; bgHov: string; border: string } {
  switch (variant) {
    case 'primary':
      return { bg: SW_COLORS.brand, fg: '#fff', bgHov: SW_COLORS.brandDeep, border: 'transparent' };
    case 'secondary':
      return { bg: SW_COLORS.paper, fg: SW_COLORS.ink, bgHov: SW_COLORS.paperDeep, border: SW_COLORS.line };
    case 'ghost':
      return { bg: 'transparent', fg: SW_COLORS.ink, bgHov: SW_COLORS.paperDeep, border: 'transparent' };
    case 'dark':
      return { bg: SW_COLORS.ink, fg: SW_COLORS.paper, bgHov: SW_COLORS.steel, border: 'transparent' };
    case 'success':
      return { bg: SW_COLORS.ok, fg: '#fff', bgHov: SW_COLORS.okDeep, border: 'transparent' };
    case 'danger':
      return { bg: SW_COLORS.alarm, fg: '#fff', bgHov: SW_COLORS.alarmDeep, border: 'transparent' };
  }
}

const SIZES: Record<ButtonSize, { p: string; f: number }> = {
  sm: { p: '6px 10px', f: 12 },
  md: { p: '9px 14px', f: 13 },
  lg: { p: '13px 22px', f: 15 },
};

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  icon,
  full,
  disabled,
  style,
}: ButtonProps) {
  const [hov, setHov] = useState(false);
  const v = variantColors(variant);
  const sz = SIZES[size];
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      disabled={disabled}
      style={{
        background: hov && !disabled ? v.bgHov : v.bg,
        color: v.fg,
        border: v.border === 'transparent' ? 'none' : `1px solid ${v.border}`,
        borderRadius: SW_RADIUS.sm,
        padding: sz.p,
        ...SW_TYPE.label,
        fontSize: sz.f,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        width: full ? '100%' : 'auto',
        justifyContent: 'center',
        transition: 'background 100ms',
        ...style,
      }}
    >
      {icon && <span style={{ fontSize: sz.f + 2 }}>{icon}</span>}
      {children}
    </button>
  );
}
