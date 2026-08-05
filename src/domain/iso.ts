/**
 * Iso Builder domain — catalogue, palette, and seed layouts for the
 * isometric 3D-feel layout builder. Ported from the design prototype's
 * sw/sw-iso-builder-data.jsx (~540 lines): all SVG draw functions,
 * projection math, default-prop generators, persistence helpers, and
 * the seeded factory + dept layouts. Pure data / pure SVG (returns
 * ReactNode); no DOM, no React hooks, safe to consume from any page.
 */

import { createElement, type ReactNode } from 'react';
import {
  PML_BLOCK_LIBRARY,
  pmlFixtureId,
  type PmlBlockSpec,
  type PmlCategory,
} from './pml';
import type { PmlIconComponent } from '../assets/pml-icons';
import type { MachineCode } from './machines';

// ============================================================================
// ISO PROJECTION
// world (cell) (x,y) at altitude z → screen (sx, sy) in iso pixels
// ============================================================================

export const ISO_TILE = 32; // half-width of an iso diamond (cell)
export const ISO_THIN = ISO_TILE / 2; // half-height of iso diamond
export const ISO_Z = ISO_TILE / 2; // 1 unit altitude in screen pixels (vertical)

export interface IsoPoint {
  sx: number;
  sy: number;
}

export function isoProj(x: number, y: number, z: number = 0): IsoPoint {
  return {
    sx: (x - y) * ISO_TILE,
    sy: (x + y) * ISO_THIN - z * ISO_Z,
  };
}

export function unproject(sx: number, sy: number): { x: number; y: number } {
  // inverse of isoProj at z=0; returns world (x,y)
  return {
    x: (sx / ISO_TILE + sy / ISO_THIN) / 2,
    y: (sy / ISO_THIN - sx / ISO_TILE) / 2,
  };
}

// ============================================================================
// FLAT (2D top-down) PROJECTION
// The Builder's 2D plan view shares the same integer cell grid as ISO but
// maps cells 1:1 onto screen pixels (no diamond skew, no altitude). Both
// projections are packaged as a `Projection` pair so the canvas and its
// page-level handlers can be parameterized instead of forked.
// ============================================================================

export const FLAT_CELL = 40; // px per cell at zoom 1 (2D top-down view)

export interface Projection {
  kind: 'iso' | 'flat';
  project: (x: number, y: number, z?: number) => IsoPoint;
  unproject: (sx: number, sy: number) => { x: number; y: number };
}

/** Top-down projection: z is ignored, so the param is simply omitted —
 *  TypeScript lets a 2-arg function satisfy `Projection.project`'s
 *  `(x, y, z?)` signature. */
export function flatProj(x: number, y: number): IsoPoint {
  return { sx: x * FLAT_CELL, sy: y * FLAT_CELL };
}

export function flatUnproject(sx: number, sy: number): { x: number; y: number } {
  return { x: sx / FLAT_CELL, y: sy / FLAT_CELL };
}

export const ISO_PROJECTION: Projection = {
  kind: 'iso',
  project: isoProj,
  unproject,
};

export const FLAT_PROJECTION: Projection = {
  kind: 'flat',
  project: flatProj,
  unproject: flatUnproject,
};

/** Rotate a local (x, y) point on the build plane by `r` (0/90/180/270) so
 *  that the rotated bounding box still anchors at (0, 0). Used by isoProjR
 *  to draw fixtures that should appear rotated on the iso floor rather than
 *  spun in screen space. For square footprints (w === d) this is a pure
 *  90° rotation; for rectangular ones, 90° and 270° also swap the w/d axes
 *  so the rotated geometry occupies a d × w cell rather than spilling
 *  outside its original w × d box. */
export function rotateLocal(
  x: number,
  y: number,
  r: number,
  w: number,
  d: number,
): { x: number; y: number } {
  switch (((r % 360) + 360) % 360) {
    case 90:
      return { x: d - y, y: x };
    case 180:
      return { x: w - x, y: d - y };
    case 270:
      return { x: y, y: w - x };
    default:
      return { x, y };
  }
}

/** isoProj after applying the build-plane rotation `r` around the footprint
 *  center (w/2, d/2). Threaded through every fixture draw so a 90° rotation
 *  in the twin model translates into the iso ground plane (footprint
 *  reorients, top diamond turns, sub-elements move to the rotated corners)
 *  rather than spinning the SVG sprite in screen space. */
export function isoProjR(
  x: number,
  y: number,
  z: number,
  r: number,
  w: number,
  d: number,
): IsoPoint {
  const p = rotateLocal(x, y, r, w, d);
  return isoProj(p.x, p.y, z);
}

// ============================================================================
// PALETTE — hybrid cream / brand red / blue / yellow accents
// ============================================================================

/**
 * Palette for the isometric sprites. Kept separate from SW_COLORS because these
 * are pigments for drawing objects (a machine body, a table top, a thread cone)
 * rather than UI roles, and they must not retheme when the vibe changes — a
 * sewing machine is the same colour in every theme.
 *
 * "Control Room" reads the floor as desaturated slate so that saturation always
 * means *state*: a choked station is the brightest thing on the stage precisely
 * because the machinery around it is not competing. The `cream*` names are kept
 * (the sprite modules reference them at ~200 call sites) but now carry slate
 * values — the machine-body ramp, light to dark.
 */
export const SW_PAL = {
  cream: '#2A3444',
  creamHi: '#3A4658',
  creamLo: '#1E2634',
  ink: '#080B11',
  steel: '#4A5768',
  edge: '#131924',
  // Accent details — thread cones, spool caps, control panels. These are the one
  // place colour is allowed on a sprite, so they come from the app palette:
  // alarm, bobbin, warn and ok respectively.
  red: '#FF4D55',
  redLo: '#D63B44',
  blue: '#5AA2F0',
  blueLo: '#3A7DC9',
  yellow: '#FFB223',
  yellowLo: '#C9861A',
  green: '#2BD07E',
  // Work surfaces — table tops, cutting beds.
  paper: '#232D3D',
  paperShade: '#1A222E',
  metal: '#8794A6',
  metalLo: '#5C6875',
  wood: '#8A6A4A',
  woodLo: '#5E452C',
} as const;

export type IsoPaletteKey = keyof typeof SW_PAL;

// ============================================================================
// CUBOID DRAWER — body + 3 visible faces, with optional decal palette
// ============================================================================

interface CuboidPoints {
  top: IsoPoint[];
  left: IsoPoint[];
  leftFx: IsoPoint[];
  right: IsoPoint[];
  rightFx: IsoPoint[];
  base: IsoPoint[];
  pts: {
    A: IsoPoint;
    B: IsoPoint;
    C: IsoPoint;
    D: IsoPoint;
    A0: IsoPoint;
    B0: IsoPoint;
    C0: IsoPoint;
    D0: IsoPoint;
  };
}

export function isoCuboid(w: number, d: number, h: number, r: number = 0): CuboidPoints {
  // w,d in cells (x, y world); h in altitude units. `r` rotates the cuboid
  // on the build plane around (w/2, d/2) so 90/180/270 reorient its diamond
  // top and side faces correctly.
  const ip = (x: number, y: number, z: number) => isoProjR(x, y, z, r, w, d);
  const A = ip(0, 0, h),
    B = ip(w, 0, h);
  const C = ip(w, d, h),
    D = ip(0, d, h);
  const A0 = ip(0, 0, 0),
    B0 = ip(w, 0, 0);
  const C0 = ip(w, d, 0),
    D0 = ip(0, d, 0);
  return {
    top: [A, B, C, D],
    left: [A, A0, D0, D], // wait — left face is x=0 plane: A,D,D0,A0
    leftFx: [A, D, D0, A0],
    right: [B, B0, C0, C], // right face is y=d plane? actually x=w plane: B,C,C0,B0
    rightFx: [B, C, C0, B0],
    base: [A0, B0, C0, D0],
    pts: { A, B, C, D, A0, B0, C0, D0 },
  };
}

export function ptsToStr(pts: IsoPoint[]): string {
  return pts.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
}

interface CuboidFacesProps {
  w: number;
  d: number;
  h: number;
  top: string;
  left: string;
  right: string;
  stroke?: string;
  /** Build-plane rotation in degrees (0/90/180/270). Defaults to 0 so the
   *  existing callers keep their original orientation. */
  r?: number;
}

