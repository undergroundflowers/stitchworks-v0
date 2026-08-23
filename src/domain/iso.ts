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
import type { StationType } from './stationTypes';
import { glyphMark, type GlyphFamily } from './machine-glyphs';
import { PML_CATEGORY_TINT } from '../design/tokens';

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

/**
 * Projection blended `t` of the way from FLAT (t = 0) to ISO (t = 1).
 *
 * Both projections are linear maps of (x, y, z), so their pointwise blend is
 * itself a linear map with an exact inverse — the Builder animates `t` to
 * morph the floor between plan and isometric without swapping geometry
 * mid-flight. `kind` reports 'iso' for any 0 < t < 1 so sprites render their
 * volumetric form throughout the tween: the altitude coefficient scales with
 * `t`, so at t → 0 every cuboid collapses onto its own footprint (i.e. the
 * flat plan) and the hand-off to the true 2D renderer is seamless.
 */
export function lerpProjection(t: number): Projection {
  if (t <= 0) return FLAT_PROJECTION;
  if (t >= 1) return ISO_PROJECTION;
  // screen = M(t) · world. a,b feed sx; c,d feed sy; zc drops altitude into sy.
  const a = FLAT_CELL + (ISO_TILE - FLAT_CELL) * t; // x → sx
  const b = -ISO_TILE * t; // y → sx
  const c = ISO_THIN * t; // x → sy
  const d = FLAT_CELL + (ISO_THIN - FLAT_CELL) * t; // y → sy
  const zc = ISO_Z * t; // z → −sy
  const det = a * d - b * c; // stays positive over the whole blend range
  return {
    kind: 'iso',
    project: (x, y, z = 0) => ({ sx: a * x + b * y, sy: c * x + d * y - zc * z }),
    unproject: (sx, sy) => ({
      x: (d * sx - b * sy) / det,
      y: (a * sy - c * sx) / det,
    }),
  };
}

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

// ── The five factories ──────────────────────────────────────────────────────
//
// Everything on the isometric floor is drawn by one of these. There used to be
// 33 bespoke factories — a modelled sewing machine with a motor block and
// thread cone, a 215-line articulated operator, belt-striped conveyors — and
// on a real floor of 30+ stations that detail read as noise, not information.
//
// Volume is kept (an isometric view without it stops reading as 3D) but each
// fixture is now one or two plain cuboids. Machines carry the same family mark
// and type code the flat plan view uses, painted unskewed on the top face:
// see domain/machine-glyphs.ts. Colour is reserved for state.
//
// Every fixture id, footprint and the IsoDrawFn contract are unchanged, so the
// Builder palette, the Builder ISO canvas and LiveSim's ambient props all pick
// this up with no call-site edits.

/** Draw a family mark + type code flat on a cuboid's top-face centroid.
 *
 *  Deliberately unskewed: a two-stroke mark projected into the iso diamond
 *  turns to mush at any zoom, and the point of the mark is that it is
 *  recognisable at a glance. */
function topFaceMark(
  w: number, d: number, h: number, r: number,
  family: GlyphFamily | null, code: string | null,
): ReactNode {
  const c = isoProjR(w / 2, d / 2, h, r, w, d);
  // Scale to the footprint's short side, but cap it — `cut_spread` is 6×2
  // cells and a proportional mark would be a billboard.
  const s = Math.min(Math.min(w, d) * ISO_TILE * 0.5, 26);
  return createElement(
    'g',
    null,
    family && s >= 10 ? glyphMark(family, c.sx, c.sy - (code ? 4 : 0), s, SW_PAL.metal) : null,
    code && s >= 12
      ? createElement(
          'text',
          {
            x: c.sx,
            y: c.sy + s * 0.5,
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", monospace',
            fontSize: 8,
            fontWeight: 800,
            fill: SW_PAL.metal,
            textAnchor: 'middle',
            letterSpacing: '0.5px',
          },
          code,
        )
      : null,
  );
}

