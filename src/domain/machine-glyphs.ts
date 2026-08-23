import { createElement, type ReactNode } from 'react';
import type { MachineCode } from './machines';

/**
 * The minimal visual vocabulary for a workstation.
 *
 * Stations used to be drawn as little illustrated machines — motor block,
 * arm, needle plate, thread spool, hand wheel, a coloured head per type. That
 * is a lot of ink to say "this is a sewing machine" on a floor where every
 * station is one, and on a 30-station plan it read as clutter rather than
 * information.
 *
 * So the whole vocabulary is now **count and direction of strokes**:
 *
 *   seam   one diagonal      a single running seam        SNL DNL FB
 *   edge   two parallel bars layered rows along an edge   4OL 5OL FL KS
 *   point  two dots          programmed point work        BH BS BT EMB
 *   blade  a cross           crossed blades               CUT CAD
 *   plate  a triangle        flat heat / ply work         SPR FUSE PRESS STEAM
 *   bench  a square          a table, no mechanism        INSP MNL
 *
 * Families are grouped by *what the machine does to cloth*, not by
 * `MachineSpec.category` — that puts ten of the nineteen codes in `sewing`,
 * which is useless on a sewing floor, while `spreading` / `fusing` /
 * `pressing` are three categories that all read as the same flat heat work.
 *
 * Marks are monochrome by contract. Colour on this floor means *state* —
 * bottleneck, blocked, selected — and a machine that is orange because it is
 * a lockstitch cannot also be orange because it is the constraint.
 *
 * The PROCESS canvas draws these same marks on a category-coloured plate, and
 * that is not a violation: the mark there is `contrastInk` — black or white,
 * chosen purely so it reads — while the hue belongs to the plate behind it and
 * encodes the block's PML *role*, not the machine's identity. The contract is
 * about a mark's own hue carrying identity, and no mark ever has one.
 *
 * Emitted with `createElement` rather than JSX so this stays a `.ts` module in
 * `domain/`, callable from both the flat plan view and the isometric
 * fixtures. One vocabulary, two projections, no drift.
 */
export type GlyphFamily = 'seam' | 'edge' | 'point' | 'blade' | 'plate' | 'bench';

export const MACHINE_GLYPH_FAMILY: Record<MachineCode, GlyphFamily> = {
  SNL: 'seam',
  DNL: 'seam',
  FB: 'seam',

  '4OL': 'edge',
  '5OL': 'edge',
  FL: 'edge',
  KS: 'edge',

  BH: 'point',
  BS: 'point',
  BT: 'point',
  EMB: 'point',

  CUT: 'blade',
  CAD: 'blade',

  SPR: 'plate',
  FUSE: 'plate',
  PRESS: 'plate',
  STEAM: 'plate',

  INSP: 'bench',
  MNL: 'bench',
};

/**
 * Draw one family mark centred on (cx, cy).
 *
 * `s` is the mark's actual span, not a box it sits inside — every primitive
 * reaches to about ±s/2, so a caller asking for s = 20 gets a 20px mark.
 *
 * Returns a `<g>` of plain primitives in the caller's user space — no
 * viewBox, no nested `<svg>`, no transform of its own — so it drops straight
 * into a flat plan cell or onto the top face of an isometric cuboid.
 */
export function glyphMark(
  family: GlyphFamily,
  cx: number,
  cy: number,
  s: number,
  color: string,
): ReactNode {
  // Stroke scales with the mark but never thins out to invisibility when a
  // station is small or the canvas is zoomed out.
  const sw = Math.max(1.2, s * 0.12);
  const stroke = { stroke: color, strokeWidth: sw, strokeLinecap: 'round' as const, fill: 'none' };
  const r = s / 2;

  const parts: ReactNode[] = (() => {
    switch (family) {
      // One running seam.
      case 'seam':
        return [
          createElement('line', {
            key: 'd', x1: cx - r, y1: cy + r, x2: cx + r, y2: cy - r, ...stroke,
          }),
        ];

      // Layered rows along an edge.
      case 'edge':
        return [
          createElement('line', {
            key: 'a', x1: cx - r, y1: cy - s * 0.18, x2: cx + r, y2: cy - s * 0.18, ...stroke,
          }),
          createElement('line', {
            key: 'b', x1: cx - r, y1: cy + s * 0.18, x2: cx + r, y2: cy + s * 0.18, ...stroke,
          }),
        ];

      // Programmed point work — the machine stops and works one spot.
      case 'point':
        return [
          createElement('circle', {
            key: 'a', cx: cx - s * 0.26, cy, r: Math.max(1, s * 0.13), fill: color,
          }),
          createElement('circle', {
            key: 'b', cx: cx + s * 0.26, cy, r: Math.max(1, s * 0.13), fill: color,
          }),
        ];

      // Crossed blades.
      case 'blade':
        return [
          createElement('line', {
            key: 'a', x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r, ...stroke,
          }),
          createElement('line', {
            key: 'b', x1: cx + r, y1: cy - r, x2: cx - r, y2: cy + r, ...stroke,
          }),
        ];

      // A flat plate coming down on cloth.
      case 'plate':
        return [
          createElement('path', {
            key: 'a',
            d: `M ${cx} ${cy - r} L ${cx + r} ${cy + s * 0.38} L ${cx - r} ${cy + s * 0.38} Z`,
            ...stroke,
            strokeLinejoin: 'round' as const,
          }),
        ];

      // A table. No mechanism at all.
      case 'bench':
        return [
          createElement('rect', {
            key: 'a',
            x: cx - s * 0.4, y: cy - s * 0.4, width: s * 0.8, height: s * 0.8,
            rx: 1.5, ...stroke, strokeLinejoin: 'round' as const,
          }),
        ];
    }
  })();

  return createElement('g', { 'aria-hidden': true }, ...parts);
}

/**
 * The family for a `stationMark()` result.
 *
 * A built-in machine carries a `code` and resolves through the table above; a
 * user-authored station type carries its family directly, because its code is
 * free text and cannot be a `MachineCode`. Both the flat plan body and the
 * PROCESS block face need this rule, so it lives here rather than being
 * written out at each call site.
 */
export function glyphFamilyOf(mark: {
  code?: MachineCode;
  family?: GlyphFamily;
}): GlyphFamily | undefined {
  return mark.code ? MACHINE_GLYPH_FAMILY[mark.code] : mark.family;
}
