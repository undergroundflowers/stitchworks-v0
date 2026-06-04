/**
 * Best-effort key/value flags that never throw. Tries localStorage
 * (persists across sessions) → sessionStorage (persists across reloads in
 * the same tab) → an in-memory map (this page load only).
 *
 * Why: Safari private mode and some embedded/iframe contexts throw on
 * localStorage access. The onboarding-dismissed flag used a bare
 * try/catch that fell back to "show onboarding" — so private-mode users
 * re-saw the onboarding modal on every refresh. Routing the flag through
 * sessionStorage keeps the dismissal sticky for the tab even when
 * localStorage is blocked, without crashing.
 *
 * This is intentionally tiny and synchronous — it's for small UI flags, not
 * the project/twin stores (those move to IndexedDB in the database phase).
 */

const memory = new Map<string, string>();

function backends(): Storage[] {
  const out: Storage[] = [];
  try {
    if (typeof localStorage !== 'undefined') out.push(localStorage);
  } catch {
    /* blocked — skip */
  }
  try {
    if (typeof sessionStorage !== 'undefined') out.push(sessionStorage);
  } catch {
    /* blocked — skip */
  }
  return out;
}

/** Read a flag, checking each backend in order, then the in-memory fallback. */
export function getFlag(key: string): string | null {
  for (const store of backends()) {
    try {
      const v = store.getItem(key);
      if (v !== null) return v;
    } catch {
      /* try next backend */
    }
  }
  return memory.get(key) ?? null;
}

/** Write a flag to the first backend that accepts it; memory as last resort. */
export function setFlag(key: string, value: string): void {
  for (const store of backends()) {
    try {
      store.setItem(key, value);
      return;
    } catch {
      /* try next backend */
    }
  }
  memory.set(key, value);
}
