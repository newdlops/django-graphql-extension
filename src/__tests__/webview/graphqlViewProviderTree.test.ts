import { describe, expect, it } from 'vitest';
import { GraphqlViewProvider } from '../../webview/graphqlViewProvider';
import { ClassInfo, FieldInfo, SchemaInfo } from '../../types';
import { FrontendGqlFileUsage } from '../../analysis/frontendGqlUsage';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p/schema.py', lineNumber: 0, ...extras };
}

function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type'): ClassInfo {
  return { name, baseClasses: [], framework: 'graphene', filePath: '/p/schema.py', lineNumber: 0, fields, kind };
}

function schema(parts: { queries?: ClassInfo[]; mutations?: ClassInfo[]; types?: ClassInfo[] }): SchemaInfo {
  return {
    name: 'test',
    filePath: '/p/schema.py',
    queries: parts.queries ?? [],
    mutations: parts.mutations ?? [],
    subscriptions: [],
    types: parts.types ?? [],
  };
}

function gqlFile(relativePath: string, operations: FrontendGqlFileUsage['operations']): FrontendGqlFileUsage {
  return {
    filePath: `/ws/${relativePath}`,
    relativePath,
    operationCount: operations.length,
    operations,
  };
}

function findNodeByLabel(nodes: Array<{ label: string; children?: any[] }>, label: string): any {
  for (const node of nodes) {
    if (node.label === label) return node;
    if (node.children) {
      const found = findNodeByLabel(node.children, label);
      if (found) return found;
    }
  }
  return undefined;
}

function findChildByLabel(node: { children?: any[] }, label: string): any {
  return (node.children ?? []).find((child: any) => child.label === label);
}

function findPath(node: { children?: any[] }, labels: string[]): any {
  let cursor: any = node;
  for (const label of labels) {
    cursor = findChildByLabel(cursor, label);
    if (!cursor) return undefined;
  }
  return cursor;
}

