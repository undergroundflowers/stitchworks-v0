/**
 * The factory a fresh install boots into.
 *
 * Replaces `buildDemoTwin`, which seeded five departments (Storage, Cutting,
 * QC Bay, Sewing Floor, Finishing) and then wired only 8 of the T-shirt
 * bulletin's 27 operations onto Line A, leaving Line B an empty two-buffer
 * skeleton that `buildLinesFromTwin` rejected outright. So the app opened onto
 * a factory whose KPIs were a partial fiction and whose second line could not
 * simulate at all — a direct contributor to "no sewing line builds reported".
 *
 * This seeds ONE complete, runnable sewing line instead. The line is built by
 * `buildGarmentTwin`, which already emits exactly the right graph from a
 * bulletin — Source, one Service per operation with its SMV / servers / buffer
 * / distribution baked in, an operator ResourcePool, a Sink, and the full
 * connector chain. Hand-authoring 27 workstations here would just duplicate
 * that (and drift from it).
 *
 * On top of the graph this adds the people and the demand: one Operator record
 * per station with a primary Assignment, and a production order wired into the
 * line's `orderSequence`.
 */

import { GARMENT_TEMPLATES } from './garments';
import { buildGarmentTwin } from './reference-twin';
import {
  newAssignmentId,
  newOperatorId,
  type Assignment,
  type Operator,
  type Order,
  type Twin,
} from './twin';
import { getBlockKind } from './pml';

/** Garment the starter line runs. 27 operations, 8.41 min total SMV. */
const STARTER_GARMENT_ID = 'tshirt';

/**
 * Pieces on the seeded order — a realistic bulk apparel PO, and deliberately
 * far larger than one shift.
 *
 * A Source running an `orderSequence` STOPS once the sequence is exhausted, and
 * an idle line has no steady state: ρ, L̄q and Ŵq all collapse toward zero
 * because the observation window fills with dead time. The line's bottleneck
 * operation is 0.70 min, so it caps near 86 pcs/hr and is offered ~73 pcs/hr —
 * meaning a 1,200-piece order would run dry around minute 990 and every
 * analysis longer than that would silently report an idle factory.
 *
 * 25,000 pieces is both an ordinary knit-tee PO and about 340 machine-hours of
 * work, so the line stays loaded for any run length a user will ask for.
 */
const STARTER_ORDER_QTY = 25_000;

export function buildStarterLine(name: string = 'Starter Factory'): Twin {
  const garment = GARMENT_TEMPLATES[STARTER_GARMENT_ID];
  const operatorTarget = garment.operations.length;

  const twin = buildGarmentTwin(garment, operatorTarget, name);
  if (!twin) {
    // Only possible if the bulletin were emptied. Fail loudly rather than
    // booting into a blank canvas that looks like data loss.
    throw new Error(
      `buildStarterLine: garment "${STARTER_GARMENT_ID}" has no operations to build a line from`,
    );
  }

  const line = twin.lines[0];

  // One operator per Service station, each owning its station for the shift.
  //
  // shareFrac is 1 on purpose. `buildShareFactorMap` only slows a station when
  // the assignments summed against it come to LESS than 1 (a shared operator
  // splitting their shift), so a full-time primary is a deliberate no-op on
  // cycle times rather than a hidden multiplier.
  const operators: Operator[] = [];
  const assignments: Assignment[] = [];
  const serviceStations = twin.workstations.filter((ws) => getBlockKind(ws) === 'Service');

  serviceStations.forEach((ws, i) => {
    const opr: Operator = {
      id: newOperatorId(),
      deptId: ws.deptId,
      lineId: line.id,
      name: `OPR-${String(i + 1).padStart(2, '0')}`,
      skills: [],
    };
    operators.push(opr);
    assignments.push({
      id: newAssignmentId(),
      operatorId: opr.id,
      wsId: ws.id,
      role: 'primary',
      shareFrac: 1,
    });
  });

  const order: Order = {
    id: 'ord-starter-1',
    po: 'PO-0001',
    client: 'Sample Buyer',
    garmentId: garment.id,
    quantity: STARTER_ORDER_QTY,
    priority: 1,
    assignedLineId: line.id,
    createdAt: twin.createdAt,
  };

  return {
    ...twin,
    name,
    lines: [{ ...line, orderSequence: [order.id] }],
    operators,
    assignments,
    orders: [order],
    notes:
      `Starter line — ${garment.name}, ${serviceStations.length} stations, `
      + `total SMV ${garment.totalSmv.toFixed(2)} min, ${operators.length} operators. `
      + `Seeded on first boot so the app opens onto something runnable; edit or delete freely.`,
  };
}
