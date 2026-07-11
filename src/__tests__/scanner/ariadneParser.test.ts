import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument } from 'vscode';
import { __clearMockFiles, __setMockFiles } from '../__mocks__/vscode';
import { parseAriadneSchemas } from '../../scanner/ariadneParser';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { computeDiagnostics } from '../../codelens/gqlDiagnostics';

beforeEach(() => __clearMockFiles());

describe('Ariadne SDL/resolver integration', () => {
  it('keeps exact wire names and merges SDL types with resolver locations', async () => {
    const source = [
      'from ariadne import QueryType, ObjectType, gql',
      'query = QueryType()',
      'user = ObjectType("User")',
      '',
      'type_defs = gql("""',
      '  type Query {',
      '    userById: User',
      '  }',
      '  type User {',
      '    displayName: String',
      '  }',
      '""")',
      '',
      '@query.field("userById")',
      'def resolve_user(*_):',
      '    return {}',
      '',
      '@user.field("displayName")',
      'def resolve_display_name(*_):',
      '    return "name"',
    ];
    __setMockFiles({ '/project/schema.py': source.join('\n') });

    const schemas = await parseAriadneSchemas('/project');
    const query = schemas[0].queries[0];
    const user = schemas[0].types.find((cls) => cls.name === 'User')!;
    const queryField = query.fields.find((field) => field.graphqlName === 'userById')!;
    const userField = user.fields.find((field) => field.graphqlName === 'displayName')!;

    expect(queryField.resolvedType).toBe('User');
    expect(queryField.lineNumber).toBe(source.indexOf('def resolve_user(*_):'));
    expect(user.fields).toHaveLength(1);
    expect(userField.lineNumber).toBe(source.indexOf('def resolve_display_name(*_):'));

    const provider = new GqlCodeLensProvider();
    provider.updateSchemas(schemas);
    expect(computeDiagnostics(
      'gql`query { userById { displayName } }`;',
      provider.getSharedState(),
    )).toEqual([]);

    const lenses = provider.provideCodeLenses(
      new TextDocument('gql`query { userById { displayName } }`;') as any,
    ) as any[];
    const rootLens = lenses.find((lens) => lens.command?.title?.includes('.userById'));
    const childLens = lenses.find((lens) => lens.command?.title?.includes('.displayName'));
    expect(rootLens.command.arguments).toEqual([
      '/project/schema.py', source.indexOf('def resolve_user(*_):'),
    ]);
    expect(childLens.command.arguments).toEqual([
      '/project/schema.py', source.indexOf('def resolve_display_name(*_):'),
    ]);
  });
});
