import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Tag, Logo, TimeChip, useConfirm, useToast } from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { useTwin, selectActiveTwin } from '../store/twin';
import {
  useProject,
  useFactoryLibrary,
  archiveAndStartFresh,
  isFactoryNameTaken,
  FACTORY_LIBRARY_MAX,
} from '../store';
import { buildReferenceFactoryTwin } from '../domain/reference-twin';
import { fmtCalendar } from '../simulation/timeUnit';
import {
  fetchModelamaBundle,
  buildModelamaTwin,
  buildModelamaScenarioVariants,
} from '../lib/modelama-bundle';

/**
 * Splash / main menu — entry point of the app. Two-column layout:
 *   LEFT: brand mark, hero copy, primary CTAs, save slots, footer links
 *   RIGHT: live mini-factory illustration, today's events, recent badges
 *
 * Ported from SWMainMenu in STITCHWORKS.html (lines 1032–1199) plus the
 * MiniIsoFactory illustration (lines 1202–1251) which lives inline below.
 */
export function MenuPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const projectTime = useProject((s) => s.time);
  const dateFormat = useProject((s) => s.units.dateFormat);
  const factoryName = useProject((s) => s.meta.name);
  const activeScenarioCount = useProject((s) => s.scenarios.length);
  const activeStationCount = useTwin((s) => selectActiveTwin(s).workstations.length);
  const savedFactories = useFactoryLibrary((s) => s.savedFactories);
  const loadFactory = useFactoryLibrary((s) => s.loadFactory);
  const deleteFactory = useFactoryLibrary((s) => s.deleteFactory);
  // No sim run has happened yet on the menu, so "today" anchors to t=0
  // (i.e. the project's start date). MODEL-time vs CAL is irrelevant here.
  const todayCal = fmtCalendar(0, projectTime.modelTimeUnit, projectTime.startDate, dateFormat);

  // New-factory dialog state. Native `window.prompt` is suppressed in
  // embedded preview / iframe contexts (and looks unstyled even when it
  // does fire), so we drive the flow through an in-app modal.
  const [newFactoryOpen, setNewFactoryOpen] = useState(false);
  const [newFactoryName, setNewFactoryName] = useState('New Factory');

  const slotsUsed = savedFactories.length + 1; // active counts toward the cap
  const atCap = slotsUsed >= FACTORY_LIBRARY_MAX;

  const openNewFactoryDialog = () => {
    // Pick a starting name that doesn't already collide.
    let seed = 'New Factory';
    if (isFactoryNameTaken(seed)) {
      for (let i = 2; i < 1000; i++) {
        const candidate = `New Factory (${i})`;
        if (!isFactoryNameTaken(candidate)) { seed = candidate; break; }
      }
    }
    setNewFactoryName(seed);
    setNewFactoryOpen(true);
  };
  const confirmNewFactory = () => {
    const name = newFactoryName.trim();
    if (!name) return;
    if (atCap) return; // belt + braces; button is disabled in this state
    if (isFactoryNameTaken(name)) return; // belt + braces; button is disabled
    archiveAndStartFresh(name);
    setNewFactoryOpen(false);
    navigate('/builder');
  };
  const handleLoadSaved = (id: string) => {
    if (loadFactory(id)) navigate('/builder');
  };
  const handleOpenScenariosForActive = () => {
    navigate('/scenarios');
  };
  const handleOpenScenariosForSaved = (id: string) => {
    if (loadFactory(id)) navigate('/scenarios');
  };
  const handleDeleteSaved = async (id: string, label: string) => {
    // Slot deletion is destructive and the user has nowhere else to undo
    // from, so confirm first via the styled dialog.
    const ok = await confirm({
      title: 'Delete saved factory',
      message: `Delete saved factory "${label}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (ok) deleteFactory(id);
  };

  // Multi-line reference factory preset — used to live as a "📚 LOAD REF
  // FACTORY" button on the Builder toolbar. Promoted here so the home
  // page is the single landing place for picking which factory to open.
  // Behaviour: archive whatever the user has open, reset, then swap the
  // fresh canonical with the multi-line reference twin (Hossain ·
  // Elnaggar · Morshed · Kursun · Koç stacked on one floor). Lands the
  // user in Builder so they can browse the seeded lines immediately.
  // One-click Modelama factory: fetches the four bundled .xlsx files,
  // parses them into garments + layouts, assembles a 4-line twin and
  // lands the user in Builder. The IndExc files live under public/modelama
  // so they ship with the build.
  const setGarmentEdit = useProject((s) => s.setGarmentEdit);
  const saveScenario = useProject((s) => s.saveScenario);
  const [modelamaLoading, setModelamaLoading] = useState(false);
  const handleLoadModelamaFactory = async () => {
    if (atCap || modelamaLoading) return;
    // Idempotent reload: if the active factory is already a Modelama bundle,
    // refresh it in place instead of archiving a "(2)", "(3)", … copy each
    // click. Match the canonical prefix (the suffix may be a (N) collision
    // disambiguator added by uniquifyFactoryName on a prior load).
    const currentName = useProject.getState().meta.name ?? '';
    const isAlreadyModelama = /^Modelama · Garment Factory/i.test(currentName.trim());
    const proceed = await confirm({
      title: isAlreadyModelama ? 'Re-seed Modelama factory' : 'Load Modelama factory',
      message: isAlreadyModelama
        ? 'Re-seed the Modelama factory? The active canonical + scenarios will be replaced with a fresh bundle, but the library is left alone (no archive copy).'
        : 'Load the Modelama factory? Your current factory will be archived to the SAVED FACTORIES library first. The Modelama bundle ships 4 styles (1-pkt Shirt, Shorts, Blouse, Dress) on one floor.',
      confirmLabel: isAlreadyModelama ? 'Re-seed' : 'Load',
    });
    if (!proceed) return;
    setModelamaLoading(true);
    try {
      const parsed = await fetchModelamaBundle(import.meta.env.BASE_URL ?? '');
      if (parsed.length === 0) {
        toast({ kind: 'error', message: 'Could not load Modelama bundle — the bundled xlsx files were not reachable.' });
        return;
      }
      if (isAlreadyModelama) {
        // In-place reseed — drop project + twin state without snapshotting
        // the (stale) active factory into the library. resetProject also
        // wipes project.scenarios so the upcoming saveScenario loop seeds
        // fresh entries instead of stacking duplicates.
        useProject.getState().resetProject();
        useTwin.getState().resetTwin();
        useProject.getState().rename('Modelama · Garment Factory');
      } else {
        archiveAndStartFresh('Modelama · Garment Factory');
      }
      const { twin, garments } = buildModelamaTwin(parsed, 'Modelama · Garment Factory');
      // Register imported garments so workstations can resolve their opIds
      // through `useGarments()` downstream.
      for (const g of garments) setGarmentEdit(g.id, g);
      const r = useTwin.getState().loadCanonical(twin);
      if (!r.ok) {
        toast({ kind: 'error', message: `Could not load Modelama factory: ${r.reason}` });
        return;
      }
      // Seed line-swap scenarios so the Scenarios tab has something to
      // compare from the moment the bundle finishes loading. Each variant
      // ships with analytical KPIs (planned-efficiency throughput from the
      // OB SMVs) so the comparison view shows real numbers immediately;
      // the user can still click Load → Sim to overwrite with simulated
      // values.
      const variants = buildModelamaScenarioVariants(parsed);
      const twinStore = useTwin.getState();
      for (const v of variants) {
        saveScenario({
          name: v.name,
          notes: v.notes,
          twin: v.twin,
          garmentTemplateId: v.garmentTemplateId,
          operators: v.operators,
          kpis: {
            producedPieces: v.kpis.producedPieces,
            throughputPerHr: v.kpis.throughputPerHr,
            efficiencyPct: v.kpis.efficiencyPct,
            meanLeadTime: v.kpis.meanLeadTime,
            utilization: v.kpis.utilization,
            wipBundles: v.kpis.wipBundles,
            bottleneckOpName: v.kpis.bottleneckOpName,
            bottleneckQueue: v.kpis.bottleneckQueue,
          },
        });
        // Also register the variant in the twin store so the Builder's
        // scenario picker shows it from the start — without this the
        // dropdown only sees the canonical until the user clicks Load.
        twinStore.createScenarioFromTwin({
          name: v.name,
          notes: v.notes,
          twin: v.twin,
          activate: false,
        });
      }
      navigate('/builder');
    } catch (err) {
      console.error('Modelama load failed', err);
      toast({ kind: 'error', message: `Modelama load failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setModelamaLoading(false);
    }
  };

  const handleLoadReferenceFactory = async () => {
    if (atCap) return;
    const proceed = await confirm({
      title: 'Load reference factory',
      message: 'Load the multi-line reference factory? Your current factory will be archived to the SAVED FACTORIES library first.',
      confirmLabel: 'Load',
    });
    if (!proceed) return;
    archiveAndStartFresh('Reference Factory · All Lines');
    const refTwin = buildReferenceFactoryTwin({ name: 'Reference Factory · All Lines' });
    const r = useTwin.getState().loadCanonical(refTwin);
    if (!r.ok) {
      toast({ kind: 'error', message: `Could not load reference factory: ${r.reason}` });
      return;
    }
    navigate('/builder');
  };

  return (
    <div style={{
      width: '100%', height: '100%',
      background: `
        radial-gradient(circle at 20% 20%, ${SW_COLORS.brandLite}40 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, #4F7CFF18 0%, transparent 50%),
        ${SW_COLORS.paper}
      `,
      display: 'grid', gridTemplateColumns: '1.2fr 1fr',
      overflow: 'auto',
    }}>
      {/* LEFT: hero + quick actions */}
      <div style={{ padding: '64px 56px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <Logo size={32}/>

        <div>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 700, color: SW_COLORS.brand, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 12 }}>
            APPAREL FACTORY DIGITAL TWIN · v0.4
          </div>
          <h1 style={{
            fontFamily: SW_FONTS.display, fontSize: 56, fontWeight: 900,
            margin: 0, lineHeight: 0.95, letterSpacing: '-0.02em', color: SW_COLORS.ink,
            maxWidth: 580,
          }}>
            Build it.<br/>Run it.<br/><span style={{ color: SW_COLORS.brand }}>Optimize it.</span>
          </h1>
          <p style={{ fontSize: 16, color: SW_COLORS.muted, marginTop: 16, maxWidth: 480, lineHeight: 1.5 }}>
            A complete, flexible digital twin for your apparel production floor that scales as your enterprise scales.
          </p>
        </div>

        {/* Continue / New */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            size="lg"
            onClick={openNewFactoryDialog}
            icon="+"
            disabled={atCap}
          >
            CREATE NEW DIGITAL FACTORY
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={handleLoadModelamaFactory}
            icon={modelamaLoading ? '…' : '🧵'}
            disabled={atCap || modelamaLoading}
          >
            {modelamaLoading ? 'LOADING…' : 'LOAD MODELAMA FACTORY'}
          </Button>
          <Button variant="secondary" size="lg" onClick={() => navigate('/reference')} icon="📖">
            REFERENCE MODELS
          </Button>
          <Button variant="secondary" size="lg" onClick={() => navigate('/pilot')} icon="⚗">
            PILOT STUDY
          </Button>
        </div>

        {/* Save slots */}
        <div style={{ marginTop: 8 }}>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 700, color: SW_COLORS.muted, letterSpacing: '1.5px', marginBottom: 8 }}>
            SAVED FACTORIES · {slotsUsed} / {FACTORY_LIBRARY_MAX}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <FactorySlot
              label={factoryName || 'Untitled Factory'}
              caption={`${activeStationCount} STATIONS`}
              badge="ACTIVE"
              badgeColor={SW_COLORS.ok}
              scenarioCount={activeScenarioCount}
              onClick={() => navigate('/builder')}
              onOpenScenarios={handleOpenScenariosForActive}
            />
            {/* Multi-line reference factory preset. Same look as a saved
                factory tile so it reads as "another factory you can open"
                — distinguished by the dashed border + PRESET badge. */}
            <ReferenceFactoryPresetSlot
              onClick={handleLoadReferenceFactory}
              disabled={atCap}
            />
            {savedFactories.map((slot) => (
              <FactorySlot
                key={slot.id}
                label={slot.name}
                caption={`${slot.stationCount} STATIONS · ${fmtSavedAt(slot.savedAt)}`}
                scenarioCount={slot.project.scenarios?.length ?? 0}
                onClick={() => handleLoadSaved(slot.id)}
                onOpenScenarios={() => handleOpenScenariosForSaved(slot.id)}
                onDelete={() => handleDeleteSaved(slot.id, slot.name)}
              />
            ))}
          </div>
        </div>

      </div>

      {/* RIGHT: live status + achievements + isometric thumbnail */}
      <div style={{ padding: '64px 56px 64px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Mini factory illustration */}
        <Card padding={0} style={{ overflow: 'hidden' }}>
          <div style={{
            height: 240, position: 'relative',
            background: `linear-gradient(135deg, ${SW_COLORS.steel}, ${SW_COLORS.steelLite})`,
            overflow: 'hidden',
          }}>
            <MiniIsoFactory/>
            <div style={{
              position: 'absolute', left: 16, bottom: 12,
              color: '#fff', fontFamily: SW_FONTS.body,
            }}>
              <div style={{ fontSize: 10, fontFamily: SW_FONTS.mono, color: '#ffffffaa', letterSpacing: '1px', fontWeight: 700 }}>LIVE NOW</div>
              <div style={{ fontFamily: SW_FONTS.display, fontSize: 18, fontWeight: 900 }}>Floor 1 · Sewing</div>
              <div style={{ fontSize: 11, color: '#ffffffcc' }}>14 operators · 2 machines down · 184 pcs/hr</div>
            </div>
            <div style={{
              position: 'absolute', right: 14, top: 12,
              display: 'flex', gap: 6,
            }}>
              <Tag color={SW_COLORS.alarm}>● 2 ALERTS</Tag>
            </div>
          </div>
        </Card>

        {/*
          Today's tasks / events — model time is anchored to t = 0 here
          (the project's start date), so the "TODAY" label honestly shows
          the calendar date the simulation will start on. Mock events were
          removed: an empty state is more honest than fictitious schedule
          rows that never updated. A real planner module will fill this.
        */}
        <Card padding={16}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontFamily: SW_FONTS.display, fontSize: 13, fontWeight: 900, color: SW_COLORS.ink }}>TODAY</div>
              <TimeChip kind="CAL" />
              <span style={{ fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 600, color: SW_COLORS.muted }}>{todayCal}</span>
            </div>
            <Tag soft color={SW_COLORS.muted}>0 EVENTS</Tag>
          </div>
          <div style={{ padding: '20px 0', textAlign: 'center', color: SW_COLORS.muted, fontSize: 12, lineHeight: 1.5 }}>
            No scheduled events. Operator absences and machine service jobs<br/>
            will appear here once the planner module ships.
          </div>
        </Card>

      </div>

      <span style={{
        position: 'fixed',
        bottom: 16,
        right: 20,
        fontSize: 11,
        color: SW_COLORS.muted,
        fontFamily: SW_FONTS.mono,
        pointerEvents: 'none',
      }}>
        BUILD 0.4.2 · OFFLINE
      </span>

      {newFactoryOpen && (
        <NewFactoryModal
          name={newFactoryName}
          archiving={factoryName}
          onNameChange={setNewFactoryName}
          onCancel={() => setNewFactoryOpen(false)}
          onConfirm={confirmNewFactory}
        />
      )}
    </div>
  );
}

