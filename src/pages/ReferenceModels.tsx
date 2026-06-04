import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Tag, Button, SectionHeader, HudSelect, useToast } from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS } from '../design/tokens';
import {
  REFERENCE_MODELS,
  type ReferenceModel,
  type ReferenceScenario,
} from '../domain/reference-models';
import {
  buildReferenceTwin,
  compareToPaper,
  type ReferenceRandomness,
  type ReferenceVariant,
  type ValidationRow,
} from '../domain/reference-twin';
import { useTwin } from '../store/twin';
import { useReferenceContext } from '../store/reference';
import { runPmlOnTwin } from '../simulation/pml-runner';

/**
 * Reference Models — sewing lines extracted from the literature.
 *
 * Each card surfaces the paper's case study so you can:
 *   • read the citation + setting + method,
 *   • inspect the operation bulletin the paper used,
 *   • see the baseline vs. proposed KPIs you should be able to reproduce in
 *     Stitchworks once you load the model.
 *
 * The corresponding markdown lives in `Literature/Reference Models/`.
 */
/** Replication / seed / randomness controls shared by every Validate action
 *  on this page. Lifted to page-level so flipping the run mode also re-runs
 *  the same toggles on the per-scenario validate buttons consistently. */
interface RunMode {
  /** Where the per-operation variability comes from. */
  randomness: ReferenceRandomness;
  /** How many independent replications to run per Validate click. */
  replications: number;
  /** Fixed seed → reproducible runs (AnyLogic §15.3). Random seed → unique runs. */
  seedMode: 'fixed' | 'random';
}

const DEFAULT_RUN_MODE: RunMode = {
  randomness: 'paper-fits',
  replications: 5,
  seedMode: 'fixed',
};

export function ReferenceModelsPage() {
  const [selectedSlug, setSelectedSlug] = useState<string>(REFERENCE_MODELS[0].slug);
  const selected = useMemo(
    () => REFERENCE_MODELS.find((m) => m.slug === selectedSlug) ?? REFERENCE_MODELS[0],
    [selectedSlug],
  );
  const [runMode, setRunMode] = useState<RunMode>(DEFAULT_RUN_MODE);

  return (
    <ReferenceModelsView
      selected={selected}
      onSelectSlug={setSelectedSlug}
      runMode={runMode}
      onRunModeChange={setRunMode}
    />
  );
}

/** Inner view — separated so the LOAD-and-simulate strip can sit in the
 *  page hierarchy alongside the two-column grid without bloating the
 *  top-level component. Pure presentation; state still owned by the
 *  parent so url params / persistence can hook in later. */
