import * as vscode from 'vscode';
import { ClassInfo, FieldInfo, SchemaInfo } from '../types';
import { log } from '../logger';

export async function parseStrawberrySchemas(rootDir: string): Promise<SchemaInfo[]> {
  const pyFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootDir, '**/*.py'),
    '{**/migrations/**,**/__pycache__/**,**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}'
  );

  // -------------------------------------------------------
  // Pass 1: collect decorated classes AND all raw class defs
  //         (raw classes are needed to resolve mixin parents)
  // -------------------------------------------------------
  interface RawStrawberryClass {
    name: string;
    baseClasses: string[];
    filePath: string;
    lineNumber: number;
    lines: string[];
    decoratorType?: string;  // set only for decorated classes
  }

  const decoratedClasses: ClassInfo[] = [];
  const allRawClasses: RawStrawberryClass[] = [];
  let queryRootName: string | undefined;
  let mutationRootName: string | undefined;
  let subscriptionRootName: string | undefined;

  for (const uri of pyFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const lines = text.split('\n');

    const hasStrawberry = /(?:import\s+strawberry|from\s+strawberry)/.test(text);

    // Build a map of line → decorator type (only for strawberry files)
    const decoratorAtLine = new Map<number, string>();
    if (hasStrawberry) {
      // Detect strawberry.Schema() calls
      const schemaMatch = text.match(
        /strawberry\.Schema\s*\(\s*query\s*=\s*(\w+)(?:.*?mutation\s*=\s*(\w+))?(?:.*?subscription\s*=\s*(\w+))?/s
      );
      if (schemaMatch) {
        queryRootName = schemaMatch[1];
        if (schemaMatch[2]) { mutationRootName = schemaMatch[2]; }
        if (schemaMatch[3]) { subscriptionRootName = schemaMatch[3]; }
      }

      for (let i = 0; i < lines.length; i++) {
        const decoratorMatch = lines[i].match(
          /^\s*@(?:strawberry(?:_django)?\.)(type|input|enum|mutation|interface)(?:\s*\(.*\))?\s*$/
        );
        if (!decoratorMatch) { continue; }

        let classLineIdx = i + 1;
        while (classLineIdx < lines.length) {
          const nextLine = lines[classLineIdx];
          if (/^\s*@/.test(nextLine)) { classLineIdx++; continue; }
          if (/^\s*class\s+/.test(nextLine)) { break; }
          break;
        }
        if (classLineIdx < lines.length && /^\s*class\s+/.test(lines[classLineIdx])) {
          decoratorAtLine.set(classLineIdx, decoratorMatch[1]);
        }
      }
    }

    // Collect ALL class definitions from ALL files
    // Supports multiline class definitions
    const classRegex = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*(?:\n[^)]*)*)\))?\s*:/gm;
    let classMatch;
    while ((classMatch = classRegex.exec(text)) !== null) {
      const className = classMatch[2];
      const baseClassRaw = classMatch[3] ?? '';
      const baseClasses = baseClassRaw
        .replace(/#[^\n]*/g, '')
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && /^\w+$/.test(b));
      const lineNumber = text.substring(0, classMatch.index).split('\n').length - 1;

      const decoratorType = decoratorAtLine.get(lineNumber);

      allRawClasses.push({
        name: className,
        baseClasses,
        filePath: uri.fsPath,
        lineNumber,
        lines,
        decoratorType,
      });

      // Build ClassInfo for decorated classes
      if (decoratorType) {
        const fields = parseStrawberryClassBody(lines, lineNumber, uri.fsPath);
        let kind: ClassInfo['kind'] = 'type';
        if (decoratorType === 'mutation') { kind = 'mutation'; }

        decoratedClasses.push({
          name: className,
          baseClasses,
          framework: 'strawberry',
          filePath: uri.fsPath,
          lineNumber,
          fields,
          kind,
        });
      }
    }
  }

  // -------------------------------------------------------
  // Pass 2: discover mixin parents via inheritance tree
  //         Walk UP from decorated classes to find undecorated
  //         base classes that should also be included
  // -------------------------------------------------------
  const rawMap = new Map<string, RawStrawberryClass>();
  for (const raw of allRawClasses) { rawMap.set(raw.name, raw); }

  const decoratedNames = new Set(decoratedClasses.map((c) => c.name));
  const allClasses = [...decoratedClasses];
  const classMap = new Map<string, ClassInfo>();
  for (const cls of decoratedClasses) { classMap.set(cls.name, cls); }

  // Iteratively add undecorated base classes
  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of [...allClasses]) {
      for (const baseName of cls.baseClasses) {
        if (classMap.has(baseName)) { continue; }
        const raw = rawMap.get(baseName);
        if (!raw) { continue; }

        const fields = parseStrawberryClassBody(raw.lines, raw.lineNumber, raw.filePath);
        const newCls: ClassInfo = {
          name: raw.name,
          baseClasses: raw.baseClasses,
          framework: 'strawberry',
          filePath: raw.filePath,
          lineNumber: raw.lineNumber,
          fields,
          kind: 'type',
        };
        allClasses.push(newCls);
        classMap.set(raw.name, newCls);
        changed = true;
      }
    }
  }

  // --- Classification (same multi-strategy as graphene) ---
  if (!queryRootName) { queryRootName = 'Query'; }
  if (!mutationRootName) { mutationRootName = 'Mutation'; }
  if (!subscriptionRootName) { subscriptionRootName = 'Subscription'; }

  // Step A: tag by Schema() ref, decorator kind, or name heuristic
  const kindMap = new Map<string, ClassInfo['kind']>();

  for (const cls of allClasses) {
    if (cls.name === queryRootName) { kindMap.set(cls.name, 'query'); continue; }
    if (cls.name === mutationRootName) { kindMap.set(cls.name, 'mutation'); continue; }
    if (cls.name === subscriptionRootName) { kindMap.set(cls.name, 'subscription'); continue; }
    if (cls.kind === 'mutation') { kindMap.set(cls.name, 'mutation'); continue; }

    const lower = cls.name.toLowerCase();
    if (lower.includes('query')) { kindMap.set(cls.name, 'query'); continue; }
    if (lower.includes('mutation')) { kindMap.set(cls.name, 'mutation'); continue; }
    if (lower.includes('subscription')) { kindMap.set(cls.name, 'subscription'); continue; }
  }

  // Step B: propagate through inheritance (up and down)
  changed = true;
  while (changed) {
    changed = false;
    for (const cls of allClasses) {
      if (kindMap.has(cls.name)) {
        const myKind = kindMap.get(cls.name)!;
        for (const baseName of cls.baseClasses) {
          if (classMap.has(baseName) && !kindMap.has(baseName)) {
            kindMap.set(baseName, myKind);
            changed = true;
          }
        }
      } else {
        const parentKinds = cls.baseClasses
          .filter((bc) => kindMap.has(bc))
          .map((bc) => kindMap.get(bc)!);
        if (parentKinds.length > 0) {
          kindMap.set(cls.name, parentKinds[0]);
          changed = true;
        }
      }
    }
  }

  // --- Build result ---
  const queries: ClassInfo[] = [];
  const mutations: ClassInfo[] = [];
  const subscriptions: ClassInfo[] = [];
  const types: ClassInfo[] = [];

  for (const cls of allClasses) {
    const kind = kindMap.get(cls.name) ?? 'type';
    cls.kind = kind;

    if (kind === 'query') { queries.push(cls); }
    else if (kind === 'mutation') { mutations.push(cls); }
    else if (kind === 'subscription') { subscriptions.push(cls); }
    else { types.push(cls); }
  }

  log(`[strawberry] === FINAL RESULT ===`);
  log(`[strawberry]   pyFiles scanned: ${pyFiles.length}`);
  log(`[strawberry]   queries: ${queries.length} [${queries.map(q => q.name).join(', ')}]`);
  log(`[strawberry]   mutations: ${mutations.length} [${mutations.map(m => m.name).join(', ')}]`);
  log(`[strawberry]   types: ${types.length}`);

  // Determine schema file path (from Schema() call or first query file)
  const schemaFilePath = queries[0]?.filePath ?? mutations[0]?.filePath ?? rootDir;

  return [{
    name: 'strawberry',
    filePath: schemaFilePath,
    queries,
    mutations,
    subscriptions,
    types,
  }];
}

