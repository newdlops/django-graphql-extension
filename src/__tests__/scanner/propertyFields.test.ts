// Phase (l) decision: `@property`-only fields are intentionally NOT exposed.
//
// In graphene, a property or plain method on an ObjectType is NOT a GraphQL
// field unless it has an accompanying class-level field declaration. Surfacing
// @property-only methods would promise queries that the runtime will reject.
//
// These tests lock in that behavior: we only pick up explicit field declarations.

import { describe, it, expect } from 'vitest';
import { parseClassFields, EMPTY_IMPORTS } from '../../scanner/grapheneParser';

describe('parseClassFields — @property / def handling', () => {
  it('ignores a bare @property without a field declaration', () => {
    const src = [
      'class UserType(ObjectType):',
      '    name = graphene.String()',
      '',
      '    @property',
      '    def display_name(self):',
      '        return self.name',
    ];
    const fields = parseClassFields(src, 0, '/u.py', {
      ...EMPTY_IMPORTS,
      fromGraphene: new Set(['ObjectType', 'String']),
    });
    expect(fields.map((f) => f.name)).toEqual(['name']);
  });

  it('ignores a bare resolve_* method without a field declaration', () => {
    const src = [
      'class UserType(ObjectType):',
      '    name = graphene.String()',
      '',
      '    def resolve_display_name(self, info):',
      '        return self.name.upper()',
    ];
    const fields = parseClassFields(src, 0, '/u.py', {
      ...EMPTY_IMPORTS,
      fromGraphene: new Set(['ObjectType', 'String']),
    });
    expect(fields.map((f) => f.name)).toEqual(['name']);
  });

  it('picks up a field that IS declared alongside a resolver', () => {
    const src = [
      'class UserType(ObjectType):',
      '    name = graphene.String()',
      '    display_name = graphene.String()',
      '',
      '    def resolve_display_name(self, info):',
      '        return self.name.upper()',
    ];
    const fields = parseClassFields(src, 0, '/u.py', {
      ...EMPTY_IMPORTS,
      fromGraphene: new Set(['ObjectType', 'String']),
    });
    expect(fields.map((f) => f.name)).toEqual(['name', 'display_name']);
  });
});