export function CuboidFaces({ w, d, h, top, left, right, stroke, r = 0 }: CuboidFacesProps): ReactNode {
  const c = isoCuboid(w, d, h, r);
  const edge = stroke || SW_PAL.ink;
  return createElement(
    'g',
    null,
    // base (rarely visible) — skip
    createElement('polygon', {
      points: ptsToStr(c.leftFx),
      fill: left,
      stroke: edge,
      strokeWidth: 1.1,
      strokeLinejoin: 'round',
    }),
    createElement('polygon', {
      points: ptsToStr(c.rightFx),
      fill: right,
      stroke: edge,
      strokeWidth: 1.1,
      strokeLinejoin: 'round',
    }),
    createElement('polygon', {
      points: ptsToStr(c.top),
      fill: top,
      stroke: edge,
      strokeWidth: 1.4,
      strokeLinejoin: 'round',
    }),
  );
}

// Convenience: lighten/darken
export function shade(color: string, amt: number): string {
  // tiny shader — return a hex tinted toward black or white by amt (-1..1)
  const c = color.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16),
    g = parseInt(c.slice(2, 4), 16),
    b = parseInt(c.slice(4, 6), 16);
  const t = (v: number) => Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  return '#' + [t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// DRAW FACTORIES — each returns a render fn (asset, opts) => SVG <g>
// All centered at world origin; element places at its grid cell anchor.
// ============================================================================

export interface IsoDrawOpts {
  w: number;
  d: number;
  h: number;
  /** Build-plane rotation in degrees (0/90/180/270). Each fixture threads
   *  this through its CuboidFaces / isoProjR calls so 90° turns visually
   *  pivot the sprite on the iso floor rather than spinning it in screen
   *  space. Optional; absent means 0°. */
  r?: number;
}

export type IsoDrawFn = (opts: IsoDrawOpts) => ReactNode;

function walls(top: string, side: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => CuboidFaces({ w, d, h, top, left: shade(side, -0.1), right: side, r });
}
function doorBay(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      // bay cut-out (blue glass)
      (() => {
        const ay = 0.5;
        const A = isoProjR(0.2, ay, h * 0.85, r, w, d),
          B = isoProjR(w - 0.2, ay, h * 0.85, r, w, d);
        const C = isoProjR(w - 0.2, ay, 0.2, r, w, d),
          D = isoProjR(0.2, ay, 0.2, r, w, d);
        return createElement('polygon', {
          points: ptsToStr([A, B, C, D]),
          fill: SW_PAL.blueLo,
          stroke: SW_PAL.edge,
          strokeWidth: 0.6,
        });
      })(),
    );
}
function windowStrip(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      (() => {
        const stripeY = h * 0.55;
        const A = isoProjR(0.2, 0.5, stripeY + 0.4, r, w, d),
          B = isoProjR(w - 0.2, 0.5, stripeY + 0.4, r, w, d);
        const C = isoProjR(w - 0.2, 0.5, stripeY - 0.4, r, w, d),
          D = isoProjR(0.2, 0.5, stripeY - 0.4, r, w, d);
        return createElement('polygon', {
          points: ptsToStr([A, B, C, D]),
          fill: SW_PAL.blue,
          stroke: SW_PAL.edge,
          strokeWidth: 0.5,
        });
      })(),
    );
}
function column(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => CuboidFaces({ w, d, h, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r });
}
function stairs(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    const steps = 4;
    return createElement(
      'g',
      null,
      Array.from({ length: steps }).map((_, i) => {
        const stepH = (h * (i + 1)) / steps;
        return createElement(
          'g',
          { key: i },
          CuboidFaces({
            w,
            d: d / steps,
            h: stepH,
            top: SW_PAL.cream,
            left: SW_PAL.creamLo,
            right: SW_PAL.cream, r }),
        );
      }),
    );
  };
}
function zonePaint(color: string, label: string): IsoDrawFn {
  return ({ w, d, r = 0 }) => {
    const A = isoProjR(0, 0, 0, r, w, d),
      B = isoProjR(w, 0, 0, r, w, d),
      C = isoProjR(w, d, 0, r, w, d),
      D = isoProjR(0, d, 0, r, w, d);
    const cx = (A.sx + B.sx + C.sx + D.sx) / 4;
    const cy = (A.sy + B.sy + C.sy + D.sy) / 4;
    // Floor zones render as a solid pastel paint with a solid dark border —
    // no opacity tricks so the zone reads as a real painted region.
    const fill = shade(color, 0.55);
    const edge = shade(color, -0.25);
    return createElement(
      'g',
      null,
      createElement('polygon', {
        points: ptsToStr([A, B, C, D]),
        fill,
        stroke: edge,
        strokeWidth: 1.6,
      }),
      // Inner inset stripe so the zone has visual weight at the edges.
      createElement('polygon', {
        points: ptsToStr([
          isoProjR(0.4, 0.4, 0, r, w, d),
          isoProjR(w - 0.4, 0.4, 0, r, w, d),
          isoProjR(w - 0.4, d - 0.4, 0, r, w, d),
          isoProjR(0.4, d - 0.4, 0, r, w, d),
        ]),
        fill: shade(color, 0.75),
        stroke: color,
        strokeWidth: 0.9,
      }),
      // Label plate so the zone tag stands out against the paint.
      createElement('rect', {
        x: cx - 36,
        y: cy - 8,
        width: 72,
        height: 16,
        rx: 3,
        fill: SW_PAL.ink,
      }),
      createElement(
        'text',
        {
          x: cx,
          y: cy + 4,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10,
          fontWeight: 800,
          fill: shade(color, 0.85),
          textAnchor: 'middle',
          letterSpacing: '1.5px',
        },
        label,
      ),
    );
  };
}
function conveyorStr(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r }),
      // belt stripes on top
      Array.from({ length: w * 2 }).map((_, i) => {
        const x = i * 0.5;
        const A = isoProjR(x, 0.1, h + 0.01, r, w, d),
          B = isoProjR(x + 0.05, 0.1, h + 0.01, r, w, d);
        const C = isoProjR(x + 0.05, d - 0.1, h + 0.01, r, w, d),
          D = isoProjR(x, d - 0.1, h + 0.01, r, w, d);
        return createElement('polygon', {
          key: i,
          points: ptsToStr([A, B, C, D]),
          fill: SW_PAL.edge,
        });
      }),
    );
}
function conveyorCurve(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r }),
      (() => {
        const cx = isoProjR(w / 2, d / 2, h + 0.01, r, w, d);
        return createElement('circle', {
          cx: cx.sx,
          cy: cx.sy,
          r: 8,
          fill: 'none',
          stroke: SW_PAL.edge,
          strokeWidth: 1.5,
          strokeDasharray: '2 2',
        });
      })(),
    );
}
function conveyorIncline(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    // Wedge: top face slopes from h0 at x=0 to h at x=w
    const h0 = h * 0.1;
    const A = isoProjR(0, 0, h0, r, w, d),
      B = isoProjR(w, 0, h, r, w, d);
    const C = isoProjR(w, d, h, r, w, d),
      D = isoProjR(0, d, h0, r, w, d);
    const A0 = isoProjR(0, 0, 0, r, w, d),
      B0 = isoProjR(w, 0, 0, r, w, d);
    const C0 = isoProjR(w, d, 0, r, w, d),
      D0 = isoProjR(0, d, 0, r, w, d);
    return createElement(
      'g',
      null,
      createElement('polygon', {
        points: ptsToStr([A, A0, D0, D]),
        fill: SW_PAL.metalLo,
        stroke: SW_PAL.edge,
        strokeWidth: 0.6,
      }),
      createElement('polygon', {
        points: ptsToStr([B, C, C0, B0]),
        fill: SW_PAL.metal,
        stroke: SW_PAL.edge,
        strokeWidth: 0.6,
      }),
      createElement('polygon', {
        points: ptsToStr([A, B, C, D]),
        fill: SW_PAL.metal,
        stroke: SW_PAL.edge,
        strokeWidth: 0.8,
      }),
    );
  };
}
function sewingMachine(accent: string, glyph: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    const tableH = h * 0.55;
    const headH = h * 0.45;
    // Table → motor block → arm → needle head, all solid cuboids.
    return createElement(
      'g',
      null,
      // Table base (cream top, darker side faces)
      CuboidFaces({
        w,
        d,
        h: tableH,
        top: SW_PAL.cream,
        left: SW_PAL.creamLo,
        right: SW_PAL.cream, r }),
      // Operator end cut-out — a darker rectangle so the operator side is
      // visually distinct from the machine side.
      (() => {
        const A = isoProjR(0.1, d - 0.6, tableH + 0.01, r, w, d);
        const B = isoProjR(w - 0.1, d - 0.6, tableH + 0.01, r, w, d);
        const C = isoProjR(w - 0.1, d - 0.1, tableH + 0.01, r, w, d);
        const D = isoProjR(0.1, d - 0.1, tableH + 0.01, r, w, d);
        return createElement('polygon', {
          points: ptsToStr([A, B, C, D]),
          fill: SW_PAL.creamLo,
          stroke: SW_PAL.edge,
          strokeWidth: 0.4,
        });
      })(),
      // Sewing-machine body — a steel cuboid running along the rear of the
      // table.
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(0.05, 0, tableH, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(0.05, 0, tableH, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.9,
          d: d * 0.35,
          h: headH * 0.55,
          top: SW_PAL.metal,
          left: SW_PAL.metalLo,
          right: SW_PAL.metal, r }),
      ),
      // Needle head — accented coloured cuboid at the operator-facing end.
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(w * 0.55, d * 0.05, tableH, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(w * 0.55, d * 0.05, tableH, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.4,
          d: d * 0.25,
          h: headH,
          top: accent,
          left: shade(accent, -0.25),
          right: accent, r }),
      ),
      // Thread spool on top of the body
      (() => {
        const c = isoProjR(w * 0.2, d * 0.18, tableH + headH * 0.55 + 0.05, r, w, d);
        return createElement(
          'g',
          null,
          createElement('ellipse', {
            cx: c.sx,
            cy: c.sy + 1,
            rx: 3,
            ry: 1.4,
            fill: shade(SW_PAL.yellow, -0.25),
          }),
          createElement('ellipse', {
            cx: c.sx,
            cy: c.sy - 1,
            rx: 3,
            ry: 1.4,
            fill: SW_PAL.yellow,
          }),
          createElement('line', {
            x1: c.sx,
            y1: c.sy,
            x2: c.sx + 12,
            y2: c.sy + 6,
            stroke: SW_PAL.yellow,
            strokeWidth: 0.8,
          }),
        );
      })(),
      // Needle bar drop — short solid line under the head
      (() => {
        const c = isoProjR(w * 0.75, d * 0.18, tableH + 0.02, r, w, d);
        return createElement('rect', {
          x: c.sx - 1,
          y: c.sy - 4,
          width: 2,
          height: 5,
          fill: SW_PAL.edge,
        });
      })(),
      // Pedal under the table on the operator side
      (() => {
        const c = isoProjR(w * 0.5, d * 0.95, 0.02, r, w, d);
        return createElement('ellipse', {
          cx: c.sx,
          cy: c.sy,
          rx: 6,
          ry: 2,
          fill: SW_PAL.edge,
        });
      })(),
      // Glyph badge on top of the needle head
      (() => {
        const c = isoProjR(w * 0.75, d * 0.18, tableH + headH + 0.02, r, w, d);
        return createElement(
          'g',
          null,
          createElement('rect', {
            x: c.sx - 7,
            y: c.sy - 6,
            width: 14,
            height: 10,
            rx: 2,
            fill: SW_PAL.ink,
          }),
          createElement(
            'text',
            {
              x: c.sx,
              y: c.sy + 1,
              fontFamily: '"Archivo Black", sans-serif',
              fontSize: 8,
              fontWeight: 900,
              fill: shade(accent, 0.6),
              textAnchor: 'middle',
            },
            glyph,
          ),
        );
      })(),
    );
  };
}
function longTable(top: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => CuboidFaces({ w, d, h, top, left: shade(top, -0.15), right: top, r });
}
function knifeCutter(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.6, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r }),
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(0.2, 0.2, h * 0.6, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(0.2, 0.2, h * 0.6, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({ w: 0.6, d: 0.6, h: h * 0.4, top: SW_PAL.red, left: SW_PAL.redLo, right: SW_PAL.red, r }),
      ),
    );
}
function bandKnife(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.5, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(w * 0.4, d * 0.4, h * 0.5, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(w * 0.4, d * 0.4, h * 0.5, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.2,
          d: d * 0.2,
          h: h * 0.5,
          top: SW_PAL.yellow,
          left: SW_PAL.yellowLo,
          right: SW_PAL.yellow, r }),
      ),
    );
}
function cncCutter(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.5, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      // bridge gantry
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(w * 0.4, 0, h * 0.5, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(w * 0.4, 0, h * 0.5, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.2,
          d,
          h: h * 0.5,
          top: SW_PAL.blue,
          left: SW_PAL.blueLo,
          right: SW_PAL.blue, r }),
      ),
    );
}
function forklift(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.6, top: SW_PAL.yellow, left: SW_PAL.yellowLo, right: SW_PAL.yellow, r }),
      // mast
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(0, 0, h * 0.6, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(0, 0, h * 0.6, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: 0.2,
          d: 0.2,
          h: h * 0.4,
          top: SW_PAL.steel,
          left: SW_PAL.edge,
          right: SW_PAL.steel, r }),
      ),
    );
}
function palletJack(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => CuboidFaces({ w, d, h, top: SW_PAL.steel, left: SW_PAL.edge, right: SW_PAL.steel, r });
}
function trolley(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.3, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r }),
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(0.05, 0.05, h * 0.3, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(0.05, 0.05, h * 0.3, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({ w: 0.9, d: 0.9, h: h * 0.7, top: SW_PAL.red, left: SW_PAL.redLo, right: SW_PAL.red, r }),
      ),
    );
}
function agv(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.blue, left: SW_PAL.blueLo, right: SW_PAL.blue, r }),
      (() => {
        const c = isoProjR(w * 0.5, d * 0.5, h + 0.01, r, w, d);
        return createElement('circle', {
          cx: c.sx,
          cy: c.sy,
          r: 4,
          fill: SW_PAL.yellow,
          stroke: SW_PAL.edge,
        });
      })(),
    );
}
function palletRack(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metalLo, r }),
      // yellow pallets stacked
      Array.from({ length: 3 })
        .map((_, lvl) => {
          const ly = h * 0.25 + lvl * h * 0.25;
          return Array.from({ length: w }).map((__, i) => {
            const ox = i + 0.1,
              oy = 0.1;
            const off = isoProjR(ox, oy, ly, r, w, d);
            const base = isoProjR(0, 0, 0, r, w, d);
            return createElement(
              'g',
              {
                key: lvl + '-' + i,
                transform: `translate(${off.sx - base.sx}, ${off.sy - base.sy})`,
              },
              CuboidFaces({
                w: 0.8,
                d: 0.8,
                h: 0.18,
                top: SW_PAL.yellow,
                left: SW_PAL.yellowLo,
                right: SW_PAL.yellow, r }),
            );
          });
        })
        .flat(),
    );
}
function pallet(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    CuboidFaces({ w, d, h, top: SW_PAL.yellow, left: SW_PAL.yellowLo, right: SW_PAL.yellow, r });
}
function fabricRoll(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.5, top: SW_PAL.wood, left: SW_PAL.woodLo, right: SW_PAL.wood, r }),
    );
}
function binShelf(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r }),
      // 3 visible bin compartments on the front-facing (right) face
      ...Array.from({ length: 3 }).map((_, lvl) => {
        const ly = h * 0.15 + lvl * h * 0.28;
        return createElement(
          'g',
          {
            key: lvl,
            transform: `translate(${isoProjR(0, 0.04, ly, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
              isoProjR(0, 0.04, ly, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
            })`,
          },
          CuboidFaces({
            w: w - 0.08,
            d: 0.06,
            h: h * 0.22,
            top: SW_PAL.yellow,
            left: SW_PAL.yellowLo,
            right: SW_PAL.yellow, r }),
        );
      }),
    );
}
/** Per-PML-category accent colour (matches the PROCESS canvas card tints
 *  in `pages/Builder.tsx > PML_CATEGORY_TINT` so a Source on the iso
 *  canvas reads the same as a Source in the PML diagram). */
