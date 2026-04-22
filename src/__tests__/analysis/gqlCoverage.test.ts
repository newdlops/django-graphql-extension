// Phase (q): gql coverage — which fields of which classes are actually
// queried by active gql templates.

import { describe, it, expect } from 'vitest';
import { computeQueryCoverage, extractGqlBodies } from '../../analysis/gqlCoverage';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p/a.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/p/a.py', lineNumber: 0, fields, kind };
}

describe('computeQueryCoverage (phase q)', () => {
  it('records root-level fields against the Query class', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const classMap = new Map([[userType.name, userType], [query.name, query]]);

    const cov = computeQueryCoverage(
      ['query { user { id } }'],
      { classMap, schemaRoots: [query] },
    );
    expect(cov.get('Query')).toEqual(new Set(['user']));
    expect(cov.get('UserType')).toEqual(new Set(['id']));
  });

  it('records inherited fields against BOTH the subclass and the mixin owner', () => {
    const mixin = cls('TimestampMixin', [f('created_at', 'DateTime')]);
    const userType = cls('UserType', [f('id')], 'type', ['TimestampMixin']);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const classMap = new Map([[mixin.name, mixin], [userType.name, userType], [query.name, query]]);

    const cov = computeQueryCoverage(
      ['query { user { createdAt } }'],
      { classMap, schemaRoots: [query] },
    );
    expect(cov.get('UserType')).toEqual(new Set(['created_at']));
    expect(cov.get('TimestampMixin')).toEqual(new Set(['created_at']));
  });

  it('does NOT recurse into children when the child type is unknown (mirrors CodeLens rule)', () => {
    // StockType.company references an unknown CompanyType. Frontend query
    // tries to read address on it — should not crash or spuriously record.
    const stockType = cls('StockType', [f('address'), f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const query = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    const classMap = new Map([[stockType.name, stockType], [query.name, query]]);

    const cov = computeQueryCoverage(
      ['query { stock { company { address } } }'],
      { classMap, schemaRoots: [query] },
    );
    expect(cov.get('StockType')).toEqual(new Set(['company']));
    // `address` is NOT recorded against StockType even though StockType has an
    // address field — the lookup was scoped to CompanyType (unknown).
    expect(cov.get('StockType')!.has('address')).toBe(false);
  });

  it('merges coverage across multiple gql templates', () => {
    const userType = cls('UserType', [f('id'), f('name'), f('email')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const classMap = new Map([[userType.name, userType], [query.name, query]]);

    const cov = computeQueryCoverage(
      [
        'query A { user { id } }',
        'query B { user { name } }',
      ],
      { classMap, schemaRoots: [query] },
    );
    expect(cov.get('UserType')).toEqual(new Set(['id', 'name']));
  });

  it('handles camelCase frontend names by converting to snake_case backend', () => {
    const userType = cls('UserType', [f('first_name'), f('last_name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const classMap = new Map([[userType.name, userType], [query.name, query]]);

    const cov = computeQueryCoverage(
      ['query { user { firstName lastName } }'],
      { classMap, schemaRoots: [query] },
    );
    expect(cov.get('UserType')).toEqual(new Set(['first_name', 'last_name']));
  });

  it('reuses provider field-name inference when child resolvedType is missing', () => {
    const investorType = cls('InvestorType', [f('id')]);
    const query = cls('Query', [f('investors', 'Field')], 'query');
    const classMap = new Map([[investorType.name, investorType], [query.name, query]]);

    const cov = computeQueryCoverage(
      ['query { investors { id } }'],
      { classMap, schemaRoots: [query] },
    );
    expect(cov.get('Query')).toEqual(new Set(['investors']));
    expect(cov.get('InvestorType')).toEqual(new Set(['id']));
  });

  it('returns an empty map for gql bodies with no known roots', () => {
    const cov = computeQueryCoverage(
      ['query { unknownField { blah } }'],
      { classMap: new Map(), schemaRoots: [] },
    );
    expect(cov.size).toBe(0);
  });

  it('skips fragment definitions gracefully', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const classMap = new Map([[userType.name, userType], [query.name, query]]);

    const cov = computeQueryCoverage(
      [
        'fragment UserFields on User { id name }',       // fragment — no operation
        'query { user { id } }',
      ],
      { classMap, schemaRoots: [query] },
    );
    // Only the query contributes coverage.
    expect(cov.get('UserType')).toEqual(new Set(['id']));
  });
});

describe('extractGqlBodies (phase q)', () => {
  it('finds gql-tagged templates', () => {
    const src = [
      "const q = gql`query { user { id } }`;",
      "const m = graphql`mutation { createUser { id } }`;",
    ].join('\n');
    const bodies = extractGqlBodies(src);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('query { user { id } }');
    expect(bodies[1]).toContain('createUser');
  });

  it('finds /* GraphQL */ literal comments', () => {
    const src = 'const q = /* GraphQL */ `query { me { id } }`;';
    const bodies = extractGqlBodies(src);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('me');
  });

  it('returns [] for files without gql templates', () => {
    expect(extractGqlBodies('const x = 42;')).toEqual([]);
  });

  it('replaces ${...} interpolations with whitespace to preserve offsets', () => {
    const src = 'const q = gql`query { ${fragment} user { id } }`;';
    const bodies = extractGqlBodies(src);
    expect(bodies).toHaveLength(1);
    // The interpolation should NOT leak into the extracted body
    expect(bodies[0]).not.toContain('${fragment}');
    // But the length should be preserved so offsets line up with the source
    expect(bodies[0]).toContain('query {');
    expect(bodies[0]).toContain('user { id }');
  });
});
