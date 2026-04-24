import { ClassInfo, FieldInfo } from '../types';
import { camelToSnake, parseGqlFields, GqlField, FragmentDef, collectDocumentFragments, expandGqlBody, mergeFragments } from '../codelens/gqlCodeLensProvider';
import { resolveChildClass } from '../codelens/gqlResolver';

/** A multimap: class name → set of field names that at least one active gql query walked through. */
export type CoverageMap = Map<string, Set<string>>;

export interface CoverageOptions {
  classMap: Map<string, ClassInfo>;
  /**
   * Schema roots (Query / Mutation / Subscription classes) used when the gql AST
   * is at the outermost operation level and there's no parent class in context.
   */
  schemaRoots: ClassInfo[];
  /**
   * Fragment defs harvested from every gql literal in the source file. Lets a
   * spread in one literal resolve a fragment defined in another — without
   * this, cross-literal `...FragmentName` spreads are silently dropped and
   * their fields get mis-counted as "missing".
   */
  documentFragments?: Map<string, FragmentDef>;
}

/**
 * Walk every gql template body, and for each field name encountered, record it
 * against the class it belongs to (plus the original owner, so inherited
 * fields are marked queried on both the subclass and the mixin).
 *
 * Pure — does not touch any provider state, does not care whether the
 * operation is valid. A field is "covered" iff the static resolver could
 * trace it to a known backend class.
 */
export function computeQueryCoverage(
  gqlBodies: string[],
  opts: CoverageOptions,
): CoverageMap {
  const coverage: CoverageMap = new Map();
  for (const body of gqlBodies) {
    const parsed = parseGqlFields(body, opts.documentFragments);
    if (parsed.length === 0) continue;
    walk(parsed, null, opts, coverage);
  }
  return coverage;
}

/**
 * Convenience: extract bodies AND collect fragments from a document text in
 * one call, applying the same `${CONST}` → fragment-body expansion that the
 * CodeLens provider does. When a workspace index is supplied the resulting
 * bodies include appended fragment bodies (so `collectFragmentDefsFromSource`
 * inside `parseGqlFields` can resolve cross-file spreads LOCALLY) and the
 * fragment map is overlaid on the workspace-wide map so `...FragName`
 * lookups also have a fallback.
 *
 * Without the workspace index this reduces to the old same-file-only
 * behavior (used by tests and any caller that doesn't have a populated
 * workspace scan yet).
 */
export function prepareDocumentGql(
  text: string,
  workspace?: { fragments: Map<string, FragmentDef>; constBodies: Map<string, string> },
): { bodies: string[]; fragments: Map<string, FragmentDef> } {
  const rawBodies = extractRawGqlBodies(text);
  const bodies = rawBodies.map((raw) =>
    workspace?.constBodies ? expandGqlBody(raw, workspace.constBodies) : stripInterpolations(raw),
  );
  const docFragments = collectDocumentFragments(text);
  const fragments = workspace?.fragments
    ? mergeFragments(workspace.fragments, docFragments)
    : docFragments;
  return { bodies, fragments };
}

function stripInterpolations(body: string): string {
  // Preserves offsets (spaces) the way extractGqlBodies did before expansion
  // was available — still the right thing to do when no workspace const map
  // is provided.
  return body.replace(/\$\{[^}]*\}/g, (match) => ' '.repeat(match.length));
}

function walk(
  nodes: GqlField[],
  parentCls: ClassInfo | null,
  opts: CoverageOptions,
  coverage: CoverageMap,
): void {
  for (const gf of nodes) {
    const snakeName = camelToSnake(gf.name);
    const resolved = resolveField(parentCls, snakeName, opts);
    if (!resolved) continue;

    record(coverage, resolved.matchedOn.name, snakeName);
    if (resolved.owner !== resolved.matchedOn) {
      record(coverage, resolved.owner.name, snakeName);
    }

    if (gf.children.length === 0) continue;
    const childCls = resolveChildClass(resolved.field, gf.name, opts.classMap);
    // If the child type is unknown, do NOT recurse into children — mirrors
    // the phase (j) CodeLens rule so we don't mis-record coverage.
    if (childCls) walk(gf.children, childCls, opts, coverage);
  }
}

interface ResolvedField {
  /**
   * The class against which the lookup was performed. For a root-level lookup
   * this is the Query/Mutation root; otherwise the parent class.
   */
  matchedOn: ClassInfo;
  /** The class where the field is actually declared (often same as matchedOn, but can be a mixin base). */
  owner: ClassInfo;
  field: FieldInfo;
}

function resolveField(
  parentCls: ClassInfo | null,
  snakeName: string,
  opts: CoverageOptions,
): ResolvedField | undefined {
  if (parentCls) {
    const direct = parentCls.fields.find((f) => f.name === snakeName);
    if (direct) return { matchedOn: parentCls, owner: parentCls, field: direct };

    for (const ancestorName of collectAncestors(parentCls, opts.classMap)) {
      const ancestor = opts.classMap.get(ancestorName);
      if (!ancestor) continue;
      const field = ancestor.fields.find((f) => f.name === snakeName);
      if (field) return { matchedOn: parentCls, owner: ancestor, field };
    }
    return undefined;
  }

  // Root-level lookup: scan schema roots.
  for (const root of opts.schemaRoots) {
    const direct = root.fields.find((f) => f.name === snakeName);
    if (direct) return { matchedOn: root, owner: root, field: direct };
  }
  return undefined;
}

function collectAncestors(cls: ClassInfo, classMap: Map<string, ClassInfo>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...cls.baseClasses];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    const base = classMap.get(name);
    if (base) stack.push(...base.baseClasses);
  }
  return out;
}

function record(coverage: CoverageMap, className: string, fieldName: string): void {
  let set = coverage.get(className);
  if (!set) {
    set = new Set();
    coverage.set(className, set);
  }
  set.add(fieldName);
}

/**
 * Extract every gql/graphql template literal body from a file's text. Used by
 * the editor watcher to feed computeQueryCoverage. Mirrors the regex used by
 * gqlCodeLensProvider so the coverage and CodeLens see the same templates.
 */
export function extractGqlBodies(text: string): string[] {
  return extractRawGqlBodies(text).map((b) => b.replace(/\$\{[^}]*\}/g, (m) => ' '.repeat(m.length)));
}

/**
 * Same template detection as `extractGqlBodies`, but preserves `${CONST}`
 * interpolations verbatim — callers that want to follow those references
 * (e.g. via `expandGqlBody`) need the un-stripped source.
 */
export function extractRawGqlBodies(text: string): string[] {
  const out: string[] = [];
  const re = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tickIdx = text.indexOf('`', m.index);
    if (tickIdx === -1) continue;
    const start = tickIdx + 1;
    let end = start;
    while (end < text.length) {
      if (text[end] === '`') break;
      if (text[end] === '\\') { end += 2; continue; }
      if (text[end] === '$' && text[end + 1] === '{') {
        end += 2;
        let depth = 1;
        while (end < text.length && depth > 0) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}') depth--;
          end++;
        }
        continue;
      }
      end++;
    }
    if (end <= start) continue;
    out.push(text.substring(start, end));
  }
  return out;
}
