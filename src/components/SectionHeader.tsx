import type { ReactNode } from 'react';
import { SW_COLORS, SW_TYPE } from '../design/tokens';

interface SectionHeaderProps {
  kicker?: string;
  title: string;
  sub?: string;
  right?: ReactNode;
}

export function SectionHeader({ kicker, title, sub, right }: SectionHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 16 }}>
      <div style={{ flex: 1 }}>
        {kicker && (
          <div
            style={{
              ...SW_TYPE.kicker,
              color: SW_COLORS.brand,
              marginBottom: 4,
            }}
          >
            {kicker}
          </div>
        )}
        <div
          style={{
            ...SW_TYPE.title,
            color: SW_COLORS.ink,
          }}
        >
          {title}
        </div>
        {sub && (
          <div style={{ fontSize: 13, color: SW_COLORS.muted, marginTop: 4 }}>{sub}</div>
        )}
      </div>
      {right}
    </div>
  );
}
