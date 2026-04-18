// Scenario 14: InputObjectType discovery + unwrapping graphene.Argument(X) in field args.

import { describe, it, expect, beforeEach } from 'vitest';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';
import {
  parseGrapheneSchemas,
  parseFieldArgs,
  parseClassFields,
  EMPTY_IMPORTS,
} from '../../scanner/grapheneParser';
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

describe('parseFieldArgs — Argument() unwrapping (scenario 14 unit)', () => {
  it('unwraps graphene.Argument(X) to type X', () => {
    const lines = ['users = Field(UserType, filter=graphene.Argument(UserFilterInput))'];
    const args = parseFieldArgs(lines, 0);
    const filter = args.find((a) => a.name === 'filter');
    expect(filter).toBeDefined();
    expect(filter!.type).toBe('UserFilterInput');
    expect(filter!.required).toBe(false);
  });

  it('picks up required=True inside Argument()', () => {
    const lines = ['users = Field(UserType, filter=graphene.Argument(UserFilterInput, required=True))'];
    const args = parseFieldArgs(lines, 0);
    const filter = args.find((a) => a.name === 'filter');
    expect(filter!.type).toBe('UserFilterInput');
    expect(filter!.required).toBe(true);
  });

  it('retains scalar arg behavior for plain graphene.Int(required=True)', () => {
    const lines = ['user = Field(UserType, id=graphene.Int(required=True))'];
    const args = parseFieldArgs(lines, 0);
    const idArg = args.find((a) => a.name === 'id');
    expect(idArg).toEqual({ name: 'id', type: 'Int', required: true });
  });

  it('handles bare Argument(X) without the graphene. prefix', () => {
    const lines = ['users = Field(UserType, filter=Argument(UserFilterInput))'];
    const args = parseFieldArgs(lines, 0);
    expect(args.find((a) => a.name === 'filter')!.type).toBe('UserFilterInput');
  });

  it('does not touch non-argument kwargs like description or default_value', () => {
    const lines = ['name = graphene.String(description="the user name", default_value="")'];
    const args = parseFieldArgs(lines, 0);
    expect(args).toEqual([]);
  });

  // Phase (l): positional forms inside Argument()
  it('unwraps positional Argument(Int, required=True) into Int with required=true', () => {
    const lines = ['user = Field(UserType, id=graphene.Argument(Int, required=True))'];
    const args = parseFieldArgs(lines, 0);
    const idArg = args.find((a) => a.name === 'id');
    expect(idArg).toEqual({ name: 'id', type: 'Int', required: true });
  });

  it('unwraps positional Argument(CustomInputType) with required flag via keyword', () => {
    const lines = ['users = Field(UserType, filter=Argument(UserFilterInput, required=True))'];
    const args = parseFieldArgs(lines, 0);
    const filter = args.find((a) => a.name === 'filter');
    expect(filter).toEqual({ name: 'filter', type: 'UserFilterInput', required: true });
  });

  it('does not accidentally mark Int() as required when a sibling arg has required=True', () => {
    // Regression guard for the old required-check that scanned beyond the
    // current arg's own closing paren.
    const lines = ['user = Field(UserType, id=Int(), filter=Argument(UserFilterInput, required=True))'];
    const args = parseFieldArgs(lines, 0);
    const idArg = args.find((a) => a.name === 'id');
    const filter = args.find((a) => a.name === 'filter');
    expect(idArg!.required).toBe(false);
    expect(filter!.required).toBe(true);
  });
});

describe('parseClassFields — InputObjectType fields', () => {
  it('extracts fields from an InputObjectType', () => {
    const src = [
      'class UserFilterInput(InputObjectType):',
      '    name = graphene.String()',
      '    age = graphene.Int()',
    ];
    const fields = parseClassFields(src, 0, '/f.py', {
      ...EMPTY_IMPORTS,
      fromGraphene: new Set(['InputObjectType']),
    });
    expect(fields.map((f) => f.name)).toEqual(['name', 'age']);
  });
});

describe('parseGrapheneSchemas — InputObjectType integration (scenario 14 E2E)', () => {
  it('discovers the InputObjectType and exposes it via Argument() arg on Query', async () => {
    __setMockFiles({
      '/proj/schema.py': [
        'from graphene import ObjectType, InputObjectType, Field, Argument, String, Int, Schema',
        '',
        'class UserFilterInput(InputObjectType):',
        '    name = String()',
        '    age = Int()',
        '',
        'class UserType(ObjectType):',
        '    id = Int()',
        '    name = String()',
        '',
        'class Query(ObjectType):',
        '    users = Field(UserType, filter=Argument(UserFilterInput))',
        '',
        'schema = Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/proj');

    // InputObjectType discovered (reachable because it is used as an argument
    // type of a Query field).
    const filterInput = findClass(schemas, 'UserFilterInput');
    expect(filterInput, 'UserFilterInput must be discovered').toBeDefined();
    expect(filterInput!.fields.map((f) => f.name).sort()).toEqual(['age', 'name']);

    // Query.users.filter argument type must resolve to UserFilterInput, not Argument.
    const query = findClass(schemas, 'Query');
    const usersField = query!.fields.find((f) => f.name === 'users');
    expect(usersField).toBeDefined();
    const filterArg = usersField!.args?.find((a) => a.name === 'filter');
    expect(filterArg).toBeDefined();
    expect(filterArg!.type).toBe('UserFilterInput');
  });
});
