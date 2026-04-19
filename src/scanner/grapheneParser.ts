import * as vscode from 'vscode';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { ClassInfo, FieldInfo, FieldArgInfo, SchemaInfo } from '../types';
import { ParseCache, CachedFileData } from './parseCache';
import { info } from '../logger';
import { isNativeAvailable, scanProjectNativeAsync } from './nativeScanner';

const GRAPHENE_BASE_CLASSES = new Set([
  'graphene.ObjectType',
  'graphene.Mutation',
  'graphene.InputObjectType',
  'graphene.Enum',
  'graphene.Interface',
  'graphene.Union',
  'ObjectType',
  'Mutation',
  'InputObjectType',
  'DjangoObjectType',
  'SerializerMutation',
  'ClientIDMutation',
  // Relay base classes — Connection classes become types; Node/ClientIDMutation
  // are interface/mutation markers.
  'Connection',
  'relay.Connection',
  'relay.Node',
  'relay.ClientIDMutation',
]);

const RELAY_CONNECTION_BASES = new Set(['Connection', 'relay.Connection']);

function isLibraryBaseClass(name: string): boolean {
  return name.startsWith('graphene.') || name.startsWith('relay.');
}

const MUTATION_BASE_CLASSES = new Set([
  'graphene.Mutation',
  'Mutation',
  'SerializerMutation',
  'ClientIDMutation',
]);

const GRAPHENE_FIELD_TYPES = new Set([
  'Field', 'List', 'NonNull', 'String', 'Int', 'Float', 'Boolean', 'ID',
  'DateTime', 'Date', 'Time', 'Decimal', 'JSONString', 'UUID',
  'DjangoListField', 'DjangoFilterConnectionField', 'DjangoConnectionField',
  'Argument', 'InputField',
]);

export interface ImportInfo {
  fromGraphene: Set<string>;
  fromGrapheneDjango: Set<string>;
  hasGrapheneImport: boolean;
}

export const EMPTY_IMPORTS: ImportInfo = {
  fromGraphene: new Set(),
  fromGrapheneDjango: new Set(),
  hasGrapheneImport: false,
};

interface RawClassInfo {
  name: string;
  baseClasses: string[];
  filePath: string;
  lineNumber: number;
  lines: string[];
  imports: ImportInfo;
  /**
   * True if the class is decorated with `@dataclass` (or `@dataclasses.dataclass`).
   * These classes use annotation-style field declarations (`id: IDStr`) rather
   * than `id = graphene.ID()`, so parseClassFields needs to know to parse them.
   */
  isDataclass: boolean;
  /**
   * True when the class declaration was indented — i.e. nested inside another
   * class or a function body. Nested classes are still useful to register
   * (e.g. a `class Foo(TypedDict)` arg container inside a Query class), but
   * when there's a name collision with a top-level class somewhere else in
   * the project, the top-level class is almost always the canonical one.
   * `resolveClassByProximity` uses this to break ties in favor of top-level
   * candidates. Without it, a dummy `class Query(ObjectType):` inside a
   * test case shadows the real production `Query`.
   */
  isNested: boolean;
}

interface SchemaCallInfo {
  queryRootName?: string;
  mutationRootName?: string;
  filePath: string;
}

// -------------------------------------------------------
// Proximity resolution helpers
// -------------------------------------------------------

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function resolveClassByProximity(
  name: string,
  rawMultiMap: Map<string, RawClassInfo[]>,
  contextFilePath: string,
): RawClassInfo | undefined {
  const candidates = rawMultiMap.get(name);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // When both top-level and nested declarations share a name, the top-level
  // one is almost always the canonical class — nested ones are usually test
  // doubles or private helpers. Filter first; if only nested remain we fall
  // back to them (e.g. a nested TypedDict arg container that only lives
  // inside one query class).
  const topLevel = candidates.filter((c) => !c.isNested);
  const pool = topLevel.length > 0 ? topLevel : candidates;
  if (pool.length === 1) return pool[0];

  // Score: prefer graphene-import files, then longest common path prefix.
  return pool.reduce((best, candidate) => {
    const bestHasImports = best.imports !== EMPTY_IMPORTS;
    const candidateHasImports = candidate.imports !== EMPTY_IMPORTS;
    if (candidateHasImports && !bestHasImports) return candidate;
    if (!candidateHasImports && bestHasImports) return best;

    const bestScore = commonPrefixLength(best.filePath, contextFilePath);
    const candidateScore = commonPrefixLength(candidate.filePath, contextFilePath);
    return candidateScore > bestScore ? candidate : best;
  });
}

// -------------------------------------------------------
// Main entry point
// -------------------------------------------------------

