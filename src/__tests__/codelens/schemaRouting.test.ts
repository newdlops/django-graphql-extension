import { describe, expect, it } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument } from 'vscode';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { computeDiagnostics } from '../../codelens/gqlDiagnostics';
import { ClassInfo, FieldInfo, SchemaInfo } from '../../types';

function field(name: string, filePath: string, extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType: 'String', filePath, lineNumber: 1, ...extras };
}

function makeSchema(side: 'core' | 'api'): SchemaInfo {
  const base = `/workspace/${side}`;
  const typeField = side === 'core' ? 'name' : 'id';
  const userType: ClassInfo = {
    name: 'UserType', baseClasses: [], framework: 'graphene', kind: 'type',
    filePath: `${base}/types.py`, lineNumber: 0,
    fields: [field(typeField, `${base}/types.py`)],
  };
  const query: ClassInfo = {
    name: 'Query', baseClasses: [], framework: 'graphene', kind: 'query',
    isSchemaRoot: true,
    filePath: `${base}/schema.py`, lineNumber: 0,
    fields: [field('user', `${base}/schema.py`, { fieldType: 'Field', resolvedType: 'UserType' })],
  };
  return {
    name: side,
    filePath: `${base}/schema.py`,
    queries: [query], mutations: [], subscriptions: [], types: [userType],
  };
}

function lensTarget(provider: GqlCodeLensProvider, source: string, fieldName: string): string | undefined {
  const lenses = provider.provideCodeLenses(
    new TextDocument(source, '/workspace/client/query.ts') as any,
  ) as any[];
  return lenses.find((lens) => lens.command?.title?.includes(`.${fieldName}`))
    ?.command?.arguments?.[0];
}

describe('schema-local gql routing', () => {
  it('uses nested selections to disambiguate duplicate Query/UserType classes', () => {
    const provider = new GqlCodeLensProvider();
    provider.updateSchemas([makeSchema('core'), makeSchema('api')]);

    expect(lensTarget(provider, 'gql`query { user { id } }`;', 'user')).toBe('/workspace/api/schema.py');
    expect(lensTarget(provider, 'gql`query { user { id } }`;', 'id')).toBe('/workspace/api/types.py');
    expect(lensTarget(provider, 'gql`query { user { name } }`;', 'user')).toBe('/workspace/core/schema.py');
    expect(lensTarget(provider, 'gql`query { user { name } }`;', 'name')).toBe('/workspace/core/types.py');
  });

  it('is independent of schema scan order and shares the choice with diagnostics', () => {
    const provider = new GqlCodeLensProvider();
    provider.updateSchemas([makeSchema('api'), makeSchema('core')]);
    const state = provider.getSharedState();

    expect(lensTarget(provider, 'gql`query { user { name } }`;', 'name')).toBe('/workspace/core/types.py');
    expect(computeDiagnostics('gql`query { user { name } }`;', {
      ...state,
      documentPath: '/workspace/client/query.ts',
    })).toEqual([]);
  });
});
