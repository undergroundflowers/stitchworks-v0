import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SideBar } from './shell/SideBar';
import { SW_COLORS, SW_FONTS } from './design/tokens';
import { ErrorBoundary, useToast } from './components';
import { QUOTA_EVENT, type QuotaEventDetail } from './store/persist-storage';
import { useStoresHydrated } from './store/storage/useHydrated';

import { useTwin } from './store/twin';
import { buildDemoTwin } from './domain/twin';
import { useProject } from './store/project';

import { MenuPage } from './pages/Menu';
import { OrdersPage } from './pages/Orders';
import { LiveSimPage } from './pages/LiveSim';
import { ResourcesPage } from './pages/Resources';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { BuilderPage } from './pages/Builder';
import { WorkstationDetailPage } from './pages/WorkstationDetail';
import { QueueIndexPage } from './pages/QueueIndex';
import { QueueAnalyticsPage } from './pages/QueueAnalytics';

/**
 * App shell: sidebar + route outlet. On launch the app opens straight to the
 * home menu (route "/").
 */
export default function App() {
  const location = useLocation();
  const toast = useToast();
  const hydrated = useStoresHydrated();

  // Seed the canonical twin with the demo factory the first time the app
  // boots into an empty workspace. Existing edits are preserved — we only
  // replace when departments + workstations + scenarios are all empty.
  useEffect(() => {
    if (!hydrated) return;
    const s = useTwin.getState();
    if (
      s.canonical.departments.length === 0 &&
      s.canonical.workstations.length === 0 &&
      s.scenarios.length === 0
    ) {
      s.loadCanonical(buildDemoTwin());
    }
  }, [hydrated]);

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
      {showSideBar && <SideBar />}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <ErrorBoundary key={location.pathname} scope="page">
        <Routes>
          <Route path="/" element={<MenuPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/sim" element={<LiveSimPage />} />
          {/* /balance is the merged Reports hub (performance + line balance +
              validation tabs). The legacy /kpi path redirects here so existing
              links still resolve. */}
          <Route path="/balance" element={<ReportsPage />} />
          {/* Scenarios is now a tab inside Reports. The standalone /scenarios
              URL redirects there so old links and deep-links still resolve. */}
          <Route path="/scenarios" element={<Navigate to="/balance?tab=scenarios" replace />} />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/kpi" element={<Navigate to="/balance" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Factory Builder — single authoring surface for the digital twin.
              Both /iso (legacy nav id) and /builder route here. */}
          <Route path="/builder" element={<BuilderPage />} />
          <Route path="/iso" element={<BuilderPage />} />
          <Route path="/queues" element={<QueueIndexPage />} />
          <Route path="/queues/analytics" element={<QueueAnalyticsPage />} />
          <Route path="/workstation/:deptId/:wsId" element={<WorkstationDetailPage />} />
          {/* Dept interior screen is not yet ported.
              Bounce back to Builder so users don't land on a dead-end stub. */}
          <Route path="/dept/:deptId" element={<Navigate to="/builder" replace />} />
          {/* The asset library was removed with the sewing-lines pivot — a
              queueing tool doesn't author fabric-roll artwork. Land stale
              /assets links on Resources rather than dead-ending. */}
          <Route path="/assets" element={<Navigate to="/resources" replace />} />
          {/* Live Floor, Reference Models and Pilot Study were removed; redirect
              any stale deep-links back to the home menu rather than dead-ending. */}
          <Route path="/floor" element={<Navigate to="/" replace />} />
          <Route path="/reference" element={<Navigate to="/" replace />} />
          <Route path="/pilot" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}
