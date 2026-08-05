import { useState, type DragEvent } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import type { Operation } from '../domain';
import { balance, DEFAULT_BALANCER } from '../domain/balancers';

export interface OperatorAssignment {
  /** Display id, e.g. "OPR-01". */
  id: string;
  /** Operations this operator runs, in order. */
  operations: Operation[];
}

interface YamazumiProps {
  /** One bar per operator. */
  assignments: OperatorAssignment[];
  /** Takt time in minutes per piece. Bar exceeding takt = bottleneck. */
  taktMin: number;
  /** Chart height in pixels (the bars area). */
  height?: number;
  /**
   * Optional change handler. When provided, operation segments become
   * draggable; dropping a segment on another operator's bar moves the
   * operation between operators and emits the new assignment list.
   */
  onChange?: (next: OperatorAssignment[]) => void;
}

/**
 * Yamazumi chart — operator-by-operation stacked SMV bars with a takt-time
 * reference line. Drag any operation segment onto another operator to
 * rebalance manually; release outside a bar to cancel. Segment colour is
 * the operation's category (sewing / manual / pressing / inspection / fusing).
 *
 * Pure HTML implementation (no SVG) so HTML5 drag-and-drop works reliably
 * across browsers and the layout stays accessible.
 */
export function Yamazumi({ assignments, taktMin, height = 300, onChange }: YamazumiProps) {
  const totals = assignments.map((a) => a.operations.reduce((s, o) => s + o.smv, 0));
  const yMax = Math.max(taktMin * 1.25, ...totals, 0.1);

  const tickStep = yMax > 4 ? 1 : yMax > 2 ? 0.5 : 0.2;
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += tickStep) ticks.push(Number(v.toFixed(2)));

  const [hoverOpId, setHoverOpId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const draggable = !!onChange;

  function onDragStart(e: DragEvent<HTMLDivElement>, fromId: string, op: Operation) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-stitchworks-op', JSON.stringify({ fromId, opId: op.id }));
    setHoverOpId(op.id);
  }

  function onDragEnd() {
    setHoverOpId(null);
    setDropTargetId(null);
  }

  function onBarDragOver(e: DragEvent<HTMLDivElement>, toId: string) {
    if (!draggable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTargetId !== toId) setDropTargetId(toId);
  }

  function onBarDrop(e: DragEvent<HTMLDivElement>, toId: string) {
    if (!draggable || !onChange) return;
    e.preventDefault();
    setDropTargetId(null);
    setHoverOpId(null);
    const raw = e.dataTransfer.getData('text/x-stitchworks-op');
    if (!raw) return;
    let payload: { fromId: string; opId: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.fromId === toId) return;
    moveOperation(payload.fromId, payload.opId, toId);
  }

  function moveOperation(fromId: string, opId: string, toId: string) {
    if (!onChange) return;
    const fromIdx = assignments.findIndex((a) => a.id === fromId);
    const toIdx = assignments.findIndex((a) => a.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const op = assignments[fromIdx].operations.find((o) => o.id === opId);
    if (!op) return;
    const next = assignments.map((a, i) => {
      if (i === fromIdx) {
        return { ...a, operations: a.operations.filter((o) => o.id !== opId) };
      }
      if (i === toIdx) {
        return { ...a, operations: [...a.operations, op] };
      }
      return a;
    });
    onChange(next);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '52px 1fr',
          height,
        }}
      >
        {/* y-axis labels */}
        <div
          style={{
            position: 'relative',
            borderRight: `1px solid ${SW_COLORS.line}`,
          }}
        >
          {ticks.map((v) => (
            <div
              key={v}
              style={{
                position: 'absolute',
                right: 8,
                bottom: `calc(${(v / yMax) * 100}% - 6px)`,
                fontFamily: SW_FONTS.mono,
                fontSize: 9,
                fontWeight: 700,
                color: SW_COLORS.muted,
              }}
            >
              {v.toFixed(2)}
            </div>
          ))}
          <div
            style={{
              position: 'absolute',
              left: 4,
              top: '50%',
              transform: 'translate(-50%, -50%) rotate(-90deg)',
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: SW_COLORS.muted,
              whiteSpace: 'nowrap',
            }}
          >
            SMV (min)
          </div>
        </div>

        {/* Bars area */}
        <div style={{ position: 'relative', overflowX: 'auto' }}>
          {/* horizontal grid lines */}
          {ticks.map((v) => (
            <div
              key={v}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `${(v / yMax) * 100}%`,
                height: 1,
                background: v === 0 ? SW_COLORS.line : `${SW_COLORS.line}80`,
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* takt-time line */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: `${(taktMin / yMax) * 100}%`,
              height: 0,
              borderTop: `1.5px dashed ${SW_COLORS.brand}`,
              pointerEvents: 'none',
              zIndex: 2,
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: 6,
              bottom: `calc(${(taktMin / yMax) * 100}% + 4px)`,
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 800,
              color: SW_COLORS.brand,
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            TAKT {taktMin.toFixed(3)} min
          </div>

          {/* Bars row */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'flex-end',
              gap: 4,
              padding: '0 8px',
            }}
          >
            {assignments.map((a, i) => {
              const total = totals[i];
              const isOver = total > taktMin;
              const isDropTarget = dropTargetId === a.id;
              return (
                <div
                  key={a.id}
                  onDragOver={(e) => onBarDragOver(e, a.id)}
                  onDragLeave={() => setDropTargetId((cur) => (cur === a.id ? null : cur))}
                  onDrop={(e) => onBarDrop(e, a.id)}
                  style={{
                    flex: 1,
                    minWidth: 36,
                    maxWidth: 56,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    position: 'relative',
                    background: isDropTarget ? `${SW_COLORS.brand}10` : 'transparent',
                    borderRadius: SW_RADIUS.sm,
                    transition: 'background 100ms',
                  }}
                >
                  {/* Total label */}
                  <div
                    style={{
                      position: 'absolute',
                      top: `calc(${100 - (total / yMax) * 100}% - 16px)`,
                      left: 0,
                      right: 0,
                      textAlign: 'center',
                      fontFamily: SW_FONTS.mono,
                      fontSize: 9,
                      fontWeight: 700,
                      color: isOver ? SW_COLORS.alarm : SW_COLORS.ink,
                      pointerEvents: 'none',
                    }}
                  >
                    {total.toFixed(2)}
                  </div>

                  {/* Stack of operation segments, bottom-up */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column-reverse',
                      height: `${(total / yMax) * 100}%`,
                      width: '100%',
                      borderRadius: SW_RADIUS.sm,
                      overflow: 'hidden',
                    }}
                  >
                    {a.operations.map((op) => {
                      const segPct = (op.smv / yMax) * 100;
                      const dragging = hoverOpId === op.id;
                      const fill = colorForCategory(op.category);
                      return (
                        <div
                          key={op.id}
                          draggable={draggable}
                          onDragStart={(e) => onDragStart(e, a.id, op)}
                          onDragEnd={onDragEnd}
                          title={`${op.code ? `${op.code} ` : ''}${op.name} · ${op.smv.toFixed(2)} min · ${op.machineCode}`}
                          style={{
                            height: `${(segPct / ((total / yMax) * 100)) * 100}%`,
                            background: fill,
                            borderTop: '1px solid #ffffff80',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: SW_COLORS.paper,
                            fontFamily: SW_FONTS.mono,
                            fontSize: 8,
                            fontWeight: 700,
                            cursor: draggable ? 'grab' : 'default',
                            opacity: dragging ? 0.4 : 1,
                            userSelect: 'none',
                          }}
                        >
                          {op.code ?? op.name.slice(0, 4)}
                        </div>
                      );
                    })}
                  </div>

                  {/* Operator id label */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: -16,
                      left: 0,
                      right: 0,
                      textAlign: 'center',
                      fontFamily: SW_FONTS.mono,
                      fontSize: 9,
                      fontWeight: 700,
                      color: SW_COLORS.muted,
                      pointerEvents: 'none',
                    }}
                  >
                    {a.id}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend + drag hint */}
      <div
        style={{
          marginTop: 22,
          display: 'flex',
          gap: 14,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {LEGEND.map((l) => (
          <div key={l.cat} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, background: colorForCategory(l.cat), borderRadius: 2 }} />
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, color: SW_COLORS.muted }}>{l.label}</span>
          </div>
        ))}
        {draggable && (
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: SW_COLORS.brand,
            }}
          >
            ⇅ DRAG OPERATIONS BETWEEN OPERATORS TO REBALANCE
          </span>
        )}
      </div>
    </div>
  );
}

