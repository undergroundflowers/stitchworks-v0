/**
 * Route registry — the app's real surfaces, declared once.
 *
 * Six of them, deliberately:
 *
 *   RESOURCES what the factory is made of — operators, machines, the garment
 *             operation libraries and the skill matrix
 *   BUILD     author the line
 *   RUN       watch it run
 *   INSIGHTS  find out what's wrong and fix it
 *   LAB       build any queueing system and analyse it, factory or not
 *   SETTINGS  project + units
 *
 * The array used to hold twelve entries for six tabs, because every
 * redirect-only path was declared here too. Redirects now live only in
 * `App.tsx`'s <Routes>; this list is what the sidebar renders, nothing more.
 *
 * RESOURCES leads the rail because it is upstream of the rest: the other
 * surfaces are verbs on one line, and this is the catalogue every one of them
 * draws from. It used to be declared a drill-down of BUILD, reachable only
 * from an icon in the Builder's top bar (which is still there) — but nothing
 * on it is scoped to a thing you clicked in the Builder, so it lit the wrong
 * tab the whole time you were on it.
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
  { path: '/resources', id: 'resources', label: 'Resources', icon: '▦', kind: 'main' },
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
 *
 * `from` names the INSIGHTS tab the drill started on, so the detail page can
 * offer a back link that lands where the user actually was. Without it "back"
 * can only mean the surface, not the view — and INSIGHTS opens on Diagnosis,
 * two tabs away from either table that drills in here.
 */
export const DRILL_PATHS = {
  workstation: (deptId: string, wsId: string, from?: string) =>
    `/workstation/${deptId}/${wsId}${from ? `?from=${encodeURIComponent(from)}` : ''}`,
} as const;

/**
 * Which rail tab owns a path that isn't itself a rail destination.
 *
 * The sidebar highlights by longest-prefix match over ROUTES, and a drill-down
 * matches nothing there — so standing on a station detail lit up MENU, telling
 * the user they had left the analysis surface when they had only gone deeper
 * into it. Longest prefix first; `startsWith` is checked against the raw path.
 */
export const DRILL_PARENTS: ReadonlyArray<readonly [prefix: string, routeId: string]> = [
  ['/workstation/', 'insights'],
] as const;

export const ROUTE_BY_ID: Record<string, RouteDef> = Object.fromEntries(
  ROUTES.map((r) => [r.id, r]),
);
