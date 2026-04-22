// Phase (v): gql diagnostics + did-you-mean suggestions.

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument, Uri, __getDiagnosticsFor, __clearDiagnostics } from 'vscode';
import { computeDiagnostics, GqlDiagnosticsManager } from '../../codelens/gqlDiagnostics';
import { buildFieldIndex } from '../../codelens/gqlResolver';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}
function ctxFromClasses(classes: ClassInfo[]) {
  const classMap = new Map(classes.map((c) => [c.name, c] as const));
  return { classMap, fieldIndex: buildFieldIndex(classMap) };
}

describe('computeDiagnostics (phase v)', () => {
  it('reports a field that does not exist on the known parent class', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { bogus } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('bogus');
    expect(diags[0].message).toContain('UserType');
  });

  it("suggests 'did you mean …' for near-misses", () => {
    const userType = cls('UserType', [f('first_name'), f('last_name'), f('email')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    // `firs_name` is one deletion away from `first_name`
    const src = 'gql`query { user { firsName } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].suggestions).toContain('first_name');
    expect(diags[0].message).toContain('first_name');
  });

  it('does NOT flag unknown root fields when no schema root is context', () => {
    // With an empty classMap and fieldIndex, we bail out early.
    const diags = computeDiagnostics('gql`query { user { id } }`;', { classMap: new Map(), fieldIndex: new Map() });
    expect(diags).toEqual([]);
  });

  it('reports root fields that only exist on regular types, not schema roots', () => {
    const userType = cls('UserType', [f('profile', 'Field', { resolvedType: 'ProfileType' })]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { profile { id } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("No root query field 'profile'");
  });

  it('walks into children and reports unresolved there too', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { id totallyNotReal } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('totally_not_real');
  });

  it('follows provider field-name inference before checking nested unresolved fields', () => {
    const investorType = cls('InvestorType', [f('id')]);
    const query = cls('Query', [f('investors', 'Field')], 'query');
    const ctx = ctxFromClasses([investorType, query]);

    const src = 'gql`query { investors { bogus } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('InvestorType');
    expect(diags[0].message).toContain('bogus');
  });

  it('does not flag fields on unknown parent types (no context to check against)', () => {
    // StockType.company references an unknown CompanyType. `bogus` under
    // company should NOT be flagged — we don't know CompanyType's fields.
    const stockType = cls('StockType', [f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const query = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    const ctx = ctxFromClasses([stockType, query]);

    const src = 'gql`query { stock { company { bogus } } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toEqual([]);
  });

  it('respects the snake↔camel conversion in the message', () => {
    const userType = cls('UserType', [f('created_at', 'DateTime')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    // `createdAd` should be reported as `created_ad` with did-you-mean `created_at`
    const src = 'gql`query { user { createdAd } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('created_ad');
    expect(diags[0].suggestions).toContain('created_at');
  });

  it('spans the squiggle exactly across the frontend field name', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { bogus } }`;';
    const diags = computeDiagnostics(src, ctx);
    expect(diags).toHaveLength(1);
    const bogusIdx = src.indexOf('bogus');
    expect(diags[0].offset).toBe(bogusIdx);
    expect(diags[0].length).toBe('bogus'.length);
  });
});

describe('GqlDiagnosticsManager (phase v integration)', () => {
  beforeEach(() => __clearDiagnostics());

  it('writes diagnostics into the collection keyed by document uri', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);
    const mgr = new GqlDiagnosticsManager(() => ctx);

    const doc = Object.assign(new TextDocument('gql`query { user { bogus } }`;'), {
      uri: Uri.file('/workspace/a.ts'),
    });
    mgr.refreshNow(doc as any);

    const diags = __getDiagnosticsFor('/workspace/a.ts');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('bogus');
  });

  it('clears diagnostics when refresh finds no issues', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);
    const mgr = new GqlDiagnosticsManager(() => ctx);

    const doc = Object.assign(new TextDocument('gql`query { user { id } }`;'), {
      uri: Uri.file('/workspace/a.ts'),
    });
    mgr.refreshNow(doc as any);
    const diags = __getDiagnosticsFor('/workspace/a.ts');
    expect(diags).toEqual([]);
  });
});
