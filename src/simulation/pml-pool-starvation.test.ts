import { describe, it, expect } from 'vitest';
import { runPmlSim } from './pml-engine';
import { buildGarmentTwin } from '../domain/reference-twin';
import { GARMENT_TEMPLATES } from '../domain/garments';
import { getBlockKind } from '../domain/pml';
import type { Twin, Workstation } from '../domain/twin';
import type { PmlBlockParams } from '../domain/pml';

/**
 * P6 operator-pool starvation — wake-on-release.
 *
 * The seize in `tryStartService` used to be write-only: a Service that found
 * every unit of its ResourcePool taken returned `false` and recorded nothing,
 * so no release could ever wake it. Only the releasing station retried itself.
 * A station that lost the race for a shared operator therefore sat idle behind
 * a non-empty queue until some unrelated event (a fresh arrival, a changeover
 * ending) happened to poke it — every release-instant in between was a start it
 * should have made. `retryForward` could not stand in: it clears DOWNSTREAM
 * buffer space and skips a pool-starved Service entirely, because such a
 * station never got an agent into service and so has an empty `blocked` list.
 *
 * The fix parks the starved station on the pool's FIFO wait list and sweeps
 * that list when a unit comes back. These tests lock in the properties that
 * make it correct:
 *
 *   • No idle operator beside waiting work — the invariant the bug violated.
 *   • Strictly more output than the pre-fix engine, on every seed.
 *   • Higher operator utilisation — the units that were idling now work.
 *   • Reproducible per seed, and still actually seed-dependent.
 *
 * The line is deliberately starved (far more stations than operators) and the
 * Source flooded, so the pool — not the arrival rate and not a buffer — is the
 * binding constraint.
 */

const DURATION = 480;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Set block params on a workstation while preserving its resolved kind. */
function patchParams(ws: Workstation, patch: Partial<PmlBlockParams>): void {
  ws.block = {
    ...(ws.block ?? {}),
    kind: getBlockKind(ws),
    params: { ...(ws.block?.params ?? {}), ...patch },
  };
}

/** A single-line twin whose stations all draw on one undersized pool, with the
 *  Source flooded so the operators are the only thing holding the line back. */
function contendedTwin(garment: keyof typeof GARMENT_TEMPLATES, operators: number): Twin {
  const twin = buildGarmentTwin(GARMENT_TEMPLATES[garment], 6)!;
  for (const ws of twin.workstations) {
    const kind = getBlockKind(ws);
    if (kind === 'Source') patchParams(ws, { sourceRatePerHr: 100_000 });
    if (kind === 'ResourcePool') patchParams(ws, { capacity: operators });
  }
  return twin;
}

function serviceIdsOf(twin: Twin): Set<string> {
  return new Set(
    twin.workstations.filter((w) => getBlockKind(w) === 'Service').map((w) => w.id),
  );
}

/** Operator-minutes actually worked across the whole pool. */
function poolBusyUnitMin(run: ReturnType<typeof runPmlSim>): number {
  let total = 0;
  for (const b of run.blocks.values()) total += b.resourceBusyUnitMin;
  return total;
}

/**
 * Sample instants where a free operator sat beside a station that could have
 * used it — a non-empty queue AND a spare server slot. This is the starvation
 * itself, counted directly rather than inferred from throughput.
 */
function idleOperatorViolations(
  run: ReturnType<typeof runPmlSim>,
  twin: Twin,
  capacity: number,
): number {
  const svcIds = serviceIdsOf(twin);
  let violations = 0;
  for (const s of run.samples) {
    // `busy` mirrors inService, which still counts a server holding a blocked
    // agent — so this is exactly the pool's occupied-unit count.
    let occupied = 0;
    for (const [id, b] of Object.entries(s.blocks)) {
      if (svcIds.has(id)) occupied += b.inService;
    }
    if (occupied >= capacity) continue; // pool saturated — nothing to hand out
    for (const [id, b] of Object.entries(s.blocks)) {
      if (!svcIds.has(id)) continue;
      // Held up by its own server cap rather than the pool? Not a violation.
      if (b.queueLen > 0 && b.inService < b.serversTotal) {
        violations++;
        break;
      }
    }
  }
  return violations;
}

