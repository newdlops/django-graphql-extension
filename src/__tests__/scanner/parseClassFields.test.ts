// Scenario 1: basic field parsing from a simple Graphene ObjectType.

import { describe, it, expect } from 'vitest';
import { parseClassFields, EMPTY_IMPORTS, ImportInfo } from '../../scanner/grapheneParser';

function makeImports(fromGraphene: string[] = [], fromGrapheneDjango: string[] = []): ImportInfo {
  return {
    fromGraphene: new Set(fromGraphene),
    fromGrapheneDjango: new Set(fromGrapheneDjango),
    hasGrapheneImport: fromGraphene.length > 0,
  };
}

describe('parseClassFields — scenario 1 (basic ObjectType)', () => {
  it('extracts scalar fields from a simple graphene ObjectType', () => {
    const source = [
      'import graphene',
      '',
      'class UserType(graphene.ObjectType):',
      '    name = graphene.String()',
      '    email = graphene.String()',
      '    age = graphene.Int()',
    ];
    const fields = parseClassFields(source, 2, 'user.py', makeImports(['ObjectType', 'String', 'Int']));
    const names = fields.map((f) => f.name);
    expect(names).toEqual(['name', 'email', 'age']);

    const types = fields.map((f) => f.fieldType);
    expect(types).toEqual(['String', 'String', 'Int']);
  });

  it('extracts Field() with type reference as resolvedType', () => {
    const source = [
      'class UserType(ObjectType):',
      '    company = graphene.Field(CompanyType)',
      '    profile = graphene.Field(ProfileType, required=True)',
    ];
    const fields = parseClassFields(source, 0, 'user.py', makeImports(['ObjectType', 'Field']));
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ name: 'company', fieldType: 'Field', resolvedType: 'CompanyType' });
    expect(fields[1]).toMatchObject({ name: 'profile', fieldType: 'Field', resolvedType: 'ProfileType' });
  });

  it('handles graphene.List(Type) and unwraps inner type', () => {
    const source = [
      'class UserType(ObjectType):',
      '    tags = graphene.List(TagType)',
    ];
    const fields = parseClassFields(source, 0, 'user.py', makeImports(['ObjectType', 'List']));
    expect(fields).toHaveLength(1);
    expect(fields[0].resolvedType).toBe('TagType');
  });

  it('stops at class end (dedented sibling definition)', () => {
    const source = [
      'class UserType(ObjectType):',
      '    name = graphene.String()',
      '',
      'class OtherType(ObjectType):',
      '    foo = graphene.String()',
    ];
    const fields = parseClassFields(source, 0, 'mixed.py', makeImports(['ObjectType', 'String']));
    expect(fields.map((f) => f.name)).toEqual(['name']);
  });

  it('records filePath and lineNumber on each field', () => {
    const source = [
      'class UserType(ObjectType):',
      '    name = graphene.String()',
      '    email = graphene.String()',
    ];
    const fields = parseClassFields(source, 0, '/abs/path/to/user.py', makeImports(['ObjectType', 'String']));
    expect(fields[0].filePath).toBe('/abs/path/to/user.py');
    expect(fields[0].lineNumber).toBe(1);
    expect(fields[1].lineNumber).toBe(2);
  });

  it('returns empty array when class body has no field definitions', () => {
    const source = [
      'class Empty(ObjectType):',
      '    pass',
    ];
    const fields = parseClassFields(source, 0, 'empty.py', EMPTY_IMPORTS);
    expect(fields).toEqual([]);
  });
});
