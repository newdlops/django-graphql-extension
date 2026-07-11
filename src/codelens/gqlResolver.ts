// Shared resolution logic for CodeLens, InlayHints, and Diagnostics providers.
// The goal: all three providers agree on "which backend class/field does this
// gql field name map to?" so users see a consistent story.

import { ClassInfo, FieldInfo } from '../types';

export interface IndexEntry {
  cls: ClassInfo;
  field: FieldInfo;
}

export interface MatchedEntry extends IndexEntry {
  /**
   * `exact`    — field belongs to parentType itself OR one of its ancestors,
   *              OR it was the sole root-level candidate.
   * `inferred` — multiple root-level candidates existed; best-effort pick.
   */
  confidence: 'exact' | 'inferred';
}

/** snake_case field name → every class that declares it. */
export type FieldIndex = Map<string, IndexEntry[]>;

export type RootOperationKind = 'query' | 'mutation' | 'subscription' | 'unknown';

export interface ResolveOptions {
  /**
   * Operation kind for root-level gql fields. When present, root resolution is
   * scoped to that schema root instead of treating every root kind as a
   * candidate.
   */
  rootKind?: RootOperationKind;
  /** Exact name as written in the GraphQL document, before case conversion. */
  graphqlFieldName?: string;
}

/** A schema-local resolver index. Class names are only unique inside this boundary. */
export interface ResolutionContext {
  id: string;
  schemaFilePath: string;
  classMap: Map<string, ClassInfo>;
  fieldIndex: FieldIndex;
  completeness?: number;
  /** Per-selection flag used by UI callers; not part of the stored schema index. */
  selectionAmbiguous?: boolean;
}

/** Minimal selection shape used to score a gql operation without importing its parser types. */
export interface GraphqlSelection {
  name: string;
  children: GraphqlSelection[];
  typeCondition?: string;
}

export interface SelectedResolutionContext {
  context: ResolutionContext;
  /** True when multiple schemas remained equally plausible after scoring. */
  ambiguous: boolean;
}

export function buildFieldIndex(classMap: Map<string, ClassInfo>): FieldIndex {
  const index: FieldIndex = new Map();
  const add = (key: string, entry: IndexEntry): void => {
    const entries = index.get(key);
    if (entries) {
      if (!entries.some((existing) => existing.cls === entry.cls && existing.field === entry.field)) {
        entries.push(entry);
      }
    } else {
      index.set(key, [entry]);
    }
  };
  for (const [, cls] of classMap) {
    for (const field of cls.fields) {
      // Skip inherited re-exports — only index the class that actually DECLARES
      // the field. findEntry's ancestor walk routes subclass lookups to the
      // declared owner.
      if (field.definedIn && field.definedIn !== cls.name) continue;
      const entry = { cls, field };
      // An explicit wire name replaces the source/Python name in GraphQL; the
      // latter must remain navigation metadata only.  Indexing both would make
      // `{ userByPk }` look valid for `user_by_pk = Field(name="user")`.
      add(field.graphqlName ?? field.name, entry);
    }
  }
  return index;
}

function camelToSnake(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Match a source field against the exact name exposed by GraphQL. */
export function fieldMatchesGraphqlName(field: FieldInfo, graphqlFieldName: string): boolean {
  return field.graphqlName !== undefined
    ? field.graphqlName === graphqlFieldName
    : field.name === graphqlFieldName || field.name === camelToSnake(graphqlFieldName);
}

function fieldMatches(field: FieldInfo, snakeFieldName: string, graphqlFieldName?: string): boolean {
  if (graphqlFieldName && fieldMatchesGraphqlName(field, graphqlFieldName)) return true;
  return field.graphqlName === undefined && field.name === snakeFieldName;
}

function lookupEntries(
  fieldIndex: FieldIndex,
  snakeFieldName: string,
  graphqlFieldName?: string,
): IndexEntry[] {
  const out: IndexEntry[] = [];
  const add = (entries: IndexEntry[] | undefined): void => {
    for (const entry of entries ?? []) {
      if (!out.some((existing) => existing.cls === entry.cls && existing.field === entry.field)) {
        out.push(entry);
      }
    }
  };
  if (graphqlFieldName) add(fieldIndex.get(graphqlFieldName));
  add(fieldIndex.get(snakeFieldName));
  return out;
}

export function collectAncestors(cls: ClassInfo, classMap: Map<string, ClassInfo>): Set<string> {
  const out = new Set<string>();
  const stack = [...cls.baseClasses];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (out.has(name)) continue;
    out.add(name);
    const base = classMap.get(name);
    if (base) stack.push(...base.baseClasses);
  }
  return out;
}

