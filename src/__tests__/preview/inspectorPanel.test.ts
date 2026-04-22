// Phase (p): Integration test — GraphqlViewProvider wires the inspector data
// into a real webview panel, reacts to navigation messages, and re-renders on
// schema refresh.

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — alias resolves to our mock via vitest.config.ts
import { __getLastPanel, __clearPanels, FakeWebviewPanel } from 'vscode';
import { GraphqlViewProvider } from '../../webview/graphqlViewProvider';
import { ClassInfo, SchemaInfo, FieldInfo } from '../../types';

function f(name: string, fieldType = 'String', extras: Partial<FieldInfo> = {}): FieldInfo {
  return { name, fieldType, filePath: '/p/a.py', lineNumber: 0, ...extras };
}
function cls(name: string, fields: FieldInfo[], kind: ClassInfo['kind'] = 'type', baseClasses: string[] = []): ClassInfo {
  return { name, baseClasses, framework: 'graphene', filePath: '/p/a.py', lineNumber: 0, fields, kind };
}

function mkSchema(classes: { queries?: ClassInfo[]; mutations?: ClassInfo[]; types?: ClassInfo[] }): SchemaInfo {
  return {
    name: 'test',
    filePath: '/p/schema.py',
    queries: classes.queries ?? [],
    mutations: classes.mutations ?? [],
    subscriptions: [],
    types: classes.types ?? [],
  };
}

// Trigger showPreview (a private method) through the onDidReceiveMessage path
// on the Activity Bar webview. Tests don't need to do that — they can call
// the public entry directly.
function showInspector(provider: GraphqlViewProvider, className: string): void {
  // showPreview is private; call through the resolveWebviewView message handler
  // by invoking the prototype method with `any`.
  (provider as unknown as { showPreview: (n: string) => void }).showPreview(className);
}

beforeEach(() => __clearPanels());

