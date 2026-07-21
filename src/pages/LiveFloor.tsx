/**
 * Live Floor — animated, view-mode-toggleable view of the active twin.
 *
 * Three views over the same data (departments + workstations from the twin
 * store):
 *   • ISO 3D — isometric projection with cuboid fixtures, walking operators,
 *     moving WIP bundles, and heat-tinted bottlenecks.
 *   • TOP 2D — flat blueprint top-down view.
 *   • HEAT  — radial-gradient blobs around each workstation showing
 *     utilisation pressure.
 *
 * Reads:
 *   - twin store (`useTwin`)  — departments & workstations
 *   - sim store (`useSim` config built from active garment) — observed util
 *
 * This is a presentation/visualisation surface only — authoring lives in
 * /builder, KPIs live in /kpi.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { SW_COLORS, SW_FONTS, SW_SHADOWS } from '../design/tokens';
import { useTwin, selectActiveTwin, type DepartmentColorKey } from '../store/twin';
import { useProject } from '../store';
import { TimeDisplay, StageOverlay, ViewTitle, EmptyState } from '../components';
import {
  fmtModelTime,
  fmtCalendar,
  fmtWallClock,
  simDayNumber,
} from '../simulation/timeUnit';
import {
  ISO_FIXTURE_CATALOG,
  isoProj,
  ptsToStr,
  type IsoFixture,
} from '../domain';
import type { Department, Workstation } from '../domain/twin';

// ============================================================================
// SHARED HELPERS
// ============================================================================

type FloorView = 'iso' | 'top' | 'heat' | 'logic';

const DEPT_COLOR_HEX: Record<DepartmentColorKey, string> = {
  fabric: SW_COLORS.fabric,
  thread: SW_COLORS.thread,
  brand: SW_COLORS.brand,
  red: SW_COLORS.alarm,
  blue: SW_COLORS.bobbin,
  yellow: SW_COLORS.thread,
  green: SW_COLORS.fabric,
  cream: SW_COLORS.paperEdge,
};

function resolveFixture(id: string): IsoFixture | undefined {
  return ISO_FIXTURE_CATALOG.find((f) => f.id === id);
}

/** Pseudo-utilisation when no real KPI run yet — derived from a station's
 *  position so the heatmap looks alive even on a fresh twin. */
function fakeUtil(ws: Workstation, t: number): number {
  const seed = (ws.position.x * 13 + ws.position.y * 7) % 100;
  return 45 + 30 * Math.sin(t * 0.6 + seed) + (seed % 25);
}

