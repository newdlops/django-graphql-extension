import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MAX_PERSISTED_PARSE_CACHE_BYTES,
  ParseCache,
  CachedFileData,
} from '../../scanner/parseCache';

const CACHE_FILE_NAME = 'graphene-parse-cache.v9.json';

function makeMemento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const updates: Array<{ key: string; value: unknown }> = [];
  return {
    store,
    updates,
    memento: {
      get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown) => {
        updates.push({ key, value });
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
      keys: () => [...store.keys()],
    },
  };
}

function makeFileData(seed: string, className = ''): CachedFileData {
  return {
    contentHash: ParseCache.computeHash(seed),
    containsGraphene: className.length > 0,
    classes: className.length > 0
      ? [{ name: className, baseClasses: ['ObjectType'], lineNumber: 0 }]
      : [],
    schemaEntries: [],
    imports: {
      fromGraphene: [],
      fromGrapheneDjango: [],
      hasGrapheneImport: className.length > 0,
    },
  };
}

describe('ParseCache persistence', () => {
  let cacheDirectory: string;
  let memento: ReturnType<typeof makeMemento>;
  let cache: ParseCache;

  beforeEach(async () => {
    cacheDirectory = await mkdtemp(path.join(tmpdir(), 'django-graphql-parse-cache-'));
    memento = makeMemento();
    cache = new ParseCache(memento.memento as vscode.Memento, vscode.Uri.file(cacheDirectory));
  });

  afterEach(async () => {
    await rm(cacheDirectory, { force: true, recursive: true });
  });

  it('persists in a workspace-local file without writing parsed data to globalState', async () => {
    await cache.load();
    cache.set('/workspace/a.py', makeFileData('a', 'Query'));
    cache.set('/workspace/b.py', makeFileData('b'));
    await cache.save();

    expect(cache.size()).toBe(2);
    expect(memento.updates).toEqual([]);

    const fresh = new ParseCache(memento.memento as vscode.Memento, vscode.Uri.file(cacheDirectory));
    await fresh.load();
    expect(fresh.size()).toBe(2);
    expect(fresh.get('/workspace/a.py')?.classes[0]?.name).toBe('Query');
  });

  it('removes every historical Memento generation while preserving unrelated state', async () => {
    memento = makeMemento({
      'grapheneParseCache.v1': { old: true },
      'grapheneParseCache.v8': { recent: true },
      explorerPreference: 'keep-me',
    });
    cache = new ParseCache(memento.memento as vscode.Memento, vscode.Uri.file(cacheDirectory));

    await cache.load();

    expect([...memento.store.entries()]).toEqual([['explorerPreference', 'keep-me']]);
    expect(memento.updates).toEqual([
      { key: 'grapheneParseCache.v1', value: undefined },
      { key: 'grapheneParseCache.v8', value: undefined },
    ]);
  });

  it('does not rewrite the file when a same-content update leaves the snapshot unchanged', async () => {
    await cache.load();
    const data = makeFileData('same', 'Query');
    cache.set('/workspace/query.py', data);
    await cache.save();
    const cachePath = path.join(cacheDirectory, CACHE_FILE_NAME);
    const oldTime = new Date(1_000);
    await utimes(cachePath, oldTime, oldTime);

    cache.set('/workspace/query.py', makeFileData('same', 'ChangedButSameSourceHash'));
    await cache.save();

    expect((await stat(cachePath)).mtimeMs).toBe(oldTime.getTime());
  });

  it('caps the persisted snapshot while retaining the full in-memory cache', async () => {
    await cache.load();
    const largeClassName = 'X'.repeat(4_096);
    for (let index = 0; index < 2_500; index += 1) {
      cache.set(`/workspace/types-${index.toString()}.py`, makeFileData(index.toString(), largeClassName));
    }
    await cache.save();

    const cachePath = path.join(cacheDirectory, CACHE_FILE_NAME);
    const fileStat = await stat(cachePath);
    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as { entries: unknown[] };
    expect(fileStat.size).toBeLessThanOrEqual(MAX_PERSISTED_PARSE_CACHE_BYTES);
    expect(cache.size()).toBe(2_500);
    expect(persisted.entries.length).toBeLessThan(cache.size());

    const fresh = new ParseCache(memento.memento as vscode.Memento, vscode.Uri.file(cacheDirectory));
    await fresh.load();
    expect(fresh.size()).toBe(persisted.entries.length);
  });

  it('prunes only the scanned project and retains sibling project entries', async () => {
    await cache.load();
    cache.set('/workspace/project-a/keep.py', makeFileData('a-keep'));
    cache.set('/workspace/project-a/stale.py', makeFileData('a-stale'));
    cache.set('/workspace/project-b/keep.py', makeFileData('b-keep'));

    cache.pruneExcept(new Set(['/workspace/project-a/keep.py']), '/workspace/project-a');

    expect(cache.get('/workspace/project-a/keep.py')).toBeDefined();
    expect(cache.get('/workspace/project-a/stale.py')).toBeUndefined();
    expect(cache.get('/workspace/project-b/keep.py')).toBeDefined();
  });

  it('clears in-memory data and the exact workspace cache file', async () => {
    await cache.load();
    cache.set('/workspace/a.py', makeFileData('a'));
    await cache.save();

    await cache.clearAll();

    expect(cache.size()).toBe(0);
    await expect(readFile(path.join(cacheDirectory, CACHE_FILE_NAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const fresh = new ParseCache(memento.memento as vscode.Memento, vscode.Uri.file(cacheDirectory));
    await fresh.load();
    expect(fresh.size()).toBe(0);
  });

  it('is a no-op when an empty cache has no storage file', async () => {
    await cache.load();
    await expect(cache.clearAll()).resolves.not.toThrow();
    expect(cache.size()).toBe(0);
  });

  it('keeps the in-memory cache usable when workspace storage is unavailable', async () => {
    const nonDirectoryPath = path.join(cacheDirectory, 'not-a-directory');
    await writeFile(nonDirectoryPath, 'occupied', 'utf8');
    const isolated = new ParseCache(
      memento.memento as vscode.Memento,
      vscode.Uri.file(nonDirectoryPath),
    );
    await isolated.load();
    isolated.set('/workspace/a.py', makeFileData('a'));

    await expect(isolated.save()).resolves.not.toThrow();
    await expect(isolated.save()).resolves.not.toThrow();
    expect(isolated.get('/workspace/a.py')).toBeDefined();
  });
});
