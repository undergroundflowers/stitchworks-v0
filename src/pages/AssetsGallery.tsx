/**
 * Asset Library — every workstation, worker, and product sprite Stitchworks
 * ships with, plus user-authored customs and overrides. Tabs switch between
 * the three families.
 *
 * The library is editable: click any card to open the inspector drawer on
 * the right, tweak the parameters, and the change persists in the project
 * store. Built-ins clone into an `*Edits` map on first edit (so you can
 * always Reset them); custom assets live alongside under `customMachines /
 * customWorkers / customProducts` and can be deleted outright.
 */

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SectionHeader, Tag, ToggleGroup, Button, HudSelect } from '../components';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import {
  WorkstationSprite,
  WorkerSprite,
  ProductSprite,
  IsoMiniPreview,
  PRODUCT_KINDS,
  type WorkerSpriteStyle,
  type ProductKind,
} from '../assets';
import {
  useProject,
  useMachines,
  useWorkers,
  useProducts,
  type EffectiveMachine,
  type EffectiveWorker,
  type EffectiveProduct,
  type CustomMachineSpec,
  type CustomWorkerArchetype,
  type CustomProductSpec,
} from '../store';
import { MACHINE_CATALOG, type MachineCategory, type MachineCode, type MachineSpec } from '../domain/machines';
import { WORKER_ARCHETYPES, type WorkerArchetype, type WorkerRole, type SkillId } from '../domain/workers';

type Tab = 'workstations' | 'workers' | 'products';

type EditorTarget =
  | { kind: 'machine'; code: string }
  | { kind: 'worker'; role: string }
  | { kind: 'product'; key: string }
  | { kind: 'new-machine' }
  | { kind: 'new-worker' }
  | { kind: 'new-product' }
  | null;

// ── Colour swatches the editor lets the user pick from ───────────────────
const COLOR_SWATCHES = [
  SW_COLORS.brand, SW_COLORS.bobbin, SW_COLORS.fabric, SW_COLORS.thread,
  SW_COLORS.trim, SW_COLORS.press, SW_COLORS.ship, SW_COLORS.alarm,
  SW_COLORS.ok, SW_COLORS.warn, SW_COLORS.ink, SW_COLORS.steel, SW_COLORS.muted,
];

const MACHINE_CATEGORIES: MachineCategory[] = [
  'sewing', 'cutting', 'spreading', 'pressing', 'embroidery', 'fusing', 'inspection', 'manual',
];

const SKILL_OPTIONS: SkillId[] = [
  'stitching', 'overlock', 'flatlock', 'kansai', 'feed_of_arm',
  'buttonhole', 'button_sew', 'bartack', 'embroidery',
  'cutting_manual', 'cutting_cad', 'spreading', 'fusing',
  'pressing', 'inspection', 'packing', 'bundling',
  'material_handling', 'supervision',
];

const PRODUCT_CATEGORIES: CustomProductSpec['category'][] = [
  'raw', 'wip', 'finished', 'packed',
];

const PRODUCT_CATEGORY_LABEL: Record<CustomProductSpec['category'], string> = {
  raw: 'Raw materials',
  wip: 'Work in progress',
  finished: 'Finished garments',
  packed: 'Packed / shipped',
};

