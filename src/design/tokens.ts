/**
 * Design tokens — single source of truth for colours, fonts, radii, shadows.
 * Plain objects so they read clearly in inline styles, typed `as const` so
 * TypeScript catches typos at the call site.
 *
 * These are now genuinely constant. The old "vibe" system (industrial /
 * workshop / arcade) mutated SW_COLORS, SW_FONTS and SW_RADIUS in place at
 * runtime, which is why callers were forbidden from hoisting token reads into
 * module-level consts. That system is gone, so the values below are the values
 * the app renders with — no runtime rewriting, no stale-capture hazard.
 */
import type { CSSProperties } from 'react';

export const SW_COLORS = {
  // Surface — "Control Room": a dark instrument ground. `paper` is the ground
  // and `ink` the near-white foreground, so the two anchors swap job versus
  // the old light system. Five surface values, each a real step apart (the old
  // paper === paperDeep made every ghost/secondary hover invisible).
  ink: '#E8EDF5',
  paper: '#0B0F16',
  paperDeep: '#131924',
  paperEdge: '#1E2634',
  steel: '#161D29',
  steelLite: '#212B3A',
  /** Deepest ground — the canvas stage and segmented-control wells sit a full
   *  step below `paper` so floating panels read as glass above the floor. */
  void: '#07090E',

  // Brand — the one colour that means "act on this", lifted for legibility on
  // a dark ground. brandLite inverts from a pale tint to a dark tinted well.
  brand: '#FF6B35',
  brandDeep: '#E04E18',
  brandLite: '#2A1710',
  /** Hairline for brand-tinted chips/wells — brand at 1/3 alpha, so the edge
   *  reads orange without competing with a solid brand fill. */
  brandEdge: '#FF6B3555',
  /** Brand-tinted *text* on dark wells. Solid `brand` at 12–13px on
   *  `brandLite` sits below 4.5:1; this lifted tint is the readable form. */
  brandText: '#FF9E77',

  // Data palette — named after garment-factory artefacts so they're memorable.
  // Generated, not picked: oklch(0.74 0.145 H) with H stepping 36° from 170 to
  // 350. Constant lightness and chroma means no hue shouts louder than another
  // as adjacent solid fills, and confining the arc to the cool half makes
  // collision with the green/amber/red status ramp structurally impossible.
  thread: '#20C3AC', // H170 · QC, inspection
  fabric: '#12B4DC', // H206 · cutting, spreading
  bobbin: '#5AA2F0', // H242 · sewing floor, overlock
  press: '#8E93F2', // H278 · finishing, pressing
  trim: '#C685E4', // H314 · storage, materials
  ship: '#F27FA8', // H350 · outbound, dispatch

  // Status — the utilisation ramp. Warm on purpose: the data palette is cool,
  // so status can never be mistaken for a department.
  ok: '#2BD07E', // util < 60% · flowing
  warn: '#FFB223', // 60–85% · warming
  alarm: '#FF4D55', // >= 85% · choked
  // Pressed/hover shades of ok/alarm — mirrors brandDeep so Button hover
  // states retheme with vibes instead of hardcoding.
  okDeep: '#1FA862',
  alarmDeep: '#D63B44',
  /** Dark red-tinted well — the ground for bottleneck callouts, error chips
   *  and "what to fix" advice cards. A surface, never a text colour. */
  alarmWell: '#1C1114',

  // UI grays — alpha on `ink`.
  line: '#E8EDF566',
  muted: '#E8EDF599',
  faint: '#E8EDF54F',
  /** Hairline for gridlines and disabled ticks — never text. */
  lineSoft: '#E8EDF52E',
  /** Canvas grid, cell tier — the dominant ruling on every canvas. Far
   *  fainter than `lineSoft`: a floor grid is a ruler you consult, not a
   *  structure you read, and at 40px pitch it covers the whole viewport. */
  gridLine: '#E8EDF512',
  /** Canvas grid, sub-cell tier. Drawn under the cell tier so cell
   *  boundaries stay visually dominant as the grid subdivides on zoom. */
  gridLineSub: '#E8EDF508',
  /** Canvas grid, axis tier — the `x = 0` and `y = 0` rules. Several steps
   *  up from `gridLine` because these two lines are the only ones the user
   *  has to be able to pick out of the lattice: they are what the
   *  Inspector's "Position (cells)" numbers are measured from. */
  gridAxis: '#E8EDF54F',
  /** Cell-coordinate tick labels along the axes, and the origin marker. */
  gridAxisText: '#E8EDF599',
  /**
   * Modal/dialog backdrop. NOT ink-alpha: on a dark ground `ink` is the light
   * end, so an ink-alpha scrim would paint a white wash over the app instead
   * of dimming it. Derived from the ground.
   */
  overlay: '#04070CB8',
} as const;

