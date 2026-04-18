// Phase (δ): resolveTemplateAtCursor — returns EVERY root in the template,
// not just the innermost field under the cursor.

import { describe, it, expect } from 'vitest';
import { resolveTemplateAtCursor } from '../../codelens/gqlCursorResolver';
import { buildFieldIndex } from '../../codelens/gqlResolver';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type'): ClassInfo {
  return { name, baseClasses: [], framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}
function ctxFor(classes: ClassInfo[]) {
  const classMap = new Map(classes.map((c) => [c.name, c] as const));
  return { classMap, fieldIndex: buildFieldIndex(classMap) };
}

describe('resolveTemplateAtCursor (phase δ)', () => {
  it('returns every root field even when the cursor is deep inside one of them', () => {
    const companyType = cls('CompanyType', [f('name')]);
    const userType = cls('UserType', [f('id'), f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const query = cls('Query', [
      f('user', 'Field', { resolvedType: 'UserType' }),
      f('stats', 'Field', { resolvedType: 'StatsType' }),
    ], 'query');
    const statsType = cls('StatsType', [f('count', 'Int')]);
    const ctx = ctxFor([companyType, userType, query, statsType]);

    const src = 'const q = gql`query Dashboard { user { id company { name } } stats { count } }`;';
    // Cursor buried inside `user { company { ... } }`
    const cursor = src.indexOf('name') + 1;
    const tpl = resolveTemplateAtCursor(src, cursor, ctx);
    expect(tpl).not.toBeNull();
    expect(tpl!.operationKind).toBe('query');
    expect(tpl!.operationName).toBe('Dashboard');
    expect(tpl!.roots.map((r) => r.gqlField.name)).toEqual(['user', 'stats']);
    expect(tpl!.roots[0].targetClass?.name).toBe('UserType');
    expect(tpl!.roots[1].targetClass?.name).toBe('StatsType');
  });

  it('flags a root field whose resolved type is unknown', () => {
    const query = cls('Query', [
      f('user', 'Field', { resolvedType: 'MissingType' }),
    ], 'query');
    const ctx = ctxFor([query]);

    const src = 'gql`query { user { id } }`;';
    const tpl = resolveTemplateAtCursor(src, src.indexOf('user') + 1, ctx)!;
    expect(tpl.roots).toHaveLength(1);
    const root = tpl.roots[0];
    expect(root.match).toBeDefined();
    expect(root.targetClass).toBeUndefined();
  });

  it('returns null when the cursor is outside any gql template', () => {
    const ctx = ctxFor([]);
    const src = 'const q = gql`query { user { id } }`;\nconst x = 42;';
    const tpl = resolveTemplateAtCursor(src, src.indexOf('const x'), ctx);
    expect(tpl).toBeNull();
  });

  it('handles anonymous queries (no operation name) gracefully', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFor([userType, query]);

    const src = 'gql`{ user { id } }`;';
    const tpl = resolveTemplateAtCursor(src, src.indexOf('user'), ctx)!;
    // With no operation keyword, kind defaults to 'unknown' but roots are still there.
    expect(tpl.operationKind).toBe('unknown');
    expect(tpl.operationName).toBeUndefined();
    expect(tpl.roots).toHaveLength(1);
    expect(tpl.roots[0].gqlField.name).toBe('user');
  });

  it('reports mutation operations correctly', () => {
    const userType = cls('UserType', [f('id')]);
    const mut = cls('Mutation', [f('create_user', 'Field', { resolvedType: 'UserType' })], 'mutation');
    const ctx = ctxFor([userType, mut]);

    const src = 'gql`mutation CreateUser { createUser { id } }`;';
    const tpl = resolveTemplateAtCursor(src, src.indexOf('createUser'), ctx)!;
    expect(tpl.operationKind).toBe('mutation');
    expect(tpl.operationName).toBe('CreateUser');
    expect(tpl.roots[0].targetClass?.name).toBe('UserType');
  });
});