function ReferenceModelsView({
  selected,
  onSelectSlug,
  runMode,
  onRunModeChange,
}: {
  selected: ReferenceModel;
  onSelectSlug: (s: string) => void;
  runMode: RunMode;
  onRunModeChange: (m: RunMode) => void;
}) {
  const navigate = useNavigate();
  const loadCanonical = useTwin((s) => s.loadCanonical);
  const refCtx = useReferenceContext();
  const setRefContext = useReferenceContext((s) => s.setContext);
  const clearRefContext = useReferenceContext((s) => s.clear);

  // Variant menu derived from the currently-selected paper. Same shape the
  // Sim toolbar used to surface, lifted up here so the page becomes the
  // single home for picking + loading a reference run.
  const variantOptions = useMemo(() => {
    const opts: { key: string; label: string; tag: string }[] = [
      {
        key: 'baseline',
        label: `Baseline · ${selected.baseline.operators} operators${
          selected.baseline.throughputPerDayPcs
            ? ` · ${selected.baseline.throughputPerDayPcs}/day`
            : ''
        }`,
        tag: 'BASE',
      },
    ];
    if (selected.proposed) {
      opts.push({
        key: 'proposed',
        label: `Proposed · ${selected.proposed.operators} operators${
          selected.proposed.throughputPerDayPcs
            ? ` · ${selected.proposed.throughputPerDayPcs}/day`
            : ''
        }`,
        tag: 'PROP',
      });
    }
    if (selected.scenarios) {
      for (const s of selected.scenarios) {
        opts.push({
          key: s.id,
          label: `${s.id} · ${s.name} · ${s.operators} operators · ${s.throughputPerDayPcs}/day (+${s.upliftPct}%)`,
          tag: s.id,
        });
      }
    }
    return opts;
  }, [selected]);

  const [variantKey, setVariantKey] = useState<string>(
    refCtx.slug === selected.slug && refCtx.variantKey ? refCtx.variantKey : 'baseline',
  );

  // Reset variant if the user picks a paper that doesn't have the
  // previously-chosen variant key (e.g. moved from a paper with scenarios
  // to one without).
  useEffect(() => {
    if (!variantOptions.some((o) => o.key === variantKey)) {
      setVariantKey(variantOptions[0].key);
    }
  }, [variantOptions, variantKey]);

  const [loadFlash, setLoadFlash] = useState<string | null>(null);

  function handleLoadAndSimulate() {
    const opts =
      variantKey === 'baseline' || variantKey === 'proposed'
        ? { variant: variantKey as 'baseline' | 'proposed' }
        : { scenarioId: variantKey };
    const twin = buildReferenceTwin(selected, opts);
    if (!twin) {
      setLoadFlash('This paper has no enumerated operations — twin not built.');
      return;
    }
    const r = loadCanonical(twin);
    if (!r.ok) {
      setLoadFlash(`Could not load twin: ${r.reason}`);
      return;
    }
    setRefContext({ slug: selected.slug, variantKey });
    const variantLabel =
      variantKey === 'baseline'
        ? 'Baseline'
        : variantKey === 'proposed'
          ? 'Proposed'
          : variantKey;
    setLoadFlash(`Loaded · ${selected.authorYear} · ${variantLabel}`);
    setTimeout(() => setLoadFlash(null), 1500);
    // Jump to PML view in /sim so the user sees the topology immediately.
    navigate('/sim?view=pml');
  }

  function handleClearReference() {
    clearRefContext();
    setLoadFlash(null);
  }

  const refLoadedLabel =
    refCtx.slug && refCtx.variantKey
      ? (() => {
          const m = REFERENCE_MODELS.find((x) => x.slug === refCtx.slug);
          if (!m) return null;
          const vlabel =
            refCtx.variantKey === 'baseline'
              ? 'Baseline'
              : refCtx.variantKey === 'proposed'
                ? 'Proposed'
                : refCtx.variantKey;
          return `${m.authorYear} · ${vlabel}`;
        })()
      : null;

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        background: SW_COLORS.paperDeep,
        padding: '24px 28px 80px',
      }}
    >
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1320, margin: '0 auto' }}>
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 11,
            fontWeight: 700,
            color: SW_COLORS.brand,
            letterSpacing: '2px',
            textTransform: 'uppercase',
            marginBottom: 6,
          }}
        >
          LITERATURE · CASE STUDIES
        </div>
        <h1
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 36,
            fontWeight: 900,
            margin: 0,
            color: SW_COLORS.ink,
            letterSpacing: '-0.02em',
          }}
        >
          Reference Models
        </h1>
        <p
          style={{
            fontSize: 14,
            color: SW_COLORS.muted,
            marginTop: 8,
            maxWidth: 740,
            lineHeight: 1.55,
          }}
        >
          Sewing-line case studies extracted from peer-reviewed papers in the
          Literature folder. Each one is a real factory line you can rebuild in
          Stitchworks and verify against the paper's published KPIs.
        </p>

        {/* ── LOAD & SIMULATE STRIP ─────────────────────────────────────
            Centralised picker that builds the currently-selected paper's
            twin (baseline / proposed / per-scenario), parks it as the
            active reference context, and jumps to /sim?view=pml so the
            user lands on the topology view ready to run. Lives on this
            page (not in the Sim toolbar) so the Sim chrome stays focused
            on observing; authoring + loading happens here. */}
        <div
          style={{
            marginTop: 18,
            padding: '12px 16px',
            border: `1px solid ${SW_COLORS.line}`,
            background: SW_COLORS.paper,
            borderRadius: SW_RADIUS.md,
            boxShadow: '0 1px 0 rgba(0,0,0,0.02)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              color: SW_COLORS.brand,
              fontFamily: SW_FONTS.mono,
              fontWeight: 800,
              fontSize: 10,
              letterSpacing: '2px',
            }}
          >
            📚 LOAD &amp; SIMULATE
          </span>
          <span style={{ color: SW_COLORS.muted, fontFamily: SW_FONTS.body, fontSize: 12 }}>
            {selected.authorYear} — {selected.title}
          </span>
          <div style={{ flex: '0 0 auto' }}>
            <HudSelect
              value={variantKey}
              onChange={setVariantKey}
              minWidth={320}
              variant="light"
              options={variantOptions.map((o) => ({
                value: o.key,
                label: o.label,
                tag: o.tag,
              }))}
            />
          </div>
          <Button variant="primary" size="sm" icon="▶" onClick={handleLoadAndSimulate}>
            LOAD &amp; SIMULATE
          </Button>
          {refLoadedLabel && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                border: `1px solid ${SW_COLORS.brand}55`,
                background: `${SW_COLORS.brand}12`,
                borderRadius: SW_RADIUS.sm,
                fontFamily: SW_FONTS.mono,
                fontSize: 11,
                fontWeight: 700,
                color: SW_COLORS.brand,
                letterSpacing: '1px',
              }}
            >
              ACTIVE · {refLoadedLabel}
              <button
                onClick={handleClearReference}
                title="Clear reference context"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: SW_COLORS.brand,
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </div>
          )}
          {loadFlash && (
            <span
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 11,
                fontWeight: 700,
                color: SW_COLORS.ok,
              }}
            >
              ✓ {loadFlash}
            </span>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '360px 1fr',
            gap: 18,
            marginTop: 24,
            alignItems: 'start',
          }}
        >
          {/* ── LEFT: paper list ─────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                fontFamily: SW_FONTS.mono,
                fontSize: 10,
                fontWeight: 700,
                color: SW_COLORS.muted,
                letterSpacing: '1.5px',
                marginBottom: 2,
              }}
            >
              {REFERENCE_MODELS.length} MODELS
            </div>
            {REFERENCE_MODELS.map((m) => (
              <PaperListCard
                key={m.slug}
                model={m}
                selected={m.slug === selected.slug}
                onSelect={() => onSelectSlug(m.slug)}
              />
            ))}
          </div>

          {/* ── RIGHT: selected model detail ─────────────────────────── */}
          <ModelDetail model={selected} runMode={runMode} onRunModeChange={onRunModeChange} />
        </div>
      </div>
    </div>
  );
}

// ── List card ───────────────────────────────────────────────────────────────
function PaperListCard({
  model,
  selected,
  onSelect,
}: {
  model: ReferenceModel;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Card
      hover
      onClick={onSelect}
      padding={14}
      accent={selected ? SW_COLORS.brand : undefined}
      style={{
        borderColor: selected ? SW_COLORS.brand : SW_COLORS.line,
        background: selected ? `${SW_COLORS.brand}08` : SW_COLORS.paper,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            color: SW_COLORS.muted,
            letterSpacing: '1px',
          }}
        >
          {model.authorYear.toUpperCase()}
        </span>
        <Tag soft color={SW_COLORS.brand}>{model.operationCount} OPERATIONS</Tag>
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 14,
          fontWeight: 800,
          color: SW_COLORS.ink,
          lineHeight: 1.25,
          marginBottom: 4,
        }}
      >
        {model.title}
      </div>
      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.4 }}>
        {model.garment} · {model.baseline.operators} operators
      </div>
    </Card>
  );
}

