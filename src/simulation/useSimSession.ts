/**
 * The app's simulation session — one engine, one clock, shared by every
 * surface.
 *
 * Before this, each surface called `usePmlSim` for itself, so the Sim screen
 * and the analysis screens ran separate engines over the same factory and
 * could never animate together; playback died the moment you navigated away.
 *
 * Three properties it is built around:
 *
 *  1. THE CLOCK IS GLOBAL. `frame`, `playing` and `speed` live on the store,
 *     not on a session, so anything subscribed moves together. A page may run
 *     more than one spec at once (the Sim screen keeps a whole-factory run and
 *     a per-line run side by side) and both advance off the same pointer
 *     instead of racing for ownership of it.
 *
 *  2. RUNS ARE ADDRESSED STRUCTURALLY. A session is keyed by
 *     `simSpecKey(spec)`, so re-deriving an equal spec is free and a canvas
 *     drag doesn't restart the engine. Sessions are cached (small LRU), so
 *     walking Sim → Reports → Sim returns to the same run at the same frame.
 *
 *  3. HISTORY GROWS INCREMENTALLY. Advancing appends one point per station.
 *     The old path re-sliced the sample array and rebuilt both history arrays
 *     from scratch on every rendered frame — ~14k iterations plus fresh arrays
 *     five times a second per line, at 480 samples × 30 stations. Scrubbing
 *     back truncates with `arr.length = k`; every point is a pure function of
 *     its sample, so re-appending reproduces it exactly.
 */

import { create } from 'zustand';
import { runPmlSim, type PmlSimResult, type PmlSimSample } from './pml-engine';
import {
  buildPmlTwinView,
  emptyPmlSimState,
  historyPointFrom,
  pmlSampleToSimState,
  stationHistoryPointFrom,
  type PmlTwinView,
} from './pml-to-sim-state';
import type { HistoryPoint, SimState, StationHistoryPoint } from './sim-state';
import { simSpecKey, type SimSpec, type SimSpecLine } from './sim-spec';

/** One point per this many sim-minutes on the history charts. */
const HISTORY_STRIDE_MIN = 5;

/** How many distinct runs to keep warm. Enough that flipping between a few
 *  surfaces never re-runs the engine; small enough to bound memory, which
 *  matters because a flow-recorded run can be tens of megabytes. */
const MAX_CACHED_SESSIONS = 4;

export interface SimRunSlot {
  lineId: string;
  lineName: string;
  view: PmlTwinView;
  result: PmlSimResult | null;
  /** Sample at the warm-up boundary, resolved once when the run loads. Handed
   *  to the adapter so displayed observables are post-transient. */
  warmupSample: PmlSimSample | null;
  /**
   * Stride-aligned points, append-only. Grown incrementally and never
   * rewritten, so the cost of advancing is one point per station per stride
   * crossing rather than a rebuild of the whole series.
   */
  strideHistory: HistoryPoint[];
  /** Parallel to `view.stations`. Same append-only contract. */
  strideStationHistory: StationHistoryPoint[][];
  /**
   * What consumers read: the stride points plus a point for the exact playhead
   * frame, so the plotted line reaches the clock and the KPI tiles quote the
   * instant on screen. Rebuilt per advance with a fresh identity — see the note
   * in `advanceSlot`.
   */
  history: HistoryPoint[];
  stationHistory: StationHistoryPoint[][];
  /** Derived for the current frame. O(stations) to rebuild. */
  state: SimState;
  /** Highest frame folded into the stride buffers. -1 = nothing yet. */
  builtThrough: number;
}

export interface SimSession {
  key: string;
  spec: SimSpec;
  runs: SimRunSlot[];
  maxFrame: number;
  /** Frame index of the warm-up boundary. */
  warmupFrame: number;
  warnings: string[];
}

export interface SimSessionState {
  sessions: Record<string, SimSession>;
  /** Shared playback pointer. Every cached session is advanced to it. */
  frame: number;
  playing: boolean;
  speed: number;
  status: 'idle' | 'running' | 'ready' | 'error';
  error: string | null;

  /**
   * Register (or reuse) a session for this spec. Idempotent and cheap when the
   * spec is structurally unchanged. Returns the session key.
   *
   * `parkAt` says where the clock should sit when this is the FIRST session to
   * load, and exists because the two kinds of surface want opposite things. An
   * analysis table wants the settled shift on arrival — that was the whole
   * complaint, metrics reading zero until something advanced the clock. The
   * animated floor wants to start at the beginning so there is something to
   * watch. It is not part of the session key: it changes nothing about the run,
   * only where playback begins.
   */
  ensure: (spec: SimSpec, opts?: { parkAt?: 'start' | 'steady' }) => string;
  setFrame: (f: number) => void;
  step: (frames: number) => void;
  reset: () => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
}

// ============================================================================
// PURE HELPERS
// ============================================================================

