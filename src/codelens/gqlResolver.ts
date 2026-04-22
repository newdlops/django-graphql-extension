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
}

export function buildFieldIndex(classMap: Map<string, ClassInfo>): FieldIndex {
  const index: FieldIndex = new Map();
  for (const [, cls] of classMap) {
    for (const field of cls.fields) {
      // Skip inherited re-exports — only index the class that actually DECLARES
      // the field. findEntry's ancestor walk routes subclass lookups to the
      // declared owner.
      if (field.definedIn && field.definedIn !== cls.name) continue;
      const entries = index.get(field.name);
      if (entries) entries.push({ cls, field });
      else index.set(field.name, [{ cls, field }]);
    }
  }
  return index;
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

export function hasSchemaRootForOperation(
  classMap: Map<string, ClassInfo>,
  rootKind?: RootOperationKind,
): boolean {
  const allowed = rootKindsForOperation(rootKind);
  for (const [, cls] of classMap) {
    if (allowed.has(cls.kind)) return true;
  }
  return false;
}

export function collectRootFieldNames(
  classMap: Map<string, ClassInfo>,
  rootKind?: RootOperationKind,
): string[] {
  const allowed = rootKindsForOperation(rootKind);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [, cls] of classMap) {
    if (!allowed.has(cls.kind)) continue;
    for (const field of cls.fields) {
      if (field.name.startsWith('__') && field.name.endsWith('__')) continue;
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      names.push(field.name);
    }
  }
  return names;
}

export function readRootOperationKindFromGql(gqlBody: string): RootOperationKind {
  const op = /(^|[^A-Za-z_0-9])(query|mutation|subscription)\b/.exec(gqlBody)?.[2];
  return (op as RootOperationKind | undefined) ?? 'query';
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

  for (const name of candidates) {
    const cls = classMap.get(name);
    if (cls && cls.kind === 'type') return cls;
  }

  const singularPascal = pascal.replace(/s$/, '');
  if (singularPascal.length >= 6) {
    for (const [, cls] of classMap) {
      if (cls.kind === 'type' && cls.name.includes(singularPascal) && cls.name.endsWith('Type')) {
        return cls;
      }
    }
  }

  return null;
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
  const resolved = field.resolvedType
    ? classMap.get(field.resolvedType) ?? null
    : null;
  return resolved ?? inferTypeFromFieldName(gqlFieldName, classMap);
}

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
  const entries = fieldIndex.get(snakeFieldName) ?? [];

  if (parentType) {
    const direct = entries.find((e) => e.cls.name === parentType.name);
    if (direct) return { ...direct, confidence: 'exact' };
    const ancestors = collectAncestors(parentType, classMap);
    const inherited = entries.find((e) => ancestors.has(e.cls.name));
    if (inherited) return { ...inherited, confidence: 'exact' };
    return undefined;
  }

  const allowedRootKinds = rootKindsForOperation(options.rootKind);
  const rootEntries: IndexEntry[] = [];
  for (const [, cls] of classMap) {
    if (!allowedRootKinds.has(cls.kind)) continue;
    const field = cls.fields.find((f) => f.name === snakeFieldName);
    if (!field) continue;

    const declaredOwner = field.definedIn && field.definedIn !== cls.name
      ? entries.find((e) => e.cls.name === field.definedIn)
      : undefined;
    rootEntries.push(declaredOwner ?? { cls, field });
  }

  if (rootEntries.length === 0) return undefined;
  if (rootEntries.length === 1) return { ...rootEntries[0], confidence: 'exact' };

  const pick = rootEntries.find((e) => e.cls.kind === 'query')
    ?? rootEntries.find((e) => e.cls.kind === 'mutation')
    ?? rootEntries[0];
  return { ...pick, confidence: 'inferred' };
}
