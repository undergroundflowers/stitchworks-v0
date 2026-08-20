/**
 * Excel → Builder-line importer. Reads "Machine Layout" sheets exported
 * by Modelama (and similar Asian-factory line-plan templates) and
 * produces a flat list of stations ready to materialize as a SewingLine
 * + Workstations on the canonical Twin.
 *
 * Source shape (what the parser expects to find on the chosen sheet):
 *
 *   Row 0       MACHINE LAYOUT
 *   Rows 1-4    metadata block:
 *                 DESCRIPTION | DRESS | LINE NO. | 6   | MACHINE     | 45
 *                 Style No.   | 100…  |          |     | MACHINE SMV | 26.45
 *                 Buyer       | INC   |          |     | No of Work  | 62
 *                 Quantity    | 6250  | FINAL INSPECTION TABLE | … | Target 8 Hrs | 61.24
 *   Row 6       header:
 *                 OPERATION | CODE NO. | TYPE OF M/C |   | TYPE OF M/C | CODE NO. | OPERATION
 *   Rows 7..n   alternating data + visually-blank spacer rows. Each data
 *               row may carry a station on the LEFT half (cols 0..2), the
 *               RIGHT half (cols 4..6), both, or neither.
 *
 * The two halves represent physically facing rows on a Progressive-
 * Bundle (PBS) sewing line — operators sit on either side of an aisle.
 * Importantly, codeNo runs *continuously across both halves* (e.g.
 * left=63, right=62, left=64, right=60…), not within one column.
 * We treat codeNo as "position along the line" and use it for X
 * placement; `side` decides which row (Y).
 */

import * as XLSX from 'xlsx';
import { useTwin, selectActiveTwin } from '../store/twin';
import type { EntityColorKey } from '../domain/twin';

export interface ImportedStation {
  /** "Code No." from the sheet — Modelama's station-position number. */
  codeNo?: number;
  /** Operation label (e.g. "BOTTOM HEM SHELL"). */
  name: string;
  /** Raw machine string from the sheet (e.g. "SN", "OL-5", "TABLE"). */
  rawMachine: string;
  /** Mapped ISO_FIXTURE_CATALOG id (e.g. `a_snls`, `a_bartack`). */
  catalogId: string;
  /** Aisle side. 'L' = top facing row, 'R' = bottom facing row. */
  side: 'L' | 'R';
  /**
   * 0-based index of the data row this station came from on the sheet.
   * Both an L and an R station drawn from the same sheet row share the
   * same `rowIndex` — that's how we know they physically face each other
   * across the aisle, regardless of how their `codeNo` values compare.
   * (On Modelama PBS sheets the codeNo snakes between sides, so two
   * facing stations almost always have different codeNos.)
   */
  rowIndex: number;
}

export interface ImportedFloor {
  stations: ImportedStation[];
  source: {
    fileName: string;
    sheetName: string;
    style?: string;
    description?: string;
    buyer?: string;
    lineNo?: number;
    machineCount?: number;
    workstationCount?: number;
    machineSmv?: number;
    quantity?: number;
    target?: number;
  };
  warnings: string[];
}