/** Index of the last sample at or before `minute`. */
export function frameAtMinute(samples: PmlSimSample[], minute: number): number {
  if (samples.length === 0) return 0;
  let lo = 0;
  let hi = samples.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].time <= minute) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Run one line, tolerating a broken graph the way the old hooks did. */
function runSlot(line: SimSpecLine, spec: SimSpec): SimRunSlot {
  const view = buildPmlTwinView(line.twin, line.garment);
  let result: PmlSimResult | null = null;
  if (line.twin.workstations.length > 0) {
    try {
      result = runPmlSim({
        twin: line.twin,
        garmentsById: spec.garmentsById,
        durationMin: spec.durationMin,
        seed: spec.seed,
        samplePeriodMin: spec.samplePeriodMin,
        recordFlow: spec.recordFlow,
        opEfficiency: spec.opEfficiency,
      });
    } catch (err) {
      // The engine throws on a genuinely broken graph (no Source, no Sink).
      // Surface an empty slot rather than taking the page down; the Builder's
      // pre-flight chip reports the same problems before the run.
      if (typeof console !== 'undefined') {
        console.error(`[useSimSession] run failed for line ${line.lineId}:`, err);
      }
    }
  }
  const samples = result?.samples ?? [];
  const warmupSample =
    spec.warmupMin > 0 && samples.length > 0
      ? samples[frameAtMinute(samples, spec.warmupMin)]
      : null;
  return {
    lineId: line.lineId,
    lineName: line.lineName,
    view,
    result,
    warmupSample,
    strideHistory: [],
    strideStationHistory: view.stations.map(() => []),
    history: [],
    stationHistory: view.stations.map(() => []),
    state: emptyPmlSimState(),
    builtThrough: -1,
  };
}

/**
 * Fold samples up to `target` into a slot's buffers, then rebuild its state.
 * Mutates in place — slots are private to the store until this returns.
 */
function advanceSlot(slot: SimRunSlot, target: number): void {
  const samples = slot.result?.samples ?? [];
  if (samples.length === 0) return;
  const idx = Math.max(0, Math.min(target, samples.length - 1));
  if (idx === slot.builtThrough) return;
  const playSample = samples[idx];

  // ── Stride buffer: append-only, one point per HISTORY_STRIDE_MIN ──────────
  // Deliberately does NOT force-include the playhead frame. An earlier version
  // did, and then tried to pop the stale tip on the next advance — which meant
  // stepping frame-by-frame appended a point per FRAME and quietly defeated the
  // stride entirely (~480 points instead of ~96 over a shift). The playhead is
  // handled separately, below, where it costs nothing to get right.
  if (idx > slot.builtThrough) {
    let cursor =
      slot.strideHistory.length > 0
        ? slot.strideHistory[slot.strideHistory.length - 1].time
        : -Infinity;
    for (let f = Math.max(0, slot.builtThrough + 1); f <= idx; f++) {
      const s = samples[f];
      if (s.time - cursor < HISTORY_STRIDE_MIN) continue;
      cursor = s.time;
      slot.strideHistory.push(historyPointFrom(slot.view, s));
      for (let i = 0; i < slot.view.stations.length; i++) {
        slot.strideStationHistory[i].push(
          stationHistoryPointFrom(slot.view.stations[i], s, slot.warmupSample ?? undefined),
        );
      }
    }
  } else {
    // Scrubbed backwards: drop points past the new playhead. Every point is a
    // pure function of its sample, so re-appending later reproduces it exactly.
    const cutTime = playSample.time;
    let keep = slot.strideHistory.length;
    while (keep > 0 && slot.strideHistory[keep - 1].time > cutTime) keep--;
    slot.strideHistory.length = keep;
    for (const h of slot.strideStationHistory) h.length = keep;
  }
  slot.builtThrough = idx;

  // ── Exposed series: stride points + the exact playhead ────────────────────
  // Consumers get a FRESH array identity on every advance. The buffers above
  // grow by mutation, which is the point of doing this incrementally, but a
  // consumer that memoises on `state.history` — LiveSim's throughput tile does
  // — cannot observe an in-place push and would serve a stale value forever. It
  // read 65 pcs/hr beside an OUTPUT tile of 569 pcs over 8 hours.
  //
  // Appending the playhead point here (rather than into the stride buffer)
  // keeps the plotted line reaching the clock and the KPI tiles quoting the
  // instant on screen, without the stride buffer ever being rewritten.
  //
  // Cost is O(points) pointer writes — ~96 per line at a 5-minute stride over a
  // shift — against the old path's ~14k point CONSTRUCTIONS per rendered frame.
  const tipNeeded =
    slot.strideHistory.length === 0 ||
    slot.strideHistory[slot.strideHistory.length - 1].time < playSample.time;

  if (tipNeeded) {
    slot.history = [...slot.strideHistory, historyPointFrom(slot.view, playSample)];
    slot.stationHistory = slot.strideStationHistory.map((h, i) => [
      ...h,
      stationHistoryPointFrom(slot.view.stations[i], playSample, slot.warmupSample ?? undefined),
    ]);
  } else {
    slot.history = slot.strideHistory.slice();
    slot.stationHistory = slot.strideStationHistory.map((h) => h.slice());
  }

  // `priorSamples` is empty: the adapter no longer walks the run to rebuild
  // history — we hand it the series assembled above.
  const state = pmlSampleToSimState(slot.view, playSample, slot.result, [], {
    warmupSample: slot.warmupSample ?? undefined,
  });
  state.history = slot.history;
  state.stationHistory = slot.stationHistory;
  slot.state = state;
}

