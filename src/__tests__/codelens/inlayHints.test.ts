// Phase (u): gql inlay hints — inline `→ TypeName` chips after each field name.

import { describe, it, expect } from 'vitest';
import { computeInlayHints } from '../../codelens/gqlInlayHintsProvider';
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

describe('computeInlayHints (phase u)', () => {
  it('emits `→ TypeName` for fields with known resolvedType', () => {
    const userType = cls('UserType', [f('id', 'Int'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'const q = gql`query { user { id name } }`;';
    const hints = computeInlayHints(src, ctx);
    // Expect three hints: user→UserType, id→Int, name→String
    const labels = hints.map((h) => h.label);
    expect(labels).toEqual([' → UserType', ' → Int', ' → String']);
    for (const h of hints) expect(h.confidence).toBe('exact');
  });

  it('places the hint offset right after the field name', () => {
    const userType = cls('UserType', [f('id', 'Int')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { id } }`;';
    const hints = computeInlayHints(src, ctx);
    // `id` lives at offset of "id" in src; the hint offset should point to the
    // character AFTER "id".
    const idAt = src.indexOf(' id') + 1; // skip the leading space
    const idHint = hints.find((h) => h.label.includes('Int'))!;
    expect(idHint.offset).toBe(idAt + 2);
  });

  it('scopes root-level matches by operation kind', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const mut = cls('Mutation', [f('user', 'Field', { resolvedType: 'UserType' })], 'mutation');
    const ctx = ctxFromClasses([userType, query, mut]);

    const src = 'gql`query { user { id } }`;';
    const hints = computeInlayHints(src, ctx);
    const userHint = hints.find((h) => h.tooltip.includes('.user'))!;
    expect(userHint.label).not.toContain('~');
    expect(userHint.confidence).toBe('exact');
  });

  it('emits `→ ?` for root fields that only exist on regular types', () => {
    const userType = cls('UserType', [f('profile', 'Field', { resolvedType: 'ProfileType' })]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { profile { id } }`;';
    const hints = computeInlayHints(src, ctx);
    const profileHint = hints.find((h) => h.tooltip.includes('root query field named'))!;
    expect(profileHint.label).toBe(' → ?');
    expect(profileHint.confidence).toBe('unresolved');
  });

  it('emits `→ ?` when parent is known but field does not belong to it', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { bogus } }`;';
    const hints = computeInlayHints(src, ctx);
    const bogus = hints.find((h) => h.label === ' → ?');
    expect(bogus).toBeDefined();
    expect(bogus!.confidence).toBe('unresolved');
    expect(bogus!.tooltip).toContain('bogus');
    expect(bogus!.tooltip).toContain('UserType');
  });

  it('does NOT recurse into children when the child type is unknown', () => {
    const stockType = cls('StockType', [f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const query = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    const ctx = ctxFromClasses([stockType, query]);

    const src = 'gql`query { stock { company { name } } }`;';
    const hints = computeInlayHints(src, ctx);
    // Should have hints for stock, company — but NOT for `name` (CompanyType not known).
    const labels = hints.map((h) => h.label);
    expect(labels).toContain(' → StockType');
    expect(labels).toContain(' → CompanyType');
    expect(labels).not.toContain(' → String'); // `name` wasn't reached
  });

  it('reuses provider field-name inference for nested child hints', () => {
    const investorType = cls('InvestorType', [f('id', 'Int')]);
    const query = cls('Query', [f('investors', 'Field')], 'query');
    const ctx = ctxFromClasses([investorType, query]);

    const src = 'gql`query { investors { id } }`;';
    const hints = computeInlayHints(src, ctx);
    expect(hints.some((h) => h.label === ' → Int')).toBe(true);
  });

  it('carries a target location pointing at the resolved class file', () => {
    const userType = cls('UserType', [f('id')]);
    userType.filePath = '/backend/user.py';
    userType.lineNumber = 42;
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { id } }`;';
    const hints = computeInlayHints(src, ctx);
    const userHint = hints.find((h) => h.label.includes('UserType'))!;
    expect(userHint.target).toEqual({ filePath: '/backend/user.py', line: 42 });
  });

  it('returns [] when the field index is empty (no schemas loaded)', () => {
    const ctx = { classMap: new Map(), fieldIndex: new Map() };
    expect(computeInlayHints('gql`query { user { id } }`;', ctx)).toEqual([]);
  });

  it('handles multiple gql templates in the same file', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = [
      'const a = gql`query A { user { id } }`;',
      'const b = gql`query B { user { id } }`;',
    ].join('\n');
    const hints = computeInlayHints(src, ctx);
    // Two `user` hints + two `id` hints.
    expect(hints.filter((h) => h.label.includes('UserType'))).toHaveLength(2);
    expect(hints.filter((h) => h.label.includes('String')).length + hints.filter((h) => h.label.includes('Int')).length).toBeGreaterThanOrEqual(2);
  });

  it('handles ${fragment} template interpolations without corrupting offsets', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { ${fragment} user { id } }`;';
    const hints = computeInlayHints(src, ctx);
    const idHint = hints.find((h) => h.label.includes('String'))!;
    expect(idHint).toBeDefined();
    // The `id` text is at a specific offset; the hint must land after it.
    const idIdx = src.indexOf(' id', src.indexOf('user')) + 1;
    expect(idHint.offset).toBe(idIdx + 2);
  });
});