describe('GraphqlViewProvider inspector panel (phase p)', () => {
  it('posts an inspector payload with reverse-refs for the requested class', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    provider.updateSchemas([mkSchema({ queries: [query], types: [userType] })]);

    showInspector(provider, 'UserType');
    const panel = __getLastPanel() as FakeWebviewPanel;
    expect(panel).toBeDefined();

    // First message should be the inspector payload for UserType.
    const msgs = panel.webview.postedMessages as Array<{ type: string; data: any }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('inspector');
    expect(msgs[0].data.className).toBe('UserType');
    expect(msgs[0].data.usedAsFieldType.map((r: any) => r.fromClass)).toEqual(['Query']);
  });

  it('re-renders the panel when a navigate message is received from the webview', () => {
    const provider = new GraphqlViewProvider();
    const companyType = cls('CompanyType', [f('name')]);
    const stockType = cls('StockType', [f('company', 'Field', { resolvedType: 'CompanyType' })]);
    const query = cls('Query', [f('stock', 'Field', { resolvedType: 'StockType' })], 'query');
    provider.updateSchemas([mkSchema({ queries: [query], types: [stockType, companyType] })]);

    showInspector(provider, 'StockType');
    const panel = __getLastPanel() as FakeWebviewPanel;

    // Simulate: user clicks the CompanyType chip inside the inspector.
    panel.simulateMessage({ type: 'navigate', className: 'CompanyType' });

    const msgs = panel.webview.postedMessages as Array<{ type: string; data: any }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].data.className).toBe('CompanyType');
    expect(panel.title).toBe('CompanyType');
  });

  it('keeps inspector navigation inside the same schema when duplicate class names exist', () => {
    const provider = new GraphqlViewProvider();
    const userTypeA = {
      name: 'UserType',
      baseClasses: [],
      framework: 'graphene' as const,
      filePath: '/proj/a/types.py',
      lineNumber: 10,
      kind: 'type' as const,
      fields: [f('id', 'ID', { filePath: '/proj/a/types.py', lineNumber: 11 })],
    };
    const queryA = {
      name: 'Query',
      baseClasses: [],
      framework: 'graphene' as const,
      filePath: '/proj/a/query.py',
      lineNumber: 1,
      kind: 'query' as const,
      fields: [f('user', 'Field', { resolvedType: 'UserType', filePath: '/proj/a/query.py', lineNumber: 2 })],
    };
    const userTypeB = {
      name: 'UserType',
      baseClasses: [],
      framework: 'graphene' as const,
      filePath: '/proj/b/types.py',
      lineNumber: 20,
      kind: 'type' as const,
      fields: [f('name', 'String', { filePath: '/proj/b/types.py', lineNumber: 21 })],
    };

    provider.updateSchemas([
      mkSchema({ queries: [queryA], types: [userTypeA] }),
      {
        name: 'other',
        filePath: '/proj/b/schema.py',
        queries: [],
        mutations: [],
        subscriptions: [],
        types: [userTypeB],
      },
    ]);

    const schemaAUser = provider.listInspectableClasses().find((item) => item.filePath === '/proj/a/types.py');
    expect(schemaAUser).toBeDefined();

    provider.showInspectorForClass(schemaAUser!.classId);
    const panel = __getLastPanel() as FakeWebviewPanel;
    const msgs = panel.webview.postedMessages as Array<{ type: string; data: any }>;
    expect(msgs[0].data.filePath).toBe('/proj/a/types.py');
    expect(msgs[0].data.fields.map((row: any) => row.name)).toEqual(['id']);

    const queryRef = msgs[0].data.usedAsFieldType[0];
    expect(queryRef.fromClassId).toBeDefined();
    panel.simulateMessage({ type: 'navigate', classId: queryRef.fromClassId });

    const latest = panel.webview.postedMessages[panel.webview.postedMessages.length - 1] as { data: any };
    expect(latest.data.filePath).toBe('/proj/a/query.py');
    expect(latest.data.fields.map((row: any) => row.name)).toEqual(['user']);
  });

  it('handles open-file messages without throwing', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    provider.updateSchemas([mkSchema({ types: [userType] })]);

    showInspector(provider, 'UserType');
    const panel = __getLastPanel() as FakeWebviewPanel;
    expect(() => panel.simulateMessage({ type: 'open', file: '/p/a.py', line: 0 })).not.toThrow();
  });

  it('keeps the panel fresh when updateSchemas is called while inspector is open', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    provider.updateSchemas([mkSchema({ types: [userType] })]);

    showInspector(provider, 'UserType');
    const panel = __getLastPanel() as FakeWebviewPanel;
    const initialCount = panel.webview.postedMessages.length;

    // Simulate a schema refresh that adds a new field to UserType.
    const userTypeV2 = cls('UserType', [f('id'), f('name'), f('email')]);
    provider.updateSchemas([mkSchema({ types: [userTypeV2] })]);

    const msgs = panel.webview.postedMessages as Array<{ type: string; data: any }>;
    expect(msgs.length).toBeGreaterThan(initialCount);
    const latest = msgs[msgs.length - 1];
    expect(latest.data.className).toBe('UserType');
    expect(latest.data.fields.map((r: any) => r.name)).toEqual(['id', 'name', 'email']);
  });

  it('ignores navigate requests for unknown classes (does not re-render)', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    provider.updateSchemas([mkSchema({ types: [userType] })]);

    showInspector(provider, 'UserType');
    const panel = __getLastPanel() as FakeWebviewPanel;
    const before = panel.webview.postedMessages.length;

    panel.simulateMessage({ type: 'navigate', className: 'DoesNotExist' });
    expect(panel.webview.postedMessages.length).toBe(before);
  });

  // Phase (r): live coverage reflects what the active gql template queries.
  it('marks fields as queried when setActiveGqlBodies reports matching gql', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id'), f('name'), f('email')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    provider.updateSchemas([mkSchema({ queries: [query], types: [userType] })]);

    provider.setActiveGqlBodies(['query { user { id name } }']);
    showInspector(provider, 'UserType');

    const panel = __getLastPanel() as FakeWebviewPanel;
    const latest = panel.webview.postedMessages[panel.webview.postedMessages.length - 1] as { data: any };
    const byName = new Map(latest.data.fields.map((r: any) => [r.name, r]));
    expect((byName.get('id') as any).queried).toBe(true);
    expect((byName.get('name') as any).queried).toBe(true);
    expect((byName.get('email') as any).queried).toBe(false);
    expect(latest.data.queriedCount).toBe(2);
    expect(latest.data.totalCount).toBe(3);
  });

  it('re-renders the panel when setActiveGqlBodies arrives AFTER showInspector', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id'), f('name')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    provider.updateSchemas([mkSchema({ queries: [query], types: [userType] })]);

    showInspector(provider, 'UserType');
    const panel = __getLastPanel() as FakeWebviewPanel;
    const before = panel.webview.postedMessages.length;

    // User moves focus to a gql-bearing file.
    provider.setActiveGqlBodies(['query { user { id } }']);

    const msgs = panel.webview.postedMessages as Array<{ data: any }>;
    expect(msgs.length).toBeGreaterThan(before);
    const latest = msgs[msgs.length - 1];
    expect(latest.data.queriedCount).toBe(1);
    expect(latest.data.fields.find((r: any) => r.name === 'id').queried).toBe(true);
    expect(latest.data.fields.find((r: any) => r.name === 'name').queried).toBe(false);
  });

  it('clears coverage when setActiveGqlBodies([]) is called (non-gql file focused)', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    provider.updateSchemas([mkSchema({ queries: [query], types: [userType] })]);

    provider.setActiveGqlBodies(['query { user { id } }']);
    showInspector(provider, 'UserType');
    provider.setActiveGqlBodies([]);

    const panel = __getLastPanel() as FakeWebviewPanel;
    const latest = panel.webview.postedMessages[panel.webview.postedMessages.length - 1] as { data: any };
    expect(latest.data.queriedCount).toBe(0);
    expect(latest.data.fields.every((r: any) => !r.queried)).toBe(true);
  });
});