const LEGEND: { cat: Operation['category']; label: string }[] = [
  { cat: 'sewing',     label: 'SEW' },
  { cat: 'manual',     label: 'MNL' },
  { cat: 'pressing',   label: 'PRESS' },
  { cat: 'inspection', label: 'INSP' },
  { cat: 'fusing',     label: 'FUSE' },
];

function colorForCategory(cat: Operation['category']): string {
  switch (cat) {
    case 'sewing':     return SW_COLORS.brand;
    case 'manual':     return SW_COLORS.muted;
    case 'pressing':   return SW_COLORS.thread;
    case 'inspection': return SW_COLORS.alarm;
    case 'fusing':     return SW_COLORS.press;
    case 'cutting':    return SW_COLORS.bobbin;
    case 'spreading':  return SW_COLORS.fabric;
    case 'embroidery': return SW_COLORS.trim;
    case 'finishing':  return SW_COLORS.ship;
    default:           return SW_COLORS.steel;
  }
}

/**
 * Auto-balance operations across N operators using the project's default
 * heuristic (RPW — Ranked Positional Weight) for precedence-aware
 * balance. Falls back to greedy LPT if the balancer reports no result.
 *
 * Accepts an optional `opEfficiency` map (op-id → 0.5..1.5) derived from
 * the project's skill matrix; the balancer biases assignments so slower
 * operators don't sit on long-SMV ops. Without it, balance is computed
 * at nominal SMV — same numbers a textbook would print.
 *
 * The returned shape is identical to the previous LPT implementation so
 * every existing caller (Reports yamazumi editor, store overrides,
 * scenario forks) keeps working without UI changes.
 */
export function autoAssign(
  ops: Operation[],
  operatorCount: number,
  opEfficiency?: Record<string, number>,
): OperatorAssignment[] {
  const result = balance(DEFAULT_BALANCER, {
    ops,
    operatorCount,
    opEfficiency,
  });
  return result.assignment.map((bucket) => ({
    id: bucket.id,
    operations: bucket.operations,
  }));
}
