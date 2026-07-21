import type { ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { Button } from './Button';

interface EmptyStateProps {
  /** Glyph character shown above the title (e.g. '✦', '▶'). */
  icon: string;
  title: string;
  body?: ReactNode;
  action?: { label: string; onClick: () => void };
  /** 'lg' = full-card onboarding block; 'sm' = compact hint for HUD panels/feeds. */
  size?: 'sm' | 'lg';
  /** 'dark' when the panel sits on ink-coloured chrome (e.g. LiveSim HUD). */
  surface?: 'light' | 'dark';
}

/**
 * Honest empty state with a next step — tells people where they are, why
 * it's empty, and what they can do about it. Call sites keep their own
 * Card/padding; this renders only the centred content block.
 */
export function EmptyState({ icon, title, body, action, size = 'lg', surface = 'light' }: EmptyStateProps) {
  const mutedFg = surface === 'dark' ? alpha(SW_COLORS.paper, 0.55) : SW_COLORS.muted;
  const strongFg = surface === 'dark' ? alpha(SW_COLORS.paper, 0.9) : SW_COLORS.ink;

  if (size === 'sm') {
    return (
      <div style={{ textAlign: 'center', padding: '14px 8px' }}>
        <div style={{ fontSize: 20, lineHeight: 1, marginBottom: 6, color: SW_COLORS.brand }}>{icon}</div>
        <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 700, color: strongFg }}>{title}</div>
        {body && <div style={{ fontSize: 11, color: mutedFg, marginTop: 3, lineHeight: 1.5 }}>{body}</div>}
        {action && (
          <div style={{ marginTop: 10 }}>
            <Button variant="primary" size="sm" onClick={action.onClick}>{action.label}</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 56, lineHeight: 1, marginBottom: 12, color: SW_COLORS.brand }}>{icon}</div>
      <div style={{ ...SW_TYPE.title, color: strongFg, marginBottom: 8 }}>{title}</div>
      {body && (
        <div style={{ fontSize: 13, color: mutedFg, maxWidth: 540, margin: '0 auto', lineHeight: 1.6 }}>{body}</div>
      )}
      {action && (
        <div style={{ marginTop: 18 }}>
          <Button variant="primary" onClick={action.onClick}>{action.label}</Button>
        </div>
      )}
    </div>
  );
}
