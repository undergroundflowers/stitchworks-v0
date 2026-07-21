/**
 * Colour helpers for deriving alpha/shade variants from design tokens.
 *
 * IMPORTANT: always call these at render time (inside the component body or
 * event handler), never hoist the result into a module-level const — the vibe
 * system mutates SW_COLORS in place, and a hoisted result goes permanently
 * stale (see Button's old VARIANTS bug).
 */

function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = hex.split('').map((ch) => parseInt(ch + ch, 16));
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) {
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return null;
}

/** `alpha('#0F1419', 0.45)` → `'rgba(15,20,25,0.45)'`. Accepts #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba(). */
export function alpha(color: string, a: number): string {
  const p = parseColor(color);
  if (!p) return color;
  return `rgba(${Math.round(p.r)},${Math.round(p.g)},${Math.round(p.b)},${Math.max(0, Math.min(1, a))})`;
}

/** Darken by factor `f` (0–1), e.g. `darken(c, 0.15)` = 15% darker. Prefer explicit deep tokens where they exist. */
export function darken(color: string, f: number): string {
  const p = parseColor(color);
  if (!p) return color;
  const k = 1 - Math.max(0, Math.min(1, f));
  return `rgba(${Math.round(p.r * k)},${Math.round(p.g * k)},${Math.round(p.b * k)},${p.a})`;
}
