// Phase (n): findEntry accuracy. The old implementation returned a match
// as soon as the field name was unique globally OR the parent's kind matched.
// Both rules produce wrong "→ X.field" links when the field actually belongs
// to an unrelated class. Confidence flag lets the UI warn users on guesses.

import { describe, it, expect, beforeEach } from 'vitest';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument } from 'vscode';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/f.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/f.py', lineNumber: 0, fields, kind };
}
function makeProvider(map: Map<string, ClassInfo>): GqlCodeLensProvider {
  const p = new GqlCodeLensProvider();
  p.updateIndex(map);
  p.rebuildIndexNow();
  return p;
}
function titlesOf(lenses: any[]): string[] {
  return lenses.map((l) => l.command?.title ?? '').filter(Boolean);
}

describe('findEntry — strict parent filtering (phase n)', () => {
  it('rejects a single-entry match when the field does NOT belong to the declared parent', () => {
    // CompanyType.address exists globally; StockType has no `address` field.
    // Query.stock is declared as StockType. `stock { address }` must NOT resolve.
    const companyType = cls('CompanyType', [f('address')]);
    const stockType = cls('StockType', [f('ticker')]);
    const query = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    const p = makeProvider(new Map([
      [companyType.name, companyType], [stockType.name, stockType], [query.name, query],
    ]));

    const src = 'gql`query { stock { address } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any);
    const ts = titlesOf(lenses);
    expect(ts.some((t) => t.includes('StockType.address'))).toBe(false);
    expect(ts.some((t) => t.includes('CompanyType.address'))).toBe(false);
    // Parent still resolved though
    expect(ts.some((t) => t.includes('Query.stock'))).toBe(true);
  });

  it('matches inherited fields via transitive baseClasses', () => {
    const mixin = cls('TimestampMixin', [f('created_at', 'DateTime')]);
    const userType = cls('UserType', [f('name')], 'type', ['TimestampMixin']);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const p = makeProvider(new Map([
      [mixin.name, mixin], [userType.name, userType], [query.name, query],
    ]));

    const src = 'gql`query { user { createdAt } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any);
    const ts = titlesOf(lenses);
    expect(ts.some((t) => t.includes('TimestampMixin.created_at'))).toBe(true);
  });

  it('scopes root-level lookup to the operation kind', () => {
    // Both Query and Mutation expose a field named `user`.
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const mut = cls('Mutation', [f('user', 'Field', { resolvedType: 'UserType' })], 'mutation');
    const p = makeProvider(new Map([
      [userType.name, userType], [query.name, query], [mut.name, mut],
    ]));

    const src = 'gql`query { user { id } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any);
    const ts = titlesOf(lenses);
    const userLens = ts.find((t) => t.includes('.user'));
    expect(userLens).toBeDefined();
    expect(userLens).toBe('→ Query.user [Query]');
    expect(userLens!.includes('~')).toBe(false);
  });

  it('does not resolve a root-level field from a regular object type', () => {
    const profileType = cls('ProfileType', [f('id')]);
    const userType = cls('UserType', [f('profile', 'Field', { resolvedType: 'ProfileType' })]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const p = makeProvider(new Map([
      [profileType.name, profileType], [userType.name, userType], [query.name, query],
    ]));

    const src = 'gql`query { profile { id } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any);
    const ts = titlesOf(lenses);
    expect(ts.some((t) => t.includes('UserType.profile'))).toBe(false);
    expect(ts.some((t) => t.includes('ProfileType.id'))).toBe(false);
  });

  it('does NOT add the ~ marker for unambiguous exact matches', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const p = makeProvider(new Map([[userType.name, userType], [query.name, query]]));

    const src = 'gql`query { user { id } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any);
    const ts = titlesOf(lenses);
    for (const t of ts) expect(t.includes('~')).toBe(false);
  });

  it('does not pick a same-kind class as a last-resort (old sameKind heuristic dropped)', () => {
    // AccountType and CompanyType both have a `name` field. Parent is StockType
    // which has neither. Must not guess via "same kind=type" heuristic.
    const accountType = cls('AccountType', [f('name')]);
    const companyType = cls('CompanyType', [f('name')]);
    const stockType = cls('StockType', [f('ticker')]);
    const query = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    const p = makeProvider(new Map([
      [accountType.name, accountType], [companyType.name, companyType],
      [stockType.name, stockType], [query.name, query],
    ]));

    const src = 'gql`query { stock { name } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any);
    const ts = titlesOf(lenses);
    expect(ts.some((t) => t.includes('AccountType.name'))).toBe(false);
    expect(ts.some((t) => t.includes('CompanyType.name'))).toBe(false);
  });

  it('only treats explicitly marked schema containers as operation roots', () => {
    // Scanner output intentionally groups reachable return types and mixins as
    // `query`, and mutation payloads as `mutation`, for the explorer UI.  They
    // are not valid top-level operation containers.
    const userType = cls('UserType', [f('name')], 'query');
    const createUser = cls('CreateUser', [f('ok')], 'mutation');
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    query.isSchemaRoot = true;
    const mutation = cls('Mutation', [f('create_user', 'Field', { resolvedType: 'CreateUser' })], 'mutation');
    mutation.isSchemaRoot = true;
    const p = makeProvider(new Map([
      [userType.name, userType], [createUser.name, createUser],
      [query.name, query], [mutation.name, mutation],
    ]));

    const src = [
      'gql`query { name }`;',
      'gql`mutation { ok }`;',
    ].join('\n');
    const ts = titlesOf(p.provideCodeLenses(new TextDocument(src) as any));
    expect(ts.some((t) => t.includes('UserType.name'))).toBe(false);
    expect(ts.some((t) => t.includes('CreateUser.ok'))).toBe(false);
  });

  it('keeps fields from marked root mixins eligible without admitting return types', () => {
    const mixin = cls('AccountQueries', [f('account')], 'query');
    mixin.isSchemaRootContributor = true;
    const query = cls('Query', [], 'query', ['AccountQueries']);
    query.isSchemaRoot = true;
    const returned = cls('AccountType', [f('display_name')], 'query');
    const p = makeProvider(new Map([
      [mixin.name, mixin], [query.name, query], [returned.name, returned],
    ]));

    const valid = titlesOf(p.provideCodeLenses(new TextDocument('gql`query { account }`;') as any));
    expect(valid).toContain('→ AccountQueries.account [Query]');

    const invalid = titlesOf(p.provideCodeLenses(new TextDocument('gql`query { displayName }`;') as any));
    expect(invalid.some((t) => t.includes('AccountType.display_name'))).toBe(false);
  });

  it('matches an exact SDL/Ariadne wire name before snake_case fallback', () => {
    const userType = cls('UserType', [f('displayName', 'String', { graphqlName: 'displayName' })]);
    const query = cls('Query', [
      f('userById', 'UserType', { graphqlName: 'userById', resolvedType: 'UserType' }),
    ], 'query');
    query.isSchemaRoot = true;
    const p = makeProvider(new Map([[userType.name, userType], [query.name, query]]));

    const ts = titlesOf(p.provideCodeLenses(
      new TextDocument('gql`query { userById { displayName } }`;') as any,
    ));
    expect(ts).toContain('→ Query.userById [Query]');
    expect(ts).toContain('→ UserType.displayName [Type]');
  });

  it('does not expose a Python source name replaced by a GraphQL name override', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [
      f('user_by_pk', 'Field', { graphqlName: 'user', resolvedType: 'UserType' }),
    ], 'query');
    query.isSchemaRoot = true;
    const p = makeProvider(new Map([[userType.name, userType], [query.name, query]]));

    const valid = titlesOf(p.provideCodeLenses(new TextDocument('gql`query { user { id } }`;') as any));
    expect(valid).toContain('→ Query.user_by_pk [Query]');

    const invalid = titlesOf(p.provideCodeLenses(new TextDocument('gql`query { userByPk { id } }`;') as any));
    expect(invalid.some((t) => t.includes('Query.user_by_pk'))).toBe(false);
  });

  it('routes fields inside fragment conditions to the conditioned backend type', () => {
    const nodeType = cls('NodeType', [f('id')]);
    const userType = cls('UserType', [f('email')]);
    const query = cls('Query', [f('node', 'Field', { resolvedType: 'NodeType' })], 'query');
    query.isSchemaRoot = true;
    const p = makeProvider(new Map([
      [nodeType.name, nodeType], [userType.name, userType], [query.name, query],
    ]));

    const ts = titlesOf(p.provideCodeLenses(
      new TextDocument('gql`query { node { id ... on UserType { email } } }`;') as any,
    ));
    expect(ts).toContain('→ UserType.email [Type]');
    expect(ts.some((t) => t.includes('NodeType.email'))).toBe(false);
  });
});
