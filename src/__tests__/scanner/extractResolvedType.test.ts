// Scenario 5: unwrap nested graphene.NonNull / graphene.List so resolvedType
// ends up pointing at the real payload type.

import { describe, it, expect } from 'vitest';
import { extractResolvedType, parseClassFields, EMPTY_IMPORTS } from '../../scanner/grapheneParser';

function call(fieldLine: string, head: string): string | undefined {
  // head is the outermost graphene callable, e.g. 'NonNull' or 'List' or 'Field'.
  return extractResolvedType([fieldLine], 0, head);
}

describe('extractResolvedType — direct (scenario 5)', () => {
  it('unwraps List(X)', () => {
    expect(call('stocks = graphene.List(StockType)', 'List')).toBe('StockType');
  });

  it('unwraps NonNull(X)', () => {
    expect(call('stock = graphene.NonNull(StockType)', 'NonNull')).toBe('StockType');
  });

  it('unwraps NonNull(List(X))', () => {
    expect(call('stocks = graphene.NonNull(graphene.List(StockType))', 'NonNull')).toBe('StockType');
  });

  it('unwraps List(NonNull(X))', () => {
    expect(call('stocks = graphene.List(graphene.NonNull(StockType))', 'List')).toBe('StockType');
  });

  it('unwraps triple wrap NonNull(List(NonNull(X)))', () => {
    expect(call(
      'stocks = graphene.NonNull(graphene.List(graphene.NonNull(StockType)))',
      'NonNull',
    )).toBe('StockType');
  });

  it('works without graphene. prefix', () => {
    expect(call('stocks = NonNull(List(StockType))', 'NonNull')).toBe('StockType');
  });

  it('unwraps string literal references: List("StockType")', () => {
    expect(call("stocks = graphene.List('StockType')", 'List')).toBe('StockType');
  });

  it('unwraps lambda references: Field(lambda: StockType)', () => {
    expect(call('stock = graphene.Field(lambda: StockType)', 'Field')).toBe('StockType');
  });

  it('ignores keyword args that come before the positional payload', () => {
    // graphene disallows this ordering, but be defensive
    expect(call('stock = graphene.Field(StockType, required=True)', 'Field')).toBe('StockType');
  });

  it('returns undefined when no type arg is present', () => {
    expect(call('name = graphene.String()', 'String')).toBeUndefined();
  });
});

describe('parseClassFields records unwrapped resolvedType (scenario 5 integration)', () => {
  it('fully unwraps nested wrappers when reading a class body', () => {
    const src = [
      'class UserType(ObjectType):',
      '    tags = graphene.NonNull(graphene.List(graphene.NonNull(TagType)))',
    ];
    const fields = parseClassFields(src, 0, '/u.py', {
      ...EMPTY_IMPORTS,
      fromGraphene: new Set(['ObjectType', 'List', 'NonNull']),
    });
    expect(fields).toHaveLength(1);
    expect(fields[0].resolvedType).toBe('TagType');
  });
});
