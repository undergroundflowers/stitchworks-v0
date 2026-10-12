import { useCallback, useEffect, useRef, useState } from 'react';
import { ZOOM_STEP, wheelGesture, zoomAtOffset, type Cam } from '../domain/camera';

/**
 * Wires one canvas element up to the shared camera vocabulary.
 *
 * Every pan/zoom surface in the app installs this, so the same gesture does
 * the same thing in Build and in Run:
 *
 *   wheel / pinch       zoom toward the cursor
 *   two-finger swipe    pan
 *   space + drag        pan, from anywhere including on top of content
 *   middle-drag         pan
 *   `+` / `−`           zoom about the centre, one `ZOOM_STEP`
 *   ⌘0 / Ctrl-0         frame everything (`fit`)
 *
 * What it deliberately does **not** own is the plain left-drag on the
 * background. That gesture is host-specific — on the Build floor the SELECT
 * tool marquees with it, on the PROCESS canvas and the simulation floor it
 * pans — so hosts call `beginPan` themselves once they have decided the drag
 * is theirs. The panning maths still lives here, so the drag tracks 1:1 in
 * every view.
 *
 * `read` must be backed by a ref rather than state: wheel events arrive
 * faster than React re-renders, and a stale closure would make a fast pinch
 * lose most of its travel.
 */
export interface CanvasCameraApi {
  /** SPACE is held — hosts use this to switch the cursor to a grab hand. */
  spacePan: boolean;
  /** A pan drag is in flight. */
  panning: boolean;
  /** Start a pan from a screen point. Hosts call this from their own
   *  background-drag handler once they have ruled out marquee / placement. */
  beginPan: (clientX: number, clientY: number) => void;
  /** Zoom about the stage centre — the HUD buttons and the `+` / `−` keys. */
  zoomStep: (factor: number) => void;
}

interface UseCanvasCameraOpts {
  /** The gesture surface. Wheel and middle/space mousedown bind here. */
  ref: React.RefObject<HTMLElement | null>;
  /**
   * Where the camera's zero sits inside the element. Every canvas in the app
   * renders through a centred viewBox today, so they all pass `'center'`;
   * `'topLeft'` stays available for a host that grows a wrapper from its
   * corner instead.
   */
  origin: 'center' | 'topLeft';
  /** Live camera. Must read a ref — see the note above. */
  read: () => Cam;
  /** Apply an update. Hosts that keep pan and zoom in separate state must
   *  still apply this atomically (see Builder's `writeFloorCam`). */
  write: (update: (c: Cam) => Cam) => void;
  /** ⌘0 and the ⛶ button — frame all content. */
  fit: () => void;
  /** Off while something else owns the surface (a modal, a different tab). */
  enabled?: boolean;
}

function inTextField(target: EventTarget | null): boolean {
  const el = target as Element | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el?.closest?.('[contenteditable="true"]'));
}

/** SPACE activates whatever control has focus. Swallowing it there would
 *  break keyboard operation of the toolbar for a pan the user did not ask
 *  for, so space-pan yields to a focused control. */
function onFocusedControl(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return Boolean(el?.closest?.('button, a, [role="button"], [role="tab"], summary'));
}

export function useCanvasCamera({
  ref,
  origin,
  read,
  write,
  fit,
  enabled = true,
}: UseCanvasCameraOpts): CanvasCameraApi {
  const [spacePan, setSpacePan] = useState(false);
  const [panning, setPanning] = useState(false);

  // Everything below runs from native listeners bound once, so each moving
  // part gets a ref. Rebinding a non-passive wheel listener on every camera
  // change would drop events mid-gesture.
  const readRef = useRef(read);
  readRef.current = read;
  const writeRef = useRef(write);
  writeRef.current = write;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const originRef = useRef(origin);
  originRef.current = origin;
  const spacePanRef = useRef(false);
  spacePanRef.current = spacePan;

  /** Screen point → offset from the camera's origin. */
  const offsetOf = useCallback(
    (clientX: number, clientY: number) => {
      const el = ref.current;
      if (!el) return { dx: 0, dy: 0 };
      const r = el.getBoundingClientRect();
      if (originRef.current === 'center') {
        return { dx: clientX - r.left - r.width / 2, dy: clientY - r.top - r.height / 2 };
      }
      return { dx: clientX - r.left, dy: clientY - r.top };
    },
    [ref],
  );

  /** Offset of the element's centre — where a centre-anchored zoom aims. */
  const centreOffset = useCallback(() => {
    if (originRef.current === 'center') return { dx: 0, dy: 0 };
    const r = ref.current?.getBoundingClientRect();
    return { dx: (r?.width ?? 0) / 2, dy: (r?.height ?? 0) / 2 };
  }, [ref]);

  const zoomStep = useCallback(
    (factor: number) => {
      const { dx, dy } = centreOffset();
      writeRef.current((c) => zoomAtOffset(c, dx, dy, factor));
    },
    [centreOffset],
  );

  const beginPan = useCallback((startX: number, startY: number) => {
    const from = readRef.current();
    setPanning(true);
    function move(ev: MouseEvent) {
      writeRef.current((c) => ({
        ...c,
        x: from.x + (ev.clientX - startX),
        y: from.y + (ev.clientY - startY),
      }));
    }
    function up() {
      setPanning(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  // Wheel. React's root wheel listener is passive, so this has to be native
  // and non-passive to preventDefault and stop the page scrolling underneath.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onWheel(ev: WheelEvent) {
      if (!enabledRef.current) return;
      ev.preventDefault();
      const g = wheelGesture(ev);
      if (g.kind === 'zoom') {
        const { dx, dy } = offsetOf(ev.clientX, ev.clientY);
        writeRef.current((c) => zoomAtOffset(c, dx, dy, g.factor));
        return;
      }
      // Screen-space pan, so the content tracks the fingers 1:1 at any zoom.
      writeRef.current((c) => ({ ...c, x: c.x - g.dx, y: c.y - g.dy }));
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, offsetOf]);

  // Space-held or middle-button pan. Capture phase so it beats entity drag
  // handlers — space-drag has to work on top of a station, not just around it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onDownCapture(ev: MouseEvent) {
      if (!enabledRef.current) return;
      if (!spacePanRef.current && ev.button !== 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      beginPan(ev.clientX, ev.clientY);
    }
    el.addEventListener('mousedown', onDownCapture, true);
    return () => el.removeEventListener('mousedown', onDownCapture, true);
  }, [ref, beginPan]);

  // Keys.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!enabledRef.current || inTextField(e.target)) return;
      if (e.code === 'Space' && !onFocusedControl(e.target) && !spacePanRef.current && !e.repeat) {
        e.preventDefault();
        setSpacePan(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        fitRef.current();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomStep(ZOOM_STEP);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomStep(1 / ZOOM_STEP);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') setSpacePan(false);
    }
    // Releasing space over another window leaves the flag stuck on, and the
    // canvas then swallows every click. Clear it whenever focus leaves.
    function onBlur() {
      setSpacePan(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [zoomStep]);

  return { spacePan, panning, beginPan, zoomStep };
}