// ── Modelama machine vernacular → ISO_FIXTURE_CATALOG id ─────────────────
// Long/specific patterns first; falls through to a_op_desk if nothing
// matches so unrecognised cells still place a station (and we surface a
// warning). Each entry covers the abbreviations Modelama actually uses on
// these layout sheets — see the four xlsx samples in MODELAMA DATA/.
const FIXTURE_PATTERNS: { pattern: RegExp; catalogId: string; label: string }[] = [
  // Overlocks first — they're the most ambiguous if we let SN match early
  { pattern: /\bo\s*\/?\s*l\s*5\b|\bol[-\s]?5\b|\b5\s*o\s*\/?\s*l/i, catalogId: 'a_5ol', label: '5-thread overlock' },
  { pattern: /\bo\s*\/?\s*l\s*4\b|\bol[-\s]?4\b|\b4\s*o\s*\/?\s*l/i, catalogId: 'a_4ol', label: '4-thread overlock' },
  { pattern: /\bo\s*\/?\s*l\s*3\b|\bol[-\s]?3\b|\b3\s*o\s*\/?\s*l/i, catalogId: 'a_4ol', label: '3-thread overlock → 4-thread' },
  { pattern: /\bover[\s-]*lock|\bo\/l\b|\bol\b/i, catalogId: 'a_4ol', label: 'overlock (unspecified)' },
  // Speciality sewing
  { pattern: /\bbartack|\bbt\b/i, catalogId: 'a_bartack', label: 'bartack' },
  { pattern: /\bbutton\s*hole|\bbh\b/i, catalogId: 'a_buttonhole', label: 'buttonhole' },
  { pattern: /\bbutton\s*(sew|stitch|stch|attach)|\bbs\b/i, catalogId: 'a_buttonsew', label: 'button sew' },
  { pattern: /\bembroid|\bemb\b/i, catalogId: 'a_embroidery', label: 'embroidery' },
  // Flatlock / cover / feed-of-arm / kansai
  { pattern: /\b(coverstitch|cover\s*stitch|flat\s*lock|flatlock|\bfl\b)/i, catalogId: 'a_flatlock', label: 'flatlock' },
  { pattern: /\b(feed\s*of\s*arm|foa|\bfb\b)/i, catalogId: 'a_foa', label: 'feed-of-arm' },
  { pattern: /\bkansai|\bks\b/i, catalogId: 'a_kansai', label: 'kansai' },
  // Cutting / spreading
  { pattern: /\bcad\b/i, catalogId: 'a_cnc_cutter', label: 'CAD cutter' },
  { pattern: /\b(cutter|cut\b|straight\s*knife|band\s*knife)/i, catalogId: 'a_knife_straight', label: 'cutter' },
  { pattern: /\bspread/i, catalogId: 'a_spread_auto', label: 'spreader' },
  // Pressing / fusing / steam
  { pattern: /\bfusing\b|\bfuse\b/i, catalogId: 'a_iron_inline', label: 'fusing' },
  { pattern: /\bsteam\s*tunnel\b|\bsteam\b/i, catalogId: 'a_iron_inline', label: 'steam' },
  { pattern: /\biron\b|\bpress\b/i, catalogId: 'a_iron_inline', label: 'iron / press' },
  // Inspection
  { pattern: /\btable\b/i, catalogId: 'a_inspect_table', label: 'inspection table' },
  { pattern: /\binspect|\bqc\b|\baql\b/i, catalogId: 'a_inspect_table', label: 'inspection' },
  // Sewing — double then single, both AFTER speciality so BH/BS/BT take precedence
  { pattern: /\bdnl(s|m|c|ec)?\b|\bdn\b|\bdouble\s*needle/i, catalogId: 'a_dnls', label: 'double needle' },
  { pattern: /\bsn(l|e|k|c|ec)?\w*\b|\bsn\b|\bsingle\s*needle|\block\s*stitch/i, catalogId: 'a_snls', label: 'single needle' },
  // Manual helper / hand
  { pattern: /\bhd\b|\bhelper\b|\bhand\b|\bmnl\b|\bmanual\b/i, catalogId: 'a_op_desk', label: 'manual / helper' },
];

// ── Public API ────────────────────────────────────────────────────────────
/**
 * Parse an .xlsx and return EVERY Machine Layout sheet inside it.
 * Modelama workbooks sometimes carry stale template layouts alongside the
 * file's real layout (e.g. `100225286 LINE-6.xlsx` has both a `7800`
 * carry-over and the actual `1893` sheet for style 100225286) — surfacing
 * every layout lets the user pick which ones to keep on import.
 */
export function parseFloorXlsx(input: ArrayBuffer | Uint8Array, fileName = 'imported.xlsx'): ImportedFloor[] {
  const wb = XLSX.read(input, { type: 'array', cellDates: false });
  const layouts: ImportedFloor[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
    if (findLayoutHeaderRow(rows) < 0) continue;
    try {
      const parsed = parseLayoutRows(rows, fileName, name);
      // Filter out sheets that match the header structure but have zero
      // stations under it (defensive — parseLayoutRows already throws on 0).
      if (parsed.stations.length > 0) layouts.push(parsed);
    } catch {
      // Skip — empty-table sheets shouldn't poison the batch.
    }
  }
  if (layouts.length === 0) {
    throw new Error('No Machine Layout sheets found in this workbook.');
  }
  return layouts;
}

/** Pick a single best layout from a workbook — used when the caller only
 *  wants one result. Prefers the sheet whose internal Style No. matches
 *  the leading numeric token in the filename; falls back to row count. */
export function parseBestFloorXlsx(input: ArrayBuffer | Uint8Array, fileName = 'imported.xlsx'): ImportedFloor {
  const all = parseFloorXlsx(input, fileName);
  const fileStyle = (fileName.match(/^\s*(\d{4,})/) || [])[1];
  if (fileStyle) {
    const exact = all.find((f) => normaliseStyle(f.source.style) === normaliseStyle(fileStyle));
    if (exact) return exact;
  }
  // Score-based fallback: prefer sheet with the most stations.
  return all.slice().sort((a, b) => b.stations.length - a.stations.length)[0];
}