function utilColor(util: number): string {
  if (util >= 92) return SW_COLORS.alarm;
  if (util >= 75) return SW_COLORS.warn;
  return SW_COLORS.ok;
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export function LiveFloorPage() {
  const navigate = useNavigate();
  const twin = useTwin(selectActiveTwin);
  const projectTime = useProject((s) => s.time);
  const dateFormat = useProject((s) => s.units.dateFormat);
  const [view, setView] = useState<FloorView>('iso');
  const [playing, setPlaying] = useState(true);
  /** Synthetic preview clock — accumulates real seconds since the page
   *  opened. LiveFloor is a visualisation preview, not a real DES run,
   *  so this stands in as the "model time" axis for the animation. */
  const [t, setT] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedWs, setSelectedWs] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const justDraggedRef = useRef(false);
  // Live drag pipeline — mutates the IsoView `<g>` transform attribute
  // directly during pointer moves so we don't pay a 130-station React re-render
  // per frame. Final pan is committed to state on pointerup.
  const isoGroupRef = useRef<SVGGElement | null>(null);
  const livePanRef = useRef({ x: 0, y: 0 });
  const rafPanRef = useRef<number | null>(null);
  useEffect(() => {
    livePanRef.current = pan;
  }, [pan]);
  const writeLiveTransform = () => {
    rafPanRef.current = null;
    const g = isoGroupRef.current;
    if (!g) return;
    g.setAttribute(
      'transform',
      `translate(${livePanRef.current.x}, ${livePanRef.current.y}) scale(${zoom})`,
    );
  };

  // Animation tick
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      setT((p) => p + dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Synthetic event log — picks a random hotspot every few seconds.
  const [events, setEvents] = useState<{ id: number; ws: string; kind: 'breakdown' | 'milestone'; label: string; t: number }[]>([]);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const ws = twin.workstations[Math.floor(Math.random() * twin.workstations.length)];
      if (!ws) return;
      const kinds: Array<{ kind: 'breakdown' | 'milestone'; label: string }> = [
        { kind: 'breakdown', label: 'NEEDLE BREAK' },
        { kind: 'milestone', label: 'BUNDLE OUT' },
        { kind: 'milestone', label: 'CLEAR QUEUE' },
      ];
      const choice = kinds[Math.floor(Math.random() * kinds.length)];
      setEvents((prev) => [
        ...prev.slice(-6),
        { id: Date.now() + Math.random(), ws: ws.id, ...choice, t: Date.now() },
      ]);
    }, 4000);
    return () => clearInterval(id);
  }, [playing, twin.workstations]);

  const hotIds = useMemo(() => {
    const set = new Set<string>();
    events.slice(-3).forEach((e) => {
      if (e.kind !== 'milestone') set.add(e.ws);
    });
    return set;
  }, [events]);

  // Three labelled clocks. Preview `t` is treated as model time in the
  // project's chosen unit; calendar projects via the start-date anchor.
  const unit = projectTime.modelTimeUnit;
  const previewModelT = t; // animation ticks model-time-units directly
  const dayN = simDayNumber(previewModelT, unit, projectTime.shiftDurationMin);
  const modelStr = fmtModelTime(previewModelT, unit);
  const calStr = fmtCalendar(previewModelT, unit, projectTime.startDate, dateFormat);

  const [wallNow, setWallNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setWallNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const wallStr = fmtWallClock(wallNow);

  const empty = twin.departments.length === 0;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        background: SW_COLORS.paper,
        color: SW_COLORS.ink,
        fontFamily: SW_FONTS.body,
      }}
    >
      {/* ── HUD ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: '10px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          background: 'transparent',
          flexWrap: 'wrap',
        }}
      >
        <ViewTitle kicker="Monitor" title="Live Floor" />
        <div style={{ width: 1, height: 22, background: '#0F141925' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: playing ? SW_COLORS.ok : SW_COLORS.warn,
              boxShadow: playing ? `0 0 10px ${SW_COLORS.ok}` : 'none',
              animation: playing ? 'lf-pulse 1.2s infinite' : 'none',
            }}
          />
          <span style={{ fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 700, letterSpacing: '2px' }}>
            {playing ? 'RUNNING' : 'PAUSED'}
          </span>
        </div>
        <div style={{ width: 1, height: 22, background: '#0F141925' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TimeDisplay
            kind="MODEL"
            primarySize={16}
            primary={modelStr}
            secondary={`day ${dayN}`}
            compact
          />
          <TimeDisplay
            kind="CAL"
            primarySize={11}
            primary={calStr}
            compact
          />
        </div>
        <TimeDisplay kind="WALL" primarySize={11} primary={wallStr} compact />
        <div style={{ width: 1, height: 22, background: '#0F141925' }} />

        {/* View toggle */}
        <div style={{ display: 'flex', gap: 2, background: '#0F141910', padding: 2, borderRadius: 6 }}>
          {(['iso', 'top', 'heat', 'logic'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                background: view === v ? SW_COLORS.brand : 'transparent',
                color: view === v ? '#fff' : '#0F141999',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 14px',
                fontFamily: SW_FONTS.display,
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: '0.1em',
                borderRadius: 4,
                textTransform: 'uppercase',
              }}
            >
              {v === 'iso' ? 'ISO 3D' : v === 'top' ? 'TOP 2D' : v === 'heat' ? 'HEAT' : 'LOGIC'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <TwinPicker activeTwin={twin} />

        <button
          onClick={() => navigate('/builder')}
          style={{
            background: '#0F141910',
            border: '1px solid #0F141930',
            color: SW_COLORS.ink,
            padding: '6px 12px',
            fontFamily: SW_FONTS.display,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: '0.08em',
            cursor: 'pointer',
            borderRadius: 4,
          }}
        >
          ✎ EDIT IN BUILDER
        </button>
      </div>

      {/* ── FLOOR + RIGHT INSPECTOR ─────────────────────────────────────── */}
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          display: 'grid',
          gridTemplateColumns: '1fr 320px',
        }}
      >
        {/* Stage */}
        <div
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: 'transparent',
            cursor: panning ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
          onWheel={(e) => {
            e.preventDefault();
            // Pinch zoom: trackpad pinch reports ctrlKey; Cmd-wheel for power users.
            // Mouse wheel (deltaMode != 0, or large discrete deltaY with no deltaX)
            // still zooms so wheel users aren't stuck with pan-only.
            const isPinch = e.ctrlKey || e.metaKey;
            const isMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
            if (isPinch || isMouseWheel) {
              setZoom((z) => Math.max(0.4, Math.min(2.5, z * (e.deltaY < 0 ? 1.08 : 0.93))));
              return;
            }
            // Two-finger trackpad swipe → pan. Route through the live-transform
            // pipeline so we don't re-render 130 stations on every wheel tick.
            livePanRef.current = {
              x: livePanRef.current.x - e.deltaX,
              y: livePanRef.current.y - e.deltaY,
            };
            if (rafPanRef.current == null) {
              rafPanRef.current = requestAnimationFrame(writeLiveTransform);
            }
            setPan({ ...livePanRef.current });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 1) return;
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              panX: pan.x,
              panY: pan.y,
              moved: false,
            };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (!d.moved && dx * dx + dy * dy < 16) return;
            if (!d.moved) {
              d.moved = true;
              setPanning(true);
            }
            livePanRef.current = { x: d.panX + dx, y: d.panY + dy };
            if (rafPanRef.current == null) {
              rafPanRef.current = requestAnimationFrame(writeLiveTransform);
            }
          }}
          onPointerUp={(e) => {
            const d = dragRef.current;
            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
            dragRef.current = null;
            if (d?.moved) {
              justDraggedRef.current = true;
              setPanning(false);
              if (rafPanRef.current != null) {
                cancelAnimationFrame(rafPanRef.current);
                rafPanRef.current = null;
              }
              setPan({ ...livePanRef.current });
            }
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setPanning(false);
            if (rafPanRef.current != null) {
              cancelAnimationFrame(rafPanRef.current);
              rafPanRef.current = null;
            }
          }}
          onClickCapture={(e) => {
            if (justDraggedRef.current) {
              justDraggedRef.current = false;
              e.stopPropagation();
            }
          }}
        >
          {empty ? (
            <FloorEmptyCard onBuild={() => navigate('/builder')} />
          ) : (
            <>
              {view === 'iso' && (
                <IsoView
                  twin={twin}
                  t={t}
                  zoom={zoom}
                  pan={pan}
                  hotIds={hotIds}
                  selectedWs={selectedWs}
                  onSelect={setSelectedWs}
                  groupRef={isoGroupRef}
                />
              )}
              {view === 'top' && (
                <TopView
                  twin={twin}
                  t={t}
                  zoom={zoom}
                  hotIds={hotIds}
                  selectedWs={selectedWs}
                  onSelect={setSelectedWs}
                />
              )}
              {view === 'heat' && <HeatView twin={twin} t={t} hotIds={hotIds} />}
              {view === 'logic' && (
                <LogicView
                  twin={twin}
                  t={t}
                  hotIds={hotIds}
                  selectedWs={selectedWs}
                  onSelect={setSelectedWs}
                />
              )}

              {/* Event toasts */}
              <div
                style={{
                  position: 'absolute',
                  left: 16,
                  top: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  pointerEvents: 'none',
                }}
              >
                {events.slice(-3).reverse().map((e) => (
                  <div
                    key={e.id}
                    style={{
                      background:
                        e.kind === 'breakdown'
                          ? `${SW_COLORS.alarm}dd`
                          : `${SW_COLORS.ok}dd`,
                      color: '#fff',
                      padding: '6px 12px',
                      borderRadius: 6,
                      fontFamily: SW_FONTS.mono,
                      fontSize: 11,
                      fontWeight: 700,
                      boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
                      animation: 'lf-toast-in 0.3s ease-out',
                      letterSpacing: '0.1em',
                    }}
                  >
                    <span>{e.label}</span>
                    <span style={{ opacity: 0.85, marginLeft: 8 }}>
                      · {twin.workstations.find((w) => w.id === e.ws)?.name?.slice(0, 14) ?? '—'}
                    </span>
                  </div>
                ))}
              </div>

              {/* Zoom controls */}
              <StageOverlay
                style={{
                  position: 'absolute',
                  right: 16,
                  bottom: 16,
                  display: 'flex',
                  gap: 4,
                  background: SW_COLORS.paperEdge,
                  padding: 3,
                  border: '1px solid #0F141925',
                  borderRadius: 6,
                }}
              >
                <FloorBtn onClick={() => setZoom((z) => Math.max(0.4, z * 0.85))}>−</FloorBtn>
                <FloorBtn
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  {Math.round(zoom * 100)}%
                </FloorBtn>
                <FloorBtn onClick={() => setZoom((z) => Math.min(2.5, z * 1.18))}>+</FloorBtn>
              </StageOverlay>
            </>
          )}
        </div>

        {/* Right inspector */}
        <Inspector
          twin={twin}
          selectedWs={selectedWs}
          onClear={() => setSelectedWs(null)}
          events={events.slice(-8).reverse()}
          t={t}
          onPlay={() => setPlaying(true)}
        />
      </div>

      {/* ── TRANSPORT BAR ───────────────────────────────────────────────── */}
      <div
        style={{
          padding: '12px 18px',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          onClick={() => setPlaying((p) => !p)}
          style={{
            background: playing ? SW_COLORS.alarm : SW_COLORS.ok,
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            padding: '8px 16px',
            fontFamily: SW_FONTS.display,
            fontSize: 12,
            fontWeight: 900,
            letterSpacing: '0.1em',
            borderRadius: 4,
          }}
        >
          {playing ? '⏸ PAUSE' : '▶ PLAY'}
        </button>
        <div style={{ width: 1, height: 24, background: '#0F141925' }} />
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: '#0F141999', letterSpacing: '0.1em' }}>
          ELAPSED · {t}s
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            color: '#0F141970',
            letterSpacing: '0.06em',
          }}
        >
          SCROLL zoom · DRAG pan · CLICK workstation to inspect
        </span>
        <button
          onClick={() => navigate('/sim')}
          style={{
            background: SW_COLORS.brand,
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            padding: '8px 16px',
            fontFamily: SW_FONTS.display,
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: '0.1em',
            borderRadius: 4,
          }}
        >
          ▶ OPEN SIMULATION →
        </button>
      </div>

      {/* keyframes */}
      <style>{`
        @keyframes lf-toast-in { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes lf-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes lf-march { to { stroke-dashoffset: -16; } }
      `}</style>
    </div>
  );
}

