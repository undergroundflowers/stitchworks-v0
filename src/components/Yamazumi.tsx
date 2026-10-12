import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_TYPE } from '../design/tokens';
import { alpha } from '../design/color-utils';
import type { Operation } from '../domain';
import type { BalanceStation } from '../domain/line-balance';

/**
 * Yamazumi chart for the line the user built.
 *
 * One bar per workstation, in flow order, drawn at the pace that station will
 * actually hold — `cycleMin`, minutes per piece, after skill efficiency,
 * operator sharing and the parallel-channel count. Two reference lines cross
 * it: PITCH (what every bar would be if the work were perfectly spread) and,
 * when the user has stated a target, TAKT (what demand requires).
 *
 * ── What this used to be ──────────────────────────────────────────────────
 * A stacked chart of *operators*, packed by a balancing heuristic out of a
 * garment template, with drag-to-move-operations between bars. It described a
 * line that did not exist: the twin binds exactly one operation to a
 * workstation, so there is no arrangement of the user's floor in which a bar
 * holds two segments and no gesture by which an operation moves between two
 * bars. The lever that IS real is the channel count at a station, so that is
 * the lever this chart carries.
 *
 * A bar taller than its dashed nominal tick is a station whose SMV is not the
 * whole story — a shared operator or a slow skill rating is inflating it. That
 * mark is the answer to "where did this number come from".
 *
 * Pure HTML, no SVG. The plot, the station names and the ± channel controls
 * are three rows of one CSS grid sharing a single column template, so they
 * stay aligned at any width and scroll together on a long line.
 */

export interface YamazumiProps {
  /** Stations in flow order, from `buildLineBalance`. */
  stations: BalanceStation[];
  /** Perfect-balance target, min/piece. Drawn as the primary reference line. */
  pitchMin: number;
  /** Demand-derived takt, min/piece. Omitted when no target is set. */
  taktMin?: number | null;
  /** Chart height in pixels (the bars area). */
  height?: number;
  /** Station the reader is being pointed at — e.g. from a WHAT-TO-FIX row. */
  highlightWsId?: string | null;
  /** When provided, each bar carries a ± control for its channel count. */
  onServersChange?: (wsId: string, next: number) => void;
}

/** Cap on channels per station — past this the bar is a pool, not a station. */
const MAX_SERVERS = 12;

