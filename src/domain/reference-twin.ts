/**
 * Reference-twin builder — turns a published case study (ReferenceModel)
 * into a runnable Stitchworks Twin so the PML engine can reproduce the
 * paper's KPIs.
 *
 * One ReferenceModel → two twins:
 *   • variant 'baseline' — pool capacity = paper's baseline operator count
 *   • variant 'proposed' — pool capacity = paper's proposed operator count
 *
 * Layout: a single Sewing-line department with the 21 (or N) ops laid
 * out left-to-right in row-wrapped order. A Source feeds the first op,
 * the last op drains into a Sink, and a ResourcePool block carries the
 * operator capacity that all Service blocks in the dept seize against.
 *
 * The engine's `runPmlOnTwin(twin, …)` consumes the result unchanged —
 * no wiring change in the Builder is needed to run a reference twin.
 */

import type { Operation } from './operations';
import type { GarmentTemplate } from './garments';
import { type ReferenceModel, type ReferenceScenario } from './reference-models';
import {
  type Twin,
  type Workstation,
  type Department,
  type Connector,
  type SewingLine,
  type TwinSchemaVersion,
  TWIN_SCHEMA_VERSION,
  defaultPolicyFor,
  newTwinId,
  newDeptId,
  newLineId,
  newConnectorId,
  makeWorkstation,
} from './twin';
import { defaultPropsFor } from './iso';
import {
  defaultDist,
  distFromOpNotes,
  syntheticTriangular,
  type ServiceDist,
} from '../simulation/distributions';

// ============================================================================
// MACHINE CODE → ISO CATALOG ID
// ============================================================================

/**
 * Map a paper's machine code (DNL, SNL, 5OL, 4OL, FB, MNL, …) onto the
 * iso fixture catalog id Stitchworks understands. Unknown codes fall back
 * to the single-needle lock so the line still runs — the user can pick a
 * better fixture from the Inspector afterwards.
 */
export function catalogForMachine(code: string): string {
  switch (code.toUpperCase()) {
    case 'DNL':
    case 'DNLS': return 'a_dnls';
    case 'SNL':
    case 'SNLS': return 'a_snls';
    case '5OL':  return 'a_5ol';
    case '4OL':  return 'a_4ol';
    case '3OL':  return 'a_3ol';
    case 'FB':
    case 'FOA':  return 'a_foa';
    case 'BT':   return 'a_bartack';
    case 'BH':   return 'a_buttonhole';
    case 'BS':   return 'a_buttonsew';
    case 'FL':   return 'a_flatlock';
    case 'KS':
    case 'KANSAI': return 'a_kansai';
    case 'PRESS': return 'fx_press';
    case 'INSP':  return 'fx_qctab';
    case 'MNL':   return 'fx_table';
    default:      return 'a_snls';
  }
}

// ============================================================================
// BUILD
// ============================================================================

export type ReferenceVariant = 'baseline' | 'proposed';

/**
 * How the builder attaches per-operation variability.
 *
 *   - 'deterministic' — every Service runs at the mean SMV. Source uses a
 *     constant inter-arrival interval. Matches the pre-randomness engine.
 *   - 'paper-fits'    — when the paper's StatFit-style notes are present
 *     (e.g. `TRIA(0.28, 0.313, 0.46)`, `0.5 + WEIB(...)`), parse them and
 *     use them as the Service-cycle distribution. Falls back to a ±25 %
 *     triangular when notes are absent. Source is exponential (Poisson).
 *   - 'synthetic'     — every op gets a ±25 % triangular around its mean
 *     SMV regardless of notes, useful for papers that don't publish fits.
 */
export type ReferenceRandomness = 'deterministic' | 'paper-fits' | 'synthetic';

