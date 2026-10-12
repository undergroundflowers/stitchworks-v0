/**
 * Authoring dialog for a user-authored station type.
 *
 * The three palette sections that used to ship fixed — sewing fixtures,
 * materials handling, operators — are gone, and this is what replaced them.
 * It asks the three questions a station has to answer before it can go on a
 * floor and into a run:
 *
 *   what it is to the simulation   → the PML block kind, which then decides
 *                                    which parameter fields exist below it
 *   what it looks like             → form + footprint (ISO), mark + code (2D)
 *   what it starts as              → the parameter defaults it drops with
 *
 * Both previews are drawn by the real functions — `StationGlyph` for the plan
 * and the type's own `fixtureForStationType(...).draw()` for the isometric —
 * so the dialog cannot show something the canvas would then draw differently.
 */

import { useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { HudSelect } from './HudSelect';
import { NumberInput } from './NumberInput';
import { StationGlyph } from './StationGlyph';
import { BlockParamRow } from './queueParamFields';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { glyphMark } from '../domain/machine-glyphs';
import { fixtureForStationType, FLAT_CELL } from '../domain/iso';
import {
  DEFAULT_STATION_GROUP,
  STATION_FORMS,
  STATION_GLYPHS,
  newStationTypeId,
  normalizeStationType,
  type StationType,
} from '../domain/stationTypes';
import { apparelLabelForKind } from '../domain/apparelPresets';
import type { StationArt } from '../domain/station-art';
import { readStationArtFile } from '../lib/import-station-svg';
import {
  PARAM_FIELDS_BY_KIND,
  SELECTABLE_BLOCK_KINDS,
  PML_BLOCK_LIBRARY,
  getBlockParams,
  type ParamFieldSpec,
  type PmlBlockKind,
  type PmlBlockParams,
} from '../domain/pml';

export interface StationTypeDialogProps {
  open: boolean;
  /** The type being edited, or null to author a new one. */
  editing: StationType | null;
  onSave: (type: StationType) => void;
  onCancel: () => void;
}

/** A fresh type, pre-set to the most common thing a user authors: an
 *  operation station one operator works at. */
function blankType(): StationType {
  return {
    id: newStationTypeId(),
    label: '',
    group: DEFAULT_STATION_GROUP,
    form: 'machine',
    glyph: 'seam',
    code: '',
    w: 1,
    d: 2,
    h: 1.4,
    kind: 'Service',
    params: {},
    createdAt: new Date().toISOString(),
  };
}

const label: React.CSSProperties = {
  fontFamily: SW_FONTS.body,
  fontSize: 12,
  fontWeight: 500,
  color: SW_COLORS.muted,
  display: 'block',
  marginBottom: 4,
};

const input: React.CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  fontSize: 13,
  fontFamily: SW_FONTS.body,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
  background: SW_COLORS.paper,
  color: SW_COLORS.ink,
};

/**
 * One artwork slot: pick an `.svg`, or clear the one already there.
 *
 * The two slots are independent on purpose — the plan view and the isometric
 * view are looked at for different reasons, and a drawing that reads well
 * top-down rarely reads well in three-quarter. An empty slot is not a gap:
 * it falls back to the authored Form / Mark, which is what most types want.
 */
function ArtSlot({
  title,
  hint,
  art,
  onSet,
}: {
  title: string;
  hint: string;
  art: StationArt | undefined;
  onSet: (art: StationArt | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const res = await readStationArtFile(file);
    setBusy(false);
    if (res.ok) {
      setError(null);
      onSet(res.art);
    } else {
      setError(res.error);
    }
  };

  return (
    <div
      style={{
        border: `1px dashed ${art ? SW_COLORS.brand : SW_COLORS.line}`,
        borderRadius: SW_RADIUS.sm,
        padding: 8,
        background: art ? SW_COLORS.brandLite : 'transparent',
      }}
    >
      <div style={{ ...label, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 10, color: SW_COLORS.muted, marginBottom: 6 }}>{hint}</div>

      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        style={{ display: 'none' }}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          // Cleared so re-picking the same file after an edit still fires.
          e.target.value = '';
        }}
      />

      {art ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            title={art.name}
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              color: SW_COLORS.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {art.name}
          </span>
          <button type="button" style={artBtn} onClick={() => fileRef.current?.click()}>
            Replace
          </button>
          <button
            type="button"
            style={artBtn}
            onClick={() => {
              setError(null);
              onSet(undefined);
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <button
          type="button"
          style={{ ...artBtn, width: '100%', height: 28 }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? 'Reading…' : 'Upload SVG'}
        </button>
      )}

      {error && (
        <div style={{ marginTop: 6, fontSize: 10, color: SW_COLORS.alarm, lineHeight: 1.4 }}>{error}</div>
      )}
    </div>
  );
}

