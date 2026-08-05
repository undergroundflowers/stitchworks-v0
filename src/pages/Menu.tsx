import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Tag, Logo, TimeChip, useConfirm } from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { useTwin, selectActiveTwin } from '../store/twin';
import {
  useProject,
  useFactoryLibrary,
  archiveAndStartFresh,
  isFactoryNameTaken,
  FACTORY_LIBRARY_MAX,
} from '../store';
import { fmtCalendar } from '../simulation/timeUnit';
import { getFlag, setFlag } from '../lib/safeStorage';

/**
 * Splash / main menu — entry point of the app. Two-column layout:
 *   LEFT:  brand mark, hero copy, the "new" CTA, and the FACTORY LIBRARY list
 *   RIGHT: today's calendar/status panel
 *
 * Ported from SWMainMenu in STITCHWORKS.html (lines 1032–1199). The original
 * mock isometric "live factory" illustration was removed — the splash has no
 * live floor, so invented telemetry was replaced with an honest panel.
 */
export function MenuPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const projectTime = useProject((s) => s.time);
  const dateFormat = useProject((s) => s.units.dateFormat);
  const factoryName = useProject((s) => s.meta.name);
  const activeScenarioCount = useProject((s) => s.scenarios.length);
  const activeStationCount = useTwin((s) => selectActiveTwin(s).workstations.length);
  const savedFactories = useFactoryLibrary((s) => s.savedFactories);
  const loadFactory = useFactoryLibrary((s) => s.loadFactory);
  const deleteFactory = useFactoryLibrary((s) => s.deleteFactory);
  const togglePin = useFactoryLibrary((s) => s.togglePin);
  // Pinned factories float to the top of the flat list (favorites stay closest
  // to hand). The underlying store array keeps its recency order — eviction
  // depends on it — so we sort a copy here for display only. Array.sort is
  // stable, so same-pinned entries keep their newest-first order.
  const sortedSaved = useMemo(
    () => [...savedFactories].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)),
    [savedFactories],
  );

  // Factory Library is a collapsible disclosure — its header toggles the card
  // grid open/closed. Defaults open (so the active factory is visible on first
  // load); the choice is remembered across sessions ('0' = collapsed).
  const [libraryOpen, setLibraryOpen] = useState<boolean>(() => getFlag('sw_lib_open') !== '0');
  const toggleLibrary = () => {
    setLibraryOpen((open) => {
      const next = !open;
      setFlag('sw_lib_open', next ? '1' : '0');
      return next;
    });
  };
  // No sim run has happened yet on the menu, so "today" anchors to t=0
  // (i.e. the project's start date). MODEL-time vs CAL is irrelevant here.
  const todayCal = fmtCalendar(0, projectTime.modelTimeUnit, projectTime.startDate, dateFormat);

  // New-factory dialog state. Native `window.prompt` is suppressed in
  // embedded preview / iframe contexts (and looks unstyled even when it
  // does fire), so we drive the flow through an in-app modal.
  const [newFactoryOpen, setNewFactoryOpen] = useState(false);
  const [newFactoryName, setNewFactoryName] = useState('New Factory');

  // The cap counts SAVED factories only — the active factory lives in the
  // project/twin stores, not the library, so it isn't a slot.
  const savedCount = savedFactories.length;

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
    if (isFactoryNameTaken(name)) return; // belt + braces; button is disabled
    archiveAndStartFresh(name);
    setNewFactoryOpen(false);
    navigate('/line');
  };
  const handleLoadSaved = (id: string) => {
    if (loadFactory(id)) navigate('/line');
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

        {/* NEW — the single "create" action. Your saved factories live in the
            FACTORY LIBRARY list below, so the menu reads like any file-based
            app: one NEW button + an Open/Recents list. */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            size="lg"
            onClick={openNewFactoryDialog}
            icon="+"
          >
            CREATE NEW FACTORY
          </Button>
        </div>

        {/* FACTORY LIBRARY — the one place you open things from. Reads like a
            file app's Open / Recents panel: the active factory first, then your
            saved factories (pinned float to the top, the rest newest-first). */}
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={toggleLibrary}
            aria-expanded={libraryOpen}
            aria-controls="factory-library-list"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', marginBottom: 8, gap: 12, flexWrap: 'wrap',
              background: 'transparent', border: 'none', padding: '2px 0',
              cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span style={{ ...SW_TYPE.kicker, color: SW_COLORS.muted }}>
              FACTORY LIBRARY · {savedCount} / {FACTORY_LIBRARY_MAX} SAVED
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...SW_TYPE.kicker, fontWeight: 600, color: SW_COLORS.muted, letterSpacing: '0.5px' }}>
              STORED ON THIS DEVICE
              <span
                aria-hidden="true"
                style={{ display: 'inline-block', transition: 'transform 160ms', transform: libraryOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              >
                ▾
              </span>
            </span>
          </button>
          {libraryOpen && (
          <div id="factory-library-list" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {/* ACTIVE — your current factory */}
            <LibraryCard
              icon="◆"
              title={factoryName || 'Untitled Factory'}
              caption={`${activeStationCount} STATIONS`}
              tag="ACTIVE"
              tagColor={SW_COLORS.ok}
              scenarioCount={activeScenarioCount}
              onClick={() => navigate('/line')}
              onOpenScenarios={handleOpenScenariosForActive}
            />

            {/* RECENTS + PINNED — your saved factories. Pinned float to the
                top (sortedSaved); the rest follow newest-first. */}
            {sortedSaved.map((slot) => (
              <LibraryCard
                key={slot.id}
                icon="▤"
                title={slot.name}
                caption={`${slot.stationCount} STATIONS · ${fmtSavedAt(slot.savedAt)}`}
                tag={slot.pinned ? 'PINNED' : 'SAVED'}
                tagColor={slot.pinned ? SW_COLORS.thread : SW_COLORS.muted}
                pinned={slot.pinned}
                scenarioCount={slot.project.scenarios?.length ?? 0}
                onClick={() => handleLoadSaved(slot.id)}
                onOpenScenarios={() => handleOpenScenariosForSaved(slot.id)}
                onTogglePin={() => togglePin(slot.id)}
                onDelete={() => handleDeleteSaved(slot.id, slot.name)}
              />
            ))}
          </div>
          )}
        </div>

      </div>

      {/* RIGHT: today's status. The mock "live factory" illustration card
          (fake isometric floor + fabricated "14 operators · 2 machines down ·
          184 pcs/hr · 2 ALERTS" telemetry) was removed — the splash menu has no
          live floor to report, so an honest, data-free panel beats invented
          numbers. */}
      <div style={{ padding: '64px 56px 64px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
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

/**
 * One entry in the FACTORY LIBRARY list. Renders your own factories as a flat
 * list:
 *
 *   • ACTIVE — the factory you currently have open. Clicking opens the Builder;
 *     it carries a scenarios sub-button but no delete/pin controls.
 *   • SAVED  — a factory in the library. Clicking loads it; it gets a delete ×,
 *     a pin toggle, and the same scenarios sub-button.
 */
interface LibraryCardProps {
  icon: string;
  title: string;
  caption: string;
  tag: string;
  tagColor: string;
  /** Scenarios sub-button count. */
  scenarioCount?: number;
  /** Pinned state (saved factories only) — drives the ★ glyph + amber accent. */
  pinned?: boolean;
  onClick: () => void;
  onDelete?: () => void;
  onOpenScenarios: () => void;
  /** Pin/unpin toggle (saved factories only). */
  onTogglePin?: () => void;
}

function LibraryCard({
  icon,
  title,
  caption,
  tag,
  tagColor,
  scenarioCount,
  pinned,
  onClick,
  onDelete,
  onOpenScenarios,
  onTogglePin,
}: LibraryCardProps) {
  const count = scenarioCount ?? 0;
  return (
    <Card
      hover
      padding={14}
      onClick={onClick}
      accent={pinned ? SW_COLORS.thread : undefined}
      style={{
        flex: '1 1 180px',
        minWidth: 160,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6, minHeight: 16 }}>
        <Tag soft color={tagColor}>{tag}</Tag>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {onTogglePin && (
            <button
              type="button"
              aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
              title={pinned
                ? 'Unpin — allow auto-cleanup to drop this when the library is full'
                : 'Pin — protect this factory from auto-cleanup'}
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              style={{
                background: 'transparent',
                border: 'none',
                color: pinned ? SW_COLORS.thread : SW_COLORS.muted,
                fontSize: 14,
                fontWeight: 700,
                cursor: 'pointer',
                padding: '0 2px',
                lineHeight: 1,
              }}
            >
              {pinned ? '★' : '☆'}
            </button>
          )}
          {onDelete ? (
            <button
              type="button"
              aria-label={`Delete saved factory ${title}`}
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
          ) : (
            !onTogglePin && <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
          )}
        </div>
      </div>
      <div style={{ ...SW_TYPE.heading, fontWeight: 800, color: SW_COLORS.ink, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {title}
      </div>
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {caption}
      </div>

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
          ...SW_TYPE.kicker,
          letterSpacing: '0.5px',
          color: count > 0 ? SW_COLORS.brand : SW_COLORS.muted,
        }}
      >
        <span>✦ {count > 0 ? `${count} SCENARIO${count === 1 ? '' : 'S'}` : 'NEW SCENARIO'}</span>
        <span>→</span>
      </button>
    </Card>
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
        background: SW_COLORS.overlay,
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
            ...SW_TYPE.heading,
            letterSpacing: '0.1em',
          }}
        >
          + CREATE NEW FACTORY
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...SW_TYPE.kicker, fontWeight: 800, color: SW_COLORS.muted, letterSpacing: '1px' }}>
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