// ============================================================================
// TWIN PICKER — dropdown over canonical + scenarios, used in the HUD
// ============================================================================

function TwinPicker({ activeTwin }: { activeTwin: ReturnType<typeof selectActiveTwin> }) {
  const canonical = useTwin((s) => s.canonical);
  const scenarios = useTwin((s) => s.scenarios);
  const activeScenarioId = useTwin((s) => s.activeScenarioId);
  const setActiveScenario = useTwin((s) => s.setActiveScenario);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const isCanonical = activeScenarioId === null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: SW_COLORS.paper,
          border: '1px solid #0F141930',
          color: SW_COLORS.ink,
          padding: '5px 10px 5px 12px',
          fontFamily: SW_FONTS.display,
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: '0.08em',
          cursor: 'pointer',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          maxWidth: 320,
        }}
        title="Switch live factory"
      >
        <span style={{ fontSize: 11 }}>{isCanonical ? '◆' : '✦'}</span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textTransform: 'uppercase',
          }}
        >
          {activeTwin.name}
        </span>
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            fontWeight: 700,
            color: '#0F141999',
            letterSpacing: '0.12em',
          }}
        >
          {activeTwin.departments.length}D · {activeTwin.workstations.length}W
        </span>
        <span style={{ fontSize: 9, color: '#0F141999' }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 280,
            background: SW_COLORS.paper,
            border: '1px solid #0F141925',
            borderRadius: 6,
            boxShadow: SW_SHADOWS.float,
            padding: 4,
            zIndex: 50,
          }}
        >
          <TwinPickerRow
            icon="◆"
            label={canonical.name}
            sub={`canonical · ${canonical.departments.length}D · ${canonical.workstations.length}W`}
            selected={isCanonical}
            onClick={() => {
              setActiveScenario(null);
              setOpen(false);
            }}
          />
          {scenarios.length > 0 && (
            <div
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 8,
                fontWeight: 800,
                color: '#0F141970',
                letterSpacing: '0.15em',
                padding: '8px 10px 4px',
              }}
            >
              SCENARIOS
            </div>
          )}
          {scenarios.map((s) => (
            <TwinPickerRow
              key={s.id}
              icon="✦"
              label={s.twin.name}
              sub={`${s.twin.departments.length}D · ${s.twin.workstations.length}W`}
              selected={s.id === activeScenarioId}
              onClick={() => {
                setActiveScenario(s.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TwinPickerRow({
  icon,
  label,
  sub,
  selected,
  onClick,
}: {
  icon: string;
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        background: selected ? SW_COLORS.brandLite : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderRadius: 4,
        textAlign: 'left',
        color: SW_COLORS.ink,
      }}
    >
      <span style={{ fontSize: 12, color: selected ? SW_COLORS.brand : '#0F141999' }}>{icon}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            color: '#0F141999',
            letterSpacing: '0.08em',
          }}
        >
          {sub}
        </span>
      </div>
      {selected && (
        <span style={{ fontSize: 11, color: SW_COLORS.brand, fontWeight: 900 }}>●</span>
      )}
    </button>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function FloorEmptyCard({ onBuild }: { onBuild: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 32,
        textAlign: 'center',
      }}
    >
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 700, color: '#0F141970', letterSpacing: '2px' }}>
        NO TWIN AUTHORED YET
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 36,
          fontWeight: 900,
          letterSpacing: '-0.01em',
          color: SW_COLORS.ink,
          maxWidth: 520,
          lineHeight: 1.05,
        }}
      >
        Build your factory.<br />
        <span style={{ color: SW_COLORS.brand }}>Then watch it run.</span>
      </div>
      <div style={{ fontSize: 13, color: '#0F141999', maxWidth: 440 }}>
        Drop departments and workstations on the canvas in Factory Builder, then come back here for the iso 3D, top-down 2D and heat-map live views.
      </div>
      <button
        onClick={onBuild}
        style={{
          background: SW_COLORS.brand,
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          padding: '10px 22px',
          fontFamily: SW_FONTS.display,
          fontSize: 13,
          fontWeight: 900,
          letterSpacing: '0.1em',
          borderRadius: 6,
          marginTop: 8,
        }}
      >
        ◆ OPEN FACTORY BUILDER →
      </button>
    </div>
  );
}

// ============================================================================
// ISO 3D VIEW
// ============================================================================

interface IsoViewProps {
  twin: ReturnType<typeof selectActiveTwin>;
  t: number;
  zoom: number;
  pan: { x: number; y: number };
  hotIds: Set<string>;
  selectedWs: string | null;
  onSelect: (id: string | null) => void;
  groupRef: MutableRefObject<SVGGElement | null>;
}

