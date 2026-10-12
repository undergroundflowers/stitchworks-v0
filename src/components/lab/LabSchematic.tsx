/**
 * The system, drawn.
 *
 * Deliberately NOT a free-form node canvas. The Lab's topology is built with
 * structural verbs — add a stage after this one, branch, send work back — so
 * there is no invalid graph to draw and no reason to make the user place boxes.
 * That buys a layout that is always readable and a picture that always matches
 * the textbook's own figure: input source → queue → service → out.
 *
 * One node draws the classical picture at full width. Two or more draw the same
 * picture per stage, laid left to right in topological rank, with the routing
 * share written on each arrow. Feedback arcs (rework) bow underneath so they
 * read as returns rather than as another forward step.
 */

import { type CSSProperties, type ReactNode } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../../design/tokens';
import { alpha } from '../../design/color-utils';
import { Sym } from '../Sym';
import type { QueueEdge, QueueNode, SolvedNode } from '../../simulation/network';

const STAGE_W = 132;
const STAGE_H = 92;
const GAP_X = 62;
const ROW_H = 150;

export interface LabSchematicProps {
  nodes: QueueNode[];
  edges: QueueEdge[];
  solvedById: Record<string, SolvedNode>;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}

/**
 * Classify edges and rank nodes for layout.
 *
 * A feedback arc has to be identified BEFORE ranking, not inferred from the
 * ranks afterwards. Relaxing every edge in a loop makes both endpoints climb
 * on every pass — a two-node rework loop ends up at ranks 3 and 4 instead of
 * 0 and 1, which pushed the whole schematic outside its own viewBox and drew
 * nothing at all.
 *
 * So: a depth-first walk colours each node white / grey / black, and any edge
 * reaching a GREY node (one still on the current stack) is a back edge — the
 * standard cycle test. Back edges are excluded from ranking and drawn as
 * returns; everything else ranks by longest path from an entry.
 */
interface Topology {
  rank: Map<string, number>;
  backEdges: Set<string>;
}

