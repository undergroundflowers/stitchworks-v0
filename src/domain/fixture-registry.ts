/**
 * The one place a catalog id becomes something drawable.
 *
 * Every surface that renders a station — the Builder canvas in both
 * projections, the palette tiles, LiveSim's ambient props, `makeWorkstation`
 * seeding a new station's props — used to run its own
 * `ISO_FIXTURE_CATALOG.find(f => f.id === …)`. That was fine while the
 * catalog was the whole world. It no longer is: a station's type can be
 * authored by the user and lives in the project store, so lookups need a
 * source of truth that knows about both.
 *
 * Why a module-level registry rather than a hook: the callers include pure
 * domain functions (`makeWorkstation`, `defaultPropsFor`, PML kind
 * inference) that can't hold React state and must not import the store.
 * The store pushes the active project's types in (`store/stationTypeSync`),
 * this module answers lookups, and components still re-render normally
 * because they read the same list out of the store themselves.
 */

import {
  ISO_FIXTURE_CATALOG,
  ISO_FIXTURE_TO_MACHINE_CODE,
  LEGACY_CATALOG_ID,
  fixtureForStationType,
  withPmlKind,
  type IsoFixture,
} from './iso';
import type { GlyphFamily } from './machine-glyphs';
import type { MachineCode } from './machines';
import type { StationArt } from './station-art';
import { isStationTypeId, type StationType } from './stationTypes';
import {
  PML_BLOCK_LIBRARY,
  getBlockKind,
  inferBlockKindFromCatalog,
  pmlKindFromFixtureId,
  type BlockSubject,
  type PmlBlockKind,
} from './pml';
import type { PmlIconComponent } from '../assets/pml-icons';

let types: StationType[] = [];
let fixtures = new Map<string, IsoFixture>();

/** Replace the registered station types. Called by the store on hydrate and
 *  on every edit; the fixtures are rebuilt eagerly because a lookup happens
 *  once per station per frame and a type edit happens once in a while. */
export function setStationTypes(next: StationType[]): void {
  types = next;
  fixtures = new Map(next.map((t) => [t.id, fixtureForStationType(t)]));
  // The kind-reskin cache keys on the catalog id, and an authored type's own
  // drawing can change under a stable id — drop it with the fixtures it was
  // derived from.
  reskinned.clear();
}

/** The authored type behind a catalog id, or undefined for a built-in. */
export function stationTypeFor(catalogId: string): StationType | undefined {
  if (!isStationTypeId(catalogId)) return undefined;
  return types.find((t) => t.id === catalogId);
}

/** Every registered type, in authoring order. */
export function allStationTypes(): StationType[] {
  return types;
}

/**
 * Resolve a catalog id to the fixture that draws it: authored types first,
 * then the built-in catalog, then one retry through `LEGACY_CATALOG_ID` so
 * an id deleted with the old palette sections still renders even if it
 * reached this call without passing through `normalizeTwin`.
 */
export function lookupFixture(catalogId: string): IsoFixture | undefined {
  const custom = fixtures.get(catalogId);
  if (custom) return custom;
  const builtIn = ISO_FIXTURE_CATALOG.find((f) => f.id === catalogId);
  if (builtIn) return builtIn;
  const legacy = LEGACY_CATALOG_ID[catalogId];
  return legacy ? ISO_FIXTURE_CATALOG.find((f) => f.id === legacy) : undefined;
}

/**
 * The mark a station draws in the 2D plan: a machine code for built-in
 * machines (whose family comes from `MACHINE_GLYPH_FAMILY`), or the family
 * and code an authored type carries directly. Returns an empty object for
 * fixtures with no mechanism to draw — racks, buffers, PML blocks — which
 * fall back to their label.
 *
 * One helper so the canvas body and the palette tile can never disagree
 * about what a station looks like before and after it is dropped.
 */
export function stationMark(catalogId: string): {
  code?: MachineCode;
  family?: GlyphFamily;
  markCode?: string;
  art?: StationArt;
} {
  const type = stationTypeFor(catalogId);
  if (type) {
    // A `block` type is a logic block: its identity is the PML icon on the
    // ISO body, and stamping a stroke mark on the plan would claim a
    // mechanism it does not have.
    const isBlock = type.form === 'block';
    // Uploaded plan artwork replaces the stroke mark — including for a block,
    // where the user has now said explicitly what it should look like. The
    // type code stays: it is the label, not the mark.
    if (type.planArt) return { art: type.planArt, markCode: isBlock ? undefined : type.code };
    return isBlock ? {} : { family: type.glyph, markCode: type.code };
  }
  const code = ISO_FIXTURE_TO_MACHINE_CODE[catalogId];
  return code ? { code } : {};
}

