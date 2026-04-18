// Covers ParseCache lifecycle — especially the clear-all path used by the
// "Django GraphQL: Clear Parse Cache" command. A stale cache after an
// extension upgrade was the root cause of a real UI bug (args missing from
// the Query Structure panel), so this behaviour is worth pinning down.

import { describe, it, expect, beforeEach } from 'vitest';
import { ParseCache, CachedFileData } from '../../scanner/parseCache';

// Minimal in-memory Memento stand-in — enough surface for ParseCache.
function makeMemento() {
  const store = new Map<string, unknown>();
  return {
    store,
    memento: {
      get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
      keys: () => [...store.keys()],
    },
  };
}

function makeFileData(hash: string): CachedFileData {
  return {
    contentHash: hash,
    containsGraphene: true,
    classes: [],
    schemaEntries: [],
    imports: { fromGraphene: [], fromGrapheneDjango: [], hasGrapheneImport: true },
  };
}

describe('ParseCache — clearAll / size', () => {
  let m: ReturnType<typeof makeMemento>;
  let cache: ParseCache;

  beforeEach(() => {
    m = makeMemento();
    cache = new ParseCache(m.memento as any);
    cache.load();
  });

  it('reports size and removes in-memory entries + persisted copy', async () => {
    cache.set('/a.py', makeFileData('h1'));
    cache.set('/b.py', makeFileData('h2'));
    await cache.save();

    expect(cache.size()).toBe(2);
    expect(m.store.size).toBeGreaterThan(0);

    await cache.clearAll();
    expect(cache.size()).toBe(0);
    expect(cache.get('/a.py')).toBeUndefined();
    // Persisted copy deleted — future loads start empty.
    const persistedKey = [...m.store.keys()][0];
    expect(persistedKey).toBeUndefined();
  });

  it('is a no-op on an empty cache (size stays 0, does not throw)', async () => {
    expect(cache.size()).toBe(0);
    await expect(cache.clearAll()).resolves.not.toThrow();
    expect(cache.size()).toBe(0);
  });

  it('a fresh load after clearAll sees no entries', async () => {
    cache.set('/a.py', makeFileData('h1'));
    await cache.save();
    await cache.clearAll();

    const fresh = new ParseCache(m.memento as any);
    fresh.load();
    expect(fresh.size()).toBe(0);
  });
});
