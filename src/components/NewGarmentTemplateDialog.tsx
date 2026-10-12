import { useState, type CSSProperties } from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { Button } from './Button';
import { HudSelect } from './HudSelect';
import { NumberInput } from './NumberInput';
import type { GarmentTemplate, GarmentClass } from '../domain/garments';
import type { Operation, OperationCategory } from '../domain/operations';
import type { MachineCode } from '../domain/machines';
import type { SkillId } from '../domain/workers';

/**
 * Create a custom garment template from a quick form plus an operations
 * textarea, and hand it back to the caller to persist.
 *
 * This is the only way to author a NEW garment in the app — the operation
 * bulletin editor in Resources can revise an existing template's rows but
 * cannot bring one into existence. It used to live inside the Orders wizard,
 * which meant creating a garment required starting a production order you did
 * not want; when that wizard was deleted the dialog moved here so Resources,
 * which already owns garments, could host it directly.
 */

const GARMENT_CLASS_OPTIONS: GarmentClass[] = ['top', 'bottom', 'dress', 'outerwear', 'accessory'];

const MACHINE_OPTIONS: MachineCode[] = [
  'SNL', 'DNL', '4OL', '5OL', 'FL', 'FB', 'KS',
  'BH', 'BS', 'BT', 'EMB',
  'CUT', 'CAD', 'SPR', 'FUSE', 'PRESS', 'STEAM', 'INSP', 'MNL',
];

const MACHINE_TO_SKILL: Record<MachineCode, SkillId> = {
  SNL: 'stitching', DNL: 'stitching',
  '4OL': 'overlock', '5OL': 'overlock',
  FL: 'flatlock', FB: 'feed_of_arm', KS: 'kansai',
  BH: 'buttonhole', BS: 'button_sew', BT: 'bartack', EMB: 'embroidery',
  CUT: 'cutting_manual', CAD: 'cutting_cad', SPR: 'spreading',
  FUSE: 'fusing', PRESS: 'pressing', STEAM: 'pressing', INSP: 'inspection',
  MNL: 'bundling',
};

const MACHINE_TO_CATEGORY: Record<MachineCode, OperationCategory> = {
  SNL: 'sewing', DNL: 'sewing', '4OL': 'sewing', '5OL': 'sewing',
  FL: 'sewing', FB: 'sewing', KS: 'sewing',
  BH: 'sewing', BS: 'sewing', BT: 'sewing',
  EMB: 'embroidery',
  CUT: 'cutting', CAD: 'cutting', SPR: 'spreading',
  FUSE: 'fusing', PRESS: 'pressing', STEAM: 'pressing',
  INSP: 'inspection', MNL: 'manual',
};

/** Parse the operations textarea. Accepts `Name | SMV | Machine` per line.
 *  Trailing whitespace and blank lines are skipped. Missing SMV falls back to
 *  0.30; missing / unknown machine falls back to SNL (the apparel workhorse). */
function parseOpsText(text: string, slug: string): Operation[] {
  const machineSet = new Set<MachineCode>(MACHINE_OPTIONS);
  return text
    .split('\n')
    .map((line) => line.trim())
    // Skip blank lines and `#`-prefixed comments so the placeholder hint
    // doesn't accidentally become 3 ghost operations.
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line, i) => {
      const parts = line.split('|').map((p) => p.trim());
      const name = parts[0] || `Operation ${i + 1}`;
      const smvRaw = parts[1] !== undefined ? parseFloat(parts[1]) : NaN;
      const smv = Number.isFinite(smvRaw) && smvRaw > 0 ? smvRaw : 0.3;
      const machRaw = (parts[2] || 'SNL').toUpperCase();
      const machineCode: MachineCode = machineSet.has(machRaw as MachineCode)
        ? (machRaw as MachineCode)
        : 'SNL';
      const code = `OP-${String(i + 1).padStart(2, '0')}`;
      return {
        id: `${slug}-${String(i + 1).padStart(2, '0')}`,
        code,
        name,
        smv: Math.round(smv * 1000) / 1000,
        machineCode,
        skill: MACHINE_TO_SKILL[machineCode],
        category: MACHINE_TO_CATEGORY[machineCode],
      };
    });
}

