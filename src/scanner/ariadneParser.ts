import * as vscode from 'vscode';
import { ClassInfo, FieldInfo, SchemaInfo } from '../types';

/**
 * Parses Ariadne GraphQL schemas.
 *
 * Ariadne is schema-first. It uses:
 *   - SDL strings: type_defs = gql("type Query { ... }")
 *   - SDL files loaded via load_schema_from_path()
 *   - Resolver decorators: @query.field("fieldName"), @mutation.field("fieldName")
 *
 * We parse both the SDL definitions and the resolver bindings.
 */

export async function parseAriadneSchemas(rootDir: string): Promise<SchemaInfo[]> {
  const pyFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootDir, '**/*.py'),
    '{**/migrations/**,**/__pycache__/**,**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}'
  );

  const queryFields: FieldInfo[] = [];
  const mutationFields: FieldInfo[] = [];
  const subscriptionFields: FieldInfo[] = [];
  const typeClasses: ClassInfo[] = [];

  // Track resolver variable names -> kind mapping
  // e.g., query = QueryType() -> "query" is a query resolver
  //        mutation = MutationType() -> "mutation" is a mutation resolver
  const resolverVars = new Map<string, 'query' | 'mutation' | 'subscription'>();

  for (const uri of pyFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const lines = text.split('\n');

    if (!/(?:import\s+ariadne|from\s+ariadne)/.test(text)) {
      continue;
    }

    // Find QueryType(), MutationType(), SubscriptionType() variable assignments
    const typeVarRegex = /^(\w+)\s*=\s*(QueryType|MutationType|SubscriptionType)\s*\(/gm;
    let typeVarMatch;
    while ((typeVarMatch = typeVarRegex.exec(text)) !== null) {
      const varName = typeVarMatch[1];
      const typeName = typeVarMatch[2];
      if (typeName === 'QueryType') { resolverVars.set(varName, 'query'); }
      else if (typeName === 'MutationType') { resolverVars.set(varName, 'mutation'); }
      else if (typeName === 'SubscriptionType') { resolverVars.set(varName, 'subscription'); }
    }

    // Find ObjectType("TypeName") variable assignments
    const objTypeRegex = /^(\w+)\s*=\s*ObjectType\s*\(\s*["'](\w+)["']/gm;
    let objMatch;
    while ((objMatch = objTypeRegex.exec(text)) !== null) {
      const varName = objMatch[1];
      const typeName = objMatch[2];
      const lineNumber = text.substring(0, objMatch.index).split('\n').length - 1;

      if (typeName === 'Query') { resolverVars.set(varName, 'query'); }
      else if (typeName === 'Mutation') { resolverVars.set(varName, 'mutation'); }
      else if (typeName === 'Subscription') { resolverVars.set(varName, 'subscription'); }
    }

    // Find @var.field("fieldName") resolver decorators
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const decoratorMatch = line.match(/^\s*@(\w+)\.field\s*\(\s*["'](\w+)["']\s*\)/);
      if (!decoratorMatch) { continue; }

      const varName = decoratorMatch[1];
      const fieldName = decoratorMatch[2];

      // Find the def line to get return type info
      let defIdx = i + 1;
      while (defIdx < lines.length && /^\s*@/.test(lines[defIdx])) {
        defIdx++;
      }

      let returnType = '';
      if (defIdx < lines.length) {
        const defMatch = lines[defIdx].match(/^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)(?:\s*->\s*(.+?))?\s*:/);
        if (defMatch && defMatch[1]) {
          returnType = defMatch[1].trim();
        }
      }

      const field: FieldInfo = {
        name: fieldName,
        fieldType: returnType || 'resolver',
        filePath: uri.fsPath,
        lineNumber: defIdx < lines.length ? defIdx : i,
      };

      const kind = resolverVars.get(varName);
      if (kind === 'query') {
        queryFields.push(field);
      } else if (kind === 'mutation') {
        mutationFields.push(field);
      } else if (kind === 'subscription') {
        subscriptionFields.push(field);
      }
    }

    // Parse inline SDL strings: type_defs = gql(""" ... """) or type_defs = """ ... """
    const sdlBlocks = extractSDLBlocks(text);
    for (const sdl of sdlBlocks) {
      const sdlLineOffset = text.substring(0, text.indexOf(sdl)).split('\n').length - 1;
      parseSDLTypes(sdl, uri.fsPath, sdlLineOffset, queryFields, mutationFields, subscriptionFields, typeClasses);
    }
  }

  const queries: ClassInfo[] = [];
  const mutations: ClassInfo[] = [];
  const subscriptions: ClassInfo[] = [];

  if (queryFields.length > 0) {
    queries.push({
      name: 'Query',
      baseClasses: [],
      framework: 'ariadne',
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
      framework: 'ariadne',
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
      framework: 'ariadne',
      filePath: subscriptionFields[0].filePath,
      lineNumber: subscriptionFields[0].lineNumber,
      fields: subscriptionFields,
      kind: 'subscription',
    });
  }

  const schemaFilePath = queryFields[0]?.filePath ?? mutationFields[0]?.filePath ?? rootDir;

  return [{
    name: 'ariadne',
    filePath: schemaFilePath,
    queries,
    mutations,
    subscriptions,
    types: typeClasses,
  }];
}

function extractSDLBlocks(text: string): string[] {
  const blocks: string[] = [];

  // Match triple-quoted strings that contain GraphQL type definitions
  const tripleQuoteRegex = /(?:gql\s*\(\s*)?"""([\s\S]*?)"""/g;
  let match;
  while ((match = tripleQuoteRegex.exec(text)) !== null) {
    const content = match[1];
    if (/\btype\s+\w+/.test(content)) {
      blocks.push(content);
    }
  }

  return blocks;
}

function parseSDLTypes(
  sdl: string,
  filePath: string,
  lineOffset: number,
  queryFields: FieldInfo[],
  mutationFields: FieldInfo[],
  subscriptionFields: FieldInfo[],
  typeClasses: ClassInfo[],
): void {
  // Parse SDL type definitions
  const typeRegex = /\btype\s+(\w+)(?:\s+implements\s+[^{]*)?\s*\{([^}]*)\}/g;
  let match;
  while ((match = typeRegex.exec(sdl)) !== null) {
    const typeName = match[1];
    const body = match[2];
    const typeLineOffset = lineOffset + sdl.substring(0, match.index).split('\n').length - 1;

    const fields = parseSDLFields(body, filePath, typeLineOffset);

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
        framework: 'ariadne',
        filePath,
        lineNumber: typeLineOffset,
        fields,
        kind: 'type',
      });
    }
  }
}

function parseSDLFields(body: string, filePath: string, typeLineOffset: number): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const fieldLines = body.split('\n');

  for (let i = 0; i < fieldLines.length; i++) {
    const line = fieldLines[i].trim();
    if (!line || line.startsWith('#')) { continue; }

    // Match: fieldName(args): ReturnType or fieldName: Type
    const fieldMatch = line.match(/^(\w+)(?:\([^)]*\))?\s*:\s*(.+?)(?:\s*@.*)?$/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2].trim().replace(/!$/, '');
      const resolvedType = extractSDLType(fieldType);

      fields.push({
        name: fieldName,
        fieldType,
        resolvedType,
        filePath,
        lineNumber: typeLineOffset + i + 1,
      });
    }
  }

  return fields;
}

function extractSDLType(typeStr: string): string | undefined {
  // [Type!]! -> Type
  const listMatch = typeStr.match(/\[(\w+)/);
  if (listMatch) { return listMatch[1]; }

  // Type! -> Type
  const plainMatch = typeStr.match(/^(\w+)/);
  if (plainMatch && !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(plainMatch[1])) {
    return plainMatch[1];
  }

  return undefined;
}