describe('GraphqlViewProvider tree sections', () => {
  it('builds backend and frontend sections together', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    const frontend = [
      gqlFile('src/components/UserCard.tsx', [
        { kind: 'fragment', label: 'fragment UserFields', lineNumber: 4, rootFields: [] },
      ]),
      gqlFile('src/pages/Dashboard.tsx', [
        { kind: 'query', label: 'query Dashboard', lineNumber: 10, rootFields: ['viewer', 'team'] },
      ]),
    ];

    provider.updateSchemas([schema({ queries: [query], types: [userType] })], frontend);

    const sections = (provider as any).buildSections();
    expect(sections.map((section: any) => section.label)).toEqual(['Backend', 'Frontend']);
    expect(sections[0].desc).toContain('2 classes');
    expect(sections[1].desc).toContain('2 files');

    const frontendRoot = findNodeByLabel(sections[1].children, 'src');
    expect(frontendRoot).toBeDefined();
    expect(frontendRoot.desc).toBe('2 files');
    expect(frontendRoot.kind).toBe('folder');

    const dashboardFile = findNodeByLabel(sections[1].children, 'Dashboard.tsx');
    expect(dashboardFile.desc).toBe('query Dashboard');
    expect(dashboardFile.kind).toBe('file');
    expect(dashboardFile.file).toBe('/ws/src/pages/Dashboard.tsx');
    expect(dashboardFile.children[0]).toMatchObject({
      label: 'query Dashboard',
      desc: 'viewer, team',
      kind: 'operation',
      line: 10,
    });
  });

  it('filters frontend nodes recursively while preserving matching ancestors', () => {
    const provider = new GraphqlViewProvider();
    provider.updateSchemas([], [
      gqlFile('src/pages/Dashboard.tsx', [
        { kind: 'query', label: 'query Dashboard', lineNumber: 10, rootFields: ['viewer'] },
      ]),
      gqlFile('src/pages/Settings.tsx', [
        { kind: 'mutation', label: 'mutation SaveSettings', lineNumber: 30, rootFields: ['saveSettings'] },
      ]),
    ]);

    (provider as any).applyFilter({ query: 'SaveSettings', caseSensitive: false, wholeWord: false, useRegex: false });
    const sections = (provider as any).buildSections();

    const frontend = sections.find((section: any) => section.id === 'frontend');
    expect(frontend.desc).toContain('1 file');
    expect(findNodeByLabel(frontend.children, 'Settings.tsx')).toBeDefined();
    expect(findNodeByLabel(frontend.children, 'Dashboard.tsx')).toBeUndefined();
    expect(findNodeByLabel(frontend.children, 'src')).toBeDefined();
    expect(findNodeByLabel(frontend.children, 'pages')).toBeDefined();
  });

  it('renders expand-all control and horizontal scrolling in the webview shell', () => {
    const provider = new GraphqlViewProvider();
    const html = (provider as any).getHtml();

    expect(html).toContain('id="expand"');
    expect(html).toContain('overflow-x: auto;');
    expect(html).toContain("node.kind === 'file' || node.kind === 'operation'");
  });

  it('keeps resolved backend path expansions schema-local when duplicate type names exist', () => {
    const provider = new GraphqlViewProvider();
    const queryA: ClassInfo = {
      name: 'Query',
      baseClasses: [],
      framework: 'graphene',
      filePath: '/proj/a/query.py',
      lineNumber: 1,
      kind: 'query',
      fields: [{ name: 'user', fieldType: 'Field', resolvedType: 'UserType', filePath: '/proj/a/query.py', lineNumber: 2 }],
    };
    const userTypeA: ClassInfo = {
      name: 'UserType',
      baseClasses: [],
      framework: 'graphene',
      filePath: '/proj/a/types.py',
      lineNumber: 10,
      kind: 'type',
      fields: [{ name: 'id', fieldType: 'ID', filePath: '/proj/a/types.py', lineNumber: 11 }],
    };
    const queryB: ClassInfo = {
      name: 'Query',
      baseClasses: [],
      framework: 'graphene',
      filePath: '/proj/b/query.py',
      lineNumber: 1,
      kind: 'query',
      fields: [{ name: 'user', fieldType: 'Field', resolvedType: 'UserType', filePath: '/proj/b/query.py', lineNumber: 2 }],
    };
    const userTypeB: ClassInfo = {
      name: 'UserType',
      baseClasses: [],
      framework: 'graphene',
      filePath: '/proj/b/types.py',
      lineNumber: 20,
      kind: 'type',
      fields: [{ name: 'name', fieldType: 'String', filePath: '/proj/b/types.py', lineNumber: 21 }],
    };

    provider.updateSchemas([
      {
        name: 'schema-a',
        filePath: '/proj/a/schema.py',
        queries: [queryA],
        mutations: [],
        subscriptions: [],
        types: [userTypeA],
      },
      {
        name: 'schema-b',
        filePath: '/proj/b/schema.py',
        queries: [queryB],
        mutations: [],
        subscriptions: [],
        types: [userTypeB],
      },
    ]);

    const sections = (provider as any).buildSections();
    const backend = sections.find((section: any) => section.id === 'backend');
    const schemaNodeA = findNodeByLabel(backend.children, 'schema-a');
    const queriesA = findChildByLabel(schemaNodeA, 'Queries');
    const queryNodeA = findPath(queriesA, ['proj', 'a', 'query.py', 'Query']);
    const userFieldA = findChildByLabel(queryNodeA, 'user');

    expect(userFieldA.children.map((child: any) => child.label)).toEqual(['id']);
    expect(userFieldA.children[0].file).toBe('/proj/a/types.py');
  });

  it('places backend classes under their real source path, not just the schema path', () => {
    const provider = new GraphqlViewProvider();
    const schemaInfo: SchemaInfo = {
      name: 'zuzu/app/graphql/schema.py',
      filePath: '/workspace/zuzu/app/graphql/schema.py',
      queries: [],
      subscriptions: [],
      mutations: [{
        name: 'CreateOrEditStakeholder',
        baseClasses: [],
        framework: 'graphene',
        filePath: '/workspace/zuzu/packages/company/stakeholder/graphql/mutations/create_or_edit_stakeholder_mutation.py',
        lineNumber: 40,
        kind: 'mutation',
        fields: [],
      }],
      types: [],
    };

    provider.updateSchemas([schemaInfo]);
    const sections = (provider as any).buildSections();
    const backend = sections.find((section: any) => section.id === 'backend');
    const schemaNode = findNodeByLabel(backend.children, 'zuzu/app/graphql/schema.py');
    const mutations = findChildByLabel(schemaNode, 'Mutations');

    expect(findPath(mutations, ['workspace', 'zuzu', 'app', 'graphql', 'schema.py', 'CreateOrEditStakeholder'])).toBeUndefined();
    expect(findPath(mutations, [
      'workspace',
      'zuzu',
      'packages',
      'company',
      'stakeholder',
      'graphql',
      'mutations',
      'create_or_edit_stakeholder_mutation.py',
      'CreateOrEditStakeholder',
    ])).toBeDefined();
  });
});
