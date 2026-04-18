// Phase (β): resolveFieldAtCursor — which gql field is under the cursor?

import { describe, it, expect } from 'vitest';
import { resolveFieldAtCursor } from '../../codelens/gqlCursorResolver';
import { buildFieldIndex } from '../../codelens/gqlResolver';
import { ClassInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type'): ClassInfo {
  return { name, baseClasses: [], framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}
function ctxFor(classes: ClassInfo[]) {
  const classMap = new Map(classes.map((c) => [c.name, c] as const));
  return { classMap, fieldIndex: buildFieldIndex(classMap) };
}

describe('resolveFieldAtCursor (phase β)', () => {
  it('finds the outer field when the cursor is on the field name', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFor([userType, query]);

    const src = 'const q = gql`query { user { id } }`;';
    // Place cursor on the "user" token
    const cursor = src.indexOf('user') + 1;
    const r = resolveFieldAtCursor(src, cursor, ctx);
    expect(r).not.toBeNull();
    expect(r!.gqlField.name).toBe('user');
    expect(r!.targetClass.name).toBe('UserType');
  });

  it('finds the INNERMOST field when cursor is inside nested selection', () => {
    const address = cls('AddressType', [f('street'), f('city')]);
    const user = cls('UserType', [f('address', 'Field', { resolvedType: 'AddressType' })]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFor([address, user, query]);

    const src = 'const q = gql`query { user { address { street } } }`;';
    // Cursor is on the "street" token inside address's selection.
    const cursor = src.indexOf('street') + 2;
    const r = resolveFieldAtCursor(src, cursor, ctx);
    expect(r).not.toBeNull();
    expect(r!.gqlField.name).toBe('street');
    // street has no resolvedType so targetClass falls back to AddressType (the owner of `street`).
    expect(r!.targetClass.name).toBe('AddressType');
  });

  it('returns null when the cursor is outside any gql template', () => {
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFor([userType, query]);

    const src = 'const q = gql`query { user { id } }`;\nconst x = 42;';
    const cursor = src.indexOf('const x');
    const r = resolveFieldAtCursor(src, cursor, ctx);
    expect(r).toBeNull();
  });

  it('falls back to the containing field when the cursor is on an unrecognized child', () => {
    // If the user typed `bogus` inside `user { ... }`, we still want the graph
    // to show UserType so they can see what IS available instead.
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFor([userType, query]);

    const src = 'const q = gql`query { user { bogus } }`;';
    const cursor = src.indexOf('bogus') + 1;
    const r = resolveFieldAtCursor(src, cursor, ctx);
    expect(r).not.toBeNull();
    expect(r!.gqlField.name).toBe('user');
    expect(r!.targetClass.name).toBe('UserType');
  });

  it('falls back to containing field when cursor is in whitespace inside a selection block', () => {
    const userType = cls('UserType', [f('id'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const ctx = ctxFor([userType, query]);

    // Cursor lands on a blank line inside the `user { ... }` selection set.
    const src = 'const q = gql`query { user {\n   \n  id\n} }`;';
    // Position in the middle of the whitespace line.
    const cursor = src.indexOf('\n   \n') + 2;
    const r = resolveFieldAtCursor(src, cursor, ctx);
    expect(r).not.toBeNull();
    expect(r!.gqlField.name).toBe('user');
  });
});