const PML_CAT_ACCENT: Record<PmlCategory, string> = {
  lifecycle: SW_PAL.yellow,
  buffer:    SW_PAL.blue,
  service:   SW_PAL.red,
  routing:   SW_PAL.green,
  batch:     '#7E5BEF',
  movement:  SW_PAL.wood,
};

/** Generic PML-block draw factory: a paper-coloured cuboid with a coloured
 *  top stripe and the kind's solid-filled SVG icon painted on the top
 *  face. Used by every `pml_*` fixture so the iso canvas always shows
 *  the block's identity at a glance. */
function pmlBlock(Icon: PmlIconComponent, accent: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    // Compute the top-face centroid for icon placement.
    const c = isoCuboid(w, d, h);
    const topCenter = isoProjR(w / 2, d / 2, h, r, w, d);
    const iconSize = 26;
    return createElement(
      'g',
      null,
      // Body — paper-coloured cuboid for high contrast against any dept tint
      CuboidFaces({
        w,
        d,
        h,
        top: SW_PAL.paper,
        left: shade(SW_PAL.paperShade, -0.05),
        right: SW_PAL.paperShade, r }),
      // Coloured stripe on the top edge (front-right ridge) so the
      // category accent is visible without the icon.
      createElement('polygon', {
        points: ptsToStr([
          isoProjR(0, 0, h, r, w, d),
          isoProjR(w, 0, h, r, w, d),
          isoProjR(w, 0.18, h, r, w, d),
          isoProjR(0, 0.18, h, r, w, d),
        ]),
        fill: accent,
        stroke: SW_PAL.edge,
        strokeWidth: 0.5,
      }),
      // Inner top-face inset rectangle in the accent colour
      createElement('polygon', {
        points: ptsToStr([
          isoProjR(0.18, 0.32, h, r, w, d),
          isoProjR(w - 0.18, 0.32, h, r, w, d),
          isoProjR(w - 0.18, d - 0.18, h, r, w, d),
          isoProjR(0.18, d - 0.18, h, r, w, d),
        ]),
        fill: shade(accent, 0.55),
        stroke: accent,
        strokeWidth: 0.6,
      }),
      // Solid-filled SVG icon, nested as a child <svg>. Centered on the
      // top-face centroid; vertical offset matches the previous text-baseline
      // anchor so existing layouts stay put.
      createElement(Icon, {
        size: iconSize,
        color: shade(accent, -0.45),
        x: topCenter.sx - iconSize / 2,
        y: topCenter.sy - iconSize / 2 + 2,
      }),
      // Suppress unused-var warning — `c` exists for future face-decals.
      ((): null => { void c; return null; })(),
    );
  };
}

