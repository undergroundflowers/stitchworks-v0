/**
 * Route registry — every page in Stitchworks is declared here once. The top
 * bar reads from this list to render its nav buttons; the router wires each
 * `path` to its page component. Add a route by extending this array and
 * adding a `<Route>` entry in App.tsx.
 *
 * `kind: 'main'` routes appear in the top-bar nav. `kind: 'special'` routes
 * (currently just the menu/home) are reachable but not rendered as nav buttons.
 */

export type RouteKind = 'main' | 'special';

export interface RouteDef {
  /** URL path */
  path: string;
  /** Stable id used by code; matches the original prototype's route ids. */
  id: string;
  /** Human-readable label for nav UI. */
  label: string;
  /**
   * Abbreviated label for narrow desktop widths (< 1180px). When undefined
   * the full label is used at every width. Keeps the bar from dropping
   * nav items on smaller laptop screens without collapsing to a hamburger.
   */
  shortLabel?: string;
  /** Glyph used in nav UI. */
  icon: string;
  kind: RouteKind;
}

export const ROUTES: RouteDef[] = [
  { path: '/',          id: 'menu',      label: 'MENU',             icon: '⌂', kind: 'special' },
  { path: '/iso',       id: 'iso',       label: 'Factory Builder',  shortLabel: 'Builder',    icon: '◆', kind: 'main' },
  { path: '/sim',       id: 'sim',       label: 'Simulation',       shortLabel: 'Sim',        icon: '▷', kind: 'main' },
  { path: '/insights',  id: 'insights',  label: 'Insights',                                   icon: '◎', kind: 'main' },
  { path: '/balance',   id: 'balance',   label: 'Reports',                                    icon: '⌬', kind: 'main' },
  { path: '/resources', id: 'resources', label: 'Resources',                                  icon: '⊟', kind: 'main' },
  // /kpi is the legacy Reports path. App.tsx redirects it to /balance, which
  // is the merged Reports hub (Performance + Line Balance + Validation tabs).
  { path: '/kpi',       id: 'kpi',       label: 'Reports',                                    icon: '⌬', kind: 'special' },
  // Scenarios is no longer a top-bar tab — it lives inside Reports as the
  // "Scenarios" tab. The /scenarios path stays for deep-links; App.tsx
  // redirects it to /balance?tab=scenarios.
  { path: '/scenarios', id: 'scenarios', label: 'Scenarios',                                  icon: '✦', kind: 'special' },
  // Queue Analysis is no longer a top-bar tab — it lives inside the Builder's
  // Inspector as the per-workstation "Queue analysis" section. The /queues
  // route still resolves for deep-links and internal navigations.
  { path: '/queues',    id: 'queues',    label: 'Queue Analysis',   shortLabel: 'Queues',     icon: 'Σ', kind: 'special' },
  { path: '/queues/analytics', id: 'queues-analytics', label: 'Queue Analytics', shortLabel: 'Analytics', icon: '∿', kind: 'special' },
  { path: '/orders',    id: 'orders',    label: 'Orders',                                     icon: '⎙', kind: 'main' },
  { path: '/settings',  id: 'settings',  label: 'Settings',                                   icon: '⚙', kind: 'main' },
];

/**
 * Drill-down routes that don't appear in the top-bar nav. Their paths are
 * parameterised; React Router resolves them to the dedicated pages.
 *
 *   /dept/:deptId               department interior (drill-down from the Builder)
 *   /workstation/:deptId/:wsId  one workstation inside a department
 */
export const DRILL_PATHS = {
  dept:        (deptId: string) => `/dept/${deptId}`,
  workstation: (deptId: string, wsId: string) => `/workstation/${deptId}/${wsId}`,
} as const;

export const ROUTE_BY_ID: Record<string, RouteDef> = Object.fromEntries(
  ROUTES.map((r) => [r.id, r]),
);