/**
 * Accent + well per PML block category — the colour vocabulary of the PROCESS
 * canvas, the BLOCKS palette and the Inspector's block chip.
 *
 * Lives here rather than in `pages/Builder.tsx` because three surfaces render
 * it and a fourth (`domain/iso.ts`, the ISO floor's `pml_*` fixtures) used to
 * carry a hand-copied duplicate that had silently drifted on five of six
 * categories while its comment still claimed parity. One table, no drift.
 *
 * Typed `Record<string, …>` rather than `Record<PmlCategory, …>` on purpose:
 * `domain` imports from `design`, not the reverse, and a type import back the
 * other way would invert that. Callers coalesce a miss to a neutral surface.
 */
export const PML_CATEGORY_TINT: Record<string, { fill: string; stroke: string }> = {
  lifecycle: { fill: 'rgba(242,193,46,0.14)', stroke: '#F2C12E' },
  buffer:    { fill: 'rgba(61,110,229,0.14)', stroke: '#3D6EE5' },
  service:   { fill: 'rgba(230,57,70,0.14)',  stroke: '#E63946' },
  routing:   { fill: 'rgba(31,179,107,0.14)', stroke: '#1FB36B' },
  batch:     { fill: 'rgba(126,91,239,0.14)', stroke: '#7E5BEF' },
  movement:  { fill: 'rgba(200,145,94,0.14)', stroke: '#C8915E' },
};

/**
 * Saira is a technical grotesk with a real weight axis, so the display slot
 * finally gets a working 700 instead of asking Archivo Black for a 900 it does
 * not ship. Plex Sans and Plex Mono were designed as one system, which is what
 * a load-bearing mono slot needs.
 */
export const SW_FONTS = {
  display: '"Saira", "Inter", system-ui, sans-serif',
  body: '"IBM Plex Sans", "Inter", system-ui, sans-serif',
  mono: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
} as const;

/**
 * Corner radii. These are the values the app has actually been rendering:
 * `applyVibe` overwrote SW_RADIUS on every boot with 6/10/14/22, so a later
 * tightening of this object to 4/8/12/18 never took effect. Now that the vibe
 * system is gone the declaration is the truth, so it carries the live numbers
 * — deleting the mutation must not silently restyle every corner in the app.
 */
export const SW_RADIUS = { sm: 6, md: 10, lg: 14, xl: 22 } as const;

/**
 * Shadows barely read on a near-black ground, so separation is carried by a 1px
 * hairline plus a real surface-value step. Cards lift with a 1px white-3% top
 * inset rather than a blur; the heavier steps exist only to rank floating
 * things above each other.
 */
export const SW_SHADOWS = {
  card: 'inset 0 1px 0 rgba(255,255,255,0.03), 0 1px 2px rgba(0,0,0,0.40)',
  pop: '0 2px 8px rgba(0,0,0,0.50)',
  hi: '0 12px 32px rgba(0,0,0,0.65)',
  /** Floating popovers/tooltips anchored to content. */
  float: '0 6px 18px rgba(0,0,0,0.55)',
  /** Modal/dialog panels above a backdrop. */
  overlay: '0 24px 64px rgba(0,0,0,0.70)',
  /** HUD dropdown panels (select menus, pickers) and canvas panels. */
  hud: '0 8px 24px rgba(0,0,0,0.60)',
} as const;

/**
 * Spacing — base 4, with one sub-base step at 2 for hairline insets. Everything
 * else is a multiple of 4. Before this the app had no scale at all: 2/4/6/8/10/
 * 12/14/16/18/24/32 all appeared, chosen per call site by habit.
 */
export const SW_SPACE = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  huge: 48,
} as const;

/**
 * Control sizes — the metrics every small chrome control shares so a panel
 * header row reads as one system instead of three sizes stacked side by side.
 *
 * `height` is the row unit: a header chip (STN/BLK), a square icon button and
 * a segmented pill all measure this tall, so they sit level with each other.
 * `chevron` is the disclosure box — one size for every triangle in the app,
 * whether it opens a palette section, an inspector group or a legend.
 */
