import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { warn } from '../logger';

export interface CachedClassInfo {
  name: string;
  baseClasses: string[];
  lineNumber: number;
  /** True when the class was decorated with @dataclass (or @dataclasses.dataclass). */
  isDataclass?: boolean;
  /**
   * True when the class declaration was indented. Let proximity resolution
   * prefer top-level classes when a nested test double collides with the
   * canonical class name.
   */
  isNested?: boolean;
}

export interface CachedSchemaCall {
  queryRootName?: string;
  mutationRootName?: string;
}

export interface CachedImportInfo {
  fromGraphene: string[];
  fromGrapheneDjango: string[];
  hasGrapheneImport: boolean;
}

export interface CachedFileData {
  contentHash: string;
  containsGraphene: boolean;
  classes: CachedClassInfo[];
  schemaEntries: CachedSchemaCall[];
  imports: CachedImportInfo;
}

const CACHE_FORMAT_VERSION = 9;
const CACHE_FILE_NAME = `graphene-parse-cache.v${CACHE_FORMAT_VERSION}.json`;
const CACHE_FILE_PATTERN = /^graphene-parse-cache\.v\d+\.json$/u;
const LEGACY_MEMENTO_KEY_PATTERN = /^grapheneParseCache\.v(\d+)$/u;
export const MAX_PERSISTED_PARSE_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_PERSISTED_PARSE_CACHE_ENTRIES = 20_000;

interface PersistedParseCache {
  version: number;
  entries: [string, CachedFileData][];
}

/**
 * Workspace-local parse cache.
 *
 * Parsed file structures used to live in ExtensionContext.globalState. That state is one shared
 * SQLite row per extension, so several VS Code windows repeatedly replaced each other's multi-MB
 * cache and old cache-version keys accumulated in the same row. A workspace-scoped file avoids
 * both the central database write amplification and cross-window cache churn.
 */
