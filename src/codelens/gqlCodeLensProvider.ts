import * as vscode from 'vscode';
import * as path from 'path';
import { ClassInfo, FieldInfo } from '../types';
import { log } from '../logger';
import {
  FieldIndex,
  IndexEntry,
  MatchedEntry,
  buildFieldIndex,
  findEntry as findEntryShared,
  readRootOperationKindFromGql,
  resolveChildClass,
  RootOperationKind,
} from './gqlResolver';

export function camelToSnake(str: string): string {
  // Two-pass conversion so consecutive capitals stay in one segment:
  //   HTTPStatus → http_status   (not h_t_t_p_status)
  //   parseHTTPResponse → parse_http_response
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Compute which fields of `backendCls` were NOT queried in `frontendChildren`.
 * Walks mixin base classes if the class itself has no direct fields.
 * Pure function — no dependency on provider state beyond the supplied classMap.
 */
export function computeMissingFields(
  frontendChildren: GqlField[],
  backendCls: ClassInfo,
  classMap: Map<string, ClassInfo>,
): FieldInfo[] {
  const available = getAllTypeFields(backendCls, classMap);
  const usedSnakeNames = new Set(frontendChildren.map((gf) => camelToSnake(gf.name)));
  return available.filter((f) => !usedSnakeNames.has(f.name));
}

function getAllTypeFields(cls: ClassInfo, classMap: Map<string, ClassInfo>): FieldInfo[] {
  if (cls.fields.length > 0) return cls.fields;
  const out: FieldInfo[] = [];
  const seen = new Set<string>();
  flattenBaseFields(cls, classMap, out, seen);
  return out;
}

// The `seen` set alone prevents cycles; no arbitrary depth cap needed.
function flattenBaseFields(
  cls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  out: FieldInfo[],
  seen: Set<string>,
): void {
  if (seen.has(cls.name)) return;
  seen.add(cls.name);
  for (const baseName of cls.baseClasses) {
    const base = classMap.get(baseName);
    if (!base) continue;
    if (base.fields.length > 0) {
      out.push(...base.fields);
    } else {
      flattenBaseFields(base, classMap, out, seen);
    }
  }
}

// IndexEntry / MatchedEntry / collectAncestors live in gqlResolver.ts and are
// re-exported from this module for back-compat with anyone importing them here.
export type { IndexEntry, MatchedEntry };

/** JSON-safe subset of a GqlField — used for passing through VSCode command args. */
export interface GqlFieldLite {
  name: string;
  children: GqlFieldLite[];
}

export function serializeGqlField(gf: GqlField): GqlFieldLite {
  return { name: gf.name, children: gf.children.map(serializeGqlField) };
}

/** Inverse of serializeGqlField for test-harnesses / webview handlers. */
export function hydrateGqlField(lite: GqlFieldLite): GqlField {
  return {
    name: lite.name,
    offset: 0, nameOffset: 0, nameLength: lite.name.length,
    children: lite.children.map(hydrateGqlField),
  };
}

export class GqlCodeLensProvider implements vscode.CodeLensProvider, vscode.HoverProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // snake_case field name → all classes that define it
  private fieldIndex: FieldIndex = new Map();
  private classMap = new Map<string, ClassInfo>();
  private updateTimer?: NodeJS.Timeout;

  updateIndex(classMap: Map<string, ClassInfo>): void {
    this.classMap = classMap;

    // Debounce index rebuild + CodeLens refresh
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.buildIndex();
      this._onDidChangeCodeLenses.fire();
    }, 200);
  }

  /**
   * Synchronous index rebuild. Used by tests (which can't wait on the debounce
   * timer) and by any future caller that needs the index up-to-date right now.
   */
  rebuildIndexNow(): void {
    if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = undefined; }
    this.buildIndex();
  }

  private buildIndex(): void {
    const __t = Date.now();
    this.fieldIndex = buildFieldIndex(this.classMap);
    const kindCounts = { query: 0, mutation: 0, type: 0, subscription: 0 };
    for (const [, cls] of this.classMap) {
      kindCounts[cls.kind] = (kindCounts[cls.kind] ?? 0) + 1;
    }
    log(`[codeLens] Index built: ${this.fieldIndex.size} fields from ${this.classMap.size} classes (Q:${kindCounts.query} M:${kindCounts.mutation} T:${kindCounts.type} S:${kindCounts.subscription}) [${Date.now() - __t}ms]`);
  }

  /**
   * Exposed so other providers (InlayHints, Diagnostics) can share the same
   * resolved view of the schema without rebuilding indexes.
   */
  getSharedState(): { classMap: Map<string, ClassInfo>; fieldIndex: FieldIndex } {
    return { classMap: this.classMap, fieldIndex: this.fieldIndex };
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (this.fieldIndex.size === 0) return [];

    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];
    const fileName = path.basename(document.fileName);

    // Collect every fragment defined anywhere in this document up front so
    // spreads in one gql literal can resolve fragments defined in another
    // (the `const F = gql\`fragment …\`; const Q = gql\`... ${F}\`` pattern).
    const docFragments = collectDocumentFragments(text);

    // Detect gql template literals in multiple patterns:
    // gql`...`, graphql`...`, /* GraphQL */ `...`, gql(`...`), graphql(`...`)
    const gqlRegex = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
    let gqlMatch;

    while ((gqlMatch = gqlRegex.exec(text)) !== null) {
      // Find the backtick start
      const backtickIdx = text.indexOf('`', gqlMatch.index);
      if (backtickIdx === -1) continue;
      const startOffset = backtickIdx + 1;
      const templateEnd = findTemplateEnd(text, startOffset);
      if (templateEnd === -1) continue;

      const rawBody = text.substring(startOffset, templateEnd);
      const gqlBody = stripTemplateExpressions(rawBody);
      const parsed = parseGqlFields(gqlBody, docFragments);

      // Log the operation type and parsed root fields
      const opType = gqlBody.match(/^\s*(query|mutation|subscription)/)?.[1] ?? 'unknown';
      const rootKind = readRootOperationKindFromGql(gqlBody);
      const rootNames = parsed.map((f) => f.name);
      log(`[codeLens] ${fileName}: ${opType} — root fields: [${rootNames.join(', ')}] (${parsed.length} fields from ${gqlBody.length} chars)`);

      if (parsed.length === 0) {
        const preview = gqlBody.substring(0, 100).replace(/\n/g, '\\n');
        log(`[codeLens]   ⚠ No fields parsed. Body preview: ${preview}`);
      }

      const logFields = (fields: GqlField[], depth: number, parent: ClassInfo | null): void => {
        for (const gf of fields) {
          const indent = '  '.repeat(depth + 1);
          const snakeName = camelToSnake(gf.name);
          const entry = this.findEntry(snakeName, parent, rootKind);
          if (entry) {
            const conf = entry.confidence === 'inferred' ? ' [inferred]' : '';
            log(`[codeLens] ${indent}✓ ${gf.name} → ${snakeName} → ${entry.cls.name}.${entry.field.name} (${entry.cls.kind})${conf}`);
            if (gf.children.length > 0) {
              const resolvedTypeName = entry.field.resolvedType;
              const resolved = resolveChildClass(entry.field, gf.name, this.classMap);
              if (resolved) {
                logFields(gf.children, depth + 1, resolved);
              } else {
                // Don't fall back to the containing class — that would misleadingly
                // blame the Query/Mutation container for children that actually
                // live on the return type. Report exactly why resolution stopped.
                const reason = resolvedTypeName
                  ? `resolvedType='${resolvedTypeName}' not in class index`
                  : `field '${entry.cls.name}.${entry.field.name}' has no resolvedType recorded`;
                log(`[codeLens] ${indent}  ⊘ children skipped — ${reason}`);
              }
            }
          } else {
            const parentLabel = parent ? parent.name : 'root';
            log(`[codeLens] ${indent}✗ ${gf.name} → ${snakeName} — no such field on ${parentLabel}`);
          }
        }
      };
      logFields(parsed, 0, null);

      this.resolveFields(parsed, null, startOffset, document, lenses, rootKind);
    }

    return lenses;
  }

  private resolveFields(
    fields: GqlField[],
    parentType: ClassInfo | null,
    baseOffset: number,
    document: vscode.TextDocument,
    lenses: vscode.CodeLens[],
    rootKind: RootOperationKind,
  ): void {
    for (const gf of fields) {
      const snakeName = camelToSnake(gf.name);
      const entry = this.findEntry(snakeName, parentType, rootKind);
      if (!entry) continue;

      const linePos = document.positionAt(baseOffset + gf.offset);
      const range = new vscode.Range(linePos, linePos);

      const kindLabel = entry.cls.kind === 'type'
        ? 'Type'
        : entry.cls.kind === 'mutation'
          ? 'Mutation'
          : entry.cls.kind === 'subscription'
            ? 'Subscription'
            : 'Query';
      const marker = entry.confidence === 'inferred' ? '~' : '';
      const tooltipSuffix = entry.confidence === 'inferred'
        ? '\n\n(~ means inferred — multiple candidates existed; verify that this is the intended class.)'
        : '';

      lenses.push(new vscode.CodeLens(range, {
        title: `→ ${marker}${entry.cls.name}.${entry.field.name} [${kindLabel}]`,
        tooltip: `${gf.name} → ${entry.field.name} in ${entry.cls.name}\n${entry.cls.filePath}:${entry.cls.lineNumber + 1}${tooltipSuffix}`,
        command: 'djangoGraphqlExplorer.openClass',
        arguments: [entry.cls.filePath, entry.cls.lineNumber],
      }));

      // Recurse into children with the resolved type as parent context.
      // If we don't know the child type, DO NOT fall back to the current
      // class — that would falsely attribute descendants to the parent.
      if (gf.children.length > 0) {
        const resolvedCls = resolveChildClass(entry.field, gf.name, this.classMap);

        if (resolvedCls) {
          this.resolveFields(gf.children, resolvedCls, baseOffset, document, lenses, rootKind);

          // Show missing fields from the resolved type
          const missing = this.getMissingFields(gf.children, resolvedCls);
          if (missing.length > 0) {
            const used = gf.children.length;
            const total = used + missing.length;
            const preview = missing.slice(0, 5).map((f) => snakeToCamel(f.name)).join(', ');
            const more = missing.length > 5 ? `, +${missing.length - 5}` : '';
            // Pass enough info for the full-tree webview: target class + the
            // user's gql subtree under this field. Also pass owner
            // class+field names so the panel can look up the backend
            // FieldInfo and render its args on the root row.
            lenses.push(new vscode.CodeLens(range, {
              title: `⚠ ${used}/${total} fields — click to see full structure`,
              tooltip: `Expand ${resolvedCls.name}: ${preview}${more}`,
              command: 'djangoGraphqlExplorer.showMissingFields',
              arguments: [resolvedCls.name, serializeGqlField(gf), entry.cls.name, entry.field.name],
            }));
          }
        }
      }
    }
  }

  private getMissingFields(frontendFields: GqlField[], backendCls: ClassInfo): FieldInfo[] {
    return computeMissingFields(frontendFields, backendCls, this.classMap);
  }

  private findEntry(
    snakeFieldName: string,
    parentType: ClassInfo | null,
    rootKind: RootOperationKind = 'query',
  ): MatchedEntry | undefined {
    return findEntryShared(this.fieldIndex, this.classMap, snakeFieldName, parentType, { rootKind });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (this.fieldIndex.size === 0) return undefined;

    const text = document.getText();
    const offset = document.offsetAt(position);
    const docFragments = collectDocumentFragments(text);
    const gqlRegex = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
    let gqlMatch;

    while ((gqlMatch = gqlRegex.exec(text)) !== null) {
      const backtickIdx = text.indexOf('`', gqlMatch.index);
      if (backtickIdx === -1) continue;
      const startOffset = backtickIdx + 1;
      const templateEnd = findTemplateEnd(text, startOffset);
      if (templateEnd === -1) continue;
      if (offset < startOffset || offset > templateEnd) continue;

      const rawBody = text.substring(startOffset, templateEnd);
      const gqlBody = stripTemplateExpressions(rawBody);
      const parsed = parseGqlFields(gqlBody, docFragments);
      const rootKind = readRootOperationKindFromGql(gqlBody);
      const hover = this.findHoverInFields(parsed, null, startOffset, offset, document, rootKind);
      if (hover) return hover;
    }

    return undefined;
  }

  private findHoverInFields(
    fields: GqlField[],
    parentType: ClassInfo | null,
    baseOffset: number,
    cursorOffset: number,
    document: vscode.TextDocument,
    rootKind: RootOperationKind,
  ): vscode.Hover | undefined {
    for (const gf of fields) {
      const snakeName = camelToSnake(gf.name);
      const entry = this.findEntry(snakeName, parentType, rootKind);

      // Check children first (more specific match). Mirror the CodeLens rule:
      // don't fall back to the parent class when we cannot resolve the child type.
      if (gf.children.length > 0 && entry) {
        const resolvedCls = resolveChildClass(entry.field, gf.name, this.classMap);
        if (resolvedCls) {
          const childHover = this.findHoverInFields(gf.children, resolvedCls, baseOffset, cursorOffset, document, rootKind);
          if (childHover) return childHover;
        }
      }

      // Check both the display name (alias) and the actual field name positions
      const displayStart = baseOffset + gf.offset;
      const nameStart = baseOffset + gf.nameOffset;
      const nameEnd = nameStart + gf.nameLength;

      // Cursor must be on the alias or the field name
      const onDisplay = cursorOffset >= displayStart && cursorOffset <= displayStart + gf.nameLength;
      const onName = cursorOffset >= nameStart && cursorOffset <= nameEnd;
      if (!onDisplay && !onName) continue;
      if (!entry) continue;
      const fieldStart = nameStart;
      const fieldEnd = nameEnd;

      const { cls, field } = entry;
      const lines: string[] = [
        `**${gf.name}** → \`${cls.name}.${field.name}\` (${cls.kind})`,
        '',
        '| | |',
        '|---|---|',
        `| **Frontend field** | \`${gf.name}\` |`,
        `| **Backend field** | \`${field.name}: ${field.fieldType}\` |`,
        `| **Resolved type** | \`${field.resolvedType ?? '—'}\` |`,
        `| **Class** | \`${cls.name}\` (${cls.kind}) |`,
        `| **File** | \`${cls.filePath}:${cls.lineNumber + 1}\` |`,
      ];

      if (field.args && field.args.length > 0) {
        lines.push('', '**Arguments:**');
        for (const a of field.args) {
          lines.push(`- \`${a.name}: ${a.type}${a.required ? '!' : ''}\``);
        }
      }

      // Show missing sub-fields if this field has a selection set
      if (gf.children.length > 0 && field.resolvedType) {
        const resolvedCls = this.classMap.get(field.resolvedType);
        if (resolvedCls) {
          const missing = this.getMissingFields(gf.children, resolvedCls);
          const used = gf.children.length;
          const total = used + missing.length;
          if (missing.length > 0) {
            lines.push('', `**Missing fields** (${used}/${total} queried from \`${resolvedCls.name}\`):`);
            for (const f of missing.slice(0, 8)) {
              lines.push(`- \`${snakeToCamel(f.name)}\`: ${f.fieldType}${f.resolvedType ? ` → ${f.resolvedType}` : ''}`);
            }
            if (missing.length > 8) {
              const cmdArgs = encodeURIComponent(JSON.stringify([
                resolvedCls.name,
                gf.children.map((c) => c.name),
                missing.map((f) => ({ name: snakeToCamel(f.name), type: `${f.fieldType}${f.resolvedType ? ' → ' + f.resolvedType : ''}` })),
              ]));
              lines.push(``, `[Show all ${missing.length} missing fields](command:djangoGraphqlExplorer.showMissingFields?${cmdArgs})`);
            }
          } else {
            lines.push('', `**All ${total} fields queried** from \`${resolvedCls.name}\``);
          }
        }
      } else if (cls.fields.length > 1) {
        const others = cls.fields.filter((f) => f.name !== field.name);
        lines.push('', `**Other fields in ${cls.name}:**`);
        for (const f of others.slice(0, 8)) {
          lines.push(`- \`${snakeToCamel(f.name)}\`: ${f.fieldType}${f.resolvedType ? ` → ${f.resolvedType}` : ''}`);
        }
        if (others.length > 8) {
          const cmdArgs = encodeURIComponent(JSON.stringify([
            cls.name,
            [field.name],
            others.map((f) => ({ name: snakeToCamel(f.name), type: `${f.fieldType}${f.resolvedType ? ' → ' + f.resolvedType : ''}` })),
          ]));
          lines.push(``, `[Show all ${others.length} fields](command:djangoGraphqlExplorer.showMissingFields?${cmdArgs})`);
        }
      }

      const md = new vscode.MarkdownString(lines.join('\n'));
      md.isTrusted = true;
      const range = new vscode.Range(document.positionAt(fieldStart), document.positionAt(fieldEnd));
      return new vscode.Hover(md, range);
    }
    return undefined;
  }
}

