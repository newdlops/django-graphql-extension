// Scenario 6: mixin inheritance — fields from a base (non-graphene) mixin must be
// merged into the inheriting class's resolved field list.

import { describe, it, expect, beforeEach } from 'vitest';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';
import { parseGrapheneSchemas, resolveInheritedFields } from '../../scanner/grapheneParser';
import { ClassInfo, FieldInfo } from '../../types';

beforeEach(() => __clearMockFiles());

function fieldNames(cls: ClassInfo | undefined): string[] {
  if (!cls) return [];
  return cls.fields.map((f) => f.name).sort();
}

function findClass(schemas: Awaited<ReturnType<typeof parseGrapheneSchemas>>, name: string): ClassInfo | undefined {
  for (const s of schemas) {
    for (const c of [...s.queries, ...s.mutations, ...s.types]) {
      if (c.name === name) return c;
    }
  }
  return undefined;
}

describe('resolveInheritedFields — pure unit test', () => {
  const mk = (name: string, fields: FieldInfo[], baseClasses: string[] = []): ClassInfo => ({
    name, baseClasses, framework: 'graphene', filePath: '/f.py', lineNumber: 0, fields, kind: 'type',
  });
  const f = (name: string): FieldInfo => ({ name, fieldType: 'String', filePath: '/f.py', lineNumber: 0 });

  it('merges own fields with base class fields', () => {
    const base = mk('TimestampMixin', [f('created_at'), f('updated_at')]);
    const child = mk('UserType', [f('id'), f('name')], ['TimestampMixin']);
    const map = new Map([[base.name, base], [child.name, child]]);
    const merged = resolveInheritedFields(child, map);
    expect(merged.map((x) => x.name).sort()).toEqual(['created_at', 'id', 'name', 'updated_at']);
  });

  it('child field takes precedence on name collision', () => {
    const base = mk('Mixin', [{ ...f('name'), fieldType: 'BaseType' }]);
    const child = mk('UserType', [{ ...f('name'), fieldType: 'ChildType' }], ['Mixin']);
    const map = new Map([[base.name, base], [child.name, child]]);
    const merged = resolveInheritedFields(child, map);
    expect(merged).toHaveLength(1);
    expect(merged[0].fieldType).toBe('ChildType');
  });

  it('is safe against cyclic inheritance (does not infinite-loop)', () => {
    const a = mk('A', [f('a_field')], ['B']);
    const b = mk('B', [f('b_field')], ['A']);
    const map = new Map([[a.name, a], [b.name, b]]);
    const merged = resolveInheritedFields(a, map);
    expect(merged.map((x) => x.name).sort()).toEqual(['a_field', 'b_field']);
  });
});

describe('parseGrapheneSchemas — scenario 6 (mixin inheritance, E2E)', () => {
  it('inherits fields from a non-graphene mixin into the derived ObjectType', async () => {
    __setMockFiles({
      '/proj/myapp/types.py': [
        'from graphene import ObjectType, DateTime, ID, String, Field, Schema',
        '',
        'class TimestampMixin:',
        '    created_at = DateTime()',
        '    updated_at = DateTime()',
        '',
        'class UserType(TimestampMixin, ObjectType):',
        '    id = ID()',
        '    name = String()',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    expect(schemas.length).toBeGreaterThan(0);

    const user = findClass(schemas, 'UserType');
    expect(user, 'UserType should be discovered').toBeDefined();

    // RED before fix: UserType.fields only contains [id, name].
    // GREEN after fix: mixin fields (created_at, updated_at) are merged in.
    expect(fieldNames(user)).toEqual(['created_at', 'id', 'name', 'updated_at']);
  });

  it('tags inherited fields with definedIn pointing to the declaring mixin (phase α)', async () => {
    __setMockFiles({
      '/proj/types.py': [
        'from graphene import ObjectType, DateTime, ID, String, Field, Schema',
        '',
        'class TimestampMixin:',
        '    created_at = DateTime()',
        '    updated_at = DateTime()',
        '',
        'class UserType(TimestampMixin, ObjectType):',
        '    id = ID()',
        '    name = String()',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const user = findClass(schemas, 'UserType');
    expect(user).toBeDefined();

    const own = user!.fields.filter((f) => !f.definedIn).map((f) => f.name).sort();
    const inherited = user!.fields.filter((f) => f.definedIn).map((f) => ({ name: f.name, from: f.definedIn }));

    expect(own).toEqual(['id', 'name']);
    expect(inherited.map((i) => i.name).sort()).toEqual(['created_at', 'updated_at']);
    for (const inh of inherited) expect(inh.from).toBe('TimestampMixin');
  });

  it('inherits through a chain of mixins', async () => {
    __setMockFiles({
      '/proj/types.py': [
        'from graphene import ObjectType, DateTime, ID, String, Field, Schema',
        '',
        'class AuditMixin:',
        '    audited_by = String()',
        '',
        'class TimestampMixin(AuditMixin):',
        '    created_at = DateTime()',
        '',
        'class UserType(TimestampMixin, ObjectType):',
        '    id = ID()',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const user = findClass(schemas, 'UserType');
    expect(fieldNames(user)).toEqual(['audited_by', 'created_at', 'id']);
  });
});