export interface BuildReferenceTwinOpts {
  /** Which top-level variant from the paper to build. Defaults to 'baseline'. */
  variant?: ReferenceVariant;
  /** Optional — when the paper has multiple what-if scenarios listed under
   *  `model.scenarios`, pass the scenario id here to size the operator pool
   *  to that scenario's count. Wins over `variant` when both are set. */
  scenarioId?: string;
  /** Override the twin name. Defaults to "<paper title> · <variant>". */
  name?: string;
  /**
   * Stochastic mode. Defaults to `'paper-fits'` so reproducing a paper
   * automatically uses its published distributions when available. Pass
   * `'deterministic'` to recover the legacy mean-SMV behaviour for an
   * A/B comparison.
   */
  randomness?: ReferenceRandomness;
}

/**
 * Resolve the per-operation cycle distribution for a Service block,
 * honouring the requested randomness mode and the paper's published fits.
 * Returns undefined when the engine should fall back to deterministic
 * service (constant `cycleS`).
 */
function resolveOpDist(op: Operation, mode: ReferenceRandomness): ServiceDist | undefined {
  if (mode === 'deterministic') return undefined;
  const parsed = mode === 'paper-fits' ? distFromOpNotes(op.notes) : null;
  if (parsed) return parsed;
  return syntheticTriangular(op.smv);
}

/** Resolve which set of paper KPIs the caller is asking for, given the
 *  variant / scenarioId combination. Falls back gracefully when fields
 *  are missing. */
function resolveScenarioKpis(
  model: ReferenceModel,
  opts: BuildReferenceTwinOpts,
): {
  operators: number;
  scenario: ReferenceScenario | null;
  variant: ReferenceVariant;
  label: string;
} {
  const variant: ReferenceVariant = opts.variant ?? 'baseline';
  if (opts.scenarioId && model.scenarios) {
    const s = model.scenarios.find((x) => x.id === opts.scenarioId);
    if (s) return { operators: s.operators, scenario: s, variant, label: s.id };
  }
  const kpis = variant === 'proposed' && model.proposed ? model.proposed : model.baseline;
  return {
    operators: kpis.operators,
    scenario: null,
    variant,
    label: variant === 'proposed' ? 'Proposed' : 'Baseline',
  };
}

/**
 * Build a Twin that reproduces one variant of a published reference model.
 * Returns null when the model carries no operation bulletin (placeholder
 * papers where the bulletin is not enumerated in the source).
 */
