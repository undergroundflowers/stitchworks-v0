/**
 * SimSpec — the complete, engine-facing description of a run, plus a
 * STRUCTURAL fingerprint of it.
 *
 * The fingerprint is the point of this module. The run used to be memoised on
 * twin OBJECT IDENTITY, so any store write minted a new twin and re-ran the
 * whole engine: dragging a workstation across the canvas, renaming a line, or
 * the `setKpiObserved` write-back that a run itself performs. Each re-run also
 * reset the playback pointer to zero. On a fresh boot the engine ran three
 * times before the user touched anything.
 *
 * `simSpecKey` hashes only what the ENGINE reads. Two specs with equal keys
 * must produce byte-identical results, so a canvas drag leaves playback alone
 * while a change to a cycle time, a server count or a buffer restarts it.
 *
 * The failure mode to guard against is the opposite one: a field the engine
 * reads but the key ignores means an edit that silently shows stale numbers.
 * That is worse than a spurious re-run, so the hash deliberately
 * over-includes, and `sim-spec.test.ts` asserts field-by-field that every
 * engine-visible parameter moves the key and every cosmetic one doesn't.
 */

import type { GarmentTemplate } from '../domain';
import type { Twin } from '../domain/twin';
import { getBlockKind, getBlockParams } from '../domain/pml';
import { scopedTwinForLine } from './useMultiPmlSim';
import { scopeToKey, type SimScope } from '../store/simScope';

/** One sewing line's slice of a run. */
export interface SimSpecLine {
  lineId: string;
  lineName: string;
  /** Twin scoped to just this line's workstations + intra-line connectors. */
  twin: Twin;
  garment?: GarmentTemplate;
}

export interface SimSpec {
  /** One entry per line in scope, in stable order. */
  lines: SimSpecLine[];
  durationMin: number;
  seed: number;
  samplePeriodMin: number;
  /**
   * Entity-flow recording. Derived from the SCOPE, never from which page
   * happens to be mounted — otherwise navigating between two surfaces that
   * disagree about it would flip the flag, change the key, and re-run the
   * engine purely as a side effect of routing.
   */
  recordFlow: boolean;
  warmupMin: number;
  opEfficiency?: Record<string, number>;
}

// ============================================================================
// SPEC CONSTRUCTION
// ============================================================================

export interface BuildSimSpecInput {
  twin: Twin;
  scope: SimScope;
  garmentsById: Record<string, GarmentTemplate>;
  defaultGarmentId: string;
  durationMin: number;
  seed: number;
  warmupMin: number;
  /** Per-op efficiency multipliers from the skill matrix. */
  opEfficiency?: Record<string, number>;
  samplePeriodMin?: number;
}

/**
 * Derive the spec from the active twin + the shared scope. Called identically
 * by every surface — that identity is what lets one session survive a route
 * change instead of being torn down and rebuilt.
 */
export function buildSimSpec(input: BuildSimSpecInput): SimSpec {
  const { twin, scope } = input;

  // Which lines are in scope. A line with no workstations is dropped: the
  // engine has nothing to run for it, and including it would put an
  // always-empty slot in every merged result.
  const candidates = (twin.lines ?? []).filter((l) => {
    if (scope.kind === 'line') return l.id === scope.id;
    return true;
  });

  const lines: SimSpecLine[] = [];
  for (const line of candidates) {
    const scoped = scopedTwinForLine(twin, line.id);
    if (scoped.workstations.length === 0) continue;
    const garmentId = line.garmentId ?? input.defaultGarmentId;
    lines.push({
      lineId: line.id,
      lineName: line.name,
      twin: scoped,
      garment: input.garmentsById[garmentId],
    });
  }

  return {
    lines,
    durationMin: input.durationMin,
    seed: input.seed,
    samplePeriodMin: input.samplePeriodMin ?? 1,
    // One line in scope is the case the animated floor is for, so record the
    // entity stream there and skip the memory cost on factory-wide runs.
    recordFlow: scope.kind === 'line' || lines.length === 1,
    warmupMin: Math.max(0, Math.min(input.warmupMin, input.durationMin - 1)),
    opEfficiency: input.opEfficiency,
  };
}

// ============================================================================
// STRUCTURAL FINGERPRINT
// ============================================================================

/** FNV-1a over a canonical string. Fast, stable, and good enough — a
 *  collision costs a stale frame pointer, not a wrong number. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Everything the engine reads off one workstation. */
function wsSignature(twin: Twin, wsId: string): string {
  const ws = twin.workstations.find((w) => w.id === wsId);
  if (!ws) return `${wsId}:missing`;
  const p = getBlockParams(ws);
  return [
    ws.id,
    getBlockKind(ws),
    // Cycle / rate / routing parameters.
    p.cycleS,
    p.servers,
    p.queueCapacity,
    p.sourceRatePerHr,
    p.passProb,
    p.capacity,
    p.batchSize,
    p.piecesPerAgent,
    JSON.stringify(p.cycleDist ?? null),
    JSON.stringify(p.arrivalDist ?? null),
    // Pool membership + op binding: both change what the engine resolves.
    ws.lineId ?? '',
    ws.operation?.opId ?? '',
    ws.operation?.garmentId ?? '',
    ws.operation?.bundleSize ?? '',
    ws.resources?.workersRequired ?? '',
    // NOT included, on purpose: position, rotation, name, props, kpiTargets,
    // kpiObserved. None of them reach the engine, and `kpiObserved` in
    // particular is WRITTEN BY a run — including it would make every run
    // invalidate itself.
  ].join('|');
}

function lineSignature(line: SimSpecLine): string {
  const { twin } = line;
  const ws = twin.workstations
    .map((w) => wsSignature(twin, w.id))
    .sort()
    .join(';');
  const conns = twin.connectors
    .map((c) => `${c.fromWsId}>${c.toWsId}>${c.fromPort ?? ''}>${c.toPort ?? ''}`)
    .sort()
    .join(';');
  const assigns = (twin.assignments ?? [])
    .map((a) => `${a.operatorId}@${a.wsId}:${a.role}:${a.shareFrac ?? ''}:${a.rotationOrder ?? ''}`)
    .sort()
    .join(';');
  const orders = (twin.orders ?? [])
    .map((o) => `${o.id}:${o.garmentId}:${o.quantity}`)
    .sort()
    .join(';');
  const meta = twin.lines
    .filter((l) => l.id === line.lineId)
    .map((l) => `${l.id}:${l.productionSystem}:${l.garmentId ?? ''}:${(l.orderSequence ?? []).join(',')}:${JSON.stringify(l.policy ?? null)}`)
    .join(';');
  return [line.lineId, line.garment?.id ?? '', meta, ws, conns, assigns, orders].join('#');
}

/**
 * Structural key for a spec. Equal keys ⇒ identical engine output.
 */
export function simSpecKey(spec: SimSpec): string {
  const body = [
    spec.durationMin,
    spec.seed,
    spec.samplePeriodMin,
    spec.recordFlow ? 'f1' : 'f0',
    spec.warmupMin,
    // Sorted so key order can't depend on object-key iteration order.
    JSON.stringify(
      Object.entries(spec.opEfficiency ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    ...spec.lines.map(lineSignature),
  ].join('~');
  return `${spec.lines.length}-${fnv1a(body)}`;
}

/** Convenience: key a scope + params without building the whole spec. Used by
 *  UI that wants to label the current run. */
export function describeSpec(spec: SimSpec, scope: SimScope): string {
  const n = spec.lines.length;
  return `${scopeToKey(scope)} · ${n} line${n === 1 ? '' : 's'} · ${spec.durationMin}min · seed ${spec.seed}`;
}
