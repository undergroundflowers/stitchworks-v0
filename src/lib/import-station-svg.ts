/**
 * Read an uploaded `.svg` into the `StationArt` a station type stores.
 *
 * This is the trust boundary. An uploaded file is arbitrary markup from
 * outside the app, and what comes out of here is rendered with
 * `dangerouslySetInnerHTML` on every canvas that draws the station — so the
 * file is parsed, walked, and *rebuilt* from an allowlist rather than
 * pattern-matched. Anything not on the list (script, style, foreignObject,
 * image, SMIL animation, event handlers, external references) is dropped,
 * and `isSafeArtMarkup` re-checks the result before it is handed back.
 *
 * Two other things happen here that matter more than they look:
 *
 *   • **ids are namespaced.** Thirty stations of the same type render the
 *     same markup thirty times, and two different uploads both exported
 *     from Illustrator will both call their gradient `linearGradient-1`.
 *     Every id is prefixed per upload, and every `url(#…)` / `href="#…"`
 *     that points at one is rewritten to match.
 *   • **the viewBox is resolved.** SVG has no layout here, so `getBBox()`
 *     is unavailable; the user space comes from the root `viewBox`, or from
 *     `width`/`height` when the file has none.
 *
 * Lives in `lib/` rather than `domain/` because it needs a DOM to parse
 * with. The pure half — the type, the allowlist, the DOM-free re-check — is
 * `domain/station-art.ts`.
 */

import {
  ALLOWED_ART_TAGS,
  ART_TAG_CANONICAL,
  MAX_ART_FILE_BYTES,
  MAX_ART_MARKUP_CHARS,
  isAllowedArtAttribute,
  isSafeArtMarkup,
  type StationArt,
} from '../domain/station-art';

export type StationArtResult =
  | { ok: true; art: StationArt }
  | { ok: false; error: string };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ids are prefixed per upload so two files can both define `#shadow`. */
let artSeq = 0;
function nextIdPrefix(): string {
  artSeq += 1;
  return `sa${artSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}-`;
}

/** Leading number of an SVG length (`"120"`, `"120px"`, `"12cm"`). Units are
 *  ignored: the value is only ever used as an aspect ratio. */
function lengthOf(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function viewBoxOf(root: SVGSVGElement): [number, number, number, number] | null {
  const vb = root.getAttribute('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return [parts[0], parts[1], parts[2], parts[3]];
    }
  }
  const w = lengthOf(root.getAttribute('width'));
  const h = lengthOf(root.getAttribute('height'));
  return w > 0 && h > 0 ? [0, 0, w, h] : null;
}

/** Elements that actually put ink on the canvas. `defs`, `title` and friends
 *  are kept but do not count as artwork, so a file of nothing but metadata
 *  is reported empty instead of saved as an invisible station. */
const DRAWABLE_TAGS: ReadonlySet<string> = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use',
]);

/**
 * Rebuild `node`'s child nodes into `into`, keeping only allowlisted elements
 * and attributes. Children are walked in document order so mixed content
 * (`<text>Hello<tspan>…</tspan></text>`) keeps its sequence. Returns how many
 * drawable elements survived.
 */
function copyAllowed(node: Element, into: Element, doc: Document, idPrefix: string): number {
  let kept = 0;
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const child_ = child as Element;
    const tag = child_.tagName.toLowerCase().replace(/^svg:/, '');
    if (!ALLOWED_ART_TAGS.has(tag)) continue;
    // Rebuilt in the SVG namespace under our own lower-cased tag name, so a
    // namespace-confused or oddly-cased node cannot survive by spelling.
    const el = doc.createElementNS(SVG_NS, ART_TAG_CANONICAL[tag] ?? tag);
    for (const attr of Array.from(child_.attributes)) {
      if (!isAllowedArtAttribute(attr.name, attr.value)) continue;
      let value = attr.value;
      if (attr.name.toLowerCase() === 'id') value = idPrefix + value;
      else if (value.includes('url(#')) value = value.replaceAll('url(#', `url(#${idPrefix}`);
      else if (attr.name.toLowerCase().endsWith('href') && value.startsWith('#')) {
        value = `#${idPrefix}${value.slice(1)}`;
      }
      // `xlink:href` is the SVG 1.1 spelling and needs its namespace to
      // resolve; every browser the app targets reads plain `href`, so the
      // deprecated form is folded into it rather than carried along.
      el.setAttribute(attr.name.toLowerCase() === 'xlink:href' ? 'href' : attr.name, value);
    }
    if (DRAWABLE_TAGS.has(tag)) kept += 1;
    kept += copyAllowed(child_, el, doc, idPrefix);
    into.appendChild(el);
  }
  return kept;
}

/**
 * Sanitize SVG source into `StationArt`. Exported separately from the file
 * reader so it can be tested without a `File`.
 */
export function sanitizeStationArt(source: string, name: string): StationArtResult {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return { ok: false, error: 'Not a readable SVG file.' };
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') {
    return { ok: false, error: 'File is not an SVG (no <svg> root).' };
  }

  const viewBox = viewBoxOf(root as unknown as SVGSVGElement);
  if (!viewBox) {
    return { ok: false, error: 'SVG needs a viewBox (or a width and height) so it can be scaled.' };
  }

  const out = doc.createElementNS(SVG_NS, 'g');
  const kept = copyAllowed(root, out, doc, nextIdPrefix());
  if (kept === 0) return { ok: false, error: 'Nothing drawable left after sanitizing — no shapes or paths.' };

  const svg = out.innerHTML;
  if (svg.length > MAX_ART_MARKUP_CHARS) {
    return { ok: false, error: `Artwork is too detailed (${Math.round(svg.length / 1024)} KB of markup, max ${MAX_ART_MARKUP_CHARS / 1024} KB).` };
  }
  // The DOM-free check every load path runs. If the walk above ever produces
  // markup it rejects, the bug surfaces here rather than in the store.
  if (!isSafeArtMarkup(svg)) return { ok: false, error: 'SVG contains markup that cannot be rendered safely.' };

  return { ok: true, art: { name: name.slice(0, 80), svg, viewBox } };
}

/** Read a user-picked file into sanitized artwork. */
export async function readStationArtFile(file: File): Promise<StationArtResult> {
  if (file.size > MAX_ART_FILE_BYTES) {
    return {
      ok: false,
      error: `File is ${Math.round(file.size / 1024)} KB — the limit is ${MAX_ART_FILE_BYTES / 1024} KB.`,
    };
  }
  if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
    return { ok: false, error: 'Only .svg files can be used as station artwork.' };
  }
  let source: string;
  try {
    source = await file.text();
  } catch {
    return { ok: false, error: 'Could not read the file.' };
  }
  return sanitizeStationArt(source, file.name);
}
