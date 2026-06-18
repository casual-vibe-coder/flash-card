// Persistence abstraction. Pass config.store with async { get, set, remove } to use your
// own DB (e.g. your flashcard app's storage). Otherwise it auto-selects the best available:
//   window.storage (Claude artifact)  →  localStorage  →  in-memory.
// Values are JSON-serializable arrays of { q, a, en, done? }.

export function createStore(custom) {
  if (custom) return custom;

  if (typeof window !== "undefined" && window.storage) {
    return {
      async get(k) {
        try { const r = await window.storage.get(k, false); return r && r.value ? JSON.parse(r.value) : null; }
        catch (_) { return null; }
      },
      async set(k, v) { try { await window.storage.set(k, JSON.stringify(v), false); } catch (_) {} },
      async remove(k) { try { await window.storage.delete(k, false); } catch (_) {} },
    };
  }

  if (typeof localStorage !== "undefined") {
    return {
      async get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
      async set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
      async remove(k) { try { localStorage.removeItem(k); } catch (_) {} },
    };
  }

  const mem = new Map();
  return {
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async set(k, v) { mem.set(k, v); },
    async remove(k) { mem.delete(k); },
  };
}
