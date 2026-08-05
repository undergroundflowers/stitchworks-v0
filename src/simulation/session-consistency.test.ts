import { describe, it, expect } from 'vitest';
import { buildStarterLine } from '../domain/starter-line';
import { GARMENT_TEMPLATES } from '../domain/garments';
import { buildSimSpec } from './sim-spec';
import { useSimSession } from './useSimSession';

/**
 * Internal consistency of what the session hands the UI.
 *
 * The HUD reads OUTPUT from `state.producedPieces` and THROUGHPUT from the last
 * point of `state.history`. Those come from two different code paths — the
 * per-frame adapter and the incrementally-grown history buffer — so nothing
 * structurally forces them to describe the same instant. If they drift, the
 * screen shows a pair of numbers that cannot both be true, which is exactly
 * the class of bug this pivot is about.
 */
describe('session state is internally consistent', () => {
  const twin = buildStarterLine();
  const spec = buildSimSpec({
    twin,
    scope: { kind: 'factory' },
    garmentsById: GARMENT_TEMPLATES,
    defaultGarmentId: 'tshirt',
    durationMin: 480,
    seed: 42,
    warmupMin: 60,
  });

  const key = useSimSession.getState().ensure(spec);
  const slotAt = (frame: number) => {
    useSimSession.getState().setFrame(frame);
    const session = useSimSession.getState().sessions[key];
    return session.runs[0];
  };

  it('loaded a run', () => {
    expect(key).not.toBe('');
    const session = useSimSession.getState().sessions[key];
    expect(session.runs.length).toBe(1);
    expect(session.maxFrame).toBeGreaterThan(0);
  });

  it("history's last point describes the frame on screen", () => {
    const slot = slotAt(480);
    const last = slot.history[slot.history.length - 1];
    expect(last.time).toBe(slot.state.time);
    // The tiles are computed from these two, so they have to agree.
    expect(last.produced).toBe(slot.state.producedPieces);
  });

  it('throughput equals output ÷ elapsed hours', () => {
    const slot = slotAt(480);
    const last = slot.history[slot.history.length - 1];
    const expected = last.produced / (last.time / 60);
    expect(last.throughputPerHr).toBeCloseTo(expected, 6);
  });

  it('stays consistent at an intermediate frame', () => {
    const slot = slotAt(240);
    const last = slot.history[slot.history.length - 1];
    expect(last.time).toBe(slot.state.time);
    expect(last.produced).toBe(slot.state.producedPieces);
  });

  it('stays consistent after scrubbing backwards', () => {
    slotAt(480);
    const slot = slotAt(120);
    const last = slot.history[slot.history.length - 1];
    expect(last.time).toBe(slot.state.time);
    expect(last.produced).toBe(slot.state.producedPieces);
    // Truncation must not leave points from the future on the chart.
    expect(Math.max(...slot.history.map((h) => h.time))).toBe(slot.state.time);
  });

  it('re-advancing after a scrub reproduces the same history', () => {
    // Points are pure functions of their sample, so truncate-then-re-append has
    // to be identical to never having scrubbed. If it isn't, the chart quietly
    // depends on how the user moved the playhead.
    const forward = slotAt(300).history.map((h) => `${h.time}:${h.produced}:${h.wip}`);
    slotAt(60);
    const again = slotAt(300).history.map((h) => `${h.time}:${h.produced}:${h.wip}`);
    expect(again).toEqual(forward);
  });

  it('hands out a NEW history array identity whenever it grows', () => {
    // The buffers are grown by mutation. A consumer that memoises on
    // `state.history` — LiveSim's throughput tile does — would never observe an
    // in-place push and would serve a stale number forever: it showed 65 pcs/hr
    // beside an OUTPUT tile reading 569 pcs after 8 hours. Every other
    // assertion in this file passed while that was broken, because they read
    // the buffer directly rather than through React's identity comparison.
    const a = slotAt(120);
    const historyA = a.state.history;
    const stationA = a.state.stationHistory[0];
    const b = slotAt(300);
    expect(b.state.history).not.toBe(historyA);
    expect(b.state.stationHistory[0]).not.toBe(stationA);
    expect(b.state.history.length).toBeGreaterThan(historyA.length);
  });

  it('refreshes identity on a one-frame advance', () => {
    const a = slotAt(300);
    const historyA = a.state.history;
    const b = slotAt(301);
    expect(b.state.history).not.toBe(historyA);
    // The playhead point is appended on top of the stride series, so the tip
    // always sits exactly on the clock.
    expect(b.state.history[b.state.history.length - 1].time).toBe(b.state.time);
  });

  it('does not leak a point per frame when stepped one frame at a time', () => {
    // The stride buffer must stay stride-aligned. An earlier version
    // force-included the playhead frame INTO that buffer and popped the stale
    // tip on the next advance, which meant frame-by-frame stepping appended a
    // point per frame and quietly defeated the stride: ~480 points over a shift
    // instead of ~96. Charts would then redraw hundreds of segments per tick.
    slotAt(0);
    for (let f = 1; f <= 120; f++) slotAt(f);
    const stepped = useSimSession.getState().sessions[key].runs[0];

    // Reach the same frame in one jump and compare series length.
    slotAt(0);
    const jumped = slotAt(120);
    expect(stepped.history.length).toBe(jumped.history.length);
    // 120 minutes at a 5-minute stride is ~25 points, plus the tip — nowhere
    // near the 120 a per-frame leak would produce.
    expect(stepped.history.length).toBeLessThan(40);
  });

  it('every station history is parallel to the line history', () => {
    const slot = slotAt(480);
    for (const sh of slot.stationHistory) {
      expect(sh.length).toBe(slot.history.length);
    }
  });

  it('reuses the cached session for an equal spec', () => {
    const before = Object.keys(useSimSession.getState().sessions).length;
    const again = buildSimSpec({
      twin,
      scope: { kind: 'factory' },
      garmentsById: GARMENT_TEMPLATES,
      defaultGarmentId: 'tshirt',
      durationMin: 480,
      seed: 42,
      warmupMin: 60,
    });
    const key2 = useSimSession.getState().ensure(again);
    expect(key2).toBe(key);
    expect(Object.keys(useSimSession.getState().sessions).length).toBe(before);
  });
});
