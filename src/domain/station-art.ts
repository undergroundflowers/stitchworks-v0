/**
 * Uploaded SVG artwork for a station type.
 *
 * A station type draws itself from a closed vocabulary — form + mark +
 * footprint — because the canvas is SVG and the 2D↔ISO morph interpolates
 * geometry. Uploaded artwork fits that constraint only because it is *also*
 * SVG: vector markup drops straight into the same `<g>` the built-in marks
 * and cuboids are drawn into, scales with the camera, and prints sharp.
 *
 * Two independent slots, because the two views answer different questions:
 *
 *   `planArt` → replaces the stroke mark inside the 2D plan footprint
 *   `isoArt`  → replaces the whole cuboid body in the isometric view
 *
 * Either can be absent, and an absent slot falls back to the authored
 * Form / Mark exactly as before.
 *
 * ── On trust ────────────────────────────────────────────────────────────
 * The markup here is rendered with `dangerouslySetInnerHTML`, so it is
 * sanitized at the boundary it enters through (`lib/import-station-svg.ts`,
 * which has a DOM to parse with). This module holds the *second* line: a
 * DOM-free re-check that `normalizeStationType` runs on every load, so
 * artwork arriving from a hand-edited `.swproj` or an older payload is
 * dropped rather than trusted. It rejects; it never repairs — anything our
 * own sanitizer produced passes untouched, and anything else is not worth
 * guessing about.
 *
 * Pure data + pure logic: no DOM, no React. See `iso.ts` for the draw side.
 */

/** Sanitized artwork: the *inner* markup of the uploaded `<svg>`, plus the
 *  user space it was drawn in so callers can fit it to a box. */
export interface StationArt {
  /** Original filename, shown in the authoring dialog. */
  name: string;
  /** Sanitized inner SVG markup — no root `<svg>` element. */
  svg: string;
  /** The source `viewBox`, as `[minX, minY, width, height]`. */
  viewBox: [number, number, number, number];
}

/** Largest file accepted at upload. A machine drawing exported from CAD runs
 *  tens of KB; anything past this is a map, and it would ride along in every
 *  project export. */
export const MAX_ART_FILE_BYTES = 512 * 1024;

/** Largest sanitized markup kept. Lower than the file cap because sanitizing
 *  strips metadata, and because this is what lands in the store. */
export const MAX_ART_MARKUP_CHARS = 256 * 1024;

/**
 * Elements allowed to survive sanitizing.
 *
 * Shapes, structure, paint servers and text — everything needed to draw.
 * Absent by design: `script` and `style` (code), `foreignObject` (arbitrary
 * HTML), `image` (loads an external file from the user's floor), and the
 * SMIL animation elements, which can retarget an attribute at runtime and
 * so route around an attribute allowlist.
 */
export const ALLOWED_ART_TAGS: ReadonlySet<string> = new Set([
  'g', 'defs', 'symbol', 'use', 'title', 'desc', 'marker',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
]);

/**
 * Canonical SVG spelling for the tags whose names are camel-cased.
 *
 * Matching is done in lower case, but SVG element names are case-sensitive:
 * a `<lineargradient>` is an unknown element that paints nothing. The
 * sanitizer rebuilds each node under the spelling given here.
 */
export const ART_TAG_CANONICAL: Readonly<Record<string, string>> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
};

/** Attribute names that are dropped whatever their value: event handlers. */
const EVENT_ATTR = /^on/i;

/** `<tag` openers in a markup string. */
const TAG_OPENER = /<\s*([a-zA-Z][\w:.-]*)/g;
/** ` onclick=`, ` on-anything =` — the whitespace is what a parser allows. */
const EVENT_ATTR_ANYWHERE = /\son[a-zA-Z-]+\s*=/;
/** Every href/xlink:href in a markup string, quoted or bare. */
const HREF_ATTR = /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
/** Every complete `url(...)` reference, with its argument captured. */
const URL_REF = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi;
/** `url(` openers, counted so a truncated reference can't slip past. */
const URL_OPENER = /url\(/gi;

/**
 * True when every `url(...)` in `value` points inside the document.
 *
 * Each reference is extracted and its argument tested, rather than pattern-
 * matching the opener: quoting and whitespace are both legal (`url(#grad)`,
 * `url("#grad")`, `url( #grad )`), and a lookahead written against the
 * opener backtracks over them and misreads the safe forms as external.
 */
export function hasOnlyLocalUrlRefs(value: string): boolean {
  URL_OPENER.lastIndex = 0;
  const openers = value.match(URL_OPENER)?.length ?? 0;
  if (openers === 0) return true;
  URL_REF.lastIndex = 0;
  let seen = 0;
  for (let m = URL_REF.exec(value); m; m = URL_REF.exec(value)) {
    seen += 1;
    const arg = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!arg.startsWith('#')) return false;
  }
  // An unterminated `url(` is not a working reference, but it is also not
  // something our sanitizer emits — treat it as unparseable and reject.
  return seen === openers;
}

/** True when an attribute is safe to keep on sanitized artwork. Shared by
 *  the DOM sanitizer and the tests, so the two cannot drift. */
export function isAllowedArtAttribute(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (EVENT_ATTR.test(n)) return false;
  // Host CSS must not reach into uploaded art, and uploaded art must not
  // reach out of the document for anything.
  if (n === 'class') return false;
  if (n === 'href' || n === 'xlink:href') return value.trim().startsWith('#');
  if (!hasOnlyLocalUrlRefs(value)) return false;
  return true;
}

/**
 * True when `svg` is markup our sanitizer could have produced.
 *
 * Deliberately a rejection test rather than a repair: every element opener
 * must be in the allowlist, and no event handler, external reference or
 * external `url()` may appear anywhere. Artwork that fails is dropped whole
 * by `normalizeStationArt`.
 */
export function isSafeArtMarkup(svg: string): boolean {
  if (svg.length > MAX_ART_MARKUP_CHARS) return false;
  if (EVENT_ATTR_ANYWHERE.test(svg)) return false;
  if (!hasOnlyLocalUrlRefs(svg)) return false;
  HREF_ATTR.lastIndex = 0;
  for (let m = HREF_ATTR.exec(svg); m; m = HREF_ATTR.exec(svg)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (!value.trim().startsWith('#')) return false;
  }
  TAG_OPENER.lastIndex = 0;
  for (let m = TAG_OPENER.exec(svg); m; m = TAG_OPENER.exec(svg)) {
    if (!ALLOWED_ART_TAGS.has(m[1].toLowerCase())) return false;
  }
  return true;
}

/**
 * Validate artwork read back from storage. Returns the art unchanged, or
 * undefined when it is missing, malformed or fails `isSafeArtMarkup` — the
 * station then falls back to its authored Form / Mark, which is a visible
 * but harmless outcome.
 */
export function normalizeStationArt(art: unknown): StationArt | undefined {
  if (!art || typeof art !== 'object') return undefined;
  const a = art as Partial<StationArt>;
  if (typeof a.svg !== 'string' || !a.svg.trim()) return undefined;
  if (!Array.isArray(a.viewBox) || a.viewBox.length !== 4) return undefined;
  const vb = a.viewBox.map(Number);
  if (!vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) return undefined;
  if (!isSafeArtMarkup(a.svg)) return undefined;
  return {
    name: typeof a.name === 'string' ? a.name.slice(0, 80) : 'artwork.svg',
    svg: a.svg,
    viewBox: [vb[0], vb[1], vb[2], vb[3]],
  };
}