const artBtn: React.CSSProperties = {
  height: 24,
  padding: '0 8px',
  fontFamily: SW_FONTS.body,
  fontSize: 11,
  cursor: 'pointer',
  color: SW_COLORS.ink,
  background: SW_COLORS.paper,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
};

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ ...SW_TYPE.kicker, fontSize: 9, color: SW_COLORS.muted, marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function StationTypeDialog({
  open,
  editing,
  onSave,
  onCancel,
}: StationTypeDialogProps) {
  // Keyed remount by the dialog's caller is not guaranteed, so the draft is
  // seeded from `editing` whenever the identity it was seeded from changes.
  const [draft, setDraft] = useState<StationType>(() => editing ?? blankType());
  const [seededFrom, setSeededFrom] = useState<string | null>(editing?.id ?? null);
  const seedKey = editing?.id ?? (open ? 'new' : null);
  if (open && seedKey !== seededFrom) {
    setDraft(editing ?? blankType());
    setSeededFrom(seedKey);
  }

  const patch = (p: Partial<StationType>) => setDraft((d) => ({ ...d, ...p }));

  const fields: ParamFieldSpec[] = PARAM_FIELDS_BY_KIND[draft.kind] ?? [];
  // Resolved through the same helper the engine and Inspector use, so an
  // untouched field shows the value the station would actually run with.
  const resolved = getBlockParams({ catalogId: draft.id, block: { kind: draft.kind, params: draft.params } });

  const preview = useMemo(() => fixtureForStationType(normalizeStationType(draft)), [draft]);
  const isBlock = draft.form === 'block';

  const setParam = (id: keyof PmlBlockParams, raw: number) => {
    const stored = id === 'passProb' ? raw / 100 : raw;
    patch({ params: { ...draft.params, [id]: stored } });
  };

  // A type with no name would land in the palette as an unclickable blank.
  const canSave = draft.label.trim().length > 0;

  // Plan preview, capped so a 6-cell-wide type still fits the panel.
  const planScale = Math.min(1, 150 / (Math.max(draft.w, draft.d) * FLAT_CELL));
  const planW = Math.max(24, draft.w * FLAT_CELL * planScale);
  const planH = Math.max(24, draft.d * FLAT_CELL * planScale);

  return (
    <Dialog
      open={open}
      width={720}
      title={editing ? 'Edit station type' : 'New station type'}
      confirmLabel={editing ? 'Save type' : 'Create type'}
      onConfirm={() => canSave && onSave(normalizeStationType(draft))}
      onCancel={onCancel}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 18, alignItems: 'start' }}>
        {/* ── Left: the authoring form ─────────────────────────────────── */}
        <div>
          <Group title="IDENTITY">
            <label style={label} htmlFor="stype-name">Name</label>
            <input
              id="stype-name"
              value={draft.label}
              autoFocus
              placeholder="Inline iron"
              onChange={(e) => patch({ label: e.target.value })}
              style={input}
            />
          </Group>

          <Group title="PROCESS BLOCK">
            <HudSelect
              value={draft.kind}
              onChange={(v) => patch({ kind: v as PmlBlockKind, params: {} })}
              variant="light"
              size="sm"
              width="100%"
              options={SELECTABLE_BLOCK_KINDS.map((k) => ({
                value: k,
                label: `${apparelLabelForKind(k)} · ${k}`,
              }))}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: SW_COLORS.muted, lineHeight: 1.45 }}>
              {PML_BLOCK_LIBRARY[draft.kind].blurb}
            </div>
          </Group>

          <Group title="APPEARANCE">
            <label style={label}>Form</label>
            <HudSelect
              value={draft.form}
              onChange={(v) => patch({ form: v as StationType['form'] })}
              variant="light"
              size="sm"
              width="100%"
              options={STATION_FORMS.map((f) => ({ value: f.id, label: f.label }))}
            />
            <div style={{ marginTop: 4, fontSize: 10, color: SW_COLORS.muted }}>
              {STATION_FORMS.find((f) => f.id === draft.form)?.blurb}
            </div>

            {/* A `block` form draws its PML icon instead of a stroke mark, so
                the mark controls have nothing to drive — and uploaded plan
                artwork replaces the mark outright. */}
            {!isBlock && draft.planArt && (
              <div style={{ marginTop: 10, fontSize: 10, color: SW_COLORS.muted }}>
                Mark is replaced by the uploaded 2D artwork below. Remove it to
                go back to a stroke mark.
              </div>
            )}
            {!isBlock && !draft.planArt && (
              <div style={{ marginTop: 10 }}>
                <label style={label}>Mark</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {STATION_GLYPHS.map((g) => {
                    const on = draft.glyph === g.id;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => patch({ glyph: g.id })}
                        title={`${g.label} — ${g.blurb}`}
                        aria-pressed={on}
                        style={{
                          width: 40,
                          height: 34,
                          padding: 0,
                          cursor: 'pointer',
                          background: on ? SW_COLORS.brandLite : SW_COLORS.paper,
                          border: `1px solid ${on ? SW_COLORS.brand : SW_COLORS.line}`,
                          borderRadius: SW_RADIUS.sm,
                        }}
                      >
                        <svg width={38} height={32} style={{ display: 'block' }}>
                          {glyphMark(g.id, 19, 16, 16, SW_COLORS.muted)}
                        </svg>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginTop: 10 }}>
              <div>
                <label style={label} htmlFor="stype-code">Code</label>
                <input
                  id="stype-code"
                  value={draft.code}
                  maxLength={5}
                  placeholder="IRN"
                  onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
                  style={{ ...input, fontFamily: SW_FONTS.mono, fontWeight: 700 }}
                />
              </div>
              {(['w', 'd', 'h'] as const).map((axis) => (
                <div key={axis}>
                  <label style={label} htmlFor={`stype-${axis}`}>
                    {axis === 'w' ? 'Width' : axis === 'd' ? 'Depth' : 'Height'}
                  </label>
                  <NumberInput
                    aria-label={axis === 'w' ? 'Width' : axis === 'd' ? 'Depth' : 'Height'}
                    min={axis === 'h' ? 0.1 : 0.5}
                    step={axis === 'h' ? 0.1 : 0.5}
                    value={draft[axis]}
                    onChange={(v) => { if (v !== undefined) patch({ [axis]: v } as Partial<StationType>); }}
                    style={{ ...input, fontFamily: SW_FONTS.mono, fontWeight: 700 }}
                  />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 4, fontSize: 10, color: SW_COLORS.muted }}>
              Width and depth are floor cells; height is altitude, where a
              sewing machine is 1.4.
            </div>
          </Group>

          <Group title="ARTWORK">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <ArtSlot
                title="2D plan"
                hint="Drawn top-down inside the footprint, in place of the mark."
                art={draft.planArt}
                onSet={(planArt) => patch({ planArt })}
              />
              <ArtSlot
                title="ISO body"
                hint="Drawn in place of the cuboid, standing on the footprint."
                art={draft.isoArt}
                onSet={(isoArt) => patch({ isoArt })}
              />
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: SW_COLORS.muted, lineHeight: 1.45 }}>
              SVG only — it has to scale with the camera and morph between the
              two views. The file needs a viewBox; scripts, external images and
              links are stripped on upload. Draw with{' '}
              <code style={{ fontFamily: SW_FONTS.mono }}>currentColor</code> to
              follow the floor's ink instead of shipping a fixed one.
            </div>
          </Group>

          <Group title={`PARAMETERS · ${draft.kind}`}>
            {fields.length === 0 ? (
              <div style={{ fontSize: 11, color: SW_COLORS.muted, fontStyle: 'italic' }}>
                This block kind takes no authored parameters.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fields.map((f) => (
                  <BlockParamRow
                    key={f.id}
                    field={f}
                    value={f.resolveDefault(resolved)}
                    onSet={(v) => setParam(f.id, v)}
                  />
                ))}
              </div>
            )}
          </Group>
        </div>

        {/* ── Right: what it will look like ────────────────────────────── */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            border: `1px solid ${SW_COLORS.line}`,
            borderRadius: SW_RADIUS.md,
            background: SW_COLORS.paperDeep,
            padding: 12,
          }}
        >
          <div style={{ ...SW_TYPE.kicker, fontSize: 9, color: SW_COLORS.muted, marginBottom: 8 }}>
            PREVIEW
          </div>

          <div style={{ fontSize: 10, color: SW_COLORS.muted, marginBottom: 4 }}>2D · plan</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 96,
              background: alpha(SW_COLORS.ink, 0.04),
              borderRadius: SW_RADIUS.sm,
            }}
          >
            <svg width={planW} height={planH} style={{ display: 'block' }}>
              <StationGlyph
                family={isBlock || draft.planArt ? undefined : draft.glyph}
                art={draft.planArt}
                markCode={isBlock ? undefined : draft.code}
                label={isBlock ? draft.label || 'Block' : undefined}
                width={planW}
                height={planH}
              />
            </svg>
          </div>

          <div style={{ fontSize: 10, color: SW_COLORS.muted, margin: '10px 0 4px' }}>ISO</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 110,
              background: alpha(SW_COLORS.ink, 0.04),
              borderRadius: SW_RADIUS.sm,
            }}
          >
            <svg width={168} height={104} viewBox="-84 -64 168 104" style={{ display: 'block' }}>
              {preview.draw({ w: preview.w, d: preview.d, h: preview.h })}
            </svg>
          </div>

          <div
            style={{
              marginTop: 10,
              fontFamily: SW_FONTS.mono,
              fontSize: 9,
              lineHeight: 1.6,
              color: SW_COLORS.muted,
            }}
          >
            <div>{draft.w} × {draft.d} cells · h {draft.h}</div>
            <div>{draft.kind}</div>
          </div>
        </div>
      </div>

      {!canSave && (
        <div style={{ marginTop: 10, fontSize: 11, color: SW_COLORS.muted, fontStyle: 'italic' }}>
          Give the type a name to save it.
        </div>
      )}
    </Dialog>
  );
}
