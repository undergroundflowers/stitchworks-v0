import { useLocation, useNavigate } from 'react-router-dom';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { ROUTES, type RouteDef } from '../lib/routes';
import { useProject } from '../store';
import { useTwin } from '../store/twin';

/** Fixed pixel width of the rail. Tuned so the icon + small label below it
 *  read cleanly without crowding the active-state left bar. */
export const SIDEBAR_WIDTH = 76;

/**
 * Slim left navigation rail: icon + tiny label per surface, active state
 * marked by a brand-coloured left bar. Factory + scenario context sits at the
 * top as a compact pill; Settings is pinned to the bottom.
 *
 * Each tab used to carry hide and lock toggles, plus an overflow popover for
 * whatever had been hidden — roughly 320 lines of affordance. That made sense
 * against twelve nav entries. Against four surfaces, hiding one is not a
 * feature, it is a way to lose part of the app.
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

  /**
   * Which tab to light up.
   *
   * Prefix-aware, longest match first. An exact `pathname` comparison meant a
   * nested route lit nothing at all: drilling into a station under
   * `/workstation/…` left the whole rail looking inactive, as did the old
   * mismatch where the nav pointed at `/iso` while the Menu navigated to
   * `/builder` — a path that wasn't in the registry, so the rail fell through
   * to 'menu' the entire time the user was in the Builder.
   */
  const currentRoute =
    location.pathname === '/'
      ? 'menu'
      : [...ROUTES]
          .filter((r) => r.path !== '/')
          .sort((a, b) => b.path.length - a.path.length)
          .find(
            (r) =>
              location.pathname === r.path || location.pathname.startsWith(`${r.path}/`),
          )?.id ?? 'menu';

  // Settings is rendered separately, pinned to the bottom.
  const mainRoutes = ROUTES.filter((r) => r.kind === 'main' && r.id !== 'settings');

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
            stroke={SW_COLORS.paper}
            strokeWidth="2.4"
            strokeLinecap="square"
            strokeDasharray="2 2"
          />
          <path
            d="M9 9 Q9 16 23 16 Q23 23 9 23"
            stroke={SW_COLORS.paper}
            strokeWidth="2.4"
            fill="none"
            strokeLinecap="square"
          />
        </svg>
      </div>

      {/* Factory + scenario pill. Full name on hover; a brand dot signals that
          a scenario — not the canonical twin — is active. */}
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
        {mainRoutes.map((r) => (
          <NavTile
            key={r.id}
            route={r}
            active={currentRoute === r.id}
            onNavigate={() => navigate(r.path)}
          />
        ))}
      </div>

      {/* Settings — pinned to the bottom. */}
      <div style={{ borderTop: `1px solid ${alpha(SW_COLORS.paper, 0.08)}`, padding: '8px 6px 10px' }}>
        <NavTile
          route={ROUTES.find((r) => r.id === 'settings')!}
          active={currentRoute === 'settings'}
          onNavigate={() => navigate('/settings')}
        />
      </div>
    </div>
  );
}

interface NavTileProps {
  route: RouteDef;
  active: boolean;
  onNavigate: () => void;
}

/** One row in the rail: icon + tiny label, with the active surface marked by a
 *  brand bar bleeding off the left edge. */
function NavTile({ route, active, onNavigate }: NavTileProps) {
  return (
    <button
      type="button"
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={route.label}
      title={route.label}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = alpha(SW_COLORS.paper, 0.03);
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
      style={{
        width: '100%',
        background: active ? alpha(SW_COLORS.paper, 0.08) : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '8px 0 6px',
        color: active ? SW_COLORS.brand : alpha(SW_COLORS.paper, 0.8),
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
      <span
        style={{
          textAlign: 'center',
          whiteSpace: 'nowrap',
          maxWidth: SIDEBAR_WIDTH - 8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {route.shortLabel ?? route.label}
      </span>
    </button>
  );
}