// ── GQL Parsing ──

export interface GqlField {
  name: string;
  offset: number;       // offset of the display name (alias or field name) in gql body
  nameOffset: number;   // offset of the actual field name in gql body (after alias ':')
  nameLength: number;   // length of the actual field name in source
  children: GqlField[];
  /**
   * Names of the arguments the user actually wrote between `(` and `)` for
   * this field (e.g. `["companyId", "page"]` for `rtccEmailList(companyId:
   * $companyId, page: $page)`). Lets downstream rendering show ONLY the
   * args that appear in the query — not every arg declared on the backend.
   * Undefined when there was no parenthesised arg list at all.
   */
  argNames?: string[];
}

function stripTemplateExpressions(body: string): string {
  // Replace ${...} with spaces to preserve character offsets
  let result = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 1;
      result += '  '; // replace ${ with spaces
      i += 2;
      while (i < body.length && depth > 0) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') depth--;
        result += ' ';
        i++;
      }
      continue;
    }
    result += body[i];
    i++;
  }
  return result;
}

function findTemplateEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') return i;
    if (text[i] === '\\') i++;
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
 * Fragment definition. `source` carries the gql text that `bodyStart` is an
 * offset into — for local fragments it's the same gql literal being parsed,
 * for cross-literal fragments (collected via `collectDocumentFragments`) it's
 * a different literal's body text.
 * `fields` is lazily populated the first time the fragment is inlined so
 * cyclic references trip the `resolving` guard without infinite recursion.
 */