/**
 * Pre-fix engine measurements, seeds 1..8, recorded from the commit before
 * wake-on-release by running the identical fixtures through the old build.
 * They are what "before the fix" means in the assertions below — re-record
 * them if GARMENT_TEMPLATES or the service-time model ever changes.
 */
const PRE_FIX = {
  starved: {
    garment: 'sweatshirt' as const,
    operators: 3,
    // The pool was so thin that the pre-fix engine finished NOTHING in a full
    // shift — the operators spent the run parked beside queued work.
    produced: [0, 0, 0, 0, 0, 0, 0, 0],
    busyUnitMin: [1417.2, 1417.3, 1419.9, 1421.4, 1414.4, 1415.0, 1406.8, 1405.8],
  },
  healthy: {
    garment: 'shirt' as const,
    operators: 6,
    // A line that already ran well pre-fix, to show the gain is not confined
    // to the degenerate produced-nothing case.
    produced: [869, 796, 889, 958, 868, 931, 826, 920],
    busyUnitMin: [2761.1, 2791.9, 2786.1, 2765.4, 2762.5, 2777.9, 2745.1, 2807.0],
  },
};

describe.each([
  ['starved line (25 stations, 3 operators)', PRE_FIX.starved],
  ['contended line (20 stations, 6 operators)', PRE_FIX.healthy],
])('PML operator-pool starvation — %s', (_label, base) => {
  const runs = SEEDS.map((seed) => {
    const twin = contendedTwin(base.garment, base.operators);
    return {
      seed,
      twin,
      run: runPmlSim({ twin, durationMin: DURATION, seed, samplePeriodMin: 1 }),
    };
  });

  it('really does share one undersized pool (sanity)', () => {
    const twin = runs[0].twin;
    const pools = twin.workstations.filter((w) => getBlockKind(w) === 'ResourcePool');
    expect(pools).toHaveLength(1);
    expect(serviceIdsOf(twin).size).toBeGreaterThan(base.operators);
  });

  it('never leaves an operator idle beside a station with waiting work', () => {
    for (const { seed, twin, run } of runs) {
      expect
        .soft(idleOperatorViolations(run, twin, base.operators), `seed ${seed}`)
        .toBe(0);
    }
  });

  it('produces strictly more than the pre-fix engine, on every seed', () => {
    runs.forEach(({ seed, run }, i) => {
      expect.soft(run.totalProduced, `seed ${seed}`).toBeGreaterThan(base.produced[i]);
    });
  });

  it('puts the recovered operator-minutes to work (utilisation rises)', () => {
    runs.forEach(({ seed, run }, i) => {
      expect.soft(poolBusyUnitMin(run), `seed ${seed}`).toBeGreaterThan(base.busyUnitMin[i]);
    });
  });

  it('stays reproducible — a repeated seed replays exactly', () => {
    // Keyed by POSITION, not workstation id: buildGarmentTwin mints fresh ids
    // on every call, so two structurally identical twins never share them.
    const replay = (seed: number) => {
      const twin = contendedTwin(base.garment, base.operators);
      const r = runPmlSim({ twin, durationMin: DURATION, seed });
      return {
        totalProduced: r.totalProduced,
        throughputPerHr: r.throughputPerHr,
        // Per-station too, not just the headline number — the wake order
        // decides WHICH station gets each freed operator, so a wobble shows
        // here first even when the totals happen to agree.
        perStation: twin.workstations.map((ws, i) => {
          const o = r.blocks.get(ws.id);
          return `${i}:${o?.produced ?? -1}:${o?.resourceBusyUnitMin ?? -1}`;
        }),
      };
    };
    for (const seed of [SEEDS[0], SEEDS[SEEDS.length - 1]]) {
      expect(replay(seed)).toEqual(replay(seed));
    }
  });

  it('still depends on the seed (the runs are not degenerate)', () => {
    const produced = runs.map((r) => r.run.totalProduced);
    expect(new Set(produced).size).toBeGreaterThan(1);
  });
});