export function analyseTopology(nodes: QueueNode[], edges: QueueEdge[]): Topology {
  const out = new Map<string, QueueEdge[]>();
  for (const n of nodes) out.set(n.id, []);
  for (const e of edges) out.get(e.from)?.push(e);

  const backEdges = new Set<string>();
  const colour = new Map<string, 'white' | 'grey' | 'black'>();
  for (const n of nodes) colour.set(n.id, 'white');

  // Iterative DFS — a deep chain would blow the stack on the recursive form.
  for (const start of nodes) {
    if (colour.get(start.id) !== 'white') continue;
    const stack: { id: string; next: number }[] = [{ id: start.id, next: 0 }];
    colour.set(start.id, 'grey');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const outs = out.get(frame.id) ?? [];
      if (frame.next >= outs.length) {
        colour.set(frame.id, 'black');
        stack.pop();
        continue;
      }
      const e = outs[frame.next++];
      const c = colour.get(e.to);
      if (c === 'grey') {
        // Points at something still open on this path: a cycle.
        backEdges.add(e.id);
      } else if (c === 'white') {
        colour.set(e.to, 'grey');
        stack.push({ id: e.to, next: 0 });
      }
    }
  }

  // Longest path over the forward edges only. Now acyclic, so |V| relaxations
  // are enough and nothing can run away.
  const rank = new Map<string, number>();
  for (const n of nodes) rank.set(n.id, 0);
  const forward = edges.filter((e) => !backEdges.has(e.id));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of forward) {
      const from = rank.get(e.from);
      const to = rank.get(e.to);
      if (from == null || to == null) continue;
      if (to < from + 1) {
        rank.set(e.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return { rank, backEdges };
}

/** Lay out by rank (column) and by order within rank (row). */
function layout(nodes: QueueNode[], edges: QueueEdge[]) {
  const { rank, backEdges } = analyseTopology(nodes, edges);
  const byRank = new Map<number, QueueNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    const list = byRank.get(r) ?? [];
    list.push(n);
    byRank.set(r, list);
  }
  // Ranks may not start at 0 or be contiguous once back edges are removed;
  // compress them to column indices so the drawing has no empty columns.
  const usedRanks = [...byRank.keys()].sort((a, b) => a - b);
  const colOf = new Map(usedRanks.map((r, i) => [r, i]));

  const pos = new Map<string, { x: number; y: number }>();
  let maxRow = 0;
  for (const r of usedRanks) {
    const col = colOf.get(r)!;
    byRank.get(r)!.forEach((n, i) => {
      pos.set(n.id, { x: col * (STAGE_W + GAP_X), y: i * ROW_H });
      maxRow = Math.max(maxRow, i);
    });
  }
  const cols = Math.max(1, usedRanks.length);
  return {
    pos,
    rank,
    backEdges,
    width: cols * STAGE_W + (cols - 1) * GAP_X,
    height: (maxRow + 1) * ROW_H - (ROW_H - STAGE_H),
  };
}

export function LabSchematic({
  nodes,
  edges,
  solvedById,
  selectedNodeId,
  onSelect,
}: LabSchematicProps) {
  const { pos, backEdges, width, height } = layout(nodes, edges);
  const PAD = 30;
  // Room below for feedback arcs to bow through, and left for the inlet arrow.
  const vbW = width + PAD * 2 + 40;
  const vbH = height + PAD * 2 + 46;

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg
        viewBox={`${-PAD - 34} ${-PAD} ${vbW} ${vbH}`}
        width={Math.max(vbW, 320)}
        height={vbH}
        style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
        role="img"
        aria-label="System schematic"
      >
        <defs>
          <marker
            id="lab-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill={SW_COLORS.muted} />
          </marker>
          <marker
            id="lab-arrow-back"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill={SW_COLORS.warn} />
          </marker>
        </defs>

        {/* External inlets — γ arriving from outside the network. */}
        {nodes.map((n) => {
          if (n.externalArrivalPerHr <= 0) return null;
          const p = pos.get(n.id)!;
          const y = p.y + STAGE_H / 2;
          return (
            <g key={`in-${n.id}`}>
              <line
                x1={p.x - 34}
                y1={y}
                x2={p.x - 6}
                y2={y}
                stroke={SW_COLORS.muted}
                strokeWidth={1.5}
                markerEnd="url(#lab-arrow)"
              />
              <text
                x={p.x - 34}
                y={y - 7}
                fill={SW_COLORS.brandText}
                fontFamily={SW_FONTS.mono}
                fontSize={10}
                fontStyle="italic"
              >
                γ {n.externalArrivalPerHr}
              </text>
            </g>
          );
        })}

        {/* Routing arcs. */}
        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const backward = backEdges.has(e.id);
          const label = e.probability >= 1 ? '' : `${Math.round(e.probability * 100)}%`;

          if (backward) {
            // Feedback: bow under the row so it reads as a return path.
            const y0 = a.y + STAGE_H;
            const dip = a.y + STAGE_H + 34;
            const x0 = a.x + STAGE_W / 2;
            const x1 = b.x + STAGE_W / 2;
            return (
              <g key={e.id}>
                <path
                  d={`M ${x0} ${y0} C ${x0} ${dip}, ${x1} ${dip}, ${x1} ${b.y + STAGE_H}`}
                  fill="none"
                  stroke={SW_COLORS.warn}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  markerEnd="url(#lab-arrow-back)"
                />
                <text
                  x={(x0 + x1) / 2}
                  y={dip + 12}
                  textAnchor="middle"
                  fill={SW_COLORS.warn}
                  fontFamily={SW_FONTS.mono}
                  fontSize={10}
                >
                  {label || '100%'} back
                </text>
              </g>
            );
          }

          const x0 = a.x + STAGE_W;
          const y0 = a.y + STAGE_H / 2;
          const x1 = b.x;
          const y1 = b.y + STAGE_H / 2;
          const mx = (x0 + x1) / 2;
          return (
            <g key={e.id}>
              <path
                d={`M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1 - 6} ${y1}`}
                fill="none"
                stroke={SW_COLORS.muted}
                strokeWidth={1.5}
                markerEnd="url(#lab-arrow)"
              />
              {label && (
                <text
                  x={mx}
                  y={(y0 + y1) / 2 - 6}
                  textAnchor="middle"
                  fill={SW_COLORS.muted}
                  fontFamily={SW_FONTS.mono}
                  fontSize={10}
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* Exits — whatever a node does not route onward leaves here. */}
        {nodes.map((n) => {
          const routed = edges
            .filter((e) => e.from === n.id)
            .reduce((a, e) => a + e.probability, 0);
          if (routed >= 0.999) return null;
          const p = pos.get(n.id)!;
          const y = p.y + STAGE_H / 2;
          return (
            <line
              key={`out-${n.id}`}
              x1={p.x + STAGE_W}
              y1={y}
              x2={p.x + STAGE_W + 26}
              y2={y}
              stroke={SW_COLORS.line}
              strokeWidth={1.5}
              markerEnd="url(#lab-arrow)"
            />
          );
        })}

        {/* Stages. */}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const solved = solvedById[n.id];
          return (
            <Stage
              key={n.id}
              node={n}
              solved={solved}
              x={p.x}
              y={p.y}
              selected={n.id === selectedNodeId}
              onSelect={() => onSelect(n.id)}
            />
          );
        })}
      </svg>
    </div>
  );
}

