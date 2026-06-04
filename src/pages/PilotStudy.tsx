/**
 * Pilot Factory 1.0 · Line Replacement Study — wizard entry.
 *
 * The page sets up the real Stitchworks workflow:
 *   1. Archive whatever factory is currently active (user never loses work).
 *   2. Build a fresh Pilot Factory twin where each line carries the FULL
 *      operation bulletin of its garment, with an operator behind every
 *      station and flow connectors chaining the bulletin end-to-end.
 *   3. Build two scenario twins where each line in turn is retooled to the
 *      chosen third product. The retooled line is rebuilt from the new
 *      garment's bulletin — every workstation, operator, and connector.
 *   4. Splice canonical + scenarios into the twin store directly so the
 *      Builder's scenario picker shows them immediately, then route to
 *      Factory Builder so the user sees the real factory.
 *
 * After this, the user runs and compares scenarios through the existing
 * Simulation, Reports, and Scenarios surfaces.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { Card, Button, Tag, SectionHeader, useToast } from '../components';
import {
  buildPilotFactoryTwin,
  buildRetooledPilotTwin,
  describePilotLineSpec,
  PILOT_FACTORY_NAME,
  PILOT_SEED_LINES,
} from '../domain/pilot';
import { ALL_GARMENT_TEMPLATES, type GarmentTemplate } from '../domain';
import { useGarments, useFactoryLibrary, useProject } from '../store';
import { useTwin, TWIN_STORE_SCHEMA_VERSION } from '../store/twin';
import { newScenarioId, type Scenario, type Twin } from '../domain/twin';

// ============================================================================
// PAGE
// ============================================================================

export function PilotStudyPage() {
  const navigate = useNavigate();
  const garments = useGarments();
  const toast = useToast();

  // Preview twin built once — replaced fresh inside `runWizard` so the store
  // gets a new id and timestamp.
  const previewTwin = useMemo<Twin>(() => buildPilotFactoryTwin(), []);

  const usedGarmentIds = useMemo(
    () => new Set(PILOT_SEED_LINES.map((l) => l.garmentId)),
    [],
  );

  const candidateGarments: GarmentTemplate[] = useMemo(
    () =>
      ALL_GARMENT_TEMPLATES
        .filter((g) => !usedGarmentIds.has(g.id))
        .map((g) => garments.byId[g.id] ?? g),
    [garments.byId, usedGarmentIds],
  );

  const [newGarmentId, setNewGarmentId] = useState<string>(
    () => candidateGarments[0]?.id ?? '',
  );

  const [busy, setBusy] = useState(false);

  const newGarment = garments.byId[newGarmentId];

  function runWizard() {
    if (!newGarment) return;
    setBusy(true);
    setTimeout(() => {
      try {
        // 1. Archive the active factory so the user never loses work.
        useFactoryLibrary.getState().archiveCurrent();

        // 2. Build the canonical pilot twin and the two retooled scenario
        //    twins as pure data.
        const now = new Date().toISOString();
        const canonical = buildPilotFactoryTwin(PILOT_SEED_LINES);
        const scenarios: Scenario[] = PILOT_SEED_LINES.map((spec, idx) => {
          const lineIndex = idx as 0 | 1;
          const twin = buildRetooledPilotTwin({
            baseSpecs: PILOT_SEED_LINES,
            lineIndexToReplace: lineIndex,
            newGarmentId: newGarment.id,
            parentTwinId: canonical.id,
          });
          twin.name = `Replace ${spec.name} → ${newGarment.name}`;
          return {
            id: newScenarioId(),
            name: twin.name,
            notes: `Pilot study: ${spec.name} retooled from ${
              garments.byId[spec.garmentId]?.name ?? spec.garmentId
            } to ${newGarment.name}; the other line keeps its original product.`,
            createdAt: now,
            modifiedAt: now,
            twin,
            runs: [],
          };
        });

        // 3. Splice the new state into the twin store. This is the same
        //    mechanism the factory-library "load" action uses, so the Builder
        //    picks up the canonical + scenarios on its next render.
        useTwin.setState({
          schemaVersion: TWIN_STORE_SCHEMA_VERSION,
          canonical,
          scenarios,
          activeScenarioId: null,
        });

        // 4. Sync project metadata so the TopBar reads "Pilot Factory 1.0".
        useProject.getState().rename(PILOT_FACTORY_NAME);

        // 5. Open the Builder.
        navigate('/builder');
      } catch (err) {
        console.error('[pilot] wizard failed', err);
        toast({ kind: 'error', message: `Pilot setup failed: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setBusy(false);
      }
    }, 16);
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        background: SW_COLORS.paperDeep,
        padding: 32,
      }}
    >
      <div style={{ maxWidth: 1240, margin: '0 auto' }}>
        <SectionHeader
          kicker="Pilot Study"
          title={PILOT_FACTORY_NAME}
          sub="A focused two-line sewing department used to study product introductions. Each line is built from the full operation bulletin of its garment, with an operator at every workstation and flow connectors wiring the line end-to-end. Pick a third product and the wizard creates two scenarios — one where each existing line is retooled to make it."
          right={
            <Button variant="secondary" size="sm" onClick={() => navigate('/')}>
              ← Back to menu
            </Button>
          }
        />

        <PilotSchematic twin={previewTwin} garments={garments.byId} />

        <Card padding={20} style={{ marginTop: 20 }}>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: SW_COLORS.brand,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Step 1 · Pick the third product
          </div>
          <div
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 18,
              fontWeight: 900,
              color: SW_COLORS.ink,
              marginBottom: 4,
            }}
          >
            What do you want to introduce?
          </div>
          <div style={{ fontSize: 13, color: SW_COLORS.muted, marginBottom: 16, lineHeight: 1.5 }}>
            Two scenarios will be generated — one where Line 1 is retooled
            (Line 2 keeps Polo), and one where Line 2 is retooled (Line 1
            keeps T-shirt). The retooled line is rebuilt from the new garment's
            full bulletin.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {candidateGarments.map((g) => (
              <GarmentPickerTile
                key={g.id}
                garment={g}
                selected={g.id === newGarmentId}
                onClick={() => setNewGarmentId(g.id)}
              />
            ))}
          </div>
        </Card>

        <Card padding={20} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div
                style={{
                  fontFamily: SW_FONTS.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  color: SW_COLORS.brand,
                  letterSpacing: '1.5px',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                Step 2 · Build it
              </div>
              <div
                style={{
                  fontFamily: SW_FONTS.display,
                  fontSize: 18,
                  fontWeight: 900,
                  color: SW_COLORS.ink,
                  marginBottom: 4,
                }}
              >
                Load Pilot Factory & generate scenarios
              </div>
              <div style={{ fontSize: 12, color: SW_COLORS.muted, lineHeight: 1.5 }}>
                Your current factory is archived to the library first — nothing is lost.
                After setup, the Builder opens with two scenarios in the picker:
                "Replace Line 1 → {newGarment?.name}" and "Replace Line 2 → {newGarment?.name}".
              </div>
            </div>
            <Button
              variant="primary"
              size="lg"
              onClick={runWizard}
              disabled={busy || !newGarment}
              icon={busy ? '⏳' : '▶'}
            >
              {busy ? 'Setting up…' : 'Build & create scenarios'}
            </Button>
          </div>
        </Card>

        <Card padding={20} style={{ marginTop: 14 }}>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: SW_COLORS.muted,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            What happens next
          </div>
          <ol
            style={{
              margin: 0,
              padding: '0 0 0 20px',
              fontSize: 13,
              color: SW_COLORS.ink,
              lineHeight: 1.7,
            }}
          >
            <li>
              <strong>Factory Builder</strong> opens on the pilot factory — one Sewing Department with two full-bulletin PBS lines, operators at every station, and flow connectors between operations.
            </li>
            <li>
              Use the <strong>scenario picker</strong> in the Builder header to switch between baseline and the two replacement scenarios.
            </li>
            <li>
              Open <strong>Simulation</strong> to play each scenario forward — bundles flow along the connectors, operators animate at their stations.
            </li>
            <li>
              Open <strong>Reports</strong> for throughput, efficiency, balance loss, bottleneck. Save runs as Scenarios to compare side-by-side.
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
}

// ============================================================================
// PILOT SCHEMATIC — preview of what we'll build
// ============================================================================

function PilotSchematic({
  twin,
  garments,
}: {
  twin: Twin;
  garments: Record<string, GarmentTemplate>;
}) {
  const sewDept = twin.departments[0];
  return (
    <Card padding={20}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: SW_COLORS.muted,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Preview · {sewDept?.name ?? 'Sewing'}
          </div>
          <div
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 18,
              fontWeight: 900,
              color: SW_COLORS.ink,
            }}
          >
            Two sewing lines · full operation bulletins
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Tag soft color={SW_COLORS.bobbin}>{twin.workstations.length} STATIONS</Tag>
          <Tag soft color={SW_COLORS.brand}>{twin.connectors.length} CONNECTORS</Tag>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {PILOT_SEED_LINES.map((spec, idx) => {
          const d = describePilotLineSpec(spec);
          const g = garments[spec.garmentId];
          const accent = idx === 0 ? SW_COLORS.bobbin : SW_COLORS.brand;
          const line = twin.lines[idx];
          const stationCount = twin.workstations.filter((w) => w.lineId === line?.id).length;
          return (
            <div
              key={spec.name}
              style={{
                borderRadius: SW_RADIUS.md,
                border: `1px solid ${SW_COLORS.line}`,
                background: SW_COLORS.paper,
                padding: 14,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: '0 auto 0 0',
                  width: 4,
                  background: accent,
                }}
              />
              <div style={{ marginLeft: 8 }}>
                <div
                  style={{
                    fontFamily: SW_FONTS.display,
                    fontSize: 15,
                    fontWeight: 900,
                    color: SW_COLORS.ink,
                    marginBottom: 4,
                  }}
                >
                  {spec.name}
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <Tag color={accent}>{d.garmentName}</Tag>
                  <Tag soft color={SW_COLORS.muted}>PBS</Tag>
                </div>
                <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.6 }}>
                  {d.opCount} operations · {stationCount} workstations (incl. operators + buffers)
                </div>
                <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.5, marginTop: 4 }}>
                  Total SAM {d.totalSmv.toFixed(2)} min · 100% target {d.hourlyTarget100} pcs/hr ·
                  {' '}{g?.bestFor}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ============================================================================
// GARMENT PICKER TILE
// ============================================================================

function GarmentPickerTile({
  garment,
  selected,
  onClick,
}: {
  garment: GarmentTemplate;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: '1 1 220px',
        textAlign: 'left',
        padding: 14,
        borderRadius: SW_RADIUS.md,
        border: `2px solid ${selected ? SW_COLORS.brand : SW_COLORS.line}`,
        background: selected ? `${SW_COLORS.brand}10` : SW_COLORS.paper,
        cursor: 'pointer',
        position: 'relative',
        transition: 'border-color 120ms, background 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 14,
            fontWeight: 900,
            color: SW_COLORS.ink,
          }}
        >
          {garment.name}
        </span>
        {selected && <Tag color={SW_COLORS.brand}>SELECTED</Tag>}
      </div>
      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.4, marginBottom: 8 }}>
        {garment.description}
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          color: SW_COLORS.muted,
          display: 'flex',
          gap: 10,
        }}
      >
        <span>SAM {garment.totalSmv.toFixed(2)}m</span>
        <span>·</span>
        <span>{garment.operations.length} ops</span>
        <span>·</span>
        <span>100% · {garment.hourlyTarget100} pcs/hr</span>
      </div>
    </button>
  );
}
