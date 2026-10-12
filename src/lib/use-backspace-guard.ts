import { useEffect } from 'react';

/**
 * Stop BACKSPACE from navigating the browser back.
 *
 * Several browsers (Safari, older Firefox, most embedded webviews) still map a
 * bare Backspace to "go back" whenever the key is pressed outside a text field.
 * In a single-page app that reads as the whole application throwing itself away:
 * one stray Backspace on the canvas — or in any control that isn't a real text
 * box, like a dropdown trigger or a station tile — and the user lands back on
 * the home menu with their surface gone. Chrome dropped the shortcut years ago,
 * which is why this never showed up in dev.
 *
 * The guard is deliberately blunt: cancel the *default action* of every
 * Backspace that isn't landing in something editable. It never stops the event
 * propagating, so the app's own Backspace handlers (delete the selected
 * station, delete the selected connector) still run exactly as before — they
 * are reading the key, not relying on its default.
 *
 * Capture phase, because a handler further in could stop propagation before the
 * event ever reached a bubble-phase listener on window.
 */
export function useBackspaceGuard(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Backspace' || e.defaultPrevented) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

/** Input types that hold text a Backspace is allowed to delete. */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date',
  'datetime-local', 'month', 'week', 'time',
]);

/** True when Backspace in `target` means "delete a character", not "go back". */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).disabled && !(el as HTMLTextAreaElement).readOnly;
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    // A checkbox or a radio has no text to delete, so a Backspace landing on
    // one is a navigation in every browser that still ships the shortcut.
    return !input.disabled && !input.readOnly && TEXT_INPUT_TYPES.has(input.type);
  }
  return el.isContentEditable || Boolean(el.closest('[contenteditable="true"]'));
}
