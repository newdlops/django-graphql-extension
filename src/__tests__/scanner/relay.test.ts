// Scenario 12: Relay Connection/Edge/node pattern.
//
// Given a `class FooConnection(relay.Connection): class Meta: node = FooType`,
// the scanner must expose StockConnection.edges → Edge type with node → FooType
// so frontend queries like `foo { edges { node { id } } }` resolve cleanly.

import { describe, it, expect, beforeEach } from 'vitest';
import { __setMockFiles, __clearMockFiles } from '../__mocks__/vscode';
import { parseGrapheneSchemas } from '../../scanner/grapheneParser';
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

const RELAY_FIXTURE = [
  'from graphene import ObjectType, Field, Schema',
  'from graphene import relay',
  '',
  'class StockType(ObjectType):',
  '    id = graphene.ID()',
  '    name = graphene.String()',
  '    price = graphene.Float()',
  '',
  'class StockConnection(relay.Connection):',
  '    class Meta:',
  '        node = StockType',
  '',
  'class Query(ObjectType):',
  '    stocks = Field(StockConnection)',
  '',
  'schema = Schema(query=Query)',
].join('\n');

describe('parseGrapheneSchemas — scenario 12 (Relay)', () => {
  it('discovers the Connection class as a graphene type', async () => {
    __setMockFiles({ '/proj/types.py': RELAY_FIXTURE });
    const schemas = await parseGrapheneSchemas('/proj');
    const conn = findClass(schemas, 'StockConnection');
    expect(conn, 'StockConnection should be discovered').toBeDefined();
  });

  it('synthesizes an `edges` field on the Connection class', async () => {
    __setMockFiles({ '/proj/types.py': RELAY_FIXTURE });
    const schemas = await parseGrapheneSchemas('/proj');
    const conn = findClass(schemas, 'StockConnection');
    const edges = conn!.fields.find((f) => f.name === 'edges');
    expect(edges, 'Connection must have an edges field').toBeDefined();
    expect(edges!.resolvedType).toBeDefined();
  });

  it('synthesizes an `Edge` type that has a `node` field pointing to the Node type', async () => {
    __setMockFiles({ '/proj/types.py': RELAY_FIXTURE });
    const schemas = await parseGrapheneSchemas('/proj');
    const conn = findClass(schemas, 'StockConnection');
    const edgeTypeName = conn!.fields.find((f) => f.name === 'edges')!.resolvedType!;

    const edgeCls = findClass(schemas, edgeTypeName);
    expect(edgeCls, `Edge class ${edgeTypeName} should exist`).toBeDefined();

    const nodeField = edgeCls!.fields.find((f) => f.name === 'node');
    expect(nodeField, 'Edge must have a node field').toBeDefined();
    expect(nodeField!.resolvedType).toBe('StockType');
  });

  it('synthesizes a `PageInfo` type with the standard fields', async () => {
    __setMockFiles({ '/proj/types.py': RELAY_FIXTURE });
    const schemas = await parseGrapheneSchemas('/proj');
    const conn = findClass(schemas, 'StockConnection');
    const pageInfoField = conn!.fields.find((f) => f.name === 'page_info' || f.name === 'pageInfo');
    expect(pageInfoField, 'Connection must have a page_info field').toBeDefined();

    const pageInfo = findClass(schemas, 'PageInfo');
    expect(pageInfo, 'PageInfo class must be synthesized').toBeDefined();
    const pageInfoFieldNames = pageInfo!.fields.map((f) => f.name).sort();
    expect(pageInfoFieldNames).toEqual(['end_cursor', 'has_next_page', 'has_previous_page', 'start_cursor']);
  });

  it('allows the full traversal stocks → edges → node → StockType statically', async () => {
    __setMockFiles({ '/proj/types.py': RELAY_FIXTURE });
    const schemas = await parseGrapheneSchemas('/proj');

    const query = findClass(schemas, 'Query');
    const stocksField = query!.fields.find((f) => f.name === 'stocks');
    expect(stocksField!.resolvedType).toBe('StockConnection');

    const conn = findClass(schemas, 'StockConnection');
    const edges = conn!.fields.find((f) => f.name === 'edges')!;

    const edgeCls = findClass(schemas, edges.resolvedType!);
    const node = edgeCls!.fields.find((f) => f.name === 'node')!;
    expect(node.resolvedType).toBe('StockType');

    const stock = findClass(schemas, node.resolvedType!);
    expect(stock!.fields.map((f) => f.name).sort()).toEqual(['id', 'name', 'price']);
  });
});