interface FactorySlotProps {
  label: string;
  caption: string;
  badge?: string;
  badgeColor?: string;
  scenarioCount?: number;
  onClick: () => void;
  onOpenScenarios?: () => void;
  onDelete?: () => void;
}

function FactorySlot({ label, caption, badge, badgeColor, scenarioCount, onClick, onOpenScenarios, onDelete }: FactorySlotProps) {
  const count = scenarioCount ?? 0;
  return (
    <Card
      hover
      padding={14}
      style={{ flex: '1 1 180px', minWidth: 160, position: 'relative', display: 'flex', flexDirection: 'column' }}
      onClick={onClick}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6, minHeight: 16 }}>
        {badge ? (
          <Tag soft color={badgeColor ?? SW_COLORS.brand}>{badge}</Tag>
        ) : <span />}
        {onDelete && (
          <button
            type="button"
            aria-label={`Delete saved factory ${label}`}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{
              background: 'transparent',
              border: 'none',
              color: SW_COLORS.muted,
              fontFamily: SW_FONTS.mono,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>
      <div style={{ fontFamily: SW_FONTS.display, fontSize: 14, fontWeight: 800, color: SW_COLORS.ink, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </div>
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {caption}
      </div>
      {onOpenScenarios && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenScenarios(); }}
          title={count > 0 ? `Open ${count} saved scenario${count === 1 ? '' : 's'}` : 'Create a new scenario for this factory'}
          style={{
            marginTop: 10,
            padding: '6px 8px',
            background: count > 0 ? SW_COLORS.brandLite : 'transparent',
            border: `1px solid ${count > 0 ? `${SW_COLORS.brand}40` : SW_COLORS.line}`,
            borderRadius: 4,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.5px',
            color: count > 0 ? SW_COLORS.brand : SW_COLORS.muted,
          }}
        >
          <span>✦ {count > 0 ? `${count} SCENARIO${count === 1 ? '' : 'S'}` : 'NEW SCENARIO'}</span>
          <span>→</span>
        </button>
      )}
    </Card>
  );
}

