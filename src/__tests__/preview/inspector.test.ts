// Phase (p): buildInspectorData — structure of the payload feeding the
// Class Inspector webview. Covers fields, args, reverse refs, origin.

import { describe, it, expect } from 'vitest';
import { buildInspectorData, buildInspectorDataFresh } from '../../preview/inspector';
import { buildReverseIndex } from '../../scanner/reverseIndex';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p/a.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], opts: Partial<ClassInfo> = {}): ClassInfo {
  return {
    name,
    baseClasses: [],
    framework: 'graphene',
    filePath: '/p/a.py',
    lineNumber: 0,
    fields,
    kind: 'type',
    ...opts,
  };
}

describe('buildInspectorData (phase p)', () => {
  it('returns null for an unknown class', () => {
    const idx = buildReverseIndex(new Map());
    expect(buildInspectorData('Nope', new Map(), idx)).toBeNull();
  });

  it('emits rows with snake→camel display names and resolved-type existence flags', () => {
    const companyType = cls('CompanyType', [f('name')]);
    const stockType = cls('StockType', [
      f('company_id', 'String'),
      f('company', 'Field', { resolvedType: 'CompanyType' }),
      f('missing_link', 'Field', { resolvedType: 'LegacyType' }),
    ]);
    const map = new Map([[companyType.name, companyType], [stockType.name, stockType]]);
    const data = buildInspectorData('StockType', map, buildReverseIndex(map))!;

    expect(data.fields.map((r) => r.displayName))
      .toEqual(['companyId', 'company', 'missingLink']);

    const company = data.fields.find((r) => r.name === 'company')!;
    expect(company.resolvedType).toBe('CompanyType');
    expect(company.resolvedTypeExists).toBe(true);

    const missing = data.fields.find((r) => r.name === 'missing_link')!;
    expect(missing.resolvedType).toBe('LegacyType');
    expect(missing.resolvedTypeExists).toBe(false); // chip should be non-clickable in UI
  });

  it('exposes argument type existence so the UI knows which chips are clickable', () => {
    const filterInput = cls('UserFilterInput', [f('name')]);
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [
      f('users', 'Field', {
        resolvedType: 'UserType',
        args: [
          { name: 'filter', type: 'UserFilterInput', required: false },
          { name: 'id', type: 'Int', required: true }, // scalar — chip not clickable
        ],
      }),
    ], { kind: 'query' });
    const map = new Map([[filterInput.name, filterInput], [userType.name, userType], [query.name, query]]);
    const data = buildInspectorData('Query', map, buildReverseIndex(map))!;

    const users = data.fields.find((r) => r.name === 'users')!;
    expect(users.args).toHaveLength(2);
    expect(users.args.find((a) => a.name === 'filter')!.typeExists).toBe(true);
    expect(users.args.find((a) => a.name === 'id')!.typeExists).toBe(false);
  });

  it('populates usedAsFieldType and usedAsArgType reverse refs', () => {
    const filterInput = cls('UserFilterInput', [f('name')]);
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [
      f('users', 'Field', {
        resolvedType: 'UserType',
        args: [{ name: 'filter', type: 'UserFilterInput', required: false }],
      }),
    ], { kind: 'query' });
    const map = new Map([
      [filterInput.name, filterInput], [userType.name, userType], [query.name, query],
    ]);
    const idx = buildReverseIndex(map);

    const userData = buildInspectorData('UserType', map, idx)!;
    expect(userData.usedAsFieldType.map((r) => `${r.fromClass}.${r.fromField}`))
      .toEqual(['Query.users']);
    expect(userData.usedAsArgType).toEqual([]);

    const filterData = buildInspectorData('UserFilterInput', map, idx)!;
    expect(filterData.usedAsArgType.map((r) => `${r.fromClass}.${r.fromField}(${r.label})`))
      .toEqual(['Query.users(filter)']);
    expect(filterData.usedAsFieldType).toEqual([]);
  });

  it('marks inherited fields with origin: "inherited"', () => {
    const mixin = cls('TimestampMixin', [
      { name: 'created_at', fieldType: 'DateTime', filePath: '/p/mixin.py', lineNumber: 1 },
    ]);
    const userType = cls('UserType',
      [
        // Simulate the merged result of resolveInheritedFields:
        { name: 'name', fieldType: 'String', filePath: '/p/a.py', lineNumber: 2 },
        { name: 'created_at', fieldType: 'DateTime', filePath: '/p/mixin.py', lineNumber: 1 },
      ],
      { filePath: '/p/a.py', baseClasses: ['TimestampMixin'] },
    );
    const map = new Map([[mixin.name, mixin], [userType.name, userType]]);
    const data = buildInspectorData('UserType', map, buildReverseIndex(map))!;

    expect(data.fields.find((r) => r.name === 'name')!.origin).toBe('own');
    expect(data.fields.find((r) => r.name === 'created_at')!.origin).toBe('inherited');
    expect(data.knownBaseClasses).toEqual(['TimestampMixin']);
  });

  it('filters out synthetic __relay_node__-style markers from the field rows', () => {
    const leaky = cls('FooConnection', [
      f('__relay_node__', 'RelayNode', { resolvedType: 'FooType' }),
      f('edges', 'List', { resolvedType: 'FooEdge' }),
    ]);
    const fooType = cls('FooType', [f('id')]);
    const edge = cls('FooEdge', [f('node', 'Field', { resolvedType: 'FooType' })]);
    const map = new Map([[leaky.name, leaky], [fooType.name, fooType], [edge.name, edge]]);
    const data = buildInspectorData('FooConnection', map, buildReverseIndex(map))!;
    expect(data.fields.map((r) => r.name)).toEqual(['edges']);
  });

  it('includes a non-empty SDL string for the class', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const data = buildInspectorData('UserType', new Map([[userType.name, userType]]), new Map())!;
    expect(data.sdl).toContain('UserType');
    expect(data.sdl.length).toBeGreaterThan(0);
  });

  it('convenience wrapper buildInspectorDataFresh builds the index internally', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], { kind: 'query' });
    const map = new Map([[userType.name, userType], [query.name, query]]);
    const data = buildInspectorDataFresh('UserType', map)!;
    expect(data.usedAsFieldType.map((r) => r.fromClass)).toEqual(['Query']);
  });
});