/** Standing-operator draw factory.
 *
 *  Proportional reference (industrial sewing floor, scale ≈ 0.6 m / unit):
 *    – sewing machine table + head ≈ 0.85 m → ~1.4 iso altitude units
 *    – standing adult worker      ≈ 1.70 m → ~2.4 iso altitude units
 *    – worker / machine ratio     ≈ 1.7×
 *
 *  Fills the full declared `h` so the operator visually stands as tall as
 *  the metadata claims (older draws only reached ~70% of declared `h`,
 *  which is why workers read shorter than machines on the floor).
 *
 *  Slim footprint (legs ≈ 0.26 × 0.18 of a cell) so the figure reads as a
 *  person, not a chunky bin. Anthropometric segment ratios — legs 0.46,
 *  torso 0.34, head 0.14, cap 0.06 — match a real adult silhouette.
 */
function operator(shirt: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    const legsH = h * 0.46;
    const torsoH = h * 0.34;
    const headH = h * 0.14;
    const capH = h * 0.06;

    // Centred sub-footprints (cell coords).
    const legW = 0.26, legD = 0.18;
    const legX = 0.5 - legW / 2;
    const legY = 0.5 - legD / 2;

    const torsoW = 0.34, torsoD = 0.22;
    const torsoX = 0.5 - torsoW / 2;
    const torsoY = 0.5 - torsoD / 2;

    const armW = 0.10, armD = 0.18;
    const armH = torsoH * 0.85;

    const headW = 0.24, headD = 0.20;
    const headX = 0.5 - headW / 2;
    const headY = 0.5 - headD / 2;

    const capW = 0.28, capD = 0.22;
    const capX = 0.5 - capW / 2;
    const capY = 0.5 - capD / 2;

    const SKIN = '#E8B98A';
    const PANTS = SW_PAL.edge;

    // Helper — translate a child <g> so (0,0,0) becomes (x,y,z) in world
    // coords, rotation-aware so 90° turns still place body parts correctly.
    const at = (x: number, y: number, z: number, children: ReactNode): ReactNode => {
      const o = isoProjR(x, y, z, r, w, d);
      const b = isoProjR(0, 0, 0, r, w, d);
      return createElement(
        'g',
        { transform: `translate(${o.sx - b.sx}, ${o.sy - b.sy})` },
        children,
      );
    };

    return createElement(
      'g',
      null,
      // Solid foot shadow
      (() => {
        const c = isoProjR(0.5, 0.5, 0, r, w, d);
        return createElement('ellipse', {
          cx: c.sx,
          cy: c.sy + 1,
          rx: 8,
          ry: 2.6,
          fill: SW_PAL.edge,
        });
      })(),
      // Legs
      at(
        legX,
        legY,
        0,
        CuboidFaces({
          w: legW,
          d: legD,
          h: legsH,
          top: shade(PANTS, 0.18),
          left: shade(PANTS, -0.15),
          right: PANTS,
          r,
        }),
      ),
      // Belt — a thin contrasting band at the top of the legs
      at(
        legX - 0.01,
        legY - 0.01,
        legsH - 0.05,
        CuboidFaces({
          w: legW + 0.02,
          d: legD + 0.02,
          h: 0.05,
          top: SW_PAL.ink,
          left: shade(SW_PAL.ink, -0.1),
          right: SW_PAL.ink,
          r,
        }),
      ),
      // Left arm
      at(
        torsoX - armW * 0.7,
        torsoY + (torsoD - armD) / 2,
        legsH - armH * 0.1,
        CuboidFaces({
          w: armW,
          d: armD,
          h: armH,
          top: shade(shirt, 0.15),
          left: shade(shirt, -0.25),
          right: shirt,
          r,
        }),
      ),
      // Right arm
      at(
        torsoX + torsoW - armW * 0.3,
        torsoY + (torsoD - armD) / 2,
        legsH - armH * 0.1,
        CuboidFaces({
          w: armW,
          d: armD,
          h: armH,
          top: shade(shirt, 0.15),
          left: shade(shirt, -0.25),
          right: shirt,
          r,
        }),
      ),
      // Torso / shirt
      at(
        torsoX,
        torsoY,
        legsH,
        CuboidFaces({
          w: torsoW,
          d: torsoD,
          h: torsoH,
          top: shade(shirt, 0.2),
          left: shade(shirt, -0.25),
          right: shirt,
          r,
        }),
      ),
      // Collar V — a darker triangle at the neckline
      (() => {
        const z = legsH + torsoH - 0.02;
        const A = isoProjR(torsoX + torsoW * 0.3, torsoY + torsoD * 0.05, z, r, w, d);
        const B = isoProjR(torsoX + torsoW * 0.7, torsoY + torsoD * 0.05, z, r, w, d);
        const C = isoProjR(torsoX + torsoW * 0.5, torsoY + torsoD * 0.4, z, r, w, d);
        return createElement('polygon', {
          points: ptsToStr([A, B, C]),
          fill: shade(shirt, -0.5),
          stroke: SW_PAL.edge,
          strokeWidth: 0.4,
        });
      })(),
      // Apron pocket — a small contrasting patch on the front-right face
      (() => {
        const z0 = legsH + torsoH * 0.2;
        const z1 = legsH + torsoH * 0.55;
        const A = isoProjR(torsoX + torsoW, torsoY + torsoD * 0.3, z1, r, w, d);
        const B = isoProjR(torsoX + torsoW, torsoY + torsoD * 0.7, z1, r, w, d);
        const C = isoProjR(torsoX + torsoW, torsoY + torsoD * 0.7, z0, r, w, d);
        const D = isoProjR(torsoX + torsoW, torsoY + torsoD * 0.3, z0, r, w, d);
        return createElement('polygon', {
          points: ptsToStr([A, B, C, D]),
          fill: shade(shirt, -0.4),
          stroke: SW_PAL.edge,
          strokeWidth: 0.4,
        });
      })(),
      // Head
      at(
        headX,
        headY,
        legsH + torsoH,
        CuboidFaces({
          w: headW,
          d: headD,
          h: headH,
          top: shade(SKIN, 0.1),
          left: shade(SKIN, -0.2),
          right: SKIN,
          r,
        }),
      ),
      // Eyes on the front-right face
      (() => {
        const eyeZ = legsH + torsoH + headH * 0.55;
        const left = isoProjR(headX + headW, headY + headD * 0.32, eyeZ, r, w, d);
        const right = isoProjR(headX + headW, headY + headD * 0.68, eyeZ, r, w, d);
        return createElement(
          'g',
          null,
          createElement('rect', {
            x: left.sx - 1.1,
            y: left.sy - 0.6,
            width: 2.2,
            height: 1.2,
            fill: SW_PAL.ink,
          }),
          createElement('rect', {
            x: right.sx - 1.1,
            y: right.sy - 0.6,
            width: 2.2,
            height: 1.2,
            fill: SW_PAL.ink,
          }),
        );
      })(),
      // Cap on the head — accent-coloured to the shirt
      at(
        capX,
        capY,
        legsH + torsoH + headH,
        CuboidFaces({
          w: capW,
          d: capD,
          h: capH,
          top: shade(shirt, -0.3),
          left: shade(shirt, -0.5),
          right: shade(shirt, -0.35),
          r,
        }),
      ),
    );
  };
}
function bufferPad(label: string, color: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: shade(color, 0.4), left: shade(color, -0.05), right: color, r }),
      (() => {
        const c = isoProjR(w / 2, d / 2, h + 0.01, r, w, d);
        return createElement(
          'text',
          {
            x: c.sx,
            y: c.sy + 3,
            fontFamily: '"Archivo Black", sans-serif',
            fontSize: 8,
            fontWeight: 900,
            fill: shade(color, -0.4),
            textAnchor: 'middle',
            letterSpacing: '1px',
          },
          label,
        );
      })(),
    );
}
function wipCart(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.3, top: SW_PAL.steel, left: SW_PAL.edge, right: SW_PAL.steel, r }),
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(0.05, 0.05, h * 0.3, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(0.05, 0.05, h * 0.3, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: 0.9,
          d: 1.9,
          h: h * 0.7,
          top: SW_PAL.cream,
          left: SW_PAL.creamLo,
          right: SW_PAL.cream, r }),
      ),
    );
}
function workTable(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      // A solid folded panel on top so the table reads as "in use", not empty
      (() => {
        const c = isoProjR(w * 0.5, d * 0.5, h + 0.01, r, w, d);
        return createElement('rect', {
          x: c.sx - 8,
          y: c.sy - 4,
          width: 16,
          height: 8,
          rx: 1,
          fill: shade(SW_PAL.blue, 0.2),
          stroke: SW_PAL.edge,
          strokeWidth: 0.5,
        });
      })(),
    );
}
function pressingTable(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.creamHi, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      // Iron + steam wisp glyph on top
      (() => {
        const c = isoProjR(w * 0.5, d * 0.5, h + 0.01, r, w, d);
        return createElement(
          'g',
          null,
          createElement('polygon', {
            points: `${c.sx - 7},${c.sy + 1} ${c.sx + 7},${c.sy - 1} ${c.sx + 8},${c.sy + 3} ${c.sx - 7},${c.sy + 4}`,
            fill: SW_PAL.metal,
            stroke: SW_PAL.edge,
            strokeWidth: 0.5,
          }),
          createElement('rect', {
            x: c.sx - 5,
            y: c.sy - 3,
            width: 10,
            height: 3,
            rx: 1,
            fill: SW_PAL.steel,
          }),
          createElement('path', {
            d: `M ${c.sx - 2} ${c.sy - 6} q -2 -3 0 -5`,
            stroke: SW_PAL.blue,
            strokeWidth: 1,
            fill: 'none',
          }),
          createElement('path', {
            d: `M ${c.sx + 2} ${c.sy - 6} q -2 -3 0 -5`,
            stroke: SW_PAL.blue,
            strokeWidth: 1,
            fill: 'none',
          }),
        );
      })(),
    );
}
function qcTable(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.paper, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      // Magnifier + checklist glyph
      (() => {
        const c = isoProjR(w * 0.5, d * 0.5, h + 0.01, r, w, d);
        return createElement(
          'g',
          null,
          createElement('rect', {
            x: c.sx - 10,
            y: c.sy - 4,
            width: 9,
            height: 8,
            rx: 0.6,
            fill: shade(SW_PAL.cream, -0.05),
            stroke: SW_PAL.edge,
            strokeWidth: 0.5,
          }),
          createElement('rect', {
            x: c.sx - 8,
            y: c.sy - 2,
            width: 5,
            height: 0.8,
            fill: SW_PAL.edge,
          }),
          createElement('rect', {
            x: c.sx - 8,
            y: c.sy,
            width: 4,
            height: 0.8,
            fill: SW_PAL.edge,
          }),
          createElement('rect', {
            x: c.sx - 8,
            y: c.sy + 2,
            width: 5,
            height: 0.8,
            fill: SW_PAL.edge,
          }),
          createElement('circle', {
            cx: c.sx + 5,
            cy: c.sy + 1,
            r: 3.5,
            fill: SW_PAL.metalLo,
          }),
          createElement('circle', {
            cx: c.sx + 5,
            cy: c.sy + 1,
            r: 2.4,
            fill: SW_PAL.blue,
          }),
        );
      })(),
    );
}
function packBench(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.wood, left: SW_PAL.woodLo, right: SW_PAL.wood, r }),
      // A carton on top
      (() => {
        const c = isoProjR(w * 0.5, d * 0.5, h + 0.01, r, w, d);
        return createElement(
          'g',
          null,
          createElement('polygon', {
            points: `${c.sx - 8},${c.sy - 1} ${c.sx},${c.sy - 4} ${c.sx + 8},${c.sy - 1} ${c.sx},${c.sy + 2}`,
            fill: '#D8B488',
            stroke: SW_PAL.edge,
            strokeWidth: 0.5,
          }),
          createElement('polygon', {
            points: `${c.sx + 8},${c.sy - 1} ${c.sx + 8},${c.sy + 5} ${c.sx},${c.sy + 8} ${c.sx},${c.sy + 2}`,
            fill: '#A37D52',
            stroke: SW_PAL.edge,
            strokeWidth: 0.5,
          }),
          createElement('polygon', {
            points: `${c.sx - 8},${c.sy - 1} ${c.sx - 8},${c.sy + 5} ${c.sx},${c.sy + 8} ${c.sx},${c.sy + 2}`,
            fill: '#C49A6C',
            stroke: SW_PAL.edge,
            strokeWidth: 0.5,
          }),
          createElement('rect', {
            x: c.sx - 0.7,
            y: c.sy - 3.5,
            width: 1.4,
            height: 5,
            fill: SW_PAL.yellow,
          }),
        );
      })(),
    );
}

