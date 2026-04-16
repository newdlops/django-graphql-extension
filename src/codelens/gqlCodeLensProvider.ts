import * as vscode from 'vscode';
import * as path from 'path';
import { ClassInfo, FieldInfo } from '../types';
import { log } from '../logger';

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

interface IndexEntry {
  cls: ClassInfo;
  field: FieldInfo;
}

export class GqlCodeLensProvider implements vscode.CodeLensProvider, vscode.HoverProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // snake_case field name → all classes that define it
  private fieldIndex = new Map<string, IndexEntry[]>();
  private classMap = new Map<string, ClassInfo>();
  private updateTimer?: NodeJS.Timeout;

  updateIndex(classMap: Map<string, ClassInfo>): void {
    this.classMap = classMap;

    // Debounce index rebuild + CodeLens refresh
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.fieldIndex.clear();
      const kindCounts = { query: 0, mutation: 0, type: 0, subscription: 0 };
      for (const [, cls] of this.classMap) {
        kindCounts[cls.kind] = (kindCounts[cls.kind] ?? 0) + 1;
        for (const field of cls.fields) {
          const entries = this.fieldIndex.get(field.name);
          if (entries) {
            entries.push({ cls, field });
          } else {
            this.fieldIndex.set(field.name, [{ cls, field }]);
          }
        }
      }
      log(`[codeLens] Index built: ${this.fieldIndex.size} fields from ${this.classMap.size} classes (Q:${kindCounts.query} M:${kindCounts.mutation} T:${kindCounts.type} S:${kindCounts.subscription})`);
      this._onDidChangeCodeLenses.fire();
    }, 200);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (this.fieldIndex.size === 0) return [];

    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];
    const fileName = path.basename(document.fileName);

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
      const parsed = parseGqlFields(gqlBody);

      // Log the operation type and parsed root fields
      const opType = gqlBody.match(/^\s*(query|mutation|subscription)/)?.[1] ?? 'unknown';
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
          const entry = this.findEntry(snakeName, parent);
          if (entry) {
            log(`[codeLens] ${indent}✓ ${gf.name} → ${snakeName} → ${entry.cls.name}.${entry.field.name} (${entry.cls.kind})`);
            if (gf.children.length > 0) {
              let resolved = entry.field.resolvedType ? this.classMap.get(entry.field.resolvedType) : undefined;
              if (!resolved) resolved = this.inferTypeFromFieldName(gf.name) ?? undefined;
              logFields(gf.children, depth + 1, resolved ?? entry.cls);
            }
          } else {
            log(`[codeLens] ${indent}✗ ${gf.name} → ${snakeName} — no match (parent: ${parent?.name ?? 'root'})`);
          }
        }
      };
      logFields(parsed, 0, null);

      this.resolveFields(parsed, null, startOffset, document, lenses);
    }

    return lenses;
  }

  private resolveFields(
    fields: GqlField[],
    parentType: ClassInfo | null,
    baseOffset: number,
    document: vscode.TextDocument,
    lenses: vscode.CodeLens[],
  ): void {
    for (const gf of fields) {
      const snakeName = camelToSnake(gf.name);
      const entry = this.findEntry(snakeName, parentType);
      if (!entry) continue;

      const linePos = document.positionAt(baseOffset + gf.offset);
      const range = new vscode.Range(linePos, linePos);

      const kindLabel = entry.cls.kind === 'type' ? 'Type' : entry.cls.kind === 'mutation' ? 'Mutation' : 'Query';

      lenses.push(new vscode.CodeLens(range, {
        title: `→ ${entry.cls.name}.${entry.field.name} [${kindLabel}]`,
        tooltip: `${gf.name} → ${entry.field.name} in ${entry.cls.name}\n${entry.cls.filePath}:${entry.cls.lineNumber + 1}`,
        command: 'djangoGraphqlExplorer.openClass',
        arguments: [entry.cls.filePath, entry.cls.lineNumber],
      }));

      // Recurse into children with the resolved type as parent context
      if (gf.children.length > 0) {
        let resolvedCls = entry.field.resolvedType
          ? (this.classMap.get(entry.field.resolvedType) ?? null)
          : null;
        // If no resolvedType, try to infer from field name convention
        if (!resolvedCls) {
          resolvedCls = this.inferTypeFromFieldName(gf.name);
        }
        this.resolveFields(gf.children, resolvedCls ?? entry.cls, baseOffset, document, lenses);

        // Show missing fields from the resolved type
        if (resolvedCls) {
          const missing = this.getMissingFields(gf.children, resolvedCls);
          if (missing.length > 0) {
            const used = gf.children.length;
            const total = used + missing.length;
            const preview = missing.slice(0, 5).map((f) => snakeToCamel(f.name)).join(', ');
            const more = missing.length > 5 ? `, +${missing.length - 5}` : '';
            lenses.push(new vscode.CodeLens(range, {
              title: `⚠ ${used}/${total} fields — missing: ${preview}${more}`,
              tooltip: 'Click to see all missing fields',
              command: 'djangoGraphqlExplorer.showMissingFields',
              arguments: [
                resolvedCls.name,
                gf.children.map((c) => c.name),
                missing.map((f) => ({ name: snakeToCamel(f.name), type: `${f.fieldType}${f.resolvedType ? ' → ' + f.resolvedType : ''}` })),
              ],
            }));
          }
        }
      }
    }
  }

  private getMissingFields(frontendFields: GqlField[], backendCls: ClassInfo): FieldInfo[] {
    // Collect all fields available from this class (including inherited)
    const available = this.getAllTypeFields(backendCls);
    const usedSnakeNames = new Set(frontendFields.map((gf) => camelToSnake(gf.name)));
    return available.filter((f) => !usedSnakeNames.has(f.name));
  }

  private getAllTypeFields(cls: ClassInfo): FieldInfo[] {
    if (cls.fields.length > 0) return cls.fields;
    // Flatten mixin base classes
    const fields: FieldInfo[] = [];
    const seen = new Set<string>();
    this.flattenBaseFields(cls, fields, seen, 0);
    return fields;
  }

  private flattenBaseFields(cls: ClassInfo, out: FieldInfo[], seen: Set<string>, depth: number): void {
    if (depth > 4 || seen.has(cls.name)) return;
    seen.add(cls.name);
    for (const baseName of cls.baseClasses) {
      const base = this.classMap.get(baseName);
      if (!base) continue;
      if (base.fields.length > 0) {
        out.push(...base.fields);
      } else {
        this.flattenBaseFields(base, out, seen, depth + 1);
      }
    }
  }

  /**
   * Infer the backend type class from a frontend field name.
   * e.g., "investors" → look for "InvestorType", "InvestorsType", "RtccInvestorType", etc.
   *       "companyInfo" → look for "CompanyInfoType", "CompanyType"
   */
  private inferTypeFromFieldName(camelFieldName: string): ClassInfo | null {
    const snakeName = camelToSnake(camelFieldName);
    // Convert to PascalCase
    const pascal = snakeName.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

    // Try common suffixes and variations
    const candidates = [
      `${pascal}Type`,           // InvestorsType
      `${pascal}`,               // Investors (might be a type itself)
      // Remove trailing 's' for singular form
      `${pascal.replace(/s$/, '')}Type`,  // InvestorType
      `${pascal.replace(/s$/, '')}`,      // Investor
      // Remove 'List' suffix
      `${pascal.replace(/List$/, '')}Type`,
    ];

    for (const name of candidates) {
      const cls = this.classMap.get(name);
      if (cls && cls.kind === 'type') return cls;
    }

    // Fuzzy: find any type class whose name contains the pascal form
    const singularPascal = pascal.replace(/s$/, '');
    if (singularPascal.length >= 6) { // avoid matching too-short names
      for (const [, cls] of this.classMap) {
        if (cls.kind === 'type' && cls.name.includes(singularPascal) && cls.name.endsWith('Type')) {
          return cls;
        }
      }
    }

    return null;
  }

  private findEntry(snakeFieldName: string, parentType: ClassInfo | null): IndexEntry | undefined {
    const entries = this.fieldIndex.get(snakeFieldName);
    if (!entries || entries.length === 0) return undefined;
    if (entries.length === 1) return entries[0];

    if (parentType) {
      // Direct match: field belongs to parentType
      const direct = entries.find((e) => e.cls.name === parentType.name);
      if (direct) return direct;

      // Base class match: field belongs to a base class of parentType
      const baseMatch = entries.find((e) => parentType.baseClasses.includes(e.cls.name));
      if (baseMatch) return baseMatch;

      // Same kind match: if parent is a type, prefer type entries
      const sameKind = entries.find((e) => e.cls.kind === parentType.kind);
      if (sameKind) return sameKind;
    }

    // No parent context: could be root level or context was lost (unresolved type)
    // Heuristic: common scalar-like field names (id, name, email, etc.) → prefer type
    // Other names → prefer query/mutation (likely root fields)
    const typeEntry = entries.find((e) => e.cls.kind === 'type');
    const qmEntry = entries.find((e) => e.cls.kind === 'query' || e.cls.kind === 'mutation');
    if (parentType) {
      return typeEntry ?? qmEntry ?? entries[0];
    }
    // At root level, prefer query/mutation; but if the field name is very common, prefer type
    if (qmEntry) return qmEntry;
    return typeEntry ?? entries[0];
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (this.fieldIndex.size === 0) return undefined;

    const text = document.getText();
    const offset = document.offsetAt(position);
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
      const parsed = parseGqlFields(gqlBody);
      const hover = this.findHoverInFields(parsed, null, startOffset, offset, document);
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
  ): vscode.Hover | undefined {
    for (const gf of fields) {
      const snakeName = camelToSnake(gf.name);
      const entry = this.findEntry(snakeName, parentType);

      // Check children first (more specific match)
      if (gf.children.length > 0 && entry) {
        let resolvedCls = entry.field.resolvedType
          ? (this.classMap.get(entry.field.resolvedType) ?? null)
          : null;
        if (!resolvedCls) resolvedCls = this.inferTypeFromFieldName(gf.name);
        const childHover = this.findHoverInFields(gf.children, resolvedCls ?? entry.cls, baseOffset, cursorOffset, document);
        if (childHover) return childHover;
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

interface GqlField {
  name: string;
  offset: number;       // offset of the display name (alias or field name) in gql body
  nameOffset: number;   // offset of the actual field name in gql body (after alias ':')
  nameLength: number;   // length of the actual field name in source
  children: GqlField[];
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

function parseGqlFields(gql: string): GqlField[] {
  // Skip fragment definitions — they are not operations
  if (/^\s*fragment\b/s.test(gql)) {
    return [];
  }

  // Find operation body — match opening brace after operation declaration
  // Handle multi-line variable declarations by matching nested parens
  let bodyStart: number | undefined;

  // Try to find operation keyword
  const keywordMatch = gql.match(/^\s*(query|mutation|subscription)\b/s);
  if (keywordMatch) {
    let i = keywordMatch.index! + keywordMatch[0].length;
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
    const braceIdx = gql.indexOf('{');
    if (braceIdx === -1) {
      log(`[codeLens] parseGqlFields: no opening brace found`);
      return [];
    }
    bodyStart = braceIdx + 1;
  }

  const result: GqlField[] = [];
  parseFieldsBlock(gql, bodyStart, result);
  return result;
}

function parseFieldsBlock(gql: string, start: number, out: GqlField[]): number {
  let i = start;

  while (i < gql.length) {
    const ch = gql[i];

    // End of this block
    if (ch === '}') return i + 1;

    // Skip parens
    if (ch === '(') { i = skipBracket(gql, i, '(', ')'); continue; }

    // Skip comments
    if (ch === '#') { while (i < gql.length && gql[i] !== '\n') i++; continue; }

    // Skip spreads: ...FragmentName or ... on Type { }
    if (ch === '.' && gql[i + 1] === '.' && gql[i + 2] === '.') {
      i += 3;
      // skip whitespace
      while (i < gql.length && /\s/.test(gql[i])) i++;
      // skip 'on' keyword and type name if inline fragment
      if (gql.substring(i, i + 2) === 'on') {
        i += 2;
        while (i < gql.length && /[\s\w]/.test(gql[i])) i++;
      } else {
        // named fragment spread
        while (i < gql.length && /\w/.test(gql[i])) i++;
      }
      // if followed by { }, skip the selection set
      const afterSpread = gql.substring(i).trimStart();
      if (afterSpread.startsWith('{')) {
        i += gql.substring(i).indexOf('{');
        i = skipBracket(gql, i, '{', '}');
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

      // Skip arguments (...)
      if (gql[i] === '(') {
        i = skipBracket(gql, i, '(', ')');
        while (i < gql.length && /\s/.test(gql[i])) i++;
      }

      // Skip directives @skip, @include etc.
      while (gql[i] === '@') {
        while (i < gql.length && /\w/.test(gql[i]) || gql[i] === '@') i++;
        while (i < gql.length && /\s/.test(gql[i])) i++;
        if (gql[i] === '(') {
          i = skipBracket(gql, i, '(', ')');
          while (i < gql.length && /\s/.test(gql[i])) i++;
        }
      }

      const field: GqlField = { name: fieldName, offset: fieldOffset, nameOffset, nameLength, children: [] };

      // If followed by { }, parse children
      if (gql[i] === '{') {
        i++; // skip '{'
        i = parseFieldsBlock(gql, i, field.children);
      }

      out.push(field);
      continue;
    }

    i++;
  }

  return i;
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