/** Evict least-recently-registered sessions beyond the cap. Object key order
 *  is insertion order, so the tail is the most recent. */
function prune(sessions: Record<string, SimSession>, keep: string): Record<string, SimSession> {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_CACHED_SESSIONS) return sessions;
  const survivors = new Set(keys.slice(-MAX_CACHED_SESSIONS));
  survivors.add(keep);
  const out: Record<string, SimSession> = {};
  for (const k of keys) if (survivors.has(k)) out[k] = sessions[k];
  return out;
}

// ============================================================================
// STORE
// ============================================================================

export const useSimSession = create<SimSessionState>()((set, get) => ({
  sessions: {},
  frame: 0,
  playing: false,
  speed: 1,
  status: 'idle',
  error: null,

  ensure: (spec, opts) => {
    // A spec with no lines has nothing to run. Returning early keeps an
    // inactive caller (a page that renders the multi-line hook with an empty
    // input while it's in single-line scope) from disturbing anything.
    if (spec.lines.length === 0) return '';

    const key = simSpecKey(spec);
    if (get().sessions[key]) return key;

    set({ status: 'running', error: null });
    try {
      const runs = spec.lines.map((line) => runSlot(line, spec));
      const maxFrame = runs.reduce(
        (m, r) => Math.max(m, (r.result?.samples.length ?? 1) - 1),
        0,
      );
      const warmupFrame = runs.reduce((m, r) => {
        const samples = r.result?.samples ?? [];
        return Math.max(m, samples.length > 0 ? frameAtMinute(samples, spec.warmupMin) : 0);
      }, 0);

      const session: SimSession = {
        key,
        spec,
        runs,
        maxFrame,
        warmupFrame,
        warnings: [...new Set(runs.flatMap((r) => r.result?.warnings ?? []))],
      };

      set((prev) => {
        // Only the FIRST session to load positions the clock; after that the
        // shared pointer is wherever the user left it.
        //
        // 'steady' parks at the end of the run rather than at the warm-up
        // boundary. Parking exactly ON the boundary makes the post-warm-up
        // window zero-length, so every windowed observable reads 0 — which is
        // indistinguishable from the "no numbers" bug it was meant to fix.
        const parkAt = opts?.parkAt ?? 'steady';
        const frame =
          prev.frame > 0
            ? prev.frame
            : parkAt === 'start'
              ? 0
              : maxFrame;
        for (const r of runs) advanceSlot(r, frame);
        return {
          sessions: prune({ ...prev.sessions, [key]: session }, key),
          frame,
          status: 'ready',
          error: null,
        };
      });
      return key;
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      return '';
    }
  },

  setFrame: (f) => {
    const { sessions, frame } = get();
    const cap = Object.values(sessions).reduce((m, s) => Math.max(m, s.maxFrame), 0);
    const next = Math.max(0, Math.min(cap, Math.round(f)));
    if (next === frame) return;
    // Every cached session tracks the shared clock. Advancing one that isn't
    // currently on screen costs O(stations) and keeps it ready to resume.
    const nextSessions: Record<string, SimSession> = {};
    for (const [k, s] of Object.entries(sessions)) {
      for (const r of s.runs) advanceSlot(r, next);
      nextSessions[k] = { ...s, runs: [...s.runs] };
    }
    set({ frame: next, sessions: nextSessions });
  },

  step: (frames) => get().setFrame(get().frame + frames),

  reset: () => {
    get().setFrame(0);
    set({ playing: false });
  },

  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed: Math.max(0, speed) }),
}));

// ============================================================================
// SELECTORS
// ============================================================================

export const selectSession =
  (key: string) =>
  (s: SimSessionState): SimSession | null =>
    s.sessions[key] ?? null;

export const selectFrame = (s: SimSessionState): number => s.frame;

/** Longest run across cached sessions — the transport's upper bound. */
export const selectMaxFrame = (s: SimSessionState): number =>
  Object.values(s.sessions).reduce((m, x) => Math.max(m, x.maxFrame), 0);

/** Narrow selector for anything that only needs the transport, so a chart
 *  doesn't re-render because the speed changed. */
export const selectTransport = (s: SimSessionState) => ({
  playing: s.playing,
  speed: s.speed,
  status: s.status,
});
