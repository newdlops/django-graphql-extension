import { ClassInfo } from '../types';

/**
 * A single place that references a given type. Used by the Class Inspector UI
 * to show "where is this type used?" — which fields own it, which arguments
 * take it, and the precise location to jump to.
 */
export interface TypeReference {
  /** Class that contains the reference. */
  fromClass: string;
  /** Field name within `fromClass`. */
  fromField: string;
  /** How the type is referenced. */
  viaKind: 'field' | 'arg';
  /**
   * For `viaKind: 'arg'` this is the argument name. For `field` it's identical
   * to `fromField` — kept so clients can branch on a single shape.
   */
  label: string;
  filePath: string;
  lineNumber: number;
}

export interface TypeReferences {
  /** Fields whose resolvedType is this class. */
  usedAsFieldType: TypeReference[];
  /** Arguments (on any field anywhere) whose type is this class. */
  usedAsArgType: TypeReference[];
}

/**
 * Invert the classMap into a type-name → usages map. Pure function. Runs in
 * O(N·F) where F is average fields-per-class; cheap to rebuild on every refresh.
 *
 * Inspector UX depends on this — without it, users have to grep the backend
 * manually to find "who imports CompanyType".
 */
export function buildReverseIndex(classMap: Map<string, ClassInfo>): Map<string, TypeReferences> {
  const index = new Map<string, TypeReferences>();

  const ensure = (typeName: string): TypeReferences => {
    let existing = index.get(typeName);
    if (!existing) {
      existing = { usedAsFieldType: [], usedAsArgType: [] };
      index.set(typeName, existing);
    }
    return existing;
  };

  for (const [, cls] of classMap) {
    for (const field of cls.fields) {
      // Skip synthetic relay marker leftovers just in case.
      if (field.name.startsWith('__') && field.name.endsWith('__')) continue;

      if (field.resolvedType) {
        ensure(field.resolvedType).usedAsFieldType.push({
          fromClass: cls.name,
          fromField: field.name,
          viaKind: 'field',
          label: field.name,
          filePath: field.filePath || cls.filePath,
          lineNumber: field.lineNumber,
        });
      }

      if (field.args) {
        for (const arg of field.args) {
          // Only record references to classes actually in the schema — scalars
          // like `Int`, `String` are noise here.
          if (!classMap.has(arg.type)) continue;
          ensure(arg.type).usedAsArgType.push({
            fromClass: cls.name,
            fromField: field.name,
            viaKind: 'arg',
            label: arg.name,
            filePath: field.filePath || cls.filePath,
            lineNumber: field.lineNumber,
          });
        }
      }
    }
  }

  return index;
}