/** A machine: table cuboid + one head cuboid + its mark. */
function machineBox(family: GlyphFamily, code: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    const tableH = h * 0.55;
    // Absolute clamps, not proportions — see topFaceMark.
    const hw = Math.min(w * 0.6, 1.0);
    const hd = Math.min(d * 0.5, 0.8);
    const ox = (w - hw) / 2;
    const oy = (d - hd) / 2;
    return createElement(
      'g',
      null,
      CuboidFaces({ w, d, h: tableH, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      createElement(
        'g',
        { transform: `translate(${isoProjR(ox, oy, 0, r, w, d).sx - isoProjR(0, 0, 0, r, w, d).sx}, ${isoProjR(ox, oy, tableH, r, w, d).sy - isoProjR(0, 0, 0, r, w, d).sy})` },
        CuboidFaces({ w: hw, d: hd, h: h * 0.45, top: SW_PAL.metal, left: SW_PAL.metalLo, right: SW_PAL.metal, r }),
      ),
      topFaceMark(w, d, h, r, family, code),
    );
  };
}

/** Anything with no mechanism to draw — racks, trolleys, tables, conveyors,
 *  walls, cutters. One neutral cuboid, optionally captioned. */
function fixtureBox(code?: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) =>
    createElement(
      'g',
      null,
      CuboidFaces({ w, d, h, top: SW_PAL.cream, left: SW_PAL.creamLo, right: SW_PAL.cream, r }),
      code ? topFaceMark(w, d, h, r, null, code) : null,
    );
}

/** A painted floor region. Regions are annotation, so they get no volume. */
function zoneFloor(label: string): IsoDrawFn {
  return ({ w, d, r = 0 }) => {
    const A = isoProjR(0, 0, 0, r, w, d),
      B = isoProjR(w, 0, 0, r, w, d),
      C = isoProjR(w, d, 0, r, w, d),
      D = isoProjR(0, d, 0, r, w, d);
    const cx = (A.sx + B.sx + C.sx + D.sx) / 4;
    const cy = (A.sy + B.sy + C.sy + D.sy) / 4;
    return createElement(
      'g',
      null,
      createElement('polygon', {
        points: ptsToStr([A, B, C, D]),
        fill: SW_PAL.creamLo,
        fillOpacity: 0.5,
        stroke: SW_PAL.steel,
        strokeWidth: 1.2,
        strokeDasharray: '4 4',
      }),
      createElement(
        'text',
        {
          x: cx,
          y: cy + 4,
          fontFamily: '"IBM Plex Mono", "JetBrains Mono", monospace',
          fontSize: 10,
          fontWeight: 800,
          fill: SW_PAL.metal,
          textAnchor: 'middle',
          letterSpacing: '1.5px',
        },
        label,
      ),
    );
  };
}

/**
 * Per-PML-category accent colour, read straight from the shared token.
 *
 * This used to be a hand-copied table whose comment claimed it matched the
 * PROCESS canvas. It did not: five of six categories had drifted, and three of
 * them had drifted onto the *status* ramp (`SW_PAL.red` is `alarm`,
 * `SW_PAL.yellow` is `warn`, `SW_PAL.green` is `ok`), so a Source on the ISO
 * floor was wearing the colour that means "choked" everywhere else. Reading
 * the token makes the claim true by construction.
 */
function pmlCatAccent(cat: PmlCategory): string {
  return PML_CATEGORY_TINT[cat]?.stroke ?? SW_PAL.ink;
}

/** A PML logic block. Body cuboid + the kind's icon.
 *
 *  The accent stripe and the inset top-face rectangle are gone; the accent
 *  now lives only on the icon. These are logical blocks rather than
 *  equipment, so unlike machines they keep a category colour — it is the
 *  only thing distinguishing a Source from a Sink at a glance. */
function pmlBlock(Icon: PmlIconComponent, accent: string): IsoDrawFn {
  return ({ w, d, h, r = 0 }) => {
    const topCenter = isoProjR(w / 2, d / 2, h, r, w, d);
    const iconSize = 26;
    return createElement(
      'g',
      null,
      CuboidFaces({
        w,
        d,
        h,
        top: SW_PAL.paper,
        left: shade(SW_PAL.paperShade, -0.05),
        right: SW_PAL.paperShade,
        r,
      }),
      createElement(Icon, {
        size: iconSize,
        color: accent,
        x: topCenter.sx - iconSize / 2,
        y: topCenter.sy - iconSize / 2 + 2,
      }),
    );
  };
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
  { id: 'buf', label: 'Buffers', icon: '◫' },
  { id: 'fix', label: 'Fixtures', icon: '▭' },
  { id: 'pml', label: 'Process blocks', icon: '⚙' },
];

