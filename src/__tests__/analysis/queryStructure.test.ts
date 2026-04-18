// Phase (y): expanded query-structure tree with queried/missing overlay.

import { describe, it, expect } from 'vitest';
import { buildQueryStructure, buildLazySubtree } from '../../analysis/queryStructure';
import { parseGqlFields } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}

function firstRoot(gql: string) {
  return parseGqlFields(gql)[0];
}

describe('buildQueryStructure (phase y)', () => {
  it('flags queried vs missing fields across a flat type', () => {
    const userType = cls('UserType', [
      f('id', 'Int'),
      f('name', 'String'),
      f('email', 'String'),
      f('created_at', 'DateTime'),
    ]);
    const gf = firstRoot('query { user { id name } }')!; // `user` node

    const s = buildQueryStructure(gf, userType, new Map([[userType.name, userType]]));
    expect(s.totalCount).toBe(4);
    expect(s.queriedCount).toBe(2);

    const byName = new Map(s.rootField.children.map((c) => [c.name, c]));
    expect(byName.get('id')!.queried).toBe(true);
    expect(byName.get('name')!.queried).toBe(true);
    expect(byName.get('email')!.queried).toBe(false);
    expect(byName.get('created_at')!.queried).toBe(false);
  });

  it('expands nested types recursively up to the depth cap', () => {
    const addressType = cls('AddressType', [f('street'), f('city')]);
    const companyType = cls('CompanyType', [f('name'), f('address', 'Field', { resolvedType: 'AddressType' })]);
    const userType = cls('UserType', [f('id'), f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const map = new Map([[userType.name, userType], [companyType.name, companyType], [addressType.name, addressType]]);

    const gf = firstRoot('query { user { id company { name } } }')!; // `user`
    const s = buildQueryStructure(gf, userType, map, 3);

    const idNode = s.rootField.children.find((c) => c.name === 'id')!;
    const companyNode = s.rootField.children.find((c) => c.name === 'company')!;
    expect(idNode.queried).toBe(true);
    expect(companyNode.queried).toBe(true);
    expect(companyNode.resolvedTypeKnown).toBe(true);

    // company.name is queried; company.address is NOT — but still expanded so the
    // user can see what's available under a missing branch.
    const companyChildren = new Map(companyNode.children.map((c) => [c.name, c]));
    expect(companyChildren.get('name')!.queried).toBe(true);
    expect(companyChildren.get('address')!.queried).toBe(false);

    // Third level: address.street / address.city are shown unqueried.
    const addressNode = companyChildren.get('address')!;
    const addressChildren = new Map(addressNode.children.map((c) => [c.name, c]));
    expect(addressChildren.get('street')!.queried).toBe(false);
    expect(addressChildren.get('city')!.queried).toBe(false);
  });

  it('respects the max depth (stops expanding beyond the cap)', () => {
    const c = cls('C', [f('deep', 'Field', { resolvedType: 'C' })]); // self-reference
    const gf = firstRoot('query { root {} }')!; // `root`
    const s = buildQueryStructure(gf, c, new Map([[c.name, c]]), 2);
    // depth 1 field `deep` exists; its child (depth 2) may be present; depth 3 must be empty.
    const l1 = s.rootField.children[0];
    expect(l1.name).toBe('deep');
    // With depth cap 2 and self-reference, l1.children should be empty because
    // expanding `C` again would revisit it (cycle guard).
    expect(l1.children).toEqual([]);
    // The cycle was truncated — the UI should be able to offer lazy expansion.
    expect(l1.hasMoreChildren).toBe(true);
  });

  it('flags hasMoreChildren when expansion stops at the depth cap', () => {
    const deep = cls('D', [f('leaf', 'Int')]);
    const outer = cls('O', [f('next', 'Field', { resolvedType: 'D' })]);
    const gf = firstRoot('query { root {} }')!;
    // maxDepth=1 → outer's `next` field can't expand D's fields.
    const s = buildQueryStructure(gf, outer, new Map([[outer.name, outer], [deep.name, deep]]), 1);
    const next = s.rootField.children[0];
    expect(next.children).toEqual([]);
    expect(next.hasMoreChildren).toBe(true);
    expect(next.resolvedType).toBe('D');
  });

  it('does not flag hasMoreChildren when the resolvedType is unknown', () => {
    const outer = cls('O', [f('next', 'Field', { resolvedType: 'Unknown' })]);
    const gf = firstRoot('query { root {} }')!;
    const s = buildQueryStructure(gf, outer, new Map([[outer.name, outer]]));
    const next = s.rootField.children[0];
    expect(next.children).toEqual([]);
    // Unknown types can't be lazy-expanded — there's nothing for the server to
    // produce. The UI renders italic 'unknown-type' instead.
    expect(next.hasMoreChildren).toBe(false);
  });
});

describe('buildLazySubtree — on-demand deeper expansion', () => {
  it('returns the class fields one level deep by default', () => {
    const inner = cls('I', [f('a', 'Int'), f('b', 'String')]);
    const nodes = buildLazySubtree(inner, new Map([[inner.name, inner]]));
    expect(nodes.map((n) => n.name)).toEqual(['a', 'b']);
    // Scalars → leaves, no further expansion.
    expect(nodes.every((n) => n.children.length === 0 && !n.hasMoreChildren)).toBe(true);
  });

  it('honors the ancestor chain to avoid re-entering cycles', () => {
    const a = cls('A', [f('toB', 'Field', { resolvedType: 'B' })]);
    const b = cls('B', [f('toA', 'Field', { resolvedType: 'A' })]);
    const map = new Map([[a.name, a], [b.name, b]]);
    // Caller already has `A` in ancestry — expansion of B must mark `toA` as
    // hasMoreChildren (cycle) rather than re-expanding A.
    const nodes = buildLazySubtree(b, map, ['A']);
    const toA = nodes.find((n) => n.name === 'toA')!;
    expect(toA.children).toEqual([]);
    expect(toA.hasMoreChildren).toBe(true);
  });

  it('expands one extra level when maxDepth is bumped', () => {
    const leaf = cls('L', [f('x', 'Int')]);
    const mid = cls('M', [f('y', 'Field', { resolvedType: 'L' })]);
    const outer = cls('O', [f('z', 'Field', { resolvedType: 'M' })]);
    const map = new Map([[leaf.name, leaf], [mid.name, mid], [outer.name, outer]]);
    const shallow = buildLazySubtree(outer, map, [], 1);
    expect(shallow[0].children).toEqual([]);
    expect(shallow[0].hasMoreChildren).toBe(true);

    const deeper = buildLazySubtree(outer, map, [], 3);
    expect(deeper[0].children.map((c) => c.name)).toEqual(['y']);
    expect(deeper[0].children[0].children.map((c) => c.name)).toEqual(['x']);
  });

  it('marks resolvedTypeKnown=false when a class is referenced but not in the map', () => {
    const userType = cls('UserType', [f('company', 'Field', { resolvedType: 'ExternalCompanyType' })]);
    const gf = firstRoot('query { user { company { name } } }')!; // `user`
    const s = buildQueryStructure(gf, userType, new Map([[userType.name, userType]]));

    const companyNode = s.rootField.children.find((c) => c.name === 'company')!;
    expect(companyNode.resolvedType).toBe('ExternalCompanyType');
    expect(companyNode.resolvedTypeKnown).toBe(false);
    expect(companyNode.children).toEqual([]); // nothing to expand
  });

  it('shows only the args the user wrote in gql, not every backend arg', () => {
    // Backend declares 4 args; user's gql only passed 2. The Query Structure
    // header must list those 2 (marked provided), not all 4 — otherwise the
    // UI is noisy and pretends the user supplied args they didn't.
    const retType = cls('Ret', [f('id', 'Int')]);
    const rootField: FieldInfo = {
      name: 'rtcc_email_list',
      fieldType: 'Field',
      resolvedType: 'Ret',
      filePath: '/q.py',
      lineNumber: 0,
      args: [
        { name: 'company_id', type: 'ID', required: true },
        { name: 'right_to_consent_or_consult_id', type: 'ID', required: true },
        { name: 'page', type: 'Int', required: false },
        { name: 'per_page', type: 'Int', required: false },
      ],
    };
    const gf = firstRoot('query Q($cid: ID!, $page: Int) { rtccEmailList(companyId: $cid, page: $page) { id } }')!;
    const s = buildQueryStructure(gf, retType, new Map([[retType.name, retType]]), undefined, rootField);

    const names = s.rootField.args.map((a) => a.name);
    expect(names).toEqual(['company_id', 'page']);
    expect(s.rootField.args.every((a) => a.provided)).toBe(true);
  });

  it('falls back to the full backend arg list when the gql has no arg list', () => {
    const retType = cls('Ret', [f('id', 'Int')]);
    const rootField: FieldInfo = {
      name: 'foo',
      fieldType: 'Field',
      resolvedType: 'Ret',
      filePath: '/q.py',
      lineNumber: 0,
      args: [
        { name: 'a', type: 'Int', required: false },
        { name: 'b', type: 'Int', required: false },
      ],
    };
    // No `(...)` on `foo` — we don't know what the user provided, so show
    // the full backend surface area.
    const gf = firstRoot('query { foo { id } }')!;
    const s = buildQueryStructure(gf, retType, new Map([[retType.name, retType]]), undefined, rootField);
    const names = s.rootField.args.map((a) => a.name);
    expect(names).toEqual(['a', 'b']);
    expect(s.rootField.args.every((a) => a.provided === false)).toBe(true);
  });

  it('surfaces rootFieldInfo.args on the root node when supplied', () => {
    const retType = cls('RtccEmailEmailList', [f('id', 'Int')]);
    const rootField: FieldInfo = {
      name: 'rtcc_email_list',
      fieldType: 'Field',
      resolvedType: 'RtccEmailEmailList',
      filePath: '/q.py',
      lineNumber: 0,
      args: [
        { name: 'company_id', type: 'ID', required: true },
        { name: 'right_to_consent_or_consult_id', type: 'ID', required: true },
        { name: 'page', type: 'Int', required: false },
        { name: 'per_page', type: 'Int', required: false },
      ],
    };
    const gf = firstRoot('query { rtccEmailList { id } }')!;
    const s = buildQueryStructure(gf, retType, new Map([[retType.name, retType]]), undefined, rootField);

    expect(s.rootField.args).toHaveLength(4);
    const byName = new Map(s.rootField.args.map((a) => [a.name, a]));
    expect(byName.get('company_id')!.required).toBe(true);
    expect(byName.get('company_id')!.displayName).toBe('companyId');
    expect(byName.get('per_page')!.required).toBe(false);
    expect(byName.get('per_page')!.displayName).toBe('perPage');
  });

  it('exposes args with required flag and camelCase display name', () => {
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

    // Treat the `user` field as the root of the structure — we're visualising
    // what lives inside it, not the Query container.
    const gf = firstRoot('query { user(id: 1) { id } }')!;
    const s = buildQueryStructure(gf, query, map);

    const userNode = s.rootField.children.find((c) => c.name === 'user')!;
    expect(userNode.args).toHaveLength(2);
    const byName = new Map(userNode.args.map((a) => [a.name, a]));
    expect(byName.get('id')!.required).toBe(true);
    expect(byName.get('include_deleted')!.required).toBe(false);
    expect(byName.get('include_deleted')!.displayName).toBe('includeDeleted');
  });

  it('hides synthetic markers like __relay_node__ from the tree', () => {
    const connection = cls('StockConnection', [
      f('__relay_node__', 'RelayNode', { resolvedType: 'StockType' }),
      f('edges', 'List', { resolvedType: 'StockEdge' }),
    ]);
    const edge = cls('StockEdge', [f('node', 'Field', { resolvedType: 'StockType' })]);
    const stockType = cls('StockType', [f('id')]);
    const map = new Map([
      [connection.name, connection], [edge.name, edge], [stockType.name, stockType],
    ]);

    const gf = firstRoot('query { conn { edges { node { id } } } }')!; // `conn`
    const s = buildQueryStructure(gf, connection, map);

    const names = s.rootField.children.map((c) => c.name);
    expect(names).toEqual(['edges']);
  });

  it('reports an accurate summary count across the whole tree', () => {
    // 1 root + 2 on user (id queried, name missing) + 2 on company (both missing)
    const companyType = cls('CompanyType', [f('city'), f('country')]);
    const userType = cls('UserType', [f('id'), f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const map = new Map([[userType.name, userType], [companyType.name, companyType]]);

    const gf = firstRoot('query { user { id } }')!; // `user`
    const s = buildQueryStructure(gf, userType, map);

    // total = id + company + city + country = 4; queried = id only
    expect(s.totalCount).toBe(4);
    expect(s.queriedCount).toBe(1);
  });
});