// ── Page shell ───────────────────────────────────────────────────────────
export function AssetsGalleryPage() {
  const [tab, setTab] = useState<Tab>('workstations');
  const [target, setTarget] = useState<EditorTarget>(null);

  return (
    <div style={{ height: '100%', overflow: 'hidden', background: SW_COLORS.paperDeep, position: 'relative', display: 'flex' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 28px 80px' }}>
          <SectionHeader
            kicker="Asset library"
            title="Workstations · Workers · Products"
            sub="Edit the built-in catalog or author your own. Click any card to inspect and change parameters — changes persist with the project."
            right={
              <ToggleGroup
                value={tab}
                onChange={(v) => { setTab(v as Tab); setTarget(null); }}
                options={[
                  { value: 'workstations', label: 'Workstations' },
                  { value: 'workers', label: 'Workers' },
                  { value: 'products', label: 'Products' },
                ]}
              />
            }
          />

          {tab === 'workstations' && (
            <WorkstationsTab
              onPick={(code) => setTarget({ kind: 'machine', code })}
              onNew={() => setTarget({ kind: 'new-machine' })}
            />
          )}
          {tab === 'workers' && (
            <WorkersTab
              onPick={(role) => setTarget({ kind: 'worker', role })}
              onNew={() => setTarget({ kind: 'new-worker' })}
            />
          )}
          {tab === 'products' && (
            <ProductsTab
              onPick={(key) => setTarget({ kind: 'product', key })}
              onNew={() => setTarget({ kind: 'new-product' })}
            />
          )}
        </div>
      </div>

      {target && (
        <EditorDrawer target={target} onClose={() => setTarget(null)} />
      )}
    </div>
  );
}

// ── Workstations tab ─────────────────────────────────────────────────────
function WorkstationsTab({
  onPick,
  onNew,
}: {
  onPick: (code: string) => void;
  onNew: () => void;
}) {
  const machines = useMachines();
  const groups: { label: string; cats: MachineCategory[] }[] = [
    { label: 'Sewing', cats: ['sewing'] },
    { label: 'Cutting / Spreading', cats: ['cutting', 'spreading'] },
    { label: 'Pressing / Fusing', cats: ['pressing', 'fusing'] },
    { label: 'Embroidery', cats: ['embroidery'] },
    { label: 'Inspection / Manual', cats: ['inspection', 'manual'] },
  ];

  // Bucket every machine (built-in + custom) into a group; anything whose
  // category doesn't match a known group falls into "Custom".
  const groupedByCat = useMemo(() => {
    const map = new Map<string, EffectiveMachine[]>();
    for (const m of machines.all) {
      const g = groups.find((x) => x.cats.includes(m.category)) ?? { label: 'Custom', cats: [] };
      const list = map.get(g.label) ?? [];
      list.push(m);
      map.set(g.label, list);
    }
    return map;
  }, [machines.all]); // eslint-disable-line react-hooks/exhaustive-deps

  const restoreMachine = useProject((s) => s.restoreMachine);

  return (
    <>
      <ToolbarRow onNew={onNew} newLabel="+ New workstation" />
      <RestoreTray
        label="workstations"
        items={machines.hidden}
        getId={(m) => m.code}
        getLabel={(m) => `${m.code} · ${m.shortName}`}
        onRestore={restoreMachine}
        renderThumb={(m) =>
          m.customImage
            ? <img src={m.customImage} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }} />
            : <WorkstationSprite code={(('baseSprite' in m && m.baseSprite) ? m.baseSprite : (m.code as MachineCode))} size={24} state="idle" />
        }
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {[...groups, { label: 'Custom', cats: [] as MachineCategory[] }]
          .filter((g) => (groupedByCat.get(g.label)?.length ?? 0) > 0)
          .map((g) => (
            <div key={g.label}>
              <GroupTitle>{g.label}</GroupTitle>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 14,
                }}
              >
                {(groupedByCat.get(g.label) ?? []).map((m) => (
                  <MachineCard
                    key={m.code}
                    spec={m}
                    isCustom={machines.isCustom(m.code)}
                    isEdited={machines.hasEdit(m.code)}
                    onClick={() => onPick(m.code)}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

function MachineCard({
  spec,
  isCustom,
  isEdited,
  onClick,
}: {
  spec: EffectiveMachine;
  isCustom: boolean;
  isEdited: boolean;
  onClick: () => void;
}) {
  const baseSprite: MachineCode =
    'baseSprite' in spec && spec.baseSprite ? spec.baseSprite : (spec.code as MachineCode);
  const renderable = (MACHINE_CATALOG as Record<string, MachineSpec>)[baseSprite] ? baseSprite : 'SNL';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderLeft: `4px solid ${spec.color}`,
        borderRadius: SW_RADIUS.md,
        padding: 14,
        textAlign: 'left',
        cursor: 'pointer',
        position: 'relative',
        boxShadow: SW_SHADOWS.card,
        transition: 'box-shadow 120ms, transform 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SW_SHADOWS.pop; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = SW_SHADOWS.card; }}
    >
      <BadgeRow isCustom={isCustom} isEdited={isEdited} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          height: 110,
          background: SW_COLORS.paperDeep,
          borderRadius: SW_RADIUS.sm,
          marginBottom: 10,
          padding: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: SW_COLORS.paper,
            borderRadius: 4,
            border: `1px solid ${SW_COLORS.line}`,
            position: 'relative',
            overflow: 'hidden',
          }}
          title={spec.customImage ? 'Uploaded image' : 'Top-down sprite used in floor diagrams'}
        >
          {spec.customImage ? (
            <img
              src={spec.customImage}
              alt={spec.label}
              style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 6 }}
            />
          ) : (
            <WorkstationSprite code={renderable as MachineCode} size={72} state="running" />
          )}
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: 4,
              fontFamily: SW_FONTS.mono,
              fontSize: 8,
              fontWeight: 800,
              color: SW_COLORS.muted,
              letterSpacing: '0.06em',
            }}
          >
            {spec.customImage ? 'IMG' : '2D'}
          </span>
        </div>
        <div
          style={{ position: 'relative' }}
          title="Same block the Builder drops on the floor"
        >
          <IsoMiniPreview
            machineCode={renderable}
            size={94}
            background={SW_COLORS.paper}
            style={{ width: '100%', height: '100%' }}
          />
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: 4,
              fontFamily: SW_FONTS.mono,
              fontSize: 8,
              fontWeight: 800,
              color: SW_COLORS.muted,
              letterSpacing: '0.06em',
            }}
          >
            BUILDER
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap', minWidth: 0 }}>
        <Tag color={spec.color}>{spec.code}</Tag>
        <div style={{ fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 700, color: SW_COLORS.ink, minWidth: 0, overflowWrap: 'anywhere' }}>{spec.shortName}</div>
      </div>
      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.4, minHeight: 30, overflowWrap: 'anywhere' }}>{spec.label}</div>
    </button>
  );
}

// ── Workers tab ──────────────────────────────────────────────────────────
function WorkersTab({
  onPick,
  onNew,
}: {
  onPick: (role: string) => void;
  onNew: () => void;
}) {
  const workers = useWorkers();
  const restoreWorker = useProject((s) => s.restoreWorker);
  const [style, setStyle] = useState<WorkerSpriteStyle>('chibi');
  return (
    <>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: SW_COLORS.muted, fontFamily: SW_FONTS.mono, textTransform: 'uppercase', letterSpacing: 1 }}>Style</span>
          <ToggleGroup
            value={style}
            onChange={(v) => setStyle(v as WorkerSpriteStyle)}
            options={[
              { value: 'chibi', label: 'Chibi' },
              { value: 'silhouette', label: 'Silhouette' },
              { value: 'dots', label: 'Dots' },
            ]}
          />
        </div>
        <Button variant="primary" size="sm" onClick={onNew}>+ New worker role</Button>
      </div>
      <RestoreTray
        label="worker roles"
        items={workers.hidden}
        getId={(w) => w.role}
        getLabel={(w) => w.label}
        onRestore={restoreWorker}
        renderThumb={(w) =>
          w.customImage
            ? <img src={w.customImage} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }} />
            : <WorkerSprite role={(('baseSprite' in w && w.baseSprite) ? w.baseSprite : (w.role as WorkerRole))} size={28} style={style} state="idle" />
        }
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 14,
        }}
      >
        {workers.all.map((a) => (
          <WorkerCard
            key={a.role}
            spec={a}
            spriteStyle={style}
            isCustom={workers.isCustom(a.role)}
            isEdited={workers.hasEdit(a.role)}
            onClick={() => onPick(a.role)}
          />
        ))}
      </div>
    </>
  );
}

