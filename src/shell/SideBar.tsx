import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { ROUTES, type RouteDef } from '../lib/routes';
import { useTabPrefs, type TabPref } from '../lib/tabPrefs';
import { useProject } from '../store';
import { useTwin } from '../store/twin';

/** Fixed pixel width of the rail. Tuned so the icon + small label below it
 *  read cleanly without crowding the active-state left bar. */
export const SIDEBAR_WIDTH = 76;

/**
 * Slim left navigation rail. Replaces the previous top bar — icon + tiny
 * label per tab, vertical stack, active state marked by a brand-colored
 * left bar. The factory + scenario context lives at the top as a compact
 * pill; settings is pinned to the bottom.
 *
 * Each tab carries the same two prefs as the old TopBar — visibility (eye)
 * and lock — but they're only rendered on hover so the rail stays clean at
 * rest. Preferences are stored per-user in localStorage (see useTabPrefs).
 */
export function SideBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const factoryName = useProject((s) => s.meta.name);
  const activeScenarioId = useTwin((s) => s.activeScenarioId);
  const scenarioName = useTwin((s) =>
    s.activeScenarioId === null
      ? null
      : s.scenarios.find((sc) => sc.id === s.activeScenarioId)?.name ?? null,
  );
  const { get, toggleHidden, toggleLocked } = useTabPrefs();

  const currentRoute =
    ROUTES.find((r) => r.path === location.pathname)?.id ?? 'menu';

  // Settings is rendered separately at the bottom of the rail.
  const mainRoutes = ROUTES.filter((r) => r.kind === 'main' && r.id !== 'settings');
  const visibleRoutes = mainRoutes.filter((r) => !get(r.id).hidden);
  const hiddenRoutes = mainRoutes.filter((r) => get(r.id).hidden);

  // Overflow popover state (the "⋯" tile at the end of the nav stack). Closes
  // on outside click.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflowOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [overflowOpen]);

  return (
    <div
      style={{
        width: SIDEBAR_WIDTH,
        background: SW_COLORS.ink,
        color: SW_COLORS.paper,
        display: 'flex',
        flexDirection: 'column',
        borderRight: `1px solid ${alpha(SW_COLORS.paper, 0.08)}`,
        flexShrink: 0,
        height: '100%',
      }}
    >
      {/* Logo */}
      <div
        onClick={() => navigate('/')}
        title="Stitchworks · home"
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '14px 0 10px',
        }}
      >
        <svg width="28" height="28" viewBox="0 0 32 32">
          <rect x="2" y="2" width="28" height="28" rx="5" fill={SW_COLORS.brand} />
          <path
            d="M9 9 L23 9 M9 16 L23 16 M9 23 L23 23"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="square"
            strokeDasharray="2 2"
          />
          <path
            d="M9 9 Q9 16 23 16 Q23 23 9 23"
            stroke="#fff"
            strokeWidth="2.4"
            fill="none"
            strokeLinecap="square"
          />
        </svg>
      </div>

      {/* Factory + scenario pill. Initials are shown on the rail; full name
          appears on hover as a native tooltip. A brand dot signals an active
          scenario. */}
      <div
        title={
          (factoryName || 'Stitchworks') +
          (scenarioName ? ` · ${scenarioName}` : ' · Canonical')
        }
        style={{
          margin: '0 8px 6px',
          padding: '6px 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          borderRadius: SW_RADIUS.sm,
          background: alpha(SW_COLORS.paper, 0.03),
        }}
      >
        <div
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 9.5,
            fontWeight: 900,
            lineHeight: 1.1,
            letterSpacing: '0.02em',
            color: SW_COLORS.paper,
            textAlign: 'center',
            wordBreak: 'break-word',
            padding: '0 4px',
          }}
        >
          {factoryName || 'Stitchworks'}
        </div>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: activeScenarioId === null ? alpha(SW_COLORS.paper, 0.2) : SW_COLORS.brand,
          }}
        />
      </div>

      <div style={{ height: 1, background: alpha(SW_COLORS.paper, 0.08), margin: '4px 10px 6px' }} />

      {/* Nav stack — scrolls vertically if the route list grows. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '2px 6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {visibleRoutes.map((r) => (
          <NavTile
            key={r.id}
            route={r}
            active={currentRoute === r.id}
            pref={get(r.id)}
            onNavigate={() => navigate(r.path)}
            onToggleHidden={() => toggleHidden(r.id)}
            onToggleLocked={() => toggleLocked(r.id)}
          />
        ))}

        {hiddenRoutes.length > 0 && (
          <div ref={overflowRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setOverflowOpen((v) => !v)}
              aria-label={`Hidden tabs (${hiddenRoutes.length})`}
              title={`Hidden tabs (${hiddenRoutes.length})`}
              onMouseEnter={(e) => { e.currentTarget.style.background = alpha(SW_COLORS.paper, 0.05); }}
              onMouseLeave={(e) => { e.currentTarget.style.background = overflowOpen ? alpha(SW_COLORS.paper, 0.08) : 'transparent'; }}
              style={{
                width: '100%',
                background: overflowOpen ? alpha(SW_COLORS.paper, 0.08) : 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px 0',
                color: alpha(SW_COLORS.paper, 0.8),
                fontFamily: SW_FONTS.body,
                fontSize: 11,
                fontWeight: 600,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                borderRadius: SW_RADIUS.sm,
                transition: 'background 100ms',
                position: 'relative',
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1, letterSpacing: 1 }}>⋯</span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  background: SW_COLORS.brand,
                  color: '#fff',
                  borderRadius: 999,
                  minWidth: 14,
                  height: 14,
                  padding: '0 4px',
                  position: 'absolute',
                  top: 4,
                  right: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {hiddenRoutes.length}
              </span>
            </button>
            {overflowOpen && (
              <div
                role="menu"
                style={{
                  marginTop: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  background: alpha(SW_COLORS.paper, 0.03),
                  borderRadius: SW_RADIUS.sm,
                  padding: 4,
                }}
              >
                {hiddenRoutes.map((r) => (
                  <HiddenTile
                    key={r.id}
                    route={r}
                    onShow={() => {
                      toggleHidden(r.id);
                      setOverflowOpen(false);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Settings — pinned to the bottom. */}
      <div style={{ borderTop: `1px solid ${alpha(SW_COLORS.paper, 0.08)}`, padding: '8px 6px 10px' }}>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="Settings"
          title="Settings"
          onMouseEnter={(e) => {
            if (currentRoute !== 'settings') e.currentTarget.style.background = alpha(SW_COLORS.paper, 0.05);
          }}
          onMouseLeave={(e) => {
            if (currentRoute !== 'settings') e.currentTarget.style.background = 'transparent';
          }}
          style={{
            width: '100%',
            background: currentRoute === 'settings' ? alpha(SW_COLORS.paper, 0.09) : 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '8px 0 6px',
            color: currentRoute === 'settings' ? SW_COLORS.brand : alpha(SW_COLORS.paper, 0.8),
            fontFamily: SW_FONTS.body,
            fontSize: 10,
            fontWeight: 600,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            borderRadius: SW_RADIUS.sm,
            transition: 'background 100ms',
          }}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>⚙</span>
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}

