import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface CachedClassInfo {
  name: string;
  baseClasses: string[];
  lineNumber: number;
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

const CACHE_KEY = 'grapheneParseCache.v5';

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

  static computeHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }
}
