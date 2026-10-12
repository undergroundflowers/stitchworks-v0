import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { Card, Button, Stat, Tag, SectionHeader, Progress, ToggleGroup, HudSelect, EmptyState, NewGarmentTemplateDialog, NumberInput, useConfirm } from '../components';
import { useRef, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ALL_WORKER_ARCHETYPES,
  WORKER_ARCHETYPES,
  type WorkerArchetype,
  type WorkerRole,
  ALL_MACHINES,
  type MachineSpec,
  type MachineCode,
  type Operation,
  type OperationCategory,
  type SkillId,
  type GarmentTemplate,
  GARMENT_TEMPLATES,
} from '../domain';
import type {
  Assignment,
  Operator as TwinOperator,
  SewingLine,
} from '../domain/twin';
import { useProject, useGarments, type EffectiveGarments } from '../store';
import { useTwin, selectActiveTwin } from '../store/twin';
import { parseGarmentXlsx, type ImportedGarment } from '../lib/import-garment-xlsx';
import {
  parseFloorXlsx,
  placeLayoutStations,
  commitFloorImport,
  type ImportedFloor,
  type LayoutPlacement,
} from '../lib/import-floor-xlsx';

/**
 * Resources page — operators, machines and roster.
 *
 * Operators and machines are now derived from the apparel domain layer
 * (WORKER_ARCHETYPES + MACHINE_CATALOG) instead of hardcoded mock arrays.
 * Names and instance counts are seeded deterministically so the table is
 * stable across renders. Roster remains demo data for now; it becomes live
 * once the project file format and roster scheduler land.
 */