export function buildReferenceTwin(
  model: ReferenceModel,
  opts: BuildReferenceTwinOpts = {},
): Twin | null {
  const ops = model.garmentTemplate.operations;
  if (ops.length === 0) return null;

  const resolved = resolveScenarioKpis(model, opts);
  const variant = resolved.variant;
  const operatorCount = resolved.operators;
  const scenario = resolved.scenario;
  const totalSmv = model.garmentTemplate.totalSmv;
  // Default to the paper's published distributions when present. Pass
  // `randomness: 'deterministic'` from the Reference Models page to compare
  // against the legacy mean-SMV engine.
  const randomness: ReferenceRandomness = opts.randomness ?? 'paper-fits';

  const now = new Date().toISOString();

  // ── Layout grid ──────────────────────────────────────────────────────────
  // Wrap N ops into rows of up to STATIONS_PER_ROW. Each station is 1×2
  // (matching the sewing-machine fixture footprint) with 2-cell spacing,
  // so a 7-station row spans ~21 cells horizontally.
  const STATIONS_PER_ROW = 7;
  const STATION_DX = 3;
  const ROW_DY = 4;
  const ORIGIN_X = 3;
  const ORIGIN_Y = 6;
  const rowCount = Math.ceil(ops.length / STATIONS_PER_ROW);

  const gridW = Math.max(36, ORIGIN_X + STATIONS_PER_ROW * STATION_DX + 4);
  const gridH = Math.max(28, ORIGIN_Y + rowCount * ROW_DY + 8);

  // ── Departments ──────────────────────────────────────────────────────────
  // One sewing-line department wide enough to enclose every station + the
  // Source / Sink / Pool plumbing. A second narrow "Plumbing" lane up top
  // hosts the lifecycle blocks so they read as scaffolding.
  const dSew = newDeptId();
  const dPlumb = newDeptId();
  const departments: Department[] = [
    {
      id: dPlumb,
      name: 'Plumbing',
      kind: 'Logistics',
      color: 'cream',
      bounds: { x: 1, y: 1, w: gridW - 2, h: 4 },
      notes: 'Source · Sink · operator pool. Auto-generated by the reference-twin builder.',
    },
    {
      id: dSew,
      name: `Sewing line — ${model.title}`,
      kind: 'Sewing',
      color: 'blue',
      bounds: {
        x: 1,
        y: 5,
        w: gridW - 2,
        h: rowCount * ROW_DY + 4,
      },
      notes:
        `${ops.length} ops · total SMV ${totalSmv.toFixed(2)} min · ` +
        `${operatorCount} operators (${variant}).`,
    },
  ];

  // ── Workstations ─────────────────────────────────────────────────────────
  const workstations: Workstation[] = [];

  // Source at the top-left of the plumbing strip. Pumps pieces in at a rate
  // sized to fully load the line (1.2× the theoretical takt). Each piece is
  // a single garment (piecesPerAgent = 1) — the Hossain paper releases a
  // bundle of 36 every 10 min, which works out to ~216/hr; we round to a
  // slightly higher rate so the line is never starved and the bottleneck
  // op governs throughput.
  const takt = totalSmv / ops.length; // min per piece if perfectly balanced
  const sourceRatePerHr = Math.max(60, Math.round((60 / takt) * 1.5));
  const wsSource = makeWorkstation({
    deptId: dPlumb,
    catalogId: 'buf_in',
    position: { x: 2, y: 2 },
    name: 'Source — orders in',
  });
  wsSource.block = {
    kind: 'Source',
    params: {
      sourceRatePerHr,
      piecesPerAgent: 1,
      // AnyLogic-default Poisson arrivals when stochastic, constant interval
      // otherwise. The exponential's mean matches the deterministic gap so
      // the offered load stays consistent across modes.
      arrivalDist:
        randomness === 'deterministic'
          ? undefined
          : { kind: 'exp', mean: 60 / Math.max(0.001, sourceRatePerHr) },
    },
  };
  wsSource.operation = {
    ...wsSource.operation,
    freeText:
      randomness === 'deterministic'
        ? `${sourceRatePerHr} pcs/hr · deterministic interval`
        : `${sourceRatePerHr} pcs/hr · exponential (Poisson) arrivals`,
  };
  workstations.push(wsSource);

  // ResourcePool — one block whose capacity equals the paper's operator
  // count. Every Service block in the Sewing-line dept seizes against the
  // dept's combined pool; placing the pool in the *sewing* dept (not
  // plumbing) is what binds it.
  const wsPool = makeWorkstation({
    deptId: dSew,
    catalogId: 'op_sewer',
    position: { x: 2, y: 2 + ROW_DY * rowCount + 2 < gridH - 2 ? ORIGIN_Y + rowCount * ROW_DY : gridH - 3 },
    name: `Operators · ${operatorCount} units`,
  });
  wsPool.block = {
    kind: 'ResourcePool',
    params: { capacity: operatorCount },
  };
  workstations.push(wsPool);

  // Sink at the top-right of the plumbing strip.
  const wsSink = makeWorkstation({
    deptId: dPlumb,
    catalogId: 'buf_out',
    position: { x: gridW - 4, y: 2 },
    name: 'Sink — finished pcs',
  });
  wsSink.block = { kind: 'Sink' };
  workstations.push(wsSink);

  // Per-op machine count (1-based). Starts from the paper's "Qty" column —
  // the variant or scenario base — then layers scenario reinforcements on top.
  // Scenarios are framed as deltas off the baseline in the literature, so
  // they merge against baseline.machineQtyByOp1 rather than the variant's.
  const baseQty: number[] = scenario
    ? (model.baseline.machineQtyByOp1 ?? new Array(ops.length).fill(1))
    : (variant === 'proposed' && model.proposed?.machineQtyByOp1
        ? model.proposed.machineQtyByOp1
        : (model.baseline.machineQtyByOp1 ?? new Array(ops.length).fill(1)));
  const serversByIdx1: number[] = ops.map((_, i) => Math.max(1, baseQty[i] ?? 1));
  if (scenario?.reinforcedOpIndices) {
    for (const idx1 of scenario.reinforcedOpIndices) {
      if (idx1 >= 1 && idx1 <= serversByIdx1.length) {
        serversByIdx1[idx1 - 1] += 1;
      }
    }
  }

  // Per-op Service stations.
  const opStations: Workstation[] = [];
  ops.forEach((op: Operation, i) => {
    const row = Math.floor(i / STATIONS_PER_ROW);
    const col = i % STATIONS_PER_ROW;
    // Snake rows so the sequential flow zig-zags rather than jumping
    // back to x=ORIGIN_X at every row break — keeps connectors short.
    const colInRow = row % 2 === 0 ? col : STATIONS_PER_ROW - 1 - col;
    const x = ORIGIN_X + colInRow * STATION_DX;
    const y = ORIGIN_Y + row * ROW_DY;

    const catalogId = catalogForMachine(op.machineCode);
    const stationServers = serversByIdx1[i];
    const ws = makeWorkstation({
      deptId: dSew,
      catalogId,
      position: { x, y },
      name: stationServers > 1
        ? `${i + 1}. ${op.name} (×${stationServers})`
        : `${i + 1}. ${op.name}`,
    });
    const cycleDist = resolveOpDist(op, randomness);
    ws.block = {
      kind: 'Service',
      params: {
        cycleS: Math.max(1, Math.round(op.smv * 60)),
        servers: stationServers,
        cycleDist,
        // Bake the authored system capacity into the twin so the DES honours
        // the SAME finite buffer the analytical M/M/c/K model reads off the
        // operation. 0 ⇒ unbounded (the default). See systemCapacityFor.
        queueCapacity: op.queueCapacity ?? 0,
      },
    };
    ws.operation = {
      ...ws.operation,
      opId: op.id,
      garmentId: model.garmentTemplate.id,
      bundleSize: model.garmentTemplate.defaultBundleSize,
      freeText: op.notes ?? `SMV ${op.smv.toFixed(3)} min`,
    };
    // Targets used by Reports' efficiency math.
    ws.kpiTargets = {
      ...ws.kpiTargets,
      capacityPerHr: op.smv > 0 ? Math.round((60 / op.smv) * stationServers) : undefined,
    };
    // Author the catalog props so the Inspector shows the per-op SMV.
    ws.props = {
      ...defaultPropsFor(catalogId),
      ...ws.props,
      cycle_s: Math.round(op.smv * 60),
      servers: stationServers,
    };
    workstations.push(ws);
    opStations.push(ws);
  });

  // ── Connectors ───────────────────────────────────────────────────────────
  // Source → Op1 → Op2 → … → OpN → Sink.
  const connectors: Connector[] = [];
  function link(fromWs: Workstation, toWs: Workstation): void {
    connectors.push({
      id: newConnectorId(),
      kind: 'flow',
      fromWsId: fromWs.id,
      toWsId: toWs.id,
    });
  }
  if (opStations.length > 0) {
    link(wsSource, opStations[0]);
    for (let i = 0; i < opStations.length - 1; i++) {
      link(opStations[i], opStations[i + 1]);
    }
    link(opStations[opStations.length - 1], wsSink);
  }

  // ── Twin ─────────────────────────────────────────────────────────────────
  // As in `buildGarmentTwin`: a bulletin-derived twin is a sewing line, so it
  // gets one, and every workstation carries the same lineId (see the note
  // there about operator pools and Source order sequences).
  const refLine: SewingLine = {
    id: newLineId(),
    deptId: dSew,
    name: 'Line 1',
    productionSystem: 'PBS',
    garmentId: model.garmentTemplate.id,
    color: 'blue',
    operatorTarget: operatorCount,
    policy: defaultPolicyFor('PBS'),
  };
  for (const ws of workstations) ws.lineId = refLine.id;

  const variantLabel = scenario ? `${scenario.id} (${scenario.name})` : resolved.label;
  const name = opts.name ?? `${model.title} · ${variantLabel}`;
  const paperKpis = scenario
    ? {
        operators: scenario.operators,
        throughputPerDayPcs: scenario.throughputPerDayPcs as number | undefined,
        lineEfficiencyPct: undefined as number | undefined,
      }
    : variant === 'proposed' && model.proposed
      ? model.proposed
      : model.baseline;
  const twin: Twin = {
    schemaVersion: TWIN_SCHEMA_VERSION as TwinSchemaVersion,
    id: newTwinId(),
    name,
    parentTwinId: null,
    isCanonical: true,
    createdAt: now,
    modifiedAt: now,
    gridW,
    gridH,
    departments,
    lines: [refLine],
    workstations,
    connectors,
    notes:
      `Auto-built from ${model.authorYear}. ${model.citation}\n\n` +
      `Variant: ${variantLabel}. ` +
      `Paper KPIs — operators ${paperKpis.operators}` +
      (paperKpis.throughputPerDayPcs ? ` · ${paperKpis.throughputPerDayPcs} pcs/day` : '') +
      (paperKpis.lineEfficiencyPct ? ` · line eff ${paperKpis.lineEfficiencyPct.toFixed(2)} %` : '') +
      (scenario?.reinforcedOpIndices?.length
        ? `\nReinforced ops (per paper): ${scenario.reinforcedOpIndices.join(', ')}.`
        : '') +
      '.',
  };

  return twin;
}

