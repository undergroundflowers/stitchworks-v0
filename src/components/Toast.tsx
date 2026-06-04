import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS } from '../design/tokens';

/**
 * Transient, non-blocking notifications. Replaces the scattered `alert()`
 * calls that were used as success/error feedback — those froze the page on a
 * native browser chrome dialog that ignores the app's design tokens. Toasts
 * stack top-right, auto-dismiss, and are click-to-dismiss.
 *
 * Usage:
 *   const toast = useToast();
 *   toast({ kind: 'success', message: 'Project exported.' });
 *
 * Mounted once near the app root via <ToastProvider>. The quota-error window
 * event (QUOTA_EVENT) is also surfaced here by App so storage failures are
 * visible rather than console-only.
 */

export type ToastKind = 'success' | 'info' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  message: string;
  /** Auto-dismiss delay in ms. Default 4000. Pass 0 to require a manual click. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
}

type ToastFn = (opts: ToastOptions) => void;

const ToastContext = createContext<ToastFn | null>(null);

const KIND_STYLE: Record<ToastKind, { accent: string; glyph: string }> = {
  success: { accent: SW_COLORS.ok, glyph: '✓' },
  info: { accent: SW_COLORS.bobbin, glyph: 'i' },
  error: { accent: SW_COLORS.alarm, glyph: '!' },
};

// Module-level counter keeps ids unique without Date.now()/Math.random().
let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const push = useCallback<ToastFn>(
    (opts) => {
      const id = ++nextToastId;
      const kind = opts.kind ?? 'info';
      setItems((xs) => [...xs, { ...opts, id, kind }]);
      const duration = opts.duration ?? 4000;
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          top: 18,
          right: 18,
          zIndex: 10050,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 380,
          pointerEvents: 'none',
        }}
      >
        {items.map((t) => {
          const ks = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              data-sw-overlay=""
              onClick={() => dismiss(t.id)}
              title="Dismiss"
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: SW_COLORS.paper,
                // Explicit per-side borders (not `border` + `borderLeft`) so
                // React doesn't warn about mixing shorthand/longhand on rerender.
                borderTop: `1px solid ${SW_COLORS.line}`,
                borderRight: `1px solid ${SW_COLORS.line}`,
                borderBottom: `1px solid ${SW_COLORS.line}`,
                borderLeft: `4px solid ${ks.accent}`,
                borderRadius: SW_RADIUS.md,
                boxShadow: SW_SHADOWS.hi,
                padding: '12px 14px',
                fontFamily: SW_FONTS.body,
                fontSize: 13,
                lineHeight: 1.4,
                color: SW_COLORS.ink,
                animation: 'sw-toast-in 160ms ease-out',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: ks.accent,
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 800,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1,
                }}
              >
                {ks.glyph}
              </span>
              <span style={{ flex: 1 }}>{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Returns a `toast(opts)` function. If called outside <ToastProvider> it
 * degrades to a console warning rather than crashing the caller.
 */
export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return (opts: ToastOptions) => {
      // eslint-disable-next-line no-console
      console.warn(
        '[stitchworks] useToast() called outside <ToastProvider>:',
        opts.message,
      );
    };
  }
  return ctx;
}
