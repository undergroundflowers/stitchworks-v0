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
  type IsoFixture,
} from './iso';
import type { GlyphFamily } from './machine-glyphs';
import type { MachineCode } from './machines';
import { isStationTypeId, type StationType } from './stationTypes';
import {
  inferBlockKindFromCatalog,
  pmlKindFromFixtureId,
  type PmlBlockKind,
} from './pml';

let types: StationType[] = [];
let fixtures = new Map<string, IsoFixture>();

/** Replace the registered station types. Called by the store on hydrate and
 *  on every edit; the fixtures are rebuilt eagerly because a lookup happens
 *  once per station per frame and a type edit happens once in a while. */
export function setStationTypes(next: StationType[]): void {
  types = next;
  fixtures = new Map(next.map((t) => [t.id, fixtureForStationType(t)]));
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
} {
  const type = stationTypeFor(catalogId);
  if (type) {
    // A `block` type is a logic block: its identity is the PML icon on the
    // ISO body, and stamping a stroke mark on the plan would claim a
    // mechanism it does not have.
    return type.form === 'block' ? {} : { family: type.glyph, markCode: type.code };
  }
  const code = ISO_FIXTURE_TO_MACHINE_CODE[catalogId];
  return code ? { code } : {};
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
