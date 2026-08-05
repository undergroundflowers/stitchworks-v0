/**
 * ServiceQueueParams — the Builder's sim-free authoring group for a
 * workstation's queueing parameters.
 *
 * The Factory Builder is for *authoring the model*, so this shows only the
 * editable variables that define how a station behaves as a queue — the
 * service-time distribution + spread, parallel servers (c), buffer capacity
 * (N), and queue discipline — plus an instant Kendall–Lee classification of
 * what those choices add up to. NO simulation runs here; the sim-vs-theory
 * results moved to the Sim view, fed by the real factory run.
 *
 * These params live on the *garment operation*, not the single machine, so a
 * change is shared by every station running that op for this garment. The
 * caption at the bottom says so to keep the semantics honest.
 *
 * Field widgets are shared with QueueAnalysisPanel via `queueParamFields`.
 */

import { type CSSProperties, type ReactNode } from 'react';
import { Card } from './Card';
import { ToggleGroup } from './ToggleGroup';
import { QueueDisciplineGraphic } from './QueueDisciplineGraphic';
import {
  DIST_OPTIONS,
  DISCIPLINE_OPTIONS,
  DistParamInputs,
  NumberField,
  CapacityField,
  DropdownField,
  SubHeader,
  morphDist,
  patchDist,
  type DistKind,
  type DistParams,
} from './queueParamFields';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import { useProject } from '../store/project';
import { useGarments } from '../store/garments';
import { GARMENT_TEMPLATES } from '../domain';
import { classify, type ServiceDist, type QueueDiscipline } from '../simulation';
import type { Workstation } from '../domain/twin';
import type { Operation } from '../domain/operations';

export function ServiceQueueParams({ ws }: { ws: Workstation }) {
  const garments = useGarments();
  const projectSelectedGarmentId = useProject((s) => s.selectedGarmentId);
  const updateOperation = useProject((s) => s.updateOperation);

  const garmentId = ws.operation.garmentId ?? projectSelectedGarmentId;
  const garment = garments.byId[garmentId] ?? garments.all[0];
  const opId = ws.operation.opId;
  const op = garment && opId ? garment.operations.find((o) => o.id === opId) : undefined;

  if (!garment) return <Note>No garment template loaded.</Note>;
  if (!opId) {
    return (
      <Note>
        Not bound to an operation yet. Pick one under <strong>Operation</strong> above to
        configure its service time and queue — and to enable <strong>SIMULATE</strong>.
      </Note>
    );
  }
  if (!op) {
    return (
      <Note>
        Operation <Code>{opId}</Code> isn't in <strong>{garment.name}</strong>'s bulletin. Pick an
        op id that exists in the active garment.
      </Note>
    );
  }

  // Read params straight off the operation — no StationView, no simulation.
  const dist: ServiceDist =
    op.serviceDistribution ?? { kind: 'uniform', mean: op.smv, variance: 0.15 };
  const servers = Math.max(1, Math.round(op.servers ?? 1));
  const capacity = op.queueCapacity != null ? op.queueCapacity : Infinity;
  const discipline: QueueDiscipline = op.queueDiscipline ?? 'FCFS';

  // Classification (not a sim result) — computed instantly from the inputs.
  const notation = classify(dist, servers, capacity, discipline);

  const patchOp = (patch: Partial<Operation>) =>
    updateOperation(garment.id, GARMENT_TEMPLATES[garment.id], opId, patch);

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Kendall chip + plain-English read */}
      <div>
        <div style={chipLabel}>Kendall–Lee classification</div>
        <div style={chipValue}>{notation.label}</div>
        <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4 }}>
          {plainEnglish(servers, capacity, discipline)}
        </div>
      </div>

      {/* Service time */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SubHeader>Service time</SubHeader>
        <ToggleGroup<DistKind>
          value={dist.kind}
          options={DIST_OPTIONS}
          onChange={(kind) => patchOp({ serviceDistribution: morphDist(dist, kind, op.smv) })}
        />
        <DistParamInputs
          dist={dist}
          editable
          onChange={(p: Partial<DistParams>) =>
            patchOp({ serviceDistribution: patchDist(dist, p) })
          }
        />
      </section>

      {/* Servers & queue */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SubHeader>Servers &amp; queue</SubHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <NumberField
            label="Servers (c)"
            value={servers}
            min={1}
            step={1}
            editable
            onChange={(v) => patchOp({ servers: Math.max(1, Math.round(v)) })}
          />
          <CapacityField
            capacity={capacity}
            editable
            onChange={(v) =>
              patchOp({ queueCapacity: v === 'inf' ? undefined : Math.max(1, Math.round(v)) })
            }
          />
          <DropdownField<QueueDiscipline>
            label="Discipline"
            value={discipline}
            options={DISCIPLINE_OPTIONS}
            editable
            onChange={(d) => patchOp({ queueDiscipline: d })}
          />
        </div>
        <QueueDisciplineGraphic discipline={discipline} />
      </section>

      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.45 }}>
        Describes operation <Code>{op.code ?? op.id}</Code> for <strong>{garment.name}</strong> —
        shared by every station running it.
      </div>
    </Card>
  );
}

function plainEnglish(servers: number, capacity: number, discipline: QueueDiscipline): string {
  const ops = servers === 1 ? '1 operator sews' : `${servers} operators sew in parallel`;
  const buffer = Number.isFinite(capacity) ? `buffer holds ${capacity}` : 'unlimited buffer';
  const disc =
    discipline === 'FCFS'
      ? 'first-in first-out'
      : discipline === 'SIRO'
        ? 'served in random order'
        : 'priority order';
  return `Bundles arrive · ${ops} · ${disc} · ${buffer}.`;
}

const chipLabel: CSSProperties = {
  fontFamily: SW_FONTS.mono,
  fontSize: 10,
  color: SW_COLORS.muted,
  letterSpacing: '0.6px',
  textTransform: 'uppercase',
  fontWeight: 700,
  marginBottom: 4,
};

const chipValue: CSSProperties = {
  fontFamily: SW_FONTS.display,
  fontSize: 20,
  fontWeight: 900,
  letterSpacing: '-0.02em',
  color: SW_COLORS.ink,
};

function Note({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: SW_COLORS.muted,
        lineHeight: 1.5,
        padding: 8,
        background: SW_COLORS.paperDeep,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
      }}
    >
      {children}
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: 11,
        background: SW_COLORS.paper,
        padding: '1px 5px',
        borderRadius: 3,
        border: `1px solid ${SW_COLORS.line}`,
      }}
    >
      {children}
    </code>
  );
}
