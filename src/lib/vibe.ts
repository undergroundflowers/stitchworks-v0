/**
 * Vibe theming system — mutates design tokens at runtime.
 *
 * Ported from STITCHWORKS.html. `applyVibe` overwrites entries on
 * `SW_COLORS`, `SW_FONTS` and `SW_RADIUS` in-place, so any component that
 * reads them via inline style on its next render picks up the new theme.
 */

import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';

export const SW_TWEAK_DEFAULTS = {
  vibe: 'industrial',
  intensity: 60,
  avatars: 'dots',
};

export interface VibeDef {
  brand: string;
  brandDeep: string;
  brandLite: string;
  ink: string;
  paper: string;
  paperDeep: string;
  paperEdge: string;
  display: string;
  radiusMul: number;
  sat: number;
}

export const SW_VIBES: Record<'industrial' | 'workshop' | 'arcade', VibeDef> = {
  industrial: {
    brand: '#FF5B26', brandDeep: '#D43E0F', brandLite: '#FFE4D6',
    ink: '#0F1419', paper: '#FFFFFF', paperDeep: '#FFFFFF', paperEdge: '#E8E2D0',
    display: '"Archivo Black", "Inter", system-ui, sans-serif',
    radiusMul: 1, sat: 1,
  },
  workshop: {
    brand: '#7A4D2B', brandDeep: '#4F2F18', brandLite: '#EFE2D2',
    ink: '#2A1E12', paper: '#F6EEDB', paperDeep: '#E9DFC4', paperEdge: '#D6C9A6',
    display: '"Fraunces", "Georgia", serif',
    radiusMul: 2.2, sat: 0.78,
  },
  arcade: {
    brand: '#FF2D87', brandDeep: '#C8146A', brandLite: '#FFD6E8',
    ink: '#0B0826', paper: '#F4F2FF', paperDeep: '#E5E0FF', paperEdge: '#C9C0FF',
    display: '"Archivo Black", "Inter", system-ui, sans-serif',
    radiusMul: 0.6, sat: 1.3,
  },
};

export function applyVibe(vibeKey: keyof typeof SW_VIBES): void {
  const v = SW_VIBES[vibeKey] || SW_VIBES.industrial;
  Object.assign(SW_COLORS, {
    brand: v.brand, brandDeep: v.brandDeep, brandLite: v.brandLite,
    ink: v.ink, paper: v.paper, paperDeep: v.paperDeep, paperEdge: v.paperEdge,
    // UI grays are ink-alpha; recompute them from the vibe's ink so they
    // retheme along with it (hex8 concat keeps the token format stable).
    line: `${v.ink}30`, muted: `${v.ink}99`, faint: `${v.ink}50`, overlay: `${v.ink}73`,
  });
  (SW_FONTS as { display: string }).display = v.display;
  const radius = SW_RADIUS as { sm: number; md: number; lg: number; xl: number };
  radius.sm = Math.round(6 * v.radiusMul);
  radius.md = Math.round(10 * v.radiusMul);
  radius.lg = Math.round(14 * v.radiusMul);
  radius.xl = Math.round(22 * v.radiusMul);
  document.documentElement.style.setProperty('--sw-sat', String(v.sat));
  document.body.style.background = v.paperDeep;
}