export function Yamazumi({
  stations,
  pitchMin,
  taktMin,
  height = 300,
  highlightWsId,
  onServersChange,
}: YamazumiProps) {
  const cycles = stations.map((s) => s.cycleMin);
  const bottleneckMin = cycles.length > 0 ? Math.max(...cycles) : 0;
  // Head-room above the tallest bar so its value label has somewhere to sit.
  //
  // Takt deliberately does NOT participate in the scale. A modest target
  // produces a takt many times the bottleneck — ask for 1 piece a shift and
  // takt is 480 min against bars under a minute — and scaling to it would
  // flatten every bar to a hairline to make room for a line that only says
  // "you have plenty of slack". When takt lands above the plot it is reported
  // as a chip instead; when it lands inside (the case that matters, because
  // that is where stations start missing it) it is drawn.
  const yMax = Math.max(bottleneckMin, pitchMin, 0.05) * 1.18;
  const taktOnChart = taktMin != null && taktMin > 0 && taktMin <= yMax;
  const taktAboveChart = taktMin != null && taktMin > yMax;

  const ticks = niceTicks(yMax);
  // Label precision follows the step, so a 100-minute axis reads "100" rather
  // than "100.00" and a 0.01-minute one keeps its digits.
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : yMax;
  const tickDecimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;

  if (stations.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          border: `1px dashed ${SW_COLORS.line}`,
          borderRadius: SW_RADIUS.sm,
          ...SW_TYPE.caption,
          color: SW_COLORS.muted,
        }}
      >
        No station on this line carries an operation yet.
      </div>
    );
  }

  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / yMax) * 100))}%`;

  /**
   * One grid template, shared by the plot, the station labels and the channel
   * steppers, so a column stays a column at any width.
   *
   * `minmax(34, 1fr)` is what makes the chart both fill a narrow line and
   * scroll a long one: with room to spare the tracks share it equally, and
   * past ~28 stations they stop shrinking and the shared scroll container
   * takes over. All three rows live inside that one container — the steppers
   * used to sit in a second one, so scrolling the bars left the ± controls
   * behind and every station ended up next to another station's button.
   */
  const cols = `repeat(${stations.length}, minmax(34px, 1fr))`;
  const rowStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: cols,
    columnGap: 4,
    padding: '0 8px',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr' }}>
        {/* y-axis — outside the scroll container so it stays put. */}
        <div style={{ position: 'relative', height, borderRight: `1px solid ${SW_COLORS.line}` }}>
          {ticks.map((v) => (
            <div
              key={v}
              style={{
                position: 'absolute',
                right: 8,
                bottom: `calc(${pct(v)} - 6px)`,
                fontFamily: SW_FONTS.mono,
                fontSize: 9,
                fontWeight: 700,
                color: SW_COLORS.muted,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {v.toFixed(tickDecimals)}
            </div>
          ))}
          <div
            style={{
              position: 'absolute',
              left: 4,
              top: '50%',
              transform: 'translate(-50%, -50%) rotate(-90deg)',
              fontFamily: SW_FONTS.mono,
              fontSize: 10,
              fontWeight: 700,
              color: SW_COLORS.muted,
              whiteSpace: 'nowrap',
            }}
          >
            MIN / PIECE
          </div>
        </div>

        <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
          {/* Plot — gridlines and reference lines are absolutely positioned,
              so they sit outside the grid flow and span the full column set. */}
          <div style={{ ...rowStyle, position: 'relative', height, alignItems: 'end' }}>
            {ticks.map((v) => (
              <div
                key={v}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: pct(v),
                  height: 1,
                  background: v === 0 ? SW_COLORS.line : SW_COLORS.lineSoft,
                  pointerEvents: 'none',
                }}
              />
            ))}

            <ReferenceLine
              value={pitchMin}
              yMax={yMax}
              color={SW_COLORS.brand}
              label="PITCH"
              title="Σ work content ÷ Σ channels — the height every bar would have if the work were perfectly spread. Not takt: this is what the line contains, not what demand asks for."
            />
            {taktOnChart && (
              <ReferenceLine
                value={taktMin!}
                yMax={yMax}
                color={taktMin! >= bottleneckMin ? SW_COLORS.ok : SW_COLORS.alarm}
                label="TAKT"
                align="left"
                title="Shift minutes ÷ target pieces — the pace demand requires. Any bar above this line cannot keep up."
              />
            )}
            {taktAboveChart && (
              <div
                title="Takt is slower than every station on this line, so it would sit off the top of the chart. The line has capacity to spare against this target."
                style={{
                  position: 'absolute',
                  left: 8,
                  top: 4,
                  zIndex: 3,
                  padding: '1px 5px',
                  borderRadius: 2,
                  border: `1px solid ${SW_COLORS.ok}`,
                  background: alpha(SW_COLORS.paper, 0.75),
                  fontFamily: SW_FONTS.mono,
                  fontSize: 10,
                  fontWeight: 800,
                  color: SW_COLORS.ok,
                  cursor: 'help',
                }}
              >
                TAKT {taktMin!.toFixed(3)} ↑ off chart — every station beats it
              </div>
            )}

            {stations.map((st) => (
              <Bar
                key={st.wsId}
                station={st}
                yMax={yMax}
                isBottleneck={st.cycleMin >= bottleneckMin - 1e-9}
                overTakt={taktMin != null && taktMin > 0 && st.cycleMin > taktMin}
                highlighted={highlightWsId === st.wsId}
              />
            ))}
          </div>

          {/* Station names, on their own row so a long name can be clipped
              without the bar above it changing size. */}
          <div style={{ ...rowStyle, marginTop: 3 }}>
            {stations.map((st) => (
              <div
                key={st.wsId}
                title={st.name}
                style={{
                  textAlign: 'center',
                  fontFamily: SW_FONTS.mono,
                  fontSize: 8,
                  fontWeight: 700,
                  color: st.cycleMin >= bottleneckMin - 1e-9 ? SW_COLORS.alarm : SW_COLORS.muted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {st.name}
              </div>
            ))}
          </div>

          {onServersChange && (
            <div style={{ ...rowStyle, marginTop: 5 }}>
              {stations.map((st) => (
                <ServersStepper key={st.wsId} station={st} onChange={onServersChange} />
              ))}
            </div>
          )}
        </div>
      </div>

      <Legend hasTakt={taktMin != null && taktMin > 0} />
    </div>
  );
}

/**
 * Five to eight gridlines, stepped on the 1 / 2 / 5 × 10ⁿ ladder.
 *
 * The step used to come from a fixed if-chain over four magnitudes, so an axis
 * outside that range drew either two gridlines or several hundred DOM nodes.
 * This bounds the count at any scale, and returns a single zero tick rather
 * than looping forever on a NaN or infinite maximum.
 */
function niceTicks(yMax: number): number[] {
  if (!Number.isFinite(yMax) || yMax <= 0) return [0];
  const raw = yMax / 7;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = 0; v <= yMax + 1e-9 && out.length < 24; v += step) {
    out.push(Number(v.toFixed(4)));
  }
  return out;
}

/** One dashed horizontal reference line with a caption riding above it. */
function ReferenceLine({
  value,
  yMax,
  color,
  label,
  title,
  align = 'right',
}: {
  value: number;
  yMax: number;
  color: string;
  label: string;
  title: string;
  align?: 'left' | 'right';
}) {
  const bottom = `${Math.max(0, Math.min(100, (value / yMax) * 100))}%`;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom,
          height: 0,
          borderTop: `1.5px dashed ${color}`,
          pointerEvents: 'none',
          zIndex: 2,
        }}
      />
      <div
        title={title}
        style={{
          position: 'absolute',
          [align]: 6,
          bottom: `calc(${bottom} + 4px)`,
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 800,
          color,
          zIndex: 3,
          background: alpha(SW_COLORS.paper, 0.75),
          padding: '0 4px',
          borderRadius: 2,
          cursor: 'help',
        }}
      >
        {label} {value.toFixed(3)}
      </div>
    </>
  );
}

function Bar({
  station: st,
  yMax,
  isBottleneck,
  overTakt,
  highlighted,
}: {
  station: BalanceStation;
  yMax: number;
  isBottleneck: boolean;
  overTakt: boolean;
  highlighted: boolean;
}) {
  // Where the bar WOULD sit on bulletin SMV alone, once split across its
  // channels. When it differs from `cycleMin`, skill or operator sharing is
  // the difference — and that is exactly the question "where does this number
  // come from" is asking.
  const nominalPerChannel = st.nominalMin / st.servers;
  const inflated = st.cycleMin > nominalPerChannel + 1e-9;
  const deflated = st.cycleMin < nominalPerChannel - 1e-9;
  const fill = colorForCategory(st.op.category);
  const barColor = overTakt || isBottleneck ? SW_COLORS.alarm : fill;

  const why: string[] = [`SMV ${st.nominalMin.toFixed(3)} min`];
  if (st.skillEff !== 1) why.push(`skill ×${st.skillEff.toFixed(2)}`);
  if (st.shareFrac < 1) why.push(`operator ${Math.round(st.shareFrac * 100)} % of shift`);
  if (st.servers > 1) why.push(`÷ ${st.servers} channels`);

  return (
    <div
      title={
        `${st.name}\n${st.op.code ? `${st.op.code} · ` : ''}${st.op.name} · ${st.op.machineCode}\n` +
        `${why.join('  ·  ')}\n= ${st.cycleMin.toFixed(3)} min/pc  →  ${st.capacityPerHr.toFixed(0)} pcs/hr` +
        `\nbundle ${st.bundleSize} pc` +
        (st.staffed !== st.servers ? `\n⚠ rostered for ${st.staffed}, run as ${st.servers}` : '')
      }
      style={{
        height: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        position: 'relative',
        background: highlighted ? alpha(SW_COLORS.brand, 0.14) : 'transparent',
        outline: highlighted ? `1px solid ${SW_COLORS.brand}` : 'none',
        borderRadius: SW_RADIUS.sm,
      }}
    >
      {/* Value label */}
      <div
        style={{
          position: 'absolute',
          top: `calc(${100 - (st.cycleMin / yMax) * 100}% - 15px)`,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: SW_FONTS.mono,
          fontSize: 9,
          fontWeight: 700,
          color: isBottleneck || overTakt ? SW_COLORS.alarm : SW_COLORS.ink,
          pointerEvents: 'none',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {st.cycleMin.toFixed(2)}
      </div>

      {/* The dashed nominal tick — only drawn when it says something. */}
      {(inflated || deflated) && (
        <div
          style={{
            position: 'absolute',
            left: 2,
            right: 2,
            bottom: `${Math.min(100, (nominalPerChannel / yMax) * 100)}%`,
            height: 0,
            borderTop: `1px dashed ${SW_COLORS.ink}`,
            opacity: 0.65,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}

      <div
        style={{
          height: `${Math.min(100, (st.cycleMin / yMax) * 100)}%`,
          width: '100%',
          background: barColor,
          borderRadius: `${SW_RADIUS.sm}px ${SW_RADIUS.sm}px 0 0`,
          borderTop: `1px solid ${alpha(SW_COLORS.ink, 0.45)}`,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          color: SW_COLORS.paper,
          fontFamily: SW_FONTS.mono,
          fontSize: 8,
          fontWeight: 800,
          overflow: 'hidden',
          userSelect: 'none',
          cursor: 'help',
        }}
      >
        <span style={{ padding: '0 1px 2px', writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap' }}>
          {st.op.code ?? st.op.name.slice(0, 6)}
        </span>
      </div>
    </div>
  );
}

/** ± control writing the station's parallel-channel count. */
function ServersStepper({
  station: st,
  onChange,
}: {
  station: BalanceStation;
  onChange: (wsId: string, next: number) => void;
}) {
  const btn = (enabled: boolean): React.CSSProperties => ({
    width: 15,
    height: 16,
    lineHeight: '14px',
    padding: 0,
    border: `1px solid ${SW_COLORS.line}`,
    borderRadius: 3,
    background: 'transparent',
    color: enabled ? SW_COLORS.ink : SW_COLORS.faint,
    fontFamily: SW_FONTS.mono,
    fontSize: 11,
    fontWeight: 800,
    cursor: enabled ? 'pointer' : 'default',
  });
  const canDown = st.servers > 1;
  const canUp = st.servers < MAX_SERVERS;
  return (
    <div
      style={{
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
      }}
    >
      <button
        type="button"
        disabled={!canDown}
        onClick={() => canDown && onChange(st.wsId, st.servers - 1)}
        title={`Remove a channel from ${st.name} (c ${st.servers} → ${st.servers - 1})`}
        aria-label={`Remove a channel from ${st.name}`}
        style={btn(canDown)}
      >
        −
      </button>
      <span
        title={`${st.servers} parallel channel${st.servers === 1 ? '' : 's'} — Kendall's c. This is what the engine runs.`}
        style={{
          fontFamily: SW_FONTS.mono,
          fontSize: 10,
          fontWeight: 800,
          color: st.staffed !== st.servers ? SW_COLORS.warn : SW_COLORS.muted,
          minWidth: 10,
          textAlign: 'center',
          cursor: 'help',
        }}
      >
        {st.servers}
      </span>
      <button
        type="button"
        disabled={!canUp}
        onClick={() => canUp && onChange(st.wsId, st.servers + 1)}
        title={`Add a channel at ${st.name} (c ${st.servers} → ${st.servers + 1})`}
        aria-label={`Add a channel at ${st.name}`}
        style={btn(canUp)}
      >
        +
      </button>
    </div>
  );
}

