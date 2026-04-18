// Phase (γ): JSON-like tree renderer that powers the Live Query Inspector.

import { describe, it, expect } from 'vitest';
import { renderQueryStructureJsonHtml, renderJsonSubtreeHtml, QUERY_STRUCTURE_JSON_STYLES } from '../../preview/queryStructureJson';
import { buildQueryStructure, buildLazySubtree } from '../../analysis/queryStructure';
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
    expect(QUERY_STRUCTURE_JSON_STYLES).toContain('block-lazy');
  });

  it('emits a closed <details class="block-lazy"> for fields truncated at the depth cap', () => {
    const deep = cls('D', [f('leaf', 'Int')]);
    const outer = cls('O', [f('next', 'Field', { resolvedType: 'D' })]);
    const gf = parseGqlFields('query { root { next } }')[0];
    // maxDepth=1 — `next` has known resolvedType 'D' but can't expand.
    const s = buildQueryStructure(gf, outer, new Map([[outer.name, outer], [deep.name, deep]]), 1);
    const html = renderQueryStructureJsonHtml(s);

    expect(html).toContain('class="block block-lazy');
    expect(html).toContain('data-lazy-type="D"');
    // data-depth is what the shell echoes back so the server can render the
    // loaded subtree at `depth + 1`, keeping indent aligned with siblings.
    expect(html).toContain('data-depth="1"');
    // The block is initially closed so the ▸ chevron is visible.
    expect(html).not.toMatch(/<details[^>]*open[^>]*class="[^"]*block-lazy/);
    // Keeps the standard summary/brace structure — that's what makes the
    // lazy response line up visually with the surrounding tree.
    expect(html).toContain('<summary><span class="line">');
    expect(html).toContain('<div class="lazy-content">');
    // Ancestry attribute carries the root type so the server can reapply
    // the cycle guard on deeper expansions.
    expect(html).toContain('data-ancestry="O"');
  });

  it('renderJsonSubtreeHtml produces nested lazy blocks for deeper cycle points', () => {
    const a = cls('A', [f('toB', 'Field', { resolvedType: 'B' })]);
    const b = cls('B', [f('toA', 'Field', { resolvedType: 'A' })]);
    const map = new Map([[a.name, a], [b.name, b]]);

    // Caller already has A in ancestry — expand B. `toA` must come back as a
    // lazy marker because it would re-enter A.
    const nodes = buildLazySubtree(b, map, ['A']);
    const html = renderJsonSubtreeHtml(nodes, ['A', 'B'], 3);

    expect(html).toContain('class="block block-lazy');
    expect(html).toContain('data-lazy-type="A"');
    expect(html).toContain('data-ancestry="A,B"');
    // startDepth=3 must land in the indent so the new line is visually at
    // the caller's child level — not at the renderer's default.
    expect(html).toContain('indent-3');
  });

  it('renders the operation variables block in the Live Inspector template view', async () => {
    const { renderTemplateStructuresHtml } = await import('../../preview/queryStructureJson');
    const user = cls('UserType', [f('id')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderTemplateStructuresHtml({
      operationKind: 'query',
      operationName: 'RtccEmailList',
      operationVariables: [
        { name: 'companyId', type: 'ID', required: true, list: false },
        { name: 'rightToConsentOrConsultId', type: 'ID', required: true, list: false },
        { name: 'page', type: 'Int', required: false, list: false },
        { name: 'perPage', type: 'Int', required: false, list: false, defaultValue: '20' },
        { name: 'tags', type: 'String', required: false, list: true },
      ],
      structures: [{ structure: struct }],
      unresolved: [],
    });

    expect(html).toContain('class="op-variables"');
    expect(html).toContain('Variables (5)');
    expect(html).toContain('$companyId');
    expect(html).toContain('ID!');
    expect(html).toContain('$perPage');
    expect(html).toContain('= 20');
    expect(html).toContain('$tags');
    expect(html).toContain('[String]');
  });

  it('omits the op-variables block when operationVariables is empty / missing', async () => {
    const { renderTemplateStructuresHtml } = await import('../../preview/queryStructureJson');
    const user = cls('UserType', [f('id')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderTemplateStructuresHtml({
      operationKind: 'query',
      operationName: 'Q',
      operationVariables: [],
      structures: [{ structure: struct }],
      unresolved: [],
    });
    expect(html).not.toContain('op-variables');
  });

  it('does not emit lazy markup for scalar leaves', () => {
    const user = cls('UserType', [f('id', 'Int')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const s = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureJsonHtml(s);
    expect(html).not.toContain('block-lazy');
    expect(html).not.toContain('lazy-content');
  });
});