function WorkerCard({
  spec,
  spriteStyle,
  isCustom,
  isEdited,
  onClick,
}: {
  spec: EffectiveWorker;
  spriteStyle: WorkerSpriteStyle;
  isCustom: boolean;
  isEdited: boolean;
  onClick: () => void;
}) {
  const baseSprite: WorkerRole =
    'baseSprite' in spec && spec.baseSprite ? spec.baseSprite : (spec.role as WorkerRole);
  const renderable = (WORKER_ARCHETYPES as Record<string, WorkerArchetype>)[baseSprite]
    ? baseSprite
    : 'helper';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderLeft: `4px solid ${spec.color}`,
        borderRadius: SW_RADIUS.md,
        padding: 14,
        textAlign: 'left',
        cursor: 'pointer',
        position: 'relative',
        boxShadow: SW_SHADOWS.card,
        transition: 'box-shadow 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SW_SHADOWS.pop; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = SW_SHADOWS.card; }}
    >
      <BadgeRow isCustom={isCustom} isEdited={isEdited} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          height: 130,
          background: SW_COLORS.paperDeep,
          borderRadius: SW_RADIUS.sm,
          marginBottom: 10,
          padding: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: SW_COLORS.paper,
            borderRadius: 4,
            border: `1px solid ${SW_COLORS.line}`,
            position: 'relative',
            overflow: 'hidden',
          }}
          title={spec.customImage ? 'Uploaded image' : 'Front-facing chibi avatar'}
        >
          {spec.customImage ? (
            <img
              src={spec.customImage}
              alt={spec.label}
              style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 6 }}
            />
          ) : (
            <WorkerSprite role={renderable as WorkerRole} size={104} style={spriteStyle} state="busy" />
          )}
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: 4,
              fontFamily: SW_FONTS.mono,
              fontSize: 8,
              fontWeight: 800,
              color: SW_COLORS.muted,
              letterSpacing: '0.06em',
            }}
          >
            {spec.customImage ? 'IMG' : 'FACE'}
          </span>
        </div>
        <div
          style={{ position: 'relative' }}
          title="Iso operator block — the one placed on the Builder floor"
        >
          <IsoMiniPreview
            workerRole={renderable}
            size={120}
            background={SW_COLORS.paper}
            style={{ width: '100%', height: '100%' }}
          />
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: 4,
              fontFamily: SW_FONTS.mono,
              fontSize: 8,
              fontWeight: 800,
              color: SW_COLORS.muted,
              letterSpacing: '0.06em',
            }}
          >
            BUILDER
          </span>
        </div>
      </div>
      <div style={{ fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 700, color: SW_COLORS.ink, marginBottom: 4 }}>{spec.label}</div>
      <div style={{ fontSize: 11, color: SW_COLORS.muted, lineHeight: 1.4, minHeight: 30 }}>{spec.description}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
        {spec.primarySkills.map((s) => (
          <span key={s} style={{ fontFamily: SW_FONTS.mono, fontSize: 9, padding: '2px 5px', borderRadius: 3, background: spec.color, color: SW_COLORS.paper, fontWeight: 700 }}>{s}</span>
        ))}
      </div>
      <div style={{ marginTop: 8, fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted }}>
        {Math.round(spec.baseEfficiency * 100)}% eff
      </div>
    </button>
  );
}