export interface FragmentDef {
  source: string;
  bodyStart: number;
  fields: GqlField[] | null;
  resolving: boolean;
}

/**
 * Find every `fragment Name on Type { ... }` block in a gql body. Used by the
 * per-literal parser and by `collectDocumentFragments` (via a different
 * `source` string).
 */
function collectFragmentDefsFromSource(gqlSource: string): Map<string, FragmentDef> {
  const out = new Map<string, FragmentDef>();
  const re = /\bfragment\s+([A-Za-z_]\w*)\s+on\s+[A-Za-z_]\w*\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(gqlSource)) !== null) {
    const name = m[1];
    const braceIdx = m.index + m[0].length - 1;
    out.set(name, { source: gqlSource, bodyStart: braceIdx + 1, fields: null, resolving: false });
  }
  return out;
}

/**
 * Scan an entire source file (TypeScript / JavaScript / JSX / TSX) for every
 * gql / graphql template literal and harvest fragment definitions from each.
 * Returns a name → FragmentDef map that `parseGqlFields` can consult when a
 * `...FragmentName` spread can't be resolved inside the current literal.
 *
 * This covers the common pattern:
 *
 *     const USER_FRAGMENT = gql`fragment UserFields on User { id name }`;
 *     const QUERY = gql`query { users { ...UserFields } } ${USER_FRAGMENT}`;
 *
 * where `UserFields` is defined in one gql literal and used in another.
 * Cross-file fragments (imported from another module) are NOT resolved here.
 */
