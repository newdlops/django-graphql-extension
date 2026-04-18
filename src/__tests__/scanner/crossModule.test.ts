// Scenario 2: cross-module type references.
//
// Graphene codebases commonly use `lambda: 'CompanyType'` (string literal inside
// a lambda) to avoid import cycles between modules. The scanner must resolve
// this to the real CompanyType defined in a sibling module.

import { describe, it, expect, beforeEach } from 'vitest';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';
import { parseGrapheneSchemas, extractResolvedType } from '../../scanner/grapheneParser';
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

describe('extractResolvedType — lambda variants (scenario 2 unit)', () => {
  it('handles lambda: PlainType', () => {
    expect(extractResolvedType(['x = Field(lambda: CompanyType)'], 0, 'Field')).toBe('CompanyType');
  });

  it("handles lambda: 'StringType'", () => {
    expect(extractResolvedType(["x = Field(lambda: 'CompanyType')"], 0, 'Field')).toBe('CompanyType');
  });

  it('handles lambda: "DoubleQuotedType"', () => {
    expect(extractResolvedType(['x = Field(lambda: "CompanyType")'], 0, 'Field')).toBe('CompanyType');
  });

  it('handles lambda: graphene.PrefixedType', () => {
    // Rare, but be forgiving.
    expect(extractResolvedType(['x = Field(lambda: graphene.CompanyType)'], 0, 'Field')).toBe('CompanyType');
  });

  it('handles lambda wrapping List/NonNull: lambda: List(CompanyType)', () => {
    expect(extractResolvedType(['x = Field(lambda: List(CompanyType))'], 0, 'Field')).toBe('CompanyType');
  });
});

describe('parseGrapheneSchemas — cross-module lambda reference (scenario 2 E2E)', () => {
  it('resolves lambda: "CompanyType" across module boundaries', async () => {
    __setMockFiles({
      '/proj/user/types.py': [
        'from graphene import ObjectType, Field, String',
        '',
        'class UserType(ObjectType):',
        '    name = String()',
        "    company = Field(lambda: 'CompanyType')",
      ].join('\n'),
      '/proj/company/types.py': [
        'from graphene import ObjectType, String, Schema, Field',
        '',
        'class CompanyType(ObjectType):',
        '    name = String()',
        '    address = String()',
      ].join('\n'),
      '/proj/schema.py': [
        'from graphene import ObjectType, Schema, Field',
        'from user.types import UserType',
        '',
        'class Query(ObjectType):',
        '    user = Field(UserType)',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');
    const user = findClass(schemas, 'UserType');
    expect(user, 'UserType must be discovered').toBeDefined();

    const companyField = user!.fields.find((f) => f.name === 'company');
    expect(companyField).toBeDefined();
    expect(companyField!.resolvedType).toBe('CompanyType');

    // And CompanyType itself must be in the schema, reachable through user.company.
    const company = findClass(schemas, 'CompanyType');
    expect(company, 'CompanyType must be reachable through user.company').toBeDefined();
    expect(company!.fields.map((f) => f.name).sort()).toEqual(['address', 'name']);
  });
});
