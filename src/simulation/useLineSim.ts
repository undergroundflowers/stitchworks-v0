/**
 * The one hook every analysis surface uses to get a live simulation of the
 * user's OWN sewing lines.
 *
 * Before this, `/queues`, `/queues/analytics`, `/workstation/:…` and Reports
 * each did the same thing:
 *
 *     const twin = buildGarmentTwin(garment, defaultOperators) ?? EMPTY_TWIN;
 *     const { state, step } = usePmlSim(twin, { garment });
 *     useEffect(() => { if (state.time === 0) step(480); }, []);
 *
 * which synthesised a throwaway zig-zag line from the selected garment
 * template and analysed THAT — not the factory the user built. Whatever they
 * had authored in the Builder was invisible on every queueing screen. Worse,
 * the mount-only warm-up raced the frame reset that a re-run triggered, so a
 * change to the garment or the operator count left every metric on zero
 * permanently.
 *
 * Now they all read the active twin through the shared session, so they
 * describe the real line, share one engine with the Sim screen, and inherit
 * its clock.
 */

import { useEffect, useMemo } from 'react';
import { useTwin, selectActiveTwin } from '../store/twin';
import { useProject } from '../store/project';
import { useGarments } from '../store/garments';
import { useSimScope, type SimScope } from '../store/simScope';
import type { SewingLine, Twin } from '../domain/twin';
import { getBlockKind } from '../domain/pml';
import { buildSimSpec, simSpecKey, type SimSpec } from './sim-spec';
import { useSimSession, type SimRunSlot } from './useSimSession';
import { emptyPmlSimState } from './pml-to-sim-state';
import { mergePmlSimStates } from './useMultiPmlSim';
import { efficiencyFromSkillMatrix } from './model';
import type { SimState } from './sim-state';

/**
 * Why a surface might have nothing to show. Distinguished because the two
 * cases need completely different advice: one user has never grouped their
 * stations into a line, the other has no factory at all.
 */
export type LineSimEmptyReason =
  | 'no-stations'
  | 'stations-not-in-a-line'
  | 'nothing-in-scope';

export interface UseLineSimResult {
  /** Merged across every line in scope. Empty-but-valid before the first run. */
  state: SimState;
  /** Per-line slots, in spec order. */
  runs: SimRunSlot[];
  /** The lines actually being simulated. */
  lines: SewingLine[];
  /** Every line in the twin, for the scope picker. */
  allLines: SewingLine[];
  twin: Twin;
  scope: SimScope;
  status: 'idle' | 'running' | 'ready' | 'error';
  /** Null when there IS something to analyse. */
  emptyReason: LineSimEmptyReason | null;
  /** Stations that exist but carry no `lineId` — the actionable count for the
   *  "group these into a line" prompt. */
  unassignedStationCount: number;
  spec: SimSpec;
}

export function useLineSim(): UseLineSimResult {
  const twin = useTwin(selectActiveTwin);
  const scope = useSimScope((s) => s.scope);
  const durationMin = useSimScope((s) => s.durationMin);
  const seed = useSimScope((s) => s.seed);
  const warmupMin = useSimScope((s) => s.warmupMin);
  const garments = useGarments();
  const selectedGarmentId = useProject((s) => s.selectedGarmentId);
  const skillMatrix = useProject((s) => s.skillMatrix);

  // Skill-matrix efficiencies are engine input, so they belong in the spec —
  // and therefore in the key, so editing the matrix re-runs the sim.
  const opEfficiency = useMemo(() => {
    const garment = garments.byId[selectedGarmentId] ?? garments.all[0];
    if (!garment) return undefined;
    const eff = efficiencyFromSkillMatrix(skillMatrix, garment.operations);
    return Object.keys(eff).length > 0 ? eff : undefined;
  }, [skillMatrix, garments, selectedGarmentId]);

  const spec = useMemo(
    () =>
      buildSimSpec({
        twin,
        scope,
        garmentsById: garments.byId,
        defaultGarmentId: selectedGarmentId,
        durationMin,
        seed,
        warmupMin,
        opEfficiency,
      }),
    [twin, scope, garments.byId, selectedGarmentId, durationMin, seed, warmupMin, opEfficiency],
  );

  const key = useMemo(() => (spec.lines.length > 0 ? simSpecKey(spec) : ''), [spec]);
  const ensure = useSimSession((s) => s.ensure);
  useEffect(() => {
    if (key) ensure(spec);
    // Keyed on the structural fingerprint, not the spec object — a re-derived
    // but identical spec must not re-run the engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const session = useSimSession((s) => (key ? s.sessions[key] : undefined));
  const status = useSimSession((s) => s.status);

  const runs = session?.runs ?? [];
  const lineIds = useMemo(() => spec.lines.map((l) => l.lineId), [spec]);

  // One line is the common case and needs no merge; several are folded into the
  // factory-wide shape the existing views already understand.
  const state = useMemo<SimState>(() => {
    if (runs.length === 0) return emptyPmlSimState();
    if (runs.length === 1) return runs[0].state;
    return mergePmlSimStates(
      runs.map((r) => r.state),
      lineIds,
    );
  }, [runs, lineIds]);

  const allLines = twin.lines ?? [];
  const lines = useMemo(
    () => allLines.filter((l) => lineIds.includes(l.id)),
    [allLines, lineIds],
  );

  const unassignedStationCount = useMemo(
    () =>
      twin.workstations.filter((ws) => !ws.lineId && getBlockKind(ws) === 'Service').length,
    [twin],
  );

  const emptyReason = useMemo<LineSimEmptyReason | null>(() => {
    if (spec.lines.length > 0) return null;
    if (twin.workstations.length === 0) return 'no-stations';
    if (unassignedStationCount > 0) return 'stations-not-in-a-line';
    // Stations exist and are assigned, but none of them fall in the current
    // scope — a line filter pointed at something that has since been emptied.
    return 'nothing-in-scope';
  }, [spec.lines.length, twin.workstations.length, unassignedStationCount]);

  return {
    state,
    runs,
    lines,
    allLines,
    twin,
    scope,
    status,
    emptyReason,
    unassignedStationCount,
    spec,
  };
}
