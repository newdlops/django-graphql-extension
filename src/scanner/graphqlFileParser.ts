import * as vscode from 'vscode';
import { ClassInfo, FieldInfo, SchemaInfo } from '../types';

/**
 * Parses .graphql / .gql schema definition files.
 */

export async function parseGraphQLFiles(rootDir: string): Promise<SchemaInfo[]> {
  const gqlFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootDir, '**/*.{graphql,gql}'),
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}'
  );

  const queryFields: FieldInfo[] = [];
  const mutationFields: FieldInfo[] = [];
  const subscriptionFields: FieldInfo[] = [];
  const typeClasses: ClassInfo[] = [];

  for (const uri of gqlFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    parseSDL(text, uri.fsPath, queryFields, mutationFields, subscriptionFields, typeClasses);
  }

  const queries: ClassInfo[] = [];
  const mutations: ClassInfo[] = [];
  const subscriptions: ClassInfo[] = [];

  if (queryFields.length > 0) {
    queries.push({
      name: 'Query',
      baseClasses: [],
      framework: 'graphql-schema',
      filePath: queryFields[0].filePath,
      lineNumber: queryFields[0].lineNumber,
      fields: queryFields,
      kind: 'query',
    });
  }

  if (mutationFields.length > 0) {
    mutations.push({
      name: 'Mutation',
      baseClasses: [],
      framework: 'graphql-schema',
      filePath: mutationFields[0].filePath,
      lineNumber: mutationFields[0].lineNumber,
      fields: mutationFields,
      kind: 'mutation',
    });
  }

  if (subscriptionFields.length > 0) {
    subscriptions.push({
      name: 'Subscription',
      baseClasses: [],
      framework: 'graphql-schema',
      filePath: subscriptionFields[0].filePath,
      lineNumber: subscriptionFields[0].lineNumber,
      fields: subscriptionFields,
      kind: 'subscription',
    });
  }

  const schemaFilePath = queryFields[0]?.filePath ?? mutationFields[0]?.filePath ?? rootDir;

  return [{
    name: 'graphql-schema',
    filePath: schemaFilePath,
    queries,
    mutations,
    subscriptions,
    types: typeClasses,
  }];
}

function parseSDL(
  text: string,
  filePath: string,
  queryFields: FieldInfo[],
  mutationFields: FieldInfo[],
  subscriptionFields: FieldInfo[],
  typeClasses: ClassInfo[],
): void {
  const lines = text.split('\n');

  // State machine to parse SDL
  let currentType: string | null = null;
  let currentTypeStartLine = 0;
  let braceDepth = 0;
  let currentFields: FieldInfo[] = [];
  let isExtend = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }

    // Match type definition start
    if (currentType === null) {
      const typeMatch = trimmed.match(
        /^(extend\s+)?(?:type|input|interface|enum)\s+(\w+)(?:\s+implements\s+[^{]*)?\s*\{?\s*$/
      );
      if (typeMatch) {
        isExtend = !!typeMatch[1];
        currentType = typeMatch[2];
        currentTypeStartLine = i;
        currentFields = [];
        braceDepth = trimmed.includes('{') ? 1 : 0;
        continue;
      }

      // Single-line type with opening brace
      const inlineTypeMatch = trimmed.match(
        /^(extend\s+)?(?:type|input|interface|enum)\s+(\w+)(?:\s+implements\s+[^{]*)?\s*\{(.+)\}\s*$/
      );
      if (inlineTypeMatch) {
        const typeName = inlineTypeMatch[2];
        const body = inlineTypeMatch[3];
        const fields = parseFieldsFromBody(body, filePath, i);
        addFieldsToTarget(typeName, fields, queryFields, mutationFields, subscriptionFields, typeClasses, filePath, i);
        continue;
      }

      // Opening brace on its own line after type declaration
      if (trimmed === '{' && i > 0) {
        const prevLine = lines[i - 1]?.trim();
        const prevTypeMatch = prevLine?.match(
          /^(extend\s+)?(?:type|input|interface|enum)\s+(\w+)(?:\s+implements\s+[^{]*)?\s*$/
        );
        if (prevTypeMatch) {
          isExtend = !!prevTypeMatch[1];
          currentType = prevTypeMatch[2];
          currentTypeStartLine = i - 1;
          currentFields = [];
          braceDepth = 1;
          continue;
        }
      }
    }

    if (currentType !== null) {
      // Count braces
      for (const ch of trimmed) {
        if (ch === '{') { braceDepth++; }
        if (ch === '}') { braceDepth--; }
      }

      if (braceDepth <= 0) {
        // Type block closed
        addFieldsToTarget(currentType, currentFields, queryFields, mutationFields, subscriptionFields, typeClasses, filePath, currentTypeStartLine);
        currentType = null;
        continue;
      }

      // Parse field line
      if (braceDepth === 1 && !trimmed.startsWith('#')) {
        const fieldMatch = trimmed.match(/^(\w+)(?:\([^)]*\))?\s*:\s*(.+?)(?:\s*@.*)?$/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const rawType = fieldMatch[2].trim();
          const fieldType = rawType.replace(/[!\[\]]/g, '').trim();
          const resolvedType = extractResolvedType(rawType);

          currentFields.push({
            name: fieldName,
            fieldType: rawType,
            resolvedType,
            filePath,
            lineNumber: i,
          });
        }
      }
    }
  }

  // Handle unclosed type (EOF)
  if (currentType !== null && currentFields.length > 0) {
    addFieldsToTarget(currentType, currentFields, queryFields, mutationFields, subscriptionFields, typeClasses, filePath, currentTypeStartLine);
  }
}

function parseFieldsFromBody(body: string, filePath: string, lineNumber: number): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const parts = body.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    const fieldMatch = part.match(/^(\w+)(?:\([^)]*\))?\s*:\s*(.+?)$/);
    if (fieldMatch) {
      const rawType = fieldMatch[2].trim();
      fields.push({
        name: fieldMatch[1],
        fieldType: rawType,
        resolvedType: extractResolvedType(rawType),
        filePath,
        lineNumber,
      });
    }
  }

  return fields;
}

function addFieldsToTarget(
  typeName: string,
  fields: FieldInfo[],
  queryFields: FieldInfo[],
  mutationFields: FieldInfo[],
  subscriptionFields: FieldInfo[],
  typeClasses: ClassInfo[],
  filePath: string,
  lineNumber: number,
): void {
  if (typeName === 'Query') {
    queryFields.push(...fields);
  } else if (typeName === 'Mutation') {
    mutationFields.push(...fields);
  } else if (typeName === 'Subscription') {
    subscriptionFields.push(...fields);
  } else {
    typeClasses.push({
      name: typeName,
      baseClasses: [],
      framework: 'graphql-schema',
      filePath,
      lineNumber,
      fields,
      kind: 'type',
    });
  }
}

function extractResolvedType(rawType: string): string | undefined {
  // [Type!]! -> Type, Type! -> Type
  const cleaned = rawType.replace(/[!\[\]]/g, '').trim();
  if (!['String', 'Int', 'Float', 'Boolean', 'ID'].includes(cleaned) && /^\w+$/.test(cleaned)) {
    return cleaned;
  }
  return undefined;
}