// ── Detail panel ────────────────────────────────────────────────────────────
function ModelDetail({
  model,
  runMode,
  onRunModeChange,
}: {
  model: ReferenceModel;
  runMode: RunMode;
  onRunModeChange: (next: RunMode) => void;
}) {
  const total = model.garmentTemplate.totalSmv;
  const sumOps = model.garmentTemplate.operations.length;
  const toast = useToast();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Headline card */}
      <Card padding={20}>
        <div
          style={{
            fontFamily: SW_FONTS.mono,
            fontSize: 10,
            fontWeight: 700,
            color: SW_COLORS.brand,
            letterSpacing: '2px',
            marginBottom: 4,
          }}
        >
          {model.authorYear.toUpperCase()}
        </div>
        <h2
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 26,
            fontWeight: 900,
            margin: 0,
            color: SW_COLORS.ink,
            letterSpacing: '-0.01em',
          }}
        >
          {model.title}
        </h2>
        <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 8, lineHeight: 1.5 }}>
          {model.citation}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 14,
            marginTop: 18,
          }}
        >
          <Field label="Garment"  value={model.garment} />
          <Field label="Setting"  value={model.setting} />
          <Field label="Method"   value={model.method} />
          <Field
            label="Bulletin"
            value={
              sumOps === 0
                ? `${model.operationCount} operations · synthetic placeholder (see file)`
                : `${sumOps} operations · total SMV ${total.toFixed(2)} min`
            }
          />
        </div>

        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: SW_RADIUS.sm,
            background: `${SW_COLORS.brand}0c`,
            border: `1px solid ${SW_COLORS.brand}30`,
            fontSize: 12,
            lineHeight: 1.55,
            color: SW_COLORS.ink,
          }}
        >
          <strong>Why this model.</strong> {model.pitch}
        </div>
      </Card>

      {/* Baseline vs proposed */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <KpiCard title="BASELINE" subtitle="as reported" kpis={model.baseline} accent={SW_COLORS.muted} />
        <KpiCard
          title="PROPOSED"
          subtitle={model.proposed ? "after method" : "—"}
          kpis={model.proposed ?? null}
          accent={SW_COLORS.brand}
        />
      </div>

      {/* Operations table */}
      <Card padding={0} style={{ overflow: 'hidden' }}>
        <SectionHeader title="Operation bulletin" sub={`${sumOps} operations · total ${total.toFixed(2)} min`} />
        {sumOps === 0 ? (
          <div style={{ padding: 18, fontSize: 12, color: SW_COLORS.muted, fontStyle: 'italic' }}>
            This paper does not enumerate the {model.operationCount} operations in its
            bulletin. The folder {model.literaturePath.replace('model.md', 'operations.json')} has a
            synthetic placeholder; load that to scaffold the line, then override SMVs with
            field-collected data.
          </div>
        ) : (
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: SW_COLORS.paperDeep, zIndex: 1 }}>
                <tr>
                  <Th>#</Th>
                  <Th>Operation</Th>
                  <Th align="right">SMV</Th>
                  <Th>Machine</Th>
                  <Th>Skill</Th>
                </tr>
              </thead>
              <tbody>
                {model.garmentTemplate.operations.map((op, i) => (
                  <tr key={op.id} style={{ borderTop: `1px solid ${SW_COLORS.line}` }}>
                    <Td><span style={{ fontFamily: SW_FONTS.mono, color: SW_COLORS.muted }}>{i + 1}</span></Td>
                    <Td>
                      <div style={{ fontWeight: 600, color: SW_COLORS.ink }}>{op.name}</div>
                      {op.notes && (
                        <div style={{ fontSize: 10, color: SW_COLORS.muted, marginTop: 2, fontStyle: 'italic' }}>
                          {op.notes}
                        </div>
                      )}
                    </Td>
                    <Td align="right">
                      <span style={{ fontFamily: SW_FONTS.mono, fontWeight: 700 }}>{op.smv.toFixed(3)}</span>
                    </Td>
                    <Td>
                      <Tag soft color={SW_COLORS.steel}>{op.machineCode}</Tag>
                    </Td>
                    <Td><span style={{ fontSize: 11, color: SW_COLORS.muted }}>{op.skill}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Run mode (randomness / replications / seed) */}
      <RunModeCard runMode={runMode} onChange={onRunModeChange} />

      {/* Build + validate */}
      <BuildAndValidateCard model={model} runMode={runMode} />

      {/* Per-scenario validation (only for multi-scenario papers like Kursun) */}
      {model.scenarios && model.scenarios.length > 0 && (
        <ScenariosCard model={model} runMode={runMode} />
      )}

      {/* Action footer */}
      <Card padding={16}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 12, color: SW_COLORS.muted, maxWidth: 560 }}>
            Full markdown writeup, citations and per-paper JSON in
            <code style={{ fontFamily: SW_FONTS.mono, fontSize: 11, marginLeft: 4 }}>
              {model.literaturePath}
            </code>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              try {
                navigator.clipboard?.writeText(
                  JSON.stringify(model.garmentTemplate, null, 2),
                );
                toast({ kind: 'success', message: 'Garment template JSON copied — paste into garments.ts to register it.' });
              } catch {
                toast({ kind: 'info', message: 'Could not copy automatically. Open the model.md / operations.json files in the Literature folder.' });
              }
            }}
          >
            COPY TEMPLATE JSON
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Run mode card ───────────────────────────────────────────────────────────
// Surfaces the AnyLogic randomness controls Stitchworks now mirrors:
//   • Per-operation cycle distribution (paper fits / deterministic / synthetic)
//   • Source inter-arrival (constant vs. exponential Poisson)
//   • Replications + seed mode (fixed for reproducible runs vs. random)
//
// Reference: Big Book of Simulation Modelling Ch. 15 — Randomness in AnyLogic
// models. Section 15.2 (sources of randomness in Process models) and
// Section 15.3 (RNG, fixed seed vs. random seed) are the parts this UI mirrors.
function RunModeCard({
  runMode,
  onChange,
}: {
  runMode: RunMode;
  onChange: (next: RunMode) => void;
}) {
  return (
    <Card padding={16} accent={SW_COLORS.steel}>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          color: SW_COLORS.steel,
          letterSpacing: '2px',
          marginBottom: 4,
        }}
      >
        RUN MODE · STOCHASTIC ENGINE
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 18,
          fontWeight: 800,
          color: SW_COLORS.ink,
          letterSpacing: '-0.01em',
        }}
      >
        Randomness controls
      </div>
      <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4, lineHeight: 1.5 }}>
        Mirrors AnyLogic's randomness section (Big Book Ch. 15). Stochastic mode
        parses the paper's fitted distributions out of each operation's notes
        and samples a fresh value per agent — Source becomes Poisson, Service
        becomes TRIA / NORM / WEIB / BETA / LOGN / ERLA per op.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr',
          gap: 14,
          marginTop: 14,
        }}
      >
        <RunModeField label="Per-operation cycle">
          <SegmentedControl
            value={runMode.randomness}
            options={[
              { value: 'paper-fits',    label: 'Paper fits' },
              { value: 'synthetic',     label: '±25 % TRIA' },
              { value: 'deterministic', label: 'Mean SMV' },
            ]}
            onChange={(v) => onChange({ ...runMode, randomness: v as ReferenceRandomness })}
          />
        </RunModeField>
        <RunModeField label="Replications">
          <SegmentedControl
            value={String(runMode.replications)}
            options={[
              { value: '1',  label: '1' },
              { value: '5',  label: '5' },
              { value: '10', label: '10' },
              { value: '25', label: '25' },
            ]}
            onChange={(v) => onChange({ ...runMode, replications: Number(v) })}
          />
        </RunModeField>
        <RunModeField label="Seed mode">
          <SegmentedControl
            value={runMode.seedMode}
            options={[
              { value: 'fixed',  label: 'Fixed (reproducible)' },
              { value: 'random', label: 'Random (unique)' },
            ]}
            onChange={(v) => onChange({ ...runMode, seedMode: v as 'fixed' | 'random' })}
          />
        </RunModeField>
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 11,
          color: SW_COLORS.muted,
          fontFamily: SW_FONTS.mono,
          lineHeight: 1.5,
        }}
      >
        {runMode.randomness === 'deterministic'
          ? 'Deterministic — every operation runs at its mean SMV. Source on a constant interval. No queue variance; matches the pre-randomness baseline.'
          : runMode.randomness === 'paper-fits'
            ? 'Paper fits — Stitchworks reads each operation\'s StatFit-style notes and samples accordingly. Falls back to a ±25 % triangular if no fit is present.'
            : 'Synthetic — every operation gets a ±25 % triangular around its mean SMV, regardless of what the paper published.'}
      </div>
    </Card>
  );
}