/**
 * Reference-factory preset tile. Same footprint as `FactorySlot` so it
 * sits cleanly in the SAVED FACTORIES row, but with a dashed border +
 * brand-coloured PRESET badge so the user understands it's a starter
 * pack, not their own saved factory. Click → archive the current
 * factory + load the multi-line reference twin as the new active one.
 */
function ReferenceFactoryPresetSlot({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? 'Factory library is at capacity — delete a saved factory first.'
          : 'Load the multi-line reference factory (Hossain · Elnaggar · Morshed · Kursun · Koç stacked on one floor). Your current factory will be archived to SAVED FACTORIES first.'
      }
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        flex: '1 1 180px',
        minWidth: 160,
        padding: 14,
        background: SW_COLORS.paper,
        border: `1.5px dashed ${SW_COLORS.brand}80`,
        borderRadius: SW_RADIUS.md,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'flex',
        flexDirection: 'column',
        transition: 'background 120ms, border-color 120ms',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = `${SW_COLORS.brand}08`;
        e.currentTarget.style.borderColor = SW_COLORS.brand;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = SW_COLORS.paper;
        e.currentTarget.style.borderColor = `${SW_COLORS.brand}80`;
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6, minHeight: 16 }}>
        <Tag soft color={SW_COLORS.brand}>PRESET</Tag>
        <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>📚</span>
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 14,
          fontWeight: 800,
          color: SW_COLORS.ink,
          marginBottom: 4,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        Reference Factory
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          color: SW_COLORS.muted,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        5 LITERATURE LINES
      </div>
      <div
        style={{
          marginTop: 10,
          padding: '6px 8px',
          background: 'transparent',
          border: `1px solid ${SW_COLORS.brand}40`,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.5px',
          color: SW_COLORS.brand,
        }}
      >
        <span>✦ LOAD INTO ACTIVE</span>
        <span>→</span>
      </div>
    </button>
  );
}

function fmtSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'SAVED';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `SAVED ${hh}:${mm}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `SAVED ${mo}/${dy}`;
}

interface NewFactoryModalProps {
  name: string;
  archiving: string | null | undefined;
  onNameChange: (s: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function NewFactoryModal({
  name,
  archiving,
  onNameChange,
  onCancel,
  onConfirm,
}: NewFactoryModalProps) {
  const trimmed = name.trim();
  // Re-evaluate on every keystroke. isFactoryNameTaken reads zustand state
  // directly so the check stays accurate as the user types or as the
  // saved-factories list changes.
  const duplicate = trimmed.length > 0 && isFactoryNameTaken(trimmed);
  const canCreate = trimmed.length > 0 && !duplicate;
  return (
    <div
      role="dialog"
      aria-label="Create new factory"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 20, 25, 0.45)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 92%)',
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
            fontFamily: SW_FONTS.display,
            fontSize: 14,
            fontWeight: 900,
            letterSpacing: '0.1em',
          }}
        >
          + CREATE NEW FACTORY
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: SW_FONTS.mono, fontSize: 10, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '1px' }}>
              FACTORY NAME
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate) onConfirm();
                if (e.key === 'Escape') onCancel();
              }}
              aria-invalid={duplicate || undefined}
              style={{
                padding: '8px 10px',
                border: `1px solid ${duplicate ? SW_COLORS.alarm : SW_COLORS.line}`,
                borderRadius: SW_RADIUS.sm,
                background: '#fff',
                fontFamily: SW_FONTS.body,
                fontSize: 13,
                color: SW_COLORS.ink,
                outline: 'none',
              }}
            />
            {duplicate && (
              <span style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 11,
                fontWeight: 700,
                color: SW_COLORS.alarm,
                marginTop: 2,
              }}>
                A factory named "{trimmed}" already exists. Pick a different name.
              </span>
            )}
          </label>

          {archiving && (
            <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.4 }}>
              Your current factory <b style={{ color: SW_COLORS.ink }}>{archiving}</b> will be saved to the slots panel before the new one starts.
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            background: SW_COLORS.paperEdge,
          }}
        >
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} disabled={!canCreate} icon="+">
            CREATE
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Mini Isometric Factory illustration ----------------
function MiniIsoFactory() {
  // Pull the live workstation count from the active twin so the splash
  // caption agrees with what /floor will actually show. The 4×5=20 tiles
  // below are decorative — the count below is what users compare against.
  const stationCount = useTwin((s) => selectActiveTwin(s).workstations.length);
  return (
    <svg viewBox="0 0 600 240" style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs>
        <linearGradient id="iso-floor" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff10"/>
          <stop offset="1" stopColor="#ffffff02"/>
        </linearGradient>
      </defs>

      {/* floor diamond */}
      <polygon points="300,40 540,140 300,220 60,140" fill="url(#iso-floor)" stroke="#ffffff20" strokeWidth="1"/>

      {/* sewing rows */}
      {[0, 1, 2, 3].flatMap((row) => {
        const y = 100 + row * 22;
        return [0, 1, 2, 3, 4].map((col) => {
          const x = 180 + col * 40 + row * 8;
          const isAct = (row + col) % 3 !== 0;
          return (
            <g key={`${row}-${col}`} transform={`translate(${x}, ${y})`}>
              <polygon points="0,0 18,9 18,22 0,13" fill={isAct ? SW_COLORS.brand : '#ffffff30'} stroke="#000" strokeOpacity="0.2"/>
              <polygon points="18,9 26,5 26,18 18,22" fill={isAct ? SW_COLORS.brandDeep : '#ffffff20'} stroke="#000" strokeOpacity="0.2"/>
              <polygon points="0,0 18,9 26,5 8,-4" fill={isAct ? '#FFD2B5' : '#ffffff20'} stroke="#000" strokeOpacity="0.2"/>
              {isAct && <circle cx="9" cy="-2" r="2.5" fill="#FFE4D6"/>}
            </g>
          );
        });
      })}

      {/* moving bundle dots */}
      <g>
        <circle cx="200" cy="105" r="3" fill={SW_COLORS.thread}>
          <animate attributeName="cx" from="120" to="440" dur="6s" repeatCount="indefinite"/>
          <animate attributeName="cy" from="120" to="180" dur="6s" repeatCount="indefinite"/>
        </circle>
        <circle cx="220" cy="120" r="3" fill={SW_COLORS.fabric}>
          <animate attributeName="cx" from="120" to="440" dur="8s" begin="2s" repeatCount="indefinite"/>
          <animate attributeName="cy" from="120" to="180" dur="8s" begin="2s" repeatCount="indefinite"/>
        </circle>
      </g>

      <text x="300" y="232" textAnchor="middle" fill="#ffffff60" fontFamily={SW_FONTS.mono} fontSize="9">FLOOR 01 · SEWING · {stationCount} STATIONS</text>
    </svg>
  );
}