export async function parseGrapheneSchemas(rootDir: string, cache?: ParseCache): Promise<SchemaInfo[]> {
  const __tStart = performance.now();
  let __tReadFile = 0;
  let __tHash = 0;
  let __tSplit = 0;
  let __tCacheGet = 0;
  let __tParseFileData = 0;
  let __tReconstruct = 0;
  let __cacheHits = 0;
  let __cacheMisses = 0;
  let __totalBytes = 0;
  let __tFindFiles = 0;
  let __pyFileCount = 0;
  let __usedNative = false;
  let __nativeWalkMs = 0;
  let __nativeReadMs = 0;
  let __nativeParseMs = 0;

  // -------------------------------------------------------
  // Per-file parse function (used for both cache miss and fresh parse)
  // -------------------------------------------------------
  // Match both top-level and indented `class X(...):` declarations so nested
  // TypedDict / dataclass helpers (commonly used as arg containers inside
  // query classes) end up in rawMultiMap for later lookups.
  const classRegex = /^[ \t]*class\s+(\w+)\s*(?:\(([^)]*(?:\n[^)]*)*)\))?\s*:/gm;

  function extractClassesFromText(text: string): { name: string; baseClasses: string[]; lineNumber: number; isDataclass: boolean; isNested: boolean }[] {
    classRegex.lastIndex = 0;
    const results: { name: string; baseClasses: string[]; lineNumber: number; isDataclass: boolean; isNested: boolean }[] = [];
    const allLines = text.split('\n');
    let classMatch;
    while ((classMatch = classRegex.exec(text)) !== null) {
      const baseClassRaw = classMatch[2] ?? '';
      const baseClasses = baseClassRaw
        .replace(/#[^\n]*/g, '')
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && /^[\w.]+$/.test(b));
      const lineNumber = text.substring(0, classMatch.index).split('\n').length - 1;
      // Any leading whitespace on the class line means the declaration is
      // nested (inside another class or a def body). Used by proximity
      // resolution to break name collisions in favor of the top-level
      // definition — the canonical one in virtually every real codebase.
      const classLine = allLines[lineNumber] ?? '';
      const isNested = /^[ \t]+class\b/.test(classLine);
      // Look backwards for @dataclass / @dataclasses.dataclass decorator.
      // Skip comments and blank lines; stop at any non-decorator statement.
      let isDataclass = false;
      for (let i = lineNumber - 1; i >= 0; i--) {
        const prev = allLines[i].trim();
        if (prev === '' || prev.startsWith('#')) continue;
        if (prev.startsWith('@')) {
          // `@dataclass`, `@dataclass(...)`, `@dataclasses.dataclass`, or `@dataclasses.dataclass(...)`
          if (/^@\s*(?:dataclasses\s*\.\s*)?dataclass\b/.test(prev)) {
            isDataclass = true;
          }
          continue; // keep scanning for decorators stacked above
        }
        break;
      }
      results.push({ name: classMatch[1], baseClasses, lineNumber, isDataclass, isNested });
    }
    return results;
  }

  function parseFileData(text: string, filePath: string): CachedFileData {
    const containsGraphene = /graphene/i.test(text);
    const imports = containsGraphene ? parseImports(text) : undefined;

    // Build import alias map: alias → original name
    // e.g., "from foo import Bar as Baz" → aliasMap["Baz"] = "Bar"
    const aliasMap = new Map<string, string>();
    const aliasRegex = /from\s+\S+\s+import\s+([^)]+(?:\([^)]*\))?)/gs;
    let aliasMatch;
    while ((aliasMatch = aliasRegex.exec(text)) !== null) {
      const importBlock = aliasMatch[1].replace(/[()]/g, '');
      for (const part of importBlock.split(',')) {
        const asMatch = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          aliasMap.set(asMatch[2], asMatch[1]); // alias → original
        }
      }
    }

    const rawClasses = extractClassesFromText(text);
    // Resolve aliased base class names to original names
    const classes = rawClasses.map((c) => ({
      ...c,
      baseClasses: c.baseClasses.map((bc) => aliasMap.get(bc) ?? bc),
    }));
    const schemaEntries: { queryRootName?: string; mutationRootName?: string }[] = [];
    if (containsGraphene && imports) {
      detectSchemaCall(text, imports, (q, m) => {
        schemaEntries.push({ queryRootName: q, mutationRootName: m });
      });
    }
    return {
      contentHash: ParseCache.computeHash(text),
      containsGraphene,
      classes: classes.map((c) => ({
        name: c.name,
        baseClasses: c.baseClasses,
        lineNumber: c.lineNumber,
        isDataclass: c.isDataclass,
        isNested: c.isNested,
      })),
      schemaEntries,
      imports: imports
        ? { fromGraphene: [...imports.fromGraphene], fromGrapheneDjango: [...imports.fromGrapheneDjango], hasGrapheneImport: imports.hasGrapheneImport }
        : { fromGraphene: [], fromGrapheneDjango: [], hasGrapheneImport: false },
    };
  }

  // -------------------------------------------------------
  // Pass 1: Scan all files with cache. Only re-parse on cache miss.
  // -------------------------------------------------------
  const rawMultiMap = new Map<string, RawClassInfo[]>();
  const schemaEntries: SchemaCallInfo[] = [];
  const grapheneDirs = new Set<string>();
  const nonGrapheneFilePaths: string[] = [];
  // Store lines per file for later field parsing (only cache misses read the file)
  const fileLinesMap = new Map<string, string[]>();
  // When no cache is provided (or for non-graphene cache misses) we still need
  // to be able to load a file's classes into rawMultiMap later. Keep the
  // per-file CachedFileData around here so Pass 2 / saturation can read it.
  const perFileData = new Map<string, CachedFileData>();

  function addToRawMultiMap(raw: RawClassInfo): void {
    const existing = rawMultiMap.get(raw.name);
    if (existing) {
      existing.push(raw);
    } else {
      rawMultiMap.set(raw.name, [raw]);
    }
  }

  function reconstructFromCache(cached: CachedFileData, filePath: string, lines: string[]): void {
    const imports: ImportInfo = {
      fromGraphene: new Set(cached.imports.fromGraphene),
      fromGrapheneDjango: new Set(cached.imports.fromGrapheneDjango),
      hasGrapheneImport: cached.imports.hasGrapheneImport,
    };
    const effectiveImports = cached.containsGraphene ? imports : EMPTY_IMPORTS;

    for (const cls of cached.classes) {
      addToRawMultiMap({
        name: cls.name,
        baseClasses: cls.baseClasses,
        filePath,
        lineNumber: cls.lineNumber,
        lines,
        imports: effectiveImports,
        isDataclass: cls.isDataclass ?? false,
        // `isNested` is an optional field for back-compat with v7 cache
        // entries. Fall back to checking the raw line when not present so
        // upgrades don't silently mis-classify.
        isNested: cls.isNested ?? /^[ \t]+class\b/.test(lines[cls.lineNumber] ?? ''),
      });
    }

    if (cached.containsGraphene) {
      grapheneDirs.add(path.dirname(filePath));
      for (const entry of cached.schemaEntries) {
        schemaEntries.push({ queryRootName: entry.queryRootName, mutationRootName: entry.mutationRootName, filePath });
      }
    }
  }

  const __tFileLoopStart = performance.now();

  // ---------- native fast path (Rust NAPI) ----------
  // Rust walker + reader + 1차 파서를 한 번에 돌려 파일 루프를 대체한다.
  // tests (vitest)와 macOS arm64 이외의 플랫폼에서는 native 바이너리가 로드되지
  // 않으므로 `isNativeAvailable()`이 false를 반환하고 아래 JS fallback으로 내려간다.
  // AsyncTask를 사용해 Rust 작업이 libuv 워커 스레드에서 돌아가며 이 기간 동안
  // 익스텐션 호스트 메인 스레드가 VS Code UI에 계속 응답한다.
  const __nativeResult = isNativeAvailable()
    ? await scanProjectNativeAsync(rootDir, cache?.snapshotHashes() ?? {}, {
        cachedNonemptyPaths: cache?.snapshotNonEmptyPaths(),
      })
    : null;

  if (__nativeResult) {
    __usedNative = true;
    __nativeWalkMs = __nativeResult.stats.walkMs;
    __nativeReadMs = __nativeResult.stats.readMs;
    __nativeParseMs = __nativeResult.stats.parseMs;
    __pyFileCount = __nativeResult.stats.fileCount;

    if (cache) cache.pruneExcept(new Set(__nativeResult.files.map((f) => f.path)));

    for (const fr of __nativeResult.files) {
      const filePath = fr.path;
      const text = fr.text ?? '';
      __totalBytes += text.length;

      const __tSplitStart = performance.now();
      const lines = text.split('\n');
      fileLinesMap.set(filePath, lines);
      __tSplit += performance.now() - __tSplitStart;

      let fileData: CachedFileData;
      if (fr.cacheHit) {
        __cacheHits++;
        // Cache hit — Rust confirmed the content hash matches, so the
        // existing parsed entry is authoritative.
        fileData = cache!.get(filePath)!;
      } else {
        __cacheMisses++;
        const p = fr.data!;
        fileData = {
          contentHash: fr.contentHash,
          containsGraphene: p.containsGraphene,
          classes: p.classes.map((c) => ({
            name: c.name,
            baseClasses: c.baseClasses,
            lineNumber: c.lineNumber,
            isDataclass: c.isDataclass,
            isNested: c.isNested,
          })),
          schemaEntries: p.schemaEntries.map((s) => ({
            queryRootName: s.queryRootName,
            mutationRootName: s.mutationRootName,
          })),
          imports: {
            fromGraphene: p.imports.fromGraphene,
            fromGrapheneDjango: p.imports.fromGrapheneDjango,
            hasGrapheneImport: p.imports.hasGrapheneImport,
          },
        };
        cache?.set(filePath, fileData);
      }
      perFileData.set(filePath, fileData);

      const __tReconStart = performance.now();
      if (fileData.containsGraphene) {
        reconstructFromCache(fileData, filePath, lines);
      } else {
        nonGrapheneFilePaths.push(filePath);
      }
      __tReconstruct += performance.now() - __tReconStart;
    }
  } else {
    // ---------- JS fallback (original path) ----------
    // vitest 모킹된 vscode.workspace.fs 위에서 돌아가는 테스트와 native 바이너리가
    // 없는 플랫폼을 위한 그대로의 TypeScript 구현.
    const __tFindFilesStart = performance.now();
    const pyFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(rootDir, '**/*.py'),
      '{**/migrations/**,**/__pycache__/**,**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}',
    );
    __tFindFiles = performance.now() - __tFindFilesStart;
    __pyFileCount = pyFiles.length;

    if (cache) cache.pruneExcept(new Set(pyFiles.map((u) => u.fsPath)));

    for (const uri of pyFiles) {
      const filePath = uri.fsPath;

      // Read file content via fs API (fast, for hash computation)
      const __tReadStart = performance.now();
      const rawBytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(rawBytes).toString('utf-8');
      __tReadFile += performance.now() - __tReadStart;
      __totalBytes += rawBytes.byteLength;

      const __tHashStart = performance.now();
      const hash = ParseCache.computeHash(text);
      __tHash += performance.now() - __tHashStart;

      const __tSplitStart = performance.now();
      const lines = text.split('\n');
      fileLinesMap.set(filePath, lines);
      __tSplit += performance.now() - __tSplitStart;

      // Check cache
      const __tCacheStart = performance.now();
      const cached = cache?.get(filePath);
      __tCacheGet += performance.now() - __tCacheStart;
      if (cached && cached.contentHash === hash) {
        __cacheHits++;
        perFileData.set(filePath, cached);
        // Cache hit — reconstruct from cached data
        const __tReconStart = performance.now();
        if (cached.containsGraphene) {
          reconstructFromCache(cached, filePath, lines);
        } else {
          nonGrapheneFilePaths.push(filePath);
        }
        __tReconstruct += performance.now() - __tReconStart;
        continue;
      }

      __cacheMisses++;
      // Cache miss — full parse
      const __tParseStart = performance.now();
      const fileData = parseFileData(text, filePath);
      __tParseFileData += performance.now() - __tParseStart;
      cache?.set(filePath, fileData);
      perFileData.set(filePath, fileData);

      if (!fileData.containsGraphene) {
        nonGrapheneFilePaths.push(filePath);
        continue;
      }

      // Reconstruct runtime data from freshly parsed data
      const __tReconStart2 = performance.now();
      reconstructFromCache(fileData, filePath, lines);
      __tReconstruct += performance.now() - __tReconStart2;
    }
  }
  const __tFileLoop = performance.now() - __tFileLoopStart;

  // -------------------------------------------------------
  // Pass 2: Iteratively scan non-graphene files to find
  //         missing base classes referenced by known classes.
  // -------------------------------------------------------

  const __tPass2Start = performance.now();
  const grapheneDirPrefixes: string[] = [];
  for (const d of grapheneDirs) {
    grapheneDirPrefixes.push(d);
    let parent = d;
    while (parent.length > rootDir.length) {
      parent = path.dirname(parent);
      grapheneDirPrefixes.push(parent);
    }
  }
  const grapheneDirSet = new Set(grapheneDirPrefixes);

  function isInGrapheneTree(filePath: string): boolean {
    let dir = path.dirname(filePath);
    while (dir.length >= rootDir.length) {
      if (grapheneDirSet.has(dir)) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  }

  function getMissingBaseNames(): Set<string> {
    const missing = new Set<string>();
    for (const [, entries] of rawMultiMap) {
      for (const raw of entries) {
        for (const bc of raw.baseClasses) {
          if (!rawMultiMap.has(bc) && !GRAPHENE_BASE_CLASSES.has(bc) && !isLibraryBaseClass(bc)) {
            missing.add(bc);
          }
        }
      }
    }
    return missing;
  }

  function extractClassesFromCachedFile(filePath: string): void {
    const data = perFileData.get(filePath) ?? cache?.get(filePath);
    const lines = fileLinesMap.get(filePath);
    if (!lines || !data) return;
    for (const cls of data.classes) {
      addToRawMultiMap({
        name: cls.name,
        baseClasses: cls.baseClasses,
        filePath,
        lineNumber: cls.lineNumber,
        lines,
        imports: EMPTY_IMPORTS,
        isDataclass: cls.isDataclass ?? false,
        isNested: cls.isNested ?? /^[ \t]+class\b/.test(lines[cls.lineNumber] ?? ''),
      });
    }
  }

  let remainingPaths = nonGrapheneFilePaths.filter((f) => isInGrapheneTree(f));
  let missingNames = getMissingBaseNames();

  while (missingNames.size > 0 && remainingPaths.length > 0) {
    const stillRemaining: string[] = [];
    let foundAny = false;

    for (const filePath of remainingPaths) {
      const prevSize = rawMultiMap.size;
      extractClassesFromCachedFile(filePath);
      if (rawMultiMap.size > prevSize) {
        foundAny = true;
      } else {
        stillRemaining.push(filePath);
      }
    }

    if (!foundAny) break;
    const newMissing = getMissingBaseNames();
    if (newMissing.size >= missingNames.size) break;
    missingNames = newMissing;
    remainingPaths = stillRemaining;
  }

  if (missingNames.size > 0 && remainingPaths.length > 0) {
    for (const filePath of remainingPaths) {
      extractClassesFromCachedFile(filePath);
    }
  }

  // Final saturation: pull every graphene-tree non-graphene file's classes into
  // rawMultiMap. This is what lets `TypedField(SomeDataclass)` references find
  // their target @dataclass even when that dataclass lives in a module that
  // doesn't itself import graphene. The missing-base-class loop above is
  // targeted; this catch-all covers resolvedType references discovered later.
  for (const filePath of nonGrapheneFilePaths) {
    if (!isInGrapheneTree(filePath)) continue;
    extractClassesFromCachedFile(filePath);
  }

  const __tPass2 = performance.now() - __tPass2Start;

  // Save cache after all parsing is done
  const __tCacheSaveStart = performance.now();
  cache?.save();
  const __tCacheSave = performance.now() - __tCacheSaveStart;

  // -------------------------------------------------------
  // Determine which classes are graphene-related
  // by walking the inheritance graph transitively
  // -------------------------------------------------------

  const __tTransitiveStart = performance.now();

  // For quick single-lookup (pick first candidate as default)
  function getAnyRaw(name: string): RawClassInfo | undefined {
    const candidates = rawMultiMap.get(name);
    return candidates && candidates.length > 0 ? candidates[0] : undefined;
  }

  const allRawClasses: RawClassInfo[] = [];
  for (const [, entries] of rawMultiMap) {
    allRawClasses.push(...entries);
  }

  const grapheneClassNames = new Set<string>();

  // Seed: classes that directly extend a known graphene base
  for (const raw of allRawClasses) {
    if (isDirectGrapheneClass(raw)) {
      grapheneClassNames.add(raw.name);
    }
  }

  // Seed: classes that have .Field() registration pattern
  // These are mutation wrapper classes that may not extend graphene bases
  const dotFieldRegex = /^\s+\w+\s*=\s*\w+\.Field\s*\(/;
  for (const raw of allRawClasses) {
    if (grapheneClassNames.has(raw.name)) continue;
    const classEnd = Math.min(raw.lineNumber + 20, raw.lines.length);
    for (let li = raw.lineNumber + 1; li < classEnd; li++) {
      const line = raw.lines[li];
      if (/^\S/.test(line) && line.trim().length > 0) break; // end of class body
      if (dotFieldRegex.test(line)) {
        grapheneClassNames.add(raw.name);
        break;
      }
    }
  }

  // Expand bidirectionally
  let changed = true;
  while (changed) {
    changed = false;
    for (const raw of allRawClasses) {
      if (grapheneClassNames.has(raw.name)) {
        for (const bc of raw.baseClasses) {
          if (!grapheneClassNames.has(bc) && rawMultiMap.has(bc) && !GRAPHENE_BASE_CLASSES.has(bc)) {
            grapheneClassNames.add(bc);
            changed = true;
          }
        }
      } else {
        if (raw.baseClasses.some((bc) => grapheneClassNames.has(bc))) {
          grapheneClassNames.add(raw.name);
          changed = true;
        }
      }
    }
  }

  // Also pull in Schema()-referenced root names
  for (const entry of schemaEntries) {
    if (entry.queryRootName && rawMultiMap.has(entry.queryRootName)) {
      grapheneClassNames.add(entry.queryRootName);
    }
    if (entry.mutationRootName && rawMultiMap.has(entry.mutationRootName)) {
      grapheneClassNames.add(entry.mutationRootName);
    }
  }

  // Re-expand after adding schema roots
  changed = true;
  while (changed) {
    changed = false;
    for (const raw of allRawClasses) {
      if (grapheneClassNames.has(raw.name)) {
        for (const bc of raw.baseClasses) {
          if (!grapheneClassNames.has(bc) && rawMultiMap.has(bc) && !GRAPHENE_BASE_CLASSES.has(bc)) {
            grapheneClassNames.add(bc);
            changed = true;
          }
        }
      } else {
        if (raw.baseClasses.some((bc) => grapheneClassNames.has(bc))) {
          grapheneClassNames.add(raw.name);
          changed = true;
        }
      }
    }
  }

  const __tTransitive = performance.now() - __tTransitiveStart;

  // -------------------------------------------------------
  // Resolved-type expansion: pull @dataclass (or any other) classes into
  // grapheneClassNames when they are referenced as a field's resolvedType
  // (or used as an input argument type) from an already-known graphene class.
  // This is what lets `TypedField(list[MyDataclass])` surface MyDataclass even
  // though MyDataclass has no graphene base class.
  // -------------------------------------------------------
  const __tResolvedExpStart = performance.now();
  const expansionFieldsCache = new Map<string, FieldInfo[]>();
  function getExpansionFields(raw: RawClassInfo): FieldInfo[] {
    const key = `${raw.filePath}:${raw.lineNumber}:${raw.name}`;
    let cached = expansionFieldsCache.get(key);
    if (!cached) {
      cached = parseClassFields(raw.lines, raw.lineNumber, raw.filePath, raw.imports, raw.isDataclass);
      expansionFieldsCache.set(key, cached);
    }
    return cached;
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const name of [...grapheneClassNames]) {
      const raw = getAnyRaw(name);
      if (!raw) continue;
      const fields = getExpansionFields(raw);
      for (const f of fields) {
        if (f.resolvedType && rawMultiMap.has(f.resolvedType) && !grapheneClassNames.has(f.resolvedType)) {
          grapheneClassNames.add(f.resolvedType);
          changed = true;
        }
        if (f.args) {
          for (const a of f.args) {
            if (rawMultiMap.has(a.type) && !grapheneClassNames.has(a.type)) {
              grapheneClassNames.add(a.type);
              changed = true;
            }
          }
        }
      }
    }
  }

  const __tResolvedExp = performance.now() - __tResolvedExpStart;

  // -------------------------------------------------------
  // For each Schema entry, build an independent resolution
  // context using directory proximity. Merge all results.
  // -------------------------------------------------------

  const __tSchemaBuildStart = performance.now();
  let __tFinalFieldsParse = 0;
  let __tInheritedFields = 0;
  let __finalFieldsCount = 0;
  let __finalFieldsMemoHits = 0;
  // Cross-schema memo for parseClassFields. Keyed by the raw class declaration
  // (filePath + lineNumber), not name, because proximity resolution may point
  // two different schema contexts at the same underlying class; caching by
  // declaration site keeps the entries consistent. The cached array is used as
  // the initial `cls.fields` value in each schema's classMap and is replaced
  // by `resolveInheritedFields(...)` before any mutation (splice/push in the
  // Connection synthesis step), so sharing the reference across schemas is
  // safe — nobody mutates it in-place.
  const classFieldsMemo = new Map<string, FieldInfo[]>();
  // Normalize schema entries: if none found, use convention defaults
  if (schemaEntries.length === 0) {
    schemaEntries.push({
      queryRootName: 'Query',
      mutationRootName: 'Mutation',
      filePath: rootDir,
    });
  }

  // Fill in defaults for entries missing root names
  for (const entry of schemaEntries) {
    if (!entry.queryRootName) entry.queryRootName = 'Query';
    if (!entry.mutationRootName) entry.mutationRootName = 'Mutation';
  }

  // Deduplicate schema entries
  const seenEntryKeys = new Set<string>();
  const uniqueSchemaEntries: SchemaCallInfo[] = [];
  for (const entry of schemaEntries) {
    const key = `${entry.filePath}::${entry.queryRootName}::${entry.mutationRootName}`;
    if (!seenEntryKeys.has(key)) {
      seenEntryKeys.add(key);
      uniqueSchemaEntries.push(entry);
    }
  }

  const results: SchemaInfo[] = [];

  const seenResolvedRoots = new Set<string>();

  for (const schemaEntry of uniqueSchemaEntries) {
    const contextPath = schemaEntry.filePath;

    // Build a single-resolution classMap for this schema context
    const classMap = new Map<string, ClassInfo>();

    // Resolver for `**ArgsClass.__annotations__` / `**Unpack[ArgsClass]` in
    // field arg lists, AND for the graphene mutation pattern where
    // `field = SomeMutation.Field()` derives its args from
    // `SomeMutation.Arguments` (or `.TypedArguments` / `.Input`). Looks up
    // the named class, pulls its own annotations (TypedDict case) plus any
    // nested *Arguments class body's annotations + assignment-style fields,
    // recursing through base classes and dotted inheritance
    // (`TypedBaseMutation.TypedArguments`). A cycle guard keeps mutually
    // referencing args classes from spinning.
    const unpackCache = new Map<string, FieldArgInfo[]>();
    const unpackResolving = new Set<string>();
    const NESTED_ARG_CLASS_NAMES = ['TypedArguments', 'Arguments', 'Input'];

    function classEndLine(raw: RawClassInfo): number {
      const classLine = raw.lines[raw.lineNumber] ?? '';
      const classIndent = classLine.match(/^(\s*)/)?.[1].length ?? 0;
      for (let i = raw.lineNumber + 1; i < raw.lines.length; i++) {
        const line = raw.lines[i];
        if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent <= classIndent && line.trim().length > 0) return i;
      }
      return raw.lines.length;
    }

    function findNestedArgsClass(raw: RawClassInfo): RawClassInfo | undefined {
      const endLine = classEndLine(raw);
      for (const name of NESTED_ARG_CLASS_NAMES) {
        const candidates = rawMultiMap.get(name);
        if (!candidates) continue;
        for (const c of candidates) {
          if (
            c.filePath === raw.filePath &&
            c.lineNumber > raw.lineNumber &&
            c.lineNumber < endLine &&
            c.isNested
          ) {
            return c;
          }
        }
      }
      return undefined;
    }

    // Resolve a base-class reference that may be dotted (`Outer.Inner`).
    // For a plain name, delegate to proximity resolution. For a dotted path,
    // locate the outer class by its last-segment name and find an inner
    // class by the trailing segment within its line range.
    function resolveBaseClass(base: string): RawClassInfo | undefined {
      if (!base.includes('.')) {
        return rawMultiMap.has(base) ? resolveClassByProximity(base, rawMultiMap, contextPath) : undefined;
      }
      const parts = base.split('.');
      const outerName = parts[0];
      const innerName = parts[parts.length - 1];
      const outer = rawMultiMap.has(outerName)
        ? resolveClassByProximity(outerName, rawMultiMap, contextPath)
        : undefined;
      if (!outer) return undefined;
      const endLine = classEndLine(outer);
      const candidates = rawMultiMap.get(innerName);
      if (!candidates) return undefined;
      return candidates.find(
        (c) =>
          c.filePath === outer.filePath &&
          c.lineNumber > outer.lineNumber &&
          c.lineNumber < endLine &&
          c.isNested,
      );
    }

    function collectArgsFromNestedArgsClass(argsClass: RawClassInfo, out: FieldArgInfo[], stack: Set<string>): void {
      const stackKey = `${argsClass.filePath}:${argsClass.lineNumber}`;
      if (stack.has(stackKey)) return;
      stack.add(stackKey);
      // Inherit from base args classes (e.g. `TypedBaseMutation.TypedArguments`).
      for (const bc of argsClass.baseClasses) {
        if (bc === 'TypedDict' || bc === 'typing.TypedDict' || GRAPHENE_BASE_CLASSES.has(bc)) continue;
        const parent = resolveBaseClass(bc);
        if (parent) collectArgsFromNestedArgsClass(parent, out, stack);
      }
      for (const a of parseAnnotationArgs(argsClass.lines, argsClass.lineNumber)) out.push(a);
      for (const a of parseAssignmentArgs(argsClass.lines, argsClass.lineNumber)) out.push(a);
      stack.delete(stackKey);
    }

    // True when a class's own top-level `name: Type` annotations should be
    // treated as args. This is the case for @dataclass classes and for
    // TypedDict subclasses (direct or transitive). Regular graphene
    // ObjectType / Mutation classes carry class-level type hints (e.g.
    // `validate: Callable[...]`, `execute: Callable[...]`) that LOOK like
    // annotation fields but are not args — mutation args live on the nested
    // `Arguments` / `TypedArguments` / `Input` class instead.
    function isAnnotationClass(raw: RawClassInfo, visited: Set<string> = new Set()): boolean {
      const key = `${raw.filePath}:${raw.lineNumber}`;
      if (visited.has(key)) return false;
      visited.add(key);
      if (raw.isDataclass) return true;
      for (const bc of raw.baseClasses) {
        if (bc === 'TypedDict' || bc === 'typing.TypedDict') return true;
        if (GRAPHENE_BASE_CLASSES.has(bc) || isLibraryBaseClass(bc)) continue;
        const parent = resolveBaseClass(bc);
        if (parent && isAnnotationClass(parent, visited)) return true;
      }
      return false;
    }

    const unpackResolver: UnpackResolver = (className: string) => {
      const cached = unpackCache.get(className);
      if (cached !== undefined) return cached;
      if (unpackResolving.has(className)) return [];
      const raw = resolveClassByProximity(className, rawMultiMap, contextPath);
      if (!raw) { unpackCache.set(className, []); return []; }
      unpackResolving.add(className);
      const collected: FieldArgInfo[] = [];
      // Inherit args from parent annotation classes (e.g. PaginationArguments).
      for (const bc of raw.baseClasses) {
        if (bc === 'TypedDict' || bc === 'typing.TypedDict' || GRAPHENE_BASE_CLASSES.has(bc)) continue;
        if (!rawMultiMap.has(bc)) continue;
        for (const a of unpackResolver(bc)) collected.push(a);
      }
      // Annotations on the class body are ONLY args when the class is a
      // TypedDict / dataclass-shaped container. On ordinary graphene
      // classes, top-level annotations are type hints for methods/attrs
      // (e.g. `validate: Callable[...]`) and must not leak into the args
      // list — otherwise every mutation inheriting `TypedBaseMutation`
      // would report `validate`, `execute`, etc. as arguments.
      if (isAnnotationClass(raw)) {
        for (const a of parseAnnotationArgs(raw.lines, raw.lineNumber)) collected.push(a);
      }
      // Nested Arguments / TypedArguments / Input — graphene mutation case.
      // The mutation class itself owns no args; its inner class does.
      const nested = findNestedArgsClass(raw);
      if (nested) {
        collectArgsFromNestedArgsClass(nested, collected, new Set());
      }
      // De-dup by name, child declaration wins over parent.
      const seen = new Set<string>();
      const unique: FieldArgInfo[] = [];
      for (let k = collected.length - 1; k >= 0; k--) {
        const a = collected[k];
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        unique.unshift(a);
      }
      unpackResolving.delete(className);
      unpackCache.set(className, unique);
      return unique;
    };

    for (const name of grapheneClassNames) {
      const raw = resolveClassByProximity(name, rawMultiMap, contextPath);
      if (!raw) continue;

      const memoKey = `${raw.filePath}:${raw.lineNumber}`;
      let fields = classFieldsMemo.get(memoKey);
      if (fields === undefined) {
        const __tPcfStart = performance.now();
        fields = parseClassFields(raw.lines, raw.lineNumber, raw.filePath, raw.imports, raw.isDataclass, unpackResolver);
        __tFinalFieldsParse += performance.now() - __tPcfStart;
        __finalFieldsCount++;
        classFieldsMemo.set(memoKey, fields);
      } else {
        __finalFieldsMemoHits++;
      }
      classMap.set(name, {
        name: raw.name,
        baseClasses: raw.baseClasses,
        framework: 'graphene',
        filePath: raw.filePath,
        lineNumber: raw.lineNumber,
        fields,
        kind: 'type',
      });
    }

    // Merge inherited fields from base classes (mixins, etc.) into each class.
    // Must run after classMap is fully populated so lookups by base class name succeed.
    const __tInheritStart = performance.now();
    // Per-schema memo: classMap is rebuilt per schemaEntry, so the memo
    // lifecycle matches. Recursive calls from the outer loop share the
    // memo, collapsing the O(classes × ancestor depth) walk into
    // O(classes + unique ancestors) per schema.
    const inheritedMemo = new Map<string, FieldInfo[]>();
    for (const cls of classMap.values()) {
      cls.fields = resolveInheritedFields(cls, classMap, new Set(), inheritedMemo);
    }
    __tInheritedFields += performance.now() - __tInheritStart;

    // Relay synthesis: for each `class FooConnection(relay.Connection)` whose
    // Meta.node points at a real type, materialize synthetic `FooEdge` / `PageInfo`
    // classes and attach `edges` / `page_info` fields on the Connection. This
    // lets the frontend traversal `foo { edges { node { … } } }` resolve.
    let anyConnection = false;
    for (const cls of [...classMap.values()]) {
      const isConnection = cls.baseClasses.some((b) => RELAY_CONNECTION_BASES.has(b));
      if (!isConnection) continue;

      const nodeMarkerIdx = cls.fields.findIndex((f) => f.name === '__relay_node__');
      if (nodeMarkerIdx < 0) continue;
      const nodeType = cls.fields[nodeMarkerIdx].resolvedType;
      if (!nodeType) continue;

      // Drop the internal marker so it doesn't leak into UI.
      cls.fields.splice(nodeMarkerIdx, 1);

      // Pick an edge name that doesn't clash with an existing user class.
      const candidate = cls.name.replace(/Connection$/, '') + 'Edge';
      const edgeName = classMap.has(candidate) ? `${cls.name}Edge` : candidate;

      classMap.set(edgeName, {
        name: edgeName,
        baseClasses: [],
        framework: 'graphene',
        filePath: cls.filePath,
        lineNumber: cls.lineNumber,
        fields: [
          { name: 'node', fieldType: 'Field', resolvedType: nodeType, filePath: cls.filePath, lineNumber: cls.lineNumber },
          { name: 'cursor', fieldType: 'String', filePath: cls.filePath, lineNumber: cls.lineNumber },
        ],
        kind: 'type',
      });

      cls.fields.push(
        { name: 'edges', fieldType: 'List', resolvedType: edgeName, filePath: cls.filePath, lineNumber: cls.lineNumber },
        { name: 'page_info', fieldType: 'Field', resolvedType: 'PageInfo', filePath: cls.filePath, lineNumber: cls.lineNumber },
      );
      anyConnection = true;
    }

    if (anyConnection && !classMap.has('PageInfo')) {
      classMap.set('PageInfo', {
        name: 'PageInfo',
        baseClasses: [],
        framework: 'graphene',
        filePath: '',
        lineNumber: 0,
        fields: [
          { name: 'has_next_page', fieldType: 'Boolean', filePath: '', lineNumber: 0 },
          { name: 'has_previous_page', fieldType: 'Boolean', filePath: '', lineNumber: 0 },
          { name: 'start_cursor', fieldType: 'String', filePath: '', lineNumber: 0 },
          { name: 'end_cursor', fieldType: 'String', filePath: '', lineNumber: 0 },
        ],
        kind: 'type',
      });
    }

    const queryRootName = schemaEntry.queryRootName!;
    const mutationRootName = schemaEntry.mutationRootName!;

    // Deduplicate by resolved root classes: if multiple schema entries
    // resolve to the same Query/Mutation root class, keep only the first
    const queryRootCls = classMap.get(queryRootName);
    const mutationRootCls = classMap.get(mutationRootName);
    const resolvedRootKey = `${queryRootCls?.filePath ?? ''}:${queryRootCls?.lineNumber ?? ''}::${mutationRootCls?.filePath ?? ''}:${mutationRootCls?.lineNumber ?? ''}`;
    if (seenResolvedRoots.has(resolvedRootKey)) continue;
    seenResolvedRoots.add(resolvedRootKey);

    // Classify each class
    const kindMap = new Map<string, 'query' | 'mutation' | 'type'>();

    for (const [name, cls] of classMap) {
      if (name === queryRootName) {
        kindMap.set(name, 'query');
        continue;
      }
      if (name === mutationRootName) {
        kindMap.set(name, 'mutation');
        continue;
      }
      if (cls.baseClasses.some((bc) => MUTATION_BASE_CLASSES.has(bc))) {
        kindMap.set(name, 'mutation');
        continue;
      }
      const lower = name.toLowerCase();
      if (lower.includes('query')) {
        kindMap.set(name, 'query');
        continue;
      }
      if (lower.includes('mutation')) {
        kindMap.set(name, 'mutation');
        continue;
      }
    }

    // Propagate through inheritance
    changed = true;
    while (changed) {
      changed = false;
      for (const [name, cls] of classMap) {
        if (kindMap.has(name)) {
          const myKind = kindMap.get(name)!;
          for (const baseName of cls.baseClasses) {
            if (!classMap.has(baseName)) continue;
            if (GRAPHENE_BASE_CLASSES.has(baseName)) continue;
            if (!kindMap.has(baseName)) {
              kindMap.set(baseName, myKind);
              changed = true;
            }
          }
        } else {
          const parentKinds = cls.baseClasses
            .filter((bc) => kindMap.has(bc))
            .map((bc) => kindMap.get(bc)!);
          if (parentKinds.length > 0) {
            kindMap.set(name, parentKinds[0]);
            changed = true;
          }
        }
      }
    }

    // Also classify via field containment: if the root query/mutation class
    // has a field whose resolved type is a class in classMap, classify it
    const rootQueryCls = classMap.get(queryRootName);
    if (rootQueryCls) {
      for (const field of rootQueryCls.fields) {
        if (field.resolvedType && classMap.has(field.resolvedType) && !kindMap.has(field.resolvedType)) {
          kindMap.set(field.resolvedType, 'query');
        }
      }
    }
    const rootMutationCls = classMap.get(mutationRootName);
    if (rootMutationCls) {
      for (const field of rootMutationCls.fields) {
        if (field.resolvedType && classMap.has(field.resolvedType) && !kindMap.has(field.resolvedType)) {
          kindMap.set(field.resolvedType, 'mutation');
        }
      }
    }

    // Collect only classes reachable from schema roots
    const reachable = new Set<string>();
    function collectReachable(name: string) {
      if (reachable.has(name) || !classMap.has(name)) return;
      reachable.add(name);
      const cls = classMap.get(name)!;
      for (const bc of cls.baseClasses) {
        collectReachable(bc);
      }
      for (const field of cls.fields) {
        if (field.resolvedType) {
          collectReachable(field.resolvedType);
        }
        // InputObjectType (or any class-named arg type) is reachable when it
        // is used as a field argument — frontends need to see its shape.
        if (field.args) {
          for (const a of field.args) {
            if (classMap.has(a.type)) {
              collectReachable(a.type);
            }
          }
        }
      }
    }
    collectReachable(queryRootName);
    collectReachable(mutationRootName);

    // Build result for this schema entry
    const queries: ClassInfo[] = [];
    const mutations: ClassInfo[] = [];
    const types: ClassInfo[] = [];

    for (const [name, cls] of classMap) {
      if (!reachable.has(name)) continue;
      const kind = kindMap.get(name) ?? 'type';
      cls.kind = kind;

      if (kind === 'query') {
        queries.push(cls);
      } else if (kind === 'mutation') {
        mutations.push(cls);
      } else {
        types.push(cls);
      }
    }

    const relPath = path.relative(rootDir, schemaEntry.filePath);
    results.push({
      name: relPath || path.basename(rootDir),
      filePath: schemaEntry.filePath,
      queries,
      mutations,
      subscriptions: [],
      types,
    });
  }

  const __tSchemaBuild = performance.now() - __tSchemaBuildStart;

  // Deduplicate by filePath: keep the most populated entry per file
  const filePathMap = new Map<string, SchemaInfo>();
  for (const result of results) {
    const existing = filePathMap.get(result.filePath);
    if (!existing) {
      filePathMap.set(result.filePath, result);
    } else {
      const existingTotal = existing.queries.length + existing.mutations.length + existing.types.length;
      const newTotal = result.queries.length + result.mutations.length + result.types.length;
      if (newTotal > existingTotal) {
        filePathMap.set(result.filePath, result);
      }
    }
  }

  const __tTotal = performance.now() - __tStart;
  const r = (n: number) => Math.round(n);
  const mb = (__totalBytes / (1024 * 1024)).toFixed(1);
  const __backend = __usedNative ? 'native' : 'js';
  const __nativeSegment = __usedNative
    ? `native[walk=${__nativeWalkMs} read=${__nativeReadMs} parse=${__nativeParseMs}] `
    : '';
  info(
    `[timing] parseGrapheneSchemas(${path.basename(rootDir)}) [${__backend}] total=${r(__tTotal)}ms ` +
    `files=${__pyFileCount}(${mb}MB) hit=${__cacheHits} miss=${__cacheMisses} | ` +
    `findFiles=${r(__tFindFiles)}ms ` +
    `fileLoop=${r(__tFileLoop)}ms ` +
    `${__nativeSegment}` +
    `[read=${r(__tReadFile)} hash=${r(__tHash)} split=${r(__tSplit)} cacheGet=${r(__tCacheGet)} parse=${r(__tParseFileData)} reconstruct=${r(__tReconstruct)}] ` +
    `pass2=${r(__tPass2)}ms cacheSave=${r(__tCacheSave)}ms ` +
    `transitiveRes=${r(__tTransitive)}ms resolvedTypeExp=${r(__tResolvedExp)}ms ` +
    `schemaBuild=${r(__tSchemaBuild)}ms [parseClassFields=${r(__tFinalFieldsParse)}ms x${__finalFieldsCount} memoHits=${__finalFieldsMemoHits} resolveInherited=${r(__tInheritedFields)}ms]`,
  );

  return [...filePathMap.values()];
}

