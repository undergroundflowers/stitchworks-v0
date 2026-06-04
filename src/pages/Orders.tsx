import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { Card, Button, Stat, SectionHeader, ProductionSystemDiagram, HudSelect } from '../components';
import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ALL_PRODUCTION_SYSTEMS,
  PRODUCTION_SYSTEMS,
  type ProductionSystem,
  pitchTime,
  crewSizeFor,
  systemFeasibilityHint,
} from '../domain';
import type { GarmentTemplate, GarmentClass } from '../domain/garments';
import type { Operation, OperationCategory } from '../domain/operations';
import type { MachineCode } from '../domain/machines';
import type { SkillId } from '../domain/workers';
import { useProject, useGarments } from '../store';
import { useTwin, selectActiveTwin } from '../store/twin';
import { shareDebtForLine } from '../domain/twin';
import { buildSeededDraftTwin, mapToLineSystem } from '../lib/build-draft-twin';

interface OrderState {
  po: string;
  client: string;
  style: string;
  qty: number;
  deadlineDays: number;
  garmentTemplateId: string;
  target: string;
}

/**
 * Order setup — the user enters PO/client/style/qty/deadline, picks a
 * garment template (T-shirt / Polo / Shirt / Trouser / Sweatshirt, all
 * sourced from the apparel domain layer with literature-backed SMVs), and
 * picks a production system. Stitchworks computes pitch time, theoretical
 * crew size and recommends the system that best fits qty × deadline.
 */
