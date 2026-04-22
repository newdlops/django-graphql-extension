// Phase (w): gutter / text decorations for query coverage.

import { describe, it, expect } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument, TextEditor, __listDecorationTypes } from 'vscode';
import { computeDecorations, GqlDecorationManager } from '../../codelens/gqlDecorations';
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

describe('computeDecorations (phase w)', () => {
  it('classifies clean root + nested fields as exact', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { id name } }`;';
    const decos = computeDecorations(src, ctx);
    expect(decos).toHaveLength(3);
    for (const d of decos) expect(d.kind).toBe('exact');
  });

  it('scopes root-level fields to the operation kind', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const mut = cls('Mutation', [f('user', 'Field', { resolvedType: 'UserType' })], 'mutation');
    const ctx = ctxFromClasses([userType, query, mut]);

    const src = 'gql`query { user { id } }`;';
    const decos = computeDecorations(src, ctx);
    const user = decos.find((d) => src.substr(d.offset, d.length) === 'user');
    expect(user!.kind).toBe('exact');
  });

  it('does not let regular type fields satisfy root-level operation fields', () => {
    const userType = cls('UserType', [f('profile', 'Field', { resolvedType: 'ProfileType' })]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { profile { id } }`;';
    const decos = computeDecorations(src, ctx);
    const profile = decos.find((d) => src.substr(d.offset, d.length) === 'profile');
    const id = decos.find((d) => src.substr(d.offset, d.length) === 'id');
    expect(profile!.kind).toBe('unresolved');
    expect(id!.kind).toBe('unresolved');
  });

  it('classifies typo fields (known parent, unknown name) as unresolved', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user { bogus } }`;';
    const decos = computeDecorations(src, ctx);
    const bogus = decos.find((d) => src.substr(d.offset, d.length) === 'bogus');
    expect(bogus!.kind).toBe('unresolved');
  });

  it('follows provider field-name inference before marking nested unresolved fields', () => {
    const investorType = cls('InvestorType', [f('id')]);
    const query = cls('Query', [f('investors', 'Field')], 'query');
    const ctx = ctxFromClasses([investorType, query]);

    const src = 'gql`query { investors { bogus } }`;';
    const decos = computeDecorations(src, ctx);
    const bogus = decos.find((d) => src.substr(d.offset, d.length) === 'bogus');
    expect(bogus!.kind).toBe('unresolved');
  });

  it('returns [] when field index is empty', () => {
    const decos = computeDecorations('gql`query { user { id } }`;', { classMap: new Map(), fieldIndex: new Map() });
    expect(decos).toEqual([]);
  });

  it('spans cover exactly the frontend field name (not args, not braces)', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const src = 'gql`query { user(id: 1) { id } }`;';
    const decos = computeDecorations(src, ctx);
    expect(decos.every((d) => /^[a-zA-Z_]\w*$/.test(src.substr(d.offset, d.length)))).toBe(true);
  });
});

describe('GqlDecorationManager integration (phase w)', () => {
  it('partitions ranges into three decoration types and writes them to the editor', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFromClasses([userType, query]);

    const mgr = new GqlDecorationManager(() => ctx);
    const src = 'gql`query { user { id bogus } }`;';
    const doc = new TextDocument(src);
    const editor = new TextEditor(doc);

    mgr.refreshNow(editor as any);

    // The manager created exactly 3 decoration types.
    const allTypes = __listDecorationTypes();
    expect(allTypes.length).toBeGreaterThanOrEqual(3);

    // Find each type by scanning its stored options for our marker colors.
    const types: Record<string, any> = {};
    for (const t of allTypes) {
      const opts = t.options as { backgroundColor?: string };
      if (!opts?.backgroundColor) continue;
      if (opts.backgroundColor.includes('76, 175, 80')) types.exact = t;
      if (opts.backgroundColor.includes('255, 179, 0')) types.inferred = t;
      if (opts.backgroundColor.includes('55, 148, 255')) types.unresolved = t;
    }
    expect(types.exact.lastRanges.length).toBe(2); // user, id
    expect(types.unresolved.lastRanges.length).toBe(1); // bogus
    expect(types.inferred.lastRanges.length).toBe(0);

    mgr.dispose();
  });
});
