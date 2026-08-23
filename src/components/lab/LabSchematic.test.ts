/**
 * Schematic layout — specifically the cycle handling, which is where the
 * blank-canvas bug lived.
 */

import { describe, expect, it } from 'vitest';
import { analyseTopology } from './LabSchematic';
import type { QueueEdge, QueueNode } from '../../simulation/network';

const node = (id: string): QueueNode => ({
  id,
  name: id,
  externalArrivalPerHr: 0,
  serviceDist: { kind: 'exp', mean: 6 },
  servers: 1,
  capacity: Infinity,
  discipline: 'FCFS',
});

const edge = (from: string, to: string): QueueEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  probability: 1,
});

describe('a plain chain ranks 0, 1, 2', () => {
  it('ranks in order and finds no back edges', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const { rank, backEdges } = analyseTopology(nodes, [edge('a', 'b'), edge('b', 'c')]);
    expect(rank.get('a')).toBe(0);
    expect(rank.get('b')).toBe(1);
    expect(rank.get('c')).toBe(2);
    expect(backEdges.size).toBe(0);
  });
});

describe('a rework loop does not inflate the ranks', () => {
  /**
   * The regression this exists for: relaxing the back edge along with the
   * forward one pushed a two-node loop to ranks 3 and 4 on the second pass,
   * which put both stages outside the SVG viewBox and drew an empty card.
   */
  it('keeps a two-node loop at ranks 0 and 1', () => {
    const nodes = [node('sew'), node('check')];
    const edges = [edge('sew', 'check'), edge('check', 'sew')];
    const { rank, backEdges } = analyseTopology(nodes, edges);
    expect(rank.get('sew')).toBe(0);
    expect(rank.get('check')).toBe(1);
    expect(backEdges.has('check->sew')).toBe(true);
    expect(backEdges.has('sew->check')).toBe(false);
  });

  it('bounds every rank by the node count, however tangled', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(node);
    const edges = [
      edge('a', 'b'), edge('b', 'c'), edge('c', 'd'),
      edge('d', 'a'), edge('c', 'b'), edge('d', 'b'),
    ];
    const { rank } = analyseTopology(nodes, edges);
    for (const n of nodes) {
      expect(rank.get(n.id)).toBeGreaterThanOrEqual(0);
      expect(rank.get(n.id)).toBeLessThan(nodes.length);
    }
  });

  it('a self-loop is a back edge and leaves the rank at 0', () => {
    const nodes = [node('solo')];
    const { rank, backEdges } = analyseTopology(nodes, [edge('solo', 'solo')]);
    expect(rank.get('solo')).toBe(0);
    expect(backEdges.has('solo->solo')).toBe(true);
  });
});

describe('branches share a column and ranks stay contiguous', () => {
  it('puts both routes at rank 1', () => {
    const nodes = [node('cut'), node('x'), node('y')];
    const { rank } = analyseTopology(nodes, [edge('cut', 'x'), edge('cut', 'y')]);
    expect(rank.get('cut')).toBe(0);
    expect(rank.get('x')).toBe(1);
    expect(rank.get('y')).toBe(1);
  });

  it('a merge sits behind its longest input, not its first', () => {
    // a → b → d and a → d: d must land at 2, not 1.
    const nodes = ['a', 'b', 'd'].map(node);
    const { rank } = analyseTopology(nodes, [edge('a', 'b'), edge('b', 'd'), edge('a', 'd')]);
    expect(rank.get('d')).toBe(2);
  });
});

describe('disconnected nodes are still placed', () => {
  it('ranks an orphan at 0 rather than dropping it', () => {
    const nodes = [node('a'), node('b'), node('orphan')];
    const { rank } = analyseTopology(nodes, [edge('a', 'b')]);
    expect(rank.get('orphan')).toBe(0);
    expect(rank.size).toBe(3);
  });
});
