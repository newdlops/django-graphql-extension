import * as vscode from 'vscode';
import { ClassInfo, FieldInfo } from '../types';

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

interface FieldMatch {
  frontendName: string;   // camelCase from gql
  backendField: FieldInfo;
  cls: ClassInfo;
}

export class GqlCodeLensProvider implements vscode.CodeLensProvider, vscode.HoverProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private fieldIndex = new Map<string, { cls: ClassInfo; field: FieldInfo }>(); // snake_case → { cls, field }

  updateIndex(classMap: Map<string, ClassInfo>): void {
    this.fieldIndex.clear();
    for (const [, cls] of classMap) {
      if (cls.kind !== 'query' && cls.kind !== 'mutation') continue;
      for (const field of cls.fields) {
        this.fieldIndex.set(field.name, { cls, field });
      }
    }
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (this.fieldIndex.size === 0) return [];

    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];

    // Find gql`...` or graphql`...` tagged template literals
    const gqlRegex = /(?:gql|graphql)\s*`/g;
    let gqlMatch;

    while ((gqlMatch = gqlRegex.exec(text)) !== null) {
      const startOffset = gqlMatch.index + gqlMatch[0].length;
      const templateEnd = findTemplateEnd(text, startOffset);
      if (templateEnd === -1) continue;

      const gqlBody = text.substring(startOffset, templateEnd);
      const rootFields = extractRootFields(gqlBody);

      for (const rf of rootFields) {
        const snakeName = camelToSnake(rf.name);
        const entry = this.fieldIndex.get(snakeName);
        if (!entry) continue;

        const fieldOffset = startOffset + rf.offset;
        const pos = document.positionAt(fieldOffset);
        const range = new vscode.Range(pos, pos);

        const fieldType = entry.field.resolvedType
          ? `${entry.field.fieldType}(${entry.field.resolvedType})`
          : entry.field.fieldType;

        lenses.push(new vscode.CodeLens(range, {
          title: `→ ${entry.cls.name}.${entry.field.name}: ${fieldType}`,
          tooltip: `${rf.name} → ${entry.field.name} in ${entry.cls.name} (${entry.cls.filePath}:${entry.cls.lineNumber + 1})`,
          command: 'djangoGraphqlExplorer.openClass',
          arguments: [entry.cls.filePath, entry.cls.lineNumber],
        }));
      }
    }

    return lenses;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (this.fieldIndex.size === 0) return undefined;

    const text = document.getText();
    const offset = document.offsetAt(position);

    // Check if we're inside a gql`...` template
    const gqlRegex = /(?:gql|graphql)\s*`/g;
    let gqlMatch;
    while ((gqlMatch = gqlRegex.exec(text)) !== null) {
      const startOffset = gqlMatch.index + gqlMatch[0].length;
      const templateEnd = findTemplateEnd(text, startOffset);
      if (templateEnd === -1) continue;
      if (offset < startOffset || offset > templateEnd) continue;

      // We're inside this gql template. Check if cursor is on a root field name.
      const gqlBody = text.substring(startOffset, templateEnd);
      const rootFields = extractRootFields(gqlBody);

      for (const rf of rootFields) {
        const fieldStart = startOffset + rf.offset;
        const fieldEnd = fieldStart + rf.name.length;
        if (offset < fieldStart || offset > fieldEnd) continue;

        const snakeName = camelToSnake(rf.name);
        const entry = this.fieldIndex.get(snakeName);
        if (!entry) continue;

        const { cls, field } = entry;
        const lines: string[] = [
          `**${rf.name}** → \`${cls.name}.${field.name}\``,
          '',
          '| | |',
          '|---|---|',
          `| **Frontend field** | \`${rf.name}\` |`,
          `| **Backend field** | \`${field.name}: ${field.fieldType}\` |`,
          `| **Resolved type** | \`${field.resolvedType ?? '—'}\` |`,
          `| **Class** | \`${cls.name}\` (${cls.kind}) |`,
          `| **File** | \`${cls.filePath}:${cls.lineNumber + 1}\` |`,
        ];

        if (cls.fields.length > 0) {
          lines.push('', `**Other fields in ${cls.name}:**`);
          const others = cls.fields.filter((f) => f.name !== field.name).slice(0, 10);
          for (const f of others) {
            lines.push(`- \`${f.name}\`: ${f.fieldType}${f.resolvedType ? ` → ${f.resolvedType}` : ''}`);
          }
          if (cls.fields.length - 1 > 10) {
            lines.push(`- *...and ${cls.fields.length - 1 - 10} more*`);
          }
        }

        const md = new vscode.MarkdownString(lines.join('\n'));
        const range = new vscode.Range(
          document.positionAt(fieldStart),
          document.positionAt(fieldEnd),
        );
        return new vscode.Hover(md, range);
      }
    }

    return undefined;
  }
}

function findTemplateEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') return i;
    if (text[i] === '\\') i++; // skip escaped chars
    if (text[i] === '$' && text[i + 1] === '{') {
      // skip template expression
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

interface RootField {
  name: string;
  offset: number; // offset within the gql template body
}

function extractRootFields(gql: string): RootField[] {
  const fields: RootField[] = [];

  // Find the first { after query/mutation keyword (or bare {)
  const opMatch = gql.match(/(?:query|mutation|subscription)\s+\w*(?:\s*\([^)]*\))?\s*\{/s);
  let bodyStart: number;
  if (opMatch) {
    bodyStart = opMatch.index! + opMatch[0].length;
  } else {
    const braceIdx = gql.indexOf('{');
    if (braceIdx === -1) return fields;
    bodyStart = braceIdx + 1;
  }

  // Parse root-level fields (depth = 0 within the operation body)
  let depth = 0;
  let i = bodyStart;
  while (i < gql.length) {
    const ch = gql[i];

    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      if (depth === 0) break; // end of operation body
      depth--;
      i++;
      continue;
    }

    // At root depth, look for field names
    if (depth === 0 && /[a-zA-Z_]/.test(ch)) {
      const nameMatch = gql.substring(i).match(/^([a-zA-Z_]\w*)/);
      if (nameMatch) {
        const name = nameMatch[1];
        // Skip GraphQL keywords that appear at this level
        if (!['on', 'fragment', 'true', 'false', 'null'].includes(name)) {
          fields.push({ name, offset: i });
        }
        i += nameMatch[0].length;
        continue;
      }
    }

    i++;
  }

  return fields;
}
