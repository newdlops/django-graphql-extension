import { ClassInfo, FieldInfo } from '../types';
import { GqlField } from '../codelens/gqlCodeLensProvider';

/** A single argument in the expanded query tree. */
export interface QueryStructureArg {
  name: string;          // snake_case backend name
  displayName: string;   // camelCase frontend name
  type: string;          // 'String' | 'Int' | 'UserFilterInput' | etc.
  required: boolean;
  /** True if a value was provided for this argument in the user's gql. */
  provided: boolean;
}

/** One row in the expanded tree. Fields can have nested children when their type is known. */
export interface QueryStructureNode {
  /** Backend snake_case name. */
  name: string;
  /** camelCase name the user writes in the gql. */
  displayName: string;
  /** User-facing type string — includes List wrapping, e.g. 'String' or '[UserType]'. */
  typeLabel: string;
  /** Name of the resolved class, if any (for click-through). */
  resolvedType?: string;
  /** Whether the resolved class is actually in the schema index. */
  resolvedTypeKnown: boolean;
  /** True iff the user's gql queries this field on this owner class. */
  queried: boolean;
  /** Arguments declared on the backend side. */
  args: QueryStructureArg[];
  /** Children — only populated when the resolved type is known and max depth isn't reached. */
  children: QueryStructureNode[];
  /**
   * True when `resolvedType` points at a class in `classMap` but we stopped
   * expanding — either because we hit the depth cap or because the class is
   * already being expanded higher in the chain (cycle guard). The UI should
   * render a collapsed twistie that fetches the subtree on demand, like a
   * debugger's variable inspector.
   */
  hasMoreChildren: boolean;
  /** Class that actually owns this field (may be a mixin, not the parent). Helpful for the UI. */
  ownerClass: string;
  /** File:line of the backend field — drives click-to-source. */
  filePath: string;
  lineNumber: number;
}

export interface QueryStructure {
  rootField: QueryStructureNode;
  queriedCount: number;
  totalCount: number;
  rootTypeName: string;
}

interface BuildCtx {
  classMap: Map<string, ClassInfo>;
  maxDepth: number;
  /** Guard against cyclic types (e.g., self-referencing). */
  expanding: Set<string>;
}

const DEFAULT_MAX_DEPTH = 3;

/**
 * GraphQL built-in + common scalars. A field whose `resolvedType` lands here
 * is a scalar leaf — it doesn't live in `classMap` but the user shouldn't see
 * it rendered as "unknown type". Kept in sync with GRAPHQL_SCALAR_NAMES in
 * grapheneParser.ts.
 */
const KNOWN_GRAPHQL_SCALARS = new Set([
  'String', 'Int', 'Float', 'Boolean', 'ID',
  'DateTime', 'Date', 'Time', 'Decimal', 'JSONString', 'UUID',
]);

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Build the complete expected tree for a given gql field, overlaying the
 * user's gql selection on top of the target class's schema.
 *
 * @param userField       the GqlField node the user is looking at (children are the queried subset)
 * @param rootCls         the class whose fields we're expanding (usually `userField`'s resolved type)
 * @param classMap        full schema map
 * @param maxDepth        recursion cap — default 3
 * @param rootFieldInfo   the backend FieldInfo for `userField` — when supplied,
 *                        its `args` become the root node's args so the Query
 *                        Structure UI can render them (e.g. `rtccEmailList(
 *                        companyId: ID!, page: Int)`). Without this, the root
 *                        args collapse to an empty list and the UI shows none.
 */
export function buildQueryStructure(
  userField: GqlField,
  rootCls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  rootFieldInfo?: FieldInfo,
): QueryStructure {
  const ctx: BuildCtx = { classMap, maxDepth, expanding: new Set() };

  // If the gql field carries an explicit arg list (e.g. `foo(x: $x, y: $y)`),
  // surface ONLY those args and mark them provided. This is what the user
  // expects: the Query Structure panel should show the gql's arguments, not
  // every arg the backend might accept. When the gql has no `(…)` at all
  // (e.g. argument-less mutation or `__typename`-only selection), fall back
  // to the full backend arg list so the user can still discover available
  // args.
  const providedArgNames = userField.argNames;
  const providedSet = providedArgNames ? new Set(providedArgNames.map(camelToSnake)) : undefined;
  const backendArgs = rootFieldInfo?.args ?? [];
  const relevantArgs = providedSet
    ? backendArgs.filter((a) => providedSet.has(a.name))
    : backendArgs;
  const rootArgs: QueryStructureArg[] = relevantArgs.map((a) => ({
    name: a.name,
    displayName: snakeToCamel(a.name),
    type: a.type,
    required: a.required,
    // Explicit list ⇒ everything listed here was provided. Without the list
    // we can't tell, so default to false — consumers that care still get the
    // backend shape.
    provided: !!providedSet,
  }));

  // The root node represents the field itself (e.g., `stocks`) whose type is rootCls.
  const root: QueryStructureNode = {
    name: camelToSnake(userField.name),
    displayName: userField.name,
    typeLabel: rootCls.name,
    resolvedType: rootCls.name,
    resolvedTypeKnown: true,
    queried: true, // the field itself is present in the gql
    args: rootArgs,
    children: expandClassFields(userField.children, rootCls, 1, ctx),
    hasMoreChildren: false,
    ownerClass: rootCls.name,
    filePath: rootCls.filePath,
    lineNumber: rootCls.lineNumber,
  };

  let queried = 0;
  let total = 0;
  const walk = (n: QueryStructureNode) => {
    for (const c of n.children) {
      total++;
      if (c.queried) queried++;
      walk(c);
    }
  };
  walk(root);

  return {
    rootField: root,
    queriedCount: queried,
    totalCount: total,
    rootTypeName: rootCls.name,
  };
}

