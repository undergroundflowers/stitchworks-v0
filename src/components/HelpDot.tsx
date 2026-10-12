import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SW_COLORS, SW_RADIUS, SW_SHADOWS, SW_TYPE, SW_Z } from '../design/tokens';
import { Icon } from './Icon';

/**
 * A `?` button that discloses a note on click.
 *
 * The Inspector had taken to printing explanatory prose inline — the PML
 * block panel, for one, carried a permanent "Seize → Delay → Release. The
 * bread-and-butter sewing/iron op." under its header chip. Prose like that is
 * read once and then costs vertical space on every visit, in a 260px column
 * that is already the app's tightest. Behind a `?` it stays reachable and
 * stops competing with the controls.
 *
 * The note is a popover rather than a disclosure that pushes siblings down:
 * opening help should not reflow the panel you were reading. It is portalled
 * to the document root and pinned to the button, because the two places these
 * live — the Inspector's `overflow: auto` column and the canvas legend's
 * `overflow: hidden` slab — would both clip an absolutely-positioned child.
 */
export function HelpDot({
  children,
  label = 'What is this?',
  width = 220,
}: {
  children: ReactNode;
  /** Tooltip + accessible name for the button. */
  label?: string;
  /** Popover width in px. */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number }>({ left: 0, top: -9999 });

  // Click-outside and Escape both close. Bound only while open so the app
  // isn't carrying a document listener per `?` on the page. The note is
  // portalled, so it is not inside `wrapRef` — it needs its own hit test or
  // clicking the note's own text would dismiss it.
  //
  // `capture: true` because these live inside `StageOverlay`, which swallows
  // mousedown so a canvas pan gesture can't steal the click. On the bubble
  // phase that swallowing also hides the event from this listener, and one
  // open note would survive opening the next — a legend of `?`s would stack
  // popovers instead of trading them.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !noteRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Pin the note under the button, right edges flush so it opens *into* the
   *  pane, flipping above when the space below cannot hold it. */
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const GAP = 6;
    const EDGE = 8;
    const h = noteRef.current?.offsetHeight ?? 0;
    const below = window.innerHeight - r.bottom - GAP;
    const top = h > below && r.top - GAP > below ? r.top - GAP - h : r.bottom + GAP;
    const next = {
      left: Math.max(EDGE, Math.min(r.right - width, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, top),
    };
    setAnchor((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [width]);

  // Re-pin while open. `capture: true` because the scroll that moves the
  // button is usually a nested pane's, not the window's, and those do not
  // bubble.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        style={{
          width: 18,
          height: 18,
          display: 'grid',
          placeItems: 'center',
          padding: 0,
          borderRadius: 9,
          cursor: 'pointer',
          background: open ? SW_COLORS.brand : 'transparent',
          color: open
            ? SW_COLORS.paper
            : hover
              ? SW_COLORS.ink
              : SW_COLORS.muted,
          border: `1px solid ${open ? SW_COLORS.brand : SW_COLORS.line}`,
        }}
      >
        <Icon name="help" size={11} />
      </button>

      {open &&
        createPortal(
          <div
            ref={noteRef}
            role="note"
            style={{
              position: 'fixed',
              left: anchor.left,
              top: anchor.top,
              zIndex: SW_Z.popover,
              width,
              padding: '8px 10px',
              background: SW_COLORS.paperDeep,
              border: `1px solid ${SW_COLORS.line}`,
              borderRadius: SW_RADIUS.sm,
              boxShadow: SW_SHADOWS.float,
              ...SW_TYPE.caption,
              color: SW_COLORS.ink,
              lineHeight: 1.5,
              textAlign: 'left',
              whiteSpace: 'normal',
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