// ── Apparel-specific draw fns ───────────────────────────────────────────────

/** Auto spreader — long fabric-spreading table with a low programmable
 *  carriage that rolls along the long axis. Distinct from the CNC cutter
 *  by a flatter, wider gantry and the cream cloth-lay top. */
function autoSpreader(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.45, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      // gantry rail (blue carriage)
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(w * 0.25, 0, h * 0.45, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(w * 0.25, 0, h * 0.45, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.15,
          d,
          h: h * 0.4,
          top: SW_PAL.blue,
          left: SW_PAL.blueLo,
          right: SW_PAL.blue, r }),
      ),
    );
}

/** Marker plotter — narrow paper-marker printing table with a thin print
 *  head crossing the short axis. Lower profile than the CNC. */
function markerPlotter(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.5, top: SW_PAL.paper, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(w * 0.45, 0, h * 0.5, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(w * 0.45, 0, h * 0.5, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.08,
          d,
          h: h * 0.3,
          top: SW_PAL.yellow,
          left: SW_PAL.yellowLo,
          right: SW_PAL.yellow, r }),
      ),
    );
}

/** Single-head embroidery machine — flat work table + perpendicular needle
 *  bridge + a yellow hoop ring on top representing the embroidery frame. */
function embroideryMachine(): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: h * 0.5, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      createElement(
        'g',
        {
          transform: `translate(${isoProjR(w * 0.2, 0, h * 0.5, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${
            isoProjR(w * 0.2, 0, h * 0.5, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy
          })`,
        },
        CuboidFaces({
          w: w * 0.6,
          d: d * 0.2,
          h: h * 0.45,
          top: SW_PAL.steel,
          left: SW_PAL.edge,
          right: SW_PAL.steel, r }),
      ),
      (() => {
        const c = isoProjR(w / 2, d / 2, h + 0.05, r, w, d);
        return createElement('circle', {
          cx: c.sx,
          cy: c.sy,
          r: 6,
          fill: 'none',
          stroke: SW_PAL.yellow,
          strokeWidth: 1.6,
        });
      })(),
    );
}

// ============================================================================
// CATEGORIES (left rail tabs)
// ============================================================================

export type IsoCategoryId =
  | 'arch'
  | 'zone'
  | 'conv'
  | 'sew'
  | 'cut'
  | 'mh'
  | 'store'
  | 'op'
  | 'buf'
  | 'fix'
  | 'pml';

export interface IsoCategory {
  id: IsoCategoryId;
  label: string;
  icon: string;
}

export const ISO_CATEGORIES: IsoCategory[] = [
  { id: 'arch', label: 'Architecture', icon: '▤' },
  { id: 'zone', label: 'Floor zones', icon: '▦' },
  { id: 'conv', label: 'Conveyors', icon: '⫶' },
  { id: 'sew', label: 'Sewing', icon: '⌃' },
  { id: 'cut', label: 'Cutting', icon: '⫻' },
  { id: 'mh', label: 'Handling', icon: '⛟' },
  { id: 'store', label: 'Storage', icon: '▥' },
  { id: 'op', label: 'Operators', icon: '☻' },
  { id: 'buf', label: 'Buffers', icon: '◫' },
  { id: 'fix', label: 'Fixtures', icon: '▭' },
  { id: 'pml', label: 'Process blocks', icon: '⚙' },
];