function IsoView({ twin, t, zoom, pan, hotIds, selectedWs, onSelect, groupRef }: IsoViewProps) {
  // Sync pan/zoom state → DOM transform. Drag updates bypass React and write
  // straight to the same attribute via ref, so this only fires for committed
  // state changes (release, zoom buttons, reset). Layout effect runs before
  // paint to avoid a flash on mount.
  useLayoutEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.setAttribute('transform', `translate(${pan.x}, ${pan.y}) scale(${zoom})`);
  }, [pan.x, pan.y, zoom, groupRef]);
  // World-extent bounds → SVG viewBox. Padded generously so the iso grid
  // breathes outward beyond the floor diamond.
  const cTL = isoProj(0, 0);
  const cTR = isoProj(twin.gridW, 0);
  const cBR = isoProj(twin.gridW, twin.gridH);
  const cBL = isoProj(0, twin.gridH);
  const PAD = 220;
  const minX = Math.min(cTL.sx, cBL.sx) - PAD;
  const maxX = Math.max(cTR.sx, cBR.sx) + PAD;
  const minY = Math.min(cTL.sy, cTR.sy) - PAD;
  const maxY = Math.max(cBL.sy, cBR.sy) + PAD;
  const vbW = maxX - minX;
  const vbH = maxY - minY;

  // Extended iso grid bounds — overshoots the floor by a wide margin so the
  // grid radiates outward into the surrounding plane.
  const GRID_OVERSCAN = 14;
  const gx0 = -GRID_OVERSCAN;
  const gx1 = twin.gridW + GRID_OVERSCAN;
  const gy0 = -GRID_OVERSCAN;
  const gy1 = twin.gridH + GRID_OVERSCAN;
  const MAJOR = 4; // major iso grid line every N cells

  const sortedWs = useMemo(
    () =>
      [...twin.workstations].sort((a, b) =>
        a.position.x + a.position.y - (b.position.x + b.position.y),
      ),
    [twin.workstations],
  );

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`${minX} ${minY} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', userSelect: 'none' }}
      onClick={() => onSelect(null)}
    >
      <defs>
        {/* Faint warm paper backing — radial wash that fades toward edges. */}
        <radialGradient id="lf-paper" cx="50%" cy="42%" r="72%">
          <stop offset="0%" stopColor="#FFFDF6" stopOpacity={1} />
          <stop offset="60%" stopColor="#F4EFE0" stopOpacity={1} />
          <stop offset="100%" stopColor="#E8E1CD" stopOpacity={1} />
        </radialGradient>
        {/* Outer vignette darkens edges to focus the eye on the floor. */}
        <radialGradient id="lf-vig" cx="50%" cy="40%" r="65%">
          <stop offset="0%" stopColor={SW_COLORS.ink} stopOpacity={0} />
          <stop offset="100%" stopColor={SW_COLORS.ink} stopOpacity={0.22} />
        </radialGradient>
        {/* Floor diamond fill — subtle blueprint cyan wash. */}
        <linearGradient id="lf-floor" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#E7EEF6" stopOpacity={1} />
          <stop offset="100%" stopColor="#D6E0EC" stopOpacity={1} />
        </linearGradient>
        {/* Soft grey under-shadow blob for each fixture base. */}
        <radialGradient id="lf-fix-shadow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={SW_COLORS.ink} stopOpacity={0.35} />
          <stop offset="60%" stopColor={SW_COLORS.ink} stopOpacity={0.12} />
          <stop offset="100%" stopColor={SW_COLORS.ink} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* 1. Paper backing — solid warm fill behind everything. */}
      <rect x={minX} y={minY} width={vbW} height={vbH} fill="url(#lf-paper)" />

      <g ref={groupRef} style={{ transformOrigin: 'center', willChange: 'transform' }}>
        {/* 2. Overscan iso grid — minor lines (every cell, outside the floor too). */}
        {Array.from({ length: gx1 - gx0 + 1 }, (_, i) => {
          const x = gx0 + i;
          const a = isoProj(x, gy0);
          const b = isoProj(x, gy1);
          const isMajor = x % MAJOR === 0;
          return (
            <line
              key={`gv-${x}`}
              x1={a.sx}
              y1={a.sy}
              x2={b.sx}
              y2={b.sy}
              stroke={isMajor ? '#0F141958' : '#0F14192e'}
              strokeWidth={isMajor ? 1.0 : 0.6}
            />
          );
        })}
        {Array.from({ length: gy1 - gy0 + 1 }, (_, i) => {
          const y = gy0 + i;
          const a = isoProj(gx0, y);
          const b = isoProj(gx1, y);
          const isMajor = y % MAJOR === 0;
          return (
            <line
              key={`gh-${y}`}
              x1={a.sx}
              y1={a.sy}
              x2={b.sx}
              y2={b.sy}
              stroke={isMajor ? '#0F141958' : '#0F14192e'}
              strokeWidth={isMajor ? 1.0 : 0.6}
            />
          );
        })}

        {/* 3. Floor diamond — filled shape + crisp outline + inner bevel. */}
        <polygon
          points={ptsToStr([cTL, cTR, cBR, cBL])}
          fill="url(#lf-floor)"
          stroke="#0F1419"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
        <polygon
          points={ptsToStr([
            { sx: cTL.sx, sy: cTL.sy + 6 },
            { sx: cTR.sx - 6, sy: cTR.sy + 3 },
            { sx: cBR.sx, sy: cBR.sy - 6 },
            { sx: cBL.sx + 6, sy: cBL.sy - 3 },
          ])}
          fill="none"
          stroke="#0F141930"
          strokeWidth={0.8}
          strokeLinejoin="round"
        />

        {/* 4. In-floor iso grid lines — slightly stronger so they read clearly inside the floor. */}
        {Array.from({ length: twin.gridW + 1 }, (_, i) => {
          const a = isoProj(i, 0);
          const b = isoProj(i, twin.gridH);
          const isMajor = i % MAJOR === 0;
          return (
            <line
              key={`v-${i}`}
              x1={a.sx}
              y1={a.sy}
              x2={b.sx}
              y2={b.sy}
              stroke={isMajor ? '#0F141958' : '#0F141930'}
              strokeWidth={isMajor ? 0.9 : 0.5}
            />
          );
        })}
        {Array.from({ length: twin.gridH + 1 }, (_, i) => {
          const a = isoProj(0, i);
          const b = isoProj(twin.gridW, i);
          const isMajor = i % MAJOR === 0;
          return (
            <line
              key={`h-${i}`}
              x1={a.sx}
              y1={a.sy}
              x2={b.sx}
              y2={b.sy}
              stroke={isMajor ? '#0F141958' : '#0F141930'}
              strokeWidth={isMajor ? 0.9 : 0.5}
            />
          );
        })}

        {/* Departments — coloured zone diamonds */}
        {twin.departments.map((d) => (
          <DeptDiamond key={d.id} dept={d} />
        ))}

        {/* Workstations — depth-sorted iso fixtures */}
        {sortedWs.map((w) => (
          <IsoWorkstation
            key={w.id}
            ws={w}
            isHot={hotIds.has(w.id)}
            isSelected={selectedWs === w.id}
            t={t}
            onClick={() => onSelect(w.id)}
          />
        ))}

        {/* Walking operators — one per workstation, animated */}
        {sortedWs.map((w) => (
          <WalkingOperator key={`op-${w.id}`} ws={w} t={t} />
        ))}

        {/* Travelling WIP bundles — synthesised from dept→dept hops */}
        <WipFlow twin={twin} t={t} />
      </g>

      <rect x={minX} y={minY} width={vbW} height={vbH} fill="url(#lf-vig)" pointerEvents="none" />
    </svg>
  );
}

function DeptDiamond({ dept }: { dept: Department }) {
  const tl = isoProj(dept.bounds.x, dept.bounds.y);
  const tr = isoProj(dept.bounds.x + dept.bounds.w, dept.bounds.y);
  const br = isoProj(dept.bounds.x + dept.bounds.w, dept.bounds.y + dept.bounds.h);
  const bl = isoProj(dept.bounds.x, dept.bounds.y + dept.bounds.h);
  const cx = (tl.sx + tr.sx + br.sx + bl.sx) / 4;
  const cy = (tl.sy + tr.sy + br.sy + bl.sy) / 4;
  const fill = DEPT_COLOR_HEX[dept.color];
  return (
    <g>
      <polygon points={ptsToStr([tl, tr, br, bl])} fill={fill} fillOpacity={0.16} />
      <polygon
        points={ptsToStr([tl, tr, br, bl])}
        fill="none"
        stroke={fill}
        strokeWidth={1.4}
        strokeDasharray="4 3"
        opacity={0.7}
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily={SW_FONTS.display}
        fontSize={18}
        fontWeight={900}
        fill={fill}
        opacity={0.45}
        style={{ pointerEvents: 'none', letterSpacing: '0.15em' }}
      >
        {dept.name.toUpperCase()}
      </text>
    </g>
  );
}

function IsoWorkstation({
  ws,
  isHot,
  isSelected,
  t,
  onClick,
}: {
  ws: Workstation;
  isHot: boolean;
  isSelected: boolean;
  t: number;
  onClick: () => void;
}) {
  const fixture = resolveFixture(ws.catalogId);
  if (!fixture) return null;

  const origin = isoProj(ws.position.x, ws.position.y);
  const tl = isoProj(ws.position.x, ws.position.y);
  const tr = isoProj(ws.position.x + fixture.w, ws.position.y);
  const br = isoProj(ws.position.x + fixture.w, ws.position.y + fixture.d);
  const bl = isoProj(ws.position.x, ws.position.y + fixture.d);

  const util = ws.kpiObserved?.utilizationPct ?? fakeUtil(ws, t);

  return (
    <g
      transform={`translate(${origin.sx}, ${origin.sy}) rotate(${ws.rotation})`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {/* Base plate — a slightly inset darker diamond that grounds the fixture. */}
      <polygon
        points={ptsToStr([
          { sx: 1, sy: 1 },
          { sx: tr.sx - tl.sx - 1, sy: tr.sy - tl.sy + 1 },
          { sx: br.sx - tl.sx - 1, sy: br.sy - tl.sy - 1 },
          { sx: bl.sx - tl.sx + 1, sy: bl.sy - tl.sy - 1 },
        ])}
        fill="#0F141918"
        stroke="#0F141940"
        strokeWidth={0.6}
        pointerEvents="none"
      />
      {fixture.draw({ w: fixture.w, d: fixture.d, h: fixture.h }) as ReactNode}

      {/* Heat tint */}
      <polygon
        points={ptsToStr([
          { sx: 0, sy: 0 },
          { sx: tr.sx - tl.sx, sy: tr.sy - tl.sy },
          { sx: br.sx - tl.sx, sy: br.sy - tl.sy },
          { sx: bl.sx - tl.sx, sy: bl.sy - tl.sy },
        ])}
        fill={utilColor(util)}
        fillOpacity={0.18 + (util / 100) * 0.25}
        pointerEvents="none"
      />

      {/* Selection ring */}
      {isSelected && (
        <polygon
          points={ptsToStr([
            { sx: 0, sy: -8 },
            { sx: tr.sx - tl.sx, sy: tr.sy - tl.sy - 8 },
            { sx: br.sx - tl.sx, sy: br.sy - tl.sy - 8 },
            { sx: bl.sx - tl.sx, sy: bl.sy - tl.sy - 8 },
          ])}
          fill="none"
          stroke={SW_COLORS.brand}
          strokeWidth={2.5}
          strokeDasharray="4 3"
          pointerEvents="none"
        />
      )}

      {/* Bottleneck flag */}
      {isHot && (
        <g transform="translate(0, -28)">
          <circle r={6} fill={SW_COLORS.alarm}>
            <animate attributeName="r" values="6;9;6" dur="0.8s" repeatCount="indefinite" />
          </circle>
          <text
            x={0}
            y={3}
            textAnchor="middle"
            fontFamily={SW_FONTS.display}
            fontSize={9}
            fontWeight={900}
            fill="#fff"
            pointerEvents="none"
          >
            !
          </text>
        </g>
      )}
    </g>
  );
}

function WalkingOperator({ ws, t }: { ws: Workstation; t: number }) {
  // Bob a small dot near the workstation that wanders within 1 cell.
  const ph = (ws.position.x * 0.7 + ws.position.y * 1.3 + t * 0.6) % (Math.PI * 2);
  const ox = ws.position.x + 0.5 + Math.cos(ph) * 0.4;
  const oy = ws.position.y + 0.5 + Math.sin(ph) * 0.4;
  const p = isoProj(ox, oy);
  return (
    <g transform={`translate(${p.sx}, ${p.sy - 8})`} pointerEvents="none">
      <circle cx={0} cy={4} r={4} fill={SW_COLORS.bobbin} stroke={SW_COLORS.ink} strokeWidth={1} />
      <circle cx={0} cy={-2} r={2.5} fill="#F0C49B" stroke="#0F1419" strokeWidth={0.6} />
    </g>
  );
}

function WipFlow({ twin, t }: { twin: ReturnType<typeof selectActiveTwin>; t: number }) {
  // Small coloured dots that ride between consecutive workstations.
  if (twin.workstations.length < 2) return null;
  const sorted = [...twin.workstations].sort(
    (a, b) => a.position.x + a.position.y - (b.position.x + b.position.y),
  );
  const colors = [SW_COLORS.thread, SW_COLORS.fabric, SW_COLORS.bobbin, SW_COLORS.trim];
  return (
    <g pointerEvents="none">
      {sorted.slice(0, sorted.length - 1).map((ws, i) => {
        const next = sorted[i + 1];
        const phase = ((t * 0.4 + i * 0.27) % 1 + 1) % 1;
        const x = ws.position.x + (next.position.x - ws.position.x) * phase + 0.5;
        const y = ws.position.y + (next.position.y - ws.position.y) * phase + 0.5;
        const p = isoProj(x, y);
        return (
          <rect
            key={`b-${i}`}
            x={p.sx - 3}
            y={p.sy - 3}
            width={6}
            height={6}
            fill={colors[i % colors.length]}
            stroke="#0F1419"
            strokeWidth={0.6}
            opacity={0.92}
          />
        );
      })}
    </g>
  );
}

// ============================================================================
// TOP 2D VIEW
// ============================================================================

interface TopViewProps {
  twin: ReturnType<typeof selectActiveTwin>;
  t: number;
  zoom: number;
  hotIds: Set<string>;
  selectedWs: string | null;
  onSelect: (id: string | null) => void;
}

function TopView({ twin, t, zoom, hotIds, selectedWs, onSelect }: TopViewProps) {
  const CELL = 28;
  const W = twin.gridW * CELL;
  const H = twin.gridH * CELL;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: '100%', display: 'block' }}
      preserveAspectRatio="xMidYMid meet"
      onClick={() => onSelect(null)}
    >
      <defs>
        <pattern id="lf-top-grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
          <path d={`M ${CELL} 0 L 0 0 0 ${CELL}`} fill="none" stroke="#0F141910" strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={W} height={H} fill={SW_COLORS.paperDeep} />
      <rect width={W} height={H} fill="url(#lf-top-grid)" />

      <g style={{ transformOrigin: 'center', transform: `scale(${zoom})` }}>
        {/* Departments */}
        {twin.departments.map((d) => {
          const c = DEPT_COLOR_HEX[d.color];
          return (
            <g key={d.id}>
              <rect
                x={d.bounds.x * CELL}
                y={d.bounds.y * CELL}
                width={d.bounds.w * CELL}
                height={d.bounds.h * CELL}
                fill={c}
                opacity={0.13}
                stroke={c}
                strokeWidth={1.4}
                strokeDasharray="4 3"
              />
              <text
                x={d.bounds.x * CELL + 8}
                y={d.bounds.y * CELL + 18}
                fontFamily={SW_FONTS.mono}
                fontSize={11}
                fontWeight={900}
                fill={c}
                style={{ letterSpacing: '0.1em' }}
              >
                {d.name.toUpperCase()}
              </text>
            </g>
          );
        })}

        {/* Flow arrows between consecutive stations */}
        {twin.workstations.length > 1 &&
          [...twin.workstations]
            .sort((a, b) => a.position.x + a.position.y - (b.position.x + b.position.y))
            .slice(0, -1)
            .map((ws, i, arr) => {
              const next = arr[i + 1] ?? twin.workstations[twin.workstations.length - 1];
              if (!next) return null;
              return (
                <line
                  key={`flow-${i}`}
                  x1={ws.position.x * CELL + CELL / 2}
                  y1={ws.position.y * CELL + CELL / 2}
                  x2={next.position.x * CELL + CELL / 2}
                  y2={next.position.y * CELL + CELL / 2}
                  stroke="#0F141930"
                  strokeWidth={1.2}
                  strokeDasharray="6 4"
                  style={{
                    animation: 'lf-march 0.8s linear infinite',
                  }}
                />
              );
            })}

        {/* Workstations */}
        {twin.workstations.map((ws) => {
          const fix = resolveFixture(ws.catalogId);
          const w = (fix?.w ?? 1) * CELL;
          const h = (fix?.d ?? 1) * CELL;
          const isHot = hotIds.has(ws.id);
          const isSel = selectedWs === ws.id;
          const util = ws.kpiObserved?.utilizationPct ?? fakeUtil(ws, t);
          const fill = isHot ? SW_COLORS.alarm : utilColor(util);
          return (
            <g
              key={ws.id}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(ws.id);
              }}
              style={{ cursor: 'pointer' }}
            >
              <rect
                x={ws.position.x * CELL + 2}
                y={ws.position.y * CELL + 2}
                width={Math.max(8, w - 4)}
                height={Math.max(8, h - 4)}
                rx={3}
                fill={fill}
                opacity={0.7 + (util / 100) * 0.3}
                stroke={isSel ? SW_COLORS.brand : SW_COLORS.ink}
                strokeWidth={isSel ? 2 : 1}
              />
              {isHot && (
                <circle
                  cx={ws.position.x * CELL + w / 2}
                  cy={ws.position.y * CELL + h / 2}
                  r={Math.min(w, h) / 2 + 4}
                  fill="none"
                  stroke={SW_COLORS.alarm}
                  strokeWidth={1.5}
                >
                  <animate
                    attributeName="r"
                    values={`${Math.min(w, h) / 2 + 4};${Math.min(w, h) / 2 + 12};${Math.min(w, h) / 2 + 4}`}
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Operator dots */}
        {twin.workstations.map((ws) => {
          const ph = (ws.position.x * 0.7 + ws.position.y * 1.3 + t * 0.6) % (Math.PI * 2);
          const ox = (ws.position.x + 0.5 + Math.cos(ph) * 0.4) * CELL;
          const oy = (ws.position.y + 0.5 + Math.sin(ph) * 0.4) * CELL;
          return (
            <circle
              key={`op-${ws.id}`}
              cx={ox}
              cy={oy}
              r={3.5}
              fill={SW_COLORS.bobbin}
              stroke={SW_COLORS.ink}
              strokeWidth={1}
              pointerEvents="none"
            />
          );
        })}
      </g>
    </svg>
  );
}

// ============================================================================
// HEAT VIEW
// ============================================================================

function HeatView({
  twin,
  t,
  hotIds,
}: {
  twin: ReturnType<typeof selectActiveTwin>;
  t: number;
  hotIds: Set<string>;
}) {
  const CELL = 28;
  const W = twin.gridW * CELL;
  const H = twin.gridH * CELL;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: '100%', display: 'block' }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {twin.workstations.map((ws) => {
          const util = ws.kpiObserved?.utilizationPct ?? fakeUtil(ws, t);
          const isHot = hotIds.has(ws.id);
          const intensity = isHot ? 1 : Math.min(1, util / 100 + 0.15);
          const col = isHot ? SW_COLORS.alarm : utilColor(util);
          return (
            <radialGradient key={`hg-${ws.id}`} id={`heat-${ws.id}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={col} stopOpacity={intensity} />
              <stop offset="100%" stopColor={col} stopOpacity={0} />
            </radialGradient>
          );
        })}
        <linearGradient id="lf-legend" x1="0%" x2="100%">
          <stop offset="0%" stopColor={SW_COLORS.ok} />
          <stop offset="60%" stopColor={SW_COLORS.warn} />
          <stop offset="100%" stopColor={SW_COLORS.alarm} />
        </linearGradient>
      </defs>

      <rect width={W} height={H} fill={SW_COLORS.paperDeep} />

      {/* dept outlines for orientation */}
      {twin.departments.map((d) => (
        <rect
          key={d.id}
          x={d.bounds.x * CELL}
          y={d.bounds.y * CELL}
          width={d.bounds.w * CELL}
          height={d.bounds.h * CELL}
          fill="none"
          stroke="#0F141925"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ))}

      {/* heat blobs */}
      {twin.workstations.map((ws) => {
        const fix = resolveFixture(ws.catalogId);
        const cx = (ws.position.x + (fix?.w ?? 1) / 2) * CELL;
        const cy = (ws.position.y + (fix?.d ?? 1) / 2) * CELL;
        return (
          <circle
            key={`heat-${ws.id}`}
            cx={cx}
            cy={cy}
            r={90}
            fill={`url(#heat-${ws.id})`}
            style={{ mixBlendMode: 'multiply' }}
          />
        );
      })}

      {/* station markers */}
      {twin.workstations.map((ws) => {
        const fix = resolveFixture(ws.catalogId);
        const cx = (ws.position.x + (fix?.w ?? 1) / 2) * CELL;
        const cy = (ws.position.y + (fix?.d ?? 1) / 2) * CELL;
        const isHot = hotIds.has(ws.id);
        return (
          <circle
            key={`pt-${ws.id}`}
            cx={cx}
            cy={cy}
            r={3.5}
            fill={isHot ? SW_COLORS.alarm : SW_COLORS.ink}
            opacity={0.85}
          />
        );
      })}

      {/* legend */}
      <g transform={`translate(${W - 220}, 20)`}>
        <rect width={200} height={62} fill="#FBFAF6E6" stroke="#0F141925" rx={4} />
        <text
          x={12}
          y={20}
          fill={SW_COLORS.ink}
          fontFamily={SW_FONTS.mono}
          fontSize={10}
          fontWeight={900}
          style={{ letterSpacing: '0.15em' }}
        >
          UTILISATION HEAT
        </text>
        <rect x={12} y={30} width={176} height={10} fill="url(#lf-legend)" />
        <text x={12} y={54} fill="#0F141999" fontFamily={SW_FONTS.mono} fontSize={9}>
          calm
        </text>
        <text
          x={188}
          y={54}
          fill="#0F141999"
          fontFamily={SW_FONTS.mono}
          fontSize={9}
          textAnchor="end"
        >
          critical
        </text>
      </g>
    </svg>
  );
}

