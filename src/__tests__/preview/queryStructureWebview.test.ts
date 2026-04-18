// Phase (y): renderQueryStructureHtml — visual structure of the Missing Fields view.
// We test the HTML contents at the string level — good enough to guarantee the
// color-coded rows, argument listings, and summary pill land where expected.

import { describe, it, expect } from 'vitest';
import { renderQueryStructureHtml, renderSubtreeNodesHtml } from '../../preview/queryStructureWebview';
import { buildQueryStructure, buildLazySubtree } from '../../analysis/queryStructure';
import { parseGqlFields, hydrateGqlField, serializeGqlField } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type'): ClassInfo {
  return { name, baseClasses: [], framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}

describe('renderQueryStructureHtml (phase y)', () => {
  it('renders a summary with queried and missing counts', () => {
    const user = cls('UserType', [f('id'), f('name'), f('email'), f('created_at', 'DateTime')]);
    const gf = parseGqlFields('query { user { id name } }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureHtml(struct);

    expect(html).toContain('✓ 2 queried');
    expect(html).toContain('✗ 2 missing');
    expect(html).toContain('of 4 total fields');
    expect(html).toContain('UserType');
  });

  it('tags queried rows with .queried and missing rows with .missing', () => {
    const user = cls('UserType', [f('id'), f('name')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureHtml(struct);

    // id is queried — row should have "queried" class
    expect(html).toMatch(/row[^"]*queried[^"]*"[^>]*>[\s\S]*?id\b/);
    // name is missing — row should have "missing" class
    expect(html).toMatch(/row[^"]*missing[^"]*"[^>]*>[\s\S]*?name\b/);
  });

  it('expands nested types recursively so a missing branch still shows its subfields', () => {
    const address = cls('AddressType', [f('street'), f('city')]);
    const user = cls('UserType', [f('id'), f('address', 'Field', { resolvedType: 'AddressType' })]);
    const map = new Map([[user.name, user], [address.name, address]]);

    const gf = parseGqlFields('query { user { id } }')[0];
    const struct = buildQueryStructure(gf, user, map);
    const html = renderQueryStructureHtml(struct);

    // Even though `address` is not queried, the HTML still contains street & city
    // rows so the user can see what they could add.
    expect(html).toContain('address');
    expect(html).toContain('street');
    expect(html).toContain('city');
  });

  it('renders root field args in the header when rootFieldInfo is supplied', () => {
    const ret = cls('RtccEmailEmailList', [f('id', 'Int')]);
    const rootField: FieldInfo = {
      name: 'rtcc_email_list',
      fieldType: 'Field',
      resolvedType: 'RtccEmailEmailList',
      filePath: '/q.py',
      lineNumber: 0,
      args: [
        { name: 'company_id', type: 'ID', required: true },
        { name: 'page', type: 'Int', required: false },
      ],
    };
    const gf = parseGqlFields('query { rtccEmailList { id } }')[0];
    const struct = buildQueryStructure(gf, ret, new Map([[ret.name, ret]]), undefined, rootField);
    const html = renderQueryStructureHtml(struct);

    // Args appear in a dedicated header-args block, visible right beside the title.
    expect(html).toContain('class="header-args"');
    expect(html).toContain('companyId: <span class="arg-type">ID!');
    expect(html).toContain('page: <span class="arg-type">Int');
    expect(html).not.toContain('page: <span class="arg-type">Int!');
  });

  it('omits the header-args block when the root has no args', () => {
    const user = cls('UserType', [f('id')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureHtml(struct);
    expect(html).not.toContain('class="header-args"');
  });

  it('shows arguments inline with required (!) marker', () => {
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
    const map = new Map([[userType.name, userType], [query.name, query]]);

    const gf = parseGqlFields('query { user(id: 1) { id } }')[0];
    const struct = buildQueryStructure(gf, query, map);
    const html = renderQueryStructureHtml(struct);

    expect(html).toContain('id: <span class="arg-type">Int!');
    expect(html).toContain('includeDeleted: <span class="arg-type">Boolean');
    expect(html).not.toContain('includeDeleted: <span class="arg-type">Boolean!'); // not required
  });

  it('renders a friendly empty-state when the target has no fields', () => {
    const empty = cls('EmptyType', []);
    const gf = parseGqlFields('query { x {} }')[0];
    const struct = buildQueryStructure(gf, empty, new Map([[empty.name, empty]]));
    const html = renderQueryStructureHtml(struct);
    expect(html).toContain('No fields to show');
  });

  it('marks a resolvedType that is not in the index with unknown-type styling', () => {
    const user = cls('UserType', [f('company', 'Field', { resolvedType: 'ExternalType' })]);
    const gf = parseGqlFields('query { user {} }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureHtml(struct);

    expect(html).toContain('unknown-type');
    expect(html).toContain('ExternalType');
  });

  it('emits lazy-load twistie + data attrs for truncated subtrees', () => {
    const leaf = cls('L', [f('x', 'Int')]);
    const mid = cls('M', [f('y', 'Field', { resolvedType: 'L' })]);
    const user = cls('UserType', [f('next', 'Field', { resolvedType: 'M' })]);
    const map = new Map([[leaf.name, leaf], [mid.name, mid], [user.name, user]]);

    // depth cap 1 — `next` can't expand M's fields, should become a lazy node.
    const gf = parseGqlFields('query { user { next } }')[0];
    const struct = buildQueryStructure(gf, user, map, 1);
    const html = renderQueryStructureHtml(struct);

    expect(html).toContain('class="twistie lazy"');
    expect(html).toContain('data-lazy-type="M"');
    expect(html).toContain('data-ancestry="UserType"');
    expect(html).toContain('click ▸ to load');
  });

  it('does not emit lazy markup for scalar leaves', () => {
    const user = cls('UserType', [f('id', 'Int'), f('name', 'String')]);
    const gf = parseGqlFields('query { user { id } }')[0];
    const struct = buildQueryStructure(gf, user, new Map([[user.name, user]]));
    const html = renderQueryStructureHtml(struct);

    expect(html).not.toContain('class="twistie lazy"');
    expect(html).not.toContain('data-lazy-type');
  });
});

describe('renderSubtreeNodesHtml — lazy-expand response', () => {
  it('renders the class fields into HTML rows ready for webview insertion', () => {
    const inner = cls('I', [f('a', 'Int'), f('b', 'String')]);
    const nodes = buildLazySubtree(inner, new Map([[inner.name, inner]]), ['A']);
    const html = renderSubtreeNodesHtml(nodes, ['A', 'I']);

    expect(html).toContain('row');
    expect(html).toContain('>a<');
    expect(html).toContain('>b<');
    // Child scalars — no nested lazy markers.
    expect(html).not.toContain('class="twistie lazy"');
  });

  it('nested subtree still carries ancestry onto deeper lazy nodes', () => {
    const a = cls('A', [f('toB', 'Field', { resolvedType: 'B' })]);
    const b = cls('B', [f('toA', 'Field', { resolvedType: 'A' })]);
    const map = new Map([[a.name, a], [b.name, b]]);

    // Caller already has `A` in ancestry; expand B — `toA` must emit lazy markup
    // because A is in the cycle guard.
    const nodes = buildLazySubtree(b, map, ['A']);
    const html = renderSubtreeNodesHtml(nodes, ['A', 'B']);

    expect(html).toContain('class="twistie lazy"');
    expect(html).toContain('data-lazy-type="A"');
    expect(html).toContain('data-ancestry="A,B"');
  });
});

describe('serializeGqlField / hydrateGqlField round-trip (phase y)', () => {
  it('preserves the name+children shape through a JSON round-trip', () => {
    const gf = parseGqlFields('query { user { id name company { address } } }')[0];
    const lite = serializeGqlField(gf);
    const jsonSafe = JSON.parse(JSON.stringify(lite)); // as it would travel through a command arg
    const hydrated = hydrateGqlField(jsonSafe);

    expect(hydrated.name).toBe('user');
    expect(hydrated.children.map((c) => c.name)).toEqual(['id', 'name', 'company']);
    expect(hydrated.children[2].children.map((c) => c.name)).toEqual(['address']);
  });
});
