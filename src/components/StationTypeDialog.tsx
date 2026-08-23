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

import { useMemo, useState } from 'react';
import { Dialog } from './Dialog';
import { HudSelect } from './HudSelect';
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
  /** Group names already in use, offered as suggestions. */
  groups: string[];
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
  groups,
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={label} htmlFor="stype-name">Name</label>
                <input
                  id="stype-name"
                  value={draft.label}
                  autoFocus
                  placeholder="Inline iron"
                  onChange={(e) => patch({ label: e.target.value })}
                  style={input}
                />
              </div>
              <div>
                <label style={label} htmlFor="stype-group">Palette section</label>
                <input
                  id="stype-group"
                  value={draft.group}
                  list="stype-groups"
                  placeholder={DEFAULT_STATION_GROUP}
                  onChange={(e) => patch({ group: e.target.value })}
                  style={input}
                />
                <datalist id="stype-groups">
                  {groups.map((g) => <option key={g} value={g} />)}
                </datalist>
              </div>
            </div>
            <div style={{ marginTop: 4, fontSize: 10, color: SW_COLORS.muted }}>
              Types sharing a section name are grouped together in the palette.
            </div>
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
                the mark controls have nothing to drive. */}
            {!isBlock && (
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
                  <input
                    id={`stype-${axis}`}
                    type="number"
                    min={axis === 'h' ? 0.1 : 0.5}
                    step={axis === 'h' ? 0.1 : 0.5}
                    value={draft[axis]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v)) patch({ [axis]: v } as Partial<StationType>);
                    }}
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
                    isAuthored={draft.params[f.id] !== undefined}
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
                family={isBlock ? undefined : draft.glyph}
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