// ============================================================================
// GARMENT-TEMPLATE TWIN (Source → ops → Sink, sized by operator pool)
// ============================================================================

/**
 * Build a Twin from any GarmentTemplate + operator pool size. Mirrors
 * `buildReferenceTwin`'s layout (Source · Pool · Sink + per-op Service
 * stations laid out in snake rows) but without the paper-specific
 * scenario/reinforcement plumbing, so the LiveSim PML view can render
 * the project's selected garment without needing a reference paper.
 *
 * Returns null when the template carries no operations.
 */
export function buildGarmentTwin(
  garment: GarmentTemplate,
  operators: number,
  name?: string,
): Twin | null {
  const ops = garment.operations;
  if (ops.length === 0) return null;

  const totalSmv = garment.totalSmv;
  const now = new Date().toISOString();

  const STATIONS_PER_ROW = 7;
  const STATION_DX = 3;
  const ROW_DY = 4;
  const ORIGIN_X = 3;
  const ORIGIN_Y = 6;
  const rowCount = Math.ceil(ops.length / STATIONS_PER_ROW);

  const gridW = Math.max(36, ORIGIN_X + STATIONS_PER_ROW * STATION_DX + 4);
  const gridH = Math.max(28, ORIGIN_Y + rowCount * ROW_DY + 8);

  const dSew = newDeptId();
  const dPlumb = newDeptId();
  const departments: Department[] = [
    {
      id: dPlumb,
      name: 'Plumbing',
      kind: 'Logistics',
      color: 'cream',
      bounds: { x: 1, y: 1, w: gridW - 2, h: 4 },
      notes: 'Source · Sink · operator pool. Auto-generated from the selected garment.',
    },
    {
      id: dSew,
      name: `Sewing line — ${garment.name}`,
      kind: 'Sewing',
      color: 'blue',
      bounds: { x: 1, y: 5, w: gridW - 2, h: rowCount * ROW_DY + 4 },
      notes:
        `${ops.length} ops · total SMV ${totalSmv.toFixed(2)} min · ${operators} operators.`,
    },
  ];

  const workstations: Workstation[] = [];

  // Arrival rate must be FEASIBLE for the line, which means it is set by the
  // BOTTLENECK operation, not by the average one.
  //
  // This previously used `(60 / (totalSmv / ops.length)) × 1.5` — the mean
  // station rate, inflated 50 %. On the T-shirt bulletin that offers 289
  // pcs/hr to a line whose slowest operation (0.70 min) caps it at 86 pcs/hr.
  // ρ > 1 at the bottleneck means its queue grows without bound: press play
  // and WIP climbs forever, no KPI ever settles, and no analytical Lq exists
  // to compare against. Feeding a line more than it can take isn't a
  // "loaded" line, it's an unstable one.
  //
  // Target ~85 % bottleneck utilisation: busy enough that queues are visible
  // and the bottleneck is obvious, stable enough that every observable
  // converges to a finite steady state.
  const BOTTLENECK_TARGET_RHO = 0.85;
  const slowestSmv = ops.reduce((m, o) => Math.max(m, o.smv / Math.max(1, o.servers ?? 1)), 0);
  const bottleneckCapPerHr = slowestSmv > 0 ? 60 / slowestSmv : 60;
  const sourceRatePerHr = Math.max(1, Math.round(bottleneckCapPerHr * BOTTLENECK_TARGET_RHO));
  const wsSource = makeWorkstation({
    deptId: dPlumb,
    catalogId: 'buf_in',
    position: { x: 2, y: 2 },
    name: 'Source — orders in',
  });
  wsSource.block = {
    kind: 'Source',
    params: {
      sourceRatePerHr,
      piecesPerAgent: 1,
      // Poisson arrivals. Without an explicit distribution the Source emits on
      // a fixed lattice, which is a D/M/1 line — it under-reports queueing
      // versus the M/M/c model every analysis surface compares it against.
      arrivalDist: { kind: 'exp', mean: 60 / sourceRatePerHr },
    },
  };
  wsSource.operation = {
    ...wsSource.operation,
    freeText: `${sourceRatePerHr} pcs/hr · ${Math.round(BOTTLENECK_TARGET_RHO * 100)}% of bottleneck capacity`,
  };
  workstations.push(wsSource);

  const wsPool = makeWorkstation({
    deptId: dSew,
    catalogId: 'op_sewer',
    position: { x: 2, y: 2 + ROW_DY * rowCount + 2 < gridH - 2 ? ORIGIN_Y + rowCount * ROW_DY : gridH - 3 },
    name: `Operators · ${operators} units`,
  });
  wsPool.block = {
    kind: 'ResourcePool',
    params: { capacity: operators },
  };
  workstations.push(wsPool);

  const wsSink = makeWorkstation({
    deptId: dPlumb,
    catalogId: 'buf_out',
    position: { x: gridW - 4, y: 2 },
    name: 'Sink — finished pcs',
  });
  wsSink.block = { kind: 'Sink' };
  workstations.push(wsSink);

  const opStations: Workstation[] = [];
  ops.forEach((op: Operation, i) => {
    const row = Math.floor(i / STATIONS_PER_ROW);
    const col = i % STATIONS_PER_ROW;
    const colInRow = row % 2 === 0 ? col : STATIONS_PER_ROW - 1 - col;
    const x = ORIGIN_X + colInRow * STATION_DX;
    const y = ORIGIN_Y + row * ROW_DY;

    const catalogId = catalogForMachine(op.machineCode);
    const ws = makeWorkstation({
      deptId: dSew,
      catalogId,
      position: { x, y },
      name: `${i + 1}. ${op.name}`,
    });
    ws.block = {
      kind: 'Service',
      params: {
        cycleS: Math.max(1, Math.round(op.smv * 60)),
        servers: Math.max(1, Math.round(op.servers ?? 1)),
        // Bake the authored system capacity so the DES honours the same finite
        // buffer as the analytical model. 0 ⇒ unbounded. See systemCapacityFor.
        queueCapacity: op.queueCapacity ?? 0,
        // Bake the service DISTRIBUTION for the same reason. Without this the
        // DES falls back to a deterministic `cycleMin` (an M/D/1 station) while
        // the analytical layer falls back to `defaultDist` (uniform ⇒ M/G/1) —
        // two different variances, so a systematically different Lq on the two
        // halves of every sim-vs-theory comparison. Resolving both from the
        // same expression is what makes them agree by construction.
        cycleDist: op.serviceDistribution
          ?? distFromOpNotes(op.notes)
          ?? defaultDist(op.smv),
      },
    };
    ws.operation = {
      ...ws.operation,
      opId: op.id,
      garmentId: garment.id,
      bundleSize: garment.defaultBundleSize,
      freeText: op.notes ?? `SMV ${op.smv.toFixed(3)} min`,
    };
    ws.kpiTargets = {
      ...ws.kpiTargets,
      capacityPerHr: op.smv > 0 ? Math.round(60 / op.smv) : undefined,
    };
    ws.props = {
      ...defaultPropsFor(catalogId),
      ...ws.props,
      cycle_s: Math.round(op.smv * 60),
      servers: Math.max(1, Math.round(op.servers ?? 1)),
    };
    workstations.push(ws);
    opStations.push(ws);
  });

  const connectors: Connector[] = [];
  function link(fromWs: Workstation, toWs: Workstation): void {
    connectors.push({
      id: newConnectorId(),
      kind: 'flow',
      fromWsId: fromWs.id,
      toWsId: toWs.id,
    });
  }
  if (opStations.length > 0) {
    link(wsSource, opStations[0]);
    for (let i = 0; i < opStations.length - 1; i++) {
      link(opStations[i], opStations[i + 1]);
    }
    link(opStations[opStations.length - 1], wsSink);
  }

  // A twin built from a bulletin IS a sewing line, so give it one. This used
  // to return `lines: []` with no `lineId` on any workstation, which meant
  // every surface that scopes by line saw a factory with no lines in it — the
  // root of "no sewing line builds reported".
  //
  // Every workstation gets the SAME lineId, including the Source, the Sink and
  // the operator ResourcePool. That consistency is load-bearing in two places:
  // the engine keys operator pools by line, so a pool tagged differently from
  // the Services it serves would silently impose no constraint at all; and the
  // Source reads `ws.lineId` to find its order sequence and raise changeovers.
  const line: SewingLine = {
    id: newLineId(),
    deptId: dSew,
    name: `Line 1 · ${garment.name}`,
    productionSystem: 'PBS',
    garmentId: garment.id,
    color: 'blue',
    operatorTarget: operators,
    policy: defaultPolicyFor('PBS'),
  };
  for (const ws of workstations) ws.lineId = line.id;

  return {
    schemaVersion: TWIN_SCHEMA_VERSION as TwinSchemaVersion,
    id: newTwinId(),
    name: name ?? `${garment.name} · ${operators} operators`,
    parentTwinId: null,
    isCanonical: true,
    createdAt: now,
    modifiedAt: now,
    gridW,
    gridH,
    departments,
    lines: [line],
    workstations,
    connectors,
    notes: `Auto-built from garment template "${garment.name}" — ${ops.length} ops, total SMV ${totalSmv.toFixed(2)} min, ${operators} operators.`,
  };
}

