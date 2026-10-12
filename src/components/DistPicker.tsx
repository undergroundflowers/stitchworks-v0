/**
 * DistPicker — the service-time distribution control.
 *
 * Five distributions used to sit in a wrapped `ToggleGroup`: a 5-chip strip
 * that broke onto two rows in every pane narrower than ~360px and, worse, told
 * the user nothing. "Erlang (Eₖ)" is a name, not a shape, and choosing between
 * five names is a memory test unless you already know the family.
 *
 * So it is a dropdown, and hovering a row draws the curve you would get if you
 * picked it — with that stage's own mean carried across, via `morphDist`, so
 * the preview is the real distribution rather than a stock illustration. The
 * graphic sits in one strip at the foot of the panel rather than inside each
 * row, so running the pointer down the list morphs a single drawing in place:
 * the flat block of a Uniform becoming the long tail of an Exponential is the
 * comparison the picker exists to make.
 */

import { SW_COLORS, SW_FONTS } from '../design/tokens';
import { alpha } from '../design/color-utils';
import { HudSelect } from './HudSelect';
import { DIST_OPTIONS, morphDist, type DistKind } from './queueParamFields';
import { describeDist, meanOf, type ServiceDist } from '../simulation';

/** Preview box, in SVG user units. Drawn at `width: 100%` of the panel. */
const W = 220;
const H = 44;
/** Inset so a curve that peaks at the top edge still shows its stroke. */
const PAD = 3;

/**
 * Probability density at `x`, for the kinds this picker offers.
 *
 * Deliberately mirrors `sample()` in `simulation/distributions.ts` rather than
 * the textbook parameterisation — a Uniform here is the engine's `mean ± mean·
 * variance`, not `[a, b]` — so the drawing is of the distribution that would
 * actually run. `det` has no density (it is a point mass) and is drawn as a
 * spike by the caller.
 */
function density(d: ServiceDist, x: number): number {
  switch (d.kind) {
    case 'exp':
      return x < 0 ? 0 : Math.exp(-x / d.mean) / d.mean;
    case 'uniform': {
      const half = d.mean * d.variance;
      if (half <= 0) return 0;
      return x >= d.mean - half && x <= d.mean + half ? 1 / (2 * half) : 0;
    }
    case 'erlang': {
      const k = Math.max(1, Math.floor(d.k));
      const lambda = k / d.mean;
      // Erlang-1 IS the exponential, and its density peaks at the origin —
      // returning 0 there would draw the one phase count that has no rise
      // with a notch out of its tallest point.
      if (x <= 0) return k === 1 ? lambda : 0;
      // Evaluated in logs: λ^k and (k-1)! both overflow well before k reaches
      // the phase counts a bundle-transfer stage uses.
      let logFactorial = 0;
      for (let i = 2; i < k; i++) logFactorial += Math.log(i);
      const logF =
        k * Math.log(lambda) + (k - 1) * Math.log(x) - lambda * x - logFactorial;
      return Math.exp(logF);
    }
    case 'normal': {
      if (d.std <= 0) return 0;
      const z = (x - d.mean) / d.std;
      return Math.exp(-0.5 * z * z) / (d.std * Math.SQRT2 * Math.sqrt(Math.PI));
    }
    default:
      return 0;
  }
}

/**
 * One distribution, drawn as a filled density curve.
 *
 * Every kind shares the x-domain `[0, 3.2·mean]` so the shapes are comparable
 * as the highlight moves between rows, and each curve is normalised to its own
 * peak so it fills the box — at 44px tall the useful signal is the silhouette,
 * not the area.
 */
export function DistShape({ dist }: { dist: ServiceDist }) {
  const mean = Math.max(1e-6, meanOf(dist));
  const xMax = mean * 3.2;
  const toX = (x: number) => PAD + (x / xMax) * (W - 2 * PAD);
  const baseline = H - PAD;

  let body;
  if (dist.kind === 'det') {
    // A point mass: no curve to draw, so it is the bar it actually is.
    const x = toX(dist.value);
    body = (
      <rect
        x={x - 1.5}
        y={PAD}
        width={3}
        height={baseline - PAD}
        fill={SW_COLORS.brand}
      />
    );
  } else {
    const N = 96;
    const ys: number[] = [];
    for (let i = 0; i <= N; i++) ys.push(density(dist, (i / N) * xMax));
    const peak = Math.max(...ys, 1e-12);
    const pts = ys.map((y, i) => {
      const px = PAD + (i / N) * (W - 2 * PAD);
      const py = baseline - (y / peak) * (baseline - PAD);
      return `${px.toFixed(2)},${py.toFixed(2)}`;
    });
    body = (
      <>
        <polygon
          points={`${PAD},${baseline} ${pts.join(' ')} ${W - PAD},${baseline}`}
          fill={alpha(SW_COLORS.brand, 0.16)}
        />
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={SW_COLORS.brand}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label={describeDist(dist)}
      style={{ display: 'block' }}
    >
      {/* Mean marker — the one reference line that makes the shapes readable
          against each other: same tick, different spread around it. */}
      <line
        x1={toX(mean)}
        y1={PAD}
        x2={toX(mean)}
        y2={baseline}
        stroke={SW_COLORS.muted}
        strokeWidth={1}
        strokeDasharray="2 3"
        opacity={0.7}
      />
      <line
        x1={PAD}
        y1={baseline}
        x2={W - PAD}
        y2={baseline}
        stroke={SW_COLORS.line}
        strokeWidth={1}
      />
      {body}
    </svg>
  );
}

/** The preview strip: curve plus the parameters it was drawn from. */
function DistPreview({ dist }: { dist: ServiceDist }) {
  return (
    <div style={{ padding: '2px 4px 4px' }}>
      <DistShape dist={dist} />
      <div
        style={{
          marginTop: 4,
          fontFamily: SW_FONTS.mono,
          fontSize: 9.5,
          color: SW_COLORS.muted,
          letterSpacing: '0.02em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {describeDist(dist)}
      </div>
    </div>
  );
}

export function DistPicker({
  dist,
  fallbackMean,
  editable = true,
  onChange,
}: {
  /** The distribution in force — supplies both the current value and the mean
   *  each preview is drawn with. */
  dist: ServiceDist;
  /** Mean to carry into a preview when `dist` has none worth keeping (a fresh
   *  station falls back to its bulletin SMV). */
  fallbackMean?: number;
  editable?: boolean;
  onChange: (kind: DistKind) => void;
}) {
  const mean = meanOf(dist) || fallbackMean || 1;
  return (
    <HudSelect<DistKind>
      value={dist.kind as DistKind}
      disabled={!editable}
      onChange={onChange}
      variant="light"
      size="sm"
      width="100%"
      title="Service-time distribution — hover an option to see its shape"
      options={DIST_OPTIONS.map((o) => ({
        ...o,
        // Morph rather than invent: the preview is the exact distribution the
        // click would produce, mean and all.
        preview: <DistPreview dist={morphDist(dist, o.value, mean)} />,
      }))}
    />
  );
}