// ============================================================================
// APPAREL PALETTE — curated, dept-aware view of the catalog
//
// The Builder's workstation palette renders this instead of filtering the
// raw fixture catalog by category. Only sewing machines ship built-in —
// fixtures, handling and operators used to be fixed lists here and are now
// authored by the user as station types (see `domain/stationTypes.ts`),
// which the palette renders as its own sections alongside this one.
// ============================================================================

export type ApparelCategoryId = 'sew_mach';

export interface ApparelCategory {
  id: ApparelCategoryId;
  label: string;
  icon: string;
}

export const APPAREL_CATEGORIES: ApparelCategory[] = [
  { id: 'sew_mach', label: 'Sewing machines', icon: '⌃' },
];

/** The one built-in palette section: the sewing machines a garment op can
 *  be run on, in the order they should appear. Renamed from APPAREL_PALETTE
 *  to disambiguate from palette.ts's flat PaletteElement[] of the same name
 *  (caused a star-export conflict).
 *
 *  Sewing-floor scope: cutting-room assets (spreaders, knives, CNC cutter,
 *  marker plotter, cut/inspection tables, fabric roll rack) are absent but
 *  remain in ISO_FIXTURE_CATALOG, so factories that already placed them —
 *  and the .xlsx floor importer — still resolve. */

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
  { id: 'wall_str', cat: 'arch', label: 'Wall — straight', w: 4, d: 1, h: 5, draw: fixtureBox() },
  { id: 'wall_corner', cat: 'arch', label: 'Wall — corner', w: 1, d: 1, h: 5, draw: fixtureBox() },
  { id: 'door_bay', cat: 'arch', label: 'Loading door', w: 2, d: 1, h: 4, draw: fixtureBox() },
  { id: 'window', cat: 'arch', label: 'Window strip', w: 3, d: 1, h: 3, draw: fixtureBox() },
  { id: 'column', cat: 'arch', label: 'Steel column', w: 1, d: 1, h: 6, draw: fixtureBox() },
  { id: 'stairs', cat: 'arch', label: 'Stairs', w: 2, d: 3, h: 3, draw: fixtureBox() },

  // --- FLOOR ZONES (paint regions) ---
  { id: 'zone_cut', cat: 'zone', label: 'Cutting zone', w: 6, d: 6, h: 0.05, draw: zoneFloor('CUTTING') },
  { id: 'zone_sew', cat: 'zone', label: 'Sewing zone', w: 8, d: 8, h: 0.05, draw: zoneFloor('SEWING') },
  { id: 'zone_qc', cat: 'zone', label: 'QC zone', w: 4, d: 4, h: 0.05, draw: zoneFloor('QC') },
  { id: 'zone_store', cat: 'zone', label: 'Storage zone', w: 6, d: 5, h: 0.05, draw: zoneFloor('STORE') },

  // --- CONVEYORS ---
  { id: 'conv_str', cat: 'conv', label: 'Conveyor — straight', w: 3, d: 1, h: 0.8, draw: fixtureBox('CONV') },
  { id: 'conv_curve', cat: 'conv', label: 'Conveyor — curve', w: 2, d: 2, h: 0.8, draw: fixtureBox('CONV') },
  { id: 'conv_inc', cat: 'conv', label: 'Conveyor — incline', w: 3, d: 1, h: 1.6, draw: fixtureBox('CONV') },

  // --- SEWING MACHINES ---
  { id: 'mach_ssm', cat: 'sew', label: 'Single-needle Lock', w: 1, d: 2, h: 1.4, draw: machineBox('seam', 'SNL') },
  { id: 'mach_over', cat: 'sew', label: 'Overlock 4-thread', w: 1, d: 2, h: 1.4, draw: machineBox('edge', '4OL') },
  { id: 'mach_flat', cat: 'sew', label: 'Flatlock', w: 1, d: 2, h: 1.4, draw: machineBox('edge', 'FL') },
  { id: 'mach_bart', cat: 'sew', label: 'Bartack', w: 1, d: 2, h: 1.4, draw: machineBox('point', 'BT') },
  { id: 'mach_btnh', cat: 'sew', label: 'Buttonhole', w: 1, d: 2, h: 1.4, draw: machineBox('point', 'BH') },

  // --- CUTTING MACHINES ---
  { id: 'cut_spread', cat: 'cut', label: 'Spread Table', w: 6, d: 2, h: 1.0, draw: machineBox('plate', 'SPR') },
  { id: 'cut_knife', cat: 'cut', label: 'Straight Knife', w: 1, d: 1, h: 1.5, draw: machineBox('blade', 'CUT') },
  { id: 'cut_band', cat: 'cut', label: 'Band Knife', w: 2, d: 2, h: 2.0, draw: machineBox('blade', 'CUT') },
  { id: 'cut_cnc', cat: 'cut', label: 'CNC Auto Cutter', w: 5, d: 3, h: 1.8, draw: machineBox('blade', 'CAD') },

  // --- MATERIAL HANDLING ---
  { id: 'mh_forklift', cat: 'mh', label: 'Forklift', w: 1, d: 2, h: 2.0, draw: fixtureBox('FORK') },
  { id: 'mh_pallet', cat: 'mh', label: 'Pallet jack', w: 1, d: 2, h: 0.6, draw: fixtureBox('JACK') },
  { id: 'mh_trolley', cat: 'mh', label: 'WIP trolley', w: 1, d: 1, h: 1.2, draw: fixtureBox('CART') },
  { id: 'mh_agv', cat: 'mh', label: 'AGV', w: 1, d: 2, h: 0.8, draw: fixtureBox('AGV') },

  // --- STORAGE ---
  { id: 'st_rack', cat: 'store', label: 'Pallet rack', w: 4, d: 1, h: 5, draw: fixtureBox('RACK') },
  { id: 'st_pallet', cat: 'store', label: 'Pallet (loaded)', w: 1, d: 1, h: 1.2, draw: fixtureBox('PLT') },
  { id: 'st_roll', cat: 'store', label: 'Fabric roll', w: 1, d: 3, h: 0.8, draw: fixtureBox('ROLL') },
  { id: 'st_bin', cat: 'store', label: 'Bin shelf', w: 2, d: 1, h: 3.5, draw: fixtureBox('BIN') },

  // --- BUFFERS ---
  { id: 'buf_in', cat: 'buf', label: 'Inbound buffer', w: 2, d: 2, h: 0.4, draw: fixtureBox('IN') },
  { id: 'buf_out', cat: 'buf', label: 'Outbound buffer', w: 2, d: 2, h: 0.4, draw: fixtureBox('OUT') },
  { id: 'buf_wip', cat: 'buf', label: 'WIP cart', w: 1, d: 2, h: 1.0, draw: fixtureBox('WIP') },

  // --- FIXTURES ---
  { id: 'fx_table', cat: 'fix', label: 'Work table', w: 2, d: 1, h: 1.0, draw: fixtureBox('TABLE') },
  { id: 'fx_press', cat: 'fix', label: 'Pressing table', w: 2, d: 1, h: 1.1, draw: machineBox('plate', 'PRESS') },
  { id: 'fx_qctab', cat: 'fix', label: 'QC table', w: 2, d: 1, h: 1.0, draw: machineBox('bench', 'INSP') },
  { id: 'fx_pack', cat: 'fix', label: 'Packing bench', w: 3, d: 1, h: 1.0, draw: fixtureBox('PACK') },

  // ─── APPAREL — SEWING MACHINES ──────────────────────────────────────────
  { id: 'a_snls',       cat: 'sew', label: 'SNLS · Single-needle Lock',  w: 1, d: 2, h: 1.4, draw: machineBox('seam', 'SNL')  },
  { id: 'a_dnls',       cat: 'sew', label: 'DNLS · Double-needle Lock',  w: 1, d: 2, h: 1.4, draw: machineBox('seam', 'DNL')  },
  { id: 'a_3ol',        cat: 'sew', label: 'Overlock · 3-thread',        w: 1, d: 2, h: 1.4, draw: machineBox('edge', '4OL')  },
  { id: 'a_4ol',        cat: 'sew', label: 'Overlock · 4-thread',        w: 1, d: 2, h: 1.4, draw: machineBox('edge', '4OL')  },
  { id: 'a_5ol',        cat: 'sew', label: 'Overlock · 5-thread safety', w: 1, d: 2, h: 1.4, draw: machineBox('edge', '5OL')  },
  { id: 'a_flatlock',   cat: 'sew', label: 'Flatlock · Coverstitch',     w: 1, d: 2, h: 1.4, draw: machineBox('edge', 'FL')  },
  { id: 'a_bartack',    cat: 'sew', label: 'Bartack',                    w: 1, d: 2, h: 1.4, draw: machineBox('point', 'BT')  },
  { id: 'a_buttonhole', cat: 'sew', label: 'Buttonhole',                 w: 1, d: 2, h: 1.4, draw: machineBox('point', 'BH')  },
  { id: 'a_buttonsew',  cat: 'sew', label: 'Button Sew',                 w: 1, d: 2, h: 1.4, draw: machineBox('point', 'BS')  },
  { id: 'a_foa',        cat: 'sew', label: 'Feed-off-the-Arm',           w: 1, d: 2, h: 1.4, draw: machineBox('seam', 'FB')  },
  { id: 'a_kansai',     cat: 'sew', label: 'Kansai · Multi-needle',      w: 1, d: 2, h: 1.4, draw: machineBox('edge', 'KS')  },
  { id: 'a_embroidery', cat: 'sew', label: 'Embroidery · Single-head',   w: 2, d: 3, h: 1.6, draw: machineBox('point', 'EMB') },

  // ─── APPAREL — CUTTING MACHINES ─────────────────────────────────────────
  { id: 'a_spread_manual', cat: 'cut', label: 'Spread Table · Manual',   w: 6, d: 2, h: 1.0, draw: machineBox('plate', 'SPR') },
  { id: 'a_spread_auto',   cat: 'cut', label: 'Auto Spreader',           w: 6, d: 2, h: 1.4, draw: machineBox('plate', 'SPR')          },
  { id: 'a_knife_straight',cat: 'cut', label: 'Straight Knife Cutter',   w: 1, d: 1, h: 1.5, draw: machineBox('blade', 'CUT')           },
  { id: 'a_knife_band',    cat: 'cut', label: 'Band Knife Cutter',       w: 2, d: 2, h: 2.0, draw: machineBox('blade', 'CUT')             },
  { id: 'a_cnc_cutter',    cat: 'cut', label: 'CNC Auto Cutter',         w: 5, d: 3, h: 1.8, draw: machineBox('blade', 'CAD')             },
  { id: 'a_marker_plotter',cat: 'cut', label: 'Marker Plotter',          w: 5, d: 1, h: 1.0, draw: fixtureBox('PLOT')         },

  // ─── APPAREL — CUTTING FIXTURES ─────────────────────────────────────────
  { id: 'a_cut_table',     cat: 'cut', label: 'Cutting Table · Plain',   w: 4, d: 2, h: 1.0, draw: fixtureBox('TABLE') },
  { id: 'a_inspect_table', cat: 'fix', label: 'Inspection · 4-point',    w: 3, d: 1, h: 1.0, draw: machineBox('bench', 'INSP')               },

  // ─── APPAREL — MATERIALS & HANDLING ─────────────────────────────────────
  { id: 'a_fabric_rack',   cat: 'store', label: 'Fabric Roll Rack', w: 4, d: 1, h: 4.5, draw: fixtureBox('ROLL')          },

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
    draw: pmlBlock(spec.Icon, pmlCatAccent(spec.category)),
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
  FUSE:  'fx_press',
  PRESS: 'fx_press',
  STEAM: 'fx_press',
  INSP:  'a_inspect_table',
  MNL:   'fx_table',
};