export function OrdersPage() {
  const navigate = useNavigate();
  const project = useProject();
  const garments = useGarments();
  const [order, setOrder] = useState<OrderState>({
    po: '',
    client: '',
    style: '',
    qty: 1200,
    deadlineDays: 5,
    garmentTemplateId: project.selectedGarmentId,
    target: 'AQL 2.5',
  });
  // Seed the selected system with whatever recommendSystem() suggests for the
  // initial qty/deadline so the "Recommended" tile is highlighted on first
  // paint instead of defaulting to PBS.
  const [system, setSystem] = useState<ProductionSystem>(() => recommendSystem(1200, 5));
  // Hovering a system tile previews its topology + description without
  // committing the selection. Falls back to the active `system` when null.
  const [hoveredSystem, setHoveredSystem] = useState<ProductionSystem | null>(null);
  const previewSystem = PRODUCTION_SYSTEMS[hoveredSystem ?? system];
  const isPreviewing = hoveredSystem !== null && hoveredSystem !== system;
  // "+ New template" tile opens a modal that builds a custom GarmentTemplate
  // from a quick form + operations textarea. The new template is persisted in
  // `project.garmentEdits` so it shows up everywhere the garments hook is read.
  const [newTplOpen, setNewTplOpen] = useState(false);

  /**
   * Save the order's chosen garment + computed crew to the project store,
   * then navigate to LiveSim. Downstream pages (LiveSim, Reports, Resources
   * skill tab) pick the new defaults up automatically.
   */
  function commit(target: '/sim') {
    const saved = persistOrder();
    navigate(`${target}?source=order:${saved.id}`);
  }

  /**
   * Build-in-Builder flow — opens a fresh, isolated Factory Builder draft in
   * a NEW BROWSER TAB so the user's current factory stays untouched on the
   * original tab. Steps:
   *
   *   1. Persist the order (so it shows up in the LiveSim source dropdown).
   *   2. Build a blank twin in memory with one Sewing department and one
   *      seeded SewingLine carrying the order's garment, system and crew.
   *   3. Push that twin as a new (non-active) scenario via the twin store.
   *      It enters the user's scenario library so it can be returned to from
   *      the canonical-factory picker later.
   *   4. Open `/builder?scenario=<id>&line=<id>` in a new tab. Builder
   *      activates the scenario in *this tab only* and selects the seeded
   *      line's parent dept so the Inspector opens straight to its lines.
   *
   * Falling back to in-tab navigation when the popup is blocked keeps the
   * flow usable when the browser refuses window.open.
   */
  function commitToBuilder() {
    const saved = persistOrder();
    const garment = garments.byId[saved.garmentTemplateId];
    const draftName = `${saved.po} · ${garment?.name ?? saved.style}`;

    // Shared builder also auto-places one workstation per operation in the
    // garment bulletin, so the user lands on a populated sewing line ready
    // to refine — not an empty Sewing Floor.
    const draft = buildSeededDraftTwin({
      draftName,
      productionSystem: mapToLineSystem(saved.productionSystem),
      garment,
      operatorTarget: saved.operators,
      color: 'brand',
      notes: `Auto-created from ${saved.po} (${saved.client}). ${saved.qty} pcs in ${saved.deadlineDays} d.`,
    });

    const scenarioId = useTwin.getState().createScenarioFromTwin({
      name: `Draft · ${draftName}`,
      notes: `Build-in-Builder draft for ${saved.po} (${saved.client}).`,
      twin: draft.twin,
      // Do NOT activate in the originating tab — the new tab activates this
      // scenario on its own, keeping this tab's view stable.
      activate: false,
    });

    const targetHash = `#/builder?scenario=${encodeURIComponent(scenarioId)}&line=${encodeURIComponent(draft.lineId)}`;
    const url = `${window.location.pathname}${window.location.search}${targetHash}`;
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
      // Popup blocked — fall back to in-tab navigation so the flow still
      // resolves. The scenario already exists in the library either way.
      navigate(`/builder?scenario=${encodeURIComponent(scenarioId)}&line=${encodeURIComponent(draft.lineId)}`);
    }
  }

  /** Shared side-effect for both flows: pin the order's garment, crew and
   *  production system as the project's working defaults and push the order
   *  onto the recent-orders list. Returns the persisted draft so callers
   *  can address it by id. */
  function persistOrder() {
    project.setSelectedGarment(order.garmentTemplateId);
    project.setDefaultOperators(crewSize);
    project.setSelectedProductionSystem(system);
    const draft = project.addOrder({
      po: order.po,
      client: order.client,
      style: order.style,
      qty: order.qty,
      deadlineDays: order.deadlineDays,
      garmentTemplateId: order.garmentTemplateId,
      operators: crewSize,
      productionSystem: system,
    });
    // P4: also push a twin-level Order so the engine can see this order
    // when running the active twin. Auto-pick the first line whose
    // garment matches; lines added to this twin without a matching
    // garmentId leave the order unassigned (lands in twin.orders[] but
    // not in any orderSequence). Wrap in try/catch so an empty twin
    // (no lines yet) doesn't break the project-store-only flow.
    try {
      const twinState = useTwin.getState();
      const activeTwin = selectActiveTwin(twinState);
      const matchedLine = activeTwin?.lines.find(
        (l) => l.garmentId === order.garmentTemplateId,
      );
      twinState.addOrderToActiveTwin(
        {
          po: order.po,
          client: order.client,
          garmentId: order.garmentTemplateId,
          quantity: order.qty,
          priority: 1,
          dueDate: order.deadlineDays
            ? new Date(Date.now() + order.deadlineDays * 86_400_000).toISOString()
            : undefined,
        },
        matchedLine?.id,
      );
    } catch {
      // Best-effort — the project-store draft is the authoritative copy.
    }
    return draft;
  }

  const template = garments.byId[order.garmentTemplateId];
  const recommended = recommendSystem(order.qty, order.deadlineDays);

  // Pitch time + crew size based on the chosen template's SAM and an
  // 8-hour shift target = qty / deadline_days / 8 = pcs/hour demand.
  // Crew size now branches on the chosen production system so picking
  // modular yields a 6-operator rotation cell instead of a 25-operator
  // PBS line for the same garment.
  const demandPerHour = order.qty / Math.max(1, order.deadlineDays) / 8;
  const crewSize = crewSizeFor({
    productionSystem: system,
    sam: template.totalSmv,
    opCount: template.operations.length,
    demandPerHour,
  });
  const pitchSec = pitchTime({ sam: template.totalSmv, operators: crewSize });
  const cycleDays = Math.ceil((order.qty * template.totalSmv) / (60 * 8 * crewSize));
  const feasibility = systemFeasibilityHint({
    productionSystem: system,
    qty: order.qty,
    days: order.deadlineDays,
    opCount: template.operations.length,
  });
  // ── Active-twin share-debt hint ──────────────────────────────────────
  // If a line on the active twin already runs the selected system, surface
  // the share debt the user has authored there. A line claiming "−2 OPR
  // saved" with "4 stations slowed 2×" is a meaningful caveat on the
  // feasibility math — without it, the user sees the same crew-size
  // recommendation as a fresh, fully-staffed line.
  const activeTwin = useTwin(selectActiveTwin);
  const mappedSystem = mapToLineSystem(system);
  const matchedLine = activeTwin?.lines?.find(
    (l) => l.productionSystem === mappedSystem,
  );
  const shareDebt = matchedLine
    ? shareDebtForLine(activeTwin, matchedLine.id)
    : { stations: 0, savings: 0 };
  // Crew the line actually has after sharing (assignments save labour) — used
  // for a fairer comparison than the abstract crewSize recommendation.
  const recommendedCrewAfterShare = Math.max(
    1,
    Math.round(crewSize - shareDebt.savings),
  );
  // Side-by-side mini-comparison: how would this same order look under
  // each of the five canonical systems? Drives the "Compare" table the
  // user can scan to understand why the recommendation is what it is.
  const COMPARISON_SYSTEMS: ProductionSystem[] = [
    'PBS',
    'modular',
    'synchro',
    'UPS',
    'make_through',
  ];
  const comparison = COMPARISON_SYSTEMS.map((sys) => {
    const crew = crewSizeFor({
      productionSystem: sys,
      sam: template.totalSmv,
      opCount: template.operations.length,
      demandPerHour,
    });
    const days = Math.ceil((order.qty * template.totalSmv) / (60 * 8 * Math.max(1, crew)));
    const pitch = pitchTime({ sam: template.totalSmv, operators: crew });
    return { sys, def: PRODUCTION_SYSTEMS[sys], crew, days, pitch };
  });

  const qtyInvalid = !(order.qty > 0);
  const deadlineInvalid = !(order.deadlineDays > 0);
  const orderInvalid = qtyInvalid || deadlineInvalid;

  return (
    <div style={{ width:'100%', height:'100%', overflow:'auto', padding: 32, background: SW_COLORS.paperDeep }}>
      <div style={{ maxWidth: 1180, margin:'0 auto' }}>
        <SectionHeader kicker="Plan a job" title="New production order"
          sub="Enter order specs. We'll suggest the line, system and crew based on the garment template's SAM."
          right={<Button variant="dark" onClick={()=>navigate('/builder')}>Cancel</Button>}
        />

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:18 }}>
          <Card padding={20}>
            <div style={{ fontFamily: SW_FONTS.display, fontSize:14, fontWeight:900, marginBottom:14 }}>ORDER DETAILS</div>
            {[
              { k:'po', label:'PO Number', placeholder:'e.g. PO-4422' },
              { k:'client', label:'Client', placeholder:'Client name' },
              { k:'style', label:'Style', placeholder:'Style name' },
            ].map(f => (
              <div key={f.k} style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, fontWeight:700, color: SW_COLORS.muted, marginBottom:4 }}>{f.label}</div>
                <input value={order[f.k as keyof OrderState] as string} placeholder={f.placeholder} onChange={e => setOrder({ ...order, [f.k]: e.target.value })}
                  style={{ width:'100%', padding:'10px 12px', borderRadius: SW_RADIUS.sm, border:`1px solid ${SW_COLORS.line}`, fontFamily: SW_FONTS.body, fontSize:13, fontWeight:600, color: SW_COLORS.ink, background: SW_COLORS.paper }}/>
              </div>
            ))}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div>
                <div style={{ fontSize:11, fontWeight:700, color: SW_COLORS.muted, marginBottom:4 }}>Quantity</div>
                <input type="number" value={order.qty} onChange={e=>setOrder({...order, qty: +e.target.value})}
                  aria-invalid={qtyInvalid || undefined}
                  style={{ width:'100%', padding:'10px 12px', borderRadius: SW_RADIUS.sm, border:`1px solid ${qtyInvalid ? SW_COLORS.alarm : SW_COLORS.line}`, fontFamily: SW_FONTS.mono, fontSize:14, fontWeight:700 }}/>
                {qtyInvalid && <div style={{ marginTop:4, fontFamily: SW_FONTS.mono, fontSize:10, fontWeight:700, color: SW_COLORS.alarm }}>Enter a quantity greater than 0.</div>}
              </div>
              <div>
                <div style={{ fontSize:11, fontWeight:700, color: SW_COLORS.muted, marginBottom:4 }}>Deadline (days)</div>
                <input type="number" value={order.deadlineDays} onChange={e=>setOrder({...order, deadlineDays:+e.target.value})}
                  aria-invalid={deadlineInvalid || undefined}
                  style={{ width:'100%', padding:'10px 12px', borderRadius: SW_RADIUS.sm, border:`1px solid ${deadlineInvalid ? SW_COLORS.alarm : SW_COLORS.line}`, fontFamily: SW_FONTS.mono, fontSize:14, fontWeight:700 }}/>
                {deadlineInvalid && <div style={{ marginTop:4, fontFamily: SW_FONTS.mono, fontSize:10, fontWeight:700, color: SW_COLORS.alarm }}>Enter a deadline of at least 1 day.</div>}
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize:11, fontWeight:700, color: SW_COLORS.muted, marginBottom:6 }}>Garment template (preset operations)</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(140px, 1fr))', gap:8 }}>
                {garments.all.map(g => {
                  const active = g.id === order.garmentTemplateId;
                  const custom = !garments.isBuiltIn(g.id);
                  return (
                    <div key={g.id} onClick={() => setOrder({ ...order, garmentTemplateId: g.id })}
                      style={{
                        padding:'10px 8px', textAlign:'center', borderRadius: SW_RADIUS.sm,
                        border:`1.5px solid ${active?SW_COLORS.brand:SW_COLORS.line}`,
                        background: active?SW_COLORS.brandLite:SW_COLORS.paper,
                        fontSize:12, fontWeight:700, cursor:'pointer',
                        position: 'relative',
                      }}>
                      {custom && (
                        <span
                          title="Custom template — saved to this project"
                          style={{
                            position: 'absolute', top: 4, right: 6,
                            fontFamily: SW_FONTS.mono, fontSize: 8, fontWeight: 800,
                            color: SW_COLORS.brand, letterSpacing: 0.8,
                          }}
                        >
                          ✦ NEW
                        </span>
                      )}
                      <div>{g.name}</div>
                      <div style={{ fontSize:10, fontFamily: SW_FONTS.mono, color: SW_COLORS.muted, fontWeight:600, marginTop:3 }}>
                        {g.totalSmv.toFixed(2)} min · {g.operations.length} ops
                      </div>
                    </div>
                  );
                })}
                {/* Add-new tile — dashed border to signal a creation action. */}
                <div
                  onClick={() => setNewTplOpen(true)}
                  role="button"
                  aria-label="Add a new garment template"
                  style={{
                    padding: '10px 8px',
                    textAlign: 'center',
                    borderRadius: SW_RADIUS.sm,
                    border: `1.5px dashed ${SW_COLORS.brand}`,
                    background: `${SW_COLORS.brand}0d`,
                    color: SW_COLORS.brand,
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                  }}
                >
                  <div style={{ fontSize: 18, lineHeight: 1, fontWeight: 900 }}>+</div>
                  <div>New template</div>
                  <div style={{ fontSize: 10, fontFamily: SW_FONTS.mono, fontWeight: 600, opacity: 0.85 }}>
                    custom bulletin
                  </div>
                </div>
              </div>
              {template && (
                <div style={{ marginTop: 10, padding: 10, background: SW_COLORS.paperDeep, borderRadius: SW_RADIUS.sm, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.5 }}>
                  <strong style={{ color: SW_COLORS.ink }}>{template.name}</strong> — {template.description} <em>Best for: {template.bestFor}</em>
                  {' '}
                  <a
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/resources?tab=operations&garment=${encodeURIComponent(template.id)}`);
                    }}
                    href={`/resources?tab=operations&garment=${encodeURIComponent(template.id)}`}
                    style={{
                      color: SW_COLORS.brand,
                      fontWeight: 800,
                      fontFamily: SW_FONTS.mono,
                      fontSize: 10,
                      letterSpacing: 0.5,
                      cursor: 'pointer',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    EDIT OPERATIONS →
                  </a>
                </div>
              )}
            </div>
          </Card>

          <Card padding={20}>
            <div style={{ fontFamily: SW_FONTS.display, fontSize:14, fontWeight:900, marginBottom:14 }}>SYSTEM RECOMMENDATION</div>
            <div style={{ background: SW_COLORS.brandLite, padding:14, borderRadius: SW_RADIUS.sm, marginBottom:14, border: `1px solid ${SW_COLORS.brand}40` }}>
              <div style={{ fontSize:11, color: SW_COLORS.brandDeep, fontWeight:700, fontFamily: SW_FONTS.mono, letterSpacing:'1px', marginBottom:4 }}>RECOMMENDED FOR THIS ORDER</div>
              <div style={{ fontFamily: SW_FONTS.display, fontSize:18, fontWeight:900, color: SW_COLORS.ink }}>
                {PRODUCTION_SYSTEMS[recommended].label}
              </div>
              <div style={{ fontSize:12, color: SW_COLORS.ink, opacity:0.8, marginTop:4 }}>
                {PRODUCTION_SYSTEMS[recommended].bestFor}
              </div>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6 }}>
              {ALL_PRODUCTION_SYSTEMS.map(s => {
                const active = system === s.id;
                const hovered = hoveredSystem === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={()=>setSystem(s.id)}
                    onMouseEnter={() => setHoveredSystem(s.id)}
                    onMouseLeave={() => setHoveredSystem(null)}
                    aria-label={`${s.label} — ${s.description}`}
                    style={{
                      padding:'8px 10px', textAlign:'center',
                      borderRadius: SW_RADIUS.sm,
                      border:`1.5px solid ${active ? SW_COLORS.ink : hovered ? SW_COLORS.brand : SW_COLORS.line}`,
                      background: active?SW_COLORS.ink:SW_COLORS.paper,
                      color: active?SW_COLORS.paper:SW_COLORS.ink,
                      fontSize:11, fontWeight:700, cursor:'pointer',
                      transition: 'border-color 120ms',
                    }}>{s.short}</div>
                );
              })}
            </div>

            {/* System preview — shows the active system by default, the hovered
                system while a tile is hovered. The diagram visually conveys
                the floor topology (bundle vs piece flow, line shape, conveyor
                presence) so the user can compare systems before committing. */}
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: SW_COLORS.paperDeep,
                borderRadius: SW_RADIUS.sm,
                border: `1px solid ${isPreviewing ? SW_COLORS.brand + '60' : SW_COLORS.line}`,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 14,
                alignItems: 'start',
              }}
            >
              <ProductionSystemDiagram system={previewSystem.id} height={120} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                  <strong style={{ color: SW_COLORS.ink, fontFamily: SW_FONTS.display, fontSize: 13, fontWeight: 900 }}>
                    {previewSystem.label}
                  </strong>
                  {isPreviewing && (
                    <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 800, color: SW_COLORS.brand, letterSpacing: 1.5 }}>
                      PREVIEW
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.5, marginBottom: 8 }}>
                  {previewSystem.description}
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted }}>
                  <span>bundle <b style={{ color: SW_COLORS.ink }}>{previewSystem.typicalBatchSize}</b></span>
                  <span>line ~<b style={{ color: SW_COLORS.ink }}>{previewSystem.typicalLineSize}</b> operations</span>
                  <span>WIP ~<b style={{ color: SW_COLORS.ink }}>{previewSystem.typicalWipPieces}</b> pcs</span>
                  <span>changeover <b style={{ color: SW_COLORS.ink }}>{previewSystem.changeoverMin}</b> min</span>
                </div>
              </div>
            </div>

            <div style={{ marginTop:18, display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:8 }}>
              <Stat label="GARMENT SAM" value={template.totalSmv.toFixed(2)} unit="min"/>
              <Stat label="PITCH TIME" value={pitchSec.toFixed(1)} unit="sec" color={SW_COLORS.brand}/>
              <Stat label="EST. CYCLE" value={`${cycleDays}d`} color={SW_COLORS.thread}/>
              <Stat label="CREW NEEDED" value={crewSize} unit="operators" color={SW_COLORS.ok}/>
            </div>
            {feasibility && (
              <div
                role="alert"
                style={{
                  marginTop: 12,
                  padding: '10px 12px',
                  borderRadius: 6,
                  background:
                    feasibility.severity === 'error'
                      ? `${SW_COLORS.alarm}14`
                      : `${SW_COLORS.thread}1f`,
                  border: `1px solid ${feasibility.severity === 'error' ? SW_COLORS.alarm : SW_COLORS.thread}`,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  color: SW_COLORS.ink,
                }}
              >
                <span
                  style={{
                    fontFamily: SW_FONTS.mono,
                    fontSize: 10,
                    fontWeight: 800,
                    color: feasibility.severity === 'error' ? SW_COLORS.alarm : SW_COLORS.thread,
                    letterSpacing: '1px',
                  }}
                >
                  {feasibility.severity === 'error' ? '⨯ MISFIT' : '⚠ HINT'}
                </span>
                <span style={{ flex: 1, lineHeight: 1.4 }}>{feasibility.message}</span>
              </div>
            )}
            {shareDebt.stations > 0 && matchedLine && (
              <div
                role="alert"
                style={{
                  marginTop: 8,
                  padding: '10px 12px',
                  borderRadius: 6,
                  background: `${SW_COLORS.alarm}10`,
                  border: `1px dashed ${SW_COLORS.alarm}`,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  color: SW_COLORS.ink,
                }}
              >
                <span
                  style={{
                    fontFamily: SW_FONTS.mono,
                    fontSize: 10,
                    fontWeight: 800,
                    color: SW_COLORS.alarm,
                    letterSpacing: '1px',
                  }}
                >
                  ⇄ SHARE DEBT
                </span>
                <span style={{ flex: 1, lineHeight: 1.4 }}>
                  Line <strong>{matchedLine.name}</strong> already shares operators on{' '}
                  <strong>{shareDebt.stations}</strong> station{shareDebt.stations === 1 ? '' : 's'} ·{' '}
                  saves <strong>{shareDebt.savings.toFixed(1)}</strong> operator
                  {shareDebt.savings >= 1.05 ? 's' : ''} of labour, but each shared station
                  cycles ≥2× slower. Effective crew on this line ≈{' '}
                  <strong>{recommendedCrewAfterShare}</strong>; deadline math below assumes a
                  fresh, fully-staffed line of {crewSize}.
                </span>
              </div>
            )}

            {/* ── Per-system comparison ────────────────────────────────
                How the same order would size up under each of the five
                canonical systems. Lets the user scan the alternatives
                without changing their selection. */}
            <div
              style={{
                marginTop: 14,
                border: `1px solid ${SW_COLORS.line}`,
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '6px 10px',
                  background: SW_COLORS.paperDeep,
                  fontFamily: SW_FONTS.mono,
                  fontSize: 9,
                  fontWeight: 800,
                  color: SW_COLORS.muted,
                  letterSpacing: '1.5px',
                }}
              >
                COMPARE UNDER OTHER SYSTEMS
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: SW_COLORS.paper, borderBottom: `1px solid ${SW_COLORS.line}` }}>
                    {['System', 'Crew', 'Pitch', 'Cycle'].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: '6px 10px',
                          textAlign: 'left',
                          fontFamily: SW_FONTS.mono,
                          fontSize: 9,
                          fontWeight: 700,
                          color: SW_COLORS.muted,
                          letterSpacing: '1px',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => {
                    const active = row.sys === system;
                    return (
                      <tr
                        key={row.sys}
                        onClick={() => setSystem(row.sys)}
                        style={{
                          borderBottom: `1px solid ${SW_COLORS.line}`,
                          background: active ? SW_COLORS.brandLite : SW_COLORS.paper,
                          cursor: 'pointer',
                        }}
                        title={`Click to pick ${row.def.label}`}
                      >
                        <td style={{ padding: '6px 10px', fontWeight: 700 }}>
                          <span style={{ color: active ? SW_COLORS.brand : SW_COLORS.muted, marginRight: 6 }}>
                            {active ? '◆' : '○'}
                          </span>
                          {row.def.label}
                        </td>
                        <td style={{ padding: '6px 10px', fontFamily: SW_FONTS.mono, fontWeight: 700 }}>
                          {row.crew}
                          <span style={{ color: SW_COLORS.muted, fontWeight: 500, marginLeft: 4 }}>opr</span>
                        </td>
                        <td style={{ padding: '6px 10px', fontFamily: SW_FONTS.mono, fontWeight: 700 }}>
                          {row.pitch.toFixed(1)}
                          <span style={{ color: SW_COLORS.muted, fontWeight: 500, marginLeft: 4 }}>s</span>
                        </td>
                        <td style={{ padding: '6px 10px', fontFamily: SW_FONTS.mono, fontWeight: 700 }}>
                          {row.days}
                          <span style={{ color: SW_COLORS.muted, fontWeight: 500, marginLeft: 4 }}>d</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div style={{ marginTop: 18, display:'flex', justifyContent:'flex-end', gap:10, flexWrap:'wrap' }}>
          <Button variant="secondary" onClick={()=>navigate('/builder')}>Save draft</Button>
          <Button variant="dark" size="lg" icon="✎" onClick={commitToBuilder} disabled={orderInvalid}>
            Build in Builder
          </Button>
          <Button variant="primary" size="lg" onClick={() => commit('/sim')} disabled={orderInvalid}>Run simulation →</Button>
        </div>
      </div>

      {newTplOpen && (
        <NewGarmentTemplateModal
          onCancel={() => setNewTplOpen(false)}
          onCreate={(g) => {
            project.setGarmentEdit(g.id, g);
            setOrder({ ...order, garmentTemplateId: g.id });
            setNewTplOpen(false);
            // Hand off to the operation-breakdown editor for this garment so
            // the user can refine ops row-by-row right after creating.
            navigate(`/resources?tab=operations&garment=${encodeURIComponent(g.id)}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * Heuristic system recommendation — matches the literature's rules of thumb:
 *   - very small batch / sample volume → make-through
 *   - tight deadline + small qty → modular (one-piece flow, low WIP)
 *   - mid-volume mixed → modular or UPS
 *   - high-volume basics → PBS
 *   - massive piece-rate runs → unit-handle
 */
function recommendSystem(qty: number, days: number): ProductionSystem {
  const dailyDemand = qty / Math.max(1, days);
  if (qty <= 50) return 'make_through';
  if (dailyDemand < 100) return 'modular';
  if (dailyDemand < 400) return 'modular';
  if (dailyDemand < 1500) return 'PBS';
  if (dailyDemand < 3000) return 'UPS';
  return 'unit_handle';
}

// ── New-garment-template modal ─────────────────────────────────────────────
// Lets the user define a new GarmentTemplate without leaving the Orders page.
// Operations are entered as one-per-line `Name | SMV | MachineCode` so a 25-op
// bulletin can be pasted from a spreadsheet in seconds. Skill + category are
// auto-derived from the machine code; codes auto-number as OP-01, OP-02, ...

const GARMENT_CLASS_OPTIONS: GarmentClass[] = ['top', 'bottom', 'dress', 'outerwear', 'accessory'];

const MACHINE_OPTIONS: MachineCode[] = [
  'SNL', 'DNL', '4OL', '5OL', 'FL', 'FB', 'KS',
  'BH', 'BS', 'BT', 'EMB',
  'CUT', 'CAD', 'SPR', 'FUSE', 'PRESS', 'STEAM', 'INSP', 'MNL',
];

const MACHINE_TO_SKILL: Record<MachineCode, SkillId> = {
  SNL: 'stitching', DNL: 'stitching',
  '4OL': 'overlock', '5OL': 'overlock',
  FL: 'flatlock', FB: 'feed_of_arm', KS: 'kansai',
  BH: 'buttonhole', BS: 'button_sew', BT: 'bartack', EMB: 'embroidery',
  CUT: 'cutting_manual', CAD: 'cutting_cad', SPR: 'spreading',
  FUSE: 'fusing', PRESS: 'pressing', STEAM: 'pressing', INSP: 'inspection',
  MNL: 'bundling',
};

const MACHINE_TO_CATEGORY: Record<MachineCode, OperationCategory> = {
  SNL: 'sewing', DNL: 'sewing', '4OL': 'sewing', '5OL': 'sewing',
  FL: 'sewing', FB: 'sewing', KS: 'sewing',
  BH: 'sewing', BS: 'sewing', BT: 'sewing',
  EMB: 'embroidery',
  CUT: 'cutting', CAD: 'cutting', SPR: 'spreading',
  FUSE: 'fusing', PRESS: 'pressing', STEAM: 'pressing',
  INSP: 'inspection', MNL: 'manual',
};

/** Parse the operations textarea. Accepts `Name | SMV | Machine` per line.
 *  Trailing whitespace and blank lines are skipped. Missing SMV falls back to
 *  0.30; missing / unknown machine falls back to SNL (the apparel workhorse). */
function parseOpsText(text: string, slug: string): Operation[] {
  const machineSet = new Set<MachineCode>(MACHINE_OPTIONS);
  return text
    .split('\n')
    .map((line) => line.trim())
    // Skip blank lines and `#`-prefixed comments so the placeholder hint
    // doesn't accidentally become 3 ghost operations.
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line, i) => {
      const parts = line.split('|').map((p) => p.trim());
      const name = parts[0] || `Operation ${i + 1}`;
      const smvRaw = parts[1] !== undefined ? parseFloat(parts[1]) : NaN;
      const smv = Number.isFinite(smvRaw) && smvRaw > 0 ? smvRaw : 0.3;
      const machRaw = (parts[2] || 'SNL').toUpperCase();
      const machineCode: MachineCode = machineSet.has(machRaw as MachineCode)
        ? (machRaw as MachineCode)
        : 'SNL';
      const code = `OP-${String(i + 1).padStart(2, '0')}`;
      return {
        id: `${slug}-${String(i + 1).padStart(2, '0')}`,
        code,
        name,
        smv: Math.round(smv * 1000) / 1000,
        machineCode,
        skill: MACHINE_TO_SKILL[machineCode],
        category: MACHINE_TO_CATEGORY[machineCode],
      };
    });
}

