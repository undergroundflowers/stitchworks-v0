/**
 * The single wall-clock loop that drives simulation playback.
 *
 * Headless, and mounted ONCE in `App.tsx` inside the shell but OUTSIDE
 * `<Routes>`. That placement is the whole point: because the driver lives
 * above the router, playback survives navigation. Start a run on the Sim
 * screen, walk to Reports, and the clock is still ticking on the same engine
 * at the same frame — the behaviour the pivot is asking for, and impossible
 * while each page owned its own loop and unmounted it on the way out.
 */

import { useEffect, useRef } from 'react';
import { useProject } from '../store/project';
import { useSimSession, selectMaxFrame } from './useSimSession';

/** Wall-clock tick for real-time playback. */
const TICK_MS = 200;

export function SimSessionDriver(): null {
  const playing = useSimSession((s) => s.playing);
  const maxFrame = useSimSession(selectMaxFrame);
  const mode = useProject((s) => s.time.executionMode);
  const realTimeScale = useProject((s) => s.time.realTimeScale);
  const speed = useSimSession((s) => s.speed);

  // Read the live frame without re-subscribing the effect to it — otherwise
  // every tick would tear down and rebuild the interval.
  const frameRef = useRef(0);
  frameRef.current = useSimSession((s) => s.frame);

  useEffect(() => {
    if (!playing || maxFrame === 0) return;
    const { setFrame, setPlaying } = useSimSession.getState();

    if (mode === 'virtual') {
      // Virtual time: the run is already recorded, so there is nothing to
      // "compute faster" — settle on the last frame and stop.
      const id = requestAnimationFrame(() => {
        setFrame(maxFrame);
        setPlaying(false);
      });
      return () => cancelAnimationFrame(id);
    }

    // Real time: advance `effectiveScale × dt` sim-minutes per real second.
    // With realTimeScale = 1 and speed = 1 that is exactly one sim-minute per
    // wall-second, since samples are taken at 1-minute cadence.
    //
    // The accumulator is fractional on purpose. Rounding dt × scale up to a
    // whole frame per tick — the obvious implementation — made the default
    // speed advance ~5 frames/sec instead of 1, because each 200 ms tick
    // contributed 0.2 sim-minutes and then rounded up to 1.
    let last = performance.now();
    let accum = frameRef.current;
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const effectiveScale = Math.max(0, realTimeScale) * Math.max(0, speed);
      accum += dt * effectiveScale;
      const next = Math.min(maxFrame, Math.floor(accum));
      if (next === frameRef.current) return;
      setFrame(next);
      if (next >= maxFrame) setPlaying(false);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, maxFrame, mode, realTimeScale, speed]);

  return null;
}
