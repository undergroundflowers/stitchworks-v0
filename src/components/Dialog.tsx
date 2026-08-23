import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SW_COLORS, SW_FONTS, SW_RADIUS, SW_SHADOWS } from '../design/tokens';
import { Button, type ButtonVariant } from './Button';

/**
 * Styled modal dialog + a promise-based confirm() that replaces the native
 * window.confirm()/alert() the app used for destructive actions. Native
 * dialogs freeze the page, ignore the design tokens, and aren't keyboard- or
 * screen-reader-friendly. This panel is focus-managed (Esc cancels, Enter
 * confirms, backdrop click cancels) and matches the rest of the UI.
 *
 * Two ways to use it:
 *   1. Imperatively via the hook (the common case — drop-in for confirm()):
 *        const confirm = useConfirm();
 *        if (await confirm({ title: 'Delete?', message: '…', variant: 'danger' })) { … }
 *   2. Declaratively with the <Dialog> component when you need a controlled
 *      modal with custom body content.
 */

export interface DialogProps {
  open: boolean;
  title: string;
  /** Body content. Falls back to `message` when omitted. */
  children?: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  /** Pass `null` to hide the cancel button (alert-style, single action). */
  cancelLabel?: string | null;
  variant?: 'default' | 'danger';
  /** Panel width. Defaults to the confirm-sized 440px; pass a larger value
   *  for a dialog that holds a form rather than a sentence. */
  width?: number | string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Dialog({
  open,
  title,
  children,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  width = 440,
  onConfirm,
  onCancel,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to whatever was focused before the dialog opened.
      prevActive?.focus?.();
    };
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const confirmVariant: ButtonVariant = variant === 'danger' ? 'danger' : 'primary';

  return (
    <div
      data-sw-overlay=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10040,
        background: SW_COLORS.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        animation: 'sw-fade-in 120ms ease-out',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-sw-overlay=""
        style={{
          width: typeof width === 'number' ? `min(${width}px, 100%)` : width,
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
          background: SW_COLORS.paper,
          borderRadius: SW_RADIUS.lg,
          boxShadow: SW_SHADOWS.hi,
          border: `1px solid ${SW_COLORS.line}`,
          padding: 22,
          outline: 'none',
          fontFamily: SW_FONTS.body,
          animation: 'sw-pop-in 150ms cubic-bezier(0.2, 0.8, 0.3, 1)',
        }}
      >
        <div
          style={{
            fontFamily: SW_FONTS.display,
            fontSize: 17,
            color: SW_COLORS.ink,
            marginBottom: 8,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: SW_COLORS.muted,
            marginBottom: 20,
          }}
        >
          {children ?? message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {cancelLabel !== null && (
            <Button variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Imperative confirm() — promise-based, mounted once via <ConfirmProvider>.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  /** `null` hides the cancel button — an acknowledgement rather than a
   *  choice, for telling the user why something can't happen. */
  cancelLabel?: string | null;
  variant?: 'default' | 'danger';
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Ref mirror so settle() never calls resolve() inside a state updater
  // (which React double-invokes under StrictMode).
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      const p: PendingConfirm = { opts, resolve };
      pendingRef.current = p;
      setPending(p);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    pendingRef.current?.resolve(result);
    pendingRef.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={pending !== null}
        title={pending?.opts.title ?? 'Are you sure?'}
        message={pending?.opts.message}
        confirmLabel={pending?.opts.confirmLabel ?? 'Confirm'}
        cancelLabel={
          pending?.opts.cancelLabel === null ? null : (pending?.opts.cancelLabel ?? 'Cancel')
        }
        variant={pending?.opts.variant ?? 'default'}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * Returns an async `confirm(opts) => Promise<boolean>`. Resolves true when the
 * user confirms, false on cancel/Esc/backdrop. Degrades to native confirm()
 * if called outside <ConfirmProvider>.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    return async (opts) =>
      window.confirm(
        typeof opts.message === 'string'
          ? opts.message
          : opts.title ?? 'Are you sure?',
      );
  }
  return ctx;
}