/**
 * One stage: the queue drawn as a row of slots, the servers as filled squares,
 * and the Kendall label underneath. The slot fill tracks Lq so the picture
 * changes as the user turns the dials — which is the whole point of drawing it
 * rather than tabulating it.
 */
function Stage({
  node,
  solved,
  x,
  y,
  selected,
  onSelect,
}: {
  node: QueueNode;
  solved: SolvedNode | undefined;
  x: number;
  y: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const rho = solved?.kpis.rho ?? 0;
  const tone = !Number.isFinite(rho) || rho >= 1
    ? SW_COLORS.alarm
    : rho >= 0.85
      ? SW_COLORS.warn
      : SW_COLORS.ok;

  const SLOTS = 5;
  // How much of the waiting room is drawn as occupied. Capped so a saturated
  // station reads as "full" rather than running off the end of the box.
  const lq = solved?.kpis.Lq ?? 0;
  const filled = Number.isFinite(lq) ? Math.min(SLOTS, Math.round(lq)) : SLOTS;

  const servers = Math.max(1, Math.min(4, node.servers));

  return (
    <g
      transform={`translate(${x} ${y})`}
      onClick={onSelect}
      style={{ cursor: 'pointer' }}
      role="button"
      aria-label={`Stage ${node.name}`}
    >
      <rect
        width={STAGE_W}
        height={STAGE_H}
        rx={SW_RADIUS.sm}
        fill={selected ? alpha(SW_COLORS.brand, 0.12) : SW_COLORS.paper}
        stroke={selected ? SW_COLORS.brand : SW_COLORS.line}
        strokeWidth={selected ? 2 : 1}
      />

      {/* Waiting room. */}
      {Array.from({ length: SLOTS }, (_, i) => (
        <rect
          key={i}
          x={9 + i * 13}
          y={16}
          width={10}
          height={16}
          rx={2}
          fill={i < filled ? alpha(tone, 0.55) : 'none'}
          stroke={SW_COLORS.line}
          strokeWidth={1}
        />
      ))}

      {/* Servers. */}
      {Array.from({ length: servers }, (_, i) => (
        <circle
          key={i}
          cx={STAGE_W - 22}
          cy={24 + i * 13 - (servers - 1) * 6.5}
          r={5.5}
          fill={alpha(tone, 0.9)}
          stroke={tone}
          strokeWidth={1}
        />
      ))}
      {node.servers > 4 && (
        <text
          x={STAGE_W - 22}
          y={STAGE_H - 30}
          textAnchor="middle"
          fill={SW_COLORS.muted}
          fontFamily={SW_FONTS.mono}
          fontSize={9}
        >
          ×{node.servers}
        </text>
      )}

      <text
        x={9}
        y={STAGE_H - 26}
        fill={SW_COLORS.ink}
        fontFamily={SW_FONTS.body}
        fontSize={11}
        fontWeight={600}
      >
        {node.name.length > 17 ? `${node.name.slice(0, 16)}…` : node.name}
      </text>
      <text
        x={9}
        y={STAGE_H - 12}
        fill={SW_COLORS.muted}
        fontFamily={SW_FONTS.mono}
        fontSize={9}
      >
        {solved?.notation.label ?? ''}
      </text>
      {solved && (
        <text
          x={STAGE_W - 9}
          y={STAGE_H - 12}
          textAnchor="end"
          fill={tone}
          fontFamily={SW_FONTS.mono}
          fontSize={10}
          fontWeight={700}
        >
          {Number.isFinite(rho) ? rho.toFixed(2) : '∞'}
        </text>
      )}
    </g>
  );
}

/**
 * Legend for the schematic.
 *
 * Each entry draws the mark it is naming, at the size and colour the
 * schematic draws it. It used to be a line of prose — "squares are the
 * waiting room · circles are servers" — which asked the reader to hold a
 * description in their head and go matching it against the picture. A legend
 * whose left-hand column is not the actual mark is a sentence, not a key.
 *
 * The swatches are drawn with the same geometry constants `<Stage>` uses, so
 * a change to the schematic's slot or server shape cannot leave the key
 * describing the old one.
 */
function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width={26} height={14} viewBox="0 0 26 14" style={{ display: 'block', flex: 'none' }}>
        {swatch}
      </svg>
      {children}
    </span>
  );
}

