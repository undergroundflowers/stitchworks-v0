/**
 * Operation bulletin → runnable Twin.
 *
 * Lays a garment's operations out as a sewing line the PML engine can run: a
 * Source feeding station one, one Service block per operation in bulletin
 * order, an operator ResourcePool, and a Sink. Row-wrapped serpentine layout so
 * a 27-station line fits on a readable grid.
 *
 * This is what seeds a new factory (`buildStarterLine`) and what the Builder's
 * "new line from bulletin" action produces. It used to also host a
 * published-paper comparison — that was removed with the sewing-lines pivot in
 * favour of the sim-versus-closed-form convergence check, which is automated
 * and doesn't depend on one paper's reported table.
 */

import type { Operation } from './operations';
import type { GarmentTemplate } from './garments';
import {
  type Twin,
  type Workstation,
  type Connector,
  type SewingLine,
  type TwinSchemaVersion,
  TWIN_SCHEMA_VERSION,
  defaultPolicyFor,
  newTwinId,
  newLineId,
  newConnectorId,
  makeWorkstation,
} from './twin';
import { defaultPropsFor } from './iso';
import { defaultDist, distFromOpNotes } from '../simulation/distributions';

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