function RunModeField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          color: SW_COLORS.muted,
          letterSpacing: '1.5px',
          marginBottom: 6,
        }}
      >
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        overflow: 'hidden',
        background: SW_COLORS.paper,
      }}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '1px',
              padding: '7px 12px',
              border: 'none',
              borderLeft: i > 0 ? `1px solid ${SW_COLORS.line}` : 'none',
              background: active ? SW_COLORS.ink : SW_COLORS.paper,
              color: active ? SW_COLORS.paper : SW_COLORS.muted,
              cursor: 'pointer',
            }}
          >
            {o.label.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

// ── Build + inline-validate panel ────────────────────────────────────────────
function BuildAndValidateCard({ model, runMode }: { model: ReferenceModel; runMode: RunMode }) {
  const navigate = useNavigate();
  const loadCanonical = useTwin((s) => s.loadCanonical);
  const createScenarioFromCanonical = useTwin((s) => s.createScenarioFromCanonical);
  const setActiveScenario = useTwin((s) => s.setActiveScenario);

  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [validation, setValidation] = useState<{
    variant: ReferenceVariant;
    rows: ValidationRow[];
    throughputPerHr: number;
    throughputStdPerHr: number;
    throughputCi95PerHr: number;
    bottleneckName: string | null;
    replications: number;
    seeds: number[];
    randomness: ReferenceRandomness;
    seedMode: RunMode['seedMode'];
    availabilityPct: number | undefined;
  } | null>(null);

  const opsAvailable = model.garmentTemplate.operations.length > 0;

  /** Load BOTH variants into the twin store: canonical = baseline, then
   *  fork a scenario for each what-if (proposed and any per-scenario forks).
   *  Navigates to the Builder when done. */
  function handleBuildAndOpen() {
    const baseline = buildReferenceTwin(model, {
      variant: 'baseline',
      randomness: runMode.randomness,
    });
    if (!baseline) {
      setStatus('This paper has no enumerated operations — cannot build a twin yet.');
      return;
    }
    const r = loadCanonical(baseline);
    if (!r.ok) {
      setStatus(`Failed to load baseline twin: ${r.reason}`);
      return;
    }
    setStatus(null);

    // Helper that creates a scenario, then overwrites its twin payload with
    // the supplied build (so the operator pool reflects the paper's count
    // instead of mirroring the canonical baseline).
    function forkAsScenario(twin: ReturnType<typeof buildReferenceTwin>, name: string, notes: string) {
      if (!twin) return;
      const id = createScenarioFromCanonical({ name, notes, activate: false });
      useTwin.setState((s) => ({
        ...s,
        scenarios: s.scenarios.map((scn) =>
          scn.id === id
            ? { ...scn, twin: { ...twin, isCanonical: false, parentTwinId: s.canonical.id } }
            : scn,
        ),
      }));
    }

    // Multi-scenario papers (Kursun): fork one Stitchworks scenario per
    // published what-if so the user can flip between S1/S2/S3 in the
    // Builder's scenario picker.
    if (model.scenarios && model.scenarios.length > 0) {
      model.scenarios.forEach((s) => {
        forkAsScenario(
          buildReferenceTwin(model, { scenarioId: s.id, randomness: runMode.randomness }),
          `${s.id} — ${s.name} (${s.operators} ops)`,
          `Paper scenario ${s.id}: ${s.description} Paper-reported ${s.throughputPerDayPcs} pcs/day (+${s.upliftPct} %).`,
        );
      });
    } else if (model.proposed) {
      // Single-scenario fallback: just fork "Proposed".
      forkAsScenario(
        buildReferenceTwin(model, { variant: 'proposed', randomness: runMode.randomness }),
        `Proposed (${model.proposed.operators} ops)`,
        `Auto-built proposed variant from ${model.authorYear}.`,
      );
    }

    setActiveScenario(null);
    navigate('/builder');
  }

  /** Run N independent replications of the chosen variant and compute mean
   *  throughput plus the standard deviation across replications and a 95 %
   *  confidence interval on the mean (half-width = 1.96·σ/√N). Honours the
   *  page-level Run Mode — randomness, replication count, seed mode.
   *
   *  AnyLogic Ch. 15.2 "Sources of randomness" recommends exactly this
   *  Monte-Carlo treatment for any stochastic model: run multiple seeds,
   *  treat the across-replication spread as your noise estimate. */
  function handleRunValidation(variant: ReferenceVariant) {
    const twin = buildReferenceTwin(model, { variant, randomness: runMode.randomness });
    if (!twin) {
      setStatus('This paper has no enumerated operations — cannot validate yet.');
      return;
    }
    const replications = Math.max(1, runMode.replications);
    setRunning(true);
    setStatus(`Running ${replications} replication${replications === 1 ? '' : 's'}…`);

    // The engine is fast enough that running N seeds inline (no worker) is
    // imperceptible for a 21-op line. setTimeout 0 lets the spinner paint.
    const kpis = variant === 'proposed' && model.proposed ? model.proposed : model.baseline;
    const availability = (kpis.availabilityPct ?? 100) / 100;
    setTimeout(() => {
      const result = runReplications({
        twin,
        replications,
        seedMode: runMode.seedMode,
        availability,
      });
      const rows = compareToPaper({
        model,
        variant,
        observed: {
          throughputPerHr: result.mean,
          operatorsConfigured: kpis.operators,
          totalSmvMin: model.garmentTemplate.totalSmv,
          shiftMin: 480,
        },
      });
      setValidation({
        variant,
        rows,
        throughputPerHr: result.mean,
        throughputStdPerHr: result.std,
        throughputCi95PerHr: result.ci95,
        bottleneckName: result.bottleneck,
        replications,
        seeds: result.seeds,
        randomness: runMode.randomness,
        seedMode: runMode.seedMode,
        availabilityPct: kpis.availabilityPct,
      });
      setStatus(null);
      setRunning(false);
    }, 0);
  }

  if (!opsAvailable) {
    return (
      <Card padding={16}>
        <div style={{ fontSize: 12, color: SW_COLORS.muted, fontStyle: 'italic' }}>
          This paper has no enumerated ops — Stitchworks cannot auto-build the
          twin yet. Once <code>operations.json</code> is filled in for
          {' '}<code>{model.literaturePath.replace('model.md', 'operations.json')}</code>,
          the Build + Validate actions will appear here.
        </div>
      </Card>
    );
  }

  return (
    <Card padding={18} accent={SW_COLORS.brand}>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          color: SW_COLORS.brand,
          letterSpacing: '2px',
          marginBottom: 4,
        }}
      >
        BUILD + VALIDATE
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 18,
          fontWeight: 800,
          color: SW_COLORS.ink,
          letterSpacing: '-0.01em',
        }}
      >
        Reproduce this paper in Stitchworks
      </div>
      <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4, lineHeight: 1.5 }}>
        One click materialises the {model.garmentTemplate.operations.length}-op
        bulletin into a runnable twin (Source → ops → Sink, operator pool sized
        to the paper). Run replications inline to verify our engine lands within
        ±5 % of the paper's KPIs.
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          marginTop: 14,
          alignItems: 'center',
        }}
      >
        <Button variant="primary" onClick={handleBuildAndOpen}>
          ◆ BUILD IN FACTORY BUILDER
        </Button>
        <Button
          variant="ghost"
          disabled={running}
          onClick={() => handleRunValidation('baseline')}
        >
          {running && validation?.variant !== 'proposed' ? '⏳' : '▶'}
          {' '}VALIDATE BASELINE
        </Button>
        {model.proposed && (
          <Button
            variant="ghost"
            disabled={running}
            onClick={() => handleRunValidation('proposed')}
          >
            {running && validation?.variant === 'proposed' ? '⏳' : '▶'}
            {' '}VALIDATE PROPOSED
          </Button>
        )}
        {status && (
          <span style={{ fontSize: 11, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono }}>
            {status}
          </span>
        )}
      </div>

      {validation && (
        <ValidationResult
          model={model}
          variant={validation.variant}
          rows={validation.rows}
          throughputPerHr={validation.throughputPerHr}
          throughputStdPerHr={validation.throughputStdPerHr}
          throughputCi95PerHr={validation.throughputCi95PerHr}
          bottleneckName={validation.bottleneckName}
          replications={validation.replications}
          randomness={validation.randomness}
          seedMode={validation.seedMode}
          availabilityPct={validation.availabilityPct}
        />
      )}
    </Card>
  );
}

