/**
 * Model builder — twin → SimConfig. Lets the user simulate the factory they
 * authored in Factory Builder instead of an idealised line synthesised from a
 * raw garment template. Mirrors `buildSimConfig` (model.ts) in output shape so
 * `useSim` consumes the result with no engine changes.
 *
 * Inputs we read from the twin:
 *   • workstations[] — each with operation.opId, operation.bundleSize,
 *     resources.workersRequired, position, rotation.
 *   • connectors[] (kind='flow') — directed topology that determines the
 *     operation order when present. Otherwise we fall back to the garment
 *     template's natural precedence / array order.
 *
 * Multi-server collapse — multiple workstations on the same opId become one
 * engine station with N parallel servers. Their workersRequired counts seed
 * the page operator pool; positions are averaged for the renderer overlay.
 */

import type { GarmentTemplate, Operation } from '../domain';
import type { Twin, Workstation, SewingLine } from '../domain/twin';
import { wsBaseFootprint } from '../domain/twin';
import type { SimConfig } from './sim-state';
import type { ServiceDist, QueueDiscipline } from './index';
import type { ModelTimeUnit } from './timeUnit';

export interface SkippedWorkstation {
  wsId: string;
  name: string;
  reason: 'no-op-id' | 'unresolved-op-id';
}

/** Block.kind values that are wired into the engine as parameters (Source =
 *  arrival rate, ResourcePool = operator pool, Sink = drain) rather than
 *  ticking stations. These are part of the simulation by design and must not
 *  be reported as "skipped" — that's a user-error signal. */
const NON_SERVICE_BLOCK_KINDS = new Set([
  'Source',
  'Sink',
  'ResourcePool',
  'Queue',
  'Hold',
  'Wait',
  'Seize',
  'Release',
  'SelectOutput',
  'SelectOutput5',
]);

export interface InfraWorkstation {
  wsId: string;
  name: string;
  /** What role the block plays in the engine wiring. */
  role: 'Source' | 'Sink' | 'ResourcePool' | 'Queue' | 'Hold' | 'Wait' | 'Seize' | 'Release' | 'SelectOutput' | 'SelectOutput5';
}

/** Per-opId aggregation: which workstations, mean position, summed workers. */
export interface TwinStationMeta {
  opId: string;
  wsIds: string[];
  /** Mean grid position across the workstations on this op. */
  gx: number;
  gy: number;
  /** Pre-aggregation workers requested in Builder. */
  workersRequested: number;
}

/** One physical workstation kept in the simulation, with its authored Builder
 *  coords. Many cells can share an `opId` — the engine collapses them into one
 *  multi-server station, but the renderer can still place each cell at its
 *  own floor position so the sim view reads like the factory the user built. */
export interface TwinWorkstationCell {
  wsId: string;
  opId: string;
  /** World-cell coords from Builder (top-left of the workstation footprint). */
  gx: number;
  gy: number;
  /** 0/90/180/270, in case the renderer wants to honour rotation. */
  rotation: number;
  /** Catalogue id, so the Run floor draws the same sprite Builder does. */
  catalogId: string;
  /** UNROTATED catalogue extent in world cells (`wsBaseFootprint`), size
   *  override included. Carried rather than re-derived so a renderer never
   *  has to reach back into the store for the twin — and so the Run floor
   *  cannot invent a footprint of its own, which is exactly what it used to
   *  do (every station was 0.9 x 1.4 whatever machine it was). */
  w: number;
  d: number;
  h: number;
  /** Which sewing line this cell belongs to (when the twin defines lines). */
  lineId?: string;
  /** Workstation display name from Builder. */
  name: string;
}