// ============================================================================
// APPAREL PALETTE — curated, dept-aware view of the catalog
//
// The Builder's workstation palette renders this instead of filtering the
// raw fixture catalog by category. Items are grouped by what an apparel
// IE actually thinks about: sewing machines vs. sewing fixtures, cutting
// machines vs. cutting fixtures, materials handling, and operators.
// Adding a new asset = add the catalog entry above, then add its id here.
// ============================================================================

export type ApparelCategoryId =
  | 'sew_mach'
  | 'sew_fix'
  | 'material'
  | 'operator';

export interface ApparelCategory {
  id: ApparelCategoryId;
  label: string;
  icon: string;
}

export const APPAREL_CATEGORIES: ApparelCategory[] = [
  { id: 'sew_mach', label: 'Sewing machines',  icon: '⌃' },
  { id: 'sew_fix',  label: 'Sewing fixtures',  icon: '▭' },
  { id: 'material', label: 'Materials handling', icon: '⛟' },
  { id: 'operator', label: 'Operators',         icon: '☻' },
];

/** Curated apparel asset list. Maps each apparel category to the catalogue
 *  ids the user should see in that group, in the order they should appear.
 *  Renamed from APPAREL_PALETTE to disambiguate from palette.ts's flat
 *  PaletteElement[] of the same name (caused a star-export conflict).
 *
 *  Sewing-floor scope: cutting-room assets (spreaders, knives, CNC cutter,
 *  marker plotter, cut/inspection tables, fabric roll rack) and the
 *  role-specific operators are deliberately absent. They remain in
 *  ISO_FIXTURE_CATALOG so factories that already placed them still render
 *  and WORKER_ROLE_FIXTURE still resolves — they're just not offered. */
export const APPAREL_FIXTURE_PALETTE: Record<ApparelCategoryId, string[]> = {
  sew_mach: [
    'a_snls', 'a_dnls',
    'a_3ol', 'a_4ol', 'a_5ol',
    'a_flatlock',
    'a_bartack',
    'a_buttonhole', 'a_buttonsew',
    'a_foa',
    'a_kansai',
    'a_embroidery',
  ],
  sew_fix: ['a_iron_inline', 'a_wip_rack', 'a_op_desk'],
  // Bundle trolley moves work between sewing operations; the fabric roll
  // rack belongs to the cutting room / store.
  material: ['a_bundle_trolley'],
  // One generic operator. Roles (sewer, helper, supervisor, …) are being
  // superseded by a user-authored operator-type feature.
  operator: ['op_generic'],
};

// ============================================================================
// FIXTURE CATALOG (~30+ hero items across 12 categories)
// Each entry: id, label, cat, footprint (w,h cells), height (z), draw fn
// ============================================================================

export interface IsoFixture {
  id: string;
  cat: IsoCategoryId;
  label: string;
  /** width in cells (x world axis) */
  w: number;
  /** depth in cells (y world axis) */
  d: number;
  /** height in altitude units */
  h: number;
  draw: IsoDrawFn;
}