// ── Replication harness ─────────────────────────────────────────────────────
// Runs N independent sims against the same twin and reports the across-rep
// mean, sample standard deviation, and a 95 % CI on the mean. This is the
// AnyLogic "Monte Carlo simulation" pattern from Big Book Ch. 15 §15.2 —
// the only honest way to report a stochastic-model KPI is mean + spread.

interface ReplicationResult {
  /** Per-replication observed throughput (pieces / hr). */
  perRun: number[];
  /** Across-replication arithmetic mean. */
  mean: number;
  /** Sample standard deviation (n-1 denominator). 0 when replications < 2. */
  std: number;
  /** 95 % CI half-width on the mean (1.96·σ/√N). */
  ci95: number;
  /** First bottleneck observed in any run, or null if all runs had none. */
  bottleneck: string | null;
  /** The seed each replication used — handy for debugging surprising runs. */
  seeds: number[];
}

function runReplications(opts: {
  twin: import('../domain/twin').Twin;
  replications: number;
  seedMode: RunMode['seedMode'];
  /** Steady-state availability (0..1). Engine output is multiplied by this
   *  before being returned so breakdown-aware paper figures compare cleanly
   *  against the otherwise-breakdown-free engine. */
  availability: number;
}): ReplicationResult {
  const { twin, replications, seedMode, availability } = opts;
  const seeds: number[] = [];
  const perRun: number[] = [];
  let bottleneck: string | null = null;

  for (let i = 0; i < replications; i++) {
    // Fixed seed → deterministic stream identical across page reloads.
    // Random seed → unique stream sourced from wall clock + index.
    const seed =
      seedMode === 'fixed'
        ? (1 + i * 2654435761) >>> 0
        : ((Date.now() + i * 7919) | 1) >>> 0;
    seeds.push(seed);
    const r = runPmlOnTwin(twin, { durationMin: 480, seed, samplePeriodMin: 0 });
    perRun.push(r.throughputPerHr * availability);
    if (!bottleneck && r.bottleneckName) bottleneck = r.bottleneckName;
  }

  const n = perRun.length;
  const mean = n > 0 ? perRun.reduce((s, v) => s + v, 0) / n : 0;
  const variance =
    n > 1
      ? perRun.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1)
      : 0;
  const std = Math.sqrt(variance);
  // 95 % CI half-width assuming the across-rep mean is approximately normal
  // (valid for N ≥ 5 by CLT; we report it for smaller N too with a caveat).
  const ci95 = n > 1 ? (1.96 * std) / Math.sqrt(n) : 0;

  return { perRun, mean, std, ci95, bottleneck, seeds };
}

