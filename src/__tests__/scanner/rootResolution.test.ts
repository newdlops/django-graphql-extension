import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { TextDocument } from 'vscode';
import { __clearMockFiles, __setMockFiles } from '../__mocks__/vscode';
import { parseGrapheneSchemas } from '../../scanner/grapheneParser';
import { GqlCodeLensProvider } from '../../codelens/gqlCodeLensProvider';
import { computeDiagnostics } from '../../codelens/gqlDiagnostics';

beforeEach(() => __clearMockFiles());

describe('Graphene scanner → operation-root resolver seam', () => {
  it('does not expose returned types or mutation payload fields as operation roots', async () => {
    __setMockFiles({
      '/project/schema.py': [
        'import graphene',
        '',
        'class UserType(graphene.ObjectType):',
        '    name = graphene.String()',
        '',
        'class CreateUser(graphene.Mutation):',
        '    ok = graphene.Boolean()',
        '',
        'class Query(graphene.ObjectType):',
        '    user = graphene.Field(UserType)',
        '',
        'class Mutation(graphene.ObjectType):',
        '    create_user = CreateUser.Field()',
        '',
        'schema = graphene.Schema(query=Query, mutation=Mutation)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/project');
    const provider = new GqlCodeLensProvider();
    provider.updateSchemas(schemas);
    const source = [
      'gql`query { name }`;',
      'gql`mutation { ok }`;',
    ].join('\n');
    const lenses = provider.provideCodeLenses(new TextDocument(source) as any) as any[];
    const titles = lenses.map((lens) => lens.command?.title ?? '');

    expect(titles.some((title) => title.includes('UserType.name'))).toBe(false);
    expect(titles.some((title) => title.includes('CreateUser.ok'))).toBe(false);

    const diagnostics = computeDiagnostics(source, provider.getSharedState());
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain("No root query field 'name'");
    expect(diagnostics[1].message).toContain("No root mutation field 'ok'");
  });

  it('keeps multiline Query mixins as legitimate root contributors', async () => {
    __setMockFiles({
      '/project/schema.py': [
        'import graphene',
        '',
        'class AccountType(graphene.ObjectType):',
        '    display_name = graphene.String()',
        '',
        'class AccountQueries:',
        '    account = graphene.Field(AccountType)',
        '',
        'class Query(',
        '    AccountQueries,  # composed root fields',
        '    graphene.ObjectType,',
        '):',
        '    pass',
        '',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/project');
    const contributor = schemas[0].queries.find((cls) => cls.name === 'AccountQueries');
    expect(contributor?.isSchemaRootContributor).toBe(true);

    const provider = new GqlCodeLensProvider();
    provider.updateSchemas(schemas);
    const source = 'gql`query { account { displayName } }`;';
    const titles = (provider.provideCodeLenses(new TextDocument(source) as any) as any[])
      .map((lens) => lens.command?.title ?? '');
    expect(titles.some((title) => title.includes('AccountQueries.account'))).toBe(true);
    expect(titles.some((title) => title.includes('AccountType.display_name'))).toBe(true);
  });

  it('does not invent a mutation root for an explicit query-only schema', async () => {
    __setMockFiles({
      '/project/schema.py': [
        'import graphene',
        'class Query(graphene.ObjectType):',
        '    ping = graphene.String()',
        'class Mutation(graphene.ObjectType):',
        '    accidental = graphene.String()',
        'schema = graphene.Schema(query=Query)',
      ].join('\n'),
    });

    const schemas = await parseGrapheneSchemas('/project');
    expect(schemas[0].mutations).toEqual([]);
    expect(schemas[0].queries.find((cls) => cls.name === 'Query')?.isSchemaRoot).toBe(true);
  });
});