// ----- helpers -----

export function detectSchemaCall(
  text: string,
  imports: ImportInfo,
  cb: (query?: string, mutation?: string) => void,
): void {
  const patterns = [
    /graphene\.Schema\s*\(([^)]*)\)/gs,
    /Schema\s*\(([^)]*)\)/gs,
  ];

  for (const pattern of patterns) {
    if (pattern.source.startsWith('Schema') && !imports.fromGraphene.has('Schema')) {
      continue;
    }
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const args = match[1];
      const qMatch = args.match(/query\s*=\s*(\w+)/);
      const mMatch = args.match(/mutation\s*=\s*(\w+)/);
      cb(qMatch?.[1], mMatch?.[1]);
    }
  }
}

function isDirectGrapheneClass(raw: RawClassInfo): boolean {
  return raw.baseClasses.some(
    (bc) =>
      GRAPHENE_BASE_CLASSES.has(bc) ||
      GRAPHENE_BASE_CLASSES.has(`graphene.${bc}`) ||
      raw.imports.fromGraphene.has(bc) ||
      raw.imports.fromGrapheneDjango.has(bc),
  );
}

export function parseImports(text: string): ImportInfo {
  const fromGraphene = new Set<string>();
  const fromGrapheneDjango = new Set<string>();
  let hasGrapheneImport = false;

  const grapheneImportRegex = /from\s+graphene\s+import\s+(.+)/g;
  let m;
  while ((m = grapheneImportRegex.exec(text)) !== null) {
    m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
      .forEach((i) => fromGraphene.add(i));
  }

  const djangoImportRegex = /from\s+graphene_django(?:\.\w+)?\s+import\s+(.+)/g;
  while ((m = djangoImportRegex.exec(text)) !== null) {
    m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
      .forEach((i) => fromGrapheneDjango.add(i));
  }

  if (/import\s+graphene/.test(text)) {
    hasGrapheneImport = true;
  }

  return { fromGraphene, fromGrapheneDjango, hasGrapheneImport };
}