/** Inverse bridge: iso fixture id → top-down machine glyph code. The forward
 *  map above is lossy (FUSE/PRESS/STEAM all share fx_press), so the
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
  fx_press: 'PRESS',
  a_inspect_table: 'INSP', fx_qctab: 'INSP',
  fx_table: 'MNL',
};

/**
 * Build the iso fixture for a user-authored station type.
 *
 * Lives here rather than in `stationTypes.ts` so `machineBox` / `fixtureBox`
 * / `pmlBlock` stay private to this module: a custom type is drawn by the
 * same three functions the built-in catalog uses, which is what keeps an
 * authored station from looking like a foreign object on the floor.
 */
export function fixtureForStationType(t: StationType): IsoFixture {
  const draw =
    t.form === 'machine'
      ? machineBox(t.glyph, t.code)
      : t.form === 'block'
        ? pmlBlock(PML_BLOCK_LIBRARY[t.kind].Icon, pmlCatAccent(PML_BLOCK_LIBRARY[t.kind].category))
        : fixtureBox(t.code);
  return {
    id: t.id,
    // `fix` is the catalog's "a thing on the floor with no further
    // taxonomy" bucket — the right home for an authored type, and it keeps
    // LiveSim's ambient palette and `defaultPropsFor` on their generic paths.
    cat: 'fix',
    label: t.label,
    w: t.w,
    d: t.d,
    h: t.h,
    draw,
  };
}