// ── Multi-scenario card ─────────────────────────────────────────────────────
// Shown only for papers that report multiple what-if scenarios (e.g. Kursun
// 2009 with S1/S2/S3). Each row is a one-click validate against that
// scenario's published throughput.
function ScenariosCard({ model, runMode }: { model: ReferenceModel; runMode: RunMode }) {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<
    Record<
      string,
      {
        rows: ValidationRow[];
        throughputPerHr: number;
        throughputStdPerHr: number;
        throughputCi95PerHr: number;
        bottleneckName: string | null;
      } | undefined
    >
  >({});

  if (!model.scenarios || model.scenarios.length === 0) return null;
  const opsAvailable = model.garmentTemplate.operations.length > 0;

  function handleValidateScenario(scenario: ReferenceScenario) {
    if (!opsAvailable) return;
    const twin = buildReferenceTwin(model, {
      scenarioId: scenario.id,
      randomness: runMode.randomness,
    });
    if (!twin) return;
    setRunning(scenario.id);
    const replications = Math.max(1, runMode.replications);

    // Scenarios are post-rebalance variants (the headline scenario *is* the
    // paper's "proposed"). Inherit proposed's availability so reinforcement
    // wins land near the paper, not under the slower baseline derating.
    const availability =
      (model.proposed?.availabilityPct ?? model.baseline.availabilityPct ?? 100) / 100;
    setTimeout(() => {
      const result = runReplications({
        twin,
        replications,
        seedMode: runMode.seedMode,
        availability,
      });
      const rows = compareToPaper({
        model,
        variant: 'proposed',
        scenarioId: scenario.id,
        observed: {
          throughputPerHr: result.mean,
          operatorsConfigured: scenario.operators,
          totalSmvMin: model.garmentTemplate.totalSmv,
          shiftMin: 480,
        },
      });
      setResults((prev) => ({
        ...prev,
        [scenario.id]: {
          rows,
          throughputPerHr: result.mean,
          throughputStdPerHr: result.std,
          throughputCi95PerHr: result.ci95,
          bottleneckName: result.bottleneck,
        },
      }));
      setRunning(null);
    }, 0);
  }

  return (
    <Card padding={18} accent={SW_COLORS.thread}>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          color: SW_COLORS.thread,
          letterSpacing: '2px',
          marginBottom: 4,
        }}
      >
        WHAT-IF SCENARIOS · {model.scenarios.length} STEPS
      </div>
      <div
        style={{
          fontFamily: SW_FONTS.display,
          fontSize: 18,
          fontWeight: 800,
          color: SW_COLORS.ink,
          letterSpacing: '-0.01em',
        }}
      >
        Iterative debottlenecking — replicate each step
      </div>
      <div style={{ fontSize: 12, color: SW_COLORS.muted, marginTop: 4, lineHeight: 1.5 }}>
        The paper adds operators at the running bottleneck and reports the
        new daily output each time. Each row below validates Stitchworks'
        throughput against that step's published figure.
      </div>

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {model.scenarios.map((s) => {
          const r = results[s.id];
          const accent = s.isBest ? SW_COLORS.brand : SW_COLORS.thread;
          return (
            <div
              key={s.id}
              style={{
                border: `1px solid ${s.isBest ? SW_COLORS.brand + '50' : SW_COLORS.line}`,
                background: s.isBest ? `${SW_COLORS.brand}06` : SW_COLORS.paper,
                borderRadius: SW_RADIUS.sm,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span
                      style={{
                        fontFamily: SW_FONTS.mono,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '2px',
                        color: accent,
                        padding: '2px 7px',
                        border: `1px solid ${accent}`,
                        borderRadius: 4,
                      }}
                    >
                      {s.id}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 14, color: SW_COLORS.ink }}>
                      {s.name}
                    </span>
                    {s.isBest && <Tag soft color={SW_COLORS.brand}>HEADLINE</Tag>}
                  </div>
                  <div style={{ fontSize: 12, color: SW_COLORS.muted, lineHeight: 1.45 }}>
                    {s.description}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 14,
                      fontFamily: SW_FONTS.mono,
                      fontSize: 11,
                      color: SW_COLORS.muted,
                    }}
                  >
                    <span>
                      <strong style={{ color: SW_COLORS.ink }}>{s.operators}</strong> operators
                    </span>
                    <span>
                      <strong style={{ color: SW_COLORS.ink }}>{s.throughputPerDayPcs}</strong> pcs/day (paper)
                    </span>
                    <span style={{ color: '#1a8a3f' }}>+{s.upliftPct} % vs. baseline</span>
                    {s.reinforcedOpIndices && (
                      <span>reinforced operations: {s.reinforcedOpIndices.join(', ')}</span>
                    )}
                  </div>
                </div>
                <Button
                  variant={s.isBest ? 'primary' : 'ghost'}
                  disabled={running !== null || !opsAvailable}
                  onClick={() => handleValidateScenario(s)}
                >
                  {running === s.id ? '⏳' : '▶'} VALIDATE {s.id}
                </Button>
              </div>

              {r && (
                <ScenarioResultRow
                  scenario={s}
                  rows={r.rows}
                  observedPerHr={r.throughputPerHr}
                  observedStdPerHr={r.throughputStdPerHr}
                  observedCi95PerHr={r.throughputCi95PerHr}
                  bottleneckName={r.bottleneckName}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ScenarioResultRow({
  scenario,
  rows,
  observedPerHr,
  observedStdPerHr,
  observedCi95PerHr,
  bottleneckName,
}: {
  scenario: ReferenceScenario;
  rows: ValidationRow[];
  observedPerHr: number;
  observedStdPerHr: number;
  observedCi95PerHr: number;
  bottleneckName: string | null;
}) {
  const gatingRows = rows.filter((r) => !r.informational);
  const throughputRow = rows.find((r) => r.label === 'Throughput');
  const ok = gatingRows.every((r) => r.withinTolerance);
  const tone = ok ? '#1a8a3f' : SW_COLORS.thread;
  const observedPerDay = Math.round(observedPerHr * 8);
  const stdPerDay = Math.round(observedStdPerHr * 8);
  const ci95PerDay = Math.round(observedCi95PerHr * 8);
  const deltaPct = throughputRow?.deltaPct ?? 0;
  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px dashed ${SW_COLORS.line}`,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        alignItems: 'center',
        fontFamily: SW_FONTS.mono,
        fontSize: 11,
      }}
    >
      <span
        style={{
          fontWeight: 700,
          letterSpacing: '1.5px',
          color: tone,
        }}
      >
        {ok ? '✓ WITHIN ±5 %' : '⚠ DRIFTED'}
      </span>
      <span style={{ color: SW_COLORS.muted }}>
        paper <strong style={{ color: SW_COLORS.ink }}>{scenario.throughputPerDayPcs}</strong>
      </span>
      <span style={{ color: SW_COLORS.muted }}>
        stitchworks <strong style={{ color: SW_COLORS.ink }}>{observedPerDay}</strong> ± {stdPerDay} pcs/day
        {ci95PerDay > 0 && (
          <span style={{ color: SW_COLORS.muted }}> · CI±{ci95PerDay}</span>
        )}
      </span>
      <span style={{ color: tone, fontWeight: 700 }}>
        {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)} %
      </span>
      {bottleneckName && (
        <span style={{ color: SW_COLORS.muted }}>⚠ bottleneck: {bottleneckName}</span>
      )}
    </div>
  );
}

// ── Validation result table ──────────────────────────────────────────────────
function ValidationResult({
  model,
  variant,
  rows,
  throughputPerHr,
  throughputStdPerHr,
  throughputCi95PerHr,
  bottleneckName,
  replications,
  randomness,
  seedMode,
  availabilityPct,
}: {
  model: ReferenceModel;
  variant: ReferenceVariant;
  rows: ValidationRow[];
  throughputPerHr: number;
  throughputStdPerHr: number;
  throughputCi95PerHr: number;
  bottleneckName: string | null;
  replications: number;
  randomness: ReferenceRandomness;
  seedMode: RunMode['seedMode'];
  availabilityPct: number | undefined;
}) {
  // Verdict is computed from gating rows only — informational rows (line
  // efficiency, where each paper uses its own formula) are shown for context
  // but never trip the ✓/✗ flag.
  const gatingRows = rows.filter((r) => !r.informational);
  const allWithin = gatingRows.every((r) => r.withinTolerance);
  const informationalNote = rows.find((r) => r.informational && r.noteWhy)?.noteWhy;
  const headlineColor = allWithin ? '#1a8a3f' : SW_COLORS.thread;
  const variantLabel = variant === 'proposed' ? 'Proposed' : 'Baseline';
  const cvPct = throughputPerHr > 0 ? (throughputStdPerHr / throughputPerHr) * 100 : 0;
  const randomnessLabel =
    randomness === 'deterministic'
      ? 'Deterministic mean SMV'
      : randomness === 'paper-fits'
        ? 'Paper-fitted distributions'
        : 'Synthetic ±25 % triangular';

  return (
    <div
      style={{
        marginTop: 16,
        padding: 14,
        borderRadius: SW_RADIUS.sm,
        background: SW_COLORS.paperDeep,
        border: `1px solid ${SW_COLORS.line}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 10,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: headlineColor,
              letterSpacing: '2px',
            }}
          >
            {allWithin ? '✓ WITHIN ±5 %' : '⚠ DRIFTED'} · {variantLabel.toUpperCase()}
          </div>
          <div
            style={{
              fontFamily: SW_FONTS.display,
              fontSize: 16,
              fontWeight: 800,
              color: SW_COLORS.ink,
              marginTop: 2,
            }}
          >
            {model.authorYear} replication ({replications} seeds, 480 min/shift)
          </div>
        </div>
        <div style={{ fontSize: 11, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono }}>
          mean {throughputPerHr.toFixed(1)} ± {throughputStdPerHr.toFixed(1)} pcs/hr
          {throughputCi95PerHr > 0 && (
            <> · 95 % CI ±{throughputCi95PerHr.toFixed(1)}</>
          )}
          {cvPct > 0 && <> · CV {cvPct.toFixed(1)} %</>}
          {bottleneckName && <> · ⚠ bottleneck: {bottleneckName}</>}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 10,
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          letterSpacing: '1px',
        }}
      >
        <Pill label="DIST" value={randomnessLabel} />
        <Pill label="SEED" value={seedMode === 'fixed' ? 'Fixed · reproducible' : 'Random · unique'} />
        <Pill label="N" value={`${replications} replication${replications === 1 ? '' : 's'}`} />
        {availabilityPct !== undefined && (
          <Pill
            label="AVAIL"
            value={`${availabilityPct} % · sub-engine effects applied`}
          />
        )}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <Th>KPI</Th>
            <Th align="right">Paper</Th>
            <Th align="right">Stitchworks</Th>
            <Th align="right">Δ %</Th>
            <Th>Within ±5 %</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tone = r.informational
              ? SW_COLORS.muted
              : r.withinTolerance
                ? '#1a8a3f'
                : SW_COLORS.thread;
            return (
              <tr key={r.label} style={{ borderTop: `1px solid ${SW_COLORS.line}` }}>
                <Td>
                  <span style={{ fontWeight: 700, color: SW_COLORS.ink }}>{r.label}</span>
                  {r.informational && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontFamily: SW_FONTS.mono,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '1.5px',
                        color: SW_COLORS.muted,
                        padding: '2px 6px',
                        border: `1px solid ${SW_COLORS.line}`,
                        borderRadius: 3,
                      }}
                    >
                      INFO
                    </span>
                  )}
                </Td>
                <Td align="right">
                  <span style={{ fontFamily: SW_FONTS.mono }}>
                    {r.paper.toLocaleString()} {r.unit}
                  </span>
                </Td>
                <Td align="right">
                  <span style={{ fontFamily: SW_FONTS.mono, fontWeight: 700 }}>
                    {typeof r.observed === 'number' ? r.observed.toLocaleString() : r.observed} {r.unit}
                  </span>
                </Td>
                <Td align="right">
                  <span style={{ fontFamily: SW_FONTS.mono, color: tone, fontWeight: 700 }}>
                    {r.deltaPct >= 0 ? '+' : ''}
                    {r.deltaPct.toFixed(1)} %
                  </span>
                </Td>
                <Td>
                  <span style={{ color: tone, fontWeight: 700, fontFamily: SW_FONTS.mono }}>
                    {r.informational ? '—' : r.withinTolerance ? '✓' : '✗'}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 10, fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.55 }}>
        {randomness === 'deterministic'
          ? 'Deterministic mode: every operation runs at its mean SMV with a constant arrival interval. Use this baseline to isolate layout / operator-pool problems before turning on stochastic service.'
          : randomness === 'paper-fits'
            ? 'Stochastic mode: Stitchworks samples each operation\'s cycle from the paper\'s fitted distribution (StatFit notes parsed at build time) and uses exponential Poisson arrivals at the Source. The σ above is the across-replication spread; the 95 % CI is a Monte-Carlo bound on the mean — drift outside the CI means a true model mismatch, not just RNG noise.'
            : 'Synthetic mode: every operation runs through a ±25 % triangular around its mean SMV (AnyLogic\'s default Service shape, Big Book Ch. 15.1). Use this when the paper does not publish per-op fits.'}
      </div>
      {informationalNote && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            borderLeft: `2px solid ${SW_COLORS.line}`,
            fontSize: 11,
            color: SW_COLORS.muted,
            lineHeight: 1.55,
            fontStyle: 'italic',
          }}
        >
          <strong style={{ fontStyle: 'normal' }}>INFO row:</strong> {informationalNote}
        </div>
      )}
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: 4,
      }}
    >
      <span style={{ color: SW_COLORS.muted, fontWeight: 700 }}>{label}</span>
      <span style={{ color: SW_COLORS.ink, fontWeight: 700, letterSpacing: 0 }}>{value}</span>
    </span>
  );
}

