// Scenario 9: missing-field detection — a backend type has N fields, frontend queries M,
// the provider should flag (N - M) missing field names.

import { describe, it, expect } from 'vitest';
import { computeMissingFields, parseGqlFields } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';

function mkField(name: string, fieldType = 'String'): FieldInfo {
  return { name, fieldType, filePath: '/fake.py', lineNumber: 0 };
}

function mkClass(name: string, fields: FieldInfo[], baseClasses: string[] = []): ClassInfo {
  return {
    name,
    baseClasses,
    framework: 'graphene',
    filePath: '/fake.py',
    lineNumber: 0,
    fields,
    kind: 'type',
  };
}

describe('computeMissingFields — scenario 9', () => {
  it('returns fields not queried in frontend selection set', () => {
    const cls = mkClass('StockType', [
      mkField('id', 'ID'),
      mkField('name', 'String'),
      mkField('ticker', 'String'),
      mkField('price', 'Float'),
      mkField('volume', 'Int'),
    ]);
    // Frontend queries only id and name
    const children = parseGqlFields('query { stock { id name } }')[0].children;
    const missing = computeMissingFields(children, cls, new Map([[cls.name, cls]]));
    expect(missing.map((f) => f.name).sort()).toEqual(['price', 'ticker', 'volume']);
  });

  it('returns empty array when all fields are queried', () => {
    const cls = mkClass('SmallType', [mkField('id'), mkField('name')]);
    const children = parseGqlFields('query { x { id name } }')[0].children;
    const missing = computeMissingFields(children, cls, new Map([[cls.name, cls]]));
    expect(missing).toEqual([]);
  });

  it('maps camelCase frontend fields to snake_case backend fields', () => {
    const cls = mkClass('UserType', [
      mkField('id'),
      mkField('first_name'),
      mkField('last_name'),
      mkField('created_at'),
    ]);
    // Frontend uses camelCase
    const children = parseGqlFields('query { user { id firstName lastName } }')[0].children;
    const missing = computeMissingFields(children, cls, new Map([[cls.name, cls]]));
    expect(missing.map((f) => f.name)).toEqual(['created_at']);
  });

  it('scales — 20 backend fields, 5 queried → 15 missing', () => {
    const backendFields = Array.from({ length: 20 }, (_, i) => mkField(`f${i}`));
    const cls = mkClass('BigType', backendFields);
    const children = parseGqlFields('query { big { f0 f1 f2 f3 f4 } }')[0].children;
    const missing = computeMissingFields(children, cls, new Map([[cls.name, cls]]));
    expect(missing).toHaveLength(15);
    expect(missing.map((f) => f.name)).toEqual(Array.from({ length: 15 }, (_, i) => `f${i + 5}`));
  });

  it('handles class with no direct fields by walking base classes (mixin)', () => {
    const base = mkClass('TimestampMixin', [mkField('created_at'), mkField('updated_at')]);
    const child = mkClass('UserType', [], ['TimestampMixin']);
    const classMap = new Map([[base.name, base], [child.name, child]]);
    // Frontend queries only createdAt
    const children = parseGqlFields('query { user { createdAt } }')[0].children;
    const missing = computeMissingFields(children, child, classMap);
    expect(missing.map((f) => f.name)).toEqual(['updated_at']);
  });

  // Phase (k): a 6-level mixin chain used to be silently truncated by a depth-4 cap.
  it('walks a 6-level mixin chain without silent truncation', () => {
    // depth:  a ← b ← c ← d ← e ← f ← leaf  (leaf has no own fields)
    const root = mkClass('RootMixin', [mkField('root_field')]);
    const mid1 = mkClass('Mid1', [], ['RootMixin']);
    const mid2 = mkClass('Mid2', [], ['Mid1']);
    const mid3 = mkClass('Mid3', [], ['Mid2']);
    const mid4 = mkClass('Mid4', [], ['Mid3']);
    const mid5 = mkClass('Mid5', [], ['Mid4']);
    const leaf = mkClass('LeafType', [], ['Mid5']);
    const classMap = new Map([
      [root.name, root], [mid1.name, mid1], [mid2.name, mid2],
      [mid3.name, mid3], [mid4.name, mid4], [mid5.name, mid5],
      [leaf.name, leaf],
    ]);
    // Frontend queries nothing — all inherited fields should be missing.
    const children = parseGqlFields('query { x {} }')[0]?.children ?? [];
    const missing = computeMissingFields(children, leaf, classMap);
    expect(missing.map((f) => f.name)).toEqual(['root_field']);
  });

  it('terminates cleanly on cyclic mixin chains (A extends B, B extends A)', () => {
    const a = mkClass('A', [], ['B']);
    const b = mkClass('B', [mkField('b_only')], ['A']);
    const classMap = new Map([[a.name, a], [b.name, b]]);
    const children = parseGqlFields('query { x {} }')[0]?.children ?? [];
    // Should not hang; should find b_only via A → B.
    const missing = computeMissingFields(children, a, classMap);
    expect(missing.map((f) => f.name)).toEqual(['b_only']);
  });
});