// ── Products tab ─────────────────────────────────────────────────────────
function ProductsTab({
  onPick,
  onNew,
}: {
  onPick: (key: string) => void;
  onNew: () => void;
}) {
  const products = useProducts();
  const groups = useMemo(() => {
    const builtInGroups = [
      { label: 'Raw materials', kinds: ['fabric_roll', 'thread_cone', 'trim_card', 'button_card', 'zipper'] },
      { label: 'Work in progress', kinds: ['bundle', 'cut_piece', 'wip_garment', 'hanger'] },
      { label: 'Garments', kinds: ['tshirt', 'polo', 'shirt', 'trouser', 'sweatshirt'] },
      { label: 'Packed', kinds: ['polybag', 'carton'] },
    ];
    const out: { label: string; items: EffectiveProduct[] }[] = builtInGroups.map((g) => ({
      label: g.label,
      items: g.kinds
        .map((k) => products.byKind[k])
        .filter((p): p is EffectiveProduct => !!p && !products.isHidden(p.kind)),
    }));
    const customs = products.all.filter((p) => p.isCustom);
    if (customs.length) out.push({ label: 'Custom', items: customs });
    return out;
  }, [products]);

  const restoreProduct = useProject((s) => s.restoreProduct);

  return (
    <>
      <ToolbarRow onNew={onNew} newLabel="+ New product" />
      <RestoreTray
        label="products"
        items={products.hidden}
        getId={(p) => p.kind}
        getLabel={(p) => p.label}
        onRestore={restoreProduct}
        renderThumb={(p) =>
          p.customImage
            ? <img src={p.customImage} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }} />
            : <ProductSprite kind={p.baseSprite} size={28} color={p.color} />
        }
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {groups.map((g) => (
          <div key={g.label}>
            <GroupTitle>{g.label}</GroupTitle>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 14,
              }}
            >
              {g.items.map((p) => (
                <ProductCard
                  key={p.kind}
                  spec={p}
                  onClick={() => onPick(p.kind)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ProductCard({ spec, onClick }: { spec: EffectiveProduct; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: SW_COLORS.paper,
        border: `1px solid ${SW_COLORS.line}`,
        borderRadius: SW_RADIUS.md,
        padding: 14,
        textAlign: 'left',
        cursor: 'pointer',
        position: 'relative',
        boxShadow: SW_SHADOWS.card,
        transition: 'box-shadow 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SW_SHADOWS.pop; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = SW_SHADOWS.card; }}
    >
      <BadgeRow isCustom={spec.isCustom} isEdited={!!spec.hasEdit} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 120,
          background: SW_COLORS.paperDeep,
          borderRadius: SW_RADIUS.sm,
          marginBottom: 10,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {spec.customImage ? (
          <img
            src={spec.customImage}
            alt={spec.label}
            style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 8 }}
          />
        ) : (
          <ProductSprite
            kind={spec.baseSprite}
            size={92}
            color={spec.color}
            count={spec.baseSprite === 'bundle' ? 30 : spec.baseSprite === 'carton' ? 24 : undefined}
          />
        )}
      </div>
      <div style={{ fontFamily: SW_FONTS.body, fontSize: 13, fontWeight: 700, color: SW_COLORS.ink }}>{spec.label}</div>
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, color: SW_COLORS.muted, marginTop: 4 }}>{spec.kind}</div>
    </button>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────
function EditorDrawer({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: alpha(SW_COLORS.ink, 0.18),
          zIndex: 10,
        }}
      />
      <aside
        style={{
          position: 'absolute', top: 0, right: 0, height: '100%',
          width: 440,
          maxWidth: '100%',
          background: SW_COLORS.paper,
          borderLeft: `1px solid ${SW_COLORS.line}`,
          boxShadow: SW_SHADOWS.hi,
          zIndex: 11,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <DrawerBody target={target} onClose={onClose} />
      </aside>
    </>
  );
}

function DrawerBody({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  if (!target) return null;
  if (target.kind === 'machine') return <MachineEditor code={target.code} onClose={onClose} />;
  if (target.kind === 'worker') return <WorkerEditor role={target.role} onClose={onClose} />;
  if (target.kind === 'product') return <ProductEditor productKey={target.key} onClose={onClose} />;
  if (target.kind === 'new-machine') return <NewMachineEditor onClose={onClose} />;
  if (target.kind === 'new-worker') return <NewWorkerEditor onClose={onClose} />;
  if (target.kind === 'new-product') return <NewProductEditor onClose={onClose} />;
  return null;
}

// ── Machine editor ───────────────────────────────────────────────────────
function MachineEditor({ code, onClose }: { code: string; onClose: () => void }) {
  const machines = useMachines();
  const spec = machines.byCode[code];
  const isCustom = machines.isCustom(code);
  const isEdited = machines.hasEdit(code);
  const builtIn = (MACHINE_CATALOG as Record<string, MachineSpec>)[code];

  const patchMachine = useProject((s) => s.patchMachine);
  const resetMachine = useProject((s) => s.resetMachine);
  const patchCustomMachine = useProject((s) => s.patchCustomMachine);
  const deleteMachine = useProject((s) => s.deleteMachine);
  const setMachineImage = useProject((s) => s.setMachineImage);

  if (!spec) return <DrawerHeader title="Workstation" subtitle="Not found" onClose={onClose} />;

  const apply = (patch: Partial<EffectiveMachine>) => {
    if (isCustom) patchCustomMachine(code, patch as Partial<CustomMachineSpec>);
    else patchMachine(code, builtIn, patch as Partial<MachineSpec>);
  };

  return (
    <>
      <DrawerHeader
        title={spec.shortName}
        subtitle={isCustom ? 'Custom workstation' : isEdited ? 'Built-in · edited' : 'Built-in workstation'}
        onClose={onClose}
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            {!isCustom && isEdited && (
              <Button variant="ghost" size="sm" onClick={() => resetMachine(code)}>Reset</Button>
            )}
            <Button variant="danger" size="sm" onClick={() => { deleteMachine(code); onClose(); }}>Delete</Button>
          </div>
        }
      />
      <DrawerScroll>
        <Section label="Image">
          <ImageDropZone
            value={spec.customImage}
            onChange={(url) => setMachineImage(code, url)}
            fallback={<WorkstationSprite code={(('baseSprite' in spec && spec.baseSprite) ? spec.baseSprite : (spec.code as MachineCode))} size={64} state="running" />}
          />
        </Section>

        <Section label="Identity">
          <Field label="Code">
            <TextInput value={spec.code} disabled />
          </Field>
          <Field label="Short name">
            <TextInput value={spec.shortName} onChange={(v) => apply({ shortName: v })} />
          </Field>
          <Field label="Full label">
            <TextInput value={spec.label} onChange={(v) => apply({ label: v })} />
          </Field>
          <Field label="Description">
            <TextArea value={spec.description} onChange={(v) => apply({ description: v })} />
          </Field>
        </Section>

        <Section label="Classification">
          <Field label="Category">
            <Select
              value={spec.category}
              onChange={(v) => apply({ category: v as MachineCategory })}
              options={MACHINE_CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Speed class">
            <Select
              value={spec.speedClass ?? ''}
              onChange={(v) => apply({ speedClass: (v || undefined) as MachineSpec['speedClass'] })}
              options={[
                { value: '', label: '—' },
                { value: 'low', label: 'Low' },
                { value: 'mid', label: 'Mid' },
                { value: 'high', label: 'High' },
              ]}
            />
          </Field>
          <Field label="Accent colour">
            <ColorPicker value={spec.color} onChange={(c) => apply({ color: c })} />
          </Field>
        </Section>

        <Section label="Machine type">
          <Field label="Manual (person-only)">
            <Toggle
              value={!!spec.isManual}
              onChange={(b) => apply({ isManual: b })}
            />
          </Field>
        </Section>
      </DrawerScroll>
    </>
  );
}

// ── Worker editor ────────────────────────────────────────────────────────
function WorkerEditor({ role, onClose }: { role: string; onClose: () => void }) {
  const workers = useWorkers();
  const spec = workers.byRole[role];
  const isCustom = workers.isCustom(role);
  const isEdited = workers.hasEdit(role);
  const builtIn = (WORKER_ARCHETYPES as Record<string, WorkerArchetype>)[role];

  const patchWorker = useProject((s) => s.patchWorker);
  const resetWorker = useProject((s) => s.resetWorker);
  const patchCustomWorker = useProject((s) => s.patchCustomWorker);
  const deleteWorker = useProject((s) => s.deleteWorker);
  const setWorkerImage = useProject((s) => s.setWorkerImage);

  if (!spec) return <DrawerHeader title="Worker" subtitle="Not found" onClose={onClose} />;

  const apply = (patch: Partial<EffectiveWorker>) => {
    if (isCustom) patchCustomWorker(role, patch as Partial<CustomWorkerArchetype>);
    else patchWorker(role, builtIn, patch as Partial<WorkerArchetype>);
  };

  const toggleSkill = (s: SkillId, pool: 'primarySkills' | 'secondarySkills') => {
    const cur = (spec[pool] ?? []) as SkillId[];
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    apply({ [pool]: next } as Partial<EffectiveWorker>);
  };

  const renderableRole: WorkerRole =
    ('baseSprite' in spec && spec.baseSprite ? spec.baseSprite : (spec.role as WorkerRole));

  return (
    <>
      <DrawerHeader
        title={spec.label}
        subtitle={isCustom ? 'Custom worker role' : isEdited ? 'Built-in · edited' : 'Built-in worker role'}
        onClose={onClose}
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            {!isCustom && isEdited && (
              <Button variant="ghost" size="sm" onClick={() => resetWorker(role)}>Reset</Button>
            )}
            <Button variant="danger" size="sm" onClick={() => { deleteWorker(role); onClose(); }}>Delete</Button>
          </div>
        }
      />
      <DrawerScroll>
        <Section label="Image">
          <ImageDropZone
            value={spec.customImage}
            onChange={(url) => setWorkerImage(role, url)}
            fallback={<WorkerSprite role={renderableRole} size={64} style="chibi" state="busy" />}
          />
        </Section>

        <Section label="Identity">
          <Field label="Role id">
            <TextInput value={spec.role} disabled />
          </Field>
          <Field label="Label">
            <TextInput value={spec.label} onChange={(v) => apply({ label: v })} />
          </Field>
          <Field label="Description">
            <TextArea value={spec.description} onChange={(v) => apply({ description: v })} />
          </Field>
          <Field label="Accent colour">
            <ColorPicker value={spec.color} onChange={(c) => apply({ color: c })} />
          </Field>
        </Section>

        <Section label="Performance">
          <Field label="Base efficiency">
            <NumberInput value={spec.baseEfficiency} step={0.05} min={0} max={1.5} onChange={(n) => apply({ baseEfficiency: n })} />
          </Field>
          <NumPair>
            <Field label="Walk speed (m/s)">
              <NumberInput value={spec.walkSpeedMps} step={0.1} min={0} onChange={(n) => apply({ walkSpeedMps: n })} />
            </Field>
            <Field label="Owns a station">
              <Toggle value={spec.ownsStation} onChange={(b) => apply({ ownsStation: b })} />
            </Field>
          </NumPair>
        </Section>

        <Section label="Primary skills">
          <SkillGrid
            selected={(spec.primarySkills ?? []) as SkillId[]}
            onToggle={(s) => toggleSkill(s, 'primarySkills')}
          />
        </Section>

        <Section label="Secondary skills">
          <SkillGrid
            selected={(spec.secondarySkills ?? []) as SkillId[]}
            onToggle={(s) => toggleSkill(s, 'secondarySkills')}
          />
        </Section>
      </DrawerScroll>
    </>
  );
}

// ── Product editor ───────────────────────────────────────────────────────
function ProductEditor({ productKey, onClose }: { productKey: string; onClose: () => void }) {
  const products = useProducts();
  const spec = products.byKind[productKey];
  const isCustom = products.isCustom(productKey);
  const isEdited = products.hasEdit(productKey);

  const patchCustomProduct = useProject((s) => s.patchCustomProduct);
  const patchProduct = useProject((s) => s.patchProduct);
  const resetProduct = useProject((s) => s.resetProduct);
  const deleteProduct = useProject((s) => s.deleteProduct);
  const setProductImage = useProject((s) => s.setProductImage);

  if (!spec) return <DrawerHeader title="Product" subtitle="Not found" onClose={onClose} />;

  const setLabel = (v: string) => {
    if (isCustom) patchCustomProduct(productKey, { label: v });
    else patchProduct(productKey, { label: v });
  };
  const setDescription = (v: string) => {
    if (isCustom) patchCustomProduct(productKey, { description: v });
    else patchProduct(productKey, { description: v });
  };
  const setBaseSprite = (v: ProductKind) => {
    if (isCustom) patchCustomProduct(productKey, { baseSprite: v });
    else patchProduct(productKey, { baseSprite: v });
  };
  const setColor = (c: string) => {
    if (isCustom) patchCustomProduct(productKey, { color: c });
    else patchProduct(productKey, { color: c });
  };

  return (
    <>
      <DrawerHeader
        title={spec.label}
        subtitle={isCustom ? 'Custom product' : isEdited ? 'Built-in · edited' : 'Built-in product'}
        onClose={onClose}
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            {!isCustom && isEdited && (
              <Button variant="ghost" size="sm" onClick={() => resetProduct(productKey)}>Reset</Button>
            )}
            <Button variant="danger" size="sm" onClick={() => { deleteProduct(productKey); onClose(); }}>Delete</Button>
          </div>
        }
      />
      <DrawerScroll>
        <Section label="Image">
          <ImageDropZone
            value={spec.customImage}
            onChange={(url) => setProductImage(productKey, url)}
            fallback={<ProductSprite kind={spec.baseSprite} size={64} color={spec.color} />}
          />
        </Section>
        <Section label="Identity">
          <Field label="Kind id">
            <TextInput value={spec.kind} disabled />
          </Field>
          <Field label="Label">
            <TextInput value={spec.label} onChange={setLabel} />
          </Field>
          <Field label="Description">
            <TextArea
              value={spec.description ?? ''}
              onChange={setDescription}
            />
          </Field>
        </Section>
        <Section label="Appearance">
          <Field label="Base sprite">
            <Select
              value={spec.baseSprite}
              onChange={(v) => setBaseSprite(v as ProductKind)}
              options={PRODUCT_KINDS.map((k) => ({ value: k, label: k }))}
            />
          </Field>
          <Field label="Accent colour">
            <ColorPicker
              value={spec.color ?? '#999999'}
              onChange={setColor}
            />
          </Field>
        </Section>
      </DrawerScroll>
    </>
  );
}

// ── New-asset editors ────────────────────────────────────────────────────
function NewMachineEditor({ onClose }: { onClose: () => void }) {
  const addCustomMachine = useProject((s) => s.addCustomMachine);
  const machines = useMachines();
  const [draft, setDraft] = useState<CustomMachineSpec>(() => ({
    code: '',
    isCustom: true,
    baseSprite: 'SNL',
    category: 'sewing',
    label: '',
    shortName: '',
    description: '',
    icon: '⌃',
    color: SW_COLORS.brand,
    speedClass: 'mid',
  }));
  const [err, setErr] = useState<string | null>(null);

  const update = <K extends keyof CustomMachineSpec>(k: K, v: CustomMachineSpec[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = () => {
    const code = draft.code.trim().toUpperCase();
    if (!code) return setErr('Code is required');
    if (machines.byCode[code]) return setErr(`Code "${code}" already exists`);
    if (!draft.shortName.trim()) return setErr('Short name is required');
    addCustomMachine({ ...draft, code });
    onClose();
  };

  return (
    <>
      <DrawerHeader title="New workstation" subtitle="Define a custom machine" onClose={onClose} />
      <DrawerScroll>
        <Section label="Identity">
          <Field label="Code (e.g. MY-SNL)">
            <TextInput value={draft.code} onChange={(v) => update('code', v.toUpperCase())} />
          </Field>
          <Field label="Short name">
            <TextInput value={draft.shortName} onChange={(v) => update('shortName', v)} />
          </Field>
          <Field label="Full label">
            <TextInput value={draft.label} onChange={(v) => update('label', v)} />
          </Field>
          <Field label="Description">
            <TextArea value={draft.description} onChange={(v) => update('description', v)} />
          </Field>
        </Section>

        <Section label="Classification">
          <Field label="Category">
            <Select
              value={draft.category}
              onChange={(v) => update('category', v as MachineCategory)}
              options={MACHINE_CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Base sprite">
            <Select
              value={draft.baseSprite}
              onChange={(v) => update('baseSprite', v as MachineCode)}
              options={Object.keys(MACHINE_CATALOG).map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Accent colour">
            <ColorPicker value={draft.color} onChange={(c) => update('color', c)} />
          </Field>
        </Section>

        {err && <div style={{ padding: '0 18px', color: SW_COLORS.alarm, fontSize: 12 }}>{err}</div>}

        <DrawerFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Create</Button>
        </DrawerFooter>
      </DrawerScroll>
    </>
  );
}

function NewWorkerEditor({ onClose }: { onClose: () => void }) {
  const addCustomWorker = useProject((s) => s.addCustomWorker);
  const workers = useWorkers();
  const [draft, setDraft] = useState<CustomWorkerArchetype>(() => ({
    role: '',
    isCustom: true,
    baseSprite: 'helper',
    label: '',
    description: '',
    icon: '✋',
    color: SW_COLORS.brand,
    primarySkills: [],
    secondarySkills: [],
    baseEfficiency: 0.85,
    walkSpeedMps: 1.0,
    ownsStation: false,
  }));
  const [err, setErr] = useState<string | null>(null);

  const update = <K extends keyof CustomWorkerArchetype>(k: K, v: CustomWorkerArchetype[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const toggleSkill = (s: SkillId, pool: 'primarySkills' | 'secondarySkills') => {
    const cur = (draft[pool] ?? []) as SkillId[];
    update(pool, (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]) as CustomWorkerArchetype[typeof pool]);
  };

  const submit = () => {
    const role = draft.role.trim().toLowerCase().replace(/\s+/g, '_');
    if (!role) return setErr('Role id is required');
    if (workers.byRole[role]) return setErr(`Role "${role}" already exists`);
    if (!draft.label.trim()) return setErr('Label is required');
    addCustomWorker({ ...draft, role });
    onClose();
  };

  return (
    <>
      <DrawerHeader title="New worker role" subtitle="Define a custom archetype" onClose={onClose} />
      <DrawerScroll>
        <Section label="Identity">
          <Field label="Role id (e.g. line_lead)">
            <TextInput value={draft.role} onChange={(v) => update('role', v)} />
          </Field>
          <Field label="Label">
            <TextInput value={draft.label} onChange={(v) => update('label', v)} />
          </Field>
          <Field label="Description">
            <TextArea value={draft.description} onChange={(v) => update('description', v)} />
          </Field>
          <Field label="Base sprite">
            <Select
              value={draft.baseSprite}
              onChange={(v) => update('baseSprite', v as WorkerRole)}
              options={Object.keys(WORKER_ARCHETYPES).map((r) => ({ value: r, label: r }))}
            />
          </Field>
          <Field label="Accent colour">
            <ColorPicker value={draft.color} onChange={(c) => update('color', c)} />
          </Field>
        </Section>

        <Section label="Performance">
          <NumPair>
            <Field label="Base efficiency">
              <NumberInput value={draft.baseEfficiency} step={0.05} min={0} max={1.5} onChange={(n) => update('baseEfficiency', n)} />
            </Field>
            <Field label="Walk speed (m/s)">
              <NumberInput value={draft.walkSpeedMps} step={0.1} min={0} onChange={(n) => update('walkSpeedMps', n)} />
            </Field>
          </NumPair>
          <Field label="Owns a station">
            <Toggle value={draft.ownsStation} onChange={(b) => update('ownsStation', b)} />
          </Field>
        </Section>

        <Section label="Primary skills">
          <SkillGrid
            selected={(draft.primarySkills ?? []) as SkillId[]}
            onToggle={(s) => toggleSkill(s, 'primarySkills')}
          />
        </Section>

        <Section label="Secondary skills">
          <SkillGrid
            selected={(draft.secondarySkills ?? []) as SkillId[]}
            onToggle={(s) => toggleSkill(s, 'secondarySkills')}
          />
        </Section>

        {err && <div style={{ padding: '0 18px', color: SW_COLORS.alarm, fontSize: 12 }}>{err}</div>}

        <DrawerFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Create</Button>
        </DrawerFooter>
      </DrawerScroll>
    </>
  );
}

function NewProductEditor({ onClose }: { onClose: () => void }) {
  const addCustomProduct = useProject((s) => s.addCustomProduct);
  const products = useProducts();
  const [draft, setDraft] = useState<CustomProductSpec>(() => ({
    kind: '',
    isCustom: true,
    baseSprite: 'tshirt',
    label: '',
    category: 'finished',
    color: SW_COLORS.brand,
    description: '',
  }));
  const [err, setErr] = useState<string | null>(null);

  const update = <K extends keyof CustomProductSpec>(k: K, v: CustomProductSpec[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = () => {
    const kind = draft.kind.trim().toLowerCase().replace(/\s+/g, '_');
    if (!kind) return setErr('Kind id is required');
    if (products.byKind[kind]) return setErr(`Kind "${kind}" already exists`);
    if (!draft.label.trim()) return setErr('Label is required');
    addCustomProduct({ ...draft, kind });
    onClose();
  };

  return (
    <>
      <DrawerHeader title="New product" subtitle="Add a custom SKU or material" onClose={onClose} />
      <DrawerScroll>
        <Section label="Identity">
          <Field label="Kind id (e.g. denim_pant)">
            <TextInput value={draft.kind} onChange={(v) => update('kind', v)} />
          </Field>
          <Field label="Label">
            <TextInput value={draft.label} onChange={(v) => update('label', v)} />
          </Field>
          <Field label="Description">
            <TextArea value={draft.description ?? ''} onChange={(v) => update('description', v)} />
          </Field>
          <Field label="Category">
            <Select
              value={draft.category}
              onChange={(v) => update('category', v as CustomProductSpec['category'])}
              options={PRODUCT_CATEGORIES.map((c) => ({ value: c, label: PRODUCT_CATEGORY_LABEL[c] }))}
            />
          </Field>
        </Section>

        <Section label="Appearance">
          <Field label="Base sprite">
            <Select
              value={draft.baseSprite}
              onChange={(v) => update('baseSprite', v as ProductKind)}
              options={PRODUCT_KINDS.map((k) => ({ value: k, label: k }))}
            />
          </Field>
          <Field label="Accent colour">
            <ColorPicker value={draft.color ?? SW_COLORS.brand} onChange={(c) => update('color', c)} />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
            <ProductSprite kind={draft.baseSprite} size={120} color={draft.color} />
          </div>
        </Section>

        {err && <div style={{ padding: '0 18px', color: SW_COLORS.alarm, fontSize: 12 }}>{err}</div>}

        <DrawerFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Create</Button>
        </DrawerFooter>
      </DrawerScroll>
    </>
  );
}

// ── Drawer chrome + form atoms ───────────────────────────────────────────
function DrawerHeader({
  title,
  subtitle,
  onClose,
  right,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  right?: ReactNode;
}) {
  return (
    <div style={{ padding: '16px 18px', borderBottom: `1px solid ${SW_COLORS.line}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: SW_COLORS.muted }}>{subtitle}</div>
        <div style={{ fontFamily: SW_FONTS.display, fontSize: 20, fontWeight: 800, color: SW_COLORS.ink, marginTop: 2 }}>{title}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {right}
        <button
          type="button"
          onClick={onClose}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 18, color: SW_COLORS.muted, padding: 4,
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function DrawerScroll({ children }: { children: ReactNode }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  );
}

function DrawerFooter({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 'auto', padding: 18, borderTop: `1px solid ${SW_COLORS.line}`, display: 'flex', gap: 8, justifyContent: 'flex-end', background: SW_COLORS.paperDeep }}>
      {children}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ padding: '14px 18px', borderBottom: `1px solid ${SW_COLORS.line}` }}>
      <div style={{ fontFamily: SW_FONTS.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: SW_COLORS.muted, marginBottom: 10 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: SW_COLORS.muted, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

function NumPair({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div>;
}

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  fontSize: 13,
  fontFamily: SW_FONTS.body,
  border: `1px solid ${SW_COLORS.line}`,
  borderRadius: SW_RADIUS.sm,
  background: SW_COLORS.paper,
  color: SW_COLORS.ink,
  outline: 'none',
};

function TextInput({ value, onChange, disabled }: { value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <input
      type="text"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
    />
  );
}

function TextArea({ value, onChange, disabled }: { value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <textarea
      value={value}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      rows={2}
      style={{ ...inputStyle, fontFamily: SW_FONTS.body, resize: 'vertical', opacity: disabled ? 0.6 : 1 }}
    />
  );
}

function NumberInput({ value, onChange, step, min, max }: { value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step ?? 1}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      style={{ ...inputStyle, fontFamily: SW_FONTS.mono }}
    />
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange?: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <HudSelect
      value={value}
      onChange={(v) => onChange?.(v)}
      variant="light"
      width="100%"
      disabled={disabled}
      options={options}
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 24, borderRadius: 12, padding: 2,
        border: `1px solid ${SW_COLORS.line}`,
        background: value ? SW_COLORS.brand : SW_COLORS.paperDeep,
        cursor: 'pointer',
        position: 'relative',
      }}
      aria-pressed={value}
    >
      <span
        style={{
          display: 'block',
          width: 18, height: 18,
          background: SW_COLORS.paper,
          borderRadius: '50%',
          boxShadow: SW_SHADOWS.card,
          transform: `translateX(${value ? 20 : 0}px)`,
          transition: 'transform 120ms',
        }}
      />
    </button>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {COLOR_SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{
            width: 22, height: 22, borderRadius: '50%',
            background: c,
            border: `2px solid ${value === c ? SW_COLORS.ink : 'transparent'}`,
            cursor: 'pointer',
            padding: 0,
          }}
          aria-label={`Pick ${c}`}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 28, height: 28, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
        aria-label="Custom colour"
      />
    </div>
  );
}

function SkillGrid({ selected, onToggle }: { selected: SkillId[]; onToggle: (s: SkillId) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {SKILL_OPTIONS.map((s) => {
        const on = selected.includes(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onToggle(s)}
            style={{
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              padding: '4px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              border: `1px solid ${on ? SW_COLORS.brand : SW_COLORS.line}`,
              background: on ? SW_COLORS.brand : SW_COLORS.paper,
              color: on ? SW_COLORS.paper : SW_COLORS.ink,
            }}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

// ── Image upload control ─────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 1_500_000; // ~1.5 MB raw; resists data-URL bloat
const IMAGE_PREVIEW_BG: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: SW_COLORS.paperDeep,
  borderRadius: SW_RADIUS.sm,
  border: `1px dashed ${SW_COLORS.line}`,
  height: 120,
  overflow: 'hidden',
};

function ImageDropZone({
  value,
  onChange,
  fallback,
}: {
  value: string | undefined;
  onChange: (dataUrl: string | null) => void;
  fallback: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pick = () => inputRef.current?.click();
  const onFile = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (!f.type.startsWith('image/')) return setErr('Please pick an image file.');
    if (f.size > MAX_IMAGE_BYTES) return setErr(`Image is too large (${Math.round(f.size / 1024)} KB). Keep under ${Math.round(MAX_IMAGE_BYTES / 1024)} KB.`);
    const r = new FileReader();
    r.onload = () => onChange(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => setErr('Could not read the file.');
    r.readAsDataURL(f);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={IMAGE_PREVIEW_BG}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          onFile(e.dataTransfer.files?.[0]);
        }}
      >
        {value ? (
          <img
            src={value}
            alt="Uploaded preview"
            style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 8 }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: SW_COLORS.muted, fontSize: 11 }}>
            {fallback}
            <span>Drop an image or click Upload</span>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="ghost" size="sm" onClick={pick}>{value ? 'Replace image' : 'Upload image'}</Button>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>Remove</Button>
        )}
      </div>
      {err && <div style={{ fontSize: 11, color: SW_COLORS.alarm }}>{err}</div>}
      {!err && (
        <div style={{ fontSize: 10, color: SW_COLORS.muted, lineHeight: 1.4 }}>
          PNG / JPG / SVG up to {Math.round(MAX_IMAGE_BYTES / 1024)} KB. Uploaded images replace the card preview; the Builder still draws the 3D iso block from the underlying spec.
        </div>
      )}
    </div>
  );
}

// ── Restore tray for hidden built-ins ────────────────────────────────────
function RestoreTray<T extends { customImage?: string }>({
  label,
  items,
  getId,
  getLabel,
  onRestore,
  renderThumb,
}: {
  label: string;
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  onRestore: (id: string) => void;
  renderThumb: (item: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 14, border: `1px dashed ${SW_COLORS.line}`, borderRadius: SW_RADIUS.sm, background: SW_COLORS.paperDeep }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', textAlign: 'left',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none', cursor: 'pointer',
          fontFamily: SW_FONTS.mono, fontSize: 11, fontWeight: 700,
          color: SW_COLORS.muted, letterSpacing: 1.2, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <span>{items.length} hidden {label}</span>
        <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 12px 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {items.map((it) => {
            const id = getId(it);
            return (
              <div
                key={id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px',
                  background: SW_COLORS.paper,
                  border: `1px solid ${SW_COLORS.line}`,
                  borderRadius: SW_RADIUS.sm,
                }}
              >
                <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{renderThumb(it)}</div>
                <span style={{ fontSize: 12, color: SW_COLORS.ink }}>{getLabel(it)}</span>
                <Button variant="ghost" size="sm" onClick={() => onRestore(id)}>Restore</Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Bits & pieces ────────────────────────────────────────────────────────
function ToolbarRow({ onNew, newLabel }: { onNew: () => void; newLabel: string }) {
  return (
    <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'flex-end' }}>
      <Button variant="primary" size="sm" onClick={onNew}>{newLabel}</Button>
    </div>
  );
}

function BadgeRow({ isCustom, isEdited }: { isCustom: boolean; isEdited: boolean }) {
  if (!isCustom && !isEdited) return null;
  return (
    <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, zIndex: 1 }}>
      {isCustom && (
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 3, background: SW_COLORS.brand, color: SW_COLORS.paper, letterSpacing: 0.5, textTransform: 'uppercase' }}>Custom</span>
      )}
      {!isCustom && isEdited && (
        <span style={{ fontFamily: SW_FONTS.mono, fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 3, background: SW_COLORS.thread, color: SW_COLORS.ink, letterSpacing: 0.5, textTransform: 'uppercase' }}>Edited</span>
      )}
    </div>
  );
}

function GroupTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: SW_FONTS.mono,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        color: SW_COLORS.muted,
        marginBottom: 10,
        paddingBottom: 6,
        borderBottom: `1px solid ${SW_COLORS.line}`,
      }}
    >
      {children}
    </div>
  );
}
