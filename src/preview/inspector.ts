import { ClassInfo } from '../types';
import { TypeReferences, TypeReference, buildReverseIndex } from '../scanner/reverseIndex';
import { classToGraphql } from './schemaPreview';

export interface InspectorArgRow {
  name: string;
  type: string;
  required: boolean;
  /** If true, clicking the type chip should navigate to that class. */
  typeExists: boolean;
}

export interface InspectorFieldRow {
  /** Backend name (snake_case). */
  name: string;
  /** Frontend name (camelCase) used in queries. */
  displayName: string;
  fieldType: string;
  resolvedType?: string;
  /** Whether resolvedType is a class we know about (i.e., clickable chip). */
  resolvedTypeExists: boolean;
  args: InspectorArgRow[];
  filePath: string;
  lineNumber: number;
  /** 'own' if declared directly on this class, 'inherited' if merged from a mixin/base. */
  origin: 'own' | 'inherited';
  /** True iff at least one active gql template walks through this field on this class. */
  queried: boolean;
}

export interface InspectorPayload {
  className: string;
  kind: ClassInfo['kind'];
  filePath: string;
  lineNumber: number;
  baseClasses: string[];
  /** Subset of baseClasses that exist in classMap — clickable chips. */
  knownBaseClasses: string[];
  fields: InspectorFieldRow[];
  /** Number of fields (inherited included) that at least one active gql template queries. */
  queriedCount: number;
  /** Total field rows shown (excluding synthetic markers). */
  totalCount: number;
  /** Other classes with a field whose resolvedType is this class. */
  usedAsFieldType: TypeReference[];
  /** Fields (anywhere) whose argument type is this class. */
  usedAsArgType: TypeReference[];
  /** Generated SDL preview — shown in a collapsible section. */
  sdl: string;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Build a self-contained payload for rendering a class in the Inspector webview.
 * Pure, serializable — safe to `postMessage`. Returns null for unknown classes.
 *
 * `coverageForClass` is the set of field names that at least one active gql
 * template queries on this class (from computeQueryCoverage). Pass an empty
 * set when no gql is active — every field renders as unqueried.
 */
export function buildInspectorData(
  className: string,
  classMap: Map<string, ClassInfo>,
  reverseIndex: Map<string, TypeReferences>,
  coverageForClass: Set<string> = new Set(),
): InspectorPayload | null {
  const cls = classMap.get(className);
  if (!cls) return null;

  const rows: InspectorFieldRow[] = cls.fields
    // Hide synthetic markers like __relay_node__ — they're internal wiring.
    .filter((f) => !(f.name.startsWith('__') && f.name.endsWith('__')))
    .map((f) => {
      // "own" if this field's source file matches the class's own file;
      // otherwise it was merged in from a base class by resolveInheritedFields.
      // This is a heuristic (two classes can live in the same file), but it's
      // accurate in the common case and better than dropping the signal.
      const origin: InspectorFieldRow['origin'] =
        f.filePath === cls.filePath ? 'own' : 'inherited';

      const args: InspectorArgRow[] = (f.args ?? []).map((a) => ({
        name: a.name,
        type: a.type,
        required: a.required,
        typeExists: classMap.has(a.type),
      }));

      return {
        name: f.name,
        displayName: snakeToCamel(f.name),
        fieldType: f.fieldType,
        resolvedType: f.resolvedType,
        resolvedTypeExists: !!f.resolvedType && classMap.has(f.resolvedType),
        args,
        filePath: f.filePath || cls.filePath,
        lineNumber: f.lineNumber,
        origin,
        queried: coverageForClass.has(f.name),
      };
    });

  const refs: TypeReferences = reverseIndex.get(className) ?? { usedAsFieldType: [], usedAsArgType: [] };

  const knownBaseClasses = cls.baseClasses.filter((b) => classMap.has(b));

  const queriedCount = rows.filter((r) => r.queried).length;

  return {
    className: cls.name,
    kind: cls.kind,
    filePath: cls.filePath,
    lineNumber: cls.lineNumber,
    baseClasses: cls.baseClasses,
    knownBaseClasses,
    fields: rows,
    queriedCount,
    totalCount: rows.length,
    usedAsFieldType: refs.usedAsFieldType,
    usedAsArgType: refs.usedAsArgType,
    sdl: classToGraphql(cls, classMap),
  };
}

/**
 * Convenience wrapper that builds the reverse index once and returns the
 * inspector payload. Callers that inspect many classes in a row should call
 * buildReverseIndex themselves to avoid rebuilding per class.
 */
export function buildInspectorDataFresh(
  className: string,
  classMap: Map<string, ClassInfo>,
): InspectorPayload | null {
  return buildInspectorData(className, classMap, buildReverseIndex(classMap));
}
