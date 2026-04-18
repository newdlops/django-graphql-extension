// Phase (j): When a field's resolvedType points at a class we don't know about
// (e.g., an external/unknown type), the CodeLens provider must NOT fall back to
// the owning class's context and falsely claim descendant fields belong there.
//
// Drives the real GqlCodeLensProvider — end-to-end CodeLens emission check.

import { describe, it, expect, beforeEach } from 'vitest';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument } from 'vscode';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/f.py', lineNumber: 0, ...extras };
}

function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/f.py', lineNumber: 0, fields, kind };
}

function makeProvider(classMap: Map<string, ClassInfo>): GqlCodeLensProvider {
  const p = new GqlCodeLensProvider();
  p.updateIndex(classMap);
  p.rebuildIndexNow();
  return p;
}

describe('resolveFields — parent-fallback suppression (phase j)', () => {
  let provider: GqlCodeLensProvider;
  let titles: string[];

  beforeEach(() => {
    // Schema:
    //   Query.stock → StockType
    //   StockType has a coincidental `address` field AND a `company` field that
    //   references an UNKNOWN CompanyType (not in classMap).
    // Without the fix, the CodeLens for `company { address }` would wrongly
    // claim the inner `address` belongs to StockType.
    const stockType = cls('StockType', [
      f('address', 'String'),
      f('company', 'Field', { resolvedType: 'CompanyType' }),
    ]);
    const queryCls = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    provider = makeProvider(new Map([[stockType.name, stockType], [queryCls.name, queryCls]]));
  });

  it('emits a CodeLens for the parent field (company) but not for the unresolved descendant (address)', () => {
    const src = [
      'const q = gql`',
      '  query {',
      '    stock {',
      '      company {',
      '        address',
      '      }',
      '    }',
      '  }',
      '`;',
    ].join('\n');
    const doc = new TextDocument(src);
    const lenses = provider.provideCodeLenses(doc as any);
    titles = lenses.map((l: any) => l.command?.title ?? '').filter(Boolean);

    // Parent field CodeLenses must be present
    expect(titles.some((t) => t.includes('Query.stock'))).toBe(true);
    expect(titles.some((t) => t.includes('StockType.company'))).toBe(true);

    // The descendant `address` must NOT be attributed to StockType.
    // (Before the fix, `resolvedCls ?? entry.cls` caused this misattribution.)
    const addressToStock = titles.find((t) => t.includes('StockType.address'));
    expect(addressToStock, 'address must not be attributed to StockType when company.type is unresolved').toBeUndefined();
  });

  it('still resolves correctly when the child type IS known', () => {
    // Re-setup: this time CompanyType IS in the schema.
    const companyType = cls('CompanyType', [f('address', 'String'), f('name', 'String')]);
    const stockType = cls('StockType', [
      f('address', 'String'),
      f('company', 'Field', { resolvedType: 'CompanyType' }),
    ]);
    const queryCls = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    const p = makeProvider(new Map([
      [companyType.name, companyType],
      [stockType.name, stockType],
      [queryCls.name, queryCls],
    ]));

    const src = [
      'const q = gql`',
      '  query { stock { company { address } } }',
      '`;',
    ].join('\n');
    const doc = new TextDocument(src);
    const lenses = p.provideCodeLenses(doc as any);
    const titles = lenses.map((l: any) => l.command?.title ?? '').filter(Boolean);

    // Now the descendant SHOULD resolve, but to CompanyType — not StockType.
    expect(titles.some((t) => t.includes('CompanyType.address'))).toBe(true);
    expect(titles.some((t) => t.includes('StockType.address'))).toBe(false);
  });
});
