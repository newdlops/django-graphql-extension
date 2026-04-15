import * as vscode from 'vscode';
import * as path from 'path';
import { ClassInfo, FieldInfo, SchemaInfo } from '../types';
import { ParseCache, CachedFileData } from './parseCache';

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
]);

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

interface ImportInfo {
  fromGraphene: Set<string>;
  fromGrapheneDjango: Set<string>;
  hasGrapheneImport: boolean;
}

const EMPTY_IMPORTS: ImportInfo = {
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

  // Score: prefer graphene-import files, then longest common path prefix
  return candidates.reduce((best, candidate) => {
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
  const pyFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootDir, '**/*.py'),
    '{**/migrations/**,**/__pycache__/**,**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}',
  );

  // Prune cache entries for deleted files
  if (cache) {
    cache.pruneExcept(new Set(pyFiles.map((u) => u.fsPath)));
  }

  // -------------------------------------------------------
  // Per-file parse function (used for both cache miss and fresh parse)
  // -------------------------------------------------------
  const classRegex = /^class\s+(\w+)\s*(?:\(([^)]*(?:\n[^)]*)*)\))?\s*:/gm;

  function extractClassesFromText(text: string): { name: string; baseClasses: string[]; lineNumber: number }[] {
    classRegex.lastIndex = 0;
    const results: { name: string; baseClasses: string[]; lineNumber: number }[] = [];
    let classMatch;
    while ((classMatch = classRegex.exec(text)) !== null) {
      const baseClassRaw = classMatch[2] ?? '';
      const baseClasses = baseClassRaw
        .replace(/#[^\n]*/g, '')
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && /^\w+$/.test(b));
      const lineNumber = text.substring(0, classMatch.index).split('\n').length - 1;
      results.push({ name: classMatch[1], baseClasses, lineNumber });
    }
    return results;
  }

  function parseFileData(text: string, filePath: string): CachedFileData {
    const containsGraphene = /graphene/i.test(text);
    const imports = containsGraphene ? parseImports(text) : undefined;
    const classes = extractClassesFromText(text);
    const schemaEntries: { queryRootName?: string; mutationRootName?: string }[] = [];
    if (containsGraphene && imports) {
      detectSchemaCall(text, imports, (q, m) => {
        schemaEntries.push({ queryRootName: q, mutationRootName: m });
      });
    }
    return {
      contentHash: ParseCache.computeHash(text),
      containsGraphene,
      classes: classes.map((c) => ({ name: c.name, baseClasses: c.baseClasses, lineNumber: c.lineNumber })),
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
      });
    }

    if (cached.containsGraphene) {
      grapheneDirs.add(path.dirname(filePath));
      for (const entry of cached.schemaEntries) {
        schemaEntries.push({ queryRootName: entry.queryRootName, mutationRootName: entry.mutationRootName, filePath });
      }
    }
  }

  for (const uri of pyFiles) {
    const filePath = uri.fsPath;

    // Read file content via fs API (fast, for hash computation)
    const rawBytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(rawBytes).toString('utf-8');
    const hash = ParseCache.computeHash(text);
    const lines = text.split('\n');
    fileLinesMap.set(filePath, lines);

    // Check cache
    const cached = cache?.get(filePath);
    if (cached && cached.contentHash === hash) {
      // Cache hit — reconstruct from cached data
      if (cached.containsGraphene) {
        reconstructFromCache(cached, filePath, lines);
      } else {
        nonGrapheneFilePaths.push(filePath);
        // Still extract classes for Pass 2 (cached)
        const effectiveImports = EMPTY_IMPORTS;
        for (const cls of cached.classes) {
          // Don't add to rawMultiMap yet — deferred to Pass 2
        }
      }
      continue;
    }

    // Cache miss — full parse
    const fileData = parseFileData(text, filePath);
    cache?.set(filePath, fileData);

    if (!fileData.containsGraphene) {
      nonGrapheneFilePaths.push(filePath);
      continue;
    }

    // Reconstruct runtime data from freshly parsed data
    reconstructFromCache(fileData, filePath, lines);
  }

  // -------------------------------------------------------
  // Pass 2: Iteratively scan non-graphene files to find
  //         missing base classes referenced by known classes.
  // -------------------------------------------------------

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
          if (!rawMultiMap.has(bc) && !GRAPHENE_BASE_CLASSES.has(bc) && !bc.startsWith('graphene.')) {
            missing.add(bc);
          }
        }
      }
    }
    return missing;
  }

  function extractClassesFromCachedFile(filePath: string): void {
    const cached = cache?.get(filePath);
    const lines = fileLinesMap.get(filePath);
    if (!lines) return;
    if (cached) {
      for (const cls of cached.classes) {
        addToRawMultiMap({
          name: cls.name,
          baseClasses: cls.baseClasses,
          filePath,
          lineNumber: cls.lineNumber,
          lines,
          imports: EMPTY_IMPORTS,
        });
      }
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

  // Save cache after all parsing is done
  cache?.save();

  // -------------------------------------------------------
  // Determine which classes are graphene-related
  // by walking the inheritance graph transitively
  // -------------------------------------------------------

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

  // -------------------------------------------------------
  // For each Schema entry, build an independent resolution
  // context using directory proximity. Merge all results.
  // -------------------------------------------------------

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
    for (const name of grapheneClassNames) {
      const raw = resolveClassByProximity(name, rawMultiMap, contextPath);
      if (!raw) continue;

      const fields = parseClassFields(raw.lines, raw.lineNumber, raw.filePath, raw.imports);
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

  return [...filePathMap.values()];
}

// ----- helpers -----

function detectSchemaCall(
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

function parseImports(text: string): ImportInfo {
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

function parseClassFields(
  lines: string[],
  classLineNumber: number,
  filePath: string,
  imports: ImportInfo,
): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const classLine = lines[classLineNumber];
  const classIndent = classLine.match(/^(\s*)/)?.[1].length ?? 0;

  for (let i = classLineNumber + 1; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      continue;
    }

    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lineIndent <= classIndent && line.trim().length > 0) {
      break;
    }

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
        const afterEquals = line.substring(line.indexOf(fieldType));
        const typeArgMatch = afterEquals.match(/\w+\s*\(\s*(\w+)/);
        let resolvedType: string | undefined;
        if (typeArgMatch) {
          resolvedType = typeArgMatch[1];
        } else {
          // Multi-line field: look at subsequent lines for the first positional argument
          for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
            const trimmed = lines[j].trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
            if (trimmed.startsWith(')')) break;
            const nextArgMatch = trimmed.match(/^(\w+)/);
            if (nextArgMatch && !/^\w+\s*=/.test(trimmed)) {
              resolvedType = nextArgMatch[1];
            }
            break;
          }
        }

        fields.push({
          name: fieldName,
          fieldType,
          resolvedType:
            resolvedType && !['True', 'False', 'None', 'lambda'].includes(resolvedType)
              ? resolvedType
              : undefined,
          filePath,
          lineNumber: i,
        });
      }
    }
  }

  return fields;
}

function resolveInheritedFields(
  cls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  visited: Set<string> = new Set(),
): FieldInfo[] {
  if (visited.has(cls.name)) return [];
  visited.add(cls.name);

  const fields = [...cls.fields];
  const seen = new Set(fields.map((f) => f.name));

  for (const baseName of cls.baseClasses) {
    if (GRAPHENE_BASE_CLASSES.has(baseName) || baseName.startsWith('graphene.')) {
      continue;
    }
    const parentCls = classMap.get(baseName);
    if (parentCls) {
      const parentFields = resolveInheritedFields(parentCls, classMap, visited);
      for (const field of parentFields) {
        if (!seen.has(field.name)) {
          fields.push({ ...field, filePath: field.filePath || parentCls.filePath });
          seen.add(field.name);
        }
      }
    }
  }

  return fields;
}