export const SW_CONTROL = {
  /** Header chip / pill / icon-button height. */
  height: 28,
  /** Square side of an icon-only button (« », +, −). Same as `height`. */
  icon: 28,
  /** Disclosure / caret glyph box — square, so rotation never nudges layout.
   *  Sized so the triangle is a comfortable click target and reads as a
   *  control rather than a punctuation mark next to its label. */
  chevron: 20,
} as const;

/**
 * Border widths. `accent` is the 3px left bar, and is reserved for status cards
 * and toasts — never a general-purpose edge.
 */
export const SW_BORDER = { hairline: 1, base: 1, thick: 2, accent: 3 } as const;

/**
 * Stacking order. Replaces an ad-hoc range that ran from 1 to 2147483646 —
 * anything floating must pick a layer from here so two overlays can never be
 * ambiguous about which wins.
 */
export const SW_Z = {
  base: 0,
  raised: 1,
  sticky: 10,
  canvasPanel: 20,
  dropdown: 100,
  drawer: 200,
  modal: 300,
  toast: 400,
  tooltip: 500,
  /**
   * Anything anchored to a control but rendered at the document root: the
   * HudSelect panel, first and so far only.
   *
   * Off the scale above on purpose. A portalled popover has to clear whatever
   * it was opened from, and `Dialog` paints its overlay at a legacy 10040 —
   * so a dropdown inside the station-type dialog would open behind the dialog
   * at any value the rest of this scale offers.
   */
  popover: 10050,
} as const;

/**
 * Motion — four durations, three curves. `standard` for state changes, `enter`
 * for things arriving, `exit` for things leaving (faster, so dismissal feels
 * immediate). Respect `prefers-reduced-motion` at the call site.
 */
export const SW_MOTION = {
  instant: 80, // hover, press, tooltip
  fast: 140, // view switch, modal exit
  base: 220, // panel, modal, toast enter
  slow: 360, // drawer, canvas fly-to
  standard: 'cubic-bezier(.2, 0, 0, 1)',
  enter: 'cubic-bezier(.05, .7, .1, 1)',
  exit: 'cubic-bezier(.3, 0, .8, .15)',
} as const;

export type SwColor = (typeof SW_COLORS)[keyof typeof SW_COLORS];

/**
 * Type scale — the app's system text styles. Spread into inline styles
 * (`{...SW_TYPE.caption, color: …}`) and override per-site where needed.
 *
 * Still getters, but now only for laziness, not correctness: SW_FONTS no
 * longer changes at runtime, so hoisting a `SW_TYPE.x` read is no longer a
 * stale-capture hazard.
 */
export const SW_TYPE = {
  /** Hero/stat numerals. */
  get display(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 };
  },
  /** Page titles, default stat value. */
  get displaySm(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 28, fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.05 };
  },
  /** Card headings, dialog titles (SectionHeader). */
  get title(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.15 };
  },
  /** Panel headers. Fills the 22 → 15 gap the old scale left open. */
  get subhead(): CSSProperties {
    return { fontFamily: SW_FONTS.display, fontSize: 17, fontWeight: 600, lineHeight: 1.25 };
  },
  /** Group headers inside panels. */
  get heading(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 15, fontWeight: 600, lineHeight: 1.3 };
  },
  /** Default prose, table cells. */
  get body(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 400, lineHeight: 1.45 };
  },
  /** Buttons, field labels. */
  get label(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 12, fontWeight: 500, letterSpacing: '0.005em', lineHeight: 1.35 };
  },
  /** Helper text. Floor raised from 11 to 12 — this is prose, so it must read. */
  get caption(): CSSProperties {
    return { fontFamily: SW_FONTS.body, fontSize: 12, fontWeight: 400, lineHeight: 1.4 };
  },
  /**
   * Every in-table number, so columns align. Tabular figures are the whole
   * point — a right-aligned proportional numeral column still looks ragged.
   */
  get numeric(): CSSProperties {
    return {
      fontFamily: SW_FONTS.mono,
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.2,
      fontVariantNumeric: 'tabular-nums',
    };
  },
  /** Op codes, HUD readouts. */
  get micro(): CSSProperties {
    return {
      fontFamily: SW_FONTS.mono,
      fontSize: 11,
      fontWeight: 500,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
    };
  },
  /** Uppercase mono kicker above titles, column headers (SectionHeader). */
  get kicker(): CSSProperties {
    return { fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', lineHeight: 1.1 };
  },
  /** Uppercase mono table/HUD column headers — the only 10px left in the scale. */
  get overline(): CSSProperties {
    return { fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 500, letterSpacing: '0.18em', textTransform: 'uppercase', lineHeight: 1.1 };
  },
} as const;
