/**
 * Station types — the station vocabulary the user authors themselves.
 *
 * The palette used to ship four fixed sections: sewing machines, sewing
 * fixtures, materials handling, operators. The last three were a thin,
 * unextendable list that made decisions belonging to whoever is modelling
 * the floor — which iron, which cart, which operator — so they are gone.
 * What replaces them is this: the user declares a station type once and it
 * behaves like a built-in fixture everywhere.
 *
 * A type answers three questions, which is exactly what the authoring
 * dialog asks:
 *
 *   • what it looks like in ISO   → `form` + `w`/`d`/`h`
 *   • what it looks like in 2D    → `glyph` + `code`
 *   • what it is to the sim       → `kind`, whose PARAM_FIELDS_BY_KIND
 *                                   set then drives `params`
 *
 * The id doubles as a `Workstation.catalogId`, so a placed station needs no
 * extra field and no schema migration — `lookupFixture` resolves custom ids
 * and built-in ids through the same call.
 *
 * Pure data + pure logic. No React, no DOM, no zustand: `iso.ts` builds the
 * IsoFixture (it owns the draw functions), the project store owns the list,
 * and `fixture-registry.ts` is where the two meet.
 */

import type { GlyphFamily } from './machine-glyphs';
import { normalizeStationArt, type StationArt } from './station-art';
import type { PmlBlockKind, PmlBlockParams } from './pml';

/**
 * How the type is built in the isometric view when it carries no `isoArt`.
 *
 * A closed set drawn from the existing fixture vocabulary — three forms
 * cover the floor: a machine on a table, a plain volume, and a logic block.
 * Uploaded artwork overrides this per view (see `planArt` / `isoArt`), and
 * it is SVG for the same reason this set is small: the canvas is SVG and the
 * 2D↔ISO morph interpolates geometry, so artwork has to be vector too.
 */
export type StationForm = 'machine' | 'bench' | 'block';

export const STATION_FORMS: { id: StationForm; label: string; blurb: string }[] = [
  { id: 'machine', label: 'Machine', blurb: 'Table with a head on top — a machine an operator sits at.' },
  { id: 'bench',   label: 'Bench',   blurb: 'One plain volume. Tables, racks, carts — height tells them apart.' },
  { id: 'block',   label: 'Block',   blurb: 'Logic block carrying its PML icon — no physical equipment.' },
];

export const STATION_GLYPHS: { id: GlyphFamily; label: string; blurb: string }[] = [
  { id: 'seam',  label: 'Seam',  blurb: 'One diagonal — a single running seam.' },
  { id: 'edge',  label: 'Edge',  blurb: 'Two parallel bars — layered rows along an edge.' },
  { id: 'point', label: 'Point', blurb: 'Two dots — programmed point work.' },
  { id: 'blade', label: 'Blade', blurb: 'A cross — crossed blades.' },
  { id: 'plate', label: 'Plate', blurb: 'A triangle — flat heat or ply work.' },
  { id: 'bench', label: 'Bench', blurb: 'A square — a table, no mechanism.' },
];

/** Palette section a type lands in when the user names none. */
export const DEFAULT_STATION_GROUP = 'Custom';

export interface StationType {
  /** `cst-…`. Used directly as `Workstation.catalogId`. */
  id: string;
  label: string;
  /** Palette section title. Types sharing a group share a section, so
   *  naming one is how the user creates a palette group of their own. */
  group: string;
  form: StationForm;
  /** Mark drawn on the 2D plan and on the ISO top face. */
  glyph: GlyphFamily;
  /** Short type code printed under the mark, e.g. `IRN`. */
  code: string;
  /** Footprint in world cells (`w` × `d`) and altitude units (`h`). */
  w: number;
  d: number;
  h: number;
  /** Uploaded SVG drawn inside the 2D plan footprint, replacing the stroke
   *  mark. Absent means the `glyph` mark is drawn. */
  planArt?: StationArt;
  /** Uploaded SVG drawn in place of the whole isometric body, fitted to the
   *  footprint's projected box. Absent means `form` builds the cuboid. */
  isoArt?: StationArt;
  /** What the simulation runs this as. Drives which params exist. */
  kind: PmlBlockKind;
  /** Authored defaults, stamped onto every station dropped from this type. */
  params: PmlBlockParams;
  createdAt: string;
}

export function newStationTypeId(): string {
  return `cst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** True for ids minted by `newStationTypeId`. Cheap enough to call on every
 *  fixture lookup, and it keeps custom ids from ever colliding with the
 *  built-in catalog's `a_` / `fx_` / `pml_` namespaces. */
export function isStationTypeId(catalogId: string): boolean {
  return catalogId.startsWith('cst-');
}

/** Clamp an authored type to values the canvas and engine can draw / run.
 *  Applied on save so a bad number can't reach the store, and again on
 *  load so an older payload can't either. */
export function normalizeStationType(t: StationType): StationType {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    ...t,
    label: t.label.trim() || 'Station type',
    group: t.group.trim() || DEFAULT_STATION_GROUP,
    // The code is stamped into a mark a few pixels tall — anything longer
    // than five characters renders as a smudge.
    code: t.code.trim().toUpperCase().slice(0, 5),
    w: clamp(t.w, 0.5, 12, 1),
    d: clamp(t.d, 0.5, 12, 1),
    h: clamp(t.h, 0.1, 8, 1.4),
    // Artwork is re-validated, not just carried: this runs on every load
    // path, including a hand-edited `.swproj`, and the markup ends up in
    // `dangerouslySetInnerHTML`. Anything that fails is dropped and the
    // station falls back to its Form / Mark.
    planArt: normalizeStationArt(t.planArt),
    isoArt: normalizeStationArt(t.isoArt),
  };
}