// ============================================================================
// LOGIC VIEW — AnyLogic-style block-flow / schema diagram
// ============================================================================
//
// Each department becomes a flow card with its station count, average util,
// and per-dept hot count. Cards are connected by directional flow arrows in
// reading order (sorted by top-left iso position). Click a card → its first
// workstation gets selected so the inspector populates.
//
// This is the same idea as STITCHWORKS.html's FloorLogicView, but driven by
// the user-authored twin instead of a hard-coded zone list.

interface LogicViewProps {
  twin: ReturnType<typeof selectActiveTwin>;
  t: number;
  hotIds: Set<string>;
  selectedWs: string | null;
  onSelect: (id: string | null) => void;
}

function LogicView({ twin, t, hotIds, selectedWs, onSelect }: LogicViewProps) {
  // Sort departments by their top-left position so the flow reads left→right,
  // top→bottom — same convention as a process schematic.
  const ordered = useMemo(
    () =>
      [...twin.departments].sort((a, b) => {
        if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
        return a.bounds.x - b.bounds.x;
      }),
    [twin.departments],
  );

  const W = 1280;
  const H = 720;
  const CARD_W = 220;
  const CARD_H = 140;
  const cols = 4;
  const colStep = (W - 80 - CARD_W) / Math.max(1, cols - 1);
  const rowStep = CARD_H + 80;

  const positions = ordered.map((_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { x: 40 + col * colStep, y: 60 + row * rowStep, col, row };
  });

  // Per-dept aggregates derived from each dept's workstations.
  const aggregates = ordered.map((d) => {
    const stations = twin.workstations.filter((w) => w.deptId === d.id);
    const utils = stations.map((w) => w.kpiObserved?.utilizationPct ?? fakeUtil(w, t));
    const avg = utils.length > 0 ? utils.reduce((a, b) => a + b, 0) / utils.length : 0;
    const hot = stations.filter((w) => hotIds.has(w.id) || (w.kpiObserved?.utilizationPct ?? fakeUtil(w, t)) >= 90).length;
    const wip = stations.length * 8 + Math.floor(Math.sin(t * 0.4 + d.bounds.x) * 6 + 6);
    const pcsHr = Math.max(0, Math.round(avg * 1.6 + Math.sin(t * 0.3 + d.bounds.y) * 12));
    return { d, stations, avg, hot, wip, pcsHr };
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block' }}
      onClick={() => onSelect(null)}
    >
      <defs>
        <pattern id="lf-logic-grid" width={32} height={32} patternUnits="userSpaceOnUse">
          <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#0F14190a" strokeWidth={1} />
        </pattern>
        <marker
          id="lf-logic-arrow"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="#0F141999" />
        </marker>
      </defs>
      <rect width={W} height={H} fill={SW_COLORS.paperDeep} />
      <rect width={W} height={H} fill="url(#lf-logic-grid)" />

      {/* Title */}
      <text
        x={W / 2}
        y={32}
        textAnchor="middle"
        fill="#0F141999"
        fontFamily={SW_FONTS.mono}
        fontSize={12}
        fontWeight={800}
        letterSpacing="2px"
      >
        {twin.name.toUpperCase()} · LOGIC · BLOCK-FLOW DIAGRAM
      </text>

      {/* Flow arrows (drawn first so cards sit on top) */}
      {ordered.map((_, i) => {
        if (i === ordered.length - 1) return null;
        const a = positions[i];
        const b = positions[i + 1];
        const sx = a.x + CARD_W;
        const sy = a.y + CARD_H / 2;
        const ex = b.x;
        const ey = b.y + CARD_H / 2;
        // Same row → straight; otherwise step down-right.
        let path: string;
        if (a.row === b.row) {
          path = `M ${sx} ${sy} L ${ex - 6} ${ey}`;
        } else {
          // Wrap from end of row down to start of next row
          const midY = (a.y + CARD_H + b.y) / 2;
          path = `M ${sx} ${sy} L ${sx + 24} ${sy} L ${sx + 24} ${midY} L ${b.x - 24} ${midY} L ${b.x - 24} ${ey} L ${ex - 6} ${ey}`;
        }
        return (
          <g key={`flow-${i}`} pointerEvents="none">
            <path
              d={path}
              fill="none"
              stroke="#0F141945"
              strokeWidth={2}
              strokeDasharray="6 5"
              markerEnd="url(#lf-logic-arrow)"
              style={{ animation: 'lf-march 0.9s linear infinite' }}
            />
          </g>
        );
      })}

      {/* Department flow cards */}
      {aggregates.map((agg, i) => {
        const { d, stations, avg, hot, wip, pcsHr } = agg;
        const p = positions[i];
        const accent = DEPT_COLOR_HEX[d.color];
        const utilCol = utilColor(avg);
        const isSelected = stations.some((s) => s.id === selectedWs);
        return (
          <g
            key={d.id}
            transform={`translate(${p.x}, ${p.y})`}
            onClick={(e) => {
              e.stopPropagation();
              if (stations[0]) onSelect(stations[0].id);
            }}
            style={{ cursor: 'pointer' }}
          >
            {/* Card frame */}
            <rect
              x={0}
              y={0}
              width={CARD_W}
              height={CARD_H}
              rx={6}
              fill={SW_COLORS.paper}
              stroke={isSelected ? SW_COLORS.brand : accent}
              strokeWidth={isSelected ? 2.5 : 1.5}
            />
            {/* Color header strip */}
            <rect x={0} y={0} width={CARD_W} height={26} rx={6} fill={accent} />
            <rect x={0} y={20} width={CARD_W} height={6} fill={accent} />
            <text
              x={12}
              y={17}
              fontFamily={SW_FONTS.display}
              fontSize={11}
              fontWeight={900}
              fill="#fff"
              letterSpacing="0.1em"
            >
              {(() => {
                const name = d.name.toUpperCase();
                // CARD_W=220, padding≈24 → ~24 chars fit at 11px Archivo Black
                return name.length > 24 ? name.slice(0, 23) + '…' : name;
              })()}
            </text>
            <text
              x={CARD_W - 12}
              y={17}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={800}
              fill="#0F1419cc"
            >
              {stations.length} STN
            </text>

            {/* Throughput hero number */}
            <text
              x={CARD_W / 2}
              y={68}
              textAnchor="middle"
              fontFamily={SW_FONTS.display}
              fontSize={32}
              fontWeight={900}
              fill={SW_COLORS.ink}
              letterSpacing="-0.02em"
            >
              {pcsHr}
            </text>
            <text
              x={CARD_W / 2}
              y={84}
              textAnchor="middle"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={700}
              fill="#0F141999"
              letterSpacing="0.1em"
            >
              PCS/HR
            </text>

            {/* Util bar */}
            <rect x={12} y={96} width={CARD_W - 24} height={4} rx={2} fill="#0F141918" />
            <rect
              x={12}
              y={96}
              width={Math.max(0, ((CARD_W - 24) * Math.min(100, avg)) / 100)}
              height={4}
              rx={2}
              fill={utilCol}
            />
            <text
              x={12}
              y={114}
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={700}
              fill="#0F141999"
              letterSpacing="0.06em"
            >
              UTIL
            </text>
            <text
              x={CARD_W - 12}
              y={114}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={10}
              fontWeight={800}
              fill={utilCol}
            >
              {avg.toFixed(0)}%
            </text>

            {/* Bottom row — WIP + hot count */}
            <text
              x={12}
              y={130}
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={700}
              fill="#0F141999"
            >
              WIP {wip}
            </text>
            <text
              x={CARD_W - 12}
              y={130}
              textAnchor="end"
              fontFamily={SW_FONTS.mono}
              fontSize={9}
              fontWeight={800}
              fill={hot > 0 ? SW_COLORS.alarm : '#0F141999'}
            >
              {hot > 0 ? `● ${hot} HOT` : '○ STABLE'}
            </text>

            {/* Animated flowing dots inside the card body */}
            {stations.length > 0 && (
              <>
                {Array.from({ length: 4 }).map((_, k) => {
                  const phase = ((t * 0.5 + k * 0.25 + i * 0.1) % 1 + 1) % 1;
                  const dx = 14 + (CARD_W - 28) * phase;
                  return (
                    <circle
                      key={`dot-${k}`}
                      cx={dx}
                      cy={92}
                      r={1.6}
                      fill={accent}
                      opacity={0.55}
                      pointerEvents="none"
                    />
                  );
                })}
              </>
            )}
          </g>
        );
      })}

      {/* Empty-state hint */}
      {ordered.length === 0 && (
        <text
          x={W / 2}
          y={H / 2}
          textAnchor="middle"
          fill="#0F141970"
          fontFamily={SW_FONTS.body}
          fontSize={14}
        >
          No departments yet — author the twin in Factory Builder.
        </text>
      )}

      {/* Legend */}
      <g transform={`translate(${W - 220}, ${H - 60})`}>
        <rect width={200} height={44} fill="#FBFAF6E6" stroke="#0F141925" rx={4} />
        <text
          x={12}
          y={18}
          fill={SW_COLORS.ink}
          fontFamily={SW_FONTS.mono}
          fontSize={10}
          fontWeight={900}
          letterSpacing="0.15em"
        >
          LOGIC LEGEND
        </text>
        <text x={12} y={34} fill="#0F141999" fontFamily={SW_FONTS.mono} fontSize={9}>
          ⬛ dept · → flow · ● bottleneck
        </text>
      </g>
    </svg>
  );
}

// ============================================================================
// RIGHT INSPECTOR
// ============================================================================

interface InspectorProps {
  twin: ReturnType<typeof selectActiveTwin>;
  selectedWs: string | null;
  onClear: () => void;
  events: { id: number; ws: string; kind: 'breakdown' | 'milestone'; label: string }[];
  t: number;
  /** Starts the floor animation — the event feed's empty-state CTA. */
  onPlay: () => void;
}

function Inspector({ twin, selectedWs, onClear, events, t, onPlay }: InspectorProps) {
  const ws = selectedWs ? twin.workstations.find((w) => w.id === selectedWs) : null;
  const dept = ws ? twin.departments.find((d) => d.id === ws.deptId) : null;
  const fix = ws ? resolveFixture(ws.catalogId) : null;
  const util = ws ? ws.kpiObserved?.utilizationPct ?? fakeUtil(ws, t) : 0;

  // Aggregate KPIs across all workstations.
  const kpis = useMemo(() => {
    const totalUtil = twin.workstations.reduce(
      (acc, w) => acc + (w.kpiObserved?.utilizationPct ?? fakeUtil(w, t)),
      0,
    );
    const avg = twin.workstations.length > 0 ? totalUtil / twin.workstations.length : 0;
    const hot = twin.workstations.filter((w) => {
      const u = w.kpiObserved?.utilizationPct ?? fakeUtil(w, t);
      return u >= 85;
    }).length;
    return { avg, hot };
  }, [twin.workstations, t]);

  return (
    <div
      style={{
        background: 'transparent',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'auto',
      }}
    >
      <div>
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            fontWeight: 800,
            color: '#0F141999',
            letterSpacing: '0.18em',
            marginBottom: 8,
          }}
        >
          FACTORY KPIs
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <KpiTile label="Avg util" value={`${kpis.avg.toFixed(0)}%`} accent={utilColor(kpis.avg)} />
          <KpiTile label="Hot stations" value={`${kpis.hot}`} accent={kpis.hot > 0 ? SW_COLORS.alarm : SW_COLORS.ok} />
          <KpiTile label="Departments" value={`${twin.departments.length}`} accent={SW_COLORS.bobbin} />
          <KpiTile label="Workstations" value={`${twin.workstations.length}`} accent={SW_COLORS.thread} />
        </div>
      </div>

      <div
        style={{
          background: '#0F141908',
          border: '1px solid #0F141918',
          borderRadius: 6,
          padding: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 9,
              fontWeight: 800,
              color: '#0F141999',
              letterSpacing: '0.18em',
            }}
          >
            INSPECTOR
          </div>
          {ws && (
            <button
              onClick={onClear}
              style={{
                background: 'transparent',
                color: '#0F141999',
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: SW_FONTS.mono,
              }}
            >
              ✕ clear
            </button>
          )}
        </div>
        {!ws ? (
          <EmptyState size="sm" icon="▣" title="Nothing selected" body="Click a workstation to inspect." />
        ) : (
          <>
            <div style={{ fontFamily: SW_FONTS.display, fontSize: 16, fontWeight: 900, color: SW_COLORS.ink }}>
              {ws.name}
            </div>
            <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: '#0F141999', marginTop: 2 }}>
              {fix?.label ?? ws.catalogId}  ·  {dept?.name ?? '—'}
            </div>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <KpiTile label="Util" value={`${util.toFixed(0)}%`} accent={utilColor(util)} />
              <KpiTile
                label="Workers"
                value={`${ws.resources.workersRequired}`}
                accent={SW_COLORS.bobbin}
              />
              <KpiTile
                label="Capacity/hr"
                value={`${ws.kpiTargets.capacityPerHr ?? '—'}`}
                accent={SW_COLORS.fabric}
              />
              <KpiTile
                label="Operation"
                value={ws.operation.opId ?? ws.operation.freeText ?? '—'}
                accent={SW_COLORS.thread}
              />
            </div>
          </>
        )}
      </div>

      <div
        style={{
          background: '#0F141908',
          border: '1px solid #0F141918',
          borderRadius: 6,
          padding: 12,
          flex: 1,
          minHeight: 100,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 9,
            fontWeight: 800,
            color: '#0F141999',
            letterSpacing: '0.18em',
            marginBottom: 8,
          }}
        >
          EVENT FEED
        </div>
        <div style={{ flex: 1, overflow: 'auto', fontFamily: SW_FONTS.mono, fontSize: 11, lineHeight: 1.6 }}>
          {events.length === 0 && (
            <EmptyState
              size="sm"
              icon="▶"
              title="No events yet"
              body="Press PLAY to start the floor."
              action={{ label: '▶ Play', onClick: onPlay }}
            />
          )}
          {events.map((e) => {
            const wsName = twin.workstations.find((w) => w.id === e.ws)?.name?.slice(0, 16) ?? '—';
            const col =
              e.kind === 'milestone'
                ? SW_COLORS.ok
                : SW_COLORS.alarm;
            return (
              <div key={e.id} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                <span style={{ color: col, width: 96, fontWeight: 700 }}>{e.label}</span>
                <span style={{ color: '#0F141999', flex: 1 }}>· {wsName}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      style={{
        background: '#0F141910',
        border: '1px solid #0F141918',
        borderRadius: 6,
        padding: '8px 10px',
      }}
    >
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          color: '#0F141999',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 18,
          fontWeight: 900,
          color: accent,
          marginTop: 2,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function FloorBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: '#0F141910',
        color: SW_COLORS.ink,
        border: '1px solid #0F141925',
        cursor: 'pointer',
        padding: '4px 10px',
        fontFamily: SW_FONTS.mono,
        fontSize: 11,
        fontWeight: 700,
        borderRadius: 4,
        minWidth: 36,
      }}
    >
      {children}
    </button>
  );
}

