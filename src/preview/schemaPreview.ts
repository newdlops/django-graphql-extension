import { ClassInfo, FieldInfo } from '../types';

const SCALAR_TYPES = new Set([
  'String', 'Int', 'Float', 'Boolean', 'ID',
  'DateTime', 'Date', 'Time', 'Decimal', 'JSONString', 'UUID',
  'Field', 'List', 'NonNull',
  'DjangoListField', 'DjangoFilterConnectionField', 'DjangoConnectionField',
  'Argument', 'InputField',
]);

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function classToGraphql(cls: ClassInfo, classMap: Map<string, ClassInfo>): string {
  const keyword = cls.kind === 'mutation' ? 'mutation' : 'query';
  const fields = collectAllFields(cls, classMap);

  if (fields.length === 0) {
    return `# ${cls.name} — no fields found`;
  }

  // Collect all variable declarations from field args
  const allArgs = fields.flatMap((f) => f.args ?? []);
  const varDecl = allArgs.length > 0
    ? `(${allArgs.map((a) => {
        const type = a.required ? `${a.type}!` : a.type;
        return `$${snakeToCamel(a.name)}: ${type}`;
      }).join(', ')})`
    : '';

  const lines: string[] = [];
  lines.push(`${keyword} ${cls.name}${varDecl} {`);

  for (const field of fields) {
    renderField(field, classMap, 1, new Set(), lines);
  }

  lines.push('}');
  return lines.join('\n');
}

function collectAllFields(cls: ClassInfo, classMap: Map<string, ClassInfo>): FieldInfo[] {
  // If the class has its own fields, use them
  if (cls.fields.length > 0) return cls.fields;

  // Otherwise flatten mixin base classes (graphene pattern)
  const fields: FieldInfo[] = [];
  const seen = new Set<string>();
  flattenMixins(cls, classMap, fields, seen, 0);
  return fields;
}

function flattenMixins(
  cls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  out: FieldInfo[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || seen.has(cls.name)) return;
  seen.add(cls.name);
  for (const baseName of cls.baseClasses) {
    const base = classMap.get(baseName);
    if (!base) continue;
    if (base.fields.length > 0) {
      out.push(...base.fields);
    } else {
      flattenMixins(base, classMap, out, seen, depth + 1);
    }
  }
}

function formatArgs(field: FieldInfo): string {
  if (!field.args || field.args.length === 0) return '';
  const parts = field.args.map((a) => {
    const type = a.required ? `${a.type}!` : a.type;
    return `$${snakeToCamel(a.name)}: ${type}`;
  });
  return `(${parts.join(', ')})`;
}

function formatArgValues(field: FieldInfo): string {
  if (!field.args || field.args.length === 0) return '';
  const parts = field.args.map((a) => {
    const camel = snakeToCamel(a.name);
    return `${camel}: $${camel}`;
  });
  return `(${parts.join(', ')})`;
}

function renderField(
  field: FieldInfo,
  classMap: Map<string, ClassInfo>,
  depth: number,
  visited: Set<string>,
  lines: string[],
): void {
  const indent = '  '.repeat(depth);
  const camelName = snakeToCamel(field.name);
  const argValues = formatArgValues(field);
  const resolvedCls = field.resolvedType ? classMap.get(field.resolvedType) : undefined;

  if (resolvedCls && resolvedCls.fields.length > 0 && !visited.has(resolvedCls.name)) {
    visited.add(resolvedCls.name);
    lines.push(`${indent}${camelName}${argValues} {`);
    for (const subField of resolvedCls.fields) {
      renderField(subField, classMap, depth + 1, visited, lines);
    }
    lines.push(`${indent}}`);
    visited.delete(resolvedCls.name);
  } else {
    lines.push(`${indent}${camelName}${argValues}`);
  }
}