export interface BuildFromTwinMeta {
  /** Workstations that participated in the simulation, in operation order. */
  simulatedWsIds: string[];
  /** Workstations dropped because of a user error (no opId on a Service block,
   *  or an opId that doesn't resolve in the chosen garment). */
  skipped: SkippedWorkstation[];
  /** Non-Service blocks that are wired into the engine as parameters rather
   *  than ticking stations: Source feeds arrivals, ResourcePool seeds the
   *  operator pool, Sink drains finished pieces, etc. These are intentional
   *  parts of the simulation, not dropped workstations. */
  infrastructure: InfraWorkstation[];
  /** Default operator-pool size — sum of workersRequired across simulated ws. */
  seedOperators: number;
  /** Default bundle-size — rounded mean across simulated ws' operation.bundleSize. */
  seedBundleSize: number;
  /** How the operation sequence was derived. */
  topologySource: 'connectors' | 'opIdPrecedence';
  /** Per-engine-station extras the renderer needs to honour Builder positions. */
  stations: TwinStationMeta[];
  /** Per-physical-workstation cells in operation order. The renderer uses this
   *  to draw one box per machine the user placed in Builder — preserves the
   *  spatial structure of the floor that `stations[]` collapses away. */
  workstations: TwinWorkstationCell[];
  /** Garment template chosen as the dominant context for this run. */
  garment: GarmentTemplate;
  /** True when the chosen garment was inferred from a workstation pin (a
   *  workstation carries `operation.garmentId`). False when no workstation
   *  pinned a garment and the run fell back to the project default — in that
   *  case the UI's GARMENT dropdown is still a meaningful knob. */
  garmentPinned: boolean;
}

export interface BuildFromTwinOptions {
  /** Active twin from `useTwin(selectActiveTwin)`. */
  twin: Twin;
  /** Map of all known garment templates (built-in + project edits). */
  garmentsById: Record<string, GarmentTemplate>;
  /** Fallback garment when a workstation didn't pin one. */
  defaultGarmentId: string;
  /** Per-op efficiency map from `efficiencyFromSkillMatrix`. */
  opEfficiency?: Record<string, number>;
  modelTimeUnit?: ModelTimeUnit;
  smvVariance?: number;
  randomSeed?: number;
  arrivalRatePerHour?: number;
  /** When set, only workstations whose `lineId` matches are considered. The
   *  rest are filtered out of the build so the engine runs as a single-line
   *  tandem network — the multi-line LiveSim view picks one line at a time. */
  lineId?: string;
}

export interface BuildFromTwinResult {
  config: SimConfig;
  meta: BuildFromTwinMeta;
}

/**
 * Build a runnable SimConfig from the twin's workstations and connectors.
 *
 * Throws when the twin has no workstation that resolves to a known operation
 * — the caller (Builder button / LiveSim) should guard against this with a
 * disabled-state tooltip or an empty-state panel.
 */