export function isSchemaRootKind(kind: ClassInfo['kind']): boolean {
  return kind === 'query' || kind === 'mutation' || kind === 'subscription';
}

export function rootKindsForOperation(rootKind?: RootOperationKind): Set<ClassInfo['kind']> {
  if (rootKind === 'mutation') return new Set(['mutation']);
  if (rootKind === 'subscription') return new Set(['subscription']);
  if (rootKind === 'query') return new Set(['query']);
  return new Set(['query', 'mutation', 'subscription']);
}

/**
 * Return the concrete schema roots for an operation.  Older callers and test
 * fixtures may not have `isSchemaRoot` yet, so we retain the legacy kind-based
 * behavior only when the index contains no explicit root metadata at all.
 */
export function schemaRootsForOperation(
  classMap: Map<string, ClassInfo>,
  rootKind?: RootOperationKind,
): ClassInfo[] {
  const allowed = rootKindsForOperation(rootKind);
  const classes = [...classMap.values()];
  const candidates = classes.filter((cls) => allowed.has(cls.kind));
  // Once a scanner supplies root metadata anywhere in this schema index, an
  // unmarked operation kind means that operation has no configured root.  Do
  // not resurrect mutation payloads (or query mixins) through the legacy
  // fallback merely because that particular kind has no marked class.
  const hasRootMetadata = classes.some((cls) => cls.isSchemaRoot === true);
  return hasRootMetadata
    ? candidates.filter((cls) => cls.isSchemaRoot === true || cls.isSchemaRootContributor === true)
    : candidates;
}

export function hasSchemaRootForOperation(
  classMap: Map<string, ClassInfo>,
  rootKind?: RootOperationKind,
): boolean {
  return schemaRootsForOperation(classMap, rootKind).length > 0;
}

export function collectRootFieldNames(
  classMap: Map<string, ClassInfo>,
  rootKind?: RootOperationKind,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const cls of schemaRootsForOperation(classMap, rootKind)) {
    for (const field of cls.fields) {
      if (field.name.startsWith('__') && field.name.endsWith('__')) continue;
      const name = field.graphqlName ?? field.name;
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function readRootOperationKindFromGql(gqlBody: string): RootOperationKind {
  return findGraphqlOperation(gqlBody)?.kind ?? 'query';
}

/** Locate the first real operation keyword, ignoring comments and string values. */
export function findGraphqlOperation(
  gqlBody: string,
): { kind: Exclude<RootOperationKind, 'unknown'>; keywordEnd: number } | null {
  const masked = maskGraphqlCommentsAndStrings(gqlBody);
  const match = /(^|[^A-Za-z_0-9])(query|mutation|subscription)\b/.exec(masked);
  if (!match) return null;
  return {
    kind: match[2] as Exclude<RootOperationKind, 'unknown'>,
    keywordEnd: match.index + match[0].length,
  };
}

function maskGraphqlCommentsAndStrings(source: string): string {
  const chars = [...source];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '#') {
      while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
      continue;
    }
    if (chars[i] !== '"') { i++; continue; }
    const triple = chars[i + 1] === '"' && chars[i + 2] === '"';
    const quoteLength = triple ? 3 : 1;
    for (let q = 0; q < quoteLength; q++) chars[i + q] = ' ';
    i += quoteLength;
    while (i < chars.length) {
      if (!triple && chars[i] === '\\') {
        chars[i++] = ' ';
        if (i < chars.length) chars[i++] = ' ';
        continue;
      }
      const closes = triple
        ? chars[i] === '"' && chars[i + 1] === '"' && chars[i + 2] === '"'
        : chars[i] === '"';
      if (closes) {
        for (let q = 0; q < quoteLength; q++) chars[i + q] = ' ';
        i += quoteLength;
        break;
      }
      if (chars[i] !== '\n') chars[i] = ' ';
      i++;
    }
  }
  return chars.join('');
}

/** GraphQL meta fields exist independently of user-defined backend fields. */
export function isGraphqlMetaField(
  graphqlFieldName: string,
  parentType: ClassInfo | null,
  rootKind: RootOperationKind,
): boolean {
  if (graphqlFieldName === '__typename') return true;
  return parentType === null
    && rootKind === 'query'
    && (graphqlFieldName === '__schema' || graphqlFieldName === '__type');
}

/**
 * When a gql literal has NO query/mutation/subscription and DOES declare a
 * fragment, returns the fragment's target type (the identifier after `on`).
 * Providers use this to walk the fragment body as children of that type,
 * so typos inside stand-alone fragment modules (e.g. `fragments.ts`) get
 * the same diagnostics and inlay hints that query bodies do.
 *
 * Literals that also contain a real operation return null — those are
 * walked from the operation's selection set, and same-literal fragments
 * are inlined at spread sites instead of being analyzed directly.
 */
