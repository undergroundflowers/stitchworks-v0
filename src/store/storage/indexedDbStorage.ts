/**
 * IndexedDB-backed storage for zustand/persist — the "proper database" seam.
 *
 * Why this replaces the localStorage wrapper:
 *   localStorage caps at ~5 MB and writes synchronously; a multi-store save
 *   (project → twin → library) could blow the cap and silently drop the
 *   biggest write (the twin). IndexedDB has orders-of-magnitude more room and
 *   stores each store under its own key in a single object store.
 *
 * Two behaviours make the switch safe:
 *   1. Transparent migration — the first read of a key with no IndexedDB
 *      value pulls the existing localStorage value in, copies it to IndexedDB,
 *      then clears the localStorage copy. Existing users keep their factory;
 *      no explicit migration pass or user action needed.
 *   2. Graceful fallback — if IndexedDB is unavailable (private mode, old
 *      browsers) every operation transparently delegates to the existing
 *      quota-aware localStorage wrapper, so the app still works.
 *
 * This adapter is async (getItem/setItem return Promises). zustand/persist
 * supports async storage; the app gates its first render on hydration (see
 * useStoresHydrated) so the UI never flashes empty default state.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { StateStorage } from 'zustand/middleware';
import {
  quotaAwareLocalStorage,
  isQuotaError,
  type QuotaAwareStorageOptions,
} from '../persist-storage';

const DB_NAME = 'stitchworks';
const DB_VERSION = 1;
const STORE = 'keyval';

let dbPromise: Promise<IDBPDatabase> | null = null;
/** Set once an IndexedDB operation fails fatally so we stop retrying it. */
let idbBroken = false;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/** Cheap synchronous capability check before we attempt any IndexedDB call. */
function idbCapable(): boolean {
  if (idbBroken) return false;
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Whether persistence is currently using IndexedDB (vs the localStorage fallback). */
export function isUsingIndexedDb(): boolean {
  return idbCapable();
}

/**
 * Build a StateStorage backed by IndexedDB, falling back to the quota-aware
 * localStorage wrapper when IndexedDB can't be used. `opts.onQuotaError` is
 * honoured in both paths.
 */
export function indexedDbStorage(opts: QuotaAwareStorageOptions = {}): StateStorage {
  const fallback = quotaAwareLocalStorage(opts);

  return {
    getItem: async (key) => {
      if (!idbCapable()) return fallback.getItem(key);
      try {
        const db = await getDb();
        let value = (await db.get(STORE, key)) as string | undefined;
        if (value == null) {
          // One-time migration from the previous localStorage backend.
          let legacy: string | null = null;
          try {
            legacy = localStorage.getItem(key);
          } catch {
            /* localStorage blocked — nothing to migrate */
          }
          if (legacy != null) {
            try {
              await db.put(STORE, legacy, key);
              localStorage.removeItem(key); // free the capped localStorage slot
            } catch {
              /* best effort — still return the legacy value below */
            }
            value = legacy;
          }
        }
        return value ?? null;
      } catch {
        idbBroken = true;
        return fallback.getItem(key);
      }
    },

    setItem: async (key, value) => {
      if (!idbCapable()) return fallback.setItem(key, value);
      try {
        const db = await getDb();
        await db.put(STORE, value, key);
      } catch (err) {
        if (isQuotaError(err) && opts.onQuotaError) {
          const handled = opts.onQuotaError(key, value.length);
          if (handled === true) {
            try {
              const db = await getDb();
              await db.put(STORE, value, key);
              return;
            } catch {
              /* fall through to the localStorage fallback */
            }
          }
        }
        // IndexedDB write failed — don't lose the write, route it to localStorage.
        idbBroken = true;
        return fallback.setItem(key, value);
      }
    },

    removeItem: async (key) => {
      if (idbCapable()) {
        try {
          const db = await getDb();
          await db.delete(STORE, key);
        } catch {
          /* ignore */
        }
      }
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Approximate byte size of everything Stitchworks has stored in IndexedDB.
 * Used by the Settings storage status line. Returns 0 when IndexedDB is
 * unavailable (the fallback path).
 */
export async function estimateIdbBytes(): Promise<number> {
  if (!idbCapable()) return 0;
  try {
    const db = await getDb();
    const keys = await db.getAllKeys(STORE);
    let bytes = 0;
    for (const k of keys) {
      const v = (await db.get(STORE, k)) as unknown;
      if (typeof v === 'string') bytes += v.length;
    }
    return bytes;
  } catch {
    return 0;
  }
}