export class ParseCache {
  private cache = new Map<string, CachedFileData>();
  private dirty = false;
  private persistedDigest: string | undefined;
  private persistenceDisabled = false;
  private revision = 0;
  private savePromise: Promise<void> | undefined;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly storageUri?: vscode.Uri,
  ) {}

  async load(): Promise<void> {
    this.cache.clear();
    this.dirty = false;
    this.persistedDigest = undefined;
    this.persistenceDisabled = false;
    this.revision = 0;

    await Promise.all([
      this.removeLegacyMementoCaches(),
      this.loadPersistedFile(),
    ]);
  }

  async save(): Promise<void> {
    if (this.savePromise) {
      await this.savePromise;
      return this.save();
    }
    if (!this.dirty) return;
    if (this.persistenceDisabled) {
      this.dirty = false;
      return;
    }

    const savePromise = this.saveSnapshot().catch((error: unknown) => {
      this.persistenceDisabled = true;
      this.dirty = false;
      warn(`[parseCache] Workspace cache persistence disabled for this session: ${describeError(error)}`);
    });
    this.savePromise = savePromise;
    try {
      await savePromise;
    } finally {
      if (this.savePromise === savePromise) this.savePromise = undefined;
    }
  }

  get(filePath: string): CachedFileData | undefined {
    return this.cache.get(filePath);
  }

  set(filePath: string, data: CachedFileData): void {
    if (this.cache.get(filePath)?.contentHash === data.contentHash) return;
    this.cache.set(filePath, data);
    this.markDirty();
  }

  delete(filePath: string): void {
    if (this.cache.delete(filePath)) this.markDirty();
  }

  /**
   * Removes stale entries inside one scanned project while retaining sibling project caches.
   * A workspace can contain several detected Django roots that share this one ParseCache.
   */
  pruneExcept(validPaths: ReadonlySet<string>, projectRoot?: string): void {
    for (const key of [...this.cache.keys()]) {
      if (projectRoot !== undefined && !isPathInside(projectRoot, key)) continue;
      if (!validPaths.has(key)) {
        this.cache.delete(key);
        this.markDirty();
      }
    }
  }

  /** Drop every cached entry and every cache file owned by this workspace. */
  async clearAll(): Promise<void> {
    if (this.savePromise) await this.savePromise;
    this.cache.clear();
    this.dirty = false;
    this.persistedDigest = undefined;
    this.revision += 1;
    await Promise.all([
      this.removeLegacyMementoCaches(),
      this.removeCacheFiles(true),
    ]);
  }

  /** Number of cached file entries — surfaced by the clear-cache command. */
  size(): number {
    return this.cache.size;
  }

  /** Snapshot of {path → contentHash} used by the native scanner for cache hits. */
  snapshotHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of this.cache) out[key] = value.contentHash;
    return out;
  }

  /** Paths whose cached parse contains classes and therefore needs reconstruction text. */
  snapshotNonEmptyPaths(): string[] {
    const out: string[] = [];
    for (const [key, value] of this.cache) {
      if (value.classes.length > 0) out.push(key);
    }
    return out;
  }

  static computeHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  private markDirty(): void {
    this.dirty = true;
    this.revision += 1;
  }

  private async saveSnapshot(): Promise<void> {
    const snapshotRevision = this.revision;
    if (!this.storageUri) {
      if (this.revision === snapshotRevision) this.dirty = false;
      return;
    }

    const contents = serializeBoundedCache(this.cache);
    const digest = computeDigest(contents);
    if (digest === this.persistedDigest) {
      if (this.revision === snapshotRevision) this.dirty = false;
      return;
    }

    await mkdir(this.storageUri.fsPath, { recursive: true });
    const cachePath = path.join(this.storageUri.fsPath, CACHE_FILE_NAME);
    const temporaryPath = `${cachePath}.tmp-${process.pid.toString()}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporaryPath, contents, { mode: 0o600 });
      await rename(temporaryPath, cachePath);
    } catch (error) {
      await removeFileIfPresent(temporaryPath);
      throw error;
    }

    this.persistedDigest = digest;
    if (this.revision === snapshotRevision) this.dirty = false;
  }

  private async loadPersistedFile(): Promise<void> {
    if (!this.storageUri) return;
    await this.removeCacheFiles(false);
    const cachePath = path.join(this.storageUri.fsPath, CACHE_FILE_NAME);

    try {
      const fileStat = await stat(cachePath);
      if (!fileStat.isFile() || fileStat.size > MAX_PERSISTED_PARSE_CACHE_BYTES) {
        await removeFileBestEffort(cachePath);
        return;
      }
      const contents = await readFile(cachePath);
      if (contents.byteLength > MAX_PERSISTED_PARSE_CACHE_BYTES) {
        await removeFileBestEffort(cachePath);
        return;
      }
      const parsed: unknown = JSON.parse(contents.toString('utf8'));
      if (!isPersistedParseCache(parsed)) {
        await removeFileBestEffort(cachePath);
        return;
      }
      for (const [filePath, data] of parsed.entries) this.cache.set(filePath, data);
      this.persistedDigest = computeDigest(contents);
    } catch (error) {
      if (!isMissingFileError(error)) await removeFileBestEffort(cachePath);
    }
  }

  /** Removes all historical Memento keys so the central VS Code state row stays small. */
  private async removeLegacyMementoCaches(): Promise<void> {
    let keys: readonly string[];
    try {
      keys = this.globalState.keys();
    } catch {
      return;
    }

    const legacyKeys = keys
      .flatMap((key) => {
        const version = LEGACY_MEMENTO_KEY_PATTERN.exec(key)?.[1];
        return version === undefined ? [] : [{ key, version: Number(version) }];
      })
      .sort((left, right) => left.version - right.version);

    for (const { key } of legacyKeys) {
      try {
        await this.globalState.update(key, undefined);
      } catch {
        // Cache cleanup is best effort and must never prevent the explorer from activating.
      }
    }
  }

  /** Removes obsolete generations and abandoned atomic-write files from this exact cache folder. */
  private async removeCacheFiles(includeCurrent: boolean): Promise<void> {
    if (!this.storageUri) return;
    let entries;
    try {
      entries = await readdir(this.storageUri.fsPath, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.allSettled(entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const isCurrent = entry.name === CACHE_FILE_NAME;
      const isTemporary = entry.name.startsWith(`${CACHE_FILE_NAME}.tmp-`);
      const isObsoleteGeneration = CACHE_FILE_PATTERN.test(entry.name) && !isCurrent;
      if ((!includeCurrent && isCurrent) || (!isCurrent && !isTemporary && !isObsoleteGeneration)) {
        return [];
      }
      return [removeFileIfPresent(path.join(this.storageUri!.fsPath, entry.name))];
    }));
  }
}

/** Serializes the most useful entries first without ever crossing the on-disk byte ceiling. */
function serializeBoundedCache(cache: ReadonlyMap<string, CachedFileData>): Buffer {
  const prefix = `{"version":${CACHE_FORMAT_VERSION.toString()},"entries":[`;
  const suffix = ']}';
  const fragments: string[] = [];
  let byteLength = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);

  const entries = [...cache.entries()].sort((left, right) => {
    const usefulnessDifference = cacheUsefulness(right[1]) - cacheUsefulness(left[1]);
    return usefulnessDifference !== 0 ? usefulnessDifference : left[0].localeCompare(right[0]);
  });

  for (const entry of entries) {
    if (fragments.length >= MAX_PERSISTED_PARSE_CACHE_ENTRIES) break;
    const fragment = JSON.stringify(entry);
    const fragmentBytes = Buffer.byteLength(fragment) + (fragments.length === 0 ? 0 : 1);
    if (byteLength + fragmentBytes > MAX_PERSISTED_PARSE_CACHE_BYTES) continue;
    fragments.push(fragment);
    byteLength += fragmentBytes;
  }

  return Buffer.from(`${prefix}${fragments.join(',')}${suffix}`, 'utf8');
}

function cacheUsefulness(data: CachedFileData): number {
  if (data.containsGraphene || data.schemaEntries.length > 0) return 2;
  return data.classes.length > 0 ? 1 : 0;
}

function isPersistedParseCache(value: unknown): value is PersistedParseCache {
  if (!isRecord(value) || value.version !== CACHE_FORMAT_VERSION || !Array.isArray(value.entries)) {
    return false;
  }
  if (value.entries.length > MAX_PERSISTED_PARSE_CACHE_ENTRIES) return false;

  const seenPaths = new Set<string>();
  return value.entries.every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [filePath, data] = entry;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || seenPaths.has(filePath)) {
      return false;
    }
    seenPaths.add(filePath);
    return isCachedFileData(data);
  });
}

function isCachedFileData(value: unknown): value is CachedFileData {
  if (!isRecord(value)) return false;
  return (
    typeof value.contentHash === 'string'
    && /^[0-9a-f]{64}$/u.test(value.contentHash)
    && typeof value.containsGraphene === 'boolean'
    && Array.isArray(value.classes)
    && value.classes.every(isCachedClassInfo)
    && Array.isArray(value.schemaEntries)
    && value.schemaEntries.every(isCachedSchemaCall)
    && isCachedImportInfo(value.imports)
  );
}

function isCachedClassInfo(value: unknown): value is CachedClassInfo {
  return (
    isRecord(value)
    && typeof value.name === 'string'
    && isStringArray(value.baseClasses)
    && Number.isInteger(value.lineNumber)
    && (value.isDataclass === undefined || typeof value.isDataclass === 'boolean')
    && (value.isNested === undefined || typeof value.isNested === 'boolean')
  );
}

function isCachedSchemaCall(value: unknown): value is CachedSchemaCall {
  return (
    isRecord(value)
    && (value.queryRootName === undefined || typeof value.queryRootName === 'string')
    && (value.mutationRootName === undefined || typeof value.mutationRootName === 'string')
  );
}

function isCachedImportInfo(value: unknown): value is CachedImportInfo {
  return (
    isRecord(value)
    && isStringArray(value.fromGraphene)
    && isStringArray(value.fromGrapheneDjango)
    && typeof value.hasGrapheneImport === 'boolean'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath))
  );
}

function computeDigest(contents: Uint8Array): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function removeFileBestEffort(filePath: string): Promise<void> {
  try {
    await removeFileIfPresent(filePath);
  } catch {
    // A cache file that cannot be removed must not prevent extension activation.
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