export function readFragmentContextFromGql(gqlBody: string): { onType: string } | null {
  if (findGraphqlOperation(gqlBody)) return null;
  const m = /\bfragment\s+[A-Za-z_]\w*\s+on\s+([A-Za-z_]\w*)\s*\{/.exec(gqlBody);
  if (!m) return null;
  return { onType: m[1] };
}

/**
 * Infer the backend type class from a frontend field name.
 * Mirrors the fallback used by the CodeLens provider for fields whose
 * `resolvedType` is absent or points at a class not present in `classMap`.
 */
export function inferTypeFromFieldName(
  camelFieldName: string,
  classMap: Map<string, ClassInfo>,
): ClassInfo | null {
  const snakeName = camelFieldName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
  const pascal = snakeName.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

  const candidates = [
    `${pascal}Type`,
    `${pascal}`,
    `${pascal.replace(/s$/, '')}Type`,
    `${pascal.replace(/s$/, '')}`,
    `${pascal.replace(/List$/, '')}Type`,
  ];

  const exact = new Set<ClassInfo>();
  for (const name of candidates) {
    const cls = classMap.get(name);
    if (cls && cls.kind === 'type') exact.add(cls);
  }
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) return null;

  const singularPascal = pascal.replace(/s$/, '');
  if (singularPascal.length >= 6) {
    const fuzzy: ClassInfo[] = [];
    for (const [, cls] of classMap) {
      if (cls.kind === 'type' && cls.name.includes(singularPascal) && cls.name.endsWith('Type')) {
        fuzzy.push(cls);
      }
    }
    if (fuzzy.length === 1) return fuzzy[0];
  }

  return null;
}

/** Resolve either a source class name or an explicitly overridden wire type name. */
export function findClassByGraphqlName(
  classMap: Map<string, ClassInfo>,
  typeName: string,
): ClassInfo | null {
  return classMap.get(typeName)
    ?? [...classMap.values()].find((cls) => cls.graphqlName === typeName)
    ?? null;
}

/**
 * Child traversal helper shared by CodeLens, hover, inlay hints, diagnostics,
 * cursor resolution, and coverage. Prefer the recorded `resolvedType`, but
 * fall back to field-name inference exactly like the provider does.
 */
export function resolveChildClass(
  field: FieldInfo,
  gqlFieldName: string,
  classMap: Map<string, ClassInfo>,
): ClassInfo | null {
  // An explicit scanner result is authoritative.  If that type is absent
  // from the index, guessing a similarly named local type can walk into the
  // wrong backend class and make every descendant link/diagnostic misleading.
  if (field.resolvedType) return findClassByGraphqlName(classMap, field.resolvedType);

  // Never infer an object type for a known scalar solely from its field name.
  const scalar = field.fieldType.replace(/[!\[\]\s]/g, '').toLowerCase();
  if (SCALAR_FIELD_TYPES.has(scalar)) return null;

  return inferTypeFromFieldName(gqlFieldName, classMap);
}

const SCALAR_FIELD_TYPES = new Set([
  'string', 'str', 'int', 'integer', 'float', 'boolean', 'bool', 'id',
  'datetime', 'date', 'time', 'decimal', 'json', 'jsonstring', 'uuid',
]);

/**
 * Strict resolver — see phase (n). If `parentType` is provided, the match must
 * belong to it or one of its ancestors; otherwise we return `undefined` rather
 * than guessing. Root-level resolution is intentionally limited to schema
 * roots; regular object-type fields must never satisfy a top-level operation
 * field, because that makes invalid gql selections look like real backend
 * entry points.
 */
export function findEntry(
  fieldIndex: FieldIndex,
  classMap: Map<string, ClassInfo>,
  snakeFieldName: string,
  parentType: ClassInfo | null,
  options: ResolveOptions = {},
): MatchedEntry | undefined {
  const entries = lookupEntries(fieldIndex, snakeFieldName, options.graphqlFieldName);

  if (parentType) {
    const direct = entries.find((e) => e.cls.name === parentType.name);
    if (direct) return { ...direct, confidence: 'exact' };
    const ancestors = collectAncestors(parentType, classMap);
    const inherited = entries.find((e) => ancestors.has(e.cls.name));
    if (inherited) return { ...inherited, confidence: 'exact' };
    return undefined;
  }

  const rootEntries: IndexEntry[] = [];
  for (const cls of schemaRootsForOperation(classMap, options.rootKind)) {
    const field = cls.fields.find((f) => fieldMatches(f, snakeFieldName, options.graphqlFieldName));
    if (!field) continue;

    const declaredOwner = field.definedIn && field.definedIn !== cls.name
      ? entries.find((e) => e.cls.name === field.definedIn)
      : undefined;
    const candidate = declaredOwner ?? { cls, field };
    if (!rootEntries.some((entry) => entry.cls === candidate.cls && entry.field === candidate.field)) {
      rootEntries.push(candidate);
    }
  }

  if (rootEntries.length === 0) return undefined;
  if (rootEntries.length === 1) return { ...rootEntries[0], confidence: 'exact' };

  const pick = rootEntries.find((e) => e.cls.kind === 'query')
    ?? rootEntries.find((e) => e.cls.kind === 'mutation')
    ?? rootEntries[0];
  return { ...pick, confidence: 'inferred' };
}

