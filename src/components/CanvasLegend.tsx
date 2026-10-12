import { useState, type ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS } from '../design/tokens';
import { Chevron } from './Chevron';
import { HelpDot } from './HelpDot';
import { alpha } from '../design/color-utils';
import { StageOverlay } from './StageOverlay';

/**
 * The collapsible legend that sits directly above the zoom HUD.
 *
 * The Build floor's legend was a fixed, always-open, click-through panel in
 * the bottom-right; the simulation's was a collapsible panel in the
 * bottom-left. Same idea, opposite corner, opposite behaviour — so on one
 * screen you could put the key away and on the other you could not.
 *
 * One shell, collapsed by default, stacked above the zoom HUD in the same
 * corner on every canvas. Each canvas supplies its own rows — as
 * `LegendRow`s, so the shell owns the list shape too and not just the box.
 */
export function CanvasLegend({
  label,
  width,
  children,
}: {
  /** Which view this key describes — shown after "LEGEND ·". */
  label: string;
  /** Expanded width. Omit to size to content. */
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <StageOverlay
      style={{
        position: 'absolute',
        right: 14,
        bottom: 56,
        width: open ? width : 'auto',
        alignItems: 'stretch',
        maxHeight: 'calc(100% - 48px)',
        background: alpha(SW_COLORS.steel, 0.95),
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.md,
        boxShadow: SW_SHADOWS.hud,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 5,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse legend' : 'Expand legend'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          background: 'transparent',
          border: 'none',
          borderBottom: open ? `1px solid ${SW_COLORS.lineSoft}` : 'none',
          color: SW_COLORS.ink,
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 900,
          letterSpacing: '0.18em',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ color: SW_COLORS.brand }}>▣</span>
        <span>LEGEND · {label}</span>
        <span style={{ flex: 1, minWidth: 12 }} />
        <Chevron open={open} />
      </button>
      {open && (
        <div
          style={{
            padding: '6px 10px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            overflow: 'auto',
          }}
        >
          {children}
        </div>
      )}
    </StageOverlay>
  );
}

/**
 * One entry in a legend: a glyph, what it is called, and a `?` for what it
 * means.
 *
 * The Build canvas used to pack its seven entries into two dense horizontal
 * rows of swatch-plus-single-word — "flow operator material" over
 * "B bundle P piece H hanger T takt". At 9px in a 300px panel that is not a
 * key, it is a word search: nothing tells you where one entry stops and the
 * next begins, and every entry has room for a noun and nothing else, so the
 * legend could name the glyphs without ever explaining them.
 *
 * Giving each entry its own line fixed that, but printing the sentence under
 * every name traded one problem for the other: a key you consult at a glance
 * became a column of prose two dozen lines tall, and the glyphs — the part
 * you actually came to match against the canvas — got pushed apart by text
 * you had already read. The sentence moves behind the same `?` the Inspector
 * uses, so a row is one line, the glyphs stack tight enough to scan, and the
 * explanation is still one click away.
 */
export function LegendRow({
  glyph,
  label,
  hint,
}: {
  glyph: ReactNode;
  /** What the glyph is called — the word the rest of the UI uses for it. */
  label: string;
  /** What it means on the floor. One plain sentence, shown behind the `?`. */
  hint?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {/* Fixed glyph column. Swatches differ in width (a 22px rule, a 30px
          rule with a letter badge on it); centring them in a common box is
          what keeps the labels on one left edge. */}
      <div
        style={{
          width: 36,
          height: 22,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {glyph}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: SW_FONTS.mono,
          fontSize: 11,
          fontWeight: 800,
          color: SW_COLORS.ink,
          letterSpacing: '0.04em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={label}
      >
        {label}
      </div>
      {hint && (
        <HelpDot label={`What is "${label}"?`} width={240}>
          {hint}
        </HelpDot>
      )}
    </div>
  );
}