/**
 * Build a QueryStructure from a gql selection alone, without any backend
 * class to overlay. Used when the backend return type isn't in the class
 * index so we can still show the user their own query in the inspector
 * (with `?` typeLabels) instead of dumping the field into "unresolved".
 */
export function buildPartialStructureFromGql(
  userField: GqlField,
  ownerHint?: { className: string; fieldName: string; filePath: string; lineNumber: number; resolvedTypeName?: string; args?: FieldInfo['args'] },
): QueryStructure {
  const typeLabel = ownerHint?.resolvedTypeName ?? '?';
  const rootOwner = ownerHint?.className ?? '?';
  const rootArgs: QueryStructureArg[] = (ownerHint?.args ?? []).map((a) => ({
    name: a.name,
    displayName: snakeToCamel(a.name),
    type: a.type,
    required: a.required,
    provided: false,
  }));
  const root: QueryStructureNode = {
    name: camelToSnake(userField.name),
    displayName: userField.name,
    typeLabel,
    resolvedType: ownerHint?.resolvedTypeName,
    resolvedTypeKnown: false,
    queried: true,
    args: rootArgs,
    children: userField.children.map(buildPartialChild),
    hasMoreChildren: false,
    ownerClass: rootOwner,
    filePath: ownerHint?.filePath ?? '',
    lineNumber: ownerHint?.lineNumber ?? 0,
  };

  const count = countAllNodes(root);
  return {
    rootField: root,
    queriedCount: count,
    totalCount: count,
    rootTypeName: typeLabel,
  };
}

/**
 * Build a short-lived subtree for a single class, to satisfy a lazy-expand
 * request from the webview. `ancestors` carries the names of classes that are
 * already visible in the path above this expansion so cycle guard doesn't
 * re-expand them.
 */
export function buildLazySubtree(
  cls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  ancestors: string[] = [],
  maxDepth: number = 2,
): QueryStructureNode[] {
  const ctx: BuildCtx = {
    classMap,
    maxDepth,
    expanding: new Set(ancestors),
  };
  // `expandClassFields` will add `cls.name` to `expanding` to guard against
  // re-entry one level down — we don't need to pre-seed it here.
  return expandClassFields([], cls, 1, ctx);
}

function buildPartialChild(gf: GqlField): QueryStructureNode {
  return {
    name: camelToSnake(gf.name),
    displayName: gf.name,
    typeLabel: '?',
    resolvedType: undefined,
    resolvedTypeKnown: false,
    queried: true,
    args: [],
    children: gf.children.map(buildPartialChild),
    hasMoreChildren: false,
    ownerClass: '?',
    filePath: '',
    lineNumber: 0,
  };
}

function countAllNodes(node: QueryStructureNode): number {
  let total = 0;
  for (const c of node.children) {
    total++;
    total += countAllNodes(c);
  }
  return total;
}

function expandClassFields(
  userChildren: GqlField[],
  cls: ClassInfo,
  depth: number,
  ctx: BuildCtx,
): QueryStructureNode[] {
  if (ctx.expanding.has(cls.name)) return []; // cycle guard
  ctx.expanding.add(cls.name);
  try {
    // Index the user's queried children by their snake_case name.
    const userBySnake = new Map<string, GqlField>();
    for (const gf of userChildren) userBySnake.set(camelToSnake(gf.name), gf);

    const nodes: QueryStructureNode[] = [];
    for (const field of cls.fields) {
      // Hide synthetic markers like __relay_node__.
      if (field.name.startsWith('__') && field.name.endsWith('__')) continue;

      const userSubfield = userBySnake.get(field.name);
      const queried = !!userSubfield;

      const args: QueryStructureArg[] = (field.args ?? []).map((a) => ({
        name: a.name,
        displayName: snakeToCamel(a.name),
        type: a.type,
        required: a.required,
        provided: false, // cannot detect arg provision from selection-set alone; set by caller if available
      }));

      const resolvedType = field.resolvedType;
      const resolvedCls = resolvedType ? ctx.classMap.get(resolvedType) ?? null : null;
      const isScalarLeaf = !!resolvedType && KNOWN_GRAPHQL_SCALARS.has(resolvedType);
      const typeLabel = resolvedType
        ? `${field.fieldType === 'List' ? '[' : ''}${resolvedType}${field.fieldType === 'List' ? ']' : ''}`
        : field.fieldType;

      let children: QueryStructureNode[] = [];
      let hasMoreChildren = false;
      if (resolvedCls) {
        if (depth < ctx.maxDepth && !ctx.expanding.has(resolvedCls.name)) {
          children = expandClassFields(
            userSubfield?.children ?? [],
            resolvedCls,
            depth + 1,
            ctx,
          );
          // If the resolved class has fields but recursion produced nothing
          // (e.g., pure scalar leaves collapsed into typeLabel only), we don't
          // need a lazy marker. Only mark as more-available when cycle guard
          // or depth cap actually truncated a non-empty subtree.
        } else if (resolvedCls.fields.length > 0) {
          hasMoreChildren = true;
        }
      }

      nodes.push({
        name: field.name,
        displayName: snakeToCamel(field.name),
        typeLabel,
        resolvedType,
        // Scalars aren't in classMap but they are "known" for display purposes —
        // the UI shouldn't dim them as `type-unknown`.
        resolvedTypeKnown: !!resolvedCls || isScalarLeaf,
        queried,
        args,
        children,
        hasMoreChildren,
        ownerClass: cls.name,
        filePath: field.filePath || cls.filePath,
        lineNumber: field.lineNumber,
      });
    }
    return nodes;
  } finally {
    ctx.expanding.delete(cls.name);
  }
}
