// Vitest setup. Runs in node, where `localStorage` doesn't exist — the
// persisted stores fall back to it when IndexedDB is unavailable, so without a
// polyfill their first write throws. A tiny in-memory shim keeps store-backed
// tests clean. (IndexedDB is left undefined; the adapter's idbCapable() check
// then routes through this localStorage shim.)
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const shim: Storage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  globalThis.localStorage = shim;
}
