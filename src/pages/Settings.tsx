import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { Card, Button, SectionHeader, ToggleGroup, useConfirm } from '../components';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProject, pickProjectFile, isFactoryNameTaken, downloadSwproj, applySwproj, parseSwproj } from '../store';
import { useTwin } from '../store/twin';
import { estimateIdbBytes, isUsingIndexedDb } from '../store/storage/indexedDbStorage';
import { formatDate } from '../lib/format';
import type { UnitsPrefs } from '../store/project';

export function SettingsPage() {
  const navigate = useNavigate();
  const project = useProject();
  const confirm = useConfirm();
  // Storage status for the PROJECT card footer — which backend persistence
  // is using (IndexedDB, or the localStorage fallback) and roughly how much
  // is stored. Fetched once on mount; IndexedDB reads are async.
  const [storageInfo, setStorageInfo] = useState<{ backend: string; kb: number } | null>(null);
  useEffect(() => {
    let alive = true;
    estimateIdbBytes().then((bytes) => {
      if (alive) {
        setStorageInfo({
          backend: isUsingIndexedDb() ? 'IndexedDB' : 'localStorage (fallback)',
          kb: bytes / 1024,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  // Read the twin universe so we can surface the saved scenario forks on
  // the PROJECT card. The PROJECT card is the single landing place where the
  // user inspects + exports the active factory; the Builder used to host an
  // EXPORT JSON button for the same payload — that's been folded in here.
  const canonical = useTwin((s) => s.canonical);
  const scenarios = useTwin((s) => s.scenarios);
  const activeScenarioId = useTwin((s) => s.activeScenarioId);
  const activeTwin =
    activeScenarioId == null
      ? canonical
      : scenarios.find((s) => s.id === activeScenarioId)?.twin ?? canonical;

  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Download the active twin (canonical or scenario fork) as a standalone
  // JSON file. Same payload + filename convention the Builder used.
  function exportActiveTwinJson() {
    const data = JSON.stringify(activeTwin, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(activeTwin.name || 'twin').replace(/[^a-z0-9_-]/gi, '-')}.twin.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Local pending value for the project-name input. Commits to the store
  // on blur or Enter when valid; lets the user keep typing through an
  // invalid intermediate state without snap-back. Re-syncs if the store
  // name changes from elsewhere (e.g. loading a saved factory).
  const [pendingName, setPendingName] = useState(project.meta.name);
  useEffect(() => { setPendingName(project.meta.name); }, [project.meta.name]);
  const trimmedPending = pendingName.trim();
  // The active factory's own name should not flag itself as a duplicate,
  // so we exclude it from the check by short-circuiting when the typed
  // value equals the currently-committed name (case-insensitive).
  const nameUnchanged = trimmedPending.toLowerCase() === project.meta.name.trim().toLowerCase();
  const nameInvalid =
    trimmedPending.length === 0 ||
    (!nameUnchanged && isFactoryNameTaken(trimmedPending));
  const commitName = () => {
    if (nameInvalid) {
      setPendingName(project.meta.name); // snap back on blur if invalid
      return;
    }
    if (!nameUnchanged) project.rename(trimmedPending);
  };

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: 32, background: SW_COLORS.paperDeep }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <SectionHeader
          kicker="Settings"
          title="Factory & project configuration"
          sub={`Last modified ${formatDate(project.meta.modifiedAt, project.units.dateFormat)} · Schema v${project.schemaVersion}`}
        />

        <Card padding={22} style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: SW_FONTS.display, fontSize: 14, fontWeight: 900, marginBottom: 14 }}>PROJECT</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Project name</div>
              <input
                value={pendingName}
                onChange={(e) => setPendingName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
                aria-invalid={nameInvalid || undefined}
                style={{
                  marginTop: 4, width: '100%', padding: '8px 10px',
                  borderRadius: SW_RADIUS.sm,
                  border: `1px solid ${nameInvalid ? SW_COLORS.alarm : SW_COLORS.line}`,
                  fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 700,
                  outline: 'none',
                }}
              />
              {nameInvalid && (
                <div style={{
                  marginTop: 4,
                  fontFamily: SW_FONTS.mono,
                  fontSize: 11,
                  fontWeight: 700,
                  color: SW_COLORS.alarm,
                }}>
                  {trimmedPending.length === 0
                    ? 'Factory name cannot be empty.'
                    : `A saved factory named "${trimmedPending}" already exists. Pick a different name.`}
                </div>
              )}
            </div>
          </div>
          {/* ── SAVED SCENARIOS ────────────────────────────────────────
              Every scenario fork off the canonical twin. Per-row counts
              come from the scenario's own twin payload (a deep clone at
              fork time), so this list stays accurate even after the
              canonical drifts. */}
          {scenarios.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: SW_COLORS.paperDeep,
                border: `1px solid ${SW_COLORS.line}`,
                borderRadius: SW_RADIUS.sm,
              }}
            >
              <div
                style={{
                  fontFamily: SW_FONTS.mono,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: '0.14em',
                  color: SW_COLORS.muted,
                  marginBottom: 8,
                }}
              >
                SAVED SCENARIOS · {scenarios.length}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {scenarios.map((scn) => {
                  const isActive = scn.id === activeScenarioId;
                  return (
                    <div
                      key={scn.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto auto auto auto',
                        alignItems: 'center',
                        gap: 12,
                        padding: '8px 10px',
                        background: SW_COLORS.paper,
                        border: `1px solid ${isActive ? SW_COLORS.brand : SW_COLORS.line}`,
                        borderRadius: SW_RADIUS.sm,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontFamily: SW_FONTS.body,
                            fontSize: 13,
                            fontWeight: 700,
                            color: SW_COLORS.ink,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {scn.name}
                          {isActive && (
                            <span
                              style={{
                                fontFamily: SW_FONTS.mono,
                                fontSize: 9,
                                fontWeight: 800,
                                color: SW_COLORS.brand,
                                letterSpacing: '0.12em',
                                padding: '1px 6px',
                                border: `1px solid ${SW_COLORS.brand}55`,
                                borderRadius: SW_RADIUS.sm,
                              }}
                            >
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontFamily: SW_FONTS.mono,
                            fontSize: 10,
                            color: SW_COLORS.muted,
                            marginTop: 2,
                          }}
                        >
                          Modified {formatDate(scn.modifiedAt, project.units.dateFormat)}
                        </div>
                      </div>
                      <ScenarioCount label="LINES" value={(scn.twin.lines ?? []).length} />
                      <ScenarioCount label="STATIONS" value={scn.twin.workstations.length} />
                      <ScenarioCount label="OPR" value={(scn.twin.operators ?? []).length} />
                      <ScenarioCount label="RUNS" value={scn.runs.length} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
            <Button variant="secondary" icon="⤓" onClick={downloadSwproj}>
              Export .swproj
            </Button>
            <Button
              variant="secondary"
              icon="⤓"
              onClick={exportActiveTwinJson}
            >
              Export twin JSON
            </Button>
            <Button
              variant="secondary"
              icon="⤒"
              onClick={async () => {
                try {
                  const raw = await pickProjectFile();
                  const result = applySwproj(parseSwproj(raw));
                  if (result.ok) {
                    setImportMsg({
                      kind: 'ok',
                      text: result.legacy
                        ? 'Project imported (legacy file — factory layout left unchanged).'
                        : 'Project + factory imported.',
                    });
                  } else {
                    setImportMsg({ kind: 'err', text: result.reason ?? 'Import failed.' });
                  }
                } catch (e) {
                  setImportMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
                }
              }}
            >
              Import .swproj
            </Button>
            <Button
              variant="danger"
              icon="↺"
              onClick={async () => {
                if (await confirm({ title: 'Reset project', message: 'Reset the project? Local changes will be lost.', confirmLabel: 'Reset', variant: 'danger' })) {
                  project.resetProject();
                  setImportMsg({ kind: 'ok', text: 'Project reset.' });
                }
              }}
            >
              Reset project
            </Button>
            {importMsg && (
              <div
                style={{
                  alignSelf: 'center',
                  padding: '6px 10px',
                  borderRadius: SW_RADIUS.sm,
                  background: importMsg.kind === 'ok' ? `${SW_COLORS.ok}20` : `${SW_COLORS.alarm}20`,
                  color: importMsg.kind === 'ok' ? SW_COLORS.ok : SW_COLORS.alarm,
                  fontSize: 12, fontWeight: 700,
                }}
              >
                {importMsg.text}
              </div>
            )}
          </div>
          <div style={{ marginTop: 12, padding: 10, background: SW_COLORS.paperDeep, borderRadius: SW_RADIUS.sm, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.5 }}>
            Project + factory state auto-saves to your browser's local database (<code style={{ fontFamily: SW_FONTS.mono }}>{storageInfo?.backend ?? 'IndexedDB'}</code>{storageInfo ? ` · ~${storageInfo.kb < 1 ? '<1' : Math.round(storageInfo.kb).toLocaleString()} KB used` : ''}) on every change. Use Export to share or back up; Import restores from a <code style={{ fontFamily: SW_FONTS.mono }}>.swproj</code> JSON file.
          </div>
        </Card>

        <Card padding={22} style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: SW_FONTS.display, fontSize: 14, fontWeight: 900, marginBottom: 14 }}>UNITS & FORMAT</div>
          {([
            { k: 'Length',      field: 'length',      opts: ['Meters', 'Yards'] },
            { k: 'SAM display', field: 'samDisplay',  opts: ['Minutes', 'Seconds'] },
            { k: 'Date format', field: 'dateFormat',  opts: ['DD/MM', 'MM/DD', 'YYYY-MM-DD'] },
          ] as const).map((r) => (
            <div key={r.k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderTop: r.k !== 'Length' ? `1px solid ${SW_COLORS.line}` : 'none' }}>
              <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{r.k}</div>
              <ToggleGroup
                value={project.units[r.field]}
                onChange={(v) => project.setUnit(r.field, v as UnitsPrefs[typeof r.field])}
                options={r.opts.map((o) => ({ value: o, label: o }))}
              />
            </div>
          ))}
        </Card>

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={() => navigate('/')}>Back to menu</Button>
          <Button variant="primary" onClick={() => navigate('/line')}>Save</Button>
        </div>
      </div>
    </div>
  );
}

/** Small inline count chip — used in the SAVED SCENARIOS list to surface
 *  per-scenario depth (workstations, operators, runs) without bloating
 *  each row into a multi-line card. */
function ScenarioCount({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          color: SW_COLORS.muted,
          letterSpacing: '1px',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 13,
          fontWeight: 800,
          color: value > 0 ? SW_COLORS.ink : SW_COLORS.faint,
        }}
      >
        {value}
      </div>
    </div>
  );
}
