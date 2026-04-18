// Phase (ε): partial fallback — when the backend return type isn't indexed,
// build a QueryStructure from the gql selection alone so the user still sees
// their query reflected in the inspector.

import { describe, it, expect } from 'vitest';
import { buildPartialStructureFromGql } from '../../analysis/queryStructure';
import { parseGqlFields } from '../../codelens/gqlCodeLensProvider';

describe('buildPartialStructureFromGql (phase ε)', () => {
  it('echoes the user gql as the structure with typeLabel `?`', () => {
    const gf = parseGqlFields('query { rtccEmailList { pageInfo { count } objectList { id } } }')[0];
    const s = buildPartialStructureFromGql(gf);
    expect(s.rootField.displayName).toBe('rtccEmailList');
    expect(s.rootField.typeLabel).toBe('?');
    // queried count = total count (all fields come from the user's selection)
    expect(s.queriedCount).toBe(s.totalCount);
    expect(s.totalCount).toBe(4); // pageInfo, count, objectList, id
  });

  it('passes through a resolvedTypeName hint as the root label', () => {
    const gf = parseGqlFields('query { foo { bar } }')[0];
    const s = buildPartialStructureFromGql(gf, {
      className: 'FooQuery',
      fieldName: 'foo',
      filePath: '/p.py',
      lineNumber: 12,
      resolvedTypeName: 'FooResult',
    });
    expect(s.rootField.typeLabel).toBe('FooResult');
    expect(s.rootField.resolvedType).toBe('FooResult');
    expect(s.rootField.resolvedTypeKnown).toBe(false);
    expect(s.rootField.ownerClass).toBe('FooQuery');
  });

  it('marks every node as queried=true, resolvedTypeKnown=false', () => {
    const gf = parseGqlFields('query { a { b { c } } }')[0];
    const s = buildPartialStructureFromGql(gf);
    const walk = (n: any): boolean =>
      n.queried === true && n.resolvedTypeKnown === false && n.children.every(walk);
    expect(walk(s.rootField)).toBe(true);
  });

  it('converts camelCase gql names back to snake_case for name field', () => {
    const gf = parseGqlFields('query { rtccEmailList { pageInfo { hasNext } } }')[0];
    const s = buildPartialStructureFromGql(gf);
    expect(s.rootField.name).toBe('rtcc_email_list');
    expect(s.rootField.children[0].name).toBe('page_info');
    expect(s.rootField.children[0].children[0].name).toBe('has_next');
  });

  it('works with leaf queries (no children)', () => {
    const gf = parseGqlFields('query { me }')[0];
    const s = buildPartialStructureFromGql(gf);
    expect(s.rootField.children).toEqual([]);
    expect(s.totalCount).toBe(0);
    expect(s.queriedCount).toBe(0);
  });
});