export const ISO_FIXTURE_CATALOG: IsoFixture[] = [
  // --- ARCHITECTURE ---
  { id: 'wall_str', cat: 'arch', label: 'Wall — straight', w: 4, d: 1, h: 5, draw: walls(SW_PAL.cream, SW_PAL.creamLo) },
  { id: 'wall_corner', cat: 'arch', label: 'Wall — corner', w: 1, d: 1, h: 5, draw: walls(SW_PAL.cream, SW_PAL.creamLo) },
  { id: 'door_bay', cat: 'arch', label: 'Loading door', w: 2, d: 1, h: 4, draw: doorBay() },
  { id: 'window', cat: 'arch', label: 'Window strip', w: 3, d: 1, h: 3, draw: windowStrip() },
  { id: 'column', cat: 'arch', label: 'Steel column', w: 1, d: 1, h: 6, draw: column() },
  { id: 'stairs', cat: 'arch', label: 'Stairs', w: 2, d: 3, h: 3, draw: stairs() },

  // --- FLOOR ZONES (paint regions) ---
  { id: 'zone_cut', cat: 'zone', label: 'Cutting zone', w: 6, d: 6, h: 0.05, draw: zonePaint(SW_PAL.green, 'CUTTING') },
  { id: 'zone_sew', cat: 'zone', label: 'Sewing zone', w: 8, d: 8, h: 0.05, draw: zonePaint(SW_PAL.blue, 'SEWING') },
  { id: 'zone_qc', cat: 'zone', label: 'QC zone', w: 4, d: 4, h: 0.05, draw: zonePaint(SW_PAL.red, 'QC') },
  { id: 'zone_store', cat: 'zone', label: 'Storage zone', w: 6, d: 5, h: 0.05, draw: zonePaint(SW_PAL.yellow, 'STORE') },

  // --- CONVEYORS ---
  { id: 'conv_str', cat: 'conv', label: 'Conveyor — straight', w: 3, d: 1, h: 0.8, draw: conveyorStr() },
  { id: 'conv_curve', cat: 'conv', label: 'Conveyor — curve', w: 2, d: 2, h: 0.8, draw: conveyorCurve() },
  { id: 'conv_inc', cat: 'conv', label: 'Conveyor — incline', w: 3, d: 1, h: 1.6, draw: conveyorIncline() },

  // --- SEWING MACHINES ---
  { id: 'mach_ssm', cat: 'sew', label: 'Single-needle Lock', w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.red, '⌃') },
  { id: 'mach_over', cat: 'sew', label: 'Overlock 4-thread', w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.blue, '⤴') },
  { id: 'mach_flat', cat: 'sew', label: 'Flatlock', w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.steel, '≣') },
  { id: 'mach_bart', cat: 'sew', label: 'Bartack', w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.yellow, '∥') },
  { id: 'mach_btnh', cat: 'sew', label: 'Buttonhole', w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.green, '◉') },

  // --- CUTTING MACHINES ---
  { id: 'cut_spread', cat: 'cut', label: 'Spread Table', w: 6, d: 2, h: 1.0, draw: longTable(SW_PAL.cream) },
  { id: 'cut_knife', cat: 'cut', label: 'Straight Knife', w: 1, d: 1, h: 1.5, draw: knifeCutter() },
  { id: 'cut_band', cat: 'cut', label: 'Band Knife', w: 2, d: 2, h: 2.0, draw: bandKnife() },
  { id: 'cut_cnc', cat: 'cut', label: 'CNC Auto Cutter', w: 5, d: 3, h: 1.8, draw: cncCutter() },

  // --- MATERIAL HANDLING ---
  { id: 'mh_forklift', cat: 'mh', label: 'Forklift', w: 1, d: 2, h: 2.0, draw: forklift() },
  { id: 'mh_pallet', cat: 'mh', label: 'Pallet jack', w: 1, d: 2, h: 0.6, draw: palletJack() },
  { id: 'mh_trolley', cat: 'mh', label: 'WIP trolley', w: 1, d: 1, h: 1.2, draw: trolley() },
  { id: 'mh_agv', cat: 'mh', label: 'AGV', w: 1, d: 2, h: 0.8, draw: agv() },

  // --- STORAGE ---
  { id: 'st_rack', cat: 'store', label: 'Pallet rack', w: 4, d: 1, h: 5, draw: palletRack() },
  { id: 'st_pallet', cat: 'store', label: 'Pallet (loaded)', w: 1, d: 1, h: 1.2, draw: pallet() },
  { id: 'st_roll', cat: 'store', label: 'Fabric roll', w: 1, d: 3, h: 0.8, draw: fabricRoll() },
  { id: 'st_bin', cat: 'store', label: 'Bin shelf', w: 2, d: 1, h: 3.5, draw: binShelf() },

  // --- OPERATORS ---
  // Standing operators — h=2.4 puts a worker at ~1.7m which is 1.7× a
  // sewing-machine table+head (h=1.4). Matches real-floor anthropometry so
  // workers visually overhang their machines rather than reading shorter.
  // The palette offers only `op_generic` — Stitchworks is sewing-floor
  // centric and roles are being replaced by a user-authored operator-type
  // feature. The role-specific fixtures below stay in the catalogue because
  // WORKER_ROLE_FIXTURE and already-placed operators still resolve to them.
  { id: 'op_generic', cat: 'op', label: 'Operator', w: 1, d: 1, h: 2.4, draw: operator(SW_PAL.steel) },
  { id: 'op_sewer', cat: 'op', label: 'Sewer', w: 1, d: 1, h: 2.4, draw: operator(SW_PAL.red) },
  { id: 'op_cutter', cat: 'op', label: 'Cutter', w: 1, d: 1, h: 2.4, draw: operator(SW_PAL.green) },
  { id: 'op_helper', cat: 'op', label: 'Helper', w: 1, d: 1, h: 2.4, draw: operator(SW_PAL.yellow) },
  { id: 'op_super', cat: 'op', label: 'Supervisor', w: 1, d: 1, h: 2.4, draw: operator(SW_PAL.ink) },
  { id: 'op_qc', cat: 'op', label: 'QC inspector', w: 1, d: 1, h: 2.4, draw: operator(SW_PAL.blue) },

  // --- BUFFERS ---
  { id: 'buf_in', cat: 'buf', label: 'Inbound buffer', w: 2, d: 2, h: 0.4, draw: bufferPad('IN', SW_PAL.green) },
  { id: 'buf_out', cat: 'buf', label: 'Outbound buffer', w: 2, d: 2, h: 0.4, draw: bufferPad('OUT', SW_PAL.red) },
  { id: 'buf_wip', cat: 'buf', label: 'WIP cart', w: 1, d: 2, h: 1.0, draw: wipCart() },

  // --- FIXTURES ---
  { id: 'fx_table', cat: 'fix', label: 'Work table', w: 2, d: 1, h: 1.0, draw: workTable() },
  { id: 'fx_press', cat: 'fix', label: 'Pressing table', w: 2, d: 1, h: 1.1, draw: pressingTable() },
  { id: 'fx_qctab', cat: 'fix', label: 'QC table', w: 2, d: 1, h: 1.0, draw: qcTable() },
  { id: 'fx_pack', cat: 'fix', label: 'Packing bench', w: 3, d: 1, h: 1.0, draw: packBench() },

  // ─── APPAREL — SEWING MACHINES ──────────────────────────────────────────
  { id: 'a_snls',       cat: 'sew', label: 'SNLS · Single-needle Lock',  w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.red,    '⌃')  },
  { id: 'a_dnls',       cat: 'sew', label: 'DNLS · Double-needle Lock',  w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.redLo,  '‖')  },
  { id: 'a_3ol',        cat: 'sew', label: 'Overlock · 3-thread',        w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.blue,   '⤴')  },
  { id: 'a_4ol',        cat: 'sew', label: 'Overlock · 4-thread',        w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.blueLo, '⤴')  },
  { id: 'a_5ol',        cat: 'sew', label: 'Overlock · 5-thread safety', w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.steel,  '⫸')  },
  { id: 'a_flatlock',   cat: 'sew', label: 'Flatlock · Coverstitch',     w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.steel,  '≣')  },
  { id: 'a_bartack',    cat: 'sew', label: 'Bartack',                    w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.yellow, '∥')  },
  { id: 'a_buttonhole', cat: 'sew', label: 'Buttonhole',                 w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.green,  '◉')  },
  { id: 'a_buttonsew',  cat: 'sew', label: 'Button Sew',                 w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.green,  '●')  },
  { id: 'a_foa',        cat: 'sew', label: 'Feed-off-the-Arm',           w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.red,    '⌒')  },
  { id: 'a_kansai',     cat: 'sew', label: 'Kansai · Multi-needle',      w: 1, d: 2, h: 1.4, draw: sewingMachine(SW_PAL.redLo,  '⫼')  },
  { id: 'a_embroidery', cat: 'sew', label: 'Embroidery · Single-head',   w: 2, d: 3, h: 1.6, draw: embroideryMachine() },

  // ─── APPAREL — SEWING FIXTURES & SUPPORT ────────────────────────────────
  { id: 'a_iron_inline', cat: 'fix', label: 'Inline iron table', w: 2, d: 1, h: 1.1, draw: pressingTable() },
  { id: 'a_wip_rack',    cat: 'fix', label: 'WIP buffer rack',   w: 2, d: 1, h: 3.5, draw: binShelf()      },
  { id: 'a_op_desk',     cat: 'fix', label: 'Operator desk',     w: 1, d: 1, h: 1.0, draw: workTable()     },

  // ─── APPAREL — CUTTING MACHINES ─────────────────────────────────────────
  { id: 'a_spread_manual', cat: 'cut', label: 'Spread Table · Manual',   w: 6, d: 2, h: 1.0, draw: longTable(SW_PAL.cream) },
  { id: 'a_spread_auto',   cat: 'cut', label: 'Auto Spreader',           w: 6, d: 2, h: 1.4, draw: autoSpreader()          },
  { id: 'a_knife_straight',cat: 'cut', label: 'Straight Knife Cutter',   w: 1, d: 1, h: 1.5, draw: knifeCutter()           },
  { id: 'a_knife_band',    cat: 'cut', label: 'Band Knife Cutter',       w: 2, d: 2, h: 2.0, draw: bandKnife()             },
  { id: 'a_cnc_cutter',    cat: 'cut', label: 'CNC Auto Cutter',         w: 5, d: 3, h: 1.8, draw: cncCutter()             },
  { id: 'a_marker_plotter',cat: 'cut', label: 'Marker Plotter',          w: 5, d: 1, h: 1.0, draw: markerPlotter()         },

  // ─── APPAREL — CUTTING FIXTURES ─────────────────────────────────────────
  { id: 'a_cut_table',     cat: 'cut', label: 'Cutting Table · Plain',   w: 4, d: 2, h: 1.0, draw: longTable(SW_PAL.paper) },
  { id: 'a_inspect_table', cat: 'fix', label: 'Inspection · 4-point',    w: 3, d: 1, h: 1.0, draw: qcTable()               },

  // ─── APPAREL — MATERIALS & HANDLING ─────────────────────────────────────
  { id: 'a_fabric_rack',   cat: 'store', label: 'Fabric Roll Rack', w: 4, d: 1, h: 4.5, draw: palletRack()          },
  { id: 'a_bundle_trolley',cat: 'mh',    label: 'Bundle Trolley',   w: 1, d: 2, h: 1.0, draw: wipCart()             },

  // ─── PML — PROCESS MODELING LIBRARY PRIMITIVES ──────────────────────────
  // Generated from PML_BLOCK_LIBRARY so adding a new kind in pml.ts adds a
  // matching iso fixture automatically. All PML fixtures share the same
  // pmlBlock() draw function and a 2×2×1.2 footprint — visual identity
  // comes from the kind glyph + per-category accent colour.
  ...(Object.values(PML_BLOCK_LIBRARY) as PmlBlockSpec[]).map<IsoFixture>((spec) => ({
    id: pmlFixtureId(spec.kind),
    cat: 'pml',
    label: spec.label,
    w: 2,
    d: 2,
    h: 1.2,
    draw: pmlBlock(spec.Icon, PML_CAT_ACCENT[spec.category]),
  })),
];

// ============================================================================
// CROSS-MODULE MAPPING — bridge to the asset-library catalogs
//
// The Asset Library page edits `MachineCode` and `WorkerRole` entries from
// `domain/machines.ts` / `domain/workers.ts`, but the Builder canvas draws
// `ISO_FIXTURE_CATALOG` blocks. These helpers tie the two together so the
// Asset Library can preview the exact iso block the Builder will place.
// ============================================================================

/** Map each industry machine code to its preferred iso fixture id. The
 *  fixture is the block the Builder drops onto the canvas. Codes missing a
 *  bespoke fixture fall back to the closest visual relative. */
export const MACHINE_CODE_TO_ISO_FIXTURE: Record<string, string> = {
  SNL:   'a_snls',
  DNL:   'a_dnls',
  '4OL': 'a_4ol',
  '5OL': 'a_5ol',
  FL:    'a_flatlock',
  FB:    'a_foa',
  KS:    'a_kansai',
  BH:    'a_buttonhole',
  BS:    'a_buttonsew',
  BT:    'a_bartack',
  EMB:   'a_embroidery',
  CUT:   'a_knife_straight',
  CAD:   'a_cnc_cutter',
  SPR:   'a_spread_auto',
  FUSE:  'a_iron_inline',
  PRESS: 'a_iron_inline',
  STEAM: 'a_iron_inline',
  INSP:  'a_inspect_table',
  MNL:   'a_op_desk',
};

/** Inverse bridge: iso fixture id → top-down machine glyph code. The forward
 *  map above is lossy (FUSE/PRESS/STEAM all share a_iron_inline), so the
 *  inverse is authored explicitly. Used by the Builder's 2D plan view to
 *  render `assets/workstations.tsx` top-down sprites for machine fixtures;
 *  ids missing here (racks, trolleys, buffers, zones, operators, PML blocks)
 *  take the flat labelled-rect fallback instead. */