export function LabSchematicLegend({ style }: { style?: CSSProperties }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        rowGap: 6,
        flexWrap: 'wrap',
        alignItems: 'center',
        fontFamily: SW_FONTS.mono,
        fontSize: 10,
        color: SW_COLORS.muted,
        ...style,
      }}
    >
      <LegendItem
        swatch={
          <>
            <line
              x1={0} y1={7} x2={20} y2={7}
              stroke={SW_COLORS.muted} strokeWidth={1.5}
              markerEnd="url(#lab-arrow)"
            />
          </>
        }
      >
        <span>
          work in, <Sym quantity="lambda" /> per hour
        </span>
      </LegendItem>

      <LegendItem
        swatch={
          <>
            {[0, 1, 2].map((i) => (
              <rect
                key={i}
                x={1 + i * 8.5} y={2} width={6} height={10} rx={2}
                fill={i === 0 ? alpha(SW_COLORS.ok, 0.55) : 'none'}
                stroke={SW_COLORS.line} strokeWidth={1}
              />
            ))}
          </>
        }
      >
        <span>
          waiting room — filled slots track <Sym quantity="Lq" />
        </span>
      </LegendItem>

      <LegendItem
        swatch={
          <>
            <circle
              cx={8} cy={7} r={5}
              fill={alpha(SW_COLORS.ok, 0.9)} stroke={SW_COLORS.ok} strokeWidth={1}
            />
            <circle
              cx={19} cy={7} r={5}
              fill={alpha(SW_COLORS.ok, 0.9)} stroke={SW_COLORS.ok} strokeWidth={1}
            />
          </>
        }
      >
        <span>
          servers, <Sym quantity="servers" /> of them
        </span>
      </LegendItem>

      <LegendItem
        swatch={
          <>
            <rect x={1} y={2} width={24} height={10} rx={2} fill="none" stroke={SW_COLORS.line} />
            <text
              x={23} y={10} textAnchor="end"
              fill={SW_COLORS.ok} fontFamily={SW_FONTS.mono} fontSize={7} fontWeight={700}
            >
              0.72
            </text>
          </>
        }
      >
        <span>
          corner figure is <Sym quantity="rho" /> — green under 85%, amber to
          100%, red at or past it
        </span>
      </LegendItem>

      <LegendItem
        swatch={
          <>
            <path
              d="M 1 3 C 6 13, 16 13, 21 4"
              fill="none" stroke={SW_COLORS.warn} strokeWidth={1.5} strokeDasharray="4 3"
              markerEnd="url(#lab-arrow-back)"
            />
          </>
        }
      >
        <span style={{ color: SW_COLORS.warn }}>work sent back — rework</span>
      </LegendItem>

      {/* The arrowheads above are `<marker>` refs, and a marker only resolves
          inside a document that defines it. The schematic's own `<defs>` live
          in its `<svg>`, so the legend carries a zero-sized copy of them. */}
      <svg width={0} height={0} aria-hidden style={{ position: 'absolute' }}>
        <defs>
          <marker
            id="lab-arrow" viewBox="0 0 8 8" refX="7" refY="4"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill={SW_COLORS.muted} />
          </marker>
          <marker
            id="lab-arrow-back" viewBox="0 0 8 8" refX="7" refY="4"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill={SW_COLORS.warn} />
          </marker>
        </defs>
      </svg>
    </div>
  );
}
