import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SideBar } from './shell/SideBar';
import { SW_COLORS, SW_FONTS } from './design/tokens';
import { ErrorBoundary, useToast } from './components';
import { QUOTA_EVENT, type QuotaEventDetail } from './store/persist-storage';
import { useStoresHydrated } from './store/storage/useHydrated';

import { useProject } from './store/project';
import { SimSessionDriver } from './simulation/SimSessionDriver';

import { MenuPage } from './pages/Menu';
import { OrdersPage } from './pages/Orders';
import { LiveSimPage } from './pages/LiveSim';
import { ResourcesPage } from './pages/Resources';
import { SettingsPage } from './pages/Settings';
import { BuilderPage } from './pages/Builder';
import { WorkstationDetailPage } from './pages/WorkstationDetail';
import { InsightsPage } from './pages/Insights';
import { QueueLabPage } from './pages/QueueLab';

/**
 * App shell: sidebar + route outlet. On launch the app opens straight to the
 * home menu (route "/").
 */
export default function App() {
  const location = useLocation();
  const toast = useToast();
  const hydrated = useStoresHydrated();

  // NOTE: there is deliberately no auto-seed here.
  //
  // This used to re-seed a 27-station T-shirt line whenever the workspace was
  // empty, which made "empty" an unreachable state: creating a new factory,
  // or deleting the last station of an existing one, handed control back to
  // this effect and the starter line reappeared on the next render. A new
  // factory must open on a blank floor — `buildStarterLine` is still exported
  // for tests and can be offered as an explicit template, but it must never
  // fire on its own.

  // Boot-time sweep of leftover scratch garments (dvss / asdf / test / etc.).
  // Idempotent — no-op when there's nothing to remove. Logs in dev so it's
  // easy to spot the migration firing.
  useEffect(() => {
    if (!hydrated) return;
    const removed = useProject.getState().purgeTestGarments();
    if (removed > 0 && import.meta.env.DEV) {
      console.info(`[stitchworks] purged ${removed} scratch garment${removed === 1 ? '' : 's'} on boot`);
    }
  }, [hydrated]);

  // Surface localStorage quota failures (dispatched by the persist wrapper)
  // as a visible toast instead of a console-only error.
  useEffect(() => {
    const onQuota = (e: Event) => {
      const detail = (e as CustomEvent<QuotaEventDetail>).detail;
      void detail;
      toast({
        kind: 'error',
        message:
          'Storage is full — your most recent changes could not be saved. '
          + 'Export and remove an old factory to free up space.',
        duration: 8000,
      });
    };
    window.addEventListener(QUOTA_EVENT, onQuota);
    return () => window.removeEventListener(QUOTA_EVENT, onQuota);
  }, [toast]);

  const showSideBar = location.pathname !== '/';

  // Gate the first render until the IndexedDB-backed stores have rehydrated,
  // so the UI never flashes an empty factory while persistence loads.
  if (!hydrated) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          background: SW_COLORS.paperDeep,
          fontFamily: SW_FONTS.body,
        }}
      >
        <div style={{ fontFamily: SW_FONTS.display, fontSize: 22, color: SW_COLORS.brand, letterSpacing: 1 }}>
          STITCHWORKS
        </div>
        <div style={{ fontSize: 12, color: SW_COLORS.muted }}>Loading your factory…</div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'row',
        background: SW_COLORS.paperDeep,
      }}
    >
      {/*
        The simulation clock. Headless, and deliberately mounted here — above
        the router — so playback survives navigation: start a run on the Sim
        screen, walk to Insights, and the same engine is still ticking at the
        same frame. While each page owned its own loop, leaving the page killed
        the run.
      */}
      <SimSessionDriver />
      {showSideBar && <SideBar />}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <ErrorBoundary key={location.pathname} scope="page">
        <Routes>
          <Route path="/" element={<MenuPage />} />

          {/* The four surfaces. */}
          <Route path="/line" element={<BuilderPage />} />
          <Route path="/sim" element={<LiveSimPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/lab" element={<QueueLabPage />} />
          <Route path="/settings" element={<SettingsPage />} />

          {/* Secondary surfaces — reachable from BUILD and from deep links, but
              not top-level destinations. Orders authors demand; Resources holds
              the operation bulletin and the skill matrix. */}
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/resources" element={<ResourcesPage />} />
          {/* One station's queueing detail, drilled into from INSIGHTS. */}
          <Route path="/workstation/:deptId/:wsId" element={<WorkstationDetailPage />} />

          {/* Everything that used to be its own tab now lives inside one of the
              four. Redirects are declared here and nowhere else, so the route
              registry stays a list of real surfaces. */}
          <Route path="/builder" element={<Navigate to="/line" replace />} />
          <Route path="/iso" element={<Navigate to="/line" replace />} />
          <Route path="/dept/:deptId" element={<Navigate to="/line" replace />} />
          <Route path="/assets" element={<Navigate to="/resources" replace />} />
          <Route path="/balance" element={<Navigate to="/insights" replace />} />
          <Route path="/kpi" element={<Navigate to="/insights" replace />} />
          <Route path="/queues" element={<Navigate to="/insights" replace />} />
          <Route path="/queues/analytics" element={<Navigate to="/insights" replace />} />
          <Route path="/scenarios" element={<Navigate to="/insights" replace />} />
          <Route path="/floor" element={<Navigate to="/" replace />} />
          <Route path="/reference" element={<Navigate to="/" replace />} />
          <Route path="/pilot" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}