/** Slugify a free-form name into a stable id suffix. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'garment';
}

const OPS_PLACEHOLDER = [
  '# One operation per line: Name | SMV (min) | Machine',
  '# e.g. Care label attach | 0.12 | SNL',
  '#      Shoulder joint    | 0.30 | 4OL',
  'Care label attach | 0.12 | SNL',
  'Front & back match | 0.15 | MNL',
  'Shoulder joint | 0.30 | 4OL',
  'Neck rib join | 0.32 | 4OL',
  'Side seam | 0.70 | 4OL',
  'Body hem | 0.33 | FL',
].join('\n');

export interface NewGarmentTemplateDialogProps {
  onCancel: () => void;
  onCreate: (g: GarmentTemplate) => void;
}

export function NewGarmentTemplateDialog({ onCancel, onCreate }: NewGarmentTemplateDialogProps) {
  const [name, setName] = useState('');
  const [klass, setKlass] = useState<GarmentClass>('top');
  const [description, setDescription] = useState('');
  const [bestFor, setBestFor] = useState('');
  const [bundleSize, setBundleSize] = useState(30);
  const [opsText, setOpsText] = useState(OPS_PLACEHOLDER);

  const trimmedName = name.trim();
  const slug = slugify(trimmedName);
  const parsedOps = parseOpsText(opsText, slug);
  const totalSmv = parsedOps.reduce((s, o) => s + o.smv, 0);
  const canSave = trimmedName.length > 0 && parsedOps.length > 0;

  function handleSave() {
    if (!canSave) return;
    const id = `custom-${slug}-${Date.now().toString(36).slice(-5)}`;
    const garment: GarmentTemplate = {
      id,
      name: trimmedName,
      class: klass,
      description: description.trim() || `${trimmedName} — custom bulletin.`,
      operations: parsedOps,
      defaultBundleSize: Math.max(1, Math.min(200, Math.round(bundleSize) || 30)),
      totalSmv,
      hourlyTarget100:
        parsedOps.length > 0 ? Math.round(60 / (totalSmv / parsedOps.length)) : 0,
      bestFor: bestFor.trim() || 'Custom orders.',
    };
    onCreate(garment);
  }

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${SW_COLORS.line}`,
    borderRadius: SW_RADIUS.sm,
    background: SW_COLORS.paper,
    fontFamily: SW_FONTS.body,
    fontSize: 13,
    color: SW_COLORS.ink,
  };
  const labelStyle: CSSProperties = {
    fontFamily: SW_FONTS.mono,
    fontSize: 10,
    fontWeight: 800,
    color: SW_COLORS.muted,
    letterSpacing: '1px',
    marginBottom: 4,
  };

  return (
    <div
      role="dialog"
      aria-label="Create new garment template"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: SW_COLORS.overlay,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)',
          maxHeight: '92vh',
          background: SW_COLORS.paper,
          borderRadius: 8,
          border: `1px solid ${SW_COLORS.line}`,
          boxShadow: '0 18px 50px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
          }}
        >
          <div style={{ ...SW_TYPE.heading, letterSpacing: '0.1em' }}>
            ✦ NEW GARMENT TEMPLATE
          </div>
          <div style={{ fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
            Custom bulletin · saved to this project
          </div>
        </div>

        <div style={{ padding: '16px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, overflowY: 'auto' }}>
          <label style={{ gridColumn: '1 / 2' }}>
            <div style={labelStyle}>NAME</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Henley L/S" style={inputStyle} />
          </label>
          <label style={{ gridColumn: '2 / 3' }}>
            <div style={labelStyle}>CLASS</div>
            <HudSelect
              value={klass}
              onChange={(v) => setKlass(v as GarmentClass)}
              variant="light"
              width="100%"
              options={GARMENT_CLASS_OPTIONS.map((c) => ({ value: c, label: c }))}
            />
          </label>

          <label style={{ gridColumn: '1 / 3' }}>
            <div style={labelStyle}>DESCRIPTION</div>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description — what's this garment?" style={inputStyle} />
          </label>

          <label style={{ gridColumn: '1 / 2' }}>
            <div style={labelStyle}>BEST FOR</div>
            <input value={bestFor} onChange={(e) => setBestFor(e.target.value)} placeholder="When to pick this template" style={inputStyle} />
          </label>
          <label style={{ gridColumn: '2 / 3' }}>
            <div style={labelStyle}>DEFAULT BUNDLE</div>
            <NumberInput
              value={bundleSize} min={1} max={200}
              onChange={(v) => setBundleSize(v ?? 0)}
              style={{ ...inputStyle, fontFamily: SW_FONTS.mono, fontWeight: 700 }}
            />
          </label>

          <label style={{ gridColumn: '1 / 3' }}>
            <div style={labelStyle}>
              OPERATIONS · one per line · <span style={{ fontWeight: 600, opacity: 0.7 }}>Name | SMV | Machine</span>
            </div>
            <textarea
              value={opsText}
              onChange={(e) => setOpsText(e.target.value)}
              rows={10}
              spellCheck={false}
              style={{ ...inputStyle, fontFamily: SW_FONTS.mono, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
            />
            <div style={{ marginTop: 6, fontFamily: SW_FONTS.mono, fontSize: 11, color: SW_COLORS.muted }}>
              Machine codes: {MACHINE_OPTIONS.join(' · ')}
            </div>
          </label>

          <div
            style={{
              gridColumn: '1 / 3',
              padding: 10,
              background: SW_COLORS.paperDeep,
              borderRadius: SW_RADIUS.sm,
              display: 'flex',
              gap: 16,
              fontFamily: SW_FONTS.mono,
              fontSize: 11,
              color: SW_COLORS.muted,
              flexWrap: 'wrap',
            }}
          >
            <span>parsed <b style={{ color: SW_COLORS.ink }}>{parsedOps.length}</b> operations</span>
            <span>total SAM <b style={{ color: SW_COLORS.ink }}>{totalSmv.toFixed(2)}</b> min</span>
            <span>≈ <b style={{ color: SW_COLORS.ink }}>{parsedOps.length > 0 ? Math.round(60 / (totalSmv / parsedOps.length)) : 0}</b> pcs/hr @ 100%</span>
            {!canSave && (
              <span style={{ color: SW_COLORS.brand, fontWeight: 800 }}>
                {trimmedName.length === 0 ? 'Name required · ' : ''}
                {parsedOps.length === 0 ? 'At least 1 op required' : ''}
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: `1px solid ${SW_COLORS.line}`,
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" icon="✦" onClick={handleSave} disabled={!canSave}>
            Create template
          </Button>
        </div>
      </div>
    </div>
  );
}
