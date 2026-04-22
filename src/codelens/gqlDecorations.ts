import * as vscode from 'vscode';
import { ClassInfo } from '../types';
import { parseGqlFields, GqlField, camelToSnake } from './gqlCodeLensProvider';
import { FieldIndex, RootOperationKind, findEntry, hasSchemaRootForOperation, readRootOperationKindFromGql, resolveChildClass } from './gqlResolver';

export interface DecorationInfo {
  offset: number;
  length: number;
  kind: 'exact' | 'inferred' | 'unresolved';
}

interface ComputeCtx {
  classMap: Map<string, ClassInfo>;
  fieldIndex: FieldIndex;
}

/**
 * Pure: walk every gql template in `text` and classify each field name as
 * exact / inferred / unresolved. Fields without a parent context (root-level
 * ambiguity that is neither clearly exact nor clearly wrong) get 'inferred';
 * fields on an unknown parent chain aren't decorated at all so we don't
 * paint misleading greens.
 */
export function computeDecorations(text: string, ctx: ComputeCtx): DecorationInfo[] {
  if (ctx.fieldIndex.size === 0) return [];
  const out: DecorationInfo[] = [];
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
  out: DecorationInfo[],
  rootKind: RootOperationKind,
): void {
  for (const gf of fields) {
    const snake = camelToSnake(gf.name);
    const entry = findEntry(ctx.fieldIndex, ctx.classMap, snake, parentCls, { rootKind });
    const offset = baseOffset + gf.nameOffset;
    const length = gf.nameLength;

    if (entry) {
      out.push({ offset, length, kind: entry.confidence });
    } else if (parentCls || hasSchemaRootForOperation(ctx.classMap, rootKind)) {
      // Known parent/root context, unknown field — clearly outside the query
      // structure. Paint the whole subtree so gql-only noise stays in the
      // source view instead of the backend structure view.
      markUnresolvedSubtree(gf, baseOffset, out);
      continue;
    }
    // else: no schema root context yet — don't paint while scan settles.

    if (gf.children.length === 0) continue;
    const childCls = entry ? resolveChildClass(entry.field, gf.name, ctx.classMap) : null;
    if (childCls) walk(gf.children, childCls, baseOffset, ctx, out, rootKind);
  }
}

function markUnresolvedSubtree(gf: GqlField, baseOffset: number, out: DecorationInfo[]): void {
  out.push({
    offset: baseOffset + gf.nameOffset,
    length: gf.nameLength,
    kind: 'unresolved',
  });
  for (const child of gf.children) markUnresolvedSubtree(child, baseOffset, out);
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
 * Vscode adapter. Creates three decoration types (exact/inferred/unresolved)
 * and paints the corresponding ranges onto the given editor. Overview ruler
 * marks make the distribution visible in the scrollbar at a glance.
 */
export class GqlDecorationManager {
  private readonly exact: vscode.TextEditorDecorationType;
  private readonly inferred: vscode.TextEditorDecorationType;
  private readonly unresolved: vscode.TextEditorDecorationType;
  private timer?: NodeJS.Timeout;

  constructor(private readState: () => ComputeCtx) {
    this.exact = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(76, 175, 80, 0.14)',
      borderRadius: '2px',
      overviewRulerColor: 'rgba(76, 175, 80, 0.7)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.inferred = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 179, 0, 0.18)',
      borderRadius: '2px',
      overviewRulerColor: 'rgba(255, 179, 0, 0.85)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.unresolved = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(55, 148, 255, 0.18)',
      textDecoration: 'underline dotted',
      borderRadius: '2px',
      overviewRulerColor: 'rgba(55, 148, 255, 0.85)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.exact.dispose();
    this.inferred.dispose();
    this.unresolved.dispose();
  }

  scheduleRefresh(editor: vscode.TextEditor): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(editor), 300);
  }

  refresh(editor: vscode.TextEditor): void {
    const infos = computeDecorations(editor.document.getText(), this.readState());
    const buckets: Record<DecorationInfo['kind'], vscode.Range[]> = {
      exact: [], inferred: [], unresolved: [],
    };
    for (const info of infos) {
      const range = new vscode.Range(
        editor.document.positionAt(info.offset),
        editor.document.positionAt(info.offset + info.length),
      );
      buckets[info.kind].push(range);
    }
    editor.setDecorations(this.exact, buckets.exact);
    editor.setDecorations(this.inferred, buckets.inferred);
    editor.setDecorations(this.unresolved, buckets.unresolved);
  }

  refreshNow(editor: vscode.TextEditor): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.refresh(editor);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.exact, []);
    editor.setDecorations(this.inferred, []);
    editor.setDecorations(this.unresolved, []);
  }
}