export function buildSimConfigFromTwin(opts: BuildFromTwinOptions): BuildFromTwinResult {
  const { twin, garmentsById, defaultGarmentId, lineId } = opts;

  // Filter to a single sewing line when one is requested. Everything else
  // (garment-detection, op classification, server collapse) then runs on the
  // narrowed set as if the line were its own factory.
  const scopedWs = lineId
    ? twin.workstations.filter((w) => w.lineId === lineId)
    : twin.workstations;

  // ── Step 1: pick the dominant garment ─────────────────────────────────
  // When multiple workstations reference different garmentIds, the most-
  // common wins; ties fall back to the default. The engine is single-product
  // by design — one garment per run is honest to the current capability.
  const garmentCounts = new Map<string, number>();
  // If the caller pinned a line, prefer the line's authored `garmentId` so a
  // skeleton line (no opIds assigned yet) still reports the right product.
  if (lineId) {
    const line = (twin.lines ?? []).find((l) => l.id === lineId);
    if (line?.garmentId && garmentsById[line.garmentId]) {
      garmentCounts.set(line.garmentId, 1);
    }
  }
  for (const ws of scopedWs) {
    const gid = ws.operation.garmentId;
    if (gid && garmentsById[gid]) {
      garmentCounts.set(gid, (garmentCounts.get(gid) ?? 0) + 1);
    }
  }
  let chosenGarmentId = defaultGarmentId;
  let bestCount = 0;
  for (const [gid, count] of garmentCounts) {
    if (count > bestCount) {
      bestCount = count;
      chosenGarmentId = gid;
    }
  }
  const garment =
    garmentsById[chosenGarmentId] ?? garmentsById[defaultGarmentId];
  if (!garment) {
    throw new Error(`buildSimConfigFromTwin: no garment template found (chosen=${chosenGarmentId}, default=${defaultGarmentId})`);
  }
  const opById: Record<string, Operation> = {};
  for (const op of garment.operations) opById[op.id] = op;

  // ── Step 2: classify each workstation ─────────────────────────────────
  // - kept: a Service block whose opId resolves in the chosen garment.
  // - infrastructure: Source / Sink / ResourcePool / Queue / etc — these
  //   are part of the engine wiring (arrival rate, operator pool, drain),
  //   not ticking stations, so they're never expected to have an opId.
  // - skipped: a Service block where the user forgot to assign an opId,
  //   or the assigned op belongs to a different garment template.
  const kept: Workstation[] = [];
  const infrastructure: InfraWorkstation[] = [];
  const skipped: SkippedWorkstation[] = [];
  for (const ws of scopedWs) {
    const blockKind = ws.block?.kind;
    if (blockKind && NON_SERVICE_BLOCK_KINDS.has(blockKind)) {
      infrastructure.push({
        wsId: ws.id,
        name: ws.name,
        role: blockKind as InfraWorkstation['role'],
      });
      continue;
    }
    if (!ws.operation.opId) {
      skipped.push({ wsId: ws.id, name: ws.name, reason: 'no-op-id' });
      continue;
    }
    if (!opById[ws.operation.opId]) {
      skipped.push({ wsId: ws.id, name: ws.name, reason: 'unresolved-op-id' });
      continue;
    }
    kept.push(ws);
  }

  if (kept.length === 0) {
    throw new Error('buildSimConfigFromTwin: no simulatable workstations (assign an operation to at least one workstation in Builder).');
  }

  // ── Step 3: group by opId, average positions, sum workers ─────────────
  const byOpId = new Map<string, Workstation[]>();
  for (const ws of kept) {
    const opId = ws.operation.opId!;
    const arr = byOpId.get(opId) ?? [];
    arr.push(ws);
    byOpId.set(opId, arr);
  }

  // ── Step 4: determine operation order ─────────────────────────────────
  // Connector path wins when any flow edge exists in the twin. Otherwise
  // fall back to the garment template's array order (which already
  // encodes `precedes`/`follows`).
  // When scoped to a single line, restrict flow edges to those whose endpoints
  // are both inside the kept set — otherwise stray cross-line edges would
  // pollute the topo-sort.
  const keptIds = new Set(kept.map((w) => w.id));
  const flowEdges = twin.connectors
    .filter((c) => c.kind === 'flow')
    .filter((c) => !lineId || (keptIds.has(c.fromWsId) && keptIds.has(c.toWsId)));
  let orderedOpIds: string[];
  let topologySource: 'connectors' | 'opIdPrecedence';
  if (flowEdges.length > 0) {
    orderedOpIds = topoSortByConnectors(kept, flowEdges, byOpId);
    topologySource = 'connectors';
  } else {
    // Filter the garment's natural operation list down to the opIds the user
    // actually placed. Preserves the bulletin's precedence implicitly.
    orderedOpIds = garment.operations
      .map((o) => o.id)
      .filter((id) => byOpId.has(id));
    topologySource = 'opIdPrecedence';
  }

  // ── Step 5: build engine arrays in operation order ────────────────────
  const operations: Operation[] = [];
  const stationServers: number[] = [];
  const stations: TwinStationMeta[] = [];
  const workstations: TwinWorkstationCell[] = [];
  const serviceDistributions: (ServiceDist | undefined)[] = [];
  const stationCapacities: (number | undefined)[] = [];
  const queueDisciplines: (QueueDiscipline | undefined)[] = [];

  let totalWorkers = 0;
  const bundleSizeSamples: number[] = [];

  // Distinct operator IDs (via `Assignment` rows) per workstation. Drives
  // the queue analysis's `c` so it matches the operator badges the Builder
  // renders on each tile. Falls back to `workersRequired` when no
  // assignment row exists, which matches the legacy implicit-assignment
  // path for older twins.
  const assignedByWs = new Map<string, Set<string>>();
  for (const a of opts.twin.assignments ?? []) {
    if (a.role === 'floater') continue;
    const set = assignedByWs.get(a.wsId) ?? new Set<string>();
    set.add(a.operatorId);
    assignedByWs.set(a.wsId, set);
  }
  const operatorsAtWs = (ws: Workstation): number => {
    const assigned = assignedByWs.get(ws.id)?.size ?? 0;
    if (assigned > 0) return assigned;
    return Math.max(1, ws.resources.workersRequired ?? 1);
  };

  for (const opId of orderedOpIds) {
    const op = opById[opId];
    const wsList = byOpId.get(opId) ?? [];
    if (wsList.length === 0) continue;

    operations.push(op);
    // c = sum of operators across every workstation on this op. Each
    // operator can run one machine in parallel, so the queue-theory c
    // matches what the Builder visualises on the tiles. Earlier this was
    // `wsList.length`, which silently dropped the operator count when a
    // workstation carried `workersRequired > 1` (multi-operator helper
    // bench) and overcounted when `workersRequired = 0` (the station was
    // unstaffed). Both cases broke the Reports-vs-OB validation.
    const cForOp = wsList.reduce((s, ws) => s + operatorsAtWs(ws), 0);
    stationServers.push(Math.max(1, cForOp));

    let workersAtOp = 0;
    let sumX = 0;
    let sumY = 0;
    for (const ws of wsList) {
      const w = operatorsAtWs(ws);
      workersAtOp += w;
      sumX += ws.position.x;
      sumY += ws.position.y;
      const bs = ws.operation.bundleSize;
      if (bs && bs > 0) bundleSizeSamples.push(bs);
      const fp = wsBaseFootprint(ws);
      workstations.push({
        wsId: ws.id,
        opId,
        gx: ws.position.x,
        gy: ws.position.y,
        rotation: ws.rotation ?? 0,
        catalogId: ws.catalogId,
        w: fp.w,
        d: fp.d,
        h: fp.h,
        lineId: ws.lineId,
        name: ws.name,
      });
    }
    totalWorkers += workersAtOp;
    stations.push({
      opId,
      wsIds: wsList.map((w) => w.id),
      gx: sumX / wsList.length,
      gy: sumY / wsList.length,
      workersRequested: workersAtOp,
    });

    serviceDistributions.push(op.serviceDistribution);
    stationCapacities.push(op.queueCapacity);
    queueDisciplines.push(op.queueDiscipline);
  }

  // ── Step 6: arrival rate from bottleneck cycle, honouring efficiency ──
  const eff = (id: string) => opts.opEfficiency?.[id] ?? 1;
  const effSmv = (id: string, smv: number) => (eff(id) > 0 ? smv / eff(id) : smv);
  const bottleneckCycle = Math.max(
    ...operations.map((op, i) => effSmv(op.id, op.smv) / stationServers[i]),
  );
  const seedBundleSize =
    bundleSizeSamples.length > 0
      ? Math.max(1, Math.round(bundleSizeSamples.reduce((s, v) => s + v, 0) / bundleSizeSamples.length))
      : garment.defaultBundleSize;
  const piecesPerHour = bottleneckCycle > 0 ? 60 / bottleneckCycle : 0;
  const bundlesPerHour = piecesPerHour / Math.max(1, seedBundleSize);
  const arrivalRatePerHour = opts.arrivalRatePerHour ?? bundlesPerHour * 1.1;

  const config: SimConfig = {
    garmentTemplateId: garment.id,
    operations,
    stationServers,
    bundleSize: seedBundleSize,
    arrivalRatePerHour,
    smvVariance: opts.smvVariance ?? 0.15,
    randomSeed: opts.randomSeed ?? 42,
    opEfficiency: opts.opEfficiency,
    serviceDistributions,
    stationCapacities,
    queueDisciplines,
    modelTimeUnit: opts.modelTimeUnit ?? 'minute',
  };

  // Seed operators — prefer distinct assignment-driven operator count when
  // the twin carries assignments. Falls back to `workersRequired` sums for
  // legacy twins. After a SHARE gesture the assignment count goes down
  // even though `workersRequired` doesn't; without this branch the engine
  // pool would be inflated relative to the staffing the user authored.
  const distinctAssignedOps = (() => {
    const wsSet = new Set(kept.map((w) => w.id));
    const ops = new Set<string>();
    for (const a of twin.assignments ?? []) {
      if (wsSet.has(a.wsId)) ops.add(a.operatorId);
    }
    return ops.size;
  })();
  const seedOperatorsForMeta = distinctAssignedOps > 0 ? distinctAssignedOps : totalWorkers;

  const meta: BuildFromTwinMeta = {
    simulatedWsIds: kept.map((w) => w.id),
    skipped,
    infrastructure,
    seedOperators: seedOperatorsForMeta,
    seedBundleSize,
    topologySource,
    stations,
    workstations,
    garment,
    garmentPinned: bestCount > 0,
  };

  return { config, meta };
}

