// Scenario 15: Schema(query=Q, mutation=M, subscription=S) detection.

import { describe, it, expect } from 'vitest';
import { detectSchemaCall, parseImports } from '../../scanner/grapheneParser';

function collect(text: string): Array<{ query?: string; mutation?: string }> {
  const imports = parseImports(text);
  const out: Array<{ query?: string; mutation?: string }> = [];
  detectSchemaCall(text, imports, (q, m) => out.push({ query: q, mutation: m }));
  return out;
}

describe('detectSchemaCall — scenario 15', () => {
  it('finds graphene.Schema(query=, mutation=) with explicit namespace', () => {
    const src = [
      'import graphene',
      'from myapp.schema import Query, Mutation',
      '',
      'schema = graphene.Schema(query=Query, mutation=Mutation)',
    ].join('\n');
    const calls = collect(src);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ query: 'Query', mutation: 'Mutation' });
  });

  it('finds Schema(query=) when Schema is imported from graphene', () => {
    const src = [
      'from graphene import Schema',
      'from myapp.schema import Query',
      '',
      'schema = Schema(query=Query)',
    ].join('\n');
    const calls = collect(src);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe('Query');
    expect(calls[0].mutation).toBeUndefined();
  });

  it('ignores Schema() calls when Schema is not imported from graphene', () => {
    const src = [
      'from otherlib import Schema',
      '',
      'x = Schema(query=Query)',
    ].join('\n');
    const calls = collect(src);
    expect(calls).toHaveLength(0);
  });

  it('handles arguments in any order and with whitespace/newlines', () => {
    const src = [
      'import graphene',
      '',
      'schema = graphene.Schema(',
      '    mutation = MyMutation,',
      '    query    = MyQuery,',
      ')',
    ].join('\n');
    const calls = collect(src);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ query: 'MyQuery', mutation: 'MyMutation' });
  });

  it('produces no callbacks when no Schema() call is present', () => {
    const src = [
      'import graphene',
      '',
      'class Query(graphene.ObjectType):',
      '    hello = graphene.String()',
    ].join('\n');
    const calls = collect(src);
    expect(calls).toHaveLength(0);
  });
});