// ============================================================================
// VALIDATION HELPER
// ============================================================================

/**
 * Compare a sim result's headline KPIs against the paper's reported KPIs.
 * Used by the Reference Models page's "Validate" card after the user has
 * run the sim on the loaded reference twin.
 *
 * Returns one row per KPI the paper reported. `withinTolerance` is true
 * when the observed value lands within the supplied ± fraction of the
 * paper figure (default ±10 %).
 */
export interface ValidationRow {
  label: string;
  paper: number;
  observed: number;
  unit: string;
  deltaPct: number;
  withinTolerance: boolean;
  /**
   * When true, the row is shown for context but is NOT used to compute the
   * card's overall ±-tolerance verdict. Used for KPIs whose definition is
   * paper-specific (e.g. "line efficiency" — Hossain reports Arena's
   * resource utilization, Morshed reports the work-study figure, Koç
   * reports a balance ratio; none of those match each other or our
   * `(throughput × ΣSMV) / (operators × shiftMin)` standard formula).
   */
  informational?: boolean;
  /** Free-form note explaining why this row may not match (formula gap). */
  noteWhy?: string;
}

export function compareToPaper(input: {
  model: ReferenceModel;
  variant: ReferenceVariant;
  /** Optional — when set, compare against this scenario's KPIs instead of
   *  the variant's baseline/proposed block. */
  scenarioId?: string;
  observed: {
    throughputPerHr: number;
    operatorsConfigured: number;
    totalSmvMin: number;
    shiftMin: number;
  };
  tolerancePct?: number;
}): ValidationRow[] {
  const { model, variant, observed } = input;
  const tol = (input.tolerancePct ?? 5) / 100;
  const scenario =
    input.scenarioId && model.scenarios
      ? model.scenarios.find((s) => s.id === input.scenarioId) ?? null
      : null;
  const paperKpis = scenario
    ? {
        operators: scenario.operators,
        throughputPerDayPcs: scenario.throughputPerDayPcs,
        lineEfficiencyPct: undefined as number | undefined,
      }
    : variant === 'proposed' && model.proposed
      ? model.proposed
      : model.baseline;

  const rows: ValidationRow[] = [];

  // Operators — exact, by construction.
  rows.push({
    label: 'Operators',
    paper: paperKpis.operators,
    observed: observed.operatorsConfigured,
    unit: '',
    deltaPct: pctDelta(paperKpis.operators, observed.operatorsConfigured),
    withinTolerance: paperKpis.operators === observed.operatorsConfigured,
  });

  // Throughput / day — derive from per-hour observed (× 8).
  if (paperKpis.throughputPerDayPcs) {
    const observedPerDay = observed.throughputPerHr * 8;
    const delta = pctDelta(paperKpis.throughputPerDayPcs, observedPerDay);
    rows.push({
      label: 'Throughput',
      paper: paperKpis.throughputPerDayPcs,
      observed: Math.round(observedPerDay),
      unit: 'pcs/day',
      deltaPct: delta,
      withinTolerance: Math.abs(delta) <= tol * 100,
    });
  }

  // Line efficiency — recompute observed from throughput × SMV using the
  // standard textbook formula. Each paper, however, defines "line efficiency"
  // differently (Arena resource utilization, balance ratio, work-study
  // figures), so this row is INFORMATIONAL: the engine reports a coherent
  // number and shows the gap, but the row does not count toward the
  // card's ±-tolerance verdict.
  if (paperKpis.lineEfficiencyPct) {
    const observedOutputPerShift = observed.throughputPerHr * (observed.shiftMin / 60);
    const observedLineEff =
      observed.operatorsConfigured > 0
        ? ((observedOutputPerShift * observed.totalSmvMin) /
            (observed.operatorsConfigured * observed.shiftMin)) *
          100
        : 0;
    const delta = pctDelta(paperKpis.lineEfficiencyPct, observedLineEff);
    rows.push({
      label: 'Line efficiency',
      paper: paperKpis.lineEfficiencyPct,
      observed: Math.round(observedLineEff * 100) / 100,
      unit: '%',
      deltaPct: delta,
      withinTolerance: Math.abs(delta) <= tol * 100,
      informational: true,
      noteWhy:
        'Each paper defines line efficiency with its own formula (Arena ' +
        'resource utilization, balance ratio, work-study quote). Stitchworks ' +
        'shows the textbook (throughput × ΣSMV) / (operators × shiftMin) ' +
        'figure for transparency; not a model error.',
    });
  }

  return rows;
}

function pctDelta(paper: number, observed: number): number {
  if (paper === 0) return 0;
  return ((observed - paper) / paper) * 100;
}
