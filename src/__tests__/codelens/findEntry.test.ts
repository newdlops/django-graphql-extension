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
});
