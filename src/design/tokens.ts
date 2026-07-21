/**
 * Design tokens — single source of truth for colours, fonts, radii, shadows.
 * Ported from STITCHWORKS.html. Keep these as plain objects so they're easy
 * to read in inline styles; they're typed via `as const` so TypeScript catches
 * typos at the call site.
 */
import type { CSSProperties } from 'react';

export const SW_COLORS = {
  // Surface
  ink: '#0F1419',
  paper: '#FFFFFF',
  paperDeep: '#FFFFFF',
  paperEdge: '#E8E2D0',
  steel: '#2A3340',
  steelLite: '#3D4856',

  // Brand
  brand: '#FF5B26',
  brandDeep: '#D43E0F',
  brandLite: '#FFE4D6',

  // Data palette — named after garment-factory artefacts so they're memorable
  thread: '#FFB800',
  fabric: '#2BA88B',
  bobbin: '#4F7CFF',
  press: '#C73E5F',
  trim: '#8B5CF6',
  ship: '#0EA5A4',

  // Status
  ok: '#1FB36B',
  warn: '#F5A623',
  alarm: '#E74C3C',
  // Pressed/hover shades of ok/alarm — mirrors brandDeep so Button hover
  // states retheme with vibes instead of hardcoding.
  okDeep: '#199A5C',
  alarmDeep: '#C0392B',

  // UI grays (alpha on ink) — recomputed from the vibe's ink by applyVibe
  line: '#0F141930',
  muted: '#0F141999',
  faint: '#0F141950',
  /** Modal/dialog backdrop (ink @ 45%). */
  overlay: '#0F141973',
} as const;

export const SW_FONTS = {
  display: '"Archivo Black", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
} as const;

export const SW_RADIUS = { sm: 6, md: 10, lg: 14, xl: 22 } as const;

export const SW_SHADOWS = {
  card: '0 1px 0 rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)',
  pop: '0 4px 14px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)',
  hi: '0 12px 40px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.08)',
  /** Floating popovers/tooltips anchored to content. */
  float: '0 8px 24px rgba(0,0,0,0.12)',
  /** Modal/dialog panels above a backdrop. */
  overlay: '0 18px 50px rgba(0,0,0,0.25)',
  /** HUD dropdown panels (select menus, pickers). */
  hud: '0 12px 32px rgba(15,20,25,0.18), 0 2px 6px rgba(15,20,25,0.1)',
} as const;

export type SwColor = (typeof SW_COLORS)[keyof typeof SW_COLORS];

/**
 * Type scale — the app's system text styles. Spread into inline styles
 * (`{...SW_TYPE.caption, color: …}`) and override per-site where needed.
 *
 * Defined as getters so every access reads the CURRENT SW_FONTS — the vibe
 * system swaps the display font at runtime. NEVER hoist `SW_TYPE.x` into a
 * module-level const; that freezes the pre-vibe font (the same stale-capture
 * bug Button's VARIANTS had).
 */
export const SW_TYPE = {
  /** Hero/stat numerals. */
  get display(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 32, fontWeight: 900, letterSpacing: '-0.02em' };
  },
  /** Default stat value. */
  get displaySm(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 24, fontWeight: 900, letterSpacing: '-0.02em' };
  },
  /** Page/section title (SectionHeader). */
  get title(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 22, fontWeight: 900, letterSpacing: '-0.01em', lineHeight: 1.1 };
  },
  /** Card/panel heading. */
  get heading(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 14, fontWeight: 900 };
  },
  /** Default prose. */
  get body(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 500 };
  },
  /** Buttons, form labels. */
  get label(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 12, fontWeight: 600 };
  },
  /** Secondary metadata. */
  get caption(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 11, fontWeight: 600 };
  },
  /** Dense metadata, rail labels. */
  get micro(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 10, fontWeight: 600 };
  },
  /** Uppercase mono kicker above titles (SectionHeader). */
  get kicker(): CSSProperties {
    return { fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase' };
  },
  /** Uppercase mono table/HUD column headers. */
  get overline(): CSSProperties {
    return { fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' };
  },
} as const;
