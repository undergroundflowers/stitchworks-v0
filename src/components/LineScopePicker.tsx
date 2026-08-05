/**
 * Which sewing line the analysis surfaces are pointed at.
 *
 * Bound to the shared `useSimScope`, so switching lines here moves the Sim
 * screen too — there is one answer to "what am I looking at" rather than one
 * per page.
 */

import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { useSimScope } from '../store/simScope';
import type { SewingLine } from '../domain/twin';

export interface LineScopePickerProps {
  /** Every line in the twin. A single-line factory renders a static label —
   *  a one-option picker is just noise. */
  lines: SewingLine[];
}

export function LineScopePicker({ lines }: LineScopePickerProps) {
  const scope = useSimScope((s) => s.scope);
  const setScope = useSimScope((s) => s.setScope);

  if (lines.length === 0) return null;

  if (lines.length === 1) {
    return (
      <div style={{ ...SW_TYPE.micro, color: SW_COLORS.muted }}>
        {lines[0].name}
      </div>
    );
  }

  const activeId = scope.kind === 'line' ? scope.id : null;

  const chip = (active: boolean): React.CSSProperties => ({
    ...SW_TYPE.micro,
    padding: '5px 10px',
    borderRadius: SW_RADIUS.sm,
    border: `1px solid ${active ? SW_COLORS.brand : SW_COLORS.line}`,
    background: active ? alpha(SW_COLORS.brand, 0.14) : 'transparent',
    color: active ? SW_COLORS.brand : SW_COLORS.muted,
    cursor: 'pointer',
    fontFamily: SW_FONTS.mono,
  });

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ ...SW_TYPE.overline, color: SW_COLORS.faint }}>SCOPE</span>
      <button
        type="button"
        style={chip(activeId === null)}
        onClick={() => setScope({ kind: 'factory' })}
        title="Analyse every wired sewing line together"
      >
        ALL LINES
      </button>
      {lines.map((l) => (
        <button
          key={l.id}
          type="button"
          style={chip(activeId === l.id)}
          onClick={() => setScope({ kind: 'line', id: l.id })}
          title={`Analyse ${l.name} on its own`}
        >
          {l.name}
        </button>
      ))}
    </div>
  );
}
