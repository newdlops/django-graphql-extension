import * as vscode from 'vscode';
import { ClassInfo } from '../types';
import { parseGqlFields, GqlField, camelToSnake } from './gqlCodeLensProvider';
import { FieldIndex, RootOperationKind, findEntry, hasSchemaRootForOperation, MatchedEntry, readRootOperationKindFromGql, resolveChildClass } from './gqlResolver';

/** Serializable inlay-hint description — pure output of computeInlayHints. */
export interface InlayHintInfo {
  /** Absolute offset in the document text where the chip should render. */
  offset: number;
  /** Chip text (usually `→ TypeName`). */
  label: string;
  /** Full `Class.field` reference, used for the tooltip. */
  tooltip: string;
  /** Whether the match was an exact/inferred/unknown result. */
  confidence: 'exact' | 'inferred' | 'unresolved';
  /** For exact/inferred matches pointing at a known type, where to jump on click. */
  target?: { filePath: string; line: number };
}

interface ComputeCtx {
  classMap: Map<string, ClassInfo>;
  fieldIndex: FieldIndex;
}

/**
 * Pure computation: for each gql template in `text`, emit an InlayHintInfo for
 * every field that resolves. Inherits the same strict resolution as CodeLens.
 */
export function computeInlayHints(text: string, ctx: ComputeCtx): InlayHintInfo[] {
  if (ctx.fieldIndex.size === 0) return [];
  const hints: InlayHintInfo[] = [];
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

    walkHints(parsed, null, startOffset, ctx, hints, rootKind);
  }
  return hints;
}

function walkHints(
  fields: GqlField[],
  parentCls: ClassInfo | null,
  baseOffset: number,
  ctx: ComputeCtx,
  out: InlayHintInfo[],
  rootKind: RootOperationKind,
): void {
  for (const gf of fields) {
    const snake = camelToSnake(gf.name);
    const entry = findEntry(ctx.fieldIndex, ctx.classMap, snake, parentCls, { rootKind });

    const hintOffset = baseOffset + gf.nameOffset + gf.nameLength;
    if (entry) {
      const resolvedName = entry.field.resolvedType ?? entry.field.fieldType;
      const marker = entry.confidence === 'inferred' ? '~' : '';
      out.push({
        offset: hintOffset,
        label: ` → ${marker}${resolvedName}`,
        tooltip: `${entry.cls.name}.${entry.field.name}${entry.confidence === 'inferred' ? ' (inferred)' : ''}`,
        confidence: entry.confidence,
        target: resolveTarget(entry, ctx.classMap),
      });
    } else if (parentCls || hasSchemaRootForOperation(ctx.classMap, rootKind)) {
      // Parent/root was known but field didn't belong to it — visible ? so users know.
      out.push({
        offset: hintOffset,
        label: ' → ?',
        tooltip: parentCls
          ? `No field named '${snake}' on ${parentCls.name} (or its ancestors)`
          : `No root ${rootKind} field named '${snake}' in the schema`,
        confidence: 'unresolved',
      });
    }

    if (gf.children.length === 0) continue;
    const childCls = entry ? resolveChildClass(entry.field, gf.name, ctx.classMap) : null;
    if (childCls) walkHints(gf.children, childCls, baseOffset, ctx, out, rootKind);
  }
}

function resolveTarget(entry: MatchedEntry, classMap: Map<string, ClassInfo>) {
  // Prefer the resolved-type class's location when the chip says "→ StockType";
  // if it's a scalar, fall back to the owning class of the field.
  const resolvedType = entry.field.resolvedType;
  if (resolvedType) {
    const target = classMap.get(resolvedType);
    if (target) return { filePath: target.filePath, line: target.lineNumber };
  }
  return { filePath: entry.cls.filePath, line: entry.cls.lineNumber };
}

function stripInterpolations(body: string): string {
  // Replace ${...} with same-length whitespace so offsets survive.
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
 * Thin vscode adapter: takes the pure computeInlayHints result and wraps it
 * with vscode.InlayHint objects. Registered on TS/JSX language IDs.
 */
export class GqlInlayHintsProvider implements vscode.InlayHintsProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this._onDidChange.event;

  constructor(private readState: () => ComputeCtx) {}

  refresh(): void { this._onDidChange.fire(); }

  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    // Respect the user toggle — when false the graph-based Live Inspector is the
    // preferred visualization so we stay out of the way.
    const enabled = vscode.workspace
      .getConfiguration('djangoGraphqlExplorer')
      .get<boolean>('inlayHints', false);
    if (!enabled) return [];

    const ctx = this.readState();
    if (ctx.fieldIndex.size === 0) return [];
    const infos = computeInlayHints(document.getText(), ctx);
    const rangeStart = document.offsetAt(range.start);
    const rangeEnd = document.offsetAt(range.end);

    const out: vscode.InlayHint[] = [];
    for (const info of infos) {
      if (info.offset < rangeStart || info.offset > rangeEnd) continue;
      const pos = document.positionAt(info.offset);
      const hint = new vscode.InlayHint(pos, info.label, vscode.InlayHintKind.Type);
      hint.paddingLeft = true;
      hint.tooltip = info.tooltip;
      if (info.target) {
        const labelPart = new vscode.InlayHintLabelPart(info.label);
        labelPart.tooltip = info.tooltip;
        labelPart.location = new vscode.Location(
          vscode.Uri.file(info.target.filePath),
          new vscode.Position(info.target.line, 0),
        );
        hint.label = [labelPart];
      }
      out.push(hint);
    }
    return out;
  }
}
