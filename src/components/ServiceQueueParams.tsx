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
import { FieldLabel, Sym } from './Sym';
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
import {
  classify,
  disciplineFor,
  meanOf,
  serversFor,
  systemCapacityFor,
  type ServiceDist,
  type QueueDiscipline,
} from '../simulation';
import { glossOf } from '../simulation/notation';
import type { Workstation } from '../domain/twin';
import type { Operation } from '../domain/operations';

export function ServiceQueueParams({ ws }: { ws: Workstation }) {
  const garments = useGarments();
  const updateOperation = useProject((s) => s.updateOperation);

  // The station's own binding is the only garment that means anything here.
  // First-in-catalog is the fallback for an unbound station, not a
  // remembered project-wide choice.
  const garmentId = ws.operation.garmentId;
  const garment = (garmentId ? garments.byId[garmentId] : undefined) ?? garments.all[0];
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

  // The EDITABLE values are the operation's — this group authors the shared
  // operation, and the fields below write straight back to it.
  const dist: ServiceDist =
    op.serviceDistribution ?? { kind: 'uniform', mean: op.smv, variance: 0.15 };
  const servers = Math.max(1, Math.round(op.servers ?? 1));
  const capacity = op.queueCapacity != null ? op.queueCapacity : Infinity;
  const discipline: QueueDiscipline = op.queueDiscipline ?? 'FCFS';

  // The EFFECTIVE values are what this station will actually run, resolved
  // through the engine's own functions. They differ from the operation's
  // whenever the station carries a per-station block override — and the
  // classification has to describe the run, not the intent, or the label lies.
  const effServers = serversFor(ws);
  const effCapacity = systemCapacityFor(ws);
  const effDiscipline = disciplineFor(ws);
  const overridden =
    effServers !== servers ||
    effCapacity !== capacity ||
    effDiscipline !== discipline;

  // Classification (not a sim result) — computed instantly from the EFFECTIVE
  // values, so it names the model this station will actually run.
  const notation = classify(dist, effServers, effCapacity, effDiscipline);
  // μ = 60 / mean service time, per the textbook's own conversion.
  const meanServiceMin = meanOf(dist);
  const muPerHr = meanServiceMin > 0 ? 60 / meanServiceMin : 0;

  const patchOp = (patch: Partial<Operation>) =>
    updateOperation(garment.id, GARMENT_TEMPLATES[garment.id], opId, patch);

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Kendall chip + plain-English read + the one derived parameter that
          is pure authoring data. μ follows from the mean service time, so it
          belongs here; λ does not — arrivals depend on what upstream feeds
          this station, which is a property of the run, not of the operation. */}
      <div>
        <div style={chipLabel}>Kendall–Lee classification</div>
        <div style={chipValue}>{notation.label}</div>
        <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4 }}>
          {plainEnglish(servers, capacity, discipline)}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 14,
            marginTop: 8,
            fontFamily: SW_FONTS.mono,
            fontSize: 11,
            color: SW_COLORS.muted,
          }}
        >
          <span title={glossOf('mu')}>
            <Sym quantity="mu" color={SW_COLORS.brandText} /> ={' '}
            <strong style={{ color: SW_COLORS.ink }}>{muPerHr.toFixed(2)}</strong> /hr
          </span>
          <span title={glossOf('servers')}>
            <Sym quantity="servers" color={SW_COLORS.brandText} /> ={' '}
            <strong style={{ color: SW_COLORS.ink }}>{effServers}</strong>
          </span>
          <span title={glossOf('capacity')}>
            <Sym quantity="capacity" color={SW_COLORS.brandText} /> ={' '}
            <strong style={{ color: SW_COLORS.ink }}>
              {Number.isFinite(effCapacity) ? effCapacity : '∞'}
            </strong>
          </span>
        </div>
        {overridden && (
          <div
            style={{
              marginTop: 8,
              padding: '7px 9px',
              background: SW_COLORS.paperDeep,
              border: `1px solid ${SW_COLORS.line}`,
              borderLeft: `3px solid ${SW_COLORS.warn}`,
              borderRadius: SW_RADIUS.sm,
              fontSize: 11,
              color: SW_COLORS.muted,
              lineHeight: 1.45,
            }}
          >
            This station overrides the operation under{' '}
            <strong style={{ color: SW_COLORS.ink }}>Process block</strong> above. The
            classification shows what it will run
            {effServers !== servers ? ` · c ${servers} → ${effServers}` : ''}
            {effCapacity !== capacity
              ? ` · N ${Number.isFinite(capacity) ? capacity : '∞'} → ${Number.isFinite(effCapacity) ? effCapacity : '∞'}`
              : ''}
            {effDiscipline !== discipline ? ` · ${discipline} → ${effDiscipline}` : ''}.
          </div>
        )}
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
            gap: 10,
            // Grid items default to min-content width; the discipline select
            // is wider than its column and would overhang the card without this.
            alignItems: 'end',
          }}
        >
          <NumberField
            label={<FieldLabel quantity="servers" />}
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
            label={<FieldLabel quantity="discipline" />}
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
