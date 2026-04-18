// Phase (o): reverse-index — for each type, who references it and how.

import { describe, it, expect } from 'vitest';
import { buildReverseIndex } from '../../scanner/reverseIndex';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/f.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/f.py', lineNumber: 0, fields, kind };
}

describe('buildReverseIndex (phase o)', () => {
  it('records field-type references', () => {
    const companyType = cls('CompanyType', [f('name')]);
    const stockType = cls('StockType', [f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const map = new Map([[companyType.name, companyType], [stockType.name, stockType]]);
    const idx = buildReverseIndex(map);

    expect(idx.get('CompanyType')!.usedAsFieldType).toEqual([{
      fromClass: 'StockType', fromField: 'company', viaKind: 'field',
      label: 'company', filePath: '/f.py', lineNumber: 0,
    }]);
    expect(idx.get('CompanyType')!.usedAsArgType).toEqual([]);
  });

  it('records argument-type references', () => {
    const filterInput = cls('UserFilterInput', [f('name')]);
    const userType = cls('UserType', [f('id', 'Int')]);
    const query = cls('Query', [
      f('users', 'Field', {
        resolvedType: 'UserType',
        args: [{ name: 'filter', type: 'UserFilterInput', required: false }],
      }),
    ], 'query');
    const map = new Map([
      [filterInput.name, filterInput],
      [userType.name, userType],
      [query.name, query],
    ]);
    const idx = buildReverseIndex(map);

    const filterRefs = idx.get('UserFilterInput')!;
    expect(filterRefs.usedAsArgType).toHaveLength(1);
    expect(filterRefs.usedAsArgType[0]).toMatchObject({
      fromClass: 'Query', fromField: 'users', viaKind: 'arg', label: 'filter',
    });
    // UserFilterInput is NOT used as a field anywhere
    expect(filterRefs.usedAsFieldType).toEqual([]);
  });

  it('collects multiple references to the same type', () => {
    const userType = cls('UserType', [f('id')]);
    const stockType = cls('StockType', [f('owner', 'Field', { resolvedType: 'UserType' })]);
    const companyType = cls('CompanyType', [f('ceo', 'Field', { resolvedType: 'UserType' })]);
    const map = new Map([
      [userType.name, userType], [stockType.name, stockType], [companyType.name, companyType],
    ]);
    const idx = buildReverseIndex(map);

    const refs = idx.get('UserType')!.usedAsFieldType;
    expect(refs.map((r) => `${r.fromClass}.${r.fromField}`).sort())
      .toEqual(['CompanyType.ceo', 'StockType.owner']);
  });

  it('ignores references to types not in the classMap (external/scalar args)', () => {
    const query = cls('Query', [
      f('users', 'Field', {
        resolvedType: 'UserType',
        args: [
          { name: 'id', type: 'Int', required: true },           // scalar
          { name: 'unknown', type: 'ExternalType', required: false }, // not in map
        ],
      }),
    ], 'query');
    const userType = cls('UserType', [f('id', 'Int')]);
    const map = new Map([[userType.name, userType], [query.name, query]]);
    const idx = buildReverseIndex(map);

    expect(idx.get('Int')).toBeUndefined();
    expect(idx.get('ExternalType')).toBeUndefined();
    expect(idx.get('UserType')!.usedAsFieldType).toHaveLength(1);
  });

  it('returns an empty index when no references exist', () => {
    const lone = cls('Lonely', [f('n')]);
    const idx = buildReverseIndex(new Map([[lone.name, lone]]));
    expect(idx.get('Lonely')).toBeUndefined();
  });

  it('does not list synthetic __relay_node__ style markers as references', () => {
    const leaky = cls('FooConnection', [
      f('__relay_node__', 'RelayNode', { resolvedType: 'FooType' }),
      f('edges', 'List', { resolvedType: 'FooEdge' }),
    ]);
    const fooType = cls('FooType', [f('id')]);
    const edge = cls('FooEdge', [f('node', 'Field', { resolvedType: 'FooType' })]);
    const map = new Map([[leaky.name, leaky], [fooType.name, fooType], [edge.name, edge]]);
    const idx = buildReverseIndex(map);

    // FooType should be referenced only via FooEdge.node — NOT via the
    // internal marker, even if it somehow survived in fields.
    const fooRefs = idx.get('FooType')!.usedAsFieldType;
    expect(fooRefs.map((r) => `${r.fromClass}.${r.fromField}`)).toEqual(['FooEdge.node']);
  });
});
