/**
 * One camera for every canvas in the app.
 *
 * Stitchworks has three pan/zoom surfaces — the Build floor (2D · ISO), the
 * Build PROCESS graph, and the Run simulation floor (ISO · TOP · HEAT ·
 * LOGIC · PML). They were written at different times and each grew its own
 * wheel handler, its own zoom clamp, its own step size and its own idea of
 * what "reset" means. The result was that the same gesture did three
 * different things depending on which tab you were in.
 *
 * This module is the single source of truth for how a camera responds. It is
 * deliberately pure — no React, no element refs — so the two very different
 * host implementations can share it:
 *
 *   - the SVG canvases pan/zoom an inner `<g transform>` inside a **centred**
 *     viewBox, so their offset origin is the stage centre;
 *   - the simulation viewport sizes a wrapper div (percentage width/height,
 *     which keeps child SVGs vector-sharp instead of rasterising them at 1×)
 *     from its **top-left**.
 *
 * Both are just an offset space with a scale, so the same maths drives both.
 * Callers only differ in which point they call the origin.
 */

/** Pan in screen px plus a scale factor. `x`/`y` are offsets from the host's
 *  origin, so they are directly comparable to mouse deltas at any zoom. */
export interface Cam {
  x: number;
  y: number;
  z: number;
}

export interface CamBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const CAM_IDENTITY: Cam = { x: 0, y: 0, z: 1 };

/**
 * Zoom range, shared by every canvas.
 *
 * The floor used to stop at 3× and the simulation at 6×, which is why the
 * same pinch ran out of travel in one tab and not the other. The floor is
 * 0.2 rather than the old 0.3 because fitting a 30-station line on the
 * PROCESS canvas already hit the 0.3 clamp — a floor you bump into while
 * framing your own content is too high.
 */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 6;

/** One HUD click, one press of `+` / `−`. */
export const ZOOM_STEP = 1.2;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * What a wheel event means.
 *
 * A trackpad reports pinch as a ctrl-modified wheel and a two-finger swipe as
 * a plain one; a mouse wheel reports line-mode deltas, or large discrete
 * vertical steps with no horizontal component. So: pinch and mouse wheel
 * zoom, a swipe pans. The swipe branch is not optional — none of these
 * surfaces has native scrollbars any more, so it is the only way to
 * trackpad-pan.
 *
 * Pinch gets a much stronger constant than the wheel because the two report
 * deltas on completely different scales; matching them is what makes a pinch
 * feel like it is tracking your fingers.
 */
export type WheelGesture =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number };

export function wheelGesture(ev: WheelEvent): WheelGesture {
  const isPinch = ev.ctrlKey || ev.metaKey;
  const isMouseWheel =
    ev.deltaMode !== 0 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50);
  if (isPinch || isMouseWheel) {
    const k = ev.ctrlKey ? 0.012 : 0.0015;
    return { kind: 'zoom', factor: Math.exp(-ev.deltaY * k) };
  }
  return { kind: 'pan', dx: ev.deltaX, dy: ev.deltaY };
}

/**
 * Scale about a point, keeping whatever is under that point pinned there.
 *
 * `dx`/`dy` are measured from the camera's origin — the stage centre for the
 * SVG canvases, the top-left corner for the simulation viewport. Passing
 * (0, 0) therefore zooms about the origin, which is what the HUD buttons and
 * the `+` / `−` keys want on a centred canvas.
 */
export function zoomAtOffset(cam: Cam, dx: number, dy: number, factor: number): Cam {
  const z = clampZoom(cam.z * factor);
  if (z === cam.z) return cam;
  return {
    x: dx - ((dx - cam.x) / cam.z) * z,
    y: dy - ((dy - cam.y) / cam.z) * z,
    z,
  };
}

/** Pan by a screen-space delta. Independent of zoom: `x`/`y` are screen px. */
export function panBy(cam: Cam, dx: number, dy: number): Cam {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

/**
 * Frame `bounds` in a stage of `w × h`, for a camera whose origin is the
 * stage centre. This is what ⌘0 and the ⛶ button mean everywhere: *show me
 * everything*, not *go back to 100%*.
 *
 * Never zooms past 1× — blowing a two-station line up to 6× because it
 * happens to fit is disorienting, not helpful.
 */
export function fitBounds(
  bounds: CamBounds,
  stage: { w: number; h: number },
  pad = 40,
): Cam {
  const bw = bounds.maxX - bounds.minX + pad * 2;
  const bh = bounds.maxY - bounds.minY + pad * 2;
  if (bw <= 0 || bh <= 0 || stage.w <= 0 || stage.h <= 0) return CAM_IDENTITY;
  const z = clampZoom(Math.min(stage.w / bw, stage.h / bh, 1));
  return {
    x: -((bounds.minX + bounds.maxX) / 2) * z,
    y: -((bounds.minY + bounds.maxY) / 2) * z,
    z,
  };
}
