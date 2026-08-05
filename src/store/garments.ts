/**
 * Effective-garments hook + helpers — merges the built-in `GARMENT_TEMPLATES`
 * with per-project edits in `project.garmentEdits`. Pages should consume
 * this hook instead of importing the built-ins directly so user edits flow
 * through to every read site (Yamazumi, LiveSim, Twin, Reports, etc.).
 *
 * `garmentEdits` may also contain garments whose ids are NOT in the
 * built-in catalog — those are user-created from scratch and are appended
 * to the effective list.
 */

import { useMemo } from 'react';
import { GARMENT_TEMPLATES, ALL_GARMENT_TEMPLATES, type GarmentTemplate } from '../domain';
import { useProject } from './project';

export interface EffectiveGarments {
  all: GarmentTemplate[];
  byId: Record<string, GarmentTemplate>;
  /** Built-in ids the user removed from the picker. Still resolvable in
   *  `byId` so any lingering workstation reference doesn't crash. */
  hidden: string[];
  /** Whether the given garment is the unedited built-in. */
  isBuiltIn: (id: string) => boolean;
  /** Whether the user has edited this garment id. */
  hasEdit: (id: string) => boolean;
  /** Whether this id is currently hidden from the picker. */
  isHidden: (id: string) => boolean;
}

export function useGarments(): EffectiveGarments {
  const edits = useProject((s) => s.garmentEdits);
  const hidden = useProject((s) => s.hiddenGarmentIds);
  return useMemo(() => buildEffective(edits, hidden), [edits, hidden]);
}

/** Pure helper for non-React contexts (tests, sim model builder, etc.). */
export function effectiveGarments(
  edits: Record<string, GarmentTemplate>,
  hidden: Record<string, true> = {},
): EffectiveGarments {
  return buildEffective(edits, hidden);
}

function buildEffective(
  edits: Record<string, GarmentTemplate>,
  hidden: Record<string, true>,
): EffectiveGarments {
  const byId: Record<string, GarmentTemplate> = {};
  const all: GarmentTemplate[] = [];
  // Built-ins first; an edit with the same id replaces them entirely. Hidden
  // ids stay resolvable in `byId` but are kept out of `all` so the picker
  // (and every downstream listing) drops them.
  for (const g of ALL_GARMENT_TEMPLATES) {
    const eff = edits[g.id] ?? g;
    byId[g.id] = eff;
    if (!hidden[g.id]) all.push(eff);
  }
  // Custom garments (ids not in built-ins) tail the visible list.
  for (const id of Object.keys(edits)) {
    if (!GARMENT_TEMPLATES[id]) {
      byId[id] = edits[id];
      if (!hidden[id]) all.push(edits[id]);
    }
  }
  return {
    all,
    byId,
    hidden: Object.keys(hidden),
    isBuiltIn: (id) => !!GARMENT_TEMPLATES[id],
    hasEdit: (id) => !!edits[id],
    isHidden: (id) => !!hidden[id],
  };
}