/**
 * Topological sort of the kept workstations' opIds by flow connectors.
 * Collapses workstation-level edges to opId-level edges, then Kahn-sorts.
 * On a cycle (or disconnected sub-graphs) we fall back to garment-template
 * array order for the unplaced opIds so the run still proceeds.
 */
function topoSortByConnectors(
  kept: Workstation[],
  flowEdges: { fromWsId: string; toWsId: string }[],
  byOpId: Map<string, Workstation[]>,
): string[] {
  const wsToOp = new Map<string, string>();
  for (const ws of kept) wsToOp.set(ws.id, ws.operation.opId!);

  // Build a unique opId-level edge set, skipping self-loops.
  const adj = new Map<string, Set<string>>();
  const inDeg = new Map<string, number>();
  for (const op of byOpId.keys()) {
    adj.set(op, new Set());
    inDeg.set(op, 0);
  }
  for (const e of flowEdges) {
    const from = wsToOp.get(e.fromWsId);
    const to = wsToOp.get(e.toWsId);
    if (!from || !to || from === to) continue;
    const set = adj.get(from)!;
    if (!set.has(to)) {
      set.add(to);
      inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
    }
  }

  // Kahn's algorithm — process nodes with in-degree 0, peel back.
  const queue: string[] = [];
  for (const [op, deg] of inDeg) if (deg === 0) queue.push(op);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const op = queue.shift()!;
    ordered.push(op);
    for (const next of adj.get(op) ?? []) {
      const d = (inDeg.get(next) ?? 0) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // Cycle remnant — append any unprocessed opIds in their natural order so
  // the run doesn't drop stations silently.
  if (ordered.length < byOpId.size) {
    for (const op of byOpId.keys()) {
      if (!ordered.includes(op)) ordered.push(op);
    }
  }
  return ordered;
}

// ============================================================================
// MULTI-LINE — build one SimConfig per sewing line in the twin
// ============================================================================

export interface LineBuild {
  line: SewingLine;
  build: BuildFromTwinResult;
  /** True when this line built cleanly. False when no workstation under the
   *  line resolved to a known operation — the LiveSim panel still surfaces
   *  the line so the user knows it's there, but can't run it yet. */
  ok: boolean;
  reason?: string;
}

/**
 * Build per-line configs for every sewing line in the twin. Useful for the
 * LiveSim "ALL LINES" view, where each line becomes its own KPI card driven
 * by its own analytical model. Lines with no simulatable workstation report
 * back with `ok: false` so the UI can render a placeholder card instead of
 * blowing up.
 */
export function buildLinesFromTwin(
  opts: Omit<BuildFromTwinOptions, 'lineId'>,
): LineBuild[] {
  const out: LineBuild[] = [];
  for (const line of opts.twin.lines ?? []) {
    try {
      const build = buildSimConfigFromTwin({ ...opts, lineId: line.id });
      out.push({ line, build, ok: true });
    } catch (err) {
      out.push({
        line,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        // Empty stand-in so consumers can read `.build.meta.simulatedWsIds.length`
        // without a null check.
        build: {
          config: {
            garmentTemplateId: '',
            operations: [],
            stationServers: [],
            bundleSize: 1,
            arrivalRatePerHour: 0,
            smvVariance: 0,
            randomSeed: 0,
          },
          meta: {
            simulatedWsIds: [],
            skipped: [],
            infrastructure: [],
            seedOperators: 0,
            seedBundleSize: 0,
            topologySource: 'opIdPrecedence',
            stations: [],
            workstations: [],
            garment: opts.garmentsById[opts.defaultGarmentId] ?? Object.values(opts.garmentsById)[0],
            garmentPinned: false,
          },
        },
      });
    }
  }
  return out;
}
