/**
 * HudSelect — dropdown styled for the dark simulation HUD.
 *
 * Replaces the OS-native <select> (which renders a bright white panel that
 * clashes with the dark theme) with an accordion-style disclosure: a header
 * button that expands a panel of options below it. The panel uses a height
 * transition so it eases open like an accordion fold, and each row is
 * keyboard- and click-navigable.
 *
 * The panel is rendered into `document.body` and positioned against the
 * trigger's viewport rect rather than laid out beside it. It used to be an
 * absolutely-positioned sibling, which any scrolling ancestor was free to clip
 * — and the Builder Inspector is exactly that: a 260px `overflow: auto`
 * column. A panel sized to its content (`width: max-content`, up to 560px)
 * opened wider than the column, got cut off at the pane edge, and gave the
 * whole Inspector a horizontal scrollbar. Anchoring to the viewport means the
 * menu is never clipped by whatever it happens to sit inside, and matching the
 * trigger's width means it lands where the control is.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS, SW_Z } from '../design/tokens';
import { Caret } from './Chevron';
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
  /**
   * Optional illustration for this option, shown in a strip pinned to the
   * bottom of the open panel while the row is hovered or keyboard-highlighted.
   *
   * It lives in one shared strip rather than inside each row because the
   * point is comparison: the graphic stays in the same place while the
   * pointer runs down the list, so only the drawing changes and the eye can
   * see one shape become another.
   */
  preview?: ReactNode;
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
  /**
   * Draw the trigger's contents yourself, in place of the default
   * leading / tag / label row. The caret and every behaviour around it —
   * the portalled panel, the anchoring, the keyboard handling — are still
   * the control's.
   *
   * This exists so a surface that already draws an identity chip for the
   * current value can make that chip BE the picker, rather than printing the
   * value twice: once as a read-only badge and once inside a select beneath
   * it. See the Builder inspector's process-block header.
   */
  triggerRender?: (current: HudSelectOption<T> | undefined, open: boolean) => ReactNode;
  /** Style overrides merged into the trigger button — padding, border and
   *  background, for a caller drawing its own chip via `triggerRender`. */
  triggerStyle?: CSSProperties;
}

/** Viewport-space box the panel is pinned to. `bottom` instead of `top` when
 *  the menu has to open upward, so it grows away from the trigger rather than
 *  over it. */
interface PanelAnchor {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
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
  triggerRender,
  triggerStyle,
}: HudSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [anchor, setAnchor] = useState<PanelAnchor>({ left: 0, width: 0, top: -9999 });
  const listboxId = useId();

  const current = options.find((o) => o.value === value);
  const headerLabel = current?.label ?? placeholder;
  // `highlight` tracks both the pointer (onMouseEnter) and the arrow keys, so
  // one lookup serves hovering and keyboard browsing alike.
  const preview = open ? options[highlight]?.preview : undefined;

  // Close on outside click / Esc, and reset highlight when opening.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is portalled, so it is NOT inside rootRef — testing only the
      // root would close the menu on mousedown and unmount the row before its
      // click could land.
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        setOpen(false);
      }
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
  // `highlight` is a dependency because the preview strip is part of the
  // measured content: without it the panel keeps the height it had before
  // the first preview appeared and clips the graphic. `anchor.width` is one
  // because the panel is only as wide as the trigger it has been pinned to,
  // and how much a label wraps decides how tall the list is — measuring
  // before the first pin measures a column of width 0.
  useLayoutEffect(() => {
    if (!innerRef.current) return;
    const measured = innerRef.current.scrollHeight;
    setPanelHeight(Math.min(measured, maxPanelHeight));
  }, [options, open, maxPanelHeight, highlight, anchor.width]);

  /** Pin the panel to the trigger, flipping above it when the space below
   *  cannot hold the list. */
  const measure = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const GAP = 4;
    const EDGE = 8;
    // Never narrower than legible: a `size="sm"` trigger in a table cell is
    // too tight for its own option labels.
    const width = Math.min(
      Math.max(r.width, 180),
      Math.max(120, window.innerWidth - 2 * EDGE),
    );
    const wanted = panelHeight || maxPanelHeight;
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const flip = below < wanted && above > below;
    const next: PanelAnchor = {
      left: Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE)),
      width,
      ...(flip
        ? { bottom: window.innerHeight - r.top + GAP }
        : { top: r.bottom + GAP }),
    };
    // Bail on an unchanged box. This runs on every scroll frame, and
    // `panelHeight` feeds back into it via the height measurement — a fresh
    // object each time would re-render the panel for no reason.
    setAnchor((prev) =>
      prev.left === next.left &&
      prev.width === next.width &&
      prev.top === next.top &&
      prev.bottom === next.bottom
        ? prev
        : next,
    );
  }, [panelHeight, maxPanelHeight]);

  // Re-pin while open. `capture: true` because the scroll that moves the
  // trigger is usually a nested pane's, not the window's, and those do not
  // bubble.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onAny = () => measure();
    window.addEventListener('scroll', onAny, true);
    window.addEventListener('resize', onAny);
    return () => {
      window.removeEventListener('scroll', onAny, true);
      window.removeEventListener('resize', onAny);
    };
  }, [open, measure]);

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
  // A caller that states its own width has already decided how much room the
  // control gets — usually `width="100%"` inside a grid column or a narrow
  // rail. Keeping the 200px floor there would win over `maxWidth: 100%`
  // (min-width beats max-width in CSS) and push the trigger straight out of
  // its section, which is what the Queue Lab parameter rail did to its
  // distribution and discipline pickers. The floor is only a default for
  // callers that say nothing about width; the portalled panel keeps its own
  // 180px legibility floor, so a squeezed trigger still opens a readable menu.
  const rootMinWidth = width === undefined ? minWidth : 0;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        display: 'inline-block',
        minWidth: rootMinWidth,
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
          ...triggerStyle,
        }}
      >
        {triggerRender ? (
          triggerRender(current, open)
        ) : (
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
        )}
        <Caret open={open} color={palette.chevron} />
      </button>

      {/* Accordion panel — wrapper animates max-height for the fold effect,
          inner div is measured for the natural height. Portalled to the body
          so no scrolling ancestor can clip it, and kept mounted while closed
          so there is content to measure and a height to animate from. */}
      {createPortal(
      <div
        ref={panelRef}
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        onKeyDown={onListKeyDown}
        style={{
          position: 'fixed',
          left: anchor.left,
          top: anchor.top,
          bottom: anchor.bottom,
          width: anchor.width,
          maxHeight: open ? panelHeight : 0,
          overflowY: open ? 'auto' : 'hidden',
          background: palette.panelBg,
          backdropFilter: palette.panelBlur ? 'blur(8px)' : undefined,
          WebkitBackdropFilter: palette.panelBlur ? 'blur(8px)' : undefined,
          border: open ? `1px solid ${palette.panelBorder}` : '1px solid transparent',
          borderRadius: SW_RADIUS.sm,
          boxShadow: open ? palette.panelShadow : 'none',
          transition: 'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms ease, box-shadow 160ms ease',
          zIndex: SW_Z.popover,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          visibility: open ? 'visible' : 'hidden',
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
          {preview && (
            <div
              style={{
                marginTop: 4,
                paddingTop: 8,
                borderTop: `1px solid ${palette.panelBorder}`,
              }}
            >
              {preview}
            </div>
          )}
        </div>
      </div>,
      document.body,
      )}
    </div>
  );
}
