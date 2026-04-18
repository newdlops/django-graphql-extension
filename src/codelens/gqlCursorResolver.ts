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

/**
 * One operation-level variable declared after the operation name, e.g.
 * `$companyId: ID!` → `{ name: 'companyId', type: 'ID', required: true }`.
 * These appear only on named operations — inline queries without a name and
 * without parens carry no variables.
 */
export interface OperationVariable {
  name: string;
  type: string;
  required: boolean;
  list: boolean;
  defaultValue?: string;
}

export interface TemplateContext {
  operationKind: 'query' | 'mutation' | 'subscription' | 'unknown';
  operationName?: string;
  /** Variables declared in the operation's `(...)` header. Empty when absent. */
  operationVariables: OperationVariable[];
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
    const operationVariables = parseOperationVariables(gqlBody);

    const roots: TemplateRoot[] = parsed.map((gf) => {
      const snake = camelToSnake(gf.name);
      const match = findEntry(ctx.fieldIndex, ctx.classMap, snake, null);
      const target = match?.field.resolvedType
        ? ctx.classMap.get(match.field.resolvedType) ?? undefined
        : match?.cls;
      return { gqlField: gf, match, targetClass: target };
    });

    return { operationKind, operationName, operationVariables, roots, bodyStart, bodyEnd };
  }
  return null;
}

/**
 * Parse the variable declarations from a named operation header, e.g.
 *     query RtccEmailList($companyId: ID!, $page: Int) { … }
 * Returns each `$name: Type` pair (commas optional), with `list` and
 * `required` extracted from the GraphQL type syntax. Default values (`= …`)
 * are kept verbatim as a display hint. Designed to run on the stripped gql
 * body so `${…}` interpolations don't confuse it.
 */
export function parseOperationVariables(gql: string): OperationVariable[] {
  const out: OperationVariable[] = [];
  const opRe = /^\s*(?:query|mutation|subscription)\b\s*(?:\w+\s*)?\(/;
  const headerMatch = gql.match(opRe);
  if (!headerMatch) return out;
  const openIdx = headerMatch[0].length - 1;
  // Find the matching close paren.
  let depth = 1;
  let i = openIdx + 1;
  while (i < gql.length && depth > 0) {
    if (gql[i] === '(') depth++;
    else if (gql[i] === ')') { depth--; if (depth === 0) break; }
    i++;
  }
  const end = i;

  i = openIdx + 1;
  while (i < end) {
    while (i < end && /[\s,]/.test(gql[i])) i++;
    if (gql[i] === '#') { while (i < end && gql[i] !== '\n') i++; continue; }
    if (i >= end) break;
    if (gql[i] !== '$') { i++; continue; }
    i++; // past `$`
    const nameMatch = gql.substring(i, end).match(/^([A-Za-z_]\w*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    i += nameMatch[0].length;
    while (i < end && /\s/.test(gql[i])) i++;
    if (gql[i] !== ':') continue;
    i++; // past `:`
    while (i < end && /\s/.test(gql[i])) i++;
    // Type ::= NamedType '!'? | '[' Type ']' '!'?
    let typeText = '';
    // Balance `[ ]` inside the type.
    let bracketDepth = 0;
    while (i < end) {
      const ch = gql[i];
      if (ch === '[') { bracketDepth++; typeText += ch; i++; continue; }
      if (ch === ']') { if (bracketDepth === 0) break; bracketDepth--; typeText += ch; i++; continue; }
      if (/[A-Za-z0-9_!]/.test(ch)) { typeText += ch; i++; continue; }
      if (bracketDepth === 0) break;
      // whitespace inside brackets — ignore.
      i++;
    }
    const trimmedType = typeText.trim();
    const list = /^\[/.test(trimmedType);
    const required = /!$/.test(trimmedType);
    // Strip outer brackets and trailing `!`s to get the inner type name.
    let inner = trimmedType.replace(/^!+$/, '');
    if (list) inner = inner.replace(/^\[+/, '').replace(/\]+!?$/, '');
    inner = inner.replace(/!+$/, '');
    // Default value: `= …`. Capture up to the next top-level `,` / `)` /
    // `$`, or the bracket end.
    let defaultValue: string | undefined;
    while (i < end && /\s/.test(gql[i])) i++;
    if (gql[i] === '=') {
      i++;
      while (i < end && /\s/.test(gql[i])) i++;
      const vStart = i;
      let vDepth = 0;
      let inString: string | null = null;
      while (i < end) {
        const ch = gql[i];
        if (inString) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === inString) inString = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") { inString = ch; i++; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { vDepth++; i++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
          if (vDepth === 0) break;
          vDepth--; i++; continue;
        }
        if (ch === ',' && vDepth === 0) break;
        if (ch === '$' && vDepth === 0) break;
        i++;
      }
      defaultValue = gql.substring(vStart, i).trim() || undefined;
    }
    out.push({ name, type: inner, required, list, defaultValue });
  }
  return out;
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