export function parseClassFields(
  lines: string[],
  classLineNumber: number,
  filePath: string,
  imports: ImportInfo,
  isDataclass: boolean = false,
  unpackResolver?: UnpackResolver,
): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const classLine = lines[classLineNumber];
  const classIndent = classLine.match(/^(\s*)/)?.[1].length ?? 0;

  // Track method boundaries so we don't mis-parse annotations inside method bodies.
  // `def <name>(…):` opens a method; any subsequent line indented strictly more
  // than `methodIndent` belongs to the method body and is ignored for field
  // detection. Resets when we dedent back to method-indent level.
  let methodIndent = -1;

  for (let i = classLineNumber + 1; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      continue;
    }

    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lineIndent <= classIndent && line.trim().length > 0) {
      break;
    }

    if (methodIndent >= 0 && lineIndent > methodIndent) continue;
    if (methodIndent >= 0 && lineIndent <= methodIndent) methodIndent = -1;

    // Skip decorator lines (they aren't fields). We still consider the class
    // decorator scan separately up front; here a `@decorator` inside a class
    // body marks the following def/method.
    if (/^\s*@/.test(line)) continue;

    // Method def — remember its indent; skip until we dedent back.
    if (/^\s*(async\s+)?def\s+\w/.test(line)) {
      methodIndent = lineIndent;
      continue;
    }

    // Pattern 0: nested `class Meta:` block — extract DjangoObjectType field list.
    // Supported: fields = [...] / only_fields = [...] / fields = (...), with the
    // list spanning multiple lines. NOT supported (needs Django model scan):
    // fields = '__all__', exclude = [...].
    const metaClassMatch = line.match(/^(\s+)class\s+Meta\s*:/);
    if (metaClassMatch) {
      const metaIndent = metaClassMatch[1].length;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const ml = lines[j];
        if (/^\s*$/.test(ml) || /^\s*#/.test(ml)) continue;
        const mli = ml.match(/^(\s*)/)?.[1].length ?? 0;
        if (mli <= metaIndent && ml.trim().length > 0) break;

        // Match start of: (only_)?fields = [ ... ]  or  fields = ( ... )
        // Gather subsequent lines until brackets are balanced so long lists
        // split across lines (the common Django pattern) still work.
        const listHeadMatch = ml.match(/^(\s+)(?:only_fields|fields)\s*=\s*[[(]/);
        if (listHeadMatch) {
          let buf = ml.substring(listHeadMatch[0].length);
          let depth = 1;
          for (const ch of buf) {
            if (ch === '[' || ch === '(') depth++;
            else if (ch === ']' || ch === ')') depth--;
          }
          let k = j;
          while (depth > 0 && k + 1 < lines.length) {
            k++;
            const next = lines[k];
            buf += '\n' + next;
            for (const ch of next) {
              if (ch === '[' || ch === '(') depth++;
              else if (ch === ']' || ch === ')') depth--;
              if (depth === 0) break;
            }
          }
          const names = [...buf.matchAll(/['"](\w+)['"]/g)].map((m) => m[1]);
          for (const n of names) {
            fields.push({ name: n, fieldType: 'DjangoField', filePath, lineNumber: j });
          }
          j = k; // skip past the gathered list
          continue;
        }
        // Match: node = SomeType (Relay Connection — Meta.node)
        const nodeMatch = ml.match(/^\s+node\s*=\s*(\w+)/);
        if (nodeMatch) {
          fields.push({
            name: '__relay_node__',
            fieldType: 'RelayNode',
            resolvedType: nodeMatch[1],
            filePath,
            lineNumber: j,
          });
        }
      }
      i = j - 1; // resume outer loop after the Meta block
      continue;
    }

    // Skip nested class declarations that aren't Meta (e.g. TypedDict argument
    // containers inside a Query class). Their bodies live at deeper indent and
    // would otherwise be mis-read as class fields.
    const nestedClassMatch = line.match(/^\s+class\s+\w+/);
    if (nestedClassMatch) {
      methodIndent = lineIndent; // reuse the method-body-skip mechanism
      continue;
    }

    // Pattern 1: field = graphene.Type(...) or field = Type(...)
    const fieldMatch = line.match(/^\s+(\w+)\s*=\s*(?:graphene\.)?(\w+)\s*\(/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];

      if (
        GRAPHENE_FIELD_TYPES.has(fieldType) ||
        imports.fromGraphene.has(fieldType) ||
        imports.fromGrapheneDjango.has(fieldType) ||
        /Field$/.test(fieldType)
      ) {
        const resolvedType = extractResolvedType(lines, i, fieldType);

        // Extract keyword arguments as field args
        const args = parseFieldArgs(lines, i, unpackResolver);

        // When the ctor isn't itself a `List` but its first positional arg is
        // a list-shaped container (Python `list[X]`, graphene `List(X)`,
        // `NonNull(List(X))`, etc.), report fieldType as 'List' so the UI
        // renders the expected `[X]` brackets. Without this, e.g.
        // `TypedField(list[X])` would look like a bare `X`.
        let effectiveFieldType = fieldType;
        if (effectiveFieldType !== 'List') {
          const firstArg = firstPositionalArgText(lines, i, fieldType);
          if (firstArg && detectListShape(firstArg)) {
            effectiveFieldType = 'List';
          }
        }

        fields.push({
          name: fieldName,
          fieldType: effectiveFieldType,
          resolvedType,
          args: args.length > 0 ? args : undefined,
          filePath,
          lineNumber: i,
        });
        continue;
      }
    }

    // Pattern 2: field = ClassName.Field() — mutation/relay registration pattern
    const dotFieldMatch = line.match(/^\s+(\w+)\s*=\s*(\w+)\.Field\s*\(/);
    if (dotFieldMatch) {
      const fieldName = dotFieldMatch[1];
      const className = dotFieldMatch[2];

      // Mutation args live on the mutation class's nested `Arguments` /
      // `TypedArguments` / `Input` class — not on the `.Field()` call itself.
      // The unpack resolver is responsible for discovering the nested class
      // and harvesting its annotations + assignment-style fields.
      const args = unpackResolver ? unpackResolver(className) : [];

      fields.push({
        name: fieldName,
        fieldType: 'Field',
        resolvedType: className,
        args: args.length > 0 ? args : undefined,
        filePath,
        lineNumber: i,
      });
      continue;
    }

    // Pattern 3: dataclass annotation — `field_name: TypeAnnotation [= default]`.
    // Only active when the class was declared with @dataclass, so we don't
    // pick up stray local-variable annotations in non-dataclass classes.
    // Collect a multi-line annotation when the declaration continues via
    // bracket-depth > 0 (e.g., `x: list[\n    SomeType,\n]`).
    if (isDataclass) {
      const annMatch = line.match(/^(\s+)(\w+)\s*:\s*(.+)$/);
      if (annMatch) {
        // Dataclass authors sometimes spell fields in camelCase (e.g.
        // `totalCount: int`) to match a GraphQL wire name directly. The
        // frontend-matching pipeline always snake-cases the camel name from
        // the gql query, so we normalize backend names to snake_case on
        // storage — otherwise `totalCount` in the class wouldn't match
        // `camelToSnake('totalCount') === 'total_count'` at lookup time.
        const fieldName = normalizeFieldName(annMatch[2]);
        // `ClassVar[...]` annotations are never dataclass fields.
        let annotation = annMatch[3];
        if (/^ClassVar\b/.test(annotation)) continue;

        // If brackets aren't balanced on this line, accumulate subsequent
        // lines until they are. Dataclasses commonly split long generics
        // across lines for readability.
        let depth = 0;
        for (const ch of annotation) {
          if (ch === '[' || ch === '(' || ch === '{') depth++;
          else if (ch === ']' || ch === ')' || ch === '}') depth--;
        }
        let j = i;
        while (depth > 0 && j + 1 < lines.length) {
          j++;
          annotation += ' ' + lines[j];
          for (const ch of lines[j]) {
            if (ch === '[' || ch === '(' || ch === '{') depth++;
            else if (ch === ']' || ch === ')' || ch === '}') depth--;
          }
        }

        // Drop trailing `= default` / `= field(...)` — dataclass default values
        // don't participate in the type.
        const eqIdx = topLevelEqualsIndex(annotation);
        const typeExpr = (eqIdx >= 0 ? annotation.substring(0, eqIdx) : annotation).trim();

        // Decide fieldType / resolvedType from the annotation shape:
        //  - List wrapping (`list[X]`, `Sequence[X]`, `X | None` where X is a
        //    list) → fieldType='List', resolvedType=inner payload.
        //  - Pure scalar annotation (`int`, `datetime.datetime`, etc.) →
        //    fieldType is the GraphQL scalar name, resolvedType undefined so
        //    downstream consumers treat it as a leaf.
        //  - Custom class (`UserType`, `FooDataclass`) → fieldType='Field',
        //    resolvedType points to the class so the UI can expand it.
        const inner = firstPositionalType(typeExpr);
        const listLike = isListLikeAnnotation(typeExpr);
        const isScalar = !!inner && GRAPHQL_SCALAR_NAMES.has(inner);

        let fieldType: string;
        let resolvedType: string | undefined = inner;
        if (listLike) {
          fieldType = 'List';
        } else if (isScalar && inner) {
          fieldType = inner;
          resolvedType = undefined;
        } else if (inner) {
          fieldType = 'Field';
        } else {
          fieldType = 'DataclassField';
        }

        fields.push({
          name: fieldName,
          fieldType,
          resolvedType,
          filePath,
          lineNumber: i,
        });
        i = j;
        continue;
      }
    }
  }

  return fields;
}

// GraphQL built-in + common-custom scalar names. When Pattern 3 resolves an
// annotation to one of these, treat the field as a leaf and surface the scalar
// as fieldType so the UI can render `Int` / `String` directly.
const GRAPHQL_SCALAR_NAMES = new Set([
  'String', 'Int', 'Float', 'Boolean', 'ID',
  'DateTime', 'Date', 'Time', 'Decimal', 'JSONString', 'UUID',
]);

/**
 * Extract the text of the first positional argument of `headType(...)` starting
 * at `fieldLineNumber`. Used to let Pattern 1 detect list-wrapped payloads in
 * Python or graphene syntax (`TypedField(list[X])`, `Field(List(X))`, …).
 */
function firstPositionalArgText(lines: string[], fieldLineNumber: number, headType: string): string | undefined {
  let fullText = '';
  let depth = 0;
  for (let j = fieldLineNumber; j < lines.length && j < fieldLineNumber + 15; j++) {
    const line = lines[j];
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    fullText += line + '\n';
    if (depth <= 0 && j > fieldLineNumber) break;
  }
  const headRe = new RegExp(String.raw`(?:graphene\s*\.\s*)?\b` + escapeRegex(headType) + String.raw`\s*\(`);
  const match = headRe.exec(fullText);
  if (!match) return undefined;
  const openParen = match.index + match[0].length - 1;
  const inner = extractBalancedContent(fullText, openParen);
  if (inner === null) return undefined;
  // First positional arg runs until the first top-level comma.
  let d = 0;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
    else if (ch === ',' && d === 0) return inner.substring(0, k);
  }
  return inner;
}

/**
 * True when the supplied type expression is a list-like container. Recognizes
 * both Python typing syntax (`list[X]`, `Sequence[X]`, `X | None` where X is
 * a list) and graphene ctor syntax (`List(X)`, `graphene.List(X)`,
 * `NonNull(List(X))`, `NonNull(graphene.List(X))`, `lambda: List(X)`).
 */
function detectListShape(typeExpr: string): boolean {
  let trimmed = typeExpr.replace(/^(?:\s*(?:#[^\n]*\n)?)*/, '').trimStart();
  // Strip union None arms — `list[X] | None` is still a list.
  const arms = splitTopLevelUnion(trimmed)
    .map((a) => a.trim())
    .filter((a) => a !== 'None' && a !== 'NoneType');
  if (arms.length > 0) trimmed = arms[0];
  // Python typing containers (case-sensitive — `List[X]`, `list[X]`, etc.).
  if (/^(?:typing\s*\.\s*)?(?:list|List|Sequence|Iterable|tuple|Tuple|set|Set|frozenset|FrozenSet|AsyncIterable|AsyncIterator|Iterator|Generator|AsyncGenerator)\s*\[/.test(trimmed)) return true;
  // graphene List ctor.
  if (/^(?:graphene\s*\.\s*)?List\s*\(/.test(trimmed)) return true;
  // NonNull(List(...)) — unwrap NonNull.
  const nnMatch = trimmed.match(/^(?:graphene\s*\.\s*)?NonNull\s*\(/);
  if (nnMatch) {
    const openIdx = trimmed.indexOf('(');
    const inner = extractBalancedContent(trimmed, openIdx);
    if (inner !== null) return detectListShape(inner);
  }
  // lambda: body — unwrap lambda.
  const lambdaMatch = trimmed.match(/^lambda\s*:\s*/);
  if (lambdaMatch) return detectListShape(trimmed.substring(lambdaMatch[0].length));
  return false;
}

/**
 * camelCase → snake_case — matches the conversion used by the frontend gql
 * matcher so backend names written in camelCase still line up with the
 * snake-cased lookup keys. Duplicated (not imported from
 * gqlCodeLensProvider) to keep the scanner free of VS Code dependencies.
 */
function normalizeFieldName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * True when a dataclass annotation's top-level type (after stripping `None`
 * union arms) is a list/sequence-like Python container. Used to decide
 * whether the field should render as `[X]` vs. a bare `X` in the structure UI.
 */
function isListLikeAnnotation(typeExpr: string): boolean {
  // Strip `None` / `NoneType` arms of a top-level union; the list-ness is
  // determined by the non-None arm.
  const arms = splitTopLevelUnion(typeExpr)
    .map((a) => a.trim())
    .filter((a) => a !== 'None' && a !== 'NoneType');
  const primary = arms.length > 0 ? arms[0] : typeExpr.trim();
  // list[X] / List[X] / Sequence[X] / Iterable[X] / tuple[X] / set[X] / …
  return /^(?:typing\s*\.\s*)?(?:list|List|Sequence|Iterable|tuple|Tuple|set|Set|frozenset|FrozenSet|AsyncIterable|AsyncIterator|Iterator|Generator|AsyncGenerator)\s*\[/.test(primary);
}

function topLevelEqualsIndex(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      // Skip comparison operators that happen to involve '=' — unlikely in
      // annotations but safe.
      if (text[i + 1] === '=' || text[i - 1] === '!' || text[i - 1] === '<' || text[i - 1] === '>') continue;
      return i;
    }
  }
  return -1;
}

const NON_TYPE_WORDS = new Set([
  'True', 'False', 'None', 'lambda', 'self', 'info', 'root',
  'required', 'description', 'default_value', 'deprecation_reason',
  'source', 'resolver', 'name',
]);

const WRAPPER_TYPES = new Set(['List', 'NonNull']);

// Python primitive / stdlib types → their GraphQL scalar equivalents. These let
// annotation-style fields (`count: int`, `title: str`, `ids: list[UUID]`) report
// a meaningful leaf type instead of `undefined` — so the user sees `Int` /
// `String` / `[ID]` in the query structure rather than a bare `DataclassField`.
const PY_PRIMITIVE_SCALARS: Record<string, string> = {
  str: 'String', int: 'Int', float: 'Float', bool: 'Boolean',
  bytes: 'String',
  Decimal: 'Decimal', UUID: 'ID',
  datetime: 'DateTime', date: 'Date', time: 'Time',
};

// Dotted forms — `datetime.datetime` resolves to DateTime, etc. Values are the
// GraphQL scalar name; keys are the full dotted path.
const PY_DOTTED_SCALARS: Record<string, string> = {
  'datetime.datetime': 'DateTime',
  'datetime.date': 'Date',
  'datetime.time': 'Time',
  'decimal.Decimal': 'Decimal',
  'uuid.UUID': 'ID',
};

function mapPythonScalar(name: string, dottedPath?: string): string | undefined {
  if (dottedPath && PY_DOTTED_SCALARS[dottedPath]) return PY_DOTTED_SCALARS[dottedPath];
  return PY_PRIMITIVE_SCALARS[name];
}

export function extractResolvedType(lines: string[], fieldLineNumber: number, fieldType: string): string | undefined {
  // Collect the full field definition text (up to 15 lines or closing paren)
  let fullText = '';
  let depth = 0;
  for (let j = fieldLineNumber; j < lines.length && j < fieldLineNumber + 15; j++) {
    const line = lines[j];
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    fullText += line + '\n';
    if (depth <= 0 && j > fieldLineNumber) break;
  }

  return unwrapFromText(fullText, fieldType, new Set());
}

function unwrapFromText(text: string, headType: string, visited: Set<string>): string | undefined {
  // Guard against pathological input (shouldn't happen but be safe)
  if (visited.has(headType) && visited.size > 8) return undefined;
  visited.add(headType);

  // Find `[graphene.]headType(` — use the first occurrence; `text` is already
  // scoped to the balanced content of the previous layer on recursion.
  const headRe = new RegExp(String.raw`(?:graphene\s*\.\s*)?\b` + escapeRegex(headType) + String.raw`\s*\(`);
  const match = headRe.exec(text);
  if (!match) return undefined;

  const openParen = match.index + match[0].length - 1;
  const inner = extractBalancedContent(text, openParen);
  if (inner == null) return undefined;

  const first = firstPositionalType(inner);
  if (!first) return undefined;

  if (WRAPPER_TYPES.has(first)) {
    return unwrapFromText(inner, first, visited);
  }
  return first;
}

function extractBalancedContent(text: string, openIdx: number): string | null {
  if (text[openIdx] !== '(') return null;
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.substring(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

// Python typing containers whose payload type is the SINGLE type argument.
// `list[X]` / `Optional[X]` / `tuple[X]` etc. — extract X via recursion.
const PY_SINGLE_CONTAINERS = new Set([
  'list', 'List', 'set', 'Set', 'frozenset', 'FrozenSet',
  'tuple', 'Tuple', 'Iterable', 'Sequence', 'Optional',
  'Awaitable', 'Coroutine', 'AsyncIterable', 'AsyncIterator',
  'Iterator', 'Generator', 'AsyncGenerator', 'NotRequired',
]);

// Mapping-like containers where the VALUE type (2nd arg) is the interesting one.
const PY_MAPPING_CONTAINERS = new Set([
  'dict', 'Dict', 'Mapping', 'MutableMapping', 'DefaultDict', 'defaultdict',
  'OrderedDict',
]);

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(text.substring(start));
  return parts;
}

function splitTopLevelUnion(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth--;
    else if (ch === '|' && depth === 0) {
      parts.push(text.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(text.substring(start));
  return parts;
}

function extractBalancedBrackets(text: string, openIdx: number): string | null {
  if (text[openIdx] !== '[') return null;
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.substring(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

function firstPositionalType(args: string, lambdaDepth: number = 0): string | undefined {
  // Strip leading whitespace/newlines/comments
  let trimmed = args.replace(/^(?:\s*(?:#[^\n]*\n)?)*/, '').trimStart();

  // Pattern 0a: `X | Y | None` / `None | X` union — return first non-None arm.
  // Only split at top-level pipes (not inside [] or ()). Guards against
  // recursing on the identical string if we only found one arm.
  const unionArms = splitTopLevelUnion(trimmed);
  if (unionArms.length > 1) {
    for (const arm of unionArms) {
      const armStr = arm.trim();
      if (armStr === 'None' || armStr === 'NoneType') continue;
      const resolved = firstPositionalType(armStr, lambdaDepth);
      if (resolved) return resolved;
    }
    return undefined;
  }

  // Pattern 0b: Python typing containers — list[X], Optional[X], tuple[X], etc.
  // For `typing.list[X]` / `typing.List[X]`, strip the `typing.` prefix first.
  const containerMatch = trimmed.match(/^(?:typing\s*\.\s*)?(\w+)\s*\[/);
  if (containerMatch) {
    const containerName = containerMatch[1];
    const openIdx = trimmed.indexOf('[');
    const inner = extractBalancedBrackets(trimmed, openIdx);
    if (inner !== null) {
      // Union[X, Y, None] — pick first non-None arm (same semantics as `X | None`).
      if (containerName === 'Union') {
        const parts = splitTopLevelCommas(inner);
        for (const part of parts) {
          const partTrimmed = part.trim();
          if (partTrimmed === 'None' || partTrimmed === 'NoneType') continue;
          const result = firstPositionalType(partTrimmed, lambdaDepth);
          if (result) return result;
        }
        return undefined;
      }
      if (PY_SINGLE_CONTAINERS.has(containerName)) {
        return firstPositionalType(inner, lambdaDepth);
      }
      if (PY_MAPPING_CONTAINERS.has(containerName)) {
        const parts = splitTopLevelCommas(inner);
        if (parts.length >= 2) return firstPositionalType(parts[1], lambdaDepth);
        return firstPositionalType(inner, lambdaDepth);
      }
      // Unknown container with subscript (e.g., `Literal[...]`, `Annotated[X, ...]`) —
      // `Annotated[X, ...]` should return X. For anything else, fall through to
      // treat `containerName` itself as the type.
      if (containerName === 'Annotated') {
        const parts = splitTopLevelCommas(inner);
        if (parts.length >= 1) return firstPositionalType(parts[0], lambdaDepth);
      }
      // fall through — treat as `ContainerName` if it's a capitalized class name
    }
  }

  // Pattern 1: lambda : <body>  — recurse on the body. Supports lambda: 'X',
  // lambda: graphene.X, lambda: List(X), etc. Guard against pathological
  // nested lambdas.
  const lambdaHead = trimmed.match(/^lambda\s*:\s*/);
  if (lambdaHead) {
    if (lambdaDepth > 4) return undefined;
    return firstPositionalType(trimmed.substring(lambdaHead[0].length), lambdaDepth + 1);
  }

  // Pattern 2: 'StringType' or "StringType"
  const strMatch = trimmed.match(/^['"](\w+)['"]/);
  if (strMatch) {
    const t = strMatch[1];
    return NON_TYPE_WORDS.has(t) ? undefined : t;
  }

  // Pattern 3: graphene.Type
  const grapheneMatch = trimmed.match(/^graphene\s*\.\s*(\w+)/);
  if (grapheneMatch) {
    const t = grapheneMatch[1];
    if (NON_TYPE_WORDS.has(t)) return undefined;
    if (!/^[A-Z]/.test(t)) return undefined;
    return t;
  }

  // Pattern 4: dotted type like `datetime.datetime` / `decimal.Decimal` — take
  // the rightmost identifier (it's the actual class name), or map stdlib
  // dotted scalars to their GraphQL equivalent.
  const dottedMatch = trimmed.match(/^(\w+(?:\s*\.\s*\w+)+)/);
  if (dottedMatch) {
    const segments = dottedMatch[1].split('.').map((s) => s.trim());
    const last = segments[segments.length - 1];
    const afterWord = trimmed.substring(dottedMatch[0].length).trimStart();
    if (afterWord.startsWith('=')) return undefined;
    if (NON_TYPE_WORDS.has(last)) return undefined;
    const dottedPath = segments.join('.');
    const mapped = mapPythonScalar(last, dottedPath);
    if (mapped) return mapped;
    if (!/^[A-Z]/.test(last)) return undefined;
    return last;
  }

  // Pattern 5: plain identifier (must not be a keyword arg). Lowercase Python
  // primitives map to the corresponding GraphQL scalar so downstream code sees
  // a usable resolvedType for annotations like `count: int`.
  const wordMatch = trimmed.match(/^(\w+)/);
  if (wordMatch) {
    const word = wordMatch[1];
    const afterWord = trimmed.substring(wordMatch[0].length).trimStart();
    if (afterWord.startsWith('=')) return undefined; // kwarg, not a positional type
    if (NON_TYPE_WORDS.has(word)) return undefined;
    const mapped = mapPythonScalar(word);
    if (mapped) return mapped;
    if (!/^[A-Z]/.test(word)) return undefined;
    return word;
  }

  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GRAPHENE_ARG_TYPES: Record<string, string> = {
  String: 'String', Int: 'Int', Float: 'Float', Boolean: 'Boolean', ID: 'ID',
  DateTime: 'DateTime', Date: 'Date', Time: 'Time', Decimal: 'Decimal',
  JSONString: 'JSONString', UUID: 'UUID', List: 'List', NonNull: 'NonNull',
  Argument: 'Argument', InputField: 'InputField',
};

const ARG_WRAPPER_TYPES = new Set(['Argument', 'InputField']);

/**
 * Resolves a TypedDict-style class name to a list of FieldArgInfo. Used by
 * `parseFieldArgs` to expand `**ArgsClass.__annotations__` kwargs-unpacking
 * patterns. Implementations typically look the name up in rawMultiMap and
 * parse its annotation-style fields.
 */
export type UnpackResolver = (className: string) => FieldArgInfo[];

export function parseFieldArgs(
  lines: string[],
  fieldLineNumber: number,
  unpackResolver?: UnpackResolver,
): FieldArgInfo[] {
  const args: FieldArgInfo[] = [];
  // Collect the full field definition (may span multiple lines until closing ')')
  let fullDef = '';
  let depth = 0;
  for (let j = fieldLineNumber; j < lines.length && j < fieldLineNumber + 20; j++) {
    const line = lines[j];
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    fullDef += line + '\n';
    if (depth <= 0 && j > fieldLineNumber) break;
  }

  // Match keyword args: arg_name=graphene.Type(...) or arg_name=Type(...)
  const kwargRegex = /(\w+)\s*=\s*(?:graphene\.)?(\w+)\s*\(/g;
  let m;
  let first = true;
  while ((m = kwargRegex.exec(fullDef)) !== null) {
    if (first) { first = false; continue; } // skip the field assignment itself (field_name = Type(...))
    const argName = m[1];
    let argType = m[2];
    // Skip non-type kwargs like description, default_value, deprecation_reason
    if (['description', 'default_value', 'deprecation_reason', 'name', 'source', 'resolver'].includes(argName)) continue;
    if (!GRAPHENE_ARG_TYPES[argType] && !/^[A-Z]/.test(argType)) continue;

    // Unwrap Argument(X) / InputField(X) → X. The real type is the first
    // positional arg inside the wrapper.
    const wrapperOpenIdx = m.index + m[0].length - 1;
    if (ARG_WRAPPER_TYPES.has(argType)) {
      const inner = extractBalancedContent(fullDef, wrapperOpenIdx);
      if (inner != null) {
        const innerType = firstPositionalType(inner);
        if (innerType) argType = innerType;
      }
    }

    // Scope the required=True check to this arg's own parens (handles the case
    // where `required=True` sits inside a wrapper like Argument(X, required=True)).
    const ownInner = extractBalancedContent(fullDef, wrapperOpenIdx) ?? '';
    const required = /\brequired\s*=\s*True\b/.test(ownInner);
    args.push({
      name: argName,
      type: GRAPHENE_ARG_TYPES[argType] ?? argType,
      required,
    });
  }

  // Captain-style kwargs unpacking: `TypedField(X, **ArgsClass.__annotations__)`
  // or `TypedField(X, **Unpack[ArgsClass])`. We resolve the referenced TypedDict
  // (or @dataclass, or any annotation-bearing class) and inline its annotations
  // as field args. Without this, graphene fields that derive their arg shape
  // from a TypedDict wouldn't surface any args in the UI.
  if (unpackResolver) {
    const patterns = [
      /\*\*\s*(\w+)\s*\.\s*__annotations__/g,
      /\*\*\s*Unpack\s*\[\s*(\w+)\s*\]/g,
    ];
    const seen = new Set(args.map((a) => a.name));
    for (const re of patterns) {
      let u: RegExpExecArray | null;
      while ((u = re.exec(fullDef)) !== null) {
        const className = u[1];
        const resolved = unpackResolver(className);
        for (const a of resolved) {
          if (seen.has(a.name)) continue;
          seen.add(a.name);
          args.push(a);
        }
      }
    }
  }

  return args;
}

/**
 * Parse `name: Type` annotation lines inside a TypedDict / dataclass-like class
 * body and return them as field args. Skips decorators, methods, nested
 * classes, and `ClassVar[…]` entries. Arg `required` is derived from:
 *   - `NotRequired[X]` / `typing.NotRequired[X]` → not required
 *   - `Optional[X]` / `X | None` / `None | X` → not required
 *   - otherwise required.
 */
export function parseAnnotationArgs(lines: string[], classLineNumber: number): FieldArgInfo[] {
  const classLine = lines[classLineNumber];
  const classIndent = classLine?.match(/^(\s*)/)?.[1].length ?? 0;
  const out: FieldArgInfo[] = [];
  let methodIndent = -1;

  for (let i = classLineNumber + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lineIndent <= classIndent && line.trim().length > 0) break;
    if (methodIndent >= 0 && lineIndent > methodIndent) continue;
    if (methodIndent >= 0 && lineIndent <= methodIndent) methodIndent = -1;
    if (/^\s*@/.test(line)) continue;
    if (/^\s*(async\s+)?def\s+\w/.test(line)) { methodIndent = lineIndent; continue; }
    if (/^\s+class\s+\w/.test(line)) { methodIndent = lineIndent; continue; }

    const annMatch = line.match(/^(\s+)(\w+)\s*:\s*(.+)$/);
    if (!annMatch) continue;
    const argName = annMatch[2];
    let annotation = annMatch[3];
    if (/^ClassVar\b/.test(annotation)) continue;

    // Multi-line bracket balance.
    let depth = 0;
    for (const ch of annotation) {
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth--;
    }
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      annotation += ' ' + lines[j];
      for (const ch of lines[j]) {
        if (ch === '[' || ch === '(' || ch === '{') depth++;
        else if (ch === ']' || ch === ')' || ch === '}') depth--;
      }
    }

    const eqIdx = topLevelEqualsIndex(annotation);
    const typeExpr = (eqIdx >= 0 ? annotation.substring(0, eqIdx) : annotation).trim();

    const { type, required } = annotationToArgShape(typeExpr);
    out.push({ name: argName, type, required });
    i = j;
  }
  return out;
}

/**
 * Parse graphene-style assignment args — the convention for mutation
 * `class Arguments: name = String(required=True)` inner classes. Each
 * `name = Type(...)` line contributes one arg; `required=True` at the top
 * level of the call marks it required. Matching `parseAnnotationArgs`'s
 * indentation / method-body / nested-class skipping semantics so the two
 * can be composed on the same inner class body.
 */
export function parseAssignmentArgs(lines: string[], classLineNumber: number): FieldArgInfo[] {
  const classLine = lines[classLineNumber];
  const classIndent = classLine?.match(/^(\s*)/)?.[1].length ?? 0;
  const out: FieldArgInfo[] = [];
  let methodIndent = -1;

  for (let i = classLineNumber + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lineIndent <= classIndent && line.trim().length > 0) break;
    if (methodIndent >= 0 && lineIndent > methodIndent) continue;
    if (methodIndent >= 0 && lineIndent <= methodIndent) methodIndent = -1;
    if (/^\s*@/.test(line)) continue;
    if (/^\s*(async\s+)?def\s+\w/.test(line)) { methodIndent = lineIndent; continue; }
    if (/^\s+class\s+\w/.test(line)) { methodIndent = lineIndent; continue; }

    const assignMatch = line.match(/^(\s+)(\w+)\s*=\s*(?:graphene\s*\.\s*)?(\w+)\s*\(/);
    if (!assignMatch) continue;
    const argName = assignMatch[2];
    let argType = assignMatch[3];

    // Collect the full call text so multi-line declarations with trailing
    // commas still see `required=True`.
    let fullDef = line;
    let depth = 0;
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      fullDef += '\n' + lines[j];
      for (const ch of lines[j]) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    }

    // Argument(X) / InputField(X) wraps the real type as its first positional.
    const openParenIdx = fullDef.indexOf('(', line.indexOf(argType) + argType.length);
    const inner = openParenIdx >= 0 ? extractBalancedContent(fullDef, openParenIdx) : null;
    if (ARG_WRAPPER_TYPES.has(argType) && inner != null) {
      const unwrapped = firstPositionalType(inner);
      if (unwrapped) argType = unwrapped;
    }

    const required = /\brequired\s*=\s*True\b/.test(inner ?? fullDef);
    out.push({
      name: argName,
      type: GRAPHENE_ARG_TYPES[argType] ?? argType,
      required,
    });
    i = j;
  }
  return out;
}

/** Given `company_id: IDStr` / `page: NotRequired[int]` / `x: A | None` etc. */
function annotationToArgShape(typeExpr: string): { type: string; required: boolean } {
  const hasNotRequired = /^\s*(?:typing\s*\.\s*)?NotRequired\s*\[/.test(typeExpr);
  const hasOptional = /^\s*(?:typing\s*\.\s*)?Optional\s*\[/.test(typeExpr);
  const unionArms = splitTopLevelUnion(typeExpr);
  const hasNoneArm = unionArms.some((a) => {
    const t = a.trim();
    return t === 'None' || t === 'NoneType';
  });
  const required = !hasNotRequired && !hasOptional && !hasNoneArm;
  const resolved = firstPositionalType(typeExpr) ?? typeExpr.trim();
  return { type: resolved, required };
}

export function resolveInheritedFields(
  cls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  visited: Set<string> = new Set(),
  memo?: Map<string, FieldInfo[]>,
): FieldInfo[] {
  // Optional memo cache keyed by className. Safe when the classMap topology
  // is an acyclic inheritance graph (the normal case — Python forbids
  // inheritance cycles outright). Callers that don't pass `memo` keep the
  // original recompute-from-scratch behavior.
  if (memo) {
    const cached = memo.get(cls.name);
    if (cached !== undefined) return cached;
  }
  if (visited.has(cls.name)) return [];
  visited.add(cls.name);

  const fields = [...cls.fields];
  const seen = new Set(fields.map((f) => f.name));

  for (const baseName of cls.baseClasses) {
    if (GRAPHENE_BASE_CLASSES.has(baseName) || isLibraryBaseClass(baseName)) {
      continue;
    }
    const parentCls = classMap.get(baseName);
    if (parentCls) {
      const parentFields = resolveInheritedFields(parentCls, classMap, visited, memo);
      for (const field of parentFields) {
        if (!seen.has(field.name)) {
          fields.push({
            ...field,
            filePath: field.filePath || parentCls.filePath,
            // Remember where this field was originally declared so downstream
            // consumers (fieldIndex, inspector, click-to-source) can route to
            // the true owner, not the subclass that merely inherits it.
            definedIn: field.definedIn ?? parentCls.name,
          });
          seen.add(field.name);
        }
      }
    }
  }

  if (memo) memo.set(cls.name, fields);
  return fields;
}