/**
 * Catalog ids that no longer exist, and what they become.
 *
 * The sewing-fixture / materials-handling / operator palette sections were
 * removed — the user authors those as station types now — and their fixtures
 * went with them. A factory saved before that still carries the old ids, so
 * every id is rewritten to the nearest surviving fixture: the iron and the
 * operator desk keep their artwork under the catalog-only `fx_*` entries, the
 * rack and trolley become the generic buffer/cart, and the operator figures
 * become the PML ResourcePool block they always meant in the model.
 *
 * Applied once when a twin is loaded (`store/twin.ts`) and again as a
 * fallback in `lookupFixture`, so a stale id can never render as a hole.
 */
export const LEGACY_CATALOG_ID: Record<string, string> = {
  a_iron_inline: 'fx_press',
  a_op_desk: 'fx_table',
  a_wip_rack: 'buf_wip',
  a_bundle_trolley: 'mh_trolley',
  op_generic: pmlFixtureId('ResourcePool'),
  op_sewer: pmlFixtureId('ResourcePool'),
  op_cutter: pmlFixtureId('ResourcePool'),
  op_helper: pmlFixtureId('ResourcePool'),
  op_super: pmlFixtureId('ResourcePool'),
  op_qc: pmlFixtureId('ResourcePool'),
};

