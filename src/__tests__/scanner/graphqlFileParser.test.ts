import { beforeEach, describe, expect, it } from 'vitest';
import { __clearMockFiles, __setMockFiles } from '../__mocks__/vscode';
import { parseGraphQLFiles } from '../../scanner/graphqlFileParser';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { computeDiagnostics } from '../../codelens/gqlDiagnostics';

beforeEach(() => __clearMockFiles());

describe('GraphQL SDL parser wire names', () => {
  it('preserves camelCase and merges type extensions across files', async () => {
    __setMockFiles({
      '/project/schema.graphql': [
        'schema { query: RootQuery }',
        'type RootQuery { userById: User }',
        'type User { displayName: String }',
        'type Mutation { notActuallyRegistered: String }',
      ].join('\n'),
      '/project/user-extension.graphql': 'extend type User { createdAt: String }',
    });

    const schemas = await parseGraphQLFiles('/project');
    expect(schemas[0].queries[0].name).toBe('RootQuery');
    expect(schemas[0].queries[0].isSchemaRoot).toBe(true);
    expect(schemas[0].mutations).toEqual([]);
    expect(schemas[0].types.some((cls) => cls.name === 'Mutation')).toBe(true);
    const user = schemas[0].types.find((cls) => cls.name === 'User')!;
    expect(user.fields.map((field) => field.graphqlName).sort()).toEqual(['createdAt', 'displayName']);

    const provider = new GqlCodeLensProvider();
    provider.updateSchemas(schemas);
    expect(computeDiagnostics(
      'gql`query { userById { displayName createdAt } }`;',
      provider.getSharedState(),
    )).toEqual([]);
  });
});
