import * as vscode from 'vscode';
import { ClassInfo } from '../types';
import { parseGqlFields, GqlField, camelToSnake } from './gqlCodeLensProvider';
import {
  FieldIndex,
  RootOperationKind,
  collectAncestors,
  collectRootFieldNames,
  findEntry,
  hasSchemaRootForOperation,
  readRootOperationKindFromGql,
  resolveChildClass,
} from './gqlResolver';

export interface DiagnosticInfo {
  /** Offset of the field name in document text. */
  offset: number;
  /** Length of the field name — squiggle spans exactly that. */
  length: number;
  message: string;
  /** Suggested alternative field names (snake_case). */
  suggestions: string[];
}

interface ComputeCtx {
  classMap: Map<string, ClassInfo>;
  fieldIndex: FieldIndex;
}

/**
 * Pure computation: scan every gql template in `text`, and for each field that
 * can't be resolved against a *known* parent, emit a DiagnosticInfo. Fields
 * that have no parent context (root level with nothing to match on) are NOT
 * flagged — that's a schema-wide ambiguity, not a user typo.
 */
export function computeDiagnostics(text: string, ctx: ComputeCtx): DiagnosticInfo[] {
  if (ctx.fieldIndex.size === 0) return [];
  const out: DiagnosticInfo[] = [];
  const gqlRegex = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;

  while ((m = gqlRegex.exec(text)) !== null) {
    const backtickIdx = text.indexOf('`', m.index);
    if (backtickIdx === -1) continue;
    const startOffset = backtickIdx + 1;
    const endOffset = findTemplateEnd(text, startOffset);
    if (endOffset === -1) continue;

    const rawBody = text.substring(startOffset, endOffset);
    const gqlBody = stripInterpolations(rawBody);
    const parsed = parseGqlFields(gqlBody);
    const rootKind = readRootOperationKindFromGql(gqlBody);

    walk(parsed, null, startOffset, ctx, out, rootKind);
  }
  return out;
}

function walk(
  fields: GqlField[],
  parentCls: ClassInfo | null,
  baseOffset: number,
  ctx: ComputeCtx,
  out: DiagnosticInfo[],
  rootKind: RootOperationKind,
): void {
  for (const gf of fields) {
    const snake = camelToSnake(gf.name);
    const entry = findEntry(ctx.fieldIndex, ctx.classMap, snake, parentCls, { rootKind });

    if (!entry && parentCls) {
      // Parent is known but the field doesn't exist on it — user typo or
      // schema drift. Surface it.
      const candidates = collectCandidateFieldNames(parentCls, ctx.classMap);
      const suggestions = suggest(snake, candidates, 3);
      const suggestText = suggestions.length > 0
        ? ` — did you mean ${suggestions.map((s) => `\`${s}\``).join(' or ')}?`
        : '';
      out.push({
        offset: baseOffset + gf.nameOffset,
        length: gf.nameLength,
        message: `No field '${snake}' on ${parentCls.name} (or its ancestors)${suggestText}`,
        suggestions,
      });
    } else if (!entry && hasSchemaRootForOperation(ctx.classMap, rootKind)) {
      const candidates = collectRootFieldNames(ctx.classMap, rootKind);
      const suggestions = suggest(snake, candidates, 3);
      const suggestText = suggestions.length > 0
        ? ` — did you mean ${suggestions.map((s) => `\`${s}\``).join(' or ')}?`
        : '';
      out.push({
        offset: baseOffset + gf.nameOffset,
        length: gf.nameLength,
        message: `No root ${rootKind} field '${snake}' in the schema${suggestText}`,
        suggestions,
      });
    }

    if (gf.children.length === 0) continue;
    const childCls = entry ? resolveChildClass(entry.field, gf.name, ctx.classMap) : null;
    if (childCls) walk(gf.children, childCls, baseOffset, ctx, out, rootKind);
  }
}

function collectCandidateFieldNames(cls: ClassInfo, classMap: Map<string, ClassInfo>): string[] {
  const names: string[] = cls.fields
    .filter((f) => !(f.name.startsWith('__') && f.name.endsWith('__')))
    .map((f) => f.name);
  for (const anc of collectAncestors(cls, classMap)) {
    const ancCls = classMap.get(anc);
    if (!ancCls) continue;
    for (const f of ancCls.fields) {
      if (f.name.startsWith('__') && f.name.endsWith('__')) continue;
      if (!names.includes(f.name)) names.push(f.name);
    }
  }
  return names;
}

/** Return up to `limit` nearest neighbours of `target` from `pool` by edit distance. */
function suggest(target: string, pool: string[], limit: number): string[] {
  if (target.length < 2) return [];
  const scored = pool
    .map((candidate) => ({ candidate, dist: levenshtein(target, candidate) }))
    // Allow up to half the target length in edits before we consider it unrelated.
    .filter((s) => s.dist <= Math.max(2, Math.floor(target.length / 2)))
    .sort((a, b) => a.dist - b.dist || a.candidate.length - b.candidate.length);
  return scored.slice(0, limit).map((s) => s.candidate);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
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

/**
 * Vscode adapter: listens to editor changes and writes diagnostics into a
 * shared collection. Severity defaults to Information to avoid false-positive
 * noise when the schema hasn't been scanned yet.
 */
export class GqlDiagnosticsManager {
  private collection: vscode.DiagnosticCollection;
  private timer?: NodeJS.Timeout;

  constructor(
    private readState: () => ComputeCtx,
    private readonly severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Information,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('django-graphql');
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.collection.dispose();
  }

  scheduleRefresh(document: vscode.TextDocument): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(document), 300);
  }

  refresh(document: vscode.TextDocument): void {
    const ctx = this.readState();
    const infos = computeDiagnostics(document.getText(), ctx);
    const diags = infos.map((info) => {
      const range = new vscode.Range(
        document.positionAt(info.offset),
        document.positionAt(info.offset + info.length),
      );
      const d = new vscode.Diagnostic(range, info.message, this.severity);
      d.source = 'django-graphql';
      return d;
    });
    this.collection.set(document.uri, diags);
  }

  clear(document: vscode.TextDocument): void {
    this.collection.delete(document.uri);
  }

  /** Test helper — exposes the effective collection without the setTimeout. */
  refreshNow(document: vscode.TextDocument): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.refresh(document);
  }
}
