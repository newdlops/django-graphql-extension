// Phase (s): listInspectableClasses + showInspectorForClass public API.
// Also covers the sort/format the extension.ts command builds for showQuickPick.

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
function mkSchema(parts: { queries?: ClassInfo[]; mutations?: ClassInfo[]; types?: ClassInfo[] }): SchemaInfo {
  return {
    name: 'test', filePath: '/p/schema.py',
    queries: parts.queries ?? [], mutations: parts.mutations ?? [],
    subscriptions: [], types: parts.types ?? [],
  };
}

beforeEach(() => __clearPanels());

describe('listInspectableClasses (phase s)', () => {
  it('exposes name, kind, filePath, and a field count excluding synthetic markers', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id'), f('name'), f('__relay_node__', 'RelayNode')]);
    const query = cls('Query', [f('user', 'Field', { resolvedType: 'UserType' })], 'query');
    provider.updateSchemas([mkSchema({ queries: [query], types: [userType] })]);

    const list = provider.listInspectableClasses();
    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(['Query', 'UserType']);

    const user = list.find((c) => c.name === 'UserType')!;
    expect(user.kind).toBe('type');
    expect(user.filePath).toBe('/p/a.py');
    expect(user.fieldCount).toBe(2); // __relay_node__ excluded
  });

  it('returns an empty list before any schemas are loaded', () => {
    const provider = new GraphqlViewProvider();
    expect(provider.listInspectableClasses()).toEqual([]);
  });
});

describe('showInspectorForClass (phase s)', () => {
  it('opens a fresh inspector panel for the given class', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    provider.updateSchemas([mkSchema({ types: [userType] })]);

    provider.showInspectorForClass('UserType');
    const panel = __getLastPanel() as FakeWebviewPanel;
    expect(panel).toBeDefined();
    expect(panel.title).toBe('UserType');

    const msgs = panel.webview.postedMessages as Array<{ type: string; data: any }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('inspector');
    expect(msgs[0].data.className).toBe('UserType');
  });

  it('is a no-op for unknown class names', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    provider.updateSchemas([mkSchema({ types: [userType] })]);

    provider.showInspectorForClass('Nope');
    // No panel created since classMap doesn't contain 'Nope'.
    expect(__getLastPanel()).toBeUndefined();
  });

  it('reuses the same panel when called twice (navigation, not duplication)', () => {
    const provider = new GraphqlViewProvider();
    const userType = cls('UserType', [f('id')]);
    const companyType = cls('CompanyType', [f('name')]);
    provider.updateSchemas([mkSchema({ types: [userType, companyType] })]);

    provider.showInspectorForClass('UserType');
    const firstPanel = __getLastPanel() as FakeWebviewPanel;
    provider.showInspectorForClass('CompanyType');
    const secondPanel = __getLastPanel() as FakeWebviewPanel;

    expect(firstPanel).toBe(secondPanel); // same panel, just re-rendered
    expect(secondPanel.title).toBe('CompanyType');
    expect(secondPanel.webview.postedMessages).toHaveLength(2);
  });
});
