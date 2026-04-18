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

/**
 * Strict resolver — see phase (n). If `parentType` is provided, the match must
 * belong to it or one of its ancestors; otherwise we return `undefined` rather
 * than guessing. Root-level resolution returns `'inferred'` for ambiguity.
 */
export function findEntry(
  fieldIndex: FieldIndex,
  classMap: Map<string, ClassInfo>,
  snakeFieldName: string,
  parentType: ClassInfo | null,
): MatchedEntry | undefined {
  const entries = fieldIndex.get(snakeFieldName);
  if (!entries || entries.length === 0) return undefined;

  if (parentType) {
    const direct = entries.find((e) => e.cls.name === parentType.name);
    if (direct) return { ...direct, confidence: 'exact' };
    const ancestors = collectAncestors(parentType, classMap);
    const inherited = entries.find((e) => ancestors.has(e.cls.name));
    if (inherited) return { ...inherited, confidence: 'exact' };
    return undefined;
  }

  if (entries.length === 1) return { ...entries[0], confidence: 'exact' };

  const qmEntry = entries.find((e) => e.cls.kind === 'query' || e.cls.kind === 'mutation');
  const typeEntry = entries.find((e) => e.cls.kind === 'type');
  const pick = qmEntry ?? typeEntry ?? entries[0];
  return { ...pick, confidence: 'inferred' };
}
