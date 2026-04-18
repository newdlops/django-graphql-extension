// Phase (γ): JSON-like tree renderer that powers the Live Query Inspector.

import { describe, it, expect } from 'vitest';
import { renderQueryStructureJsonHtml, QUERY_STRUCTURE_JSON_STYLES } from '../../preview/queryStructureJson';
import { buildQueryStructure } from '../../analysis/queryStructure';
import { parseGqlFields } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type'): ClassInfo {
  return { name, baseClasses: [], framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}

describe('renderQueryStructureJsonHtml (phase γ)', () => {
  it('emits a summary with queried/missing counts', () => {
    const user = cls('UserType', [f('id'), f('name'), f('email')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const s = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureJsonHtml(s);
    expect(html).toContain('✓ 1 queried');
    expect(html).toContain('✗ 2 missing');
    expect(html).toContain('of 3 total fields');
  });

  it('renders the root as a collapsible <details> block with the type label', () => {
    const user = cls('UserType', [f('id')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const s = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureJsonHtml(s);
    expect(html).toMatch(/<details open class="block block-root">/);
    expect(html).toContain('UserType');
    expect(html).toContain('<span class="brace">{</span>');
    expect(html).toContain('<span class="brace">}</span>');
  });

  it('marks queried vs missing fields with distinct classes', () => {
    const user = cls('UserType', [f('id'), f('name')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const s = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureJsonHtml(s);
    expect(html).toMatch(/key-queried[^>]*>id</);
    expect(html).toMatch(/key-missing[^>]*>name</);
  });

  it('nests <details> blocks for object-valued fields', () => {
    const address = cls('AddressType', [f('street'), f('city')]);
    const user = cls('UserType', [f('address', 'Field', { resolvedType: 'AddressType' })]);
    const gf = parseGqlFields('query { user { address { street } } }')[0];
    const s = buildQueryStructure(gf, user, new Map([[user.name, user], [address.name, address]]));
    const html = renderQueryStructureJsonHtml(s);

    // Outer block for root + inner block for `address` — two <details>.
    const openCount = (html.match(/<details/g) || []).length;
    expect(openCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('street');
    expect(html).toContain('city');
  });

  it('uses [{ }] brackets for List-typed fields', () => {
    const edge = cls('StockEdge', [f('node', 'Field', { resolvedType: 'StockType' })]);
    const stock = cls('StockType', [f('id')]);
    const conn = cls('StockConnection', [
      f('edges', 'List', { resolvedType: 'StockEdge' }),
    ]);
    const map = new Map([[edge.name, edge], [stock.name, stock], [conn.name, conn]]);

    const gf = parseGqlFields('query { stocks { edges { node { id } } } }')[0];
    const s = buildQueryStructure(gf, conn, map);
    const html = renderQueryStructureJsonHtml(s);
    // List-typed `edges` gets `[{` and `}]` braces.
    expect(html).toContain('<span class="brace">[{</span>');
    expect(html).toContain('<span class="brace">}]</span>');
  });

  it('renders arguments inline with required indicator', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [
      f('user', 'Field', {
        resolvedType: 'UserType',
        args: [
          { name: 'id', type: 'Int', required: true },
          { name: 'include_deleted', type: 'Boolean', required: false },
        ],
      }),
    ], 'query');
    const gf = parseGqlFields('query { user(id: 1) { id } }')[0];
    const s = buildQueryStructure(gf, query, new Map([[userType.name, userType], [query.name, query]]));
    const html = renderQueryStructureJsonHtml(s);

    expect(html).toContain('id: <span class="arg-type">Int!');
    expect(html).toContain('includeDeleted: <span class="arg-type">Boolean');
    expect(html).toContain('arg-req');
  });

  it('marks an unknown resolved type as .type-unknown', () => {
    const user = cls('UserType', [f('company', 'Field', { resolvedType: 'ExternalType' })]);
    const gf = parseGqlFields('query { user { company } }')[0];
    const s = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureJsonHtml(s);
    expect(html).toContain('type-unknown');
    expect(html).toContain('ExternalType');
  });

  it('exports shared styles as a stable string', () => {
    expect(QUERY_STRUCTURE_JSON_STYLES).toContain('.json-tree');
    expect(QUERY_STRUCTURE_JSON_STYLES).toContain('.key-queried');
    expect(QUERY_STRUCTURE_JSON_STYLES).toContain('.key-missing');
  });
});
