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
  /**
   * Modal/dialog backdrop, supplied per vibe rather than derived.
   *
   * The UI grays below ARE ink-alpha and recompute correctly for any vibe, but
   * the scrim cannot: it has to be a darkening of the ground, and on a dark
   * vibe `ink` is the LIGHT end. Deriving it from ink would paint a white wash
   * over the app instead of dimming it.
   */
  overlay: string;
  display: string;
  radiusMul: number;
  sat: number;
}

export const SW_VIBES: Record<'industrial' | 'workshop' | 'arcade', VibeDef> = {
  // "Control Room" — the dark instrument ground. See SW_COLORS for the reasoning
  // behind each value; these must stay in sync with the tokens' defaults, since
  // App.tsx calls applyVibe on boot and would otherwise overwrite them.
  industrial: {
    brand: '#FF6B35', brandDeep: '#E04E18', brandLite: '#2A1710',
    ink: '#E8EDF5', paper: '#0B0F16', paperDeep: '#131924', paperEdge: '#1E2634',
    overlay: '#04070CB8',
    display: '"Saira", "Inter", system-ui, sans-serif',
    radiusMul: 1, sat: 1,
  },
  workshop: {
    brand: '#7A4D2B', brandDeep: '#4F2F18', brandLite: '#EFE2D2',
    ink: '#2A1E12', paper: '#F6EEDB', paperDeep: '#E9DFC4', paperEdge: '#D6C9A6',
    overlay: '#2A1E1273',
    display: '"Fraunces", "Georgia", serif',
    radiusMul: 2.2, sat: 0.78,
  },
  arcade: {
    brand: '#FF2D87', brandDeep: '#C8146A', brandLite: '#FFD6E8',
    ink: '#0B0826', paper: '#F4F2FF', paperDeep: '#E5E0FF', paperEdge: '#C9C0FF',
    overlay: '#0B082673',
    display: '"Saira", "Inter", system-ui, sans-serif',
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
    line: `${v.ink}66`, muted: `${v.ink}99`, faint: `${v.ink}4F`, lineSoft: `${v.ink}2E`,
    // NOT ink-alpha — see VibeDef.overlay.
    overlay: v.overlay,
  });
  (SW_FONTS as { display: string }).display = v.display;
  const radius = SW_RADIUS as { sm: number; md: number; lg: number; xl: number };
  radius.sm = Math.round(6 * v.radiusMul);
  radius.md = Math.round(10 * v.radiusMul);
  radius.lg = Math.round(14 * v.radiusMul);
  radius.xl = Math.round(22 * v.radiusMul);
  document.documentElement.style.setProperty('--sw-sat', String(v.sat));
  // Publish the handful of tokens that global CSS needs (the focus ring and the
  // scrollbars in index.css) — those rules cannot reach into the JS tokens.
  const root = document.documentElement.style;
  root.setProperty('--sw-ink', v.ink);
  root.setProperty('--sw-paper', v.paper);
  root.setProperty('--sw-brand', v.brand);
  root.setProperty('--sw-line', `${v.ink}66`);
  root.setProperty('--sw-muted', `${v.ink}99`);
  document.body.style.background = v.paper;
}