// ============================================================================
// LOGIC BLOCKS — the fixtures whose drawing IS their block kind
// ============================================================================
//
// A sewing machine is drawn as the machine it is, whatever the simulation runs
// it as. A logic block has no machine: a Source, a Queue and a Sink are the
// same empty volume, and the only thing telling them apart in any view is the
// PML glyph on top. So for those — and only those — the drawing has to follow
// the workstation's LIVE block kind rather than the catalog id it was dropped
// from, or re-declaring a block's kind in the Inspector leaves the floor
// showing the kind it used to be.

/** True when the fixture has no equipment to depict and draws its PML kind
 *  instead — a `pml_*` primitive, or an authored type whose form is `block`
 *  and which carries no uploaded isometric artwork of its own. */
function isLogicBlock(catalogId: string, fixture: IsoFixture): boolean {
  const type = stationTypeFor(catalogId);
  if (type) return type.form === 'block' && !type.isoArt;
  return fixture.cat === 'pml';
}

/** The kind a logic-block fixture draws before any override — what the
 *  catalog id (or the authored type) says it is. */
function baseKindOf(catalogId: string): PmlBlockKind | undefined {
  return stationTypeFor(catalogId)?.kind ?? pmlKindFromFixtureId(catalogId) ?? undefined;
}

// Re-skinned fixtures are memoised per (catalogId, kind): `withPmlKind` builds
// a fresh draw closure, and this resolves once per station per frame.
const reskinned = new Map<string, IsoFixture>();

/**
 * The fixture that draws a particular workstation — `lookupFixture` plus the
 * block-kind override for logic blocks.
 *
 * Every canvas that DRAWS a station should call this; `lookupFixture` remains
 * the right call for anything that only needs the footprint (`w`/`d`/`h`),
 * which a kind change never moves.
 */
export function fixtureForWorkstation(
  ws: BlockSubject & { catalogId: string },
): IsoFixture | undefined {
  const base = lookupFixture(ws.catalogId);
  if (!base || !isLogicBlock(ws.catalogId, base)) return base;
  const kind = getBlockKind(ws);
  if (kind === baseKindOf(ws.catalogId)) return base;
  const key = `${ws.catalogId}|${kind}`;
  let skin = reskinned.get(key);
  if (!skin) {
    skin = withPmlKind(base, kind);
    reskinned.set(key, skin);
  }
  return skin;
}

/**
 * The PML glyph a workstation draws in the top-down plan, or undefined when
 * it is real equipment and draws a machine mark instead.
 *
 * The 2D plan used to fall back to an abbreviated label for every logic
 * block, so the one view where blocks are easiest to compare side by side was
 * the one view that never drew the kind at all.
 */
export function stationBlockIcon(
  ws: BlockSubject & { catalogId: string },
): { Icon: PmlIconComponent; category: string } | undefined {
  const base = lookupFixture(ws.catalogId);
  if (!base || !isLogicBlock(ws.catalogId, base)) return undefined;
  const spec = PML_BLOCK_LIBRARY[getBlockKind(ws)];
  return { Icon: spec.Icon, category: spec.category };
}

/**
 * The PML block kind a catalog id becomes when it is dropped on the PROCESS
 * canvas.
 *
 * Precedence: an authored station type carries its own kind (the point of
 * choosing one while authoring is that the station arrives already being that
 * thing) → a `pml_*` primitive maps straight across → anything else is
 * inferred from the catalog id.
 *
 * `makeWorkstation` and the PROCESS drop ghost both call this, so what the
 * ghost promises under the cursor and what the drop actually creates cannot
 * disagree. Note the palette's *preset* id is deliberately not part of the
 * chain: a preset's `baseKind` is already baked into the fixture id by
 * `pmlFixtureId` before it ever reaches here.
 */
export function resolveBlockKindForDrop(catalogId: string): PmlBlockKind {
  return (
    stationTypeFor(catalogId)?.kind ??
    pmlKindFromFixtureId(catalogId) ??
    inferBlockKindFromCatalog(catalogId)
  );
}