/**
 * Pick the schema-local index that best explains the complete gql selection.
 * Root matches dominate the score; nested fields disambiguate common roots
 * such as `user`.  File proximity and schema completeness are deterministic
 * tie-breakers, never scan/insertion order.
 */
export function selectResolutionContext(
  contexts: ResolutionContext[] | undefined,
  fields: GraphqlSelection[],
  rootKind: RootOperationKind,
  options: { fragmentType?: string; documentPath?: string } = {},
): SelectedResolutionContext | undefined {
  if (!contexts || contexts.length === 0) return undefined;

  const ranked = contexts.map((context) => {
    const semanticScore = options.fragmentType
      ? scoreFragmentContext(context, fields, options.fragmentType)
      : scoreOperationContext(context, fields, rootKind);
    return {
      context,
      semanticScore,
      proximity: commonPathSegments(options.documentPath, context.schemaFilePath),
      completeness: contextCompleteness(context),
    };
  }).sort((a, b) =>
    b.semanticScore - a.semanticScore
    || b.proximity - a.proximity
    || b.completeness - a.completeness
    || a.context.schemaFilePath.localeCompare(b.context.schemaFilePath)
    || a.context.id.localeCompare(b.context.id),
  );

  const best = ranked[0];
  const second = ranked[1];
  return {
    context: best.context,
    ambiguous: !!second
      && second.semanticScore === best.semanticScore
      && second.proximity === best.proximity,
  };
}

function scoreOperationContext(
  context: ResolutionContext,
  fields: GraphqlSelection[],
  rootKind: RootOperationKind,
): number {
  let score = 0;
  for (const field of fields) {
    const entry = findEntry(
      context.fieldIndex,
      context.classMap,
      camelToSnake(field.name),
      null,
      { rootKind, graphqlFieldName: field.name },
    );
    if (!entry) {
      score -= 100;
      continue;
    }
    score += 100;
    if (field.children.length > 0) {
      const child = resolveChildClass(entry.field, field.name, context.classMap);
      score += child
        ? scoreNestedSelections(context, field.children, child)
        : -field.children.length * 4;
    }
  }
  return score;
}

function scoreFragmentContext(
  context: ResolutionContext,
  fields: GraphqlSelection[],
  fragmentType: string,
): number {
  const parent = findClassByGraphqlName(context.classMap, fragmentType);
  return parent ? 100 + scoreNestedSelections(context, fields, parent) : -1000;
}

function scoreNestedSelections(
  context: ResolutionContext,
  fields: GraphqlSelection[],
  parent: ClassInfo,
): number {
  let score = 0;
  for (const field of fields) {
    const conditionedParent = field.typeCondition
      ? findClassByGraphqlName(context.classMap, field.typeCondition)
      : null;
    if (field.typeCondition && !conditionedParent) {
      score -= 10;
      continue;
    }
    const effectiveParent = conditionedParent ?? parent;
    if (isGraphqlMetaField(field.name, effectiveParent, 'unknown')) {
      score += 1;
      continue;
    }
    const entry = findEntry(
      context.fieldIndex,
      context.classMap,
      camelToSnake(field.name),
      effectiveParent,
      { rootKind: 'unknown', graphqlFieldName: field.name },
    );
    if (!entry) {
      score -= 6;
      continue;
    }
    score += 6;
    if (field.children.length > 0) {
      const child = resolveChildClass(entry.field, field.name, context.classMap);
      score += child
        ? scoreNestedSelections(context, field.children, child)
        : -field.children.length * 2;
    }
  }
  return score;
}

function commonPathSegments(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const aa = a.replace(/\\/g, '/').split('/').filter(Boolean);
  const bb = b.replace(/\\/g, '/').split('/').filter(Boolean);
  let i = 0;
  while (i < aa.length && i < bb.length && aa[i] === bb[i]) i++;
  return i;
}

function contextCompleteness(context: ResolutionContext): number {
  if (context.completeness !== undefined) return context.completeness;
  let fields = 0;
  for (const cls of context.classMap.values()) fields += cls.fields.length;
  return fields * 1000 + context.classMap.size;
}
