// Scenario 3: DjangoObjectType Meta.fields / Meta.only_fields extraction.

import { describe, it, expect, beforeEach } from 'vitest';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';
import { parseGrapheneSchemas, parseClassFields, EMPTY_IMPORTS } from '../../scanner/grapheneParser';
import { ClassInfo } from '../../types';

beforeEach(() => __clearMockFiles());

function findClass(schemas: Awaited<ReturnType<typeof parseGrapheneSchemas>>, name: string): ClassInfo | undefined {
  for (const s of schemas) {
    for (const c of [...s.queries, ...s.mutations, ...s.types]) {
      if (c.name === name) return c;
    }
  }
  return undefined;
}

describe('parseClassFields — Meta.fields (unit)', () => {
  it('extracts field names from Meta.fields list (string literals)', () => {
    const src = [
      'class UserType(DjangoObjectType):',
      '    class Meta:',
      '        model = User',
      '        fields = ["id", "name", "email"]',
    ];
    const fields = parseClassFields(src, 0, '/u.py', EMPTY_IMPORTS);
    expect(fields.map((f) => f.name)).toEqual(['id', 'name', 'email']);
    for (const f of fields) expect(f.fieldType).toBe('DjangoField');
  });

  it('extracts from only_fields (legacy name) too', () => {
    const src = [
      'class UserType(DjangoObjectType):',
      '    class Meta:',
      '        model = User',
      "        only_fields = ['id', 'email']",
    ];
    const fields = parseClassFields(src, 0, '/u.py', EMPTY_IMPORTS);
    expect(fields.map((f) => f.name)).toEqual(['id', 'email']);
  });

  it('supports tuple syntax: fields = ("a", "b")', () => {
    const src = [
      'class UserType(DjangoObjectType):',
      '    class Meta:',
      '        fields = ("a", "b")',
    ];
    const fields = parseClassFields(src, 0, '/u.py', EMPTY_IMPORTS);
    expect(fields.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('combines Meta.fields with explicit graphene fields in the same class', () => {
    const src = [
      'class UserType(DjangoObjectType):',
      '    class Meta:',
      '        model = User',
      '        fields = ["id", "name"]',
      '',
      '    display_name = String()',
    ];
    const fields = parseClassFields(src, 0, '/u.py', {
      fromGraphene: new Set(['String']),
      fromGrapheneDjango: new Set(['DjangoObjectType']),
      hasGrapheneImport: true,
    });
    expect(fields.map((f) => f.name).sort()).toEqual(['display_name', 'id', 'name']);
  });

  it("gracefully ignores fields = '__all__' (cannot statically enumerate)", () => {
    const src = [
      'class UserType(DjangoObjectType):',
      '    class Meta:',
      '        model = User',
      "        fields = '__all__'",
    ];
    const fields = parseClassFields(src, 0, '/u.py', EMPTY_IMPORTS);
    expect(fields).toEqual([]);
  });

  it('parses multi-line Meta.fields list with extra Meta attributes and TypedField siblings', () => {
    const src = [
      'class InstitutionStakeholderType(DjangoObjectType):',
      '    class Meta:',
      '        model = InstitutionStakeholder',
      '        fields = [',
      '            "id",',
      '            "is_company_itself",',
      '            "name",',
      '            "registration_number",',
      '            "base_address",',
      '        ]',
      '        interfaces = (StakeholderType,)',
      '',
      '    managers = TypedField(list[InstitutionStakeholderManagerType])',
    ];
    const fields = parseClassFields(src, 0, '/u.py', EMPTY_IMPORTS);
    expect(fields.map((f) => f.name)).toEqual([
      'id', 'is_company_itself', 'name', 'registration_number', 'base_address',
      'managers',
    ]);
    const managers = fields.find((f) => f.name === 'managers')!;
    expect(managers.fieldType).toBe('List');
    expect(managers.resolvedType).toBe('InstitutionStakeholderManagerType');
  });

  it('parses multi-line Meta.fields tuple syntax', () => {
    const src = [
      'class T(DjangoObjectType):',
      '    class Meta:',
      '        fields = (',
      '            "a",',
      '            "b",',
      '            "c",',
      '        )',
    ];
    const fields = parseClassFields(src, 0, '/u.py', EMPTY_IMPORTS);
    expect(fields.map((f) => f.name)).toEqual(['a', 'b', 'c']);
  });

  it('does not confuse a top-level `class Meta:` (sibling) with a nested one', () => {
    // Two sibling classes; UserType has no Meta. Meta is a peer class.
    const src = [
      'class UserType(DjangoObjectType):',
      '    display_name = String()',
      '',
      'class Meta:',
      '    fields = ["id", "name"]',
    ];
    const fields = parseClassFields(src, 0, '/u.py', {
      fromGraphene: new Set(['String']),
      fromGrapheneDjango: new Set(['DjangoObjectType']),
      hasGrapheneImport: true,
    });
    // Only the explicit display_name — the peer `class Meta:` must not leak fields in.
    expect(fields.map((f) => f.name)).toEqual(['display_name']);
  });
});

describe('parseGrapheneSchemas — Meta.fields end-to-end (scenario 3)', () => {
  it('surfaces Meta.fields through the full pipeline', async () => {
    __setMockFiles({
      '/proj/app/types.py': [
        'from graphene import ObjectType, Field, Schema, String',
        'from graphene_django import DjangoObjectType',
        '',
        'class UserType(DjangoObjectType):',
        '    class Meta:',
        '        model = User',
        '        fields = ["id", "name", "email"]',
        '',
        '    display_name = String()',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });
    const schemas = await parseGrapheneSchemas('/proj');
    const user = findClass(schemas, 'UserType');
    expect(user, 'UserType should be discovered').toBeDefined();
    const names = user!.fields.map((f) => f.name).sort();
    expect(names).toEqual(['display_name', 'email', 'id', 'name']);
  });
});