export const ISO_FIXTURE_TO_MACHINE_CODE: Record<string, MachineCode> = {
  a_snls: 'SNL', mach_ssm: 'SNL',
  a_dnls: 'DNL',
  a_3ol: '4OL', a_4ol: '4OL', mach_over: '4OL',
  a_5ol: '5OL',
  a_flatlock: 'FL', mach_flat: 'FL',
  a_foa: 'FB',
  a_kansai: 'KS',
  a_buttonhole: 'BH', mach_btnh: 'BH',
  a_buttonsew: 'BS',
  a_bartack: 'BT', mach_bart: 'BT',
  a_embroidery: 'EMB',
  a_knife_straight: 'CUT', cut_knife: 'CUT',
  a_knife_band: 'CUT', cut_band: 'CUT',
  a_cnc_cutter: 'CAD', cut_cnc: 'CAD',
  a_spread_auto: 'SPR', a_spread_manual: 'SPR', cut_spread: 'SPR',
  a_iron_inline: 'PRESS', fx_press: 'PRESS',
  a_inspect_table: 'INSP', fx_qctab: 'INSP',
  a_op_desk: 'MNL',
};

/** Map each worker archetype role to its iso operator fixture. Roles that
 *  share visual identity collapse onto the same operator block (e.g. all
 *  QC-flavoured roles use op_qc). */
export const WORKER_ROLE_TO_ISO_FIXTURE: Record<string, string> = {
  sew_op:           'op_sewer',
  helper:           'op_helper',
  cutter:           'op_cutter',
  spreader:         'op_cutter',
  bundler:          'op_helper',
  fuser:            'op_sewer',
  embroidery_op:    'op_sewer',
  qc_inline:        'op_qc',
  qc_final:         'op_qc',
  presser:          'op_sewer',
  packer:           'op_helper',
  material_handler: 'op_helper',
  supervisor:       'op_super',
  merchandiser:     'op_super',
};

/** Look up the iso fixture for a MachineCode or any catalog id. Returns the
 *  fixture object (with `draw`, `w`, `d`, `h`) or null. */
export function isoFixtureForMachineCode(code: string): IsoFixture | null {
  const fid = MACHINE_CODE_TO_ISO_FIXTURE[code] ?? code;
  return ISO_FIXTURE_CATALOG.find((f) => f.id === fid) ?? null;
}

/** Look up the iso fixture for a WorkerRole. */
export function isoFixtureForWorkerRole(role: string): IsoFixture | null {
  const fid = WORKER_ROLE_TO_ISO_FIXTURE[role] ?? 'op_helper';
  return ISO_FIXTURE_CATALOG.find((f) => f.id === fid) ?? null;
}

// ============================================================================
// DEFAULT VARIABLE SETS by category
// ============================================================================

export type IsoFixturePropValue = string | number | boolean | null | undefined;
export type IsoFixtureProps = Record<string, IsoFixturePropValue>;

/** Apparel-IE-tuned defaults per apparel asset id. Values reflect typical
 *  knit-garment factory baselines (cycle time in seconds, capacity/hr,
 *  operators needed, routing). They're starting points — the user is
 *  expected to tune them per machine + line. */
const APPAREL_DEFAULT_PROPS: Record<string, IsoFixtureProps> = {
  a_snls:        { capacity_per_hr: 144, cycle_s: 25, skill_required: 3, operators_needed: 1, accepts: 'panels',          produces: 'seamed-pieces' },
  a_dnls:        { capacity_per_hr: 128, cycle_s: 28, skill_required: 4, operators_needed: 1, accepts: 'panels',          produces: 'topstitched-pieces' },
  a_3ol:         { capacity_per_hr: 164, cycle_s: 22, skill_required: 3, operators_needed: 1, accepts: 'panels',          produces: 'overlocked-edges' },
  a_4ol:         { capacity_per_hr: 144, cycle_s: 25, skill_required: 3, operators_needed: 1, accepts: 'panels',          produces: 'overlocked-seams' },
  a_5ol:         { capacity_per_hr: 120, cycle_s: 30, skill_required: 4, operators_needed: 1, accepts: 'panels-heavy',    produces: 'safety-stitched-seams' },
  a_flatlock:    { capacity_per_hr: 128, cycle_s: 28, skill_required: 3, operators_needed: 1, accepts: 'panels',          produces: 'flatlocked-pieces' },
  a_bartack:     { capacity_per_hr: 300, cycle_s: 12, skill_required: 2, operators_needed: 1, accepts: 'sewn-pieces',     produces: 'reinforced-pieces' },
  a_buttonhole:  { capacity_per_hr: 257, cycle_s: 14, skill_required: 3, operators_needed: 1, accepts: 'placket',         produces: 'buttonholed-placket' },
  a_buttonsew:   { capacity_per_hr: 360, cycle_s: 10, skill_required: 2, operators_needed: 1, accepts: 'placket+button',  produces: 'buttoned-placket' },
  a_foa:         { capacity_per_hr: 120, cycle_s: 30, skill_required: 4, operators_needed: 1, accepts: 'tube-pieces',     produces: 'finished-cuffs' },
  a_kansai:      { capacity_per_hr: 128, cycle_s: 28, skill_required: 3, operators_needed: 1, accepts: 'waistband-strip', produces: 'multi-needle-band' },
  a_embroidery:  { capacity_per_hr:  20, cycle_s:180, skill_required: 2, operators_needed: 1, accepts: 'panel',           produces: 'embroidered-panel' },

  a_iron_inline: { capacity_per_hr: 180, cycle_s: 20, skill_required: 2, operators_needed: 1, accepts: 'sewn-pieces',     produces: 'pressed-pieces' },
  a_wip_rack:    { capacity_units: 60, occupied_units: 0 },
  a_op_desk:     { occupants: 1 },

  a_spread_manual:  { capacity_per_hr:  72, cycle_s: 50, skill_required: 3, operators_needed: 2, accepts: 'fabric-rolls', produces: 'fabric-lay' },
  a_spread_auto:    { capacity_per_hr: 150, cycle_s: 24, skill_required: 3, operators_needed: 1, accepts: 'fabric-rolls', produces: 'fabric-lay' },
  a_knife_straight: { capacity_per_hr:  60, cycle_s: 60, skill_required: 4, operators_needed: 1, accepts: 'fabric-lay',   produces: 'cut-panels' },
  a_knife_band:     { capacity_per_hr:  90, cycle_s: 40, skill_required: 4, operators_needed: 1, accepts: 'block-panels', produces: 'cut-panels-precise' },
  a_cnc_cutter:     { capacity_per_hr: 200, cycle_s: 18, skill_required: 3, operators_needed: 1, accepts: 'fabric-lay',  produces: 'cut-panels' },
  a_marker_plotter: { capacity_per_hr:  60, cycle_s: 60, skill_required: 2, operators_needed: 1, accepts: 'marker-file',  produces: 'paper-marker' },
  a_cut_table:      { capacity_per_hr:   0 },
  a_inspect_table:  { capacity_per_hr: 120, cycle_s: 30, skill_required: 3, operators_needed: 1, accepts: 'fabric-roll', produces: 'inspected-roll · 4pt' },

  a_fabric_rack:    { capacity_units: 24, occupied_units: 0, accepts: 'fabric-rolls' },
  a_bundle_trolley: { capacity_units: 30, occupied_units: 0, accepts: 'cut-bundles,sewn-bundles' },
};

export function defaultPropsFor(catalogId: string): IsoFixtureProps {
  const a = ISO_FIXTURE_CATALOG.find((x) => x.id === catalogId);
  if (!a) return {};
  const base: IsoFixtureProps = {
    name: a.label,
    rotation: 0,
  };
  // Apparel-specific overrides take precedence over the generic category
  // defaults below.
  if (catalogId in APPAREL_DEFAULT_PROPS) {
    return { ...base, ...APPAREL_DEFAULT_PROPS[catalogId] };
  }
  if (a.cat === 'sew' || a.cat === 'cut')
    return {
      ...base,
      capacity_per_hr: 60,
      cycle_s: 35,
      skill_required: 3,
      operators_needed: 1,
      accepts: 'fabric,panels',
      produces: 'sewn-pieces',
    };
  if (a.cat === 'mh')
    return {
      ...base,
      capacity_per_hr: 12,
      accepts: 'pallets,trolleys',
    };
  if (a.cat === 'op') return { ...base, skill: 3, max_machines: 1 };
  if (a.cat === 'buf') return { ...base, capacity: 30, current: 0 };
  if (a.cat === 'conv') return { ...base, speed_m_min: 12, capacity_per_hr: 240 };
  if (a.cat === 'store') return { ...base, capacity_units: 80, occupied_units: 0 };
  if (a.cat === 'fix') return { ...base, capacity_per_hr: 40 };
  if (a.cat === 'zone') return { ...base, area_label: a.label, color: '' };
  if (a.cat === 'pml')
    return {
      ...base,
      // PML primitives are pure simulation blocks — physical props are
      // optional and overlap heavily with the kind's semantics. We seed a
      // minimal set that the sim engine can read; the user fleshes out the
      // rest from the Inspector.
      capacity_per_hr: 0,
      cycle_s: 0,
    };
  return base;
}

