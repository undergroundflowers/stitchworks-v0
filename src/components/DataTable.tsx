import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { SW_COLORS, SW_MOTION, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';

/**
 * The app's data table.
 *
 * Every table in Stitchworks had been hand-rolled at its call site, and each
 * one drifted: its own header type, its own row rhythm, its own idea of what
 * a "quiet" row looks like. The worst of it was zebra striping — the station
 * table banded alternate rows with a hard-coded cream `#FAF7F0`, which had
 * been written against a light theme. On the Control Room ground (`paper` is
 * near-black, `ink` near-white) that band paints a white slab under
 * near-white text, and every second row of the table goes unreadable. A
 * banded row is decoration pretending to be structure; a hairline does the
 * same job with none of the contrast risk.
 *
 * So: no banding. One ground, hairline rules between rows, a header well that
 * reads as a header because of its type and its rule — not because it is a
 * different colour of paint. Numbers use `SW_TYPE.numeric` (tabular figures),
 * so a column of them lines up on the decimal without any extra work.
 *
 * ## Resizable columns
 *
 * A dense table is always a negotiation: `Operation` wants room to breathe,
 * `ρ theory` needs six characters and never more. Fixed widths guess that
 * negotiation once, at build time, for every factory. Instead each column
 * declares a starting width and the user drags the rule between headers to
 * settle it themselves. Double-click a handle to put that column back.
 *
 * Widths are plain pixels, and the grid is all-pixel, so a drag moves exactly
 * as far as the pointer does. When the columns outgrow the container the
 * table scrolls sideways rather than crushing every column to fit — the
 * crushing is what loses the information in the first place.
 *
 * Pass `storageKey` and the user's widths survive a reload.
 */

export interface DataTableColumn<T> {
  /** Stable identity — used for React keys and for width persistence. */
  key: string;
  /** Header content. Plain strings get the overline treatment automatically. */
  header?: ReactNode;
  /** Starting width in px. The user's drag overrides it from then on. */
  width: number;
  /** Floor for a drag. Defaults to 48px — below that a header is unreadable. */
  minWidth?: number;
  /** Numbers and codes right-align; text left-aligns. Default 'left'. */
  align?: 'left' | 'right';
  /** Render the cell in tabular mono. Use for anything numeric. */
  numeric?: boolean;
  /** Cell content for one row. */
  cell: (row: T, index: number) => ReactNode;
}

/** Per-row emphasis. `tone` tints the row and paints a left edge; `muted`
 *  is for rows that are present but not the point. */
export interface DataTableRowStyle {
  tone?: string | null;
  muted?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Whole-row click. Adds the pointer cursor and a hover lift. */
  onRowClick?: (row: T, index: number) => void;
  rowStyle?: (row: T, index: number) => DataTableRowStyle | null | undefined;
  /** Shown in place of the body when `rows` is empty. */
  empty?: ReactNode;
  /** localStorage key for the user's column widths. Omit to keep them
   *  in-memory for the life of the mount. */
  storageKey?: string;
  style?: CSSProperties;
}

/** Width of the invisible grab strip straddling each column rule. */
const HANDLE_W = 9;
const DEFAULT_MIN_W = 48;

function readStoredWidths(storageKey: string | undefined): Record<string, number> {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowStyle,
  empty,
  storageKey,
  style,
}: DataTableProps<T>) {
  const [widths, setWidths] = useState<Record<string, number>>(() => readStoredWidths(storageKey));
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [hoverRow, setHoverRow] = useState<number | null>(null);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // A full quota is not worth failing a table render over.
    }
  }, [storageKey, widths]);

  const widthOf = useCallback(
    (c: DataTableColumn<T>) => widths[c.key] ?? c.width,
    [widths],
  );

  /**
   * All-pixel tracks plus one flexible filler at the tail.
   *
   * The pixel tracks are what make a drag move exactly as far as the pointer
   * does. The filler soaks up whatever width is left over so the table still
   * fills its card instead of ending in a ragged edge — and it collapses to
   * zero the moment the columns outgrow the box, handing the overflow to the
   * horizontal scroll. Nothing is placed into it: grid auto-placement fills
   * the first N tracks and leaves the last one empty.
   */
  const template = useMemo(
    () => `${columns.map((c) => `${widthOf(c)}px`).join(' ')} minmax(0, 1fr)`,
    [columns, widthOf],
  );

  /**
   * Drag a column rule.
   *
   * Bound to `window` rather than the handle so the drag survives the pointer
   * running ahead of the element — at speed the cursor leaves a 9px strip
   * long before the layout catches up, and a handle-bound listener would drop
   * the gesture mid-pull.
   */
  const beginResize = (col: DataTableColumn<T>, startX: number) => {
    const from = widthOf(col);
    const floor = col.minWidth ?? DEFAULT_MIN_W;
    setDragKey(col.key);
    const move = (ev: MouseEvent) => {
      const next = Math.max(floor, Math.round(from + (ev.clientX - startX)));
      setWidths((w) => ({ ...w, [col.key]: next }));
    };
    const up = () => {
      setDragKey(null);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const resetColumn = (col: DataTableColumn<T>) =>
    setWidths((w) => {
      const next = { ...w };
      delete next[col.key];
      return next;
    });

  return (
    <div
      style={{
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        // The columns own their widths; when their sum outgrows the box the
        // table scrolls. Squeezing instead is what loses the numbers.
        overflowX: 'auto',
        // A resize drag would otherwise select the header text it passes over.
        userSelect: dragKey ? 'none' : undefined,
        cursor: dragKey ? 'col-resize' : undefined,
        ...style,
      }}
    >
      <div style={{ minWidth: 'min-content' }}>
        {/* Header. It reads as a header through type and the rule beneath it,
            not through a slab of contrasting paint. */}
        <div
          role="row"
          style={{
            display: 'grid',
            gridTemplateColumns: template,
            alignItems: 'end',
            background: SW_COLORS.paperDeep,
            borderBottom: `1px solid ${SW_COLORS.line}`,
          }}
        >
          {columns.map((c, ci) => (
            <div
              key={c.key}
              role="columnheader"
              style={{
                ...SW_TYPE.overline,
                position: 'relative',
                minWidth: 0,
                padding: '9px 10px',
                color: SW_COLORS.muted,
                textAlign: c.align === 'right' ? 'right' : 'left',
                // Headers never wrap: a two-line header misaligns the whole
                // row and hides which column you are actually resizing.
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {c.header}
              {ci < columns.length - 1 && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize column ${c.key}`}
                  title="Drag to resize · double-click to reset"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    beginResize(c, e.clientX);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    resetColumn(c);
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    right: -HANDLE_W / 2,
                    width: HANDLE_W,
                    cursor: 'col-resize',
                    // The rule itself is a 1px core inside the grab strip, so
                    // the target is finger-sized while the line stays hair-thin.
                    display: 'flex',
                    justifyContent: 'center',
                    zIndex: 1,
                  }}
                >
                  <div
                    style={{
                      width: 1,
                      height: '100%',
                      background: dragKey === c.key ? SW_COLORS.brand : SW_COLORS.lineSoft,
                      transition: `background ${SW_MOTION.instant}ms linear`,
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {rows.length === 0 && empty !== undefined ? (
          <div style={{ ...SW_TYPE.caption, padding: '14px 12px', color: SW_COLORS.muted }}>
            {empty}
          </div>
        ) : (
          rows.map((row, ri) => {
            const rs = rowStyle?.(row, ri);
            const tone = rs?.tone ?? null;
            const hovered = hoverRow === ri;
            return (
              <div
                key={rowKey(row, ri)}
                role="row"
                onClick={onRowClick ? () => onRowClick(row, ri) : undefined}
                onMouseEnter={() => setHoverRow(ri)}
                onMouseLeave={() => setHoverRow((r) => (r === ri ? null : r))}
                style={{
                  display: 'grid',
                  gridTemplateColumns: template,
                  alignItems: 'center',
                  // One ground for every row. Emphasis is a tint on top of it,
                  // never an alternating slab.
                  background: tone
                    ? alpha(tone, hovered ? 0.16 : 0.1)
                    : hovered
                      ? SW_COLORS.paperDeep
                      : 'transparent',
                  borderBottom:
                    ri === rows.length - 1 ? 'none' : `1px solid ${SW_COLORS.lineSoft}`,
                  // A tone-carrying row gets a left edge in its own colour —
                  // the structural signal the banding was failing to give.
                  boxShadow: tone ? `inset 3px 0 0 0 ${tone}` : undefined,
                  cursor: onRowClick ? 'pointer' : undefined,
                  opacity: rs?.muted ? 0.62 : 1,
                  transition: `background ${SW_MOTION.instant}ms linear`,
                }}
              >
                {columns.map((c) => (
                  <div
                    key={c.key}
                    role="cell"
                    style={{
                      ...(c.numeric ? SW_TYPE.numeric : SW_TYPE.body),
                      minWidth: 0,
                      padding: '9px 10px',
                      textAlign: c.align === 'right' ? 'right' : 'left',
                      color: SW_COLORS.ink,
                      // Cells clip rather than wrap: a wrapped cell changes the
                      // height of its whole row and breaks the scan down a
                      // column. If a value is cut off, widen the column — that
                      // is what the handles are for. The title carries the full
                      // value for anything that does get clipped.
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.cell(row, ri)}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
