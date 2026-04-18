// Phase (α): inherited-field lookups must route the link to the class that
// DECLARES the field, not the subclass that merely re-exposes it.
//
// Scenario: UserType extends TimestampMixin. `created_at` is declared in the
// mixin. When gql queries `user { createdAt }`, the CodeLens title must read
// `→ TimestampMixin.created_at`, not `→ UserType.created_at`.

import { describe, it, expect } from 'vitest';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { ClassInfo, FieldInfo } from '../../types';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument } from 'vscode';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/p.py', lineNumber: 0, fields, kind };
}

describe('findEntry owner routing (phase α)', () => {
  it('routes an inherited field to the declaring mixin, not the inheriting class', () => {
    // Simulate the post-resolveInheritedFields state: UserType.fields contains
    // both its own `name` and the merged `created_at` from TimestampMixin,
    // with `definedIn` pointing at TimestampMixin.
    const mixin = cls('TimestampMixin', [f('created_at', 'DateTime')]);
    const userType = cls('UserType', [
      f('name'),
      { ...f('created_at', 'DateTime'), definedIn: 'TimestampMixin' },
    ], 'type', ['TimestampMixin']);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');

    const p = new GqlCodeLensProvider();
    p.updateIndex(new Map([[mixin.name, mixin], [userType.name, userType], [query.name, query]]));
    p.rebuildIndexNow();

    const src = 'gql`query { user { createdAt } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any) as any[];
    const titles = lenses.map((l) => l.command?.title ?? '');

    expect(titles).toContain('→ TimestampMixin.created_at [Type]');
    expect(titles.some((t: string) => t.includes('UserType.created_at'))).toBe(false);
  });

  it('own fields still resolve to the subclass (not to the mixin)', () => {
    const mixin = cls('TimestampMixin', [f('created_at', 'DateTime')]);
    const userType = cls('UserType', [
      f('name'),
      { ...f('created_at', 'DateTime'), definedIn: 'TimestampMixin' },
    ], 'type', ['TimestampMixin']);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');

    const p = new GqlCodeLensProvider();
    p.updateIndex(new Map([[mixin.name, mixin], [userType.name, userType], [query.name, query]]));
    p.rebuildIndexNow();

    const src = 'gql`query { user { name } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any) as any[];
    const titles = lenses.map((l) => l.command?.title ?? '');

    expect(titles).toContain('→ UserType.name [Type]');
  });

  it('click target for an inherited field points at the mixin source', () => {
    const mixin = cls('TimestampMixin', [f('created_at', 'DateTime')]);
    // The mixin lives in a different file than the user type — clicking the
    // CodeLens must open the mixin's file, not the user's.
    mixin.filePath = '/backend/mixins/timestamp.py';
    mixin.lineNumber = 7;

    const userType = cls('UserType', [
      f('name'),
      { ...f('created_at', 'DateTime'), definedIn: 'TimestampMixin' },
    ], 'type', ['TimestampMixin']);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');

    const p = new GqlCodeLensProvider();
    p.updateIndex(new Map([[mixin.name, mixin], [userType.name, userType], [query.name, query]]));
    p.rebuildIndexNow();

    const src = 'gql`query { user { createdAt } }`;';
    const lenses = p.provideCodeLenses(new TextDocument(src) as any) as any[];
    const createdLens = lenses.find((l) => l.command?.title?.includes('created_at'));
    expect(createdLens).toBeDefined();
    expect(createdLens.command.arguments[0]).toBe('/backend/mixins/timestamp.py');
    expect(createdLens.command.arguments[1]).toBe(7);
  });
});