function normaliseStyle(s: string | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function parseLayoutRows(rows: unknown[][], fileName: string, sheetName: string): ImportedFloor {
  const warnings: string[] = [];
  const headerRow = findLayoutHeaderRow(rows);
  if (headerRow < 0) {
    throw new Error('Could not find the layout header row (needs "TYPE OF M/C" + "OPERATION" / "CODE NO.").');
  }
  // Column layout per Modelama spec — header is *symmetric* around column 3
  // (an empty gutter). We hardcode the offsets because the sheets we've
  // seen all match this exact 7-col grid; if a future sheet deviates we can
  // map columns by header text.
  const COL_L_NAME = 0;
  const COL_L_CODE = 1;
  const COL_L_M = 2;
  const COL_R_M = 4;
  const COL_R_CODE = 5;
  const COL_R_NAME = 6;

  const source = readLayoutMetadata(rows.slice(0, headerRow));
  source.fileName = fileName;
  source.sheetName = sheetName;

  const stations: ImportedStation[] = [];
  // `rowIndex` is a compressed counter — only sheet rows that actually
  // contributed at least one station bump it, so visually-blank spacer
  // rows in the workbook don't create empty columns on the canvas.
  let rowIndex = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    let pushedFromThisRow = false;
    // LEFT side
    const lName = toString(row[COL_L_NAME]);
    const lMach = toString(row[COL_L_M]);
    const lCode = toNumber(row[COL_L_CODE]);
    if (lName && lMach) {
      const { catalogId, matched } = resolveCatalogId(lMach);
      if (!matched) warnings.push(`Left col row ${r + 1}: machine "${lMach}" unmapped — fell back to ${catalogId}.`);
      stations.push({
        codeNo: lCode ?? undefined,
        name: lName,
        rawMachine: lMach,
        catalogId,
        side: 'L',
        rowIndex,
      });
      pushedFromThisRow = true;
    }
    // RIGHT side
    const rName = toString(row[COL_R_NAME]);
    const rMach = toString(row[COL_R_M]);
    const rCode = toNumber(row[COL_R_CODE]);
    if (rName && rMach) {
      const { catalogId, matched } = resolveCatalogId(rMach);
      if (!matched) warnings.push(`Right col row ${r + 1}: machine "${rMach}" unmapped — fell back to ${catalogId}.`);
      stations.push({
        codeNo: rCode ?? undefined,
        name: rName,
        rawMachine: rMach,
        catalogId,
        side: 'R',
        rowIndex,
      });
      pushedFromThisRow = true;
    }
    if (pushedFromThisRow) rowIndex++;
  }

  if (stations.length === 0) {
    throw new Error('Found a Machine Layout header but no stations under it.');
  }

  return { stations, source, warnings };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function findLayoutHeaderRow(rows: unknown[][]): number {
  // Look in the first ~40 rows for one that has "TYPE OF M/C" along with
  // "OPERATION" or "CODE NO." — these three header labels uniquely identify
  // Modelama's Machine Layout header row.
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const norm = (rows[r] ?? []).map((c) => normaliseHeaderText(c));
    const hasTypeMc = norm.some((c) => c === 'typeofmc' || c === 'typemc');
    const hasOperation = norm.some((c) => c === 'operation' || c === 'operationname');
    const hasCode = norm.some((c) => c === 'codeno' || c === 'code');
    if (hasTypeMc && (hasOperation || hasCode)) return r;
  }
  return -1;
}

function readLayoutMetadata(headerRows: unknown[][]): ImportedFloor['source'] {
  const src: ImportedFloor['source'] = { fileName: '', sheetName: '' };
  for (const row of headerRows) {
    for (let c = 0; c < row.length; c++) {
      const label = normaliseHeaderText(row[c]);
      if (!label) continue;
      const v = pickNextValue(row, c);
      const num = toNumber(v);
      if (label === 'description' && v) src.description ??= v;
      else if (label === 'styleno' && v) src.style ??= v;
      else if (label === 'buyer' && v) src.buyer ??= v;
      else if (label === 'quantity' && num != null) src.quantity ??= num;
      else if ((label === 'lineno' || label === 'line') && num != null) src.lineNo ??= num;
      else if (label === 'machine' && num != null) src.machineCount ??= num;
      else if (label === 'machinesmv' && num != null) src.machineSmv ??= num;
      else if (label === 'noofworkstations' && num != null) src.workstationCount ??= num;
      else if (label.startsWith('target') && num != null) src.target ??= num;
    }
  }
  return src;
}

