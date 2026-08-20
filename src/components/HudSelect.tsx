/**
 * HudSelect — dropdown styled for the dark simulation HUD.
 *
 * Replaces the OS-native <select> (which renders a bright white panel that
 * clashes with the dark theme) with an accordion-style disclosure: a header
 * button that expands a panel of options below it. The panel uses a height
 * transition so it eases open like an accordion fold, and each row is
 * keyboard- and click-navigable.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS } from '../design/tokens';
import { alpha } from '../design/color-utils';

export interface HudSelectOption<T extends string> {
  value: T;
  /** Primary label shown in the row + header. */
  label: string;
  /** Optional leading visual (e.g. SVG icon) rendered before the label
   *  in both the trigger header and option rows. Sized by the caller. */
  leading?: ReactNode;
  /** Optional muted right-aligned metadata, e.g. "28 ops · 741/day". */
  meta?: string;
  /** Optional left-aligned tag chip, e.g. "BASE". */
  tag?: string;
  /** Disable selection of this option. */
  disabled?: boolean;
}

export interface HudSelectProps<T extends string> {
  value: T;
  options: HudSelectOption<T>[];
  onChange: (value: T) => void;
  /** Minimum width of the trigger; the panel matches the trigger width. */
  minWidth?: number;
  /** Width override — useful inside fixed-grid layouts. */
  width?: number | string;
  /** Cap the panel height before it scrolls. */
  maxPanelHeight?: number;
  /** Text shown when no value matches. */
  placeholder?: string;
  /** Force-disable the whole control. */
  disabled?: boolean;
  /** Render label rows in mono for that terminal feel; defaults to body. */
  mono?: boolean;
  /** Optional title shown on hover of the trigger. */
  title?: string;
  /**
   * Surface palette — 'dark' for the HUD (dark glass over the iso scene),
   * 'light' for paper-card contexts like Settings, Builder, Resources.
   */
  variant?: 'dark' | 'light';
  /** Compact density for inline cells (tables, toolbars). */
  size?: 'sm' | 'md';
}