export function collectDocumentFragments(docText: string): Map<string, FragmentDef> {
  const merged = new Map<string, FragmentDef>();
  const re = /(?:gql|graphql)\s*(?:`|(\()[\s\S]*?`)|\/\*\s*GraphQL\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docText)) !== null) {
    const backtickIdx = docText.indexOf('`', m.index);
    if (backtickIdx === -1) continue;
    const start = backtickIdx + 1;
    const end = findTemplateEnd(docText, start);
    if (end === -1) continue;
    const rawBody = docText.substring(start, end);
    const gqlBody = stripTemplateExpressions(rawBody);
    const local = collectFragmentDefsFromSource(gqlBody);
    // First definition wins — later redefinitions are ignored (same as real gql).
    for (const [name, def] of local) {
      if (!merged.has(name)) merged.set(name, def);
    }
  }
  return merged;
}

export function parseGqlFields(gql: string, externalFragments?: Map<string, FragmentDef>): GqlField[] {
  // Fragment defs in the same gql literal are inlined at spread sites.
  const local = collectFragmentDefsFromSource(gql);
  // Local fragments win over external ones (same name = same-literal wins).
  const fragments = new Map<string, FragmentDef>();
  if (externalFragments) {
    for (const [name, def] of externalFragments) fragments.set(name, def);
  }
  for (const [name, def] of local) fragments.set(name, def);

  // Find operation body — match opening brace after operation declaration.
  // Fragment definitions may appear before the operation in the same literal,
  // so scan anywhere in the gql string instead of only the leading token.
  let bodyStart: number | undefined;

  const keywordMatch = /(^|[^A-Za-z_0-9])(query|mutation|subscription)\b/.exec(gql);
  if (keywordMatch) {
    let i = keywordMatch.index + keywordMatch[0].length;
    // Skip operation name
    const nameMatch = gql.substring(i).match(/^\s*(\w+)/);
    if (nameMatch) i += nameMatch[0].length;
    // Skip whitespace
    while (i < gql.length && /\s/.test(gql[i])) i++;
    // Skip variable declarations (...) — handle nested parens
    if (gql[i] === '(') {
      i = skipBracket(gql, i, '(', ')');
    }
    // Skip whitespace
    while (i < gql.length && /\s/.test(gql[i])) i++;
    // Expect {
    if (gql[i] === '{') {
      bodyStart = i + 1;
    }
  }

  if (bodyStart === undefined) {
    // Fragment-only body: nothing to report at the operation level.
    if (/^\s*fragment\b/s.test(gql)) {
      return [];
    }
    const braceIdx = gql.indexOf('{');
    if (braceIdx === -1) {
      log(`[codeLens] parseGqlFields: no opening brace found`);
      return [];
    }
    bodyStart = braceIdx + 1;
  }

  const result: GqlField[] = [];
  parseFieldsBlock(gql, bodyStart, result, fragments);
  return result;
}