function pickNextValue(row: unknown[], from: number): string | undefined {
  for (let c = from + 1; c < Math.min(row.length, from + 6); c++) {
    const v = toString(row[c]);
    if (v) return v;
  }
  return undefined;
}

function resolveCatalogId(raw: string): { catalogId: string; matched: boolean } {
  const cleaned = (raw ?? '').toString().trim();
  if (!cleaned) return { catalogId: 'a_op_desk', matched: false };
  for (const { pattern, catalogId } of FIXTURE_PATTERNS) {
    if (pattern.test(cleaned)) return { catalogId, matched: true };
  }
  return { catalogId: 'a_op_desk', matched: false };
}

function normaliseHeaderText(v: unknown): string {
  if (v == null) return '';
  return String(v).toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function toString(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[, ]+/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── Twin materialiser ────────────────────────────────────────────────────
/**
 * Lay the parsed stations out as a two-row facing line in Twin grid space.
 * Returns the relative placement positions; the caller adds an origin
 * offset so multiple imports don't stack on top of each other.
 *
 * Geometry rules (this is the part that has to match the source sheet):
 *
 *   • **Sheet row ⇒ X column.** Both the L and the R cell on the same
 *     sheet row are *physically facing each other across the aisle* in the
 *     factory — they belong at the same X on the canvas, just on opposite
 *     sides of the aisle. We bucket stations by `rowIndex` and give every
 *     bucket one X column.
 *
 *   • **Representative codeNo orders the columns.** Modelama PBS sheets
 *     are usually laid out tail-at-top / head-at-bottom (FINAL TABLE up
 *     top, codeNo 1 down low). We sort the row buckets by their smallest
 *     codeNo so the canvas reads line-head → tail left-to-right, which is
 *     the convention everywhere else in the app.
 *
 *   • **Side ⇒ Y row.** `L` sits on the top facing row, `R` on the bottom
 *     facing row, separated by the aisle.
 *
 *   • **codeNo ⇒ seq.** The flow connectors that wire workstations
 *     together still follow codeNo ascending — the snake path the sheet
 *     encodes — independent of X placement.
 *
 * Earlier this used codeNo for X directly, which broke visual fidelity:
 * a sheet row showing L=58 / R=57 (two operators across the aisle from
 * each other) ended up at X=58 and X=57 — two completely different
 * columns. The canvas no longer matched what the user saw in Excel.
 */
export interface PlacedStation extends ImportedStation {
  /** Cell offset within the new line's bounding rect. */
  x: number;
  y: number;
  /** Order along the line, ascending (0 = head, N-1 = tail). */
  seq: number;
}

export interface LayoutPlacement {
  /** Stations with x/y resolved, sorted in flow order (head→tail). */
  stations: PlacedStation[];
  /** Bounding rect width / depth in cells. */
  widthCells: number;
  depthCells: number;
  /** Suggested name for the new SewingLine. */
  lineName: string;
  /** Suggested grouping name carried over from the sheet. */
  deptName: string;
}

const STATION_STRIDE = 3;      // Cells between adjacent stations along X
const AISLE_WIDTH = 4;          // Cells separating the two facing rows

export function placeLayoutStations(parsed: ImportedFloor): LayoutPlacement {
  // 1) Bucket stations by their sheet `rowIndex` so the L and R cells on
  //    the same data row always land at the same X column.
  const byRow = new Map<number, ImportedStation[]>();
  for (const s of parsed.stations) {
    const arr = byRow.get(s.rowIndex);
    if (arr) arr.push(s);
    else byRow.set(s.rowIndex, [s]);
  }

  // 2) Compute one representative codeNo per row (the smaller of the two
  //    sides — that's the one closer to the line head on a snake path).
  //    Rows with no codeNo at all sort to the right edge in original sheet
  //    order — they're things like blank trailers or "FINAL TABLE" stubs
  //    with the codeNo column missing, which conventionally sit at the
  //    tail anyway.
  type RowMeta = { rowIndex: number; rep: number; stations: ImportedStation[] };
  const rowMetas: RowMeta[] = [];
  for (const [rowIndex, stations] of byRow.entries()) {
    const codes = stations
      .map((s) => s.codeNo)
      .filter((c): c is number => c != null);
    const rep = codes.length ? Math.min(...codes) : Number.POSITIVE_INFINITY;
    rowMetas.push({ rowIndex, rep, stations });
  }
  rowMetas.sort((a, b) => {
    if (a.rep === b.rep) return a.rowIndex - b.rowIndex;
    return a.rep - b.rep;
  });

  // 3) Assign every row a column index, then materialise stations at
  //    (col × stride, side-based Y). L on top row, R across the aisle.
  const placed: PlacedStation[] = [];
  rowMetas.forEach((rm, col) => {
    for (const s of rm.stations) {
      placed.push({
        ...s,
        x: col * STATION_STRIDE,
        y: s.side === 'L' ? 0 : AISLE_WIDTH,
        seq: 0, // filled in step 4
      });
    }
  });

  // 4) Flow sequence (`seq`) is driven by codeNo independent of X — that
  //    keeps the connector graph snaking the way the sheet's codeNos
  //    intend. Within a tied codeNo, L precedes R as a deterministic
  //    tiebreaker. Stations missing codeNo go to the end in placement
  //    order.
  const seqOrder = [...placed].sort((a, b) => {
    const ac = a.codeNo ?? Number.POSITIVE_INFINITY;
    const bc = b.codeNo ?? Number.POSITIVE_INFINITY;
    if (ac !== bc) return ac - bc;
    if (a.side !== b.side) return a.side === 'L' ? -1 : 1;
    return 0;
  });
  seqOrder.forEach((s, i) => {
    s.seq = i;
  });

  // 5) Sort the returned list by seq so `commitFloorImport`'s neighbour
  //    wiring (wsIds[i] → wsIds[i+1]) follows the bundle path.
  placed.sort((a, b) => a.seq - b.seq);

  const colCount = Math.max(1, rowMetas.length);
  const widthCells = (colCount - 1) * STATION_STRIDE + 3;
  const depthCells = AISLE_WIDTH + 3;
  const styleLabel = parsed.source.style ?? parsed.source.sheetName ?? 'Imported';
  const lineLabel = parsed.source.lineNo != null ? `Line ${parsed.source.lineNo}` : 'Imported line';

  return {
    stations: placed,
    widthCells,
    depthCells,
    lineName: `${lineLabel} · ${styleLabel}`,
    deptName: `Imported · ${styleLabel}`,
  };
}

// ── Commit ───────────────────────────────────────────────────────────────
/**
 * Materialise a parsed layout into the active Twin. Creates a new
 * Department to host the line (positioned to the right of all existing
 * departments so multiple imports don't stack), the SewingLine itself,
 * one Workstation per station, and a flow connector between every
 * adjacent pair on the line (head → tail).
 *
 * Returns a summary so the caller can surface counts in a toast.
 */
export interface CommittedFloor {
  lineId: string;
  workstationCount: number;
  connectorCount: number;
}

type TwinStore = ReturnType<typeof useTwin.getState>;

export function commitFloorImport(
  store: TwinStore,
  _parsed: ImportedFloor,
  placement: LayoutPlacement,
  options?: { color?: EntityColorKey; productionSystem?: 'PBS' | 'straight' | 'modular' | 'UPS' | 'synchro' },
): CommittedFloor {
  const color: EntityColorKey = options?.color ?? 'blue';
  const productionSystem = options?.productionSystem ?? 'PBS';

  // Find an empty patch of the grid for the new department — sit it to
  // the right of everything that already exists, with a 4-cell gutter.
  const active = selectActiveTwin(store);
  if (!active) throw new Error('No active twin to import into.');
  // Park the import clear of whatever is already on the floor. With zones
  // gone there is no dept rect to measure, so the right edge of the existing
  // stations is the reference.
  const gutter = 4;
  let originX = 0;
  const originY = 0;
  for (const w of active.workstations) {
    const right = w.position.x + (w.size?.w ?? 1);
    if (right > originX) originX = right;
  }
  if (active.workstations.length > 0) originX += gutter;

  const lineId = store.addLine({
    name: placement.lineName,
    productionSystem,
    color,
    operatorTarget: placement.stations.length,
  });

  // Drop each workstation, remembering the new id so we can wire flow
  // connectors between them afterwards.
  const wsIds: string[] = [];
  for (const s of placement.stations) {
    const id = store.addWorkstation({
      lineId,
      catalogId: s.catalogId,
      // Inset by 1 cell so the imported block sits clear of whatever it was
      // parked beside.
      position: { x: originX + 1 + s.x, y: originY + 1 + s.y },
      name: s.name,
    });
    // Assign to the line.
    store.updateWorkstation(id, { lineId });
    wsIds.push(id);
  }

  // Flow connectors head → tail (sequentially along the line). Use a
  // bundle carrier since these layouts come from PBS lines.
  let connectorCount = 0;
  for (let i = 0; i < wsIds.length - 1; i++) {
    const cid = store.addConnector({
      kind: 'flow',
      fromWsId: wsIds[i],
      toWsId: wsIds[i + 1],
    });
    if (cid) connectorCount++;
  }

  return { lineId, workstationCount: wsIds.length, connectorCount };
}