function parseStrawberryClassBody(
  lines: string[],
  classLineIdx: number,
  filePath: string,
): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const classLine = lines[classLineIdx];
  const classIndent = classLine.match(/^(\s*)/)?.[1].length ?? 0;

  for (let i = classLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*$/.test(line) || /^\s*#/.test(line)) { continue; }

    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lineIndent <= classIndent && line.trim().length > 0) { break; }

    // Type-annotated fields
    const annotatedField = line.match(/^\s+(\w+)\s*:\s*(.+?)(?:\s*=.*)?$/);
    if (annotatedField) {
      const fieldName = annotatedField[1];
      const typeAnnotation = annotatedField[2].trim();
      if (fieldName.startsWith('_')) { continue; }

      fields.push({
        name: fieldName,
        fieldType: typeAnnotation,
        resolvedType: extractTypeFromAnnotation(typeAnnotation),
        filePath,
        lineNumber: i,
      });
      continue;
    }

    // Decorated methods
    if (/^\s+@(?:strawberry(?:_django)?\.)(field|mutation)/.test(line)) {
      let defIdx = i + 1;
      while (defIdx < lines.length && /^\s+@/.test(lines[defIdx])) { defIdx++; }
      if (defIdx < lines.length) {
        const defMatch = lines[defIdx].match(/^\s+(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*(.+?))?\s*:/);
        if (defMatch) {
          const returnType = defMatch[2]?.trim() ?? '';
          fields.push({
            name: defMatch[1],
            fieldType: returnType || 'Field',
            resolvedType: extractTypeFromAnnotation(returnType),
            filePath,
            lineNumber: defIdx,
          });
          i = defIdx;
        }
      }
    }
  }

  return fields;
}

function extractTypeFromAnnotation(annotation: string): string | undefined {
  const genericMatch = annotation.match(/(?:List|Optional|Sequence)\[(\w+)/);
  if (genericMatch) { return genericMatch[1]; }

  const plainMatch = annotation.match(/^(\w+)$/);
  if (plainMatch && !['str', 'int', 'float', 'bool', 'None', 'ID'].includes(plainMatch[1])) {
    return plainMatch[1];
  }

  return undefined;
}