function Legend({ hasTakt }: { hasTakt: boolean }) {
  return (
    <div
      style={{
        marginTop: 14,
        display: 'flex',
        gap: 14,
        flexWrap: 'wrap',
        alignItems: 'center',
        ...SW_TYPE.overline,
        color: SW_COLORS.muted,
      }}
    >
      {LEGEND.map((l) => (
        <span key={l.cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, background: colorForCategory(l.cat), borderRadius: 2 }} />
          {l.label}
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 10, height: 10, background: SW_COLORS.alarm, borderRadius: 2 }} />
        {hasTakt ? 'PACER / OVER TAKT' : 'PACER'}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Where the bar would sit on bulletin SMV alone. A bar above its tick is inflated by a shared operator or a slow skill rating; below it, by a fast one.">
        <span style={{ width: 12, borderTop: `1px dashed ${SW_COLORS.ink}` }} />
        SMV ÷ C
      </span>
      <span style={{ marginLeft: 'auto', color: SW_COLORS.faint, textTransform: 'none', letterSpacing: 0 }}>
        Bars are minutes per piece, after skill, operator sharing and channels.
      </span>
    </div>
  );
}

const LEGEND: { cat: Operation['category']; label: string }[] = [
  { cat: 'sewing', label: 'SEW' },
  { cat: 'manual', label: 'MNL' },
  { cat: 'pressing', label: 'PRESS' },
  { cat: 'inspection', label: 'INSP' },
  { cat: 'fusing', label: 'FUSE' },
];

function colorForCategory(cat: Operation['category']): string {
  switch (cat) {
    case 'sewing':     return SW_COLORS.brand;
    case 'manual':     return SW_COLORS.muted;
    case 'pressing':   return SW_COLORS.thread;
    case 'inspection': return SW_COLORS.bobbin;
    case 'fusing':     return SW_COLORS.press;
    case 'cutting':    return SW_COLORS.fabric;
    case 'spreading':  return SW_COLORS.fabric;
    case 'embroidery': return SW_COLORS.trim;
    case 'finishing':  return SW_COLORS.ship;
    default:           return SW_COLORS.steel;
  }
}
