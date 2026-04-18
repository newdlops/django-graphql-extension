import * as vscode from 'vscode';
import * as crypto from 'crypto';

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

const CACHE_KEY = 'grapheneParseCache.v8';

export class ParseCache {
  private cache = new Map<string, CachedFileData>();
  private dirty = false;

  constructor(private globalState: vscode.Memento) {}

  load(): void {
    const raw = this.globalState.get<Record<string, CachedFileData>>(CACHE_KEY);
    this.cache.clear();
    if (raw) {
      for (const [k, v] of Object.entries(raw)) {
        this.cache.set(k, v);
      }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const obj: Record<string, CachedFileData> = {};
    for (const [k, v] of this.cache) {
      obj[k] = v;
    }
    await this.globalState.update(CACHE_KEY, obj);
    this.dirty = false;
  }

  get(filePath: string): CachedFileData | undefined {
    return this.cache.get(filePath);
  }

  set(filePath: string, data: CachedFileData): void {
    this.cache.set(filePath, data);
    this.dirty = true;
  }

  delete(filePath: string): void {
    if (this.cache.delete(filePath)) {
      this.dirty = true;
    }
  }

  pruneExcept(validPaths: Set<string>): void {
    for (const key of [...this.cache.keys()]) {
      if (!validPaths.has(key)) {
        this.cache.delete(key);
        this.dirty = true;
      }
    }
  }

  /**
   * Drop every cached entry AND remove the persisted copy from globalState.
   * Used by the "Clear Parse Cache" command when the user wants to force a
   * full re-scan — e.g., after upgrading the extension or when debugging a
   * stale result. Intentionally async to await the globalState write so a
   * refresh triggered right after finds no leftover cache.
   */
  async clearAll(): Promise<void> {
    this.cache.clear();
    this.dirty = false;
    await this.globalState.update(CACHE_KEY, undefined);
  }

  /** Number of cached file entries — surfaced by the clear-cache command so the user sees what they invalidated. */
  size(): number {
    return this.cache.size;
  }

  static computeHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }
}
