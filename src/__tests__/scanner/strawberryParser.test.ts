import { beforeEach, describe, expect, it } from 'vitest';
import { __clearMockFiles, __setMockFiles } from '../__mocks__/vscode';
import { parseStrawberrySchemas } from '../../scanner/strawberryParser';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { computeDiagnostics } from '../../codelens/gqlDiagnostics';

beforeEach(() => __clearMockFiles());

describe('Strawberry GraphQL name overrides', () => {
  it('preserves type and field wire names', async () => {
    __setMockFiles({
      '/project/schema.py': [
        'import strawberry',
        '',
        '@strawberry.type(name="User")',
        'class UserType:',
        '    display_name: str = strawberry.field(name="displayName")',
        '',
        '@strawberry.type',
        'class Query:',
        '    @strawberry.field(name="currentUser")',
        '    def current_user(self) -> UserType:',
        '        return UserType()',
        '',
        'schema = strawberry.Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseStrawberrySchemas('/project');
    const query = schemas[0].queries.find((cls) => cls.name === 'Query')!;
    const user = schemas[0].types.find((cls) => cls.name === 'UserType')!;
    expect(query.isSchemaRoot).toBe(true);
    expect(query.fields[0].graphqlName).toBe('currentUser');
    expect(user.graphqlName).toBe('User');
    expect(user.fields[0].graphqlName).toBe('displayName');

    const provider = new GqlCodeLensProvider();
    provider.updateSchemas(schemas);
    expect(computeDiagnostics(
      'gql`query { currentUser { displayName } }`;',
      provider.getSharedState(),
    )).toEqual([]);
    expect(computeDiagnostics(
      'gql`fragment UserFields on User { displayName }`;',
      provider.getSharedState(),
    )).toEqual([]);
  });
});