// ── tiny atoms ──────────────────────────────────────────────────────────────
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          color: SW_COLORS.muted,
          letterSpacing: '1px',
          marginBottom: 3,
        }}
      >
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: SW_COLORS.ink, lineHeight: 1.4 }}>
        {value}
      </div>
    </div>
  );
}

function KpiCard({
  title,
  subtitle,
  kpis,
  accent,
}: {
  title: string;
  subtitle: string;
  kpis: { operators: number; throughputPerDayPcs?: number; throughputPerShiftPcs?: number; lineEfficiencyPct?: number; notes?: string } | null;
  accent: string;
}) {
  return (
    <Card padding={16} accent={accent}>
      <div
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 700,
          color: accent,
          letterSpacing: '2px',
          marginBottom: 2,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 11, color: SW_COLORS.muted, marginBottom: 12 }}>{subtitle}</div>
      {!kpis ? (
        <div style={{ fontSize: 12, color: SW_COLORS.muted, fontStyle: 'italic' }}>
          Not reported in this paper.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Metric label="OPERATORS" value={String(kpis.operators)} />
            <Metric
              label="THROUGHPUT"
              value={
                kpis.throughputPerDayPcs
                  ? `${kpis.throughputPerDayPcs} / day`
                  : kpis.throughputPerShiftPcs
                    ? `${kpis.throughputPerShiftPcs} / shift`
                    : '—'
              }
            />
            <Metric
              label="LINE EFF."
              value={kpis.lineEfficiencyPct ? `${kpis.lineEfficiencyPct.toFixed(2)} %` : '—'}
            />
          </div>
          {kpis.notes && (
            <div
              style={{
                marginTop: 10,
                fontSize: 11,
                color: SW_COLORS.muted,
                lineHeight: 1.5,
              }}
            >
              {kpis.notes}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
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
          fontFamily: SW_FONTS.display,
          fontSize: 18,
          fontWeight: 900,
          color: SW_COLORS.ink,
          letterSpacing: '-0.01em',
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        textAlign: align,
        fontFamily: SW_FONTS.mono,
        fontSize: 10,
        fontWeight: 700,
        color: SW_COLORS.muted,
        letterSpacing: '1px',
        padding: '10px 12px',
        borderBottom: `1px solid ${SW_COLORS.line}`,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td style={{ padding: '8px 12px', textAlign: align, verticalAlign: 'top' }}>{children}</td>
  );
}
