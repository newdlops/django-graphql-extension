import { ClassInfo } from '../types';
import { parseGqlFields, GqlField, camelToSnake, collectDocumentFragments } from './gqlCodeLensProvider';
import { FieldIndex, findEntry, MatchedEntry } from './gqlResolver';

export interface CursorContext {
  /** The gql field the cursor is inside (innermost). */
  gqlField: GqlField;
  /** Matched backend entry for `gqlField`. */
  match: MatchedEntry;
  /** Target class to expand — the field's resolvedType, or the owner if no resolvedType. */
  targetClass: ClassInfo;
  /** Byte offset where the gql template body starts in the document text. */
  bodyStart: number;
}

export interface TemplateRoot {
  gqlField: GqlField;
  /** Undefined if the root field can't be resolved against schema roots. */
  match?: MatchedEntry;
  targetClass?: ClassInfo;
}

export interface TemplateContext {
  operationKind: 'query' | 'mutation' | 'subscription' | 'unknown';
  operationName?: string;
  /** Every top-level field inside the operation body. */
  roots: TemplateRoot[];
  bodyStart: number;
  bodyEnd: number;
}

interface ResolveCtx {
  classMap: Map<string, ClassInfo>;
  fieldIndex: FieldIndex;
}

/**
 * Find the gql template the cursor is inside and return every top-level field
 * in its operation body, each paired with its resolved backend class (if any).
 * Use this when the UI wants a whole-template view — e.g., the Live Query
 * Inspector that shows the complete structure at all levels.
 */
export function resolveTemplateAtCursor(
  text: string,
  cursorOffset: number,
  ctx: ResolveCtx,
): TemplateContext | null {
  const docFragments = collectDocumentFragments(text);
  const gqlRegex = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;

  while ((m = gqlRegex.exec(text)) !== null) {
    const backtickIdx = text.indexOf('`', m.index);
    if (backtickIdx === -1) continue;
    const bodyStart = backtickIdx + 1;
    const bodyEnd = findTemplateEnd(text, bodyStart);
    if (bodyEnd === -1) continue;
    if (cursorOffset < bodyStart || cursorOffset > bodyEnd) continue;

    const rawBody = text.substring(bodyStart, bodyEnd);
    const gqlBody = stripInterpolations(rawBody);
    const parsed = parseGqlFields(gqlBody, docFragments);

    // Detect the operation keyword and its name.
    const opMatch = gqlBody.match(/^\s*(query|mutation|subscription)\b\s*(\w+)?/);
    const operationKind = (opMatch?.[1] as TemplateContext['operationKind']) ?? 'unknown';
    const operationName = opMatch?.[2];

    const roots: TemplateRoot[] = parsed.map((gf) => {
      const snake = camelToSnake(gf.name);
      const match = findEntry(ctx.fieldIndex, ctx.classMap, snake, null);
      const target = match?.field.resolvedType
        ? ctx.classMap.get(match.field.resolvedType) ?? undefined
        : match?.cls;
      return { gqlField: gf, match, targetClass: target };
    });

    return { operationKind, operationName, roots, bodyStart, bodyEnd };
  }
  return null;
}

/**
 * Given a document text and a cursor offset, return the innermost gql field
 * the cursor is inside plus the resolved backend context. Returns null if the
 * cursor isn't inside a gql template or the innermost field can't be resolved.
 */
export function resolveFieldAtCursor(
  text: string,
  cursorOffset: number,
  ctx: ResolveCtx,
): CursorContext | null {
  const docFragments = collectDocumentFragments(text);
  const gqlRegex = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;

  while ((m = gqlRegex.exec(text)) !== null) {
    const backtickIdx = text.indexOf('`', m.index);
    if (backtickIdx === -1) continue;
    const bodyStart = backtickIdx + 1;
    const bodyEnd = findTemplateEnd(text, bodyStart);
    if (bodyEnd === -1) continue;
    if (cursorOffset < bodyStart || cursorOffset > bodyEnd) continue;

    const rawBody = text.substring(bodyStart, bodyEnd);
    const gqlBody = stripInterpolations(rawBody);
    const parsed = parseGqlFields(gqlBody, docFragments);

    const bodyOffset = cursorOffset - bodyStart;
    const walked = walkForCursor(parsed, null, bodyOffset, ctx);
    if (walked) return { ...walked, bodyStart };
    return null;
  }
  return null;
}

interface PartialCtx {
  gqlField: GqlField;
  match: MatchedEntry;
  targetClass: ClassInfo;
}

function walkForCursor(
  fields: GqlField[],
  parentCls: ClassInfo | null,
  cursorInBody: number,
  ctx: ResolveCtx,
): PartialCtx | null {
  let last: PartialCtx | null = null;
  for (const gf of fields) {
    // Figure out the field's range: from nameOffset through its closing brace
    // if it has one, else through nameOffset+nameLength.
    const fieldStart = gf.nameOffset;
    // If there are children the field's range extends to the last child's end.
    const fieldEnd = rangeEnd(gf);
    if (cursorInBody < fieldStart || cursorInBody > fieldEnd) continue;

    const snake = camelToSnake(gf.name);
    const match = findEntry(ctx.fieldIndex, ctx.classMap, snake, parentCls);
    if (!match) continue;

    // The target class to visualize is the field's resolvedType (if known),
    // or the owning class otherwise.
    const target = match.field.resolvedType
      ? ctx.classMap.get(match.field.resolvedType) ?? null
      : null;
    // Without a resolved type we still want to show SOMETHING — fall back to
    // the match's own owning class so the user sees its fields.
    const targetClass = target ?? match.cls;

    last = { gqlField: gf, match, targetClass };

    // If children exist and cursor is INSIDE them, descend — inner match wins.
    if (gf.children.length > 0) {
      const nested = walkForCursor(gf.children, target, cursorInBody, ctx);
      if (nested) return nested;
    }
  }
  return last;
}

function rangeEnd(gf: GqlField): number {
  if (gf.children.length === 0) return gf.nameOffset + gf.nameLength + 1024; // generous tail
  let max = gf.nameOffset + gf.nameLength;
  for (const c of gf.children) {
    const e = rangeEnd(c);
    if (e > max) max = e;
  }
  return max;
}

function stripInterpolations(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      out += '  '; i += 2;
      let depth = 1;
      while (i < body.length && depth > 0) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
        out += ' ';
        i++;
      }
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}

function findTemplateEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') return i;
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$' && text[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return -1;
}
