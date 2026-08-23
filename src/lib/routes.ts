/**
 * Route registry — the app's real surfaces, declared once.
 *
 * Five of them, deliberately:
 *
 *   BUILD     author the line
 *   RUN       watch it run
 *   INSIGHTS  find out what's wrong and fix it
 *   LAB       build any queueing system and analyse it, factory or not
 *   SETTINGS  project + units
 *
 * The array used to hold twelve entries for six tabs, because every
 * redirect-only path was declared here too. Redirects now live only in
 * `App.tsx`'s <Routes>; this list is what the sidebar renders, nothing more.
 */

export type RouteKind = 'main' | 'special';

export interface RouteDef {
  /** URL path */
  path: string;
  /** Stable id used by code. */
  id: string;
  /** Human-readable label for nav UI. */
  label: string;
  /** Abbreviated label for narrow desktop widths. Undefined ⇒ use `label`. */
  shortLabel?: string;
  /** Glyph used in nav UI. */
  icon: string;
  kind: RouteKind;
}

export const ROUTES: RouteDef[] = [
  { path: '/',          id: 'menu',      label: 'MENU',     icon: '⌂', kind: 'special' },
  { path: '/line',      id: 'line',      label: 'Build',    icon: '◆', kind: 'main' },
  { path: '/sim',       id: 'sim',       label: 'Run',      icon: '▷', kind: 'main' },
  { path: '/insights',  id: 'insights',  label: 'Insights', icon: '◎', kind: 'main' },
  { path: '/lab',       id: 'lab',       label: 'Queue Lab', shortLabel: 'Lab', icon: '∑', kind: 'main' },
  { path: '/settings',  id: 'settings',  label: 'Settings', icon: '⚙', kind: 'main' },
];

/**
 * Drill-down paths that aren't nav destinations.
 *
 *   /workstation/:deptId/:wsId  one station's queueing detail
 */
export const DRILL_PATHS = {
  workstation: (deptId: string, wsId: string) => `/workstation/${deptId}/${wsId}`,
} as const;

export const ROUTE_BY_ID: Record<string, RouteDef> = Object.fromEntries(
  ROUTES.map((r) => [r.id, r]),
);