/** Slugify a free-form name into a stable id suffix. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'garment';
}

const OPS_PLACEHOLDER = [
  '# One operation per line: Name | SMV (min) | Machine',
  '# e.g. Care label attach | 0.12 | SNL',
  '#      Shoulder joint    | 0.30 | 4OL',
  'Care label attach | 0.12 | SNL',
  'Front & back match | 0.15 | MNL',
  'Shoulder joint | 0.30 | 4OL',
  'Neck rib join | 0.32 | 4OL',
  'Side seam | 0.70 | 4OL',
  'Body hem | 0.33 | FL',
].join('\n');

interface NewGarmentTemplateModalProps {
  onCancel: () => void;
  onCreate: (g: GarmentTemplate) => void;
}

function NewGarmentTemplateModal({ onCancel, onCreate }: NewGarmentTemplateModalProps) {
  const [name, setName] = useState('');
  const [klass, setKlass] = useState<GarmentClass>('top');
  const [description, setDescription] = useState('');
  const [bestFor, setBestFor] = useState('');
  const [bundleSize, setBundleSize] = useState(30);
  const [opsText, setOpsText] = useState(OPS_PLACEHOLDER);

  const trimmedName = name.trim();
  const slug = slugify(trimmedName);
  const parsedOps = parseOpsText(opsText, slug);
  const totalSmv = parsedOps.reduce((s, o) => s + o.smv, 0);
  const canSave = trimmedName.length > 0 && parsedOps.length > 0;

  function handleSave() {
    if (!canSave) return;
    const id = `custom-${slug}-${Date.now().toString(36).slice(-5)}`;
    const garment: GarmentTemplate = {
      id,
      name: trimmedName,
      class: klass,
      description: description.trim() || `${trimmedName} — custom bulletin.`,
      operations: parsedOps,
      defaultBundleSize: Math.max(1, Math.min(200, Math.round(bundleSize) || 30)),
      totalSmv,
      hourlyTarget100:
        parsedOps.length > 0 ? Math.round(60 / (totalSmv / parsedOps.length)) : 0,
      bestFor: bestFor.trim() || 'Custom orders.',
    };
    onCreate(garment);
  }

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${SW_COLORS.line}`,
    borderRadius: SW_RADIUS.sm,
    background: SW_COLORS.paper,
    fontFamily: SW_FONTS.body,
    fontSize: 13,
    color: SW_COLORS.ink,
  };
  const labelStyle: CSSProperties = {
    fontFamily: SW_FONTS.mono,
    fontSize: 10,
    fontWeight: 800,
    color: SW_COLORS.muted,
    letterSpacing: '1px',
    marginBottom: 4,
  };

  return (
    <div
      role="dialog"
      aria-label="Create new garment template"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 20, 25, 0.45)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)',
          maxHeight: '92vh',
          background: SW_COLORS.paper,
          borderRadius: 8,
          border: `1px solid ${SW_COLORS.line}`,
          boxShadow: '0 18px 50px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
          }}
        >
          <div style={{ fontFamily: SW_FONTS.display, fontSize: 14, fontWeight: 900, letterSpacing: '0.1em' }}>
            ✦ NEW GARMENT TEMPLATE
          </div>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
            Custom bulletin · saved to this project
          </div>
        </div>

        <div style={{ padding: '16px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, overflowY: 'auto' }}>
          <label style={{ gridColumn: '1 / 2' }}>
            <div style={labelStyle}>NAME</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Henley L/S" style={inputStyle} />
          </label>
          <label style={{ gridColumn: '2 / 3' }}>
            <div style={labelStyle}>CLASS</div>
            <HudSelect
              value={klass}
              onChange={(v) => setKlass(v as GarmentClass)}
              variant="light"
              width="100%"
              options={GARMENT_CLASS_OPTIONS.map((c) => ({ value: c, label: c }))}
            />
          </label>

          <label style={{ gridColumn: '1 / 3' }}>
            <div style={labelStyle}>DESCRIPTION</div>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description — what's this garment?" style={inputStyle} />
          </label>

          <label style={{ gridColumn: '1 / 2' }}>
            <div style={labelStyle}>BEST FOR</div>
            <input value={bestFor} onChange={(e) => setBestFor(e.target.value)} placeholder="When to pick this template" style={inputStyle} />
          </label>
          <label style={{ gridColumn: '2 / 3' }}>
            <div style={labelStyle}>DEFAULT BUNDLE</div>
            <input
              type="number" min={1} max={200} value={bundleSize}
              onChange={(e) => setBundleSize(parseInt(e.target.value) || 0)}
              style={{ ...inputStyle, fontFamily: SW_FONTS.mono, fontWeight: 700 }}
            />
          </label>

          <label style={{ gridColumn: '1 / 3' }}>
            <div style={labelStyle}>
              OPERATIONS · one per line · <span style={{ fontWeight: 600, opacity: 0.7 }}>Name | SMV | Machine</span>
            </div>
            <textarea
              value={opsText}
              onChange={(e) => setOpsText(e.target.value)}
              rows={10}
              spellCheck={false}
              style={{ ...inputStyle, fontFamily: SW_FONTS.mono, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
            />
            <div style={{ marginTop: 6, fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
              Machine codes: {MACHINE_OPTIONS.join(' · ')}
            </div>
          </label>

          <div
            style={{
              gridColumn: '1 / 3',
              padding: 10,
              background: SW_COLORS.paperDeep,
              borderRadius: SW_RADIUS.sm,
              display: 'flex',
              gap: 16,
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              color: SW_COLORS.muted,
              flexWrap: 'wrap',
            }}
          >
            <span>parsed <b style={{ color: SW_COLORS.ink }}>{parsedOps.length}</b> operations</span>
            <span>total SAM <b style={{ color: SW_COLORS.ink }}>{totalSmv.toFixed(2)}</b> min</span>
            <span>≈ <b style={{ color: SW_COLORS.ink }}>{parsedOps.length > 0 ? Math.round(60 / (totalSmv / parsedOps.length)) : 0}</b> pcs/hr @ 100%</span>
            {!canSave && (
              <span style={{ color: SW_COLORS.brand, fontWeight: 800 }}>
                {trimmedName.length === 0 ? 'Name required · ' : ''}
                {parsedOps.length === 0 ? 'At least 1 op required' : ''}
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" icon="✦" onClick={handleSave} disabled={!canSave}>
            Create template
          </Button>
        </div>
      </div>
    </div>
  );
}
