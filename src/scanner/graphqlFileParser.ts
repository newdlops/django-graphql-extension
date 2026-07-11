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

  const documents: Array<{ filePath: string; text: string }> = [];

  for (const uri of gqlFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    documents.push({ filePath: uri.fsPath, text: doc.getText() });
  }

  const hasExplicitSchema = documents.some((document) =>
    /\b(?:extend\s+)?schema\s*(?:@[^{}]+)?\{/.test(document.text),
  );
  const operationTypes = hasExplicitSchema
    ? { query: '', mutation: '', subscription: '' }
    : { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };
  for (const document of documents) {
    Object.assign(operationTypes, extractSchemaOperationTypes(document.text));
  }

  for (const document of documents) {
    parseSDL(
      document.text,
      document.filePath,
      queryFields,
      mutationFields,
      subscriptionFields,
      typeClasses,
      operationTypes,
    );
  }

  const queries: ClassInfo[] = [];
  const mutations: ClassInfo[] = [];
  const subscriptions: ClassInfo[] = [];

  if (queryFields.length > 0) {
    queries.push({
      name: operationTypes.query,
      baseClasses: [],
      framework: 'graphql-schema',
      filePath: queryFields[0].filePath,
      lineNumber: queryFields[0].lineNumber,
      fields: queryFields,
      kind: 'query',
      isSchemaRoot: true,
    });
  }

  if (mutationFields.length > 0) {
    mutations.push({
      name: operationTypes.mutation,
      baseClasses: [],
      framework: 'graphql-schema',
      filePath: mutationFields[0].filePath,
      lineNumber: mutationFields[0].lineNumber,
      fields: mutationFields,
      kind: 'mutation',
      isSchemaRoot: true,
    });
  }

  if (subscriptionFields.length > 0) {
    subscriptions.push({
      name: operationTypes.subscription,
      baseClasses: [],
      framework: 'graphql-schema',
      filePath: subscriptionFields[0].filePath,
      lineNumber: subscriptionFields[0].lineNumber,
      fields: subscriptionFields,
      kind: 'subscription',
      isSchemaRoot: true,
    });
  }

  const schemaFilePath = queryFields[0]?.filePath ?? mutationFields[0]?.filePath ?? rootDir;
  const mergedTypes = mergeTypeClasses(typeClasses);

  return [{
    name: 'graphql-schema',
    filePath: schemaFilePath,
    queries,
    mutations,
    subscriptions,
    types: mergedTypes,
  }];
}

function extractSchemaOperationTypes(text: string): Partial<Record<'query' | 'mutation' | 'subscription', string>> {
  const out: Partial<Record<'query' | 'mutation' | 'subscription', string>> = {};
  const schemaRegex = /\b(?:extend\s+)?schema\s*(?:@[^{}]+)?\{([\s\S]*?)\}/g;
  let schemaMatch: RegExpExecArray | null;
  while ((schemaMatch = schemaRegex.exec(text)) !== null) {
    for (const kind of ['query', 'mutation', 'subscription'] as const) {
      const match = new RegExp(`\\b${kind}\\s*:\\s*([A-Za-z_]\\w*)`).exec(schemaMatch[1]);
      if (match) out[kind] = match[1];
    }
  }
  return out;
}

function mergeTypeClasses(classes: ClassInfo[]): ClassInfo[] {
  const merged = new Map<string, ClassInfo>();
  for (const cls of classes) {
    const existing = merged.get(cls.name);
    if (!existing) {
      merged.set(cls.name, cls);
      continue;
    }
    const seen = new Set(existing.fields.map((field) => field.graphqlName ?? field.name));
    for (const field of cls.fields) {
      const name = field.graphqlName ?? field.name;
      if (!seen.has(name)) {
        existing.fields.push(field);
        seen.add(name);
      }
    }
  }
  return [...merged.values()];
}

function parseSDL(
  text: string,
  filePath: string,
  queryFields: FieldInfo[],
  mutationFields: FieldInfo[],
  subscriptionFields: FieldInfo[],
  typeClasses: ClassInfo[],
  operationTypes: { query: string; mutation: string; subscription: string },
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
        addFieldsToTarget(typeName, fields, queryFields, mutationFields, subscriptionFields, typeClasses, filePath, i, operationTypes);
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
        addFieldsToTarget(currentType, currentFields, queryFields, mutationFields, subscriptionFields, typeClasses, filePath, currentTypeStartLine, operationTypes);
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
            graphqlName: fieldName,
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
    addFieldsToTarget(currentType, currentFields, queryFields, mutationFields, subscriptionFields, typeClasses, filePath, currentTypeStartLine, operationTypes);
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
        graphqlName: fieldMatch[1],
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
  operationTypes: { query: string; mutation: string; subscription: string },
): void {
  if (typeName === operationTypes.query) {
    queryFields.push(...fields);
  } else if (typeName === operationTypes.mutation) {
    mutationFields.push(...fields);
  } else if (typeName === operationTypes.subscription) {
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