export function HudSelect<T extends string>({
  value,
  options,
  onChange,
  minWidth = 200,
  width,
  maxPanelHeight = 320,
  placeholder = 'Select…',
  disabled = false,
  mono = false,
  title,
  variant = 'dark',
  size = 'md',
}: HudSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const listboxId = useId();

  const current = options.find((o) => o.value === value);
  const headerLabel = current?.label ?? placeholder;

  // Close on outside click / Esc, and reset highlight when opening.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, options, value]);

  // Measure the panel's natural height so we can animate max-height from 0
  // to the real value — needed for a smooth accordion fold without
  // hard-coding pixel heights.
  useLayoutEffect(() => {
    if (!innerRef.current) return;
    const measured = innerRef.current.scrollHeight;
    setPanelHeight(Math.min(measured, maxPanelHeight));
  }, [options, open, maxPanelHeight]);

  const choose = (opt: HudSelectOption<T>) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      return;
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight >= 0 && highlight < options.length) choose(options[highlight]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlight(options.length - 1);
    }
  };

  // Variant palettes — same accordion structure, two surfaces. The dark
  // palette floats translucently on a near-black ground (the sim HUD, the
  // iso scene); the light palette sits on a solid panel card.
  //
  // The dark palette's overlays are alphas of `ink`, not `paper`: on this
  // ground a paper-alpha is dark-on-dark and disappears. It read `paper`
  // until the Control Room flip swapped which token was the near-white.
  const palette = variant === 'dark'
    ? {
        trigBg: alpha(SW_COLORS.ink, 0.06),
        trigBgOpen: alpha(SW_COLORS.ink, 0.09),
        trigBgHover: alpha(SW_COLORS.ink, 0.08),
        trigBorder: alpha(SW_COLORS.ink, 0.15),
        trigBorderOpen: `${SW_COLORS.brand}99`,
        trigText: SW_COLORS.ink,
        trigPlaceholder: alpha(SW_COLORS.ink, 0.44),
        chevron: alpha(SW_COLORS.ink, 0.56),
        panelBg: alpha(SW_COLORS.steel, 0.95),
        panelBlur: true,
        panelBorder: `${SW_COLORS.brand}55`,
        panelShadow: SW_SHADOWS.hud,
        rowText: alpha(SW_COLORS.ink, 0.82),
        rowTextSelected: SW_COLORS.ink,
        rowBgActive: alpha(SW_COLORS.ink, 0.06),
        rowBgSelected: `${SW_COLORS.brand}26`,
        tagBg: alpha(SW_COLORS.ink, 0.08),
        tagBgSelected: `${SW_COLORS.brand}40`,
        tagBorder: `${SW_COLORS.brand}55`,
        tagText: SW_COLORS.brand,
        tagTextSelected: SW_COLORS.ink,
        metaText: alpha(SW_COLORS.ink, 0.44),
        emptyText: alpha(SW_COLORS.ink, 0.38),
      }
    : {
        trigBg: SW_COLORS.paper,
        trigBgOpen: SW_COLORS.paper,
        trigBgHover: `${SW_COLORS.ink}0F`,
        trigBorder: SW_COLORS.line,
        trigBorderOpen: `${SW_COLORS.brand}99`,
        trigText: SW_COLORS.ink,
        trigPlaceholder: SW_COLORS.muted,
        chevron: SW_COLORS.muted,
        panelBg: SW_COLORS.steel,
        panelBlur: true,
        panelBorder: `${SW_COLORS.brand}66`,
        panelShadow: SW_SHADOWS.hud,
        rowText: SW_COLORS.ink,
        rowTextSelected: SW_COLORS.brand,
        rowBgActive: `${SW_COLORS.ink}0F`,
        rowBgSelected: `${SW_COLORS.brand}1A`,
        tagBg: `${SW_COLORS.ink}0F`,
        tagBgSelected: `${SW_COLORS.brand}26`,
        tagBorder: `${SW_COLORS.brand}55`,
        tagText: SW_COLORS.brand,
        tagTextSelected: SW_COLORS.brand,
        metaText: SW_COLORS.muted,
        emptyText: SW_COLORS.muted,
      };

  // Density tuning — `sm` shrinks padding/font so the trigger fits inline
  // in a table cell or a tight toolbar row.
  const dims = size === 'sm'
    ? { trigPad: '4px 8px', trigFs: 11, rowPad: '6px 8px', rowFs: 11, tagFs: 9 }
    : { trigPad: '6px 10px', trigFs: 12, rowPad: '7px 10px', rowFs: 12, tagFs: 9 };

  // We size the root explicitly (default = minWidth) and cap it at 100% of
  // its parent. Without this, `display: inline-block` lets the root grow to
  // the natural width of the (potentially very long) label, which makes the
  // absolutely-positioned panel balloon — see the Builder SCENARIO picker
  // with names like "Kid's Pant — Arunima Sportswear · Proposed".
  const rootWidth = width ?? minWidth;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        display: 'inline-block',
        minWidth,
        width: rootWidth,
        maxWidth: '100%',
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        title={title ?? current?.label}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: dims.trigPad,
          border: `1px solid ${open ? palette.trigBorderOpen : palette.trigBorder}`,
          background: open ? palette.trigBgOpen : palette.trigBg,
          color: palette.trigText,
          borderRadius: SW_RADIUS.sm,
          fontFamily: mono ? SW_FONTS.mono : SW_FONTS.body,
          fontWeight: 700,
          fontSize: dims.trigFs,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          letterSpacing: mono ? '0.04em' : 'normal',
          transition: 'background 120ms ease, border-color 120ms ease',
          textAlign: 'left',
          boxShadow: variant === 'light' && open
            ? `0 0 0 3px ${SW_COLORS.brand}22`
            : 'none',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: current ? palette.trigText : palette.trigPlaceholder,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
          }}
        >
          {current?.leading && (
            <span style={{ display: 'inline-flex', flex: '0 0 auto' }}>
              {current.leading}
            </span>
          )}
          {current?.tag && (
            <span
              style={{
                display: 'inline-block',
                padding: '1px 6px',
                background: palette.tagBg,
                color: palette.tagText,
                border: `1px solid ${palette.tagBorder}`,
                borderRadius: 3,
                fontFamily: SW_FONTS.mono,
                fontSize: dims.tagFs,
                fontWeight: 800,
                letterSpacing: '0.08em',
              }}
            >
              {current.tag}
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {headerLabel}
          </span>
        </span>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 180ms ease',
            color: open ? SW_COLORS.brand : palette.chevron,
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          ▾
        </span>
      </button>

      {/* Accordion panel — wrapper animates max-height for the fold effect,
          inner div is measured for the natural height. */}
      <div
        ref={panelRef}
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        onKeyDown={onListKeyDown}
        style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          minWidth: '100%',
          width: 'max-content',
          maxWidth: 'min(560px, 96vw)',
          maxHeight: open ? panelHeight : 0,
          overflowY: open ? 'auto' : 'hidden',
          background: palette.panelBg,
          backdropFilter: palette.panelBlur ? 'blur(8px)' : undefined,
          WebkitBackdropFilter: palette.panelBlur ? 'blur(8px)' : undefined,
          border: open ? `1px solid ${palette.panelBorder}` : '1px solid transparent',
          borderRadius: SW_RADIUS.sm,
          boxShadow: open ? palette.panelShadow : 'none',
          transition: 'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms ease, box-shadow 160ms ease',
          zIndex: 50,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div ref={innerRef} style={{ padding: 4 }}>
          {options.map((opt, i) => {
            const selected = opt.value === value;
            const active = i === highlight;
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={selected}
                aria-disabled={opt.disabled}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(opt)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: dims.rowPad,
                  borderRadius: SW_RADIUS.sm - 2,
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  opacity: opt.disabled ? 0.4 : 1,
                  background: selected
                    ? palette.rowBgSelected
                    : active
                    ? palette.rowBgActive
                    : 'transparent',
                  borderLeft: selected
                    ? `2px solid ${SW_COLORS.brand}`
                    : '2px solid transparent',
                  color: selected ? palette.rowTextSelected : palette.rowText,
                  fontFamily: mono ? SW_FONTS.mono : SW_FONTS.body,
                  fontSize: dims.rowFs,
                  fontWeight: selected ? 800 : 600,
                  letterSpacing: mono ? '0.04em' : 'normal',
                  transition: 'background 90ms ease, color 90ms ease',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {opt.leading && (
                    <span style={{ flex: '0 0 auto', display: 'inline-flex' }}>
                      {opt.leading}
                    </span>
                  )}
                  {opt.tag && (
                    <span
                      style={{
                        flex: '0 0 auto',
                        padding: '1px 6px',
                        background: selected ? palette.tagBgSelected : palette.tagBg,
                        color: selected ? palette.tagTextSelected : palette.tagText,
                        border: `1px solid ${selected ? SW_COLORS.brand : palette.tagBorder}`,
                        borderRadius: 3,
                        fontFamily: SW_FONTS.mono,
                        fontSize: dims.tagFs,
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                      }}
                    >
                      {opt.tag}
                    </span>
                  )}
                  <span style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
                    {opt.label}
                  </span>
                </span>
                {opt.meta && (
                  <span
                    style={{
                      flex: '0 0 auto',
                      fontFamily: SW_FONTS.mono,
                      fontSize: 10,
                      fontWeight: 700,
                      color: selected ? SW_COLORS.brand : palette.metaText,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {opt.meta}
                  </span>
                )}
                {selected && (
                  <span
                    aria-hidden
                    style={{
                      flex: '0 0 auto',
                      color: SW_COLORS.brand,
                      fontSize: 11,
                      fontWeight: 900,
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
            );
          })}
          {options.length === 0 && (
            <div
              style={{
                padding: '10px 12px',
                color: palette.emptyText,
                fontFamily: SW_FONTS.mono,
                fontSize: 11,
                fontStyle: 'italic',
              }}
            >
              No options.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