interface NavTileProps {
  route: RouteDef;
  active: boolean;
  pref: TabPref;
  onNavigate: () => void;
  onToggleHidden: () => void;
  onToggleLocked: () => void;
}

/** One row in the rail. Icon + tiny label, with eye/lock micro-toggles
 *  appearing on hover so the rail reads clean at rest. */
function NavTile({ route, active, pref, onNavigate, onToggleHidden, onToggleLocked }: NavTileProps) {
  const [hovered, setHovered] = useState(false);
  const locked = pref.locked;

  return (
    <div
      onClick={() => { if (!locked) onNavigate(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-disabled={locked || undefined}
      aria-current={active ? 'page' : undefined}
      title={locked ? `${route.label} (locked)` : route.label}
      onKeyDown={(e) => {
        if (locked) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onNavigate();
        }
      }}
      style={{
        background: active ? alpha(SW_COLORS.paper, 0.08) : hovered && !locked ? alpha(SW_COLORS.paper, 0.03) : 'transparent',
        cursor: locked ? 'not-allowed' : 'pointer',
        padding: '8px 0 6px',
        color: locked
          ? alpha(SW_COLORS.paper, 0.33)
          : active
            ? SW_COLORS.brand
            : alpha(SW_COLORS.paper, 0.8),
        fontFamily: SW_FONTS.body,
        fontSize: 10,
        fontWeight: 600,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        borderRadius: SW_RADIUS.sm,
        transition: 'background 100ms, color 100ms',
        position: 'relative',
        userSelect: 'none',
      }}
    >
      {active && (
        <div
          style={{
            position: 'absolute',
            left: -6,
            top: 8,
            bottom: 8,
            width: 3,
            background: SW_COLORS.brand,
            borderRadius: 2,
          }}
        />
      )}
      <span style={{ fontSize: 18, lineHeight: 1 }}>{route.icon}</span>
      <span style={{ textAlign: 'center', whiteSpace: 'nowrap', maxWidth: SIDEBAR_WIDTH - 8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {route.shortLabel ?? route.label}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          marginTop: 2,
          height: 14,
          opacity: hovered || locked ? 1 : 0,
          transition: 'opacity 120ms',
          pointerEvents: hovered || locked ? 'auto' : 'none',
        }}
      >
        <MicroToggle
          onClick={(e) => { e.stopPropagation(); onToggleHidden(); }}
          label={`Hide ${route.label}`}
          tone="default"
        >
          <EyeIcon open size={11} />
        </MicroToggle>
        <MicroToggle
          onClick={(e) => { e.stopPropagation(); onToggleLocked(); }}
          label={locked ? `Unlock ${route.label}` : `Lock ${route.label}`}
          tone={locked ? 'active' : 'default'}
        >
          <LockIcon locked={locked} size={11} />
        </MicroToggle>
      </div>
    </div>
  );
}

interface HiddenTileProps {
  route: RouteDef;
  onShow: () => void;
}

/** Slim un-hide tile rendered inline under the "⋯" button when the overflow
 *  is expanded. One click both shows the tab again and collapses the panel. */
function HiddenTile({ route, onShow }: HiddenTileProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onShow}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Show ${route.label}`}
      title={`Show ${route.label}`}
      style={{
        background: hovered ? alpha(SW_COLORS.paper, 0.08) : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '6px 0 5px',
        color: alpha(SW_COLORS.paper, 0.67),
        fontFamily: SW_FONTS.body,
        fontSize: 9.5,
        fontWeight: 600,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        borderRadius: SW_RADIUS.sm,
        transition: 'background 100ms, color 100ms',
        position: 'relative',
      }}
    >
      <span style={{ fontSize: 15, lineHeight: 1 }}>{route.icon}</span>
      <span style={{ textAlign: 'center', whiteSpace: 'nowrap', maxWidth: SIDEBAR_WIDTH - 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {route.shortLabel ?? route.label}
      </span>
      <div style={{ marginTop: 1, opacity: 0.7, display: 'inline-flex' }}>
        <EyeIcon open={false} size={10} />
      </div>
    </button>
  );
}

interface MicroToggleProps {
  onClick: (e: React.MouseEvent) => void;
  label: string;
  tone: 'default' | 'active';
  children: React.ReactNode;
}

function MicroToggle({ onClick, label, tone, children }: MicroToggleProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={label}
      title={label}
      style={{
        background: tone === 'active'
          ? alpha(SW_COLORS.paper, 0.13)
          : hovered
            ? alpha(SW_COLORS.paper, 0.09)
            : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 1,
        width: 16,
        height: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: tone === 'active' ? SW_COLORS.brand : alpha(SW_COLORS.paper, 0.67),
        borderRadius: 3,
        transition: 'background 100ms, color 100ms',
      }}
    >
      {children}
    </button>
  );
}

interface IconProps {
  size?: number;
}

function EyeIcon({ open, size = 12 }: IconProps & { open: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8 C 3.5 4.5, 6 3, 8 3 C 10 3, 12.5 4.5, 14.5 8 C 12.5 11.5, 10 13, 8 13 C 6 13, 3.5 11.5, 1.5 8 Z" />
      <circle cx="8" cy="8" r="2" />
      {!open && <path d="M2.5 13.5 L 13.5 2.5" />}
    </svg>
  );
}

function LockIcon({ locked, size = 12 }: IconProps & { locked: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7.5" width="10" height="6.5" rx="1.2" />
      {locked ? (
        <path d="M5.5 7.5 V 5 a 2.5 2.5 0 0 1 5 0 V 7.5" />
      ) : (
        <path d="M5.5 7.5 V 5 a 2.5 2.5 0 0 1 5 0" />
      )}
    </svg>
  );
}