/** Look up the iso fixture for a MachineCode or any catalog id. Returns the
 *  fixture object (with `draw`, `w`, `d`, `h`) or null. */
export function isoFixtureForMachineCode(code: string): IsoFixture | null {
  const fid = MACHINE_CODE_TO_ISO_FIXTURE[code] ?? code;
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


  a_spread_manual:  { capacity_per_hr:  72, cycle_s: 50, skill_required: 3, operators_needed: 2, accepts: 'fabric-rolls', produces: 'fabric-lay' },
  a_spread_auto:    { capacity_per_hr: 150, cycle_s: 24, skill_required: 3, operators_needed: 1, accepts: 'fabric-rolls', produces: 'fabric-lay' },
  a_knife_straight: { capacity_per_hr:  60, cycle_s: 60, skill_required: 4, operators_needed: 1, accepts: 'fabric-lay',   produces: 'cut-panels' },
  a_knife_band:     { capacity_per_hr:  90, cycle_s: 40, skill_required: 4, operators_needed: 1, accepts: 'block-panels', produces: 'cut-panels-precise' },
  a_cnc_cutter:     { capacity_per_hr: 200, cycle_s: 18, skill_required: 3, operators_needed: 1, accepts: 'fabric-lay',  produces: 'cut-panels' },
  a_marker_plotter: { capacity_per_hr:  60, cycle_s: 60, skill_required: 2, operators_needed: 1, accepts: 'marker-file',  produces: 'paper-marker' },
  a_cut_table:      { capacity_per_hr:   0 },
  a_inspect_table:  { capacity_per_hr: 120, cycle_s: 30, skill_required: 3, operators_needed: 1, accepts: 'fabric-roll', produces: 'inspected-roll · 4pt' },

  a_fabric_rack:    { capacity_units: 24, occupied_units: 0, accepts: 'fabric-rolls' },
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