function parseFieldsBlock(
  gql: string,
  start: number,
  out: GqlField[],
  fragments?: Map<string, FragmentDef>,
): number {
  let i = start;

  while (i < gql.length) {
    const ch = gql[i];

    // End of this block
    if (ch === '}') return i + 1;

    // Skip parens
    if (ch === '(') { i = skipBracket(gql, i, '(', ')'); continue; }

    // Skip comments
    if (ch === '#') { while (i < gql.length && gql[i] !== '\n') i++; continue; }

    // Spreads: inline (`... on Type { ... }`) or named (`...FragmentName`).
    // Both flatten their fields into the current selection so coverage,
    // CodeLens and the structure inspector see them as regular children.
    if (ch === '.' && gql[i + 1] === '.' && gql[i + 2] === '.') {
      i += 3;
      while (i < gql.length && /\s/.test(gql[i])) i++;

      // Inline fragment: `... on Type [@dir…] { selection }`. Merge its
      // fields into the current selection set so downstream consumers treat
      // them as regular children.
      if (
        gql[i] === 'o' && gql[i + 1] === 'n' &&
        i + 2 < gql.length && /\s/.test(gql[i + 2])
      ) {
        i += 2;
        while (i < gql.length && /\s/.test(gql[i])) i++;
        while (i < gql.length && /\w/.test(gql[i])) i++; // type name
        while (i < gql.length && /\s/.test(gql[i])) i++;
        while (gql[i] === '@') {
          i++;
          while (i < gql.length && /\w/.test(gql[i])) i++;
          while (i < gql.length && /\s/.test(gql[i])) i++;
          if (gql[i] === '(') { i = skipBracket(gql, i, '(', ')'); }
          while (i < gql.length && /\s/.test(gql[i])) i++;
        }
        if (gql[i] === '{') {
          i++;
          i = parseFieldsBlock(gql, i, out, fragments);
        }
        continue;
      }

      // Named fragment spread — inline the fragment's fields by looking up
      // its definition in the same gql literal. Unknown fragments are
      // silently dropped (same-literal scope by design).
      const nameMatch = gql.substring(i).match(/^([A-Za-z_]\w*)/);
      if (nameMatch) {
        const fragName = nameMatch[1];
        i += nameMatch[0].length;
        // Skip directives on the spread: `...F @include(if: $x)`
        while (i < gql.length && /\s/.test(gql[i])) i++;
        while (gql[i] === '@') {
          i++;
          while (i < gql.length && /\w/.test(gql[i])) i++;
          while (i < gql.length && /\s/.test(gql[i])) i++;
          if (gql[i] === '(') { i = skipBracket(gql, i, '(', ')'); }
          while (i < gql.length && /\s/.test(gql[i])) i++;
        }
        if (fragments) {
          const def = fragments.get(fragName);
          if (def && !def.resolving) {
            if (def.fields === null) {
              def.resolving = true;
              const resolved: GqlField[] = [];
              // A fragment's body lives in the gql literal where it was
              // defined — for cross-literal fragments that's a different
              // source string than the one we're currently parsing.
              parseFieldsBlock(def.source, def.bodyStart, resolved, fragments);
              def.fields = resolved;
              def.resolving = false;
            }
            for (const f of def.fields) out.push(f);
          }
        }
      }
      continue;
    }

    // Field name
    if (/[a-zA-Z_]/.test(ch)) {
      const nameMatch = gql.substring(i).match(/^([a-zA-Z_]\w*)/);
      if (!nameMatch) { i++; continue; }

      let fieldName = nameMatch[1];
      const fieldOffset = i;
      let nameOffset = i;
      let nameLength = nameMatch[0].length;
      i += nameMatch[0].length;

      // Skip whitespace
      while (i < gql.length && /\s/.test(gql[i])) i++;

      // Handle alias: if followed by ':', the real field name comes after
      if (gql[i] === ':') {
        i++; // skip ':'
        while (i < gql.length && /\s/.test(gql[i])) i++;
        const realMatch = gql.substring(i).match(/^([a-zA-Z_]\w*)/);
        if (realMatch) {
          fieldName = realMatch[1];
          nameOffset = i;
          nameLength = realMatch[0].length;
          i += realMatch[0].length;
          while (i < gql.length && /\s/.test(gql[i])) i++;
        }
      }

      // Parse argument list `(name: value, …)` — we need the arg NAMES so
      // downstream rendering can show only the args the user actually wrote.
      // Values are just skipped (can be $var, literals, nested objects/lists).
      let fieldArgNames: string[] | undefined;
      if (gql[i] === '(') {
        const argsEnd = skipBracket(gql, i, '(', ')');
        fieldArgNames = collectArgNames(gql, i + 1, argsEnd - 1);
        i = argsEnd;
        while (i < gql.length && /\s/.test(gql[i])) i++;
      }

      // Skip directives @skip, @include etc. — their args don't count toward
      // the field's own arg list.
      while (gql[i] === '@') {
        while (i < gql.length && /\w/.test(gql[i]) || gql[i] === '@') i++;
        while (i < gql.length && /\s/.test(gql[i])) i++;
        if (gql[i] === '(') {
          i = skipBracket(gql, i, '(', ')');
          while (i < gql.length && /\s/.test(gql[i])) i++;
        }
      }

      const field: GqlField = { name: fieldName, offset: fieldOffset, nameOffset, nameLength, children: [], argNames: fieldArgNames };

      // If followed by { }, parse children
      if (gql[i] === '{') {
        i++; // skip '{'
        i = parseFieldsBlock(gql, i, field.children, fragments);
      }

      out.push(field);
      continue;
    }

    i++;
  }

  return i;
}