export function ResourcesPage() {
  // ?tab=operations&garment=<id> lets other surfaces deep-link straight to the
  // operations editor for a specific garment, and `&new=1` opens the
  // new-garment dialog on arrival — the Builder links in with both, because
  // "edit this garment's bulletin" and "add a garment" are asked from there
  // and this page is the only place either can be done.
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialTab = (searchParams.get('tab') as
    | 'operators' | 'machines' | 'skills' | 'operations'
    | null) ?? 'operators';
  const initialGarment = searchParams.get('garment') ?? undefined;
  const openNewGarment = searchParams.get('new') === '1';
  const [tab, setTab] = useState<'operators' | 'machines' | 'skills' | 'operations'>(initialTab);
  const project = useProject();
  const garments = useGarments();
  const skillMatrix = project.skillMatrix;
  const setSkill = project.setSkill;
  const resetSkillMatrix = project.resetSkillMatrix;
  const [skillsGarment, setSkillsGarment] = useState<string>(garments.all[0]?.id ?? '');

  // Target headcount = total operators configured across every factory line.
  // Without this, the page showed a hardcoded 33 even when the factory had
  // 131 operators across 8 lines — the pill, the WORKFORCE card and the
  // ROLE COVERAGE breakdown all printed numbers that didn't match anywhere
  // else in the app.
  const factoryHeadcount = useMemo(
    () => project.factory.lines.reduce((s, l) => s + (l.operators || 0), 0),
    [project.factory.lines],
  );
  // Operators come from the active Twin when it carries any (post step-3
  // seed flow), otherwise we fall back to the synthesised demo roster so
  // the table is never empty on v8 saves or canonical-only projects.
  const activeTwin = useTwin(selectActiveTwin);
  const operators = useMemo(() => {
    const twinOps = activeTwin?.operators ?? [];
    if (twinOps.length > 0) {
      const workstationsById = new Map(
        (activeTwin?.workstations ?? []).map((w) => [w.id, { id: w.id, name: w.name }]),
      );
      return operatorsFromTwin(
        twinOps,
        activeTwin?.assignments ?? [],
        activeTwin?.lines ?? [],
        workstationsById,
      );
    }
    return buildOperators(factoryHeadcount);
  }, [activeTwin, factoryHeadcount]);
  const machineTypes = useMemo(() => buildMachineTypes(), []);
  const machineCount = useMemo(
    () => machineTypes.reduce((s, t) => s + t.count, 0),
    [machineTypes],
  );

  const avgEff = Math.round(operators.reduce((s, o) => s + o.eff, 0) / operators.length);

  // Avatar tint keyed to the operator's position in the flat roster so the
  // colour stays put whether the table renders grouped or flat.
  const avatarTintById = useMemo(
    () => new Map(operators.map((o, i) => [o.id, i % 5])),
    [operators],
  );
  // Group the roster by sewing line. When the roster has fewer than two
  // distinct lines (e.g. the seeded demo crew carries no line names) the
  // table renders flat, exactly as before.
  const operatorRows = useMemo(() => {
    const buckets = new Map<string, typeof operators>();
    for (const o of operators) {
      const key = o.lineName ?? '— Unassigned';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(o);
    }
    if (buckets.size < 2) return operators.map((op) => ({ kind: 'op' as const, op }));
    const names = [...buckets.keys()].sort((a, b) => {
      if (a === '— Unassigned') return 1;
      if (b === '— Unassigned') return -1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    return names.flatMap((name) => {
      const ops = buckets.get(name)!;
      const groupEff = Math.round(ops.reduce((s, o) => s + o.eff, 0) / ops.length);
      return [
        { kind: 'section' as const, name, count: ops.length, groupEff },
        ...ops.map((op) => ({ kind: 'op' as const, op })),
      ];
    });
  }, [operators]);

  return (
    <div style={{ width:'100%', height:'100%', display:'flex', flexDirection:'column', background: SW_COLORS.paperDeep }}>
      <div style={{ padding:'18px 24px', background: SW_COLORS.paper, borderBottom: `1px solid ${SW_COLORS.line}` }}>
        <SectionHeader kicker="Resources" title="People & machines"
          sub="Manage your factory's workforce and equipment. Operators and machines are seeded from the apparel domain catalog."
          right={
            /* Back to the floor this library feeds. It replaces an "+ Add new"
               primary that had no handler at all — the loudest control on the
               page did nothing, while the real add buttons live inside each
               tab, where what is being added is unambiguous. */
            <Button variant="secondary" size="sm" onClick={() => navigate('/line')}>
              ← Back to Builder
            </Button>
          }/>
        <div style={{ marginTop: 8 }}>
          <ToggleGroup value={tab} onChange={setTab} options={[
            { value:'operators',  label:`👥 Operators · ${operators.length}` },
            { value:'machines',   label:`⚙ Machines · ${machineCount}` },
            { value:'operations', label:`🪡 Operations · ${garments.all.length} garments` },
            { value:'skills',     label:`🎯 Skill matrix` },
          ]}/>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'24px' }}>
        {tab==='operators' && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 280px', gap: 18 }}>
            <Card padding={0}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontFamily: SW_FONTS.body }}>
                <thead>
                  <tr style={{ background: SW_COLORS.paperDeep, borderBottom: `1px solid ${SW_COLORS.line}` }}>
                    {['ID','Name','Role','Line','Eff %','Assignment'].map(h => (
                      <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontFamily: SW_FONTS.mono, fontSize:10, fontWeight:700, color: SW_COLORS.muted, letterSpacing:'1px' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {operatorRows.map((row) => {
                    if (row.kind === 'section') {
                      return (
                        <tr key={`section:${row.name}`} style={{ background: SW_COLORS.paperDeep, borderBottom: `1px solid ${SW_COLORS.line}` }}>
                          <td colSpan={6} style={{ padding:'7px 12px', fontFamily: SW_FONTS.mono, fontSize:10, fontWeight:700, color: SW_COLORS.muted, letterSpacing:'1px', textTransform:'uppercase' }}>
                            {row.name} · {row.count} OPR · AVG EFF {row.groupEff}%
                          </td>
                        </tr>
                      );
                    }
                    const o = row.op;
                    return (
                    <tr key={o.id} style={{ borderBottom: `1px solid ${SW_COLORS.line}`, fontSize:12 }}>
                      <td style={{ padding:'10px 12px', fontFamily: SW_FONTS.mono, fontWeight:700, color: SW_COLORS.muted }}>{o.id}</td>
                      <td style={{ padding:'10px 12px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <div style={{ width:24, height:24, borderRadius:'50%', background: [SW_COLORS.brandLite,'#D6F0E4','#E4DEFF','#FFEAD6','#D6E8FF'][avatarTintById.get(o.id) ?? 0], display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, color: SW_COLORS.ink }}>{o.name[0]}</div>
                          <span style={{ fontWeight:700 }}>{o.name}</span>
                        </div>
                      </td>
                      <td style={{ padding:'10px 12px' }}>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                          <span style={{ width:18, height:18, borderRadius:4, background: o.archetype.color, color:'#fff', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:11 }}>{o.archetype.icon}</span>
                          {o.archetype.label}
                        </span>
                      </td>
                      <td style={{ padding:'10px 12px', fontFamily: SW_FONTS.mono, fontSize:11, color: SW_COLORS.muted }}>
                        {o.lineName ?? '—'}
                      </td>
                      <td style={{ padding:'10px 12px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ fontFamily: SW_FONTS.mono, fontWeight:700, width:30, color: o.eff>=80?SW_COLORS.ok:o.eff>=65?SW_COLORS.thread:SW_COLORS.alarm }}>{o.eff}%</span>
                          <div style={{ flex:1, maxWidth:60 }}><Progress value={o.eff} color={o.eff>=80?SW_COLORS.ok:o.eff>=65?SW_COLORS.thread:SW_COLORS.alarm} height={4}/></div>
                        </div>
                      </td>
                      <td style={{ padding:'10px 12px', fontFamily: SW_FONTS.mono, fontSize:11, color: SW_COLORS.muted, minWidth: 220 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span>{o.assignmentSummary ?? `SAM ${o.sam}`}</span>
                          {o.overallocated && (
                            <span
                              title="This operator's non-rotation shareFrac sums to > 1.0. Engine cycle math will treat the most absent station as the bottleneck; consider redistributing assignments."
                              style={{
                                fontFamily: SW_FONTS.mono,
                                fontSize: 9,
                                fontWeight: 800,
                                color: SW_COLORS.alarm,
                                padding: '1px 6px',
                                border: `1px solid ${SW_COLORS.alarm}`,
                                borderRadius: 3,
                                letterSpacing: '0.05em',
                              }}
                            >
                              ⚠ OVERALLOCATED
                            </span>
                          )}
                        </div>
                        {o.stationDetails && o.stationDetails.length > 0 && (
                          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {o.stationDetails.map((s, idx) => {
                              const sharedColor = s.sharePct < 100 ? SW_COLORS.alarm : SW_COLORS.steel;
                              return (
                                <div
                                  key={idx}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr auto',
                                    gap: 6,
                                    alignItems: 'center',
                                    fontSize: 10,
                                  }}
                                >
                                  <span style={{ color: SW_COLORS.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.wsName}>
                                    {s.wsName}
                                  </span>
                                  <span style={{ color: sharedColor, fontWeight: 700, minWidth: 30, textAlign: 'right' }}>
                                    {s.sharePct}%
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>

            <div>
              <Card padding={16} style={{ marginBottom:14 }}>
                <div style={{ ...SW_TYPE.heading, fontSize: 13, marginBottom: 10 }}>WORKFORCE</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  <Stat label="OPERATORS" value={operators.length}/>
                  <Stat label="AVG EFF" value={avgEff} unit="%"/>
                </div>
              </Card>
              <Card padding={16}>
                <div style={{ ...SW_TYPE.heading, fontSize: 13, marginBottom: 10 }}>ROLE COVERAGE</div>
                {ALL_WORKER_ARCHETYPES.filter((a) => operators.some((o) => o.archetype.role === a.role)).map((a) => {
                  const c = operators.filter((o) => o.archetype.role === a.role).length;
                  return (
                    <div key={a.role} style={{ marginBottom:8 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:600, marginBottom:3 }}>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                          <span style={{ color: a.color, fontSize:13 }}>{a.icon}</span>
                          {a.label}
                        </span>
                        <span style={{ fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>{c}</span>
                      </div>
                      <Progress value={c} max={8} color={a.color} height={5}/>
                    </div>
                  );
                })}
              </Card>
            </div>
          </div>
        )}

        {tab==='machines' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {machineTypes.map(t => (
              <Card key={t.spec.code} padding={14}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ ...SW_TYPE.heading, color: t.spec.color }}>
                      <span style={{ marginRight:6 }}>{t.spec.icon}</span>{t.spec.shortName}
                    </div>
                    <div style={{ fontSize:11, color: SW_COLORS.muted, marginTop:2 }}>{t.spec.label}</div>
                    <div style={{ fontFamily: SW_FONTS.mono, fontSize:10, fontWeight:700, color: SW_COLORS.muted, marginTop:4 }}>{t.spec.code}</div>
                  </div>
                  <span style={{ fontFamily: SW_FONTS.mono, fontSize:13, fontWeight:700, color: SW_COLORS.ink, whiteSpace:'nowrap' }}>×{t.count}</span>
                </div>
              </Card>
            ))}
          </div>
        )}

        {tab==='operations' && (
          <OperationsPanel garments={garments} initialGarmentId={initialGarment} openNewGarment={openNewGarment}/>
        )}

        {tab==='skills' && (
          <SkillMatrixPanel
            operators={operators}
            garmentId={skillsGarment}
            setGarmentId={setSkillsGarment}
            skillMatrix={skillMatrix}
            setSkill={setSkill}
            resetSkillMatrix={resetSkillMatrix}
            garments={garments}
          />
        )}

      </div>
    </div>
  );
}

// ── Operations editor ───────────────────────────────────────────────────────

const ALL_SKILL_IDS: SkillId[] = [
  'stitching', 'overlock', 'flatlock', 'kansai', 'feed_of_arm',
  'buttonhole', 'button_sew', 'bartack', 'embroidery',
  'cutting_manual', 'cutting_cad', 'spreading', 'fusing',
  'pressing', 'inspection', 'packing', 'bundling',
  'material_handling', 'supervision',
];

const ALL_OPERATION_CATEGORIES: OperationCategory[] = [
  'sewing', 'manual', 'cutting', 'spreading', 'pressing',
  'fusing', 'inspection', 'embroidery', 'finishing',
];

interface OperationsPanelProps {
  garments: EffectiveGarments;
  /** Optional deep-link target — when set, the panel opens with this garment
   *  pre-selected (e.g. from the Builder inspector's ?garment=<id>). */
  initialGarmentId?: string;
  /** Open the new-garment dialog on mount — the landing state for a
   *  "+ New garment" link arriving from another surface. */
  openNewGarment?: boolean;
}

/**
 * Operation library editor — pick a garment, edit / add / reorder / delete
 * its operations. Edits are stored in `project.garmentEdits` (built-in or
 * custom) and flow through `useGarments()` so every read site (LiveSim,
 * Line Balance, Twin run-line, etc.) picks them up immediately.
 */
function OperationsPanel({ garments, initialGarmentId, openNewGarment }: OperationsPanelProps) {
  const project = useProject();
  const confirm = useConfirm();
  const [garmentId, setGarmentId] = useState<string>(
    initialGarmentId && garments.byId[initialGarmentId]
      ? initialGarmentId
      : garments.all[0]?.id ?? '',
  );
  // Excel import state — `importBatch` is a queue of parsed previews (one
  // per selected file). Each entry is tagged with its `kind`: garment OBs
  // commit into the project library; floor layouts commit a new SewingLine
  // + Workstations into the canonical Twin. The preview modal
  // pages through the batch one entry at a time.
  type ImportEntry =
    | { kind: 'garment'; preview: ImportedGarment }
    | { kind: 'layout'; preview: ImportedFloor; placement: LayoutPlacement };
  const [importBatch, setImportBatch] = useState<ImportEntry[]>([]);
  const [importBatchIndex, setImportBatchIndex] = useState(0);
  const [importFailures, setImportFailures] = useState<{ file: string; reason: string }[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [newGarmentOpen, setNewGarmentOpen] = useState(!!openNewGarment);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const handleImportPick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    setImportError(null);
    setImportSummary(null);
    const fileList = Array.from(files);
    const reads = fileList.map(
      (file) =>
        new Promise<{ ok: true; entry: ImportEntry | ImportEntry[] } | { ok: false; file: string; reason: string }>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const buf = reader.result as ArrayBuffer;
            // Try OB first — operation breakdowns are the common case and
            // succeed quickly when the sheet matches. Only fall back to the
            // layout parser when no OB header is found.
            // Try OB first — operation breakdowns are the common case and
            // succeed quickly when the sheet matches.
            try {
              const preview = parseGarmentXlsx(buf, file.name);
              return resolve({ ok: true, entry: { kind: 'garment', preview } });
            } catch (eOb) {
              // Fall back to layout parser. Returns every layout sheet in
              // the workbook (some files genuinely hold more than one);
              // we expand them into individual batch entries.
              try {
                const floors = parseFloorXlsx(buf, file.name);
                const entries: ImportEntry[] = floors.map((floor) => ({
                  kind: 'layout',
                  preview: floor,
                  placement: placeLayoutStations(floor),
                }));
                return resolve({ ok: true, entry: entries });
              } catch (eLayout) {
                const ob = eOb instanceof Error ? eOb.message : String(eOb);
                const lay = eLayout instanceof Error ? eLayout.message : String(eLayout);
                return resolve({
                  ok: false,
                  file: file.name,
                  reason: `Not an OB (${ob}) and not a Machine Layout (${lay}).`,
                });
              }
            }
          };
          reader.onerror = () => resolve({ ok: false, file: file.name, reason: 'Could not read the file.' });
          reader.readAsArrayBuffer(file);
        }),
    );
    Promise.all(reads).then((results) => {
      const successes: ImportEntry[] = [];
      const failures: { file: string; reason: string }[] = [];
      for (const r of results) {
        if (r.ok) {
          if (Array.isArray(r.entry)) successes.push(...r.entry);
          else successes.push(r.entry);
        } else failures.push({ file: r.file, reason: r.reason });
      }
      // Garments first, then layouts — feels natural in the preview flow:
      // user reviews data first, then physical line placements.
      successes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'garment' ? -1 : 1));
      setImportBatch(successes);
      setImportBatchIndex(0);
      setImportFailures(failures);
      if (successes.length === 0 && failures.length > 0) {
        setImportError(`${failures.length} file${failures.length === 1 ? '' : 's'} failed to parse — see details below.`);
      }
      setImporting(false);
    });
  };

  const importPreview = importBatch[importBatchIndex] ?? null;

  const commitEntry = (entry: ImportEntry): string => {
    if (entry.kind === 'garment') {
      const g = entry.preview.garment;
      project.setGarmentEdit(g.id, g);
      setGarmentId(g.id);
      return `${g.name} (${g.operations.length} ops)`;
    }
    const twinStore = useTwin.getState();
    const result = commitFloorImport(twinStore, entry.preview, entry.placement);
    return `${entry.placement.lineName} (${result.workstationCount} stations)`;
  };

  const commitImport = () => {
    if (!importPreview) return;
    commitEntry(importPreview);
    if (importBatchIndex + 1 < importBatch.length) {
      setImportBatchIndex(importBatchIndex + 1);
    } else {
      setImportBatch([]);
      setImportBatchIndex(0);
    }
  };

  const commitAllImports = () => {
    if (importBatch.length === 0) return;
    const labels: string[] = [];
    for (const item of importBatch) {
      labels.push(commitEntry(item));
    }
    setImportBatch([]);
    setImportBatchIndex(0);
    setImportSummary(`Imported ${labels.length} item${labels.length === 1 ? '' : 's'}: ${labels.join('; ')}.`);
  };

  const skipImport = () => {
    if (importBatchIndex + 1 < importBatch.length) {
      setImportBatchIndex(importBatchIndex + 1);
    } else {
      setImportBatch([]);
      setImportBatchIndex(0);
    }
  };

  const cancelImport = () => {
    setImportBatch([]);
    setImportBatchIndex(0);
  };
  const garment = garments.byId[garmentId] ?? garments.all[0];
  const builtIn = GARMENT_TEMPLATES[garmentId];
  const isEdited = project.garmentEdits[garmentId] !== undefined;
  const isBuiltIn = !!builtIn;
  const hiddenIds = garments.hidden;

  function patch(p: Partial<Omit<GarmentTemplate, 'operations'>>) {
    project.patchGarment(garmentId, builtIn, p);
  }

  function addOp() {
    const newOp: Operation = {
      id: `${garmentId}-${Date.now().toString(36)}`,
      code: `OP-${(garment.operations.length + 1).toString().padStart(2, '0')}`,
      name: 'New operation',
      smv: 0.30,
      machineCode: 'SNL',
      skill: 'stitching',
      category: 'sewing',
    };
    project.addOperation(garmentId, builtIn, newOp);
  }

  /** Persist a garment authored in the new-template dialog and select it.
   *
   *  This replaced a `prompt()` that produced a garment with zero operations —
   *  a template you then had to build row by row before it could be run. The
   *  dialog parses a whole bulletin at once, so a new garment arrives usable.
   */
  function createGarment(g: GarmentTemplate) {
    project.setGarmentEdit(g.id, g);
    setGarmentId(g.id);
    setNewGarmentOpen(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Garment picker + meta */}
      <Card padding={16}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>GARMENT</span>
          <HudSelect
            value={garmentId}
            onChange={setGarmentId}
            variant="light"
            width={280}
            options={garments.all.map((g) => ({
              value: g.id,
              label: g.name.replace(/\s*\(.*\)/, '') + (project.garmentEdits[g.id] ? ' ●' : ''),
              meta: `${g.operations.length} ops`,
            }))}
          />
          <div style={{ flex: 1 }}/>
          <Button variant="secondary" size="sm" icon="+" onClick={() => setNewGarmentOpen(true)}>New garment</Button>
          {/* Import from Excel — feeds an industry operation-breakdown sheet
              (Modelama / Brandix / generic ERP export) through
              `parseGarmentXlsx` and previews the result in a confirm modal.
              Hidden <input> + button click forwards via ref. */}
          <input
            ref={importInputRef}
            type="file"
            multiple
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            style={{ display: 'none' }}
            onChange={(e) => {
              handleImportPick(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="⇣"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? 'Reading…' : 'Import Excel'}
          </Button>
          {/* Built-in edited rows expose a Reset that drops the override but
              keeps the garment in the picker — separate from the delete
              action, which removes it from the library entirely. */}
          {isBuiltIn && isEdited && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                if (await confirm({ title: 'Reset garment', message: `Reset ${garment.name} back to its built-in defaults? Your edits will be discarded.`, confirmLabel: 'Reset' })) {
                  project.resetGarment(garmentId);
                }
              }}
            >
              Reset to built-in
            </Button>
          )}
          {/* Delete works for every garment — built-ins are hidden from the
              picker (and their edits dropped) while customs are removed. */}
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete garment', message: `Delete ${garment.name}?`, confirmLabel: 'Delete', variant: 'danger' }))) return;
              const remaining = garments.all.filter((g) => g.id !== garmentId);
              const nextId = remaining[0]?.id ?? 'tshirt';
              if (isBuiltIn) {
                project.hideGarment(garmentId);
              } else {
                project.resetGarment(garmentId);
              }
              setGarmentId(nextId);
            }}
          >
            Delete garment
          </Button>
        </div>
        {hiddenIds.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
            margin: '0 0 10px', padding: '6px 10px',
            background: SW_COLORS.paperEdge, borderRadius: SW_RADIUS.md,
            fontSize: 11, color: SW_COLORS.muted,
          }}>
            <span style={{ fontFamily: SW_FONTS.mono, fontWeight: 700, letterSpacing: '0.5px' }}>HIDDEN</span>
            <span>· {hiddenIds.length} built-in{hiddenIds.length === 1 ? '' : 's'} removed from the picker:</span>
            {hiddenIds.map((id) => {
              const def = GARMENT_TEMPLATES[id];
              const label = def?.name ?? id;
              return (
                <button
                  key={id}
                  onClick={() => {
                    project.unhideGarment(id);
                    setGarmentId(id);
                  }}
                  style={{
                    background: SW_COLORS.paper, border: `1px solid ${SW_COLORS.line}`,
                    borderRadius: SW_RADIUS.sm, padding: '2px 8px', cursor: 'pointer',
                    fontSize: 11, color: SW_COLORS.ink, fontFamily: SW_FONTS.body,
                  }}
                  title={`Restore ${label} to the garment picker`}
                >
                  ↺ {label}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
          {/* Left column — Name and Description as peer text fields. They sit
              at the same visual level (same label style, same input style,
              stacked) so neither one feels more important than the other. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: SW_COLORS.muted, marginBottom: 4 }}>Name</div>
              <input value={garment.name} onChange={(e) => patch({ name: e.target.value })}
                aria-label="Garment name"
                style={headerField}/>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: SW_COLORS.muted, marginBottom: 4 }}>Description</div>
              <input value={garment.description} onChange={(e) => patch({ description: e.target.value })}
                aria-label="Garment description"
                placeholder="What is this garment?"
                style={headerField}/>
            </div>
          </div>
          {/* Bundle size + Total SAM share one card — they're both "size of a
              run" measurements and read more naturally as a pair than as two
              separate columns. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            border: `1px solid ${SW_COLORS.line}`,
            borderRadius: SW_RADIUS.sm,
            background: SW_COLORS.paperDeep,
            overflow: 'hidden',
          }}>
            <label style={{ padding: '6px 10px', borderRight: `1px solid ${SW_COLORS.line}`, display: 'block', cursor: 'text' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: SW_COLORS.muted, marginBottom: 4 }}>Default bundle size</div>
              {/* Borderless on purpose — the surrounding `<label>` cell is the
                  well and the whole cell is the click target, so a second
                  border inside it would read as a box in a box. It still needs
                  `color` + `colorScheme`: transparent over `paperDeep` left the
                  UA's dark `fieldtext` on a dark ground. */}
              <NumberInput value={garment.defaultBundleSize} min={1} max={500}
                aria-label="Default bundle size"
                onChange={(v) => { if (v !== undefined) patch({ defaultBundleSize: v }); }}
                style={{
                  ...headerField,
                  padding: 0,
                  border: 'none',
                  borderRadius: 0,
                  background: 'transparent',
                  fontFamily: SW_FONTS.mono,
                  fontSize: 14,
                }}/>
            </label>
            <div style={{ padding: '6px 10px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: SW_COLORS.muted, marginBottom: 4 }}>Total SAM</div>
              {/* Ink, not brand — this one is summed from the operations table,
                  so it is the derived half of the pair. */}
              <div style={{ fontFamily: SW_FONTS.mono, fontSize: 14, fontWeight: 700, color: SW_COLORS.ink }}>
                {garment.totalSmv.toFixed(3)} min
                <span style={{ color: SW_COLORS.muted, fontWeight: 600, marginLeft: 6, fontSize: 11 }}>· {garment.operations.length} ops</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Operations table */}
      <Card padding={0} style={{ overflow: 'auto', maxHeight: 'calc(100vh - 380px)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: SW_FONTS.body, fontSize: 12 }}>
          <thead>
            <tr style={{ background: SW_COLORS.paperDeep, borderBottom: `1px solid ${SW_COLORS.line}` }}>
              {['#', 'Order', 'Code', 'Name', 'SMV (min)', 'Machine', 'Skill', 'Category', ''].map((h) => (
                <th key={h} style={{ padding: '10px 10px', textAlign: 'left', fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {garment.operations.map((op, i) => (
              <tr key={op.id} style={{ borderBottom: `1px solid ${SW_COLORS.line}` }}>
                <td style={{ padding: '6px 10px', fontFamily: SW_FONTS.mono, fontWeight: 700, color: SW_COLORS.muted, width: 28 }}>{i + 1}</td>
                <td style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>
                  <button onClick={() => project.moveOperation(garmentId, builtIn, op.id, -1)} disabled={i === 0}
                    style={miniBtn(i === 0)}>↑</button>
                  <button onClick={() => project.moveOperation(garmentId, builtIn, op.id, 1)} disabled={i === garment.operations.length - 1}
                    style={miniBtn(i === garment.operations.length - 1)}>↓</button>
                </td>
                <td style={{ padding: '6px 6px' }}>
                  <input value={op.code ?? ''}
                    onChange={(e) => project.updateOperation(garmentId, builtIn, op.id, { code: e.target.value })}
                    style={cellInput(60)}
                  />
                </td>
                <td style={{ padding: '6px 6px' }}>
                  <input value={op.name}
                    onChange={(e) => project.updateOperation(garmentId, builtIn, op.id, { name: e.target.value })}
                    style={cellInput(220)}
                  />
                </td>
                <td style={{ padding: '6px 6px' }}>
                  <NumberInput value={op.smv} step={0.01} min={0.001}
                    aria-label={`SMV for ${op.name}`}
                    onChange={(v) => { if (v !== undefined) project.updateOperation(garmentId, builtIn, op.id, { smv: v }); }}
                    style={{ ...cellInput(72), fontFamily: SW_FONTS.mono, fontWeight: 700 }}
                  />
                </td>
                <td style={{ padding: '6px 6px' }}>
                  <HudSelect
                    value={op.machineCode}
                    onChange={(v) => project.updateOperation(garmentId, builtIn, op.id, { machineCode: v as MachineCode })}
                    variant="light"
                    size="sm"
                    mono
                    width="100%"
                    options={ALL_MACHINES.map((m) => ({ value: m.code, label: `${m.code} · ${m.shortName}` }))}
                  />
                </td>
                <td style={{ padding: '6px 6px' }}>
                  <HudSelect
                    value={op.skill}
                    onChange={(v) => project.updateOperation(garmentId, builtIn, op.id, { skill: v as SkillId })}
                    variant="light"
                    size="sm"
                    mono
                    width="100%"
                    options={ALL_SKILL_IDS.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
                  />
                </td>
                <td style={{ padding: '6px 6px' }}>
                  <HudSelect
                    value={op.category}
                    onChange={(v) => project.updateOperation(garmentId, builtIn, op.id, { category: v as OperationCategory })}
                    variant="light"
                    size="sm"
                    mono
                    width="100%"
                    options={ALL_OPERATION_CATEGORIES.map((c) => ({ value: c, label: c }))}
                  />
                </td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                  <button onClick={async () => {
                    if (await confirm({ title: 'Delete operation', message: `Delete ${op.code ?? op.name}?`, confirmLabel: 'Delete', variant: 'danger' })) project.removeOperation(garmentId, builtIn, op.id);
                  }} style={{ ...miniBtn(false), background: 'transparent', color: SW_COLORS.alarm, fontSize: 13 }}>×</button>
                </td>
              </tr>
            ))}
            {garment.operations.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 12 }}>
                  <EmptyState
                    size="sm"
                    icon="🪡"
                    title="No operations yet"
                    body={<>Click <strong style={{ color: SW_COLORS.ink }}>+ Add operation</strong> below to build this bulletin.</>}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paperDeep }}>
          <Button variant="primary" size="sm" icon="+" onClick={addOp}>Add operation</Button>
        </div>
      </Card>

      <div style={{ padding: 12, background: SW_COLORS.paper, border: `1px solid ${SW_COLORS.line}`, borderRadius: SW_RADIUS.sm, fontSize: 12, color: SW_COLORS.muted, lineHeight: 1.5 }}>
        Edits flow live to <strong style={{ color: SW_COLORS.ink }}>LiveSim</strong>, the <strong style={{ color: SW_COLORS.ink }}>Line Balance</strong> tab on Reports, the
        <strong style={{ color: SW_COLORS.ink }}> Factory Twin's run-line</strong>, and the <strong style={{ color: SW_COLORS.ink }}>skill matrix</strong>. Total SAM auto-recomputes on every change.
        Built-in garments restore their defaults via <em>Reset to built-in</em>; custom garments live entirely in your project file.
      </div>

      {importError && (
        <div
          style={{
            padding: 12,
            background: SW_COLORS.paper,
            border: `1px solid ${SW_COLORS.alarm}`,
            borderRadius: SW_RADIUS.sm,
            fontSize: 12,
            color: SW_COLORS.alarm,
            display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between',
          }}
        >
          <span><strong>Excel import failed:</strong> {importError}</span>
          <Button variant="ghost" size="sm" onClick={() => setImportError(null)}>Dismiss</Button>
        </div>
      )}

      {importFailures.length > 0 && (
        <div
          style={{
            padding: 12,
            background: SW_COLORS.paper,
            border: `1px solid ${SW_COLORS.warn}`,
            borderRadius: SW_RADIUS.sm,
            fontSize: 12,
            color: SW_COLORS.ink,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong style={{ color: SW_COLORS.warn }}>
              {importFailures.length} file{importFailures.length === 1 ? '' : 's'} skipped during import
            </strong>
            <Button variant="ghost" size="sm" onClick={() => setImportFailures([])}>Dismiss</Button>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: SW_COLORS.muted, fontSize: 11, lineHeight: 1.6 }}>
            {importFailures.map((f) => (
              <li key={f.file}><strong style={{ color: SW_COLORS.ink }}>{f.file}</strong> — {f.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {importSummary && (
        <div
          style={{
            padding: 12,
            background: SW_COLORS.paper,
            border: `1px solid ${SW_COLORS.ok}`,
            borderRadius: SW_RADIUS.sm,
            fontSize: 12,
            color: SW_COLORS.ink,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          }}
        >
          <span><strong style={{ color: SW_COLORS.ok }}>✓ Import complete</strong> — {importSummary}</span>
          <Button variant="ghost" size="sm" onClick={() => setImportSummary(null)}>Dismiss</Button>
        </div>
      )}

      {importPreview?.kind === 'garment' && (
        <ImportPreviewModal
          preview={importPreview.preview}
          batchIndex={importBatchIndex}
          batchTotal={importBatch.length}
          onCancel={cancelImport}
          onConfirm={commitImport}
          onSkip={skipImport}
          onConfirmAll={importBatch.length > 1 ? commitAllImports : undefined}
        />
      )}
      {importPreview?.kind === 'layout' && (
        <LayoutPreviewModal
          preview={importPreview.preview}
          placement={importPreview.placement}
          batchIndex={importBatchIndex}
          batchTotal={importBatch.length}
          onCancel={cancelImport}
          onConfirm={commitImport}
          onSkip={skipImport}
          onConfirmAll={importBatch.length > 1 ? commitAllImports : undefined}
        />
      )}
      {newGarmentOpen && (
        <NewGarmentTemplateDialog
          onCancel={() => setNewGarmentOpen(false)}
          onCreate={createGarment}
        />
      )}
    </div>
  );
}

// ── Excel import preview modal ───────────────────────────────────────────
/**
 * Confirm-before-commit modal for the Excel importer. Lists every parsed
 * operation with its mapped MachineCode + skill so the user can spot bad
 * machine inferences before the garment lands in the library.
 */
function ImportPreviewModal({
  preview,
  onCancel,
  onConfirm,
  onSkip,
  onConfirmAll,
  batchIndex,
  batchTotal,
}: {
  preview: ImportedGarment;
  onCancel: () => void;
  onConfirm: () => void;
  onSkip?: () => void;
  onConfirmAll?: () => void;
  batchIndex: number;
  batchTotal: number;
}) {
  const g = preview.garment;
  const totalCount = g.operations.length;
  const machineBreakdown = useMemo(() => {
    const byCode = new Map<string, number>();
    for (const op of g.operations) byCode.set(op.machineCode, (byCode.get(op.machineCode) ?? 0) + 1);
    return Array.from(byCode.entries()).sort((a, b) => b[1] - a[1]);
  }, [g.operations]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: alpha(SW_COLORS.ink, 0.55),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(960px, 96vw)',
          maxHeight: '88vh',
          background: SW_COLORS.paper,
          border: `1px solid ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.md,
          boxShadow: '0 24px 60px rgba(15,20,25,0.35)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${SW_COLORS.line}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: SW_COLORS.muted }}>
              Import preview
              {batchTotal > 1 && (
                <span style={{ marginLeft: 8, color: SW_COLORS.brand }}>
                  · {batchIndex + 1} of {batchTotal}
                </span>
              )}
            </div>
            <div style={{ fontFamily: SW_FONTS.display, fontSize: 20, fontWeight: 800, color: SW_COLORS.ink, marginTop: 2 }}>{g.name}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{ border: 'none', background: 'transparent', fontSize: 22, color: SW_COLORS.muted, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '12px 18px', borderBottom: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paperDeep, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Stat label="Operations" value={totalCount.toString()} />
          <Stat label="Total SAM" value={`${g.totalSmv.toFixed(3)} min`} />
          <Stat label="Target / hr @100%" value={`${g.hourlyTarget100}`} />
          <Stat label="Class" value={g.class} />
        </div>

        <div style={{ padding: '8px 18px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paper }}>
          {preview.source.style && <Tag>{`Style: ${preview.source.style}`}</Tag>}
          {preview.source.customer && <Tag>{`Customer: ${preview.source.customer}`}</Tag>}
          {preview.source.declaredSmv !== undefined && (
            <Tag>{`Declared SMV: ${preview.source.declaredSmv}`}</Tag>
          )}
          {preview.source.declaredManpower !== undefined && (
            <Tag>{`Declared manpower: ${preview.source.declaredManpower.toFixed(1)}`}</Tag>
          )}
          <Tag>{`File: ${preview.source.fileName}`}</Tag>
        </div>

        {machineBreakdown.length > 0 && (
          <div style={{ padding: '8px 18px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${SW_COLORS.line}` }}>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, marginRight: 6, alignSelf: 'center', letterSpacing: '0.5px' }}>MIX</span>
            {machineBreakdown.map(([code, n]) => (
              <Tag key={code}>{`${code} · ${n}`}</Tag>
            ))}
          </div>
        )}

        {preview.warnings.length > 0 && (
          <div style={{ padding: '8px 18px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {preview.warnings.map((w, i) => (
              <div key={i} style={{ fontSize: 11, color: SW_COLORS.warn }}>⚠ {w}</div>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 18px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: SW_FONTS.body, fontSize: 12 }}>
            <thead>
              <tr style={{ background: SW_COLORS.paperDeep }}>
                {['#', 'Code', 'Name', 'SMV', 'Machine', 'Skill', 'Category', 'Notes'].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '6px 8px', textAlign: 'left',
                      fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700,
                      color: SW_COLORS.muted, letterSpacing: '0.5px',
                      borderBottom: `1px solid ${SW_COLORS.line}`,
                      position: 'sticky', top: 0, background: SW_COLORS.paperDeep,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.operations.map((op, i) => (
                <tr key={op.id} style={{ borderBottom: `1px solid ${SW_COLORS.line}` }}>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, color: SW_COLORS.muted, width: 28 }}>{i + 1}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11 }}>{op.code ?? ''}</td>
                  <td style={{ padding: '4px 8px' }}>{op.name}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11, textAlign: 'right' }}>{op.smv.toFixed(3)}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11 }}>{op.machineCode}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11 }}>{op.skill}</td>
                  <td style={{ padding: '4px 8px', fontSize: 11, color: SW_COLORS.muted }}>{op.category}</td>
                  <td style={{ padding: '4px 8px', fontSize: 11, color: SW_COLORS.muted, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={op.notes ?? ''}>{op.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '12px 18px', borderTop: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paperDeep, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 11, color: SW_COLORS.muted, maxWidth: 380 }}>
            Confirming creates a new custom garment in your library. You can edit operations, SMVs, and machine codes afterward.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
            {onSkip && batchTotal > 1 && (
              <Button variant="ghost" size="sm" onClick={onSkip}>Skip this one</Button>
            )}
            {onConfirmAll && (
              <Button variant="secondary" size="sm" onClick={onConfirmAll}>
                Add all ({batchTotal})
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={onConfirm}>
              {batchTotal > 1 ? `Add & next` : `Add to garment library`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Machine-Layout preview modal ────────────────────────────────────────
/**
 * Sibling of `ImportPreviewModal` that handles Modelama-style Machine
 * Layout files. The body summarises the line (station count, machine
 * mix, source meta) and shows a simple top-down schematic of the two
 * facing rows so the user can sanity-check placement before the new
 * SewingLine + Workstations are dropped into the Twin.
 */
function LayoutPreviewModal({
  preview,
  placement,
  onCancel,
  onConfirm,
  onSkip,
  onConfirmAll,
  batchIndex,
  batchTotal,
}: {
  preview: ImportedFloor;
  placement: LayoutPlacement;
  onCancel: () => void;
  onConfirm: () => void;
  onSkip?: () => void;
  onConfirmAll?: () => void;
  batchIndex: number;
  batchTotal: number;
}) {
  const counts = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const s of placement.stations) byCat.set(s.catalogId, (byCat.get(s.catalogId) ?? 0) + 1);
    return Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);
  }, [placement.stations]);

  // Schematic dimensions
  const cellPx = 18;
  const padPx = 12;
  const schematicW = placement.widthCells * cellPx + padPx * 2;
  const schematicH = placement.depthCells * cellPx + padPx * 2;

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: alpha(SW_COLORS.ink, 0.55),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(960px, 96vw)',
          maxHeight: '88vh',
          background: SW_COLORS.paper,
          border: `1px solid ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.md,
          boxShadow: '0 24px 60px rgba(15,20,25,0.35)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${SW_COLORS.line}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: SW_COLORS.muted }}>
              Layout preview
              {batchTotal > 1 && (
                <span style={{ marginLeft: 8, color: SW_COLORS.brand }}>
                  · {batchIndex + 1} of {batchTotal}
                </span>
              )}
            </div>
            <div style={{ fontFamily: SW_FONTS.display, fontSize: 20, fontWeight: 800, color: SW_COLORS.ink, marginTop: 2 }}>
              {placement.lineName}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{ border: 'none', background: 'transparent', fontSize: 22, color: SW_COLORS.muted, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '12px 18px', borderBottom: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paperDeep, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Stat label="Stations" value={placement.stations.length.toString()} />
          <Stat label="Declared M/C" value={(preview.source.machineCount ?? '—').toString()} />
          <Stat label="Declared W/S" value={(preview.source.workstationCount ?? '—').toString()} />
          <Stat label="Machine SMV" value={preview.source.machineSmv != null ? `${preview.source.machineSmv} min` : '—'} />
        </div>

        <div style={{ padding: '8px 18px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paper }}>
          {preview.source.style && <Tag>{`Style: ${preview.source.style}`}</Tag>}
          {preview.source.buyer && <Tag>{`Buyer: ${preview.source.buyer}`}</Tag>}
          {preview.source.description && <Tag>{preview.source.description}</Tag>}
          {preview.source.lineNo != null && <Tag>{`Line ${preview.source.lineNo}`}</Tag>}
          {preview.source.target != null && <Tag>{`Target ${Math.round(preview.source.target)}/8h`}</Tag>}
          <Tag>{`File: ${preview.source.fileName}`}</Tag>
        </div>

        {counts.length > 0 && (
          <div style={{ padding: '8px 18px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${SW_COLORS.line}` }}>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, marginRight: 6, alignSelf: 'center', letterSpacing: '0.5px' }}>MIX</span>
            {counts.map(([id, n]) => (
              <Tag key={id}>{`${id.replace(/^a_/, '')} · ${n}`}</Tag>
            ))}
          </div>
        )}

        {preview.warnings.length > 0 && (
          <div style={{ padding: '8px 18px 0', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 80, overflow: 'auto' }}>
            {preview.warnings.slice(0, 6).map((w, i) => (
              <div key={i} style={{ fontSize: 11, color: SW_COLORS.warn }}>⚠ {w}</div>
            ))}
            {preview.warnings.length > 6 && (
              <div style={{ fontSize: 11, color: SW_COLORS.muted }}>… and {preview.warnings.length - 6} more</div>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 18px' }}>
          {/* Top-down schematic of the two facing rows */}
          <div style={{ marginBottom: 12, fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>
            SCHEMATIC · {placement.widthCells}×{placement.depthCells} cells
          </div>
          <div style={{
            background: SW_COLORS.paperDeep,
            border: `1px solid ${SW_COLORS.line}`,
            borderRadius: SW_RADIUS.sm,
            overflow: 'auto',
            marginBottom: 16,
          }}>
            <svg width={schematicW} height={schematicH} style={{ display: 'block' }}>
              {/* aisle band */}
              <rect
                x={padPx} y={padPx + cellPx * 2}
                width={placement.widthCells * cellPx} height={cellPx * 2}
                fill={SW_COLORS.paper} opacity={0.6}
              />
              {placement.stations.map((s, i) => (
                <g key={i} transform={`translate(${padPx + s.x * cellPx}, ${padPx + s.y * cellPx})`}>
                  <rect
                    width={cellPx * 2 - 2} height={cellPx * 2 - 2}
                    rx={2}
                    fill={catalogColor(s.catalogId)}
                    stroke={SW_COLORS.line}
                    strokeWidth={0.5}
                  />
                  <text
                    x={cellPx} y={cellPx + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fontFamily={SW_FONTS.mono}
                    fontWeight={700}
                    fill={SW_COLORS.paper}
                  >
                    {s.catalogId.replace(/^a_/, '').slice(0, 4).toUpperCase()}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          {/* Station list as a table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: SW_FONTS.body, fontSize: 12 }}>
            <thead>
              <tr style={{ background: SW_COLORS.paperDeep }}>
                {['Seq', 'Code', 'Name', 'Raw M/C', 'Mapped', 'Side'].map((h) => (
                  <th key={h} style={{
                    padding: '6px 8px', textAlign: 'left',
                    fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700,
                    color: SW_COLORS.muted, letterSpacing: '0.5px',
                    borderBottom: `1px solid ${SW_COLORS.line}`,
                    position: 'sticky', top: 0, background: SW_COLORS.paperDeep,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {placement.stations.map((s) => (
                <tr key={s.seq} style={{ borderBottom: `1px solid ${SW_COLORS.line}` }}>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, color: SW_COLORS.muted, width: 32 }}>{s.seq + 1}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11 }}>{s.codeNo ?? ''}</td>
                  <td style={{ padding: '4px 8px' }}>{s.name}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>{s.rawMachine}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11 }}>{s.catalogId}</td>
                  <td style={{ padding: '4px 8px', fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>{s.side}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '12px 18px', borderTop: `1px solid ${SW_COLORS.line}`, background: SW_COLORS.paperDeep, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 11, color: SW_COLORS.muted, maxWidth: 420 }}>
            Confirming adds a new SewingLine + {placement.stations.length} workstations to the canonical Twin, placed to the right of whatever is already on the floor.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
            {onSkip && batchTotal > 1 && (
              <Button variant="ghost" size="sm" onClick={onSkip}>Skip this one</Button>
            )}
            {onConfirmAll && (
              <Button variant="secondary" size="sm" onClick={onConfirmAll}>
                Add all ({batchTotal})
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={onConfirm}>
              {batchTotal > 1 ? 'Add & next' : 'Add line to Twin'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pick a category-flavoured tint for the layout schematic blocks. The
 *  Builder uses richer SVG, but for the preview a flat colour per
 *  fixture-family reads clearly at small sizes. */
function catalogColor(catalogId: string): string {
  if (catalogId.startsWith('a_5ol') || catalogId.startsWith('a_4ol')) return SW_COLORS.bobbin;
  if (catalogId.startsWith('a_iron') || catalogId.includes('press')) return SW_COLORS.press;
  if (catalogId.startsWith('a_inspect') || catalogId.includes('table')) return SW_COLORS.muted;
  if (catalogId.startsWith('a_op')) return SW_COLORS.thread;
  if (catalogId.startsWith('a_bart') || catalogId.startsWith('a_button')) return SW_COLORS.alarm;
  if (catalogId.startsWith('a_kn') || catalogId.startsWith('a_cnc') || catalogId.startsWith('a_spread')) return SW_COLORS.steel;
  return SW_COLORS.brand;
}

function miniBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 22, height: 22, marginRight: 2,
    background: disabled ? SW_COLORS.paperEdge : SW_COLORS.paper,
    color: disabled ? SW_COLORS.faint : SW_COLORS.ink,
    border: `1px solid ${SW_COLORS.line}`,
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    fontWeight: 800,
    fontFamily: SW_FONTS.mono,
  };
}

function cellInput(width: number): React.CSSProperties {
  return {
    width,
    padding: '5px 7px',
    border: `1px solid ${SW_COLORS.line}`,
    borderRadius: 4,
    fontFamily: SW_FONTS.body,
    fontSize: 12,
    fontWeight: 600,
    background: SW_COLORS.paper,
    color: SW_COLORS.ink,
  };
}

/**
 * The garment header's three editable fields — Name, Description, Default
 * bundle size.
 *
 * These were the last inputs in the app still carrying hand-rolled styles, and
 * all three were unreadable for the same reason: an `<input>` left without a
 * `background` falls back to the UA's light `field` ground, and left without a
 * `color` to the UA's dark `fieldtext`. Name got UA-on-UA (legible, but a white
 * hole punched in a dark panel); Description set `color: ink` and kept the
 * white ground, so near-white text sat on near-white; bundle size set
 * `background: transparent` over the `paperDeep` well and kept UA text, so
 * near-black sat on near-black. Two of the three were invisible.
 *
 * `colorScheme: 'dark'` is what actually fixes the class of bug rather than
 * these three instances: it moves the UA's own `field`/`fieldtext`/caret
 * defaults to their dark variants, so the fallbacks are dark-correct even
 * where a style is later overridden.
 *
 * The typed value reads in `brand`, not `ink`: everything in this header is
 * authored by the user, and the header sits directly above an operations table
 * whose numbers are computed from it (Total SAM, the SMV column). Orange for
 * "you typed this", ink for "the app derived this" — 6.8:1 on `paper` and
 * 6.2:1 on `paperDeep`, so both clear AA.
 */
const HEADER_FIELD_TEXT = SW_COLORS.brand;

const headerField: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: SW_RADIUS.sm,
  border: `1px solid ${SW_COLORS.line}`,
  background: SW_COLORS.paper,
  color: HEADER_FIELD_TEXT,
  colorScheme: 'dark',
  fontFamily: SW_FONTS.body,
  fontSize: 13,
  fontWeight: 700,
  outline: 'none',
};

// ── Skill matrix ────────────────────────────────────────────────────────────

interface SkillMatrixPanelProps {
  operators: SeededOperator[];
  garmentId: string;
  setGarmentId: (id: string) => void;
  skillMatrix: Record<string, Record<string, number>>;
  setSkill: (operatorId: string, opId: string, efficiency: number) => void;
  resetSkillMatrix: () => void;
  garments: EffectiveGarments;
}

/**
 * Operator × Operation efficiency grid for one garment template.
 *
 * Defaults: an operator gets 1.0 efficiency on operations whose required
 * skill is in their archetype's primarySkills, 0.7 on secondarySkills, and
 * 0 (= cannot perform) otherwise. The user overrides any cell — overrides
 * persist to the project store.
 *
 * Cell colour is a heat: green (≥0.9) → yellow (0.6–0.9) → red (<0.6) →
 * grey (0 = ineligible). Click any cell to type a new value.
 */
function SkillMatrixPanel({
  operators, garmentId, setGarmentId, skillMatrix, setSkill, resetSkillMatrix, garments,
}: SkillMatrixPanelProps) {
  const confirm = useConfirm();
  const garment = garments.byId[garmentId] ?? garments.all[0];
  const ops = garment.operations;

  function defaultEfficiency(arch: WorkerArchetype, opSkill: SkillId): number {
    if (arch.primarySkills.includes(opSkill)) return arch.baseEfficiency;
    if (arch.secondarySkills?.includes(opSkill)) return arch.baseEfficiency * 0.7;
    return 0;
  }

  function effFor(op: SeededOperator, operation: Operation): number {
    const stored = skillMatrix[op.id]?.[operation.id];
    if (stored !== undefined) return stored;
    return defaultEfficiency(op.archetype, operation.skill);
  }

  function cellColor(eff: number): string {
    if (eff <= 0) return SW_COLORS.paperEdge;
    if (eff < 0.6) return `${SW_COLORS.alarm}60`;
    if (eff < 0.9) return `${SW_COLORS.thread}60`;
    return `${SW_COLORS.ok}80`;
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap: 14 }}>
      <div style={{ display:'flex', alignItems:'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap: 8 }}>
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>GARMENT</span>
          <ToggleGroup value={garmentId} onChange={setGarmentId} options={garments.all.map(g => ({ value: g.id, label: g.name.replace(/\s*\(.*\)/, '') }))}/>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ display:'flex', alignItems:'center', gap: 14, fontSize: 11, fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>
          <LegendChip color={SW_COLORS.ok} label="≥90"/>
          <LegendChip color={SW_COLORS.thread} label="60–89"/>
          <LegendChip color={SW_COLORS.alarm} label="<60"/>
          <LegendChip color={SW_COLORS.paperEdge} label="—"/>
        </div>
        <Button variant="ghost" size="sm" onClick={async () => {
          if (await confirm({ title: 'Reset skill matrix', message: 'Reset every skill cell to the role defaults?', confirmLabel: 'Reset' })) resetSkillMatrix();
        }}>Reset to defaults</Button>
      </div>

      <Card padding={0} style={{ overflow: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: SW_FONTS.body, fontSize: 11 }}>
          <thead>
            <tr style={{ background: SW_COLORS.paperDeep }}>
              <th style={{ position: 'sticky', left: 0, background: SW_COLORS.paperDeep, padding: '8px 10px', textAlign: 'left', minWidth: 200, borderRight: `1px solid ${SW_COLORS.line}`, fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '1px', zIndex: 1 }}>OPERATOR</th>
              {ops.map((op) => (
                <th key={op.id} title={`${op.code} ${op.name} · ${op.smv.toFixed(2)} min · ${op.machineCode}`}
                  style={{ padding: '8px 4px', textAlign: 'center', minWidth: 56, fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '0.5px', borderBottom: `1px solid ${SW_COLORS.line}`, verticalAlign: 'bottom' }}>
                  <div>{op.code ?? ''}</div>
                  <div style={{ fontSize: 8, color: SW_COLORS.faint, marginTop: 2 }}>{op.machineCode}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {operators.map((op) => (
              <tr key={op.id} style={{ borderBottom: `1px solid ${SW_COLORS.line}` }}>
                <td style={{ position: 'sticky', left: 0, background: SW_COLORS.paper, padding: '6px 10px', borderRight: `1px solid ${SW_COLORS.line}`, zIndex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 18, height: 18, borderRadius: 4, background: op.archetype.color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>{op.archetype.icon}</span>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700 }}>{op.id} {op.name}</div>
                      <div style={{ fontSize: 9, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono }}>{op.archetype.label}</div>
                    </div>
                  </div>
                </td>
                {ops.map((operation) => {
                  const eff = effFor(op, operation);
                  return (
                    <td key={operation.id} style={{ padding: 1, textAlign: 'center', background: cellColor(eff) }}>
                      <NumberInput
                        min={0} max={120} step={5} value={Math.round(eff * 100)}
                        aria-label={`Skill %`}
                        onChange={(v) => { if (v !== undefined) setSkill(op.id, operation.id, v / 100); }}
                        style={{
                          width: '100%', padding: '4px 0', textAlign: 'center',
                          background: 'transparent', border: 'none',
                          fontFamily: SW_FONTS.mono, fontWeight: 700, fontSize: 10,
                          color: eff > 0 ? SW_COLORS.ink : SW_COLORS.faint,
                        }}
                        title={`${op.id} on ${operation.code}: ${(eff * 100).toFixed(0)}% efficiency`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div style={{ padding: 12, background: SW_COLORS.paper, border: `1px solid ${SW_COLORS.line}`, borderRadius: SW_RADIUS.sm, fontSize: 12, color: SW_COLORS.muted, lineHeight: 1.5 }}>
        Cells default to the operator's archetype: <strong style={{ color: SW_COLORS.ink }}>primary skills = base efficiency</strong> (≈85% for sewing operators), <strong style={{ color: SW_COLORS.ink }}>secondary = 70% of base</strong>, otherwise 0 (ineligible). Override any cell to capture per-operator know-how — values persist locally and travel with the .swproj file.
      </div>
    </div>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color }}/>
      {label}
    </span>
  );
}

// ── Demo seeding helpers — deterministic so the table is stable per session ──

interface SeededOperator {
  id: string;
  name: string;
  archetype: WorkerArchetype;
  eff: number;
  sam: string;
  /** Parent sewing-line name when the row came from a real Twin operator;
   *  blank for synthesised demo rows. */
  lineName?: string;
  /** "3 stns · rotation", "1 stn · primary", etc. — empty for demo rows. */
  assignmentSummary?: string;
  /** Per-station breakdown for twin-derived rows — drives the expandable
   *  "stations" column so the user sees which workstations an operator
   *  covers and at what share %. Empty / missing for demo rows. */
  stationDetails?: Array<{ wsName: string; sharePct: number; role: string }>;
  /** True when this operator's non-rotation shareFrac sums to > 1.0 —
   *  surfaced as a ⚠ OVERALLOCATED chip. The validator emits a matching
   *  warning string in `validateTwin`. */
  overallocated?: boolean;
}

/** Map an Operator entity from the active twin onto the row shape the
 *  Operators table already knows how to render. Each operator's
 *  Assignment rows are summarised into a single "N stns · <role>" tag
 *  so the user sees fixed-station vs rotation membership at a glance. */
function operatorsFromTwin(
  operators: TwinOperator[],
  assignments: Assignment[],
  lines: SewingLine[],
  workstationsById: Map<string, { id: string; name: string }>,
): SeededOperator[] {
  const linesById = new Map(lines.map((l) => [l.id, l]));
  const byOperator = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const arr = byOperator.get(a.operatorId) ?? [];
    arr.push(a);
    byOperator.set(a.operatorId, arr);
  }
  return operators.map((op, i) => {
    const role = (op.archetypeId as WorkerRole) ?? 'sew_op';
    const archetype = WORKER_ARCHETYPES[role] ?? WORKER_ARCHETYPES.sew_op;
    const myAssignments = byOperator.get(op.id) ?? [];
    // Pick the dominant assignment role for the summary tag. Rotation wins
    // when any rotation_member assignment exists, otherwise the first
    // assignment's role; falls back to "floater" for un-assigned operators.
    const dominant =
      myAssignments.find((a) => a.role === 'rotation_member')?.role ??
      myAssignments[0]?.role ??
      (op.floats ? 'floater' : 'floater');
    const summary =
      myAssignments.length === 0
        ? op.floats
          ? '— · floater'
          : '— · unassigned'
        : `${myAssignments.length} stn${myAssignments.length === 1 ? '' : 's'} · ${dominant}`;
    // Per-station breakdown — drives the expandable list under the summary.
    const stationDetails = myAssignments.map((a) => {
      const sharePct =
        a.shareFrac !== undefined
          ? Math.round(a.shareFrac * 100)
          : a.role === 'primary'
            ? 100
            : a.role === 'helper'
              ? 30
              : a.role === 'rotation_member'
                ? Math.round(100 / Math.max(1, myAssignments.length))
                : 0;
      return {
        wsName: workstationsById.get(a.wsId)?.name ?? a.wsId,
        sharePct,
        role: a.role,
      };
    });
    // Σ shareFrac across non-rotation assignments. Rotation members are
    // expected to sum near 1 (one operator splits attention across their
    // rotation by design) so they don't count toward over-allocation.
    const nonRotSum = myAssignments
      .filter((a) => a.role !== 'rotation_member')
      .reduce((s, a) => s + (a.shareFrac ?? (a.role === 'primary' ? 1 : a.role === 'helper' ? 0.3 : 0)), 0);
    const overallocated = nonRotSum > 1.001;
    // Average skill efficiency × 100 ⇒ display %.
    const avgEff =
      op.skills.length > 0
        ? Math.round(
            (op.skills.reduce((s, sk) => s + sk.efficiency, 0) / op.skills.length) * 100,
          )
        : Math.round(archetype.baseEfficiency * 100);
    return {
      id: `OPR-${String(i + 1).padStart(2, '0')}`,
      name: op.name,
      archetype,
      eff: avgEff,
      sam: '—',
      lineName: op.lineId ? linesById.get(op.lineId)?.name ?? '—' : '—',
      assignmentSummary: summary,
      stationDetails,
      overallocated,
    };
  });
}

const NAMES = ['Aanya','Rohan','Mei','Kofi','Lara','Yui','Tariq','Sara','Rafa','Nina','Diego','Eun','Jamal','Priya','Ola','Ravi','Lin','Pavel','Kemi','Iris','Boun','Asha','Nova','Tomi','Hina','Beto','Hai','Anya','Karim','Joon'];

/**
 * Distribute operators across worker archetypes proportional to each
 * archetype's typical headcount on a 100-operator finishing-room. Counts
 * sum to ~30 to keep the table readable.
 */
const ROLE_DISTRIBUTION: Partial<Record<WorkerArchetype['role'], number>> = {
  sew_op: 14, helper: 3, cutter: 2, spreader: 1, bundler: 2,
  qc_inline: 2, qc_final: 1, presser: 2, packer: 2, material_handler: 2,
  supervisor: 1,
};

/**
 * Build a synthetic operator roster sized to match the factory headcount
 * configured across all lines. Roles are scaled proportionally from
 * `ROLE_DISTRIBUTION`; rounding drift is absorbed by the largest role
 * (sew_op) so the total exactly equals `target`. Falls back to the
 * unscaled distribution when `target` is 0 / undefined.
 */
function buildOperators(target?: number): SeededOperator[] {
  const baseSum = Object.values(ROLE_DISTRIBUTION).reduce((s, v) => s + (v || 0), 0);
  const scale = target && baseSum ? target / baseSum : 1;
  const counts = new Map<WorkerArchetype['role'], number>();
  let assigned = 0;
  for (const archetype of ALL_WORKER_ARCHETYPES) {
    const base = ROLE_DISTRIBUTION[archetype.role] ?? 0;
    if (base === 0) continue;
    const scaled = scale === 1 ? base : Math.max(1, Math.round(base * scale));
    counts.set(archetype.role, scaled);
    assigned += scaled;
  }
  // Absorb rounding drift into sew_op so the total matches the factory.
  if (target && assigned !== target) {
    const drift = target - assigned;
    const sewCount = counts.get('sew_op') ?? 0;
    counts.set('sew_op', Math.max(1, sewCount + drift));
  }
  const out: SeededOperator[] = [];
  let n = 1;
  for (const archetype of ALL_WORKER_ARCHETYPES) {
    const count = counts.get(archetype.role) ?? 0;
    for (let i = 0; i < count; i++) {
      const idx = (n - 1) % NAMES.length;
      // Deterministic eff variation seeded by id.
      const eff = Math.round(archetype.baseEfficiency * 100 + ((n * 17) % 25) - 12);
      out.push({
        id: `OPR-${n.toString().padStart(2, '0')}`,
        name: NAMES[idx],
        archetype,
        eff: Math.max(40, Math.min(99, eff)),
        sam: (1.4 + ((n * 13) % 17) * 0.08).toFixed(2),
      });
      n++;
    }
  }
  return out;
}

interface MachineType {
  spec: MachineSpec;
  /** How many of this machine type the factory runs. */
  count: number;
}

/**
 * Headcount per machine type for a balanced sewing line. Proportions match
 * the Brandix-era SMV sheet (4× 4OL, 10× SNL, 1× FB, 1× BS, 4× FL, 1× BH).
 */
const MACHINE_DISTRIBUTION: Partial<Record<MachineSpec['code'], number>> = {
  SNL: 10, '4OL': 4, FL: 4, FB: 1, KS: 1, BH: 1, BS: 1, BT: 1,
  CUT: 2, SPR: 1, FUSE: 1, PRESS: 3, EMB: 1, INSP: 2,
};

/**
 * The machine tab is a catalog of the machine *types* on the floor — one card
 * per type with a count — rather than a per-unit inventory. Health, run-hours
 * and per-unit identity are intentionally out of scope for this tool.
 */
function buildMachineTypes(): MachineType[] {
  const out: MachineType[] = [];
  for (const spec of ALL_MACHINES) {
    if (spec.isManual) continue;
    const count = MACHINE_DISTRIBUTION[spec.code] ?? 0;
    if (count > 0) out.push({ spec, count });
  }
  return out;
}