/**
 * Pull the names from a gql field's `(…)` argument list. `start` is the
 * first character AFTER the opening paren; `end` is the index OF the closing
 * paren. Each arg is `name: value` — we collect `name` identifiers and skip
 * over values (including nested `()` / `[]` / `{}`). GraphQL allows
 * comma-less lists, so the value-skip loop also terminates at the start of
 * the next top-level `Name:` pair. Unknown / malformed chunks are silently
 * tolerated to avoid breaking the rest of the parse.
 */
function collectArgNames(gql: string, start: number, end: number): string[] {
  const names: string[] = [];
  let i = start;
  while (i < end) {
    // Skip whitespace, commas, comments.
    while (i < end && /[\s,]/.test(gql[i])) i++;
    if (gql[i] === '#') {
      while (i < end && gql[i] !== '\n') i++;
      continue;
    }
    if (i >= end) break;
    // Grab arg name.
    const nameMatch = gql.substring(i, end).match(/^([A-Za-z_]\w*)/);
    if (!nameMatch) { i++; continue; }
    const name = nameMatch[1];
    i += nameMatch[0].length;
    while (i < end && /\s/.test(gql[i])) i++;
    if (gql[i] !== ':') {
      // Malformed — bail on this pair but keep scanning the list.
      continue;
    }
    i++; // past ':'
    // Skip value — walk until the next top-level comma, the end of the
    // list, OR the start of the next comma-less `Name:` pair. We balance
    // brackets/strings so nested values (`{x: 1, y: 2}`) don't trigger a
    // premature exit.
    let depth = 0;
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
      if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--; i++; continue;
      }
      if (ch === ',' && depth === 0) break;
      // Comma-less lists: GraphQL allows `name1: v1\n  name2: v2` without a
      // separator. When we hit an identifier-then-colon at depth 0, bail
      // out so the outer loop can collect the next arg name. Enum / bool
      // literals are bare identifiers NOT followed by `:`, so they won't
      // accidentally trigger this.
      if (depth === 0 && /[A-Za-z_]/.test(ch)) {
        const rest = gql.substring(i, end);
        if (/^([A-Za-z_]\w*)\s*:/.test(rest)) break;
      }
      i++;
    }
    names.push(name);
  }
  return names;
}

function skipBracket(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}
